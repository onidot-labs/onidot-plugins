#!/usr/bin/env node
// onidot crew 역할 정의를 Codex 사용자 설정(<codex-home>/agents)에 놓고 갱신·제거한다.
// 설치 기록의 해시와 일치하는 파일만 우리가 소유한 것으로 보고 건드린다.
import { readFile, writeFile, readdir, mkdir, rename, rm, lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PACKAGE = 'onidot-crew';
const RECORD = '.onidot-crew.json';
const LOCK = '.onidot-crew.lock';
const STALE_LOCK_MS = 10 * 60 * 1000;
const OWNED_NAME = /^crew-[A-Za-z0-9._-]+\.toml$/;
const here = dirname(fileURLToPath(import.meta.url));
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const byName = ([a], [b]) => a.localeCompare(b);

class UsageError extends Error {}

const readOrNull = async (path) => {
  try { return await readFile(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};

// 대상 경로의 종류와 해시를 본다. 심볼릭 링크는 따라가지 않는다.
async function inspect(path) {
  let stat;
  try { stat = await lstat(path); } catch (e) { if (e.code === 'ENOENT') return { kind: 'none' }; throw e; }
  if (stat.isSymbolicLink()) return { kind: 'link' };
  if (!stat.isFile()) return { kind: 'other' };
  return { kind: 'file', hash: sha(await readFile(path)) };
}

async function atomicWrite(path, data) {
  const tmp = join(dirname(path), `.onidot-crew.${process.pid}.${Date.now()}.tmp`);
  try { await writeFile(tmp, data); await rename(tmp, path); }
  catch (e) { await rm(tmp, { force: true }); throw e; }
}

async function pluginVersion() {
  for (const dir of ['.claude-plugin', '.codex-plugin']) {
    const raw = await readOrNull(join(here, '..', dir, 'plugin.json'));
    if (raw) { const v = JSON.parse(raw.toString('utf8')).version; if (typeof v === 'string') return v; }
  }
  throw new UsageError('플러그인 버전을 찾을 수 없습니다(../.claude-plugin/plugin.json).');
}

// 기록이 변조돼도 crew-*.toml 밖은 건드리지 않는다.
const ownedEntries = (value) => {
  const files = {};
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [name, hash] of Object.entries(value)) if (OWNED_NAME.test(name) && typeof hash === 'string') files[name] = hash;
  return files;
};

async function loadRecord(agentsDir) {
  const raw = await readOrNull(join(agentsDir, RECORD));
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw new UsageError(`설치 기록이 손상됐습니다: ${join(agentsDir, RECORD)}`); }
  if (data?.schemaVersion !== 1 || data.package !== PACKAGE || typeof data.files !== 'object' || data.files === null || Array.isArray(data.files))
    throw new UsageError(`설치 기록 형식이 맞지 않습니다: ${join(agentsDir, RECORD)}`);
  return { version: String(data.version ?? ''), files: ownedEntries(data.files), pending: ownedEntries(data.pending) };
}

// 기록된 파일에 더해, 쓰기 직전에 남긴 대기 기록과 해시가 같은 파일도 우리 것으로 회수한다.
async function ownedFiles(agentsDir, record) {
  const owned = { ...(record?.files ?? {}) };
  for (const [name, hash] of Object.entries(record?.pending ?? {})) {
    const target = await inspect(join(agentsDir, name));
    if (target.kind === 'file' && target.hash === hash) owned[name] = hash;
  }
  return owned;
}

async function loadSource(sourceDir) {
  let entries;
  try { entries = await readdir(sourceDir, { withFileTypes: true }); }
  catch { throw new UsageError(`원본 디렉터리를 읽을 수 없습니다: ${sourceDir}`); }
  const files = new Map();
  for (const entry of entries)
    if (entry.isFile() && OWNED_NAME.test(entry.name)) files.set(entry.name, await readFile(join(sourceDir, entry.name)));
  if (!files.size) throw new UsageError(`원본에 crew-*.toml이 없습니다: ${sourceDir}`);
  return files;
}

async function writeRecord(agentsDir, version, files, pending = {}) {
  await mkdir(agentsDir, { recursive: true });
  const data = { schemaVersion: 1, package: PACKAGE, version, files: Object.fromEntries(Object.entries(files).sort(byName)) };
  if (Object.keys(pending).length) data.pending = Object.fromEntries(Object.entries(pending).sort(byName));
  await atomicWrite(join(agentsDir, RECORD), JSON.stringify(data, null, 2) + '\n');
}

// TOML의 최상위 name 값을 읽는다. 역할 파일은 name을 한 줄 문자열로 둔다.
function roleName(buffer) {
  const m = /^[ \t]*name[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\.)*)"|'([^'\r\n]*)')/m.exec(buffer.toString('utf8'));
  if (!m) return null;
  if (m[2] !== undefined) return m[2];
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

// 우리 것이 아닌 agents/*.toml이 쓰는 역할 이름. 같은 이름을 두 파일이 쓰면 어느 쪽이 쓰일지 알 수 없다.
async function foreignNames(agentsDir, exclude) {
  const names = new Map();
  let entries;
  try { entries = await readdir(agentsDir, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return names; throw e; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.toml') || exclude.has(entry.name) || !(entry.isFile() || entry.isSymbolicLink())) continue;
    const raw = await readFile(join(agentsDir, entry.name)).catch(() => null);
    const name = raw && roleName(raw);
    if (name && !names.has(name)) names.set(name, entry.name);
  }
  return names;
}

// 원본 파일마다 할 일을 정한다. 충돌은 reason으로 구분한다(link, other, name, user).
async function plan(agentsDir, source, owned) {
  const taken = await foreignNames(agentsDir, new Set([...source.keys(), ...Object.keys(owned)]));
  const items = [];
  for (const [name, content] of [...source].sort(byName)) {
    const want = sha(content), target = await inspect(join(agentsDir, name));
    const role = roleName(content), clash = role ? taken.get(role) : undefined;
    const item = { name, content, want };
    if (target.kind === 'link') Object.assign(item, { action: '충돌', reason: 'link', detail: '심볼릭 링크라 건드리지 않았습니다' });
    else if (target.kind === 'other') Object.assign(item, { action: '충돌', reason: 'other', detail: '일반 파일이 아니라 건드리지 않았습니다' });
    else if (clash) Object.assign(item, { action: '충돌', reason: 'name', detail: `${clash}가 같은 역할 이름 ${role}을 씁니다` });
    else if (target.kind === 'none') item.action = '설치';
    else if (owned[name] === target.hash) item.action = owned[name] === want ? '변경 없음' : '갱신';
    else Object.assign(item, { action: '충돌', reason: 'user', detail: '사용자 파일이라 건드리지 않았습니다' });
    items.push(item);
  }
  return items;
}

async function install(ctx) {
  const { agentsDir, source, version } = ctx;
  const record = await loadRecord(agentsDir);
  const owned = await ownedFiles(agentsDir, record);
  const items = await plan(agentsDir, source, owned);
  const writes = Object.fromEntries(items.filter((i) => i.action === '설치' || i.action === '갱신').map((i) => [i.name, i.want]));
  // 파일을 쓰기 전에 의도한 해시를 대기 기록에 남긴다. 최종 기록이 실패해도 다음 실행이 회수한다.
  if (Object.keys(writes).length) {
    try { await writeRecord(agentsDir, record?.version ?? version, owned, writes); }
    catch (e) { throw new Error(`설치 기록을 쓰지 못했습니다(기록 실패, 파일 0개 설치됨): ${e.message}`); }
  }
  const results = [];
  let written = 0, failure = null;
  try {
    for (const { name, content, action, detail } of items) {
      if (name in writes) { await atomicWrite(join(agentsDir, name), content); written++; }
      results.push({ name, action, ...(detail ? { detail } : {}) });
    }
    for (const [name, hash] of Object.entries(owned)) {
      if (source.has(name)) continue;
      const path = join(agentsDir, name), target = await inspect(path);
      if (target.kind === 'none') continue;
      if (target.kind === 'file' && target.hash === hash) { await rm(path); results.push({ name, action: '삭제', detail: '새 원본에 없는 이전 파일' }); }
      else results.push({ name, action: '남김', detail: '사용자가 고친 파일이라 지우지 않았습니다' });
    }
  } catch (e) { failure = e; }
  // 중간에 실패해도 기록에는 실제로 우리 것인 파일만 남긴다.
  const done = {};
  for (const name of new Set([...Object.keys(owned), ...Object.keys(writes)])) {
    const target = await inspect(join(agentsDir, name)).catch(() => ({ kind: 'none' }));
    if (target.kind === 'file' && (target.hash === owned[name] || target.hash === writes[name])) done[name] = target.hash;
  }
  try { await writeRecord(agentsDir, version, done); }
  catch (e) {
    throw new Error(`설치 기록을 쓰지 못했습니다(기록 실패, 파일 ${written}개 설치됨). 다시 실행하면 놓은 파일을 회수합니다: ${e.message}`
      + (failure ? ` / 설치 중 오류: ${failure.message}` : ''));
  }
  if (failure) throw failure;
  return { results, conflicts: results.filter((r) => r.action === '충돌').length };
}

const STATUS_BY_ACTION = { 설치: '없음', '변경 없음': '설치됨', 갱신: '최신 아님' };
const STATUS_BY_REASON = { link: '충돌(링크)', other: '충돌(사용자 파일)', name: '충돌(이름)', user: '충돌(사용자 파일)' };

async function status(ctx) {
  const { agentsDir, source } = ctx;
  const record = await loadRecord(agentsDir);
  const owned = await ownedFiles(agentsDir, record);
  const results = (await plan(agentsDir, source, owned))
    .map(({ name, action, reason }) => ({ name, state: reason ? STATUS_BY_REASON[reason] : STATUS_BY_ACTION[action] }));
  for (const name of Object.keys(owned))
    if (!source.has(name) && (await inspect(join(agentsDir, name))).kind !== 'none') results.push({ name, state: '원본에서 사라짐' });
  return { results, recordedVersion: record?.version ?? null, conflicts: results.filter((r) => r.state.startsWith('충돌')).length };
}

async function uninstall(ctx) {
  const { agentsDir } = ctx;
  const record = await loadRecord(agentsDir);
  if (!record) return { results: [], recordedVersion: null, conflicts: 0, kept: 0, note: '설치 기록이 없어 지울 것이 없습니다.' };
  const results = [];
  for (const [name, hash] of Object.entries(await ownedFiles(agentsDir, record))) {
    const path = join(agentsDir, name), target = await inspect(path);
    if (target.kind === 'none') results.push({ name, action: '이미 없음' });
    else if (target.kind === 'file' && target.hash === hash) { await rm(path); results.push({ name, action: '삭제' }); }
    else results.push({ name, action: '남김', detail: target.kind === 'file' ? '사용자가 고친 파일입니다' : '일반 파일이 아니라 지우지 않았습니다' });
  }
  await rm(join(agentsDir, RECORD));
  return { results, recordedVersion: record.version, conflicts: 0, kept: results.filter((r) => r.action === '남김').length };
}

const parseLock = (raw) => {
  try {
    const data = JSON.parse(raw.toString('utf8'));
    return Number.isInteger(data?.pid) && data.pid > 0 ? { pid: data.pid, startedAt: typeof data.startedAt === 'string' ? data.startedAt : null } : null;
  } catch { return null; }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// install·uninstall은 한 번에 하나만 돈다. 잠금은 끝나면 항상 푼다.
async function withLock(agentsDir, task) {
  await mkdir(agentsDir, { recursive: true });
  const path = join(agentsDir, LOCK);
  let handle = null, held = null;
  for (let attempt = 0; attempt < 3 && !handle; attempt++) {
    try { handle = await open(path, 'wx'); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const raw = await readOrNull(path);
    if (raw === null) continue;
    held = parseLock(raw);
    // PID가 기록돼 있고 그 프로세스가 끝났으면 남은 잠금이다. 읽은 내용 그대로일 때만 치운다.
    if (held && !alive(held.pid)) {
      if ((await readOrNull(path))?.equals(raw)) await rm(path, { force: true });
      process.stderr.write(`끝난 프로세스(PID ${held.pid})가 남긴 잠금을 치웠습니다: ${path}\n`);
      held = null;
      continue;
    }
    break;
  }
  if (!handle) {
    const age = await lstat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
    const who = held ? `PID ${held.pid}${held.startedAt ? `, 시작 ${held.startedAt}` : ''}` : '잠금 파일에 PID가 없습니다';
    throw new Error(`다른 설치가 진행 중입니다(${who}).${age > STALE_LOCK_MS ? ' 잠금이 10분 넘게 남아 있습니다.' : ''}`
      + ` 진행 중인 설치가 없다면 잠금 파일을 지운 뒤 다시 실행하세요: ${path}`);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    await handle.close();
    handle = null;
    return await task();
  } finally {
    await handle?.close().catch(() => {});
    await rm(path, { force: true });
  }
}

function render(command, out) {
  const lines = [];
  if (command === 'status') {
    lines.push(`설치 기록 버전: ${out.recordedVersion ?? '없음'} / 패키지 버전: ${out.version}`);
    for (const r of out.results) lines.push(`${r.state.padEnd(12)} ${r.name}`);
  } else {
    for (const r of out.results) lines.push(`${r.action.padEnd(8)} ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    if (out.note) lines.push(out.note);
    if (command === 'install') lines.push(out.conflicts ? `충돌 ${out.conflicts}개는 그대로 두었습니다. 같은 이름의 사용자 파일을 옮기거나 이름을 바꾼 뒤 다시 실행하세요.` : '완료했습니다. 새 Codex 세션에서 역할이 보입니다.');
    if (command === 'uninstall') lines.push(out.kept ? `사용자가 고친 파일 ${out.kept}개를 남기고 설치 기록을 지웠습니다.` : '설치 기록과 파일을 모두 지웠습니다.');
  }
  if (command === 'status' && out.conflicts) lines.push(`충돌 ${out.conflicts}개: 사용자 파일·심볼릭 링크·같은 역할 이름을 쓰는 파일이라 install이 건드리지 않습니다.`);
  return lines.join('\n') + '\n';
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      'codex-home': { type: 'string' }, source: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) { throw new UsageError(e.message); }
  const { values, positionals } = parsed;
  const usage = 'usage: codex-agents.mjs <install|status|uninstall> [--codex-home <dir>] [--source <dir>] [--json]';
  if (values.help) { process.stdout.write(usage + '\n'); return 0; }
  const [command, ...rest] = positionals;
  if (!['install', 'status', 'uninstall'].includes(command) || rest.length) throw new UsageError(usage);
  const codexHome = resolve(values['codex-home'] || process.env.CODEX_HOME || join(homedir(), '.codex'));
  const sourceDir = resolve(values.source || join(here, '..', 'codex', 'agents'));
  const agentsDir = join(codexHome, 'agents');
  const version = await pluginVersion();
  const ctx = { agentsDir, version, source: command === 'uninstall' ? new Map() : await loadSource(sourceDir) };
  const task = () => ({ install, status, uninstall })[command](ctx);
  // 지울 것이 없는 uninstall은 agents 디렉터리를 새로 만들지 않는다.
  const locked = command === 'install' || (command === 'uninstall' && (await inspect(agentsDir)).kind !== 'none');
  const out = locked ? await withLock(agentsDir, task) : await task();
  const payload = { command, codexHome, agentsDir, version, ...out };
  process.stdout.write(values.json ? JSON.stringify(payload, null, 2) + '\n' : `대상: ${agentsDir}\n` + render(command, payload));
  return 0;
}

process.on('unhandledRejection', (e) => { process.stderr.write(`오류: ${e?.message ?? e}\n`); process.exit(1); });
main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`${e instanceof UsageError ? '입력 오류' : '실행 실패'}: ${e.message}\n`);
  process.exitCode = 1;
});

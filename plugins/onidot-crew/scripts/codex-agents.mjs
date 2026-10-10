#!/usr/bin/env node
// onidot crew 역할 정의를 Codex 사용자 설정(<codex-home>/agents)에 놓고 갱신·제거한다.
// 설치 기록의 해시와 일치하는 파일만 우리가 소유한 것으로 보고 건드린다.
import { readFile, writeFile, readdir, mkdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PACKAGE = 'onidot-crew';
const RECORD = '.onidot-crew.json';
const OWNED_NAME = /^crew-[A-Za-z0-9._-]+\.toml$/;
const here = dirname(fileURLToPath(import.meta.url));
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

class UsageError extends Error {}

const readOrNull = async (path) => {
  try { return await readFile(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};

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

async function loadRecord(agentsDir) {
  const raw = await readOrNull(join(agentsDir, RECORD));
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw new UsageError(`설치 기록이 손상됐습니다: ${join(agentsDir, RECORD)}`); }
  if (data?.schemaVersion !== 1 || data.package !== PACKAGE || typeof data.files !== 'object' || data.files === null || Array.isArray(data.files))
    throw new UsageError(`설치 기록 형식이 맞지 않습니다: ${join(agentsDir, RECORD)}`);
  // 기록이 변조돼도 crew-*.toml 밖은 건드리지 않는다.
  const files = {};
  for (const [name, hash] of Object.entries(data.files)) if (OWNED_NAME.test(name) && typeof hash === 'string') files[name] = hash;
  return { version: String(data.version ?? ''), files };
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

async function writeRecord(agentsDir, version, files) {
  await mkdir(agentsDir, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  await atomicWrite(join(agentsDir, RECORD), JSON.stringify({ schemaVersion: 1, package: PACKAGE, version, files: sorted }, null, 2) + '\n');
}

async function install(ctx) {
  const { agentsDir, source, version } = ctx;
  const record = await loadRecord(agentsDir);
  const prior = record?.files ?? {};
  const owned = {}, results = [];
  await mkdir(agentsDir, { recursive: true });
  try {
    for (const [name, content] of [...source].sort(([a], [b]) => a.localeCompare(b))) {
      const path = join(agentsDir, name), want = sha(content), current = await readOrNull(path);
      if (current === null) { await atomicWrite(path, content); owned[name] = want; results.push({ name, action: '설치' }); }
      else if (prior[name] !== undefined && prior[name] === sha(current)) {
        if (prior[name] === want) results.push({ name, action: '변경 없음' });
        else { await atomicWrite(path, content); results.push({ name, action: '갱신' }); }
        owned[name] = want;
      } else results.push({ name, action: '충돌', detail: '사용자 파일이라 건드리지 않았습니다' });
    }
    for (const [name, hash] of Object.entries(prior)) {
      if (source.has(name)) continue;
      const path = join(agentsDir, name), current = await readOrNull(path);
      if (current === null) continue;
      if (sha(current) === hash) { await rm(path); results.push({ name, action: '삭제', detail: '새 원본에 없는 이전 파일' }); }
      else results.push({ name, action: '남김', detail: '사용자가 고친 파일이라 지우지 않았습니다' });
    }
  } finally {
    // 중간에 실패해도 기록에는 실제로 우리가 놓은 파일만 남긴다.
    const done = { ...owned };
    for (const [name, hash] of Object.entries(prior)) if (!source.has(name) && !(name in done)) {
      const current = await readOrNull(join(agentsDir, name)).catch(() => null);
      if (current && sha(current) === hash) done[name] = hash;
    }
    for (const [name, hash] of Object.entries(prior)) if (source.has(name) && !(name in done)) {
      const current = await readOrNull(join(agentsDir, name)).catch(() => null);
      if (current && sha(current) === hash) done[name] = hash;
    }
    await writeRecord(agentsDir, version, done).catch(() => {});
  }
  return { results, conflicts: results.filter((r) => r.action === '충돌').length };
}

async function status(ctx) {
  const { agentsDir, source } = ctx;
  const record = await loadRecord(agentsDir);
  const prior = record?.files ?? {}, results = [];
  for (const [name, content] of [...source].sort(([a], [b]) => a.localeCompare(b))) {
    const current = await readOrNull(join(agentsDir, name));
    let state;
    if (current === null) state = '없음';
    else if (prior[name] === undefined || prior[name] !== sha(current)) state = '충돌(사용자 파일)';
    else state = prior[name] === sha(content) ? '설치됨' : '최신 아님';
    results.push({ name, state });
  }
  for (const name of Object.keys(prior))
    if (!source.has(name) && await readOrNull(join(agentsDir, name)) !== null) results.push({ name, state: '원본에서 사라짐' });
  return { results, recordedVersion: record?.version ?? null, conflicts: results.filter((r) => r.state.startsWith('충돌')).length };
}

async function uninstall(ctx) {
  const { agentsDir } = ctx;
  const record = await loadRecord(agentsDir);
  if (!record) return { results: [], recordedVersion: null, conflicts: 0, kept: 0, note: '설치 기록이 없어 지울 것이 없습니다.' };
  const results = [];
  for (const [name, hash] of Object.entries(record.files)) {
    const path = join(agentsDir, name), current = await readOrNull(path);
    if (current === null) results.push({ name, action: '이미 없음' });
    else if (sha(current) === hash) { await rm(path); results.push({ name, action: '삭제' }); }
    else results.push({ name, action: '남김', detail: '사용자가 고친 파일입니다' });
  }
  await rm(join(agentsDir, RECORD));
  return { results, recordedVersion: record.version, conflicts: 0, kept: results.filter((r) => r.action === '남김').length };
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
  if (command === 'status' && out.conflicts) lines.push(`충돌 ${out.conflicts}개: 사용자 파일이라 install이 건드리지 않습니다.`);
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
  const out = await { install, status, uninstall }[command](ctx);
  const payload = { command, codexHome, agentsDir, version, ...out };
  process.stdout.write(values.json ? JSON.stringify(payload, null, 2) + '\n' : `대상: ${agentsDir}\n` + render(command, payload));
  return 0;
}

process.on('unhandledRejection', (e) => { process.stderr.write(`오류: ${e?.message ?? e}\n`); process.exit(1); });
main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`${e instanceof UsageError ? '입력 오류' : '실행 실패'}: ${e.message}\n`);
  process.exitCode = 1;
});

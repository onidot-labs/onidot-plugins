#!/usr/bin/env node
// 버전과 무관한 고정 실행기를 <codex-home>/onidot-oauth/bin에 놓고 config.toml에 넣을 한 줄을 출력한다.
// 설치 기록의 해시와 같은 파일만 갱신하고, 사용자가 고친 파일은 충돌로 남긴다. config.toml은 고치지 않는다.
import { realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, rm, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const RECORD = '.onidot-helper.json';
const here = dirname(fileURLToPath(import.meta.url));
// 설치 대상 이름 -> 이 폴더의 원본 파일
const SOURCES = { 'oauth-helper.mjs': 'oauth-launcher.mjs', 'oauth-helper-fallback.mjs': 'oauth-helper.mjs' };
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const readOrNull = async (path) => { try { return await readFile(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

async function inspect(path) {
  let stat;
  try { stat = await lstat(path); } catch (e) { if (e.code === 'ENOENT') return { kind: 'none' }; throw e; }
  if (stat.isSymbolicLink()) return { kind: 'link' };
  if (!stat.isFile()) return { kind: 'other' };
  return { kind: 'file', hash: sha(await readFile(path)) };
}
async function atomicWrite(path, data) {
  const tmp = join(dirname(path), `.onidot-helper.${process.pid}.${Date.now()}.tmp`);
  try { await writeFile(tmp, data, { mode: 0o644 }); await rename(tmp, path); } catch (e) { await rm(tmp, { force: true }); throw e; }
}
async function loadRecord(bin) {
  const raw = await readOrNull(join(bin, RECORD));
  if (!raw) return { files: {}, pending: {} };
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw new Error(`설치 기록이 손상됐습니다: ${join(bin, RECORD)}`); }
  const pick = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([k, h]) => k in SOURCES && typeof h === 'string'));
  return { files: pick(data.files), pending: pick(data.pending) };
}
const writeRecord = (bin, files, pending = {}) => atomicWrite(join(bin, RECORD), JSON.stringify({ schemaVersion: 1, files, ...(Object.keys(pending).length ? { pending } : {}) }, null, 2) + '\n');

export async function install({ codexHome = process.env.CODEX_HOME || resolve(homedir(), '.codex'), sourceDir = here } = {}) {
  codexHome = resolve(codexHome);
  const bin = join(codexHome, 'onidot-oauth/bin');
  const launcher = join(bin, 'oauth-helper.mjs');
  if (/["'\n\r\\$`]/.test(launcher)) throw new Error(`경로에 따옴표·역슬래시·개행·$·백틱이 있어 config에 안전하게 쓸 수 없습니다: ${launcher}`);
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const record = await loadRecord(bin);
  const items = [];
  for (const [name, from] of Object.entries(SOURCES)) {
    const content = await readFile(join(sourceDir, from));
    const want = sha(content), target = await inspect(join(bin, name));
    const item = { name, content, want };
    if (target.kind === 'link' || target.kind === 'other') Object.assign(item, { action: '충돌', detail: '일반 파일이 아니라 건드리지 않았습니다' });
    else if (target.kind === 'none') item.action = '설치';
    else if (target.hash === want) item.action = '변경 없음';
    else if (target.hash === record.files[name] || target.hash === record.pending[name]) item.action = '갱신';
    else Object.assign(item, { action: '충돌', detail: '사용자가 고친 파일이라 건드리지 않았습니다' });
    items.push(item);
  }
  const writes = items.filter((i) => i.action === '설치' || i.action === '갱신');
  const owned = { ...record.files };
  for (const i of items) if (i.action === '변경 없음') owned[i.name] = i.want;
  // 쓰기 전에 의도한 해시를 대기 기록에 남긴다. 중간에 실패해도 다음 실행이 우리 파일로 회수한다.
  if (writes.length) await writeRecord(bin, owned, Object.fromEntries(writes.map((i) => [i.name, i.want])));
  for (const i of writes) { await atomicWrite(join(bin, i.name), i.content); owned[i.name] = i.want; }
  if (writes.length) await writeRecord(bin, owned);
  const configLine = `http_headers_helper = 'ONIDOT_ALIAS=<별칭> ONIDOT_APP_URL="<APP_URL>" ONIDOT_MCP_URL="<MCP_URL>" ONIDOT_SCOPE="<SCOPE>" node "${launcher}" headers'`;
  return {
    bin, launcher, configLine,
    results: items.map(({ name, action, detail }) => ({ name, action, ...(detail ? { detail } : {}) })),
    conflicts: items.filter((i) => i.action === '충돌').map(({ name, detail }) => ({ name, detail })),
  };
}

async function main() {
  const { values } = parseArgs({ options: { 'codex-home': { type: 'string' } }, allowPositionals: false });
  const result = await install(values['codex-home'] ? { codexHome: values['codex-home'] } : {});
  for (const r of result.results) process.stderr.write(`${r.action}: ${join(result.bin, r.name)}${r.detail ? ` (${r.detail})` : ''}\n`);
  if (result.conflicts.length) {
    process.stderr.write('충돌한 파일이 있어 고정 실행기가 최신이 아닐 수 있습니다. 파일을 직접 확인한 뒤 지우고 다시 실행하세요.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(result.configLine + '\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}

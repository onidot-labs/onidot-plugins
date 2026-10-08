import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('fixtures/recording-mcp.mjs', import.meta.url));
const personal = 'fixture-personal';
const entry = { spaceId: personal, kind: 'LESSON', title: 'CSV 날짜 오류', body: '행별 오류를 수집하여 유효 11개를 처리한다.', status: 'VERIFIED', sources: [{ kind: 'COMMAND', ref: 'fixture 검사', note: '유효 11개 처리' }] };
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'onidot-mcp-fixture-'));
  const guide = join(dir, 'guide.md');
  await writeFile(guide, '일반 작업도 최종 답변 전 recall로 중복을 확인하고 remember로 배움을 기록한다.');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, guide, records: join(dir, 'isolated') };
}
function connect(paths, mode = 'write') {
  const process = spawn(globalThis.process.execPath, [fixture], { env: { ...globalThis.process.env, ONIDOT_RECORDING_FIXTURE_DIR: paths.records, ONIDOT_RECORDING_GUIDE_FILE: paths.guide, ONIDOT_RECORDING_FIXTURE_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0, stderr = '';
  const pending = new Map();
  process.stderr.on('data', data => { stderr += data; });
  createInterface({ input: process.stdout }).on('line', line => {
    const response = JSON.parse(line), waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); waiter.resolve(response); }
  });
  process.on('exit', code => {
    for (const waiter of pending.values()) waiter.reject(new Error(`fixture exit ${code}: ${stderr}`));
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
  });
  return { request, call: async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result, kill: () => process.kill(), close: () => { process.stdin.end(); return new Promise(resolve => process.once('exit', resolve)); } };
}
const data = result => JSON.parse(result.content[0].text);

test('격리 MCP 프로토콜은 시작 지침과 합성 결과를 제공하고 새 프로세스에서 저장을 회상한다', { timeout: 10000 }, async t => {
  const paths = await setup(t), client = connect(paths);
  t.after(client.kill);
  const init = await client.request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.result.serverInfo.name, 'onidot-recording-test');
  const tools = (await client.request('tools/list')).result.tools;
  for (const name of ['get_onidot_guide', 'get_assistant_context', 'list_spaces', 'recall', 'remember', 'get_record', 'inspect_fixture']) assert.ok(tools.some(tool => tool.name === name), name);
  const guide = data(await client.call('get_onidot_guide'));
  assert.ok(guide.defaultGuide.includes('최종 답변 전'));
  assert.deepEqual(guide.spaces.map(space => space.type), ['PERSONAL', 'TEAM']);
  const inspection = data(await client.call('inspect_fixture'));
  assert.equal(inspection.validRows, 11);
  assert.ok(inspection.cause.includes('invalid_date'));
  const saved = data(await client.call('remember', entry));
  assert.ok(saved.record.id);
  assert.equal(saved.record.version, 1);
  assert.deepEqual(saved.similar, []);
  await client.close();
  const resumed = connect(paths);
  t.after(resumed.kill);
  const found = data(await resumed.call('recall', { query: 'CSV', spaceIds: [personal] }));
  assert.equal(found.records[0].id, saved.record.id);
  assert.deepEqual(data(await resumed.call('get_record', { recordId: saved.record.id })).record, saved.record);
  const updated = data(await resumed.call('remember', { ...entry, recordId: saved.record.id, expectedVersion: 1, body: '갱신 내용' }));
  assert.equal(updated.record.version, 2);
  assert.equal((await resumed.call('remember', { ...entry, recordId: saved.record.id, expectedVersion: 1 })).isError, true);
  await resumed.close();
  assert.equal((await stat(paths.records)).mode & 0o777, 0o700);
  for (const file of ['records.json', 'calls.jsonl']) assert.equal((await stat(join(paths.records, file))).mode & 0o777, 0o600);
  const calls = (await readFile(join(paths.records, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(call => call.tool === 'remember' && call.success && call.recordId === saved.record.id));
  for (const call of calls) assert.deepEqual(Object.keys(call).sort(), ['recordId', 'success', 'tool']);
  assert.ok(!(await readFile(join(paths.records, 'calls.jsonl'), 'utf8')).includes(entry.body));
});
test('VERIFIED 출처 누락과 읽기 전용·실패 모드는 저장 성공을 반환하지 않는다', { timeout: 10000 }, async t => {
  for (const mode of ['write', 'read', 'fail']) {
    const paths = await setup(t), client = connect(paths, mode);
    t.after(client.kill);
    const tools = (await client.request('tools/list')).result.tools;
    assert.equal(tools.some(tool => tool.name === 'remember'), mode !== 'read');
    assert.equal((await client.call('remember', { ...entry, sources: [] })).isError, true);
    if (mode !== 'write') assert.equal((await client.call('remember', entry)).isError, true);
    assert.deepEqual(data(await client.call('recall')).records, []);
    await client.close();
  }
});
test('fixture 저장 디렉터리가 없으면 시작을 거부한다', () => {
  const env = { ...process.env }; delete env.ONIDOT_RECORDING_FIXTURE_DIR;
  const result = spawnSync(process.execPath, [fixture], { env, input: '', encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('ONIDOT_RECORDING_FIXTURE_DIR'));
  assert.equal(result.stdout, '');
});

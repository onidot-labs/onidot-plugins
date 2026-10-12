import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'source/crew/runtime/flow-queue.mjs');
const { oniDirs, findHost } = await import(script);
const SID = '8cbb5482-3793-4c9d-bde6-2a408981e067';
const WORK = '0rwm0wcpqz6mg';
const LEDGER = '0rwm1abcdefgh';
const STAGE = '0rwm2stage0aa';
const SPACE = '0rwm3space0aa';
const TOKEN = 'test-runtime-token';

// 가짜 런타임. 받은 요청을 모으고 status·지연을 바꿀 수 있다.
const fakeRuntime = async ({ status = 200, delay = 0, readiness = { ready: true, connection: 'CONNECTED', instanceId: 'i1', deviceId: 'd1', reason: '' } } = {}) => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(req.url.startsWith('/v1/readiness') ? JSON.stringify(readiness) : '{}');
      }, delay);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, port: server.address().port, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
};

const fixture = async ({ runtime = null, token = true } = {}) => {
  const base = await mkdtemp(join(tmpdir(), 'onidot-crew-rt-'));
  const dirs = { data: join(base, 'plugin-data'), oniConfig: join(base, 'config'), oniData: join(base, 'data'), oniState: join(base, 'state'), oniRuntime: join(base, 'runtime') };
  await mkdir(dirs.data, { recursive: true });
  await mkdir(dirs.oniConfig, { recursive: true });
  await mkdir(dirs.oniRuntime, { recursive: true });
  if (runtime) await writeFile(join(dirs.oniRuntime, 'oni-runtime.json'), JSON.stringify({ port: runtime.port, pid: process.pid, startedAt: new Date().toISOString(), version: '0.0.0' }));
  if (token) await writeFile(join(dirs.oniConfig, 'runtime-token'), TOKEN + '\n', { mode: 0o600 });
  const env = { PATH: process.env.PATH, ONI_CONFIG_DIR: dirs.oniConfig, ONI_DATA_DIR: dirs.oniData, ONI_STATE_DIR: dirs.oniState, ONI_RUNTIME_DIR: dirs.oniRuntime };
  return { base, ...dirs, env, inbox: join(dirs.oniData, 'runtime', 'inbox'), cleanup: () => rm(base, { recursive: true, force: true }) };
};

const run = (f, args, { input, claudeData = true } = {}) => new Promise((resolve) => {
  const started = performance.now();
  const child = spawn(process.execPath, [script, ...args], { env: { ...f.env, ...(claudeData ? { CLAUDE_PLUGIN_DATA: f.data } : {}), CLAUDE_CODE_SESSION_ID: SID } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr, ms: performance.now() - started }));
  child.stdin.end(input === undefined ? '' : JSON.stringify(input));
});
const hook = (f, event, input) => run(f, ['hook', event], { input });
const cli = (f, ...args) => run(f, [...args, '--data', f.data]);
const startRuntime = (f, extra = []) => cli(f, 'start', '--work', WORK, '--session', LEDGER, '--space', SPACE, '--mode', 'runtime', ...extra);
const events = (rt) => rt.requests.filter((r) => r.method === 'POST').flatMap((r) => JSON.parse(r.body).events);
const inboxFiles = async (f) => { try { return (await readdir(f.inbox)).sort(); } catch { return []; } };
const inboxEvents = async (f) => Promise.all((await inboxFiles(f)).map(async (n) => JSON.parse(await readFile(join(f.inbox, n), 'utf8'))));
const flowFiles = async (f) => { try { return (await readdir(join(f.data, 'flow'))).sort(); } catch { return []; } };

const subagentStart = (id, type = 'onidot-crew:worker') => ({ session_id: SID, hook_event_name: 'SubagentStart', agent_id: id, agent_type: type });
const subagentStop = (id, type = 'onidot-crew:worker') => ({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: id, agent_type: type });
const postAgent = (id, description = '일 맡기기') => ({ session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description, subagent_type: 'x' }, tool_response: { agentId: id } });

test('경로 규칙: macOS·Linux 기본값과 ONI_* 덮어쓰기', () => {
  const mac = oniDirs({}, '/Users/u', 'darwin');
  assert.deepEqual(mac, { config: '/Users/u/Library/Application Support/onidot/config', data: '/Users/u/Library/Application Support/onidot/data',
    state: '/Users/u/Library/Application Support/onidot/state', runtime: '/Users/u/Library/Application Support/onidot/runtime' });
  assert.deepEqual(oniDirs({}, '/home/u', 'linux'), { config: '/home/u/.config/onidot', data: '/home/u/.local/share/onidot', state: '/home/u/.local/state/onidot', runtime: '/home/u/.local/state/onidot/runtime' });
  assert.deepEqual(oniDirs({ XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d', XDG_STATE_HOME: '/s', XDG_RUNTIME_DIR: '/r' }, '/home/u', 'linux'),
    { config: '/c/onidot', data: '/d/onidot', state: '/s/onidot', runtime: '/r/onidot' });
  assert.equal(oniDirs({ ONI_CONFIG_DIR: '/x/c', ONI_DATA_DIR: '/x/d', ONI_STATE_DIR: '/x/s', ONI_RUNTIME_DIR: '/x/r' }, '/home/u', 'linux').runtime, '/x/r');
});

test('호스트 PID: 조상을 따라 올라가 claude를 찾고 4단계 안에 없으면 비운다', () => {
  const table = { 100: { ppid: 90, lstart: 'Mon Oct 12 07:36:04 2026', comm: '/usr/local/bin/node' }, 90: { ppid: 80, lstart: 'Mon Oct 12 07:36:03 2026', comm: '/bin/sh' },
    80: { ppid: 70, lstart: 'Mon Oct 12 07:05:57 2026', comm: '/Users/u/Library/Application Support/Claude/claude-code/2.1.295/abc/claude.app/Contents/MacOS/claude' }, 70: { ppid: 1, lstart: 'Mon Oct 11 15:58:26 2026', comm: '/Applications/Claude.app/Contents/MacOS/Claude' } };
  const ps = (pid) => table[pid] ?? null;
  const host = findHost(100, ps);
  assert.equal(host.hostPid, 80);
  assert.equal(host.hostStartedAt, new Date('Mon Oct 12 07:05:57 2026').toISOString());
  assert.equal(host.hostVersion, '2.1.295');
  // node 기반 실행: comm은 node, 인자에 claude
  const nodeTable = { 100: { ppid: 90, lstart: 'Mon Oct 12 07:36:03 2026', comm: '/bin/sh' }, 90: { ppid: 1, lstart: 'Mon Oct 12 07:05:57 2026', comm: '/usr/bin/node', args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' } };
  assert.equal(findHost(100, (p) => nodeTable[p] ?? null).hostPid, 90);
  // 못 찾음
  const far = { 100: { ppid: 99, lstart: "x", comm: "a" }, 99: { ppid: 98, lstart: "x", comm: "b" }, 98: { ppid: 97, lstart: "x", comm: "c" }, 97: { ppid: 96, lstart: "x", comm: "d" }, 96: { ppid: 95, lstart: "x", comm: "e" }, 95: { ppid: 1, lstart: "Mon Oct 12 07:05:57 2026", comm: "claude" } };
  assert.deepEqual(findHost(100, (p) => far[p] ?? null), {});
  assert.deepEqual(findHost(100, () => null), {});
});

test('start: 모드를 정하고 FLOW_BOUND를 보낸다. 생략하면 queue이며 아무것도 보내지 않는다', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    const q = await cli(f, 'start', '--work', WORK, '--session', LEDGER);
    assert.equal(q.status, 0, q.stderr);
    assert.equal(JSON.parse(await readFile(join(f.data, 'flow', `${SID}.active.json`), 'utf8')).mode, 'queue');
    assert.equal(rt.requests.length, 0);
    const r = await startRuntime(f);
    assert.equal(r.status, 0, r.stderr);
    const marker = JSON.parse(await readFile(join(f.data, 'flow', `${SID}.active.json`), 'utf8'));
    assert.equal(marker.mode, 'runtime');
    assert.equal(marker.spaceId, SPACE);
    const [bound] = events(rt);
    assert.equal(bound.kind, 'FLOW_BOUND');
    assert.deepEqual(bound.data, { spaceId: SPACE, workId: WORK, sessionId: LEDGER });
    assert.equal(bound.hostSession, SID);
    assert.equal(bound.host, 'claude-code');
    assert.equal(bound.schemaVersion, 1);
    const req = rt.requests[0];
    assert.equal(req.url, '/v1/hook-events');
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.match(req.headers.host, /^127\.0\.0\.1:\d+$/);
  } finally { await rt.close(); await f.cleanup(); }
});

test('start: 보내지 않은 항목이 남았으면 runtime으로 바꾸지 않고(exit 3), --space 없는 runtime은 exit 2', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    assert.equal((await cli(f, 'start', '--work', WORK, '--session', LEDGER)).status, 0);
    assert.equal((await hook(f, 'subagent-start', subagentStart('a1'))).status, 0);
    const refused = await startRuntime(f);
    assert.equal(refused.status, 3, refused.stderr);
    assert.equal(JSON.parse(await readFile(join(f.data, 'flow', `${SID}.active.json`), 'utf8')).mode, 'queue');
    assert.equal(rt.requests.length, 0);
    assert.equal((await cli(f, 'start', '--work', WORK, '--session', LEDGER, '--mode', 'runtime')).status, 2);
    assert.equal((await cli(f, 'start', '--work', WORK, '--session', LEDGER, '--mode', 'bogus')).status, 2);
  } finally { await rt.close(); await f.cleanup(); }
});

test('런타임 모드 훅은 봉투를 보내고 대기열·알림을 만들지 않으며 stdout이 비어 있다', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    assert.equal((await startRuntime(f)).status, 0);
    const before = events(rt).length;
    const results = [];
    results.push(await hook(f, 'subagent-start', subagentStart('a1')));
    results.push(await hook(f, 'post-agent', postAgent('a1', `로그인 구현 [stage:${STAGE}]`)));
    results.push(await hook(f, 'subagent-stop', subagentStop('a1')));
    results.push(await hook(f, 'stop', { session_id: SID, hook_event_name: 'Stop' }));
    results.push(await hook(f, 'session-end', { session_id: SID, hook_event_name: 'SessionEnd', reason: 'other' }));
    for (const r of results) { assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, ''); }
    const sent = events(rt).slice(before);
    assert.deepEqual(sent.map((e) => e.kind), ['SUBAGENT_STARTED', 'AGENT_LINKED', 'SUBAGENT_FINISHED', 'TURN_ENDED', 'SESSION_ENDED']);
    assert.equal(sent[0].agentId, 'a1');
    assert.equal(sent[0].agentType, 'onidot-crew:worker');
    assert.equal(sent[1].agentId, 'a1');
    assert.equal(sent[1].stageId, STAGE);
    for (const e of sent) {
      assert.equal(e.hostSession, SID);
      assert.equal(e.host, 'claude-code');
      assert.match(e.eventId, /^[0-9a-z:-]+$/);
      assert.ok(!Number.isNaN(Date.parse(e.occurredAt)));
      assert.equal(JSON.stringify(e).includes('로그인'), false, '프롬프트·설명 본문은 싣지 않는다');
    }
    assert.deepEqual(await flowFiles(f), [`${SID}.active.json`]);
    assert.deepEqual(await inboxFiles(f), []);
    // 같은 사건을 다시 보내면 같은 eventId
    await hook(f, 'subagent-stop', subagentStop('a1'));
    const again = events(rt).filter((e) => e.kind === 'SUBAGENT_FINISHED');
    assert.equal(again.length, 2);
    assert.equal(again[0].eventId, again[1].eventId);
    assert.notEqual(sent[0].eventId, sent[2].eventId);
  } finally { await rt.close(); await f.cleanup(); }
});

test('런타임 모드 SessionStart: 기존 안내를 출력하고 SESSION_STARTED를 보낸다. 활성 표시가 없으면 아무것도 보내지 않는다', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    const none = await hook(f, 'session-start', { session_id: SID, hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(none.status, 0);
    assert.ok(JSON.parse(none.stdout).hookSpecificOutput.additionalContext.includes('명령 접두사'));
    assert.equal(rt.requests.length, 0);
    assert.deepEqual(await inboxFiles(f), []);
    assert.equal((await startRuntime(f)).status, 0);
    const r = await hook(f, 'session-start', { session_id: SID, hook_event_name: 'SessionStart', source: 'resume' });
    assert.equal(r.status, 0);
    assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('명령 접두사'));
    const started = events(rt).filter((e) => e.kind === 'SESSION_STARTED');
    assert.equal(started.length, 1);
    assert.equal(started[0].hostSession, SID);
  } finally { await rt.close(); await f.cleanup(); }
});

test('활성 표시가 없으면 stop·session-end·subagent 훅은 아무것도 하지 않는다', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    for (const [e, i] of [['stop', { session_id: SID }], ['session-end', { session_id: SID }], ['subagent-start', subagentStart('a1')], ['subagent-stop', subagentStop('a1')], ['post-agent', postAgent('a1')]]) {
      const r = await hook(f, e, i);
      assert.equal(r.status, 0); assert.equal(r.stdout, '');
    }
    assert.equal(rt.requests.length, 0);
    assert.deepEqual(await inboxFiles(f), []);
    assert.deepEqual(await flowFiles(f), []);
  } finally { await rt.close(); await f.cleanup(); }
});

test('대기열 모드에서 stop·session-end는 아무것도 보내지 않고, 기존 훅은 대기열에 적는다', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    assert.equal((await cli(f, 'start', '--work', WORK, '--session', LEDGER)).status, 0);
    await hook(f, 'stop', { session_id: SID }); await hook(f, 'session-end', { session_id: SID });
    await hook(f, 'subagent-start', subagentStart('a1'));
    assert.equal(rt.requests.length, 0);
    assert.deepEqual(await inboxFiles(f), []);
    assert.ok((await readFile(join(f.data, 'flow', `${SID}.queue.jsonl`), 'utf8')).includes('SUBAGENT_STARTED'));
  } finally { await rt.close(); await f.cleanup(); }
});

test('런타임이 없으면 이벤트 하나당 파일 하나를 inbox에 쓰고(0600/0700) exit 0', async () => {
  const f = await fixture({ runtime: null });
  try {
    assert.equal((await startRuntime(f)).status, 0); // FLOW_BOUND도 inbox로
    const r1 = await hook(f, 'subagent-start', subagentStart('a1'));
    const r2 = await hook(f, 'subagent-stop', subagentStop('a1'));
    for (const r of [r1, r2]) { assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, ''); }
    const names = await inboxFiles(f);
    assert.equal(names.length, 3);
    for (const n of names) {
      assert.match(n, /^\d+-\d+-[0-9a-f]+\.json$/);
      assert.equal((await stat(join(f.inbox, n))).mode & 0o777, 0o600);
    }
    assert.equal((await stat(f.inbox)).mode & 0o777, 0o700);
    const kinds = (await inboxEvents(f)).map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['FLOW_BOUND', 'SUBAGENT_FINISHED', 'SUBAGENT_STARTED']);
    assert.deepEqual(await flowFiles(f), [`${SID}.active.json`]);
  } finally { await f.cleanup(); }
});

test('토큰이 없거나 401이거나 응답이 느리면 inbox로 떨어지고 훅은 느려지지 않는다', async () => {
  const slow = await fakeRuntime({ delay: 2000 });
  const denied = await fakeRuntime({ status: 401 });
  const a = await fixture({ runtime: slow }); const b = await fixture({ runtime: denied }); const c = await fixture({ runtime: slow, token: false });
  try {
    for (const f of [a, b, c]) assert.equal((await startRuntime(f)).status, 0);
    for (const f of [a, b, c]) await rm(f.inbox, { recursive: true, force: true });
    const ra = await hook(a, 'subagent-start', subagentStart('a1'));
    const rb = await hook(b, 'subagent-start', subagentStart('a1'));
    const rc = await hook(c, 'subagent-start', subagentStart('a1'));
    for (const r of [ra, rb, rc]) { assert.equal(r.status, 0); assert.equal(r.stdout, ''); }
    assert.ok(ra.ms < 900, `느린 런타임에서도 300ms 상한 근처: ${ra.ms}`);
    for (const f of [a, b, c]) assert.equal((await inboxFiles(f)).length, 1);
    assert.equal(slow.requests.filter((r) => r.method === 'POST').length >= 1, true);
    assert.equal(c.base !== undefined && slow.requests.some((r) => r.headers.authorization === 'Bearer undefined'), false);
  } finally { await slow.close(); await denied.close(); for (const f of [a, b, c]) await f.cleanup(); }
});

test('금지 문자열이 든 agent_type은 빼고, 든 agent_id는 보내지 않는다', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    assert.equal((await startRuntime(f)).status, 0);
    await hook(f, 'subagent-start', subagentStart('a1', 'task-runner'));
    await hook(f, 'subagent-start', subagentStart('sk-abc', 'x'));
    const sent = events(rt).filter((e) => e.kind === 'SUBAGENT_STARTED');
    assert.equal(sent.length, 1);
    assert.equal('agentType' in sent[0], false);
    assert.deepEqual(await inboxFiles(f), []);
  } finally { await rt.close(); await f.cleanup(); }
});

test('훅 한 건 처리 시간(런타임 정상 응답)을 잰다', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    assert.equal((await startRuntime(f)).status, 0);
    await hook(f, 'subagent-start', subagentStart('warm'));
    const times = [];
    for (let i = 0; i < 5; i++) times.push((await hook(f, 'subagent-start', subagentStop(`a${i}`))).ms);
    times.sort((x, y) => x - y);
    console.log(`# 훅 1건 처리 시간 ms(프로세스 시작 포함): min ${times[0].toFixed(0)} median ${times[2].toFixed(0)} max ${times[4].toFixed(0)}`);
    assert.ok(times[2] < 300, `중앙값 ${times[2]}ms`);
  } finally { await rt.close(); await f.cleanup(); }
});

test('readiness: 런타임 없음·토큰 없음·준비됨·오류', async () => {
  const rt = await fakeRuntime();
  const none = await fixture({ runtime: null }); const noToken = await fixture({ runtime: rt, token: false }); const ok = await fixture({ runtime: rt });
  const bad = await fakeRuntime({ status: 500 }); const err = await fixture({ runtime: bad });
  try {
    const parse = (r) => JSON.parse(r.stdout);
    const r1 = await run(none, ['readiness', '--space', SPACE], { claudeData: false });
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual([parse(r1).runtime, parse(r1).ready], [false, false]);
    assert.equal(parse(r1).reason, 'RUNTIME_NOT_RUNNING');
    const r2 = await run(noToken, ['readiness', '--space', SPACE], { claudeData: false });
    assert.deepEqual([parse(r2).runtime, parse(r2).ready, parse(r2).reason], [false, false, 'RUNTIME_TOKEN_MISSING']);
    const r3 = await run(ok, ['readiness', '--space', SPACE], { claudeData: false });
    assert.deepEqual(parse(r3), { ready: true, connection: 'CONNECTED', instanceId: 'i1', deviceId: 'd1', reason: '', runtime: true });
    const get = rt.requests.find((r) => r.method === 'GET');
    assert.equal(get.url, `/v1/readiness?spaceId=${SPACE}`);
    assert.equal(get.headers.authorization, `Bearer ${TOKEN}`);
    const r4 = await run(err, ['readiness', '--space', SPACE], { claudeData: false });
    assert.deepEqual([parse(r4).runtime, parse(r4).ready], [true, false]);
    assert.equal((await run(ok, ['readiness'], { claudeData: false })).status, 2);
    assert.equal((await run(ok, ['readiness', '--space', 'bad!'], { claudeData: false })).status, 2);
  } finally { await rt.close(); await bad.close(); for (const f of [none, noToken, ok, err]) await f.cleanup(); }
});

test('stage start·finish는 런타임으로 가고 없으면 inbox. 잘못된 입력은 exit 2, 대기열 모드는 exit 3', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    const q = await cli(f, 'stage', 'start', '--stage', STAGE, '--role', 'onidot-crew:worker', '--summary', 'x');
    assert.equal(q.status, 3); // 활성 표시 없음
    assert.equal((await startRuntime(f)).status, 0);
    const s = await cli(f, 'stage', 'start', '--stage', STAGE, '--role', 'onidot-crew:worker', '--summary', '로그인 구현 시작');
    assert.equal(s.status, 0, s.stderr);
    const e = await cli(f, 'stage', 'finish', '--stage', STAGE, '--result', 'DONE', '--summary', '시험 12건 통과');
    assert.equal(e.status, 0, e.stderr);
    const sent = events(rt).filter((x) => x.kind.startsWith('STAGE_'));
    assert.deepEqual(sent.map((x) => x.kind), ['STAGE_STARTED', 'STAGE_FINISHED']);
    assert.equal(sent[0].stageId, STAGE);
    assert.deepEqual(sent[0].data, { role: 'onidot-crew:worker', summary: '로그인 구현 시작', runId: 1 });
    assert.deepEqual(sent[1].data, { result: 'DONE', summary: '시험 12건 통과', runId: 1 });
    assert.equal(sent[0].hostSession, SID);
    // 같은 명령을 다시 부르면 같은 eventId
    await cli(f, 'stage', 'finish', '--stage', STAGE, '--result', 'DONE', '--summary', '시험 12건 통과');
    const fin = events(rt).filter((x) => x.kind === 'STAGE_FINISHED');
    assert.equal(fin[0].eventId, fin[1].eventId);
    assert.equal((await cli(f, 'stage', 'finish', '--stage', STAGE, '--result', 'OK', '--summary', 'x')).status, 2);
    assert.equal((await cli(f, 'stage', 'start', '--stage', 'nope', '--role', 'r', '--summary', 'x')).status, 2);
    assert.equal((await cli(f, 'stage', 'finish', '--stage', STAGE, '--result', 'DONE', '--summary', 'Bearer abc')).status, 2);
    assert.equal((await cli(f, 'stage', 'finish', '--stage', STAGE, '--result', 'DONE', '--summary', 'ghp_token')).status, 2);
    assert.equal((await cli(f, 'stage', 'start', '--stage', STAGE, '--role', 'task-runner', '--summary', 'x')).status, 2);
    assert.equal((await cli(f, 'stage', 'restart', '--stage', STAGE)).status, 2);
    // 런타임이 사라지면 inbox
    await rm(join(f.oniRuntime, 'oni-runtime.json'));
    const off = await cli(f, 'stage', 'finish', '--stage', STAGE, '--result', 'FAILED', '--summary', '실패');
    assert.equal(off.status, 0);
    assert.deepEqual((await inboxEvents(f)).map((x) => [x.kind, x.data.result]), [['STAGE_FINISHED', 'FAILED']]);
    // 대기열 모드에서는 거부
    await cli(f, 'stop');
    assert.equal((await cli(f, 'start', '--work', WORK, '--session', LEDGER)).status, 0);
    assert.equal((await cli(f, 'stage', 'start', '--stage', STAGE, '--role', 'r', '--summary', 'x')).status, 3);
  } finally { await rt.close(); await f.cleanup(); }
});

test('stop은 런타임 모드면 FLOW_UNBOUND를 보낸다', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    assert.equal((await startRuntime(f)).status, 0);
    const r = await cli(f, 'stop');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(events(rt).at(-1).kind, 'FLOW_UNBOUND');
    assert.deepEqual(await flowFiles(f), []);
  } finally { await rt.close(); await f.cleanup(); }
});

test('work-record 스킬이 런타임 모드와 대기열 모드를 구분해 안내한다', async () => {
  const skill = await readFile(join(root, 'source/crew/skills/work-record/SKILL.md'), 'utf8');
  for (const needle of ['## 3-1. 런타임 모드', '<flow> readiness --space', 'HOOK_ONLY', '`deviceId`', 'MCP_ONLY', '--mode runtime',
    '<flow> stage start --stage', '<flow> stage finish --stage', '대기열 모드', '같은 `collectionScope`·`deviceId`', '`ACTIVITY`']) assert.ok(skill.includes(needle), needle);
  const generated = await readFile(join(root, 'plugins/onidot-crew/skills/work-record/SKILL.md'), 'utf8');
  assert.equal(generated, skill.replaceAll('{{version}}', '0.6.0'));
});

test('같은 단계의 재실행은 새 runId·eventId를 받고, 명령 재시도는 같은 값을 받는다', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    assert.equal((await startRuntime(f)).status, 0);
    const start = () => cli(f, 'stage', 'start', '--stage', STAGE, '--role', 'onidot-crew:worker', '--summary', '구현');
    const finish = (r = 'DONE') => cli(f, 'stage', 'finish', '--stage', STAGE, '--result', r, '--summary', '끝');
    for (const step of [start, start, () => finish(), () => finish(), start, start, () => finish('FAILED')]) assert.equal((await step()).status, 0);
    const sent = events(rt).filter((x) => x.kind.startsWith('STAGE_'));
    assert.deepEqual(sent.map((x) => [x.kind, x.data.runId]), [['STAGE_STARTED', 1], ['STAGE_STARTED', 1], ['STAGE_FINISHED', 1], ['STAGE_FINISHED', 1],
      ['STAGE_STARTED', 2], ['STAGE_STARTED', 2], ['STAGE_FINISHED', 2]]);
    assert.equal(sent[0].eventId, sent[1].eventId); // 시작 재시도
    assert.equal(sent[2].eventId, sent[3].eventId); // 끝 재시도
    assert.equal(new Set(sent.map((x) => x.eventId)).size, 4); // 1회차 시작·끝, 2회차 시작·끝은 모두 다르다
    assert.notEqual(sent[0].eventId, sent[4].eventId);
    assert.notEqual(sent[2].eventId, sent[6].eventId);
    // 다른 단계는 독립된 카운터
    await cli(f, 'stage', 'start', '--stage', '0rwm2stage0bb', '--role', 'r', '--summary', 'x');
    assert.equal(events(rt).at(-1).data.runId, 1);
    // finish만 오면(시작 기록 없음) 1회차로 본다
    await cli(f, 'stage', 'finish', '--stage', '0rwm2stage0cc', '--result', 'DONE', '--summary', 'x');
    assert.equal(events(rt).at(-1).data.runId, 1);
  } finally { await rt.close(); await f.cleanup(); }
});

// Go onipaths.ResolvePaths와 같은 결과를 내는지 표로 고정한다(빈 문자열은 없는 것으로 본다).
test('경로 표: Go ResolvePaths와 모든 조합에서 같은 경로가 나온다', () => {
  const H = '/home/u';
  const table = [
    ['linux', {}, { config: '/home/u/.config/onidot', data: '/home/u/.local/share/onidot', state: '/home/u/.local/state/onidot', runtime: '/home/u/.local/state/onidot/runtime' }],
    ['linux', { ONI_STATE_DIR: '/o/s' }, { config: '/home/u/.config/onidot', data: '/home/u/.local/share/onidot', state: '/o/s', runtime: '/o/s/runtime' }],
    ['linux', { XDG_STATE_HOME: '/x/s' }, { config: '/home/u/.config/onidot', data: '/home/u/.local/share/onidot', state: '/x/s/onidot', runtime: '/x/s/onidot/runtime' }],
    ['linux', { XDG_RUNTIME_DIR: '/run/u' }, { config: '/home/u/.config/onidot', data: '/home/u/.local/share/onidot', state: '/home/u/.local/state/onidot', runtime: '/run/u/onidot' }],
    ['linux', { XDG_RUNTIME_DIR: '/run/u', ONI_STATE_DIR: '/o/s' }, { config: '/home/u/.config/onidot', data: '/home/u/.local/share/onidot', state: '/o/s', runtime: '/run/u/onidot' }],
    ['linux', { XDG_RUNTIME_DIR: '/run/u', ONI_RUNTIME_DIR: '/o/r' }, { config: '/home/u/.config/onidot', data: '/home/u/.local/share/onidot', state: '/home/u/.local/state/onidot', runtime: '/o/r' }],
    ['linux', { ONI_STATE_DIR: '/o/s', ONI_RUNTIME_DIR: '/o/r' }, { config: '/home/u/.config/onidot', data: '/home/u/.local/share/onidot', state: '/o/s', runtime: '/o/r' }],
    ['linux', { XDG_STATE_HOME: '/x/s', ONI_STATE_DIR: '/o/s', XDG_CONFIG_HOME: '/x/c', ONI_DATA_DIR: '/o/d', XDG_DATA_HOME: '/x/d' }, { config: '/x/c/onidot', data: '/o/d', state: '/o/s', runtime: '/o/s/runtime' }],
    ['linux', { XDG_RUNTIME_DIR: '', ONI_STATE_DIR: '', XDG_STATE_HOME: '' }, { config: '/home/u/.config/onidot', data: '/home/u/.local/share/onidot', state: '/home/u/.local/state/onidot', runtime: '/home/u/.local/state/onidot/runtime' }],
    ['linux', { ONI_STATE_DIR: '/o//s/../s/' }, { config: '/home/u/.config/onidot', data: '/home/u/.local/share/onidot', state: '/o/s', runtime: '/o/s/runtime' }],
    ['darwin', {}, { config: '/home/u/Library/Application Support/onidot/config', data: '/home/u/Library/Application Support/onidot/data', state: '/home/u/Library/Application Support/onidot/state', runtime: '/home/u/Library/Application Support/onidot/runtime' }],
    ['darwin', { XDG_RUNTIME_DIR: '/run/u', XDG_STATE_HOME: '/x/s' }, { config: '/home/u/Library/Application Support/onidot/config', data: '/home/u/Library/Application Support/onidot/data', state: '/home/u/Library/Application Support/onidot/state', runtime: '/home/u/Library/Application Support/onidot/runtime' }],
    ['darwin', { ONI_STATE_DIR: '/o/s' }, { config: '/home/u/Library/Application Support/onidot/config', data: '/home/u/Library/Application Support/onidot/data', state: '/o/s', runtime: '/home/u/Library/Application Support/onidot/runtime' }],
    ['darwin', { ONI_CONFIG_DIR: '/o/c', ONI_RUNTIME_DIR: '/o/r', ONI_DATA_DIR: '/o/d' }, { config: '/o/c', data: '/o/d', state: '/home/u/Library/Application Support/onidot/state', runtime: '/o/r' }],
  ];
  for (const [os, env, want] of table) assert.deepEqual(oniDirs(env, H, os), want, `${os} ${JSON.stringify(env)}`);
  // Go는 상대경로·루트 덮어쓰기를 오류로 거부한다. 같은 입력이면 경로를 만들지 않는다(던진다).
  for (const env of [{ ONI_STATE_DIR: 'rel' }, { ONI_DATA_DIR: '/' }, { XDG_STATE_HOME: 'rel' }]) assert.throws(() => oniDirs(env, H, 'linux'), /절대경로/, JSON.stringify(env));
});

test('남은 실행 정보 파일: pid가 죽었거나 다른 사용자 것이면 토큰을 보내지 않고 inbox로 간다', async () => {
  const rt = await fakeRuntime(); const f = await fixture({ runtime: rt });
  try {
    assert.equal((await startRuntime(f)).status, 0);
    const before = rt.requests.length;
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const info = (pid) => writeFile(join(f.oniRuntime, 'oni-runtime.json'), JSON.stringify({ port: rt.port, pid, startedAt: new Date().toISOString(), version: '0' }));
    // 죽은 pid(ESRCH), 다른 사용자 소유 pid(1번은 EPERM; root로 돌면 건너뜀), pid 없음·잘못된 값
    const cases = [Number(dead.stdout), ...(process.getuid?.() === 0 ? [] : [1]), undefined, 0, -3, '12'];
    for (const pid of cases) {
      await info(pid);
      assert.equal((await hook(f, 'subagent-stop', subagentStop('a1'))).status, 0);
      const r = await run(f, ['readiness', '--space', SPACE], { claudeData: false });
      assert.deepEqual([JSON.parse(r.stdout).runtime, JSON.parse(r.stdout).reason], [false, 'RUNTIME_NOT_RUNNING'], String(pid));
    }
    assert.equal(rt.requests.length, before, '토큰이 포트 점유자에게 가면 안 된다');
    assert.equal((await inboxFiles(f)).length, cases.length);
    await info(process.pid); // 살아 있는 내 pid는 보낸다
    await hook(f, 'subagent-stop', subagentStop('a2'));
    assert.equal(rt.requests.length, before + 1);
  } finally { await rt.close(); await f.cleanup(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, stat, utimes } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'source/crew/runtime/flow-queue.mjs');
const { serverText, validAgentId, validRole, isTsid, newId, eventIdOf } = await import(script);
const SID = '8cbb5482-3793-4c9d-bde6-2a408981e067';
const WORK = '0rwm0wcpqz6mg';
const LEDGER = '0rwm1abcdefgh';
const STAGE = '0rwm2stage0aa';

const fixture = async () => {
  const data = await mkdtemp(join(tmpdir(), 'onidot-crew-flow-'));
  return { data, cleanup: () => rm(data, { recursive: true, force: true }) };
};
// 훅은 Claude Code처럼 표준 입력 JSON과 CLAUDE_PLUGIN_DATA 환경 변수로 부른다.
const hook = (data, event, input, env = {}) => spawnSync(process.execPath, [script, 'hook', event], {
  input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8',
  env: { PATH: process.env.PATH, ...(data ? { CLAUDE_PLUGIN_DATA: data } : {}), ...env } });
const hookAsync = (data, event, input) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, 'hook', event], { env: { PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: data } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', (status) => resolve({ status, stdout: out }));
  child.stdin.end(JSON.stringify(input));
});
// 메인이 Bash로 부르는 명령. Claude 세션은 CLAUDE_CODE_SESSION_ID에서 읽는다.
const cli = (data, ...args) => spawnSync(process.execPath, [script, ...args, '--data', data], {
  encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: SID } });
const cliAsync = (data, args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args, '--data', data], { env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: SID, ...env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', (status) => resolve({ status, stdout: out }));
});
const start = (data) => {
  const r = cli(data, 'start', '--work', WORK, '--session', LEDGER);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const subagentStart = (id, type = 'onidot-crew:worker') => ({ session_id: SID, hook_event_name: 'SubagentStart', agent_id: id, agent_type: type,
  transcript_path: '/tmp/t.jsonl', cwd: '/tmp', prompt_id: 'p1' });
const subagentStop = (id, type = 'onidot-crew:worker') => ({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: id, agent_type: type,
  stop_hook_active: false, agent_transcript_path: '/tmp/a.jsonl', last_assistant_message: '비밀 결과 본문 sk-should-not-leak' });
const postAgent = (id, description = '단계 구현', extra = {}) => ({ session_id: SID, hook_event_name: 'PostToolUse', agent_type: 'onidot-crew:lead',
  tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { description, prompt: '프롬프트 본문 비공개', subagent_type: 'onidot-crew:worker' },
  tool_response: { status: 'completed', agentId: id, content: [{ type: 'text', text: '결과 본문' }] }, ...extra });
const files = async (data) => readdir(join(data, 'flow')).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
const pending = (data, nextSeq) => {
  const r = cli(data, 'pending', '--next-seq', String(nextSeq));
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('활성 표시가 없으면 훅은 아무것도 쓰지 않고 알리지도 않는다', async () => {
  const f = await fixture();
  try {
    for (const [event, input] of [['subagent-start', subagentStart('a1')], ['subagent-stop', subagentStop('a1')], ['post-agent', postAgent('a1')]]) {
      const r = hook(f.data, event, input);
      assert.equal(r.status, 0, event);
      assert.equal(r.stdout, '', event);
      assert.equal(r.stderr, '', event);
    }
    assert.equal(await files(f.data), null);
  } finally { await f.cleanup(); }
});

test('잘못된 입력에도 훅은 종료 코드 0으로 조용히 끝난다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    const cases = [
      [f.data, 'subagent-start', '{not json'],
      [f.data, 'subagent-start', ''],
      [f.data, 'subagent-start', '[1,2]'],
      [f.data, 'subagent-start', { ...subagentStart('a1'), session_id: '../escape' }],
      [f.data, 'subagent-start', { ...subagentStart('a1'), session_id: 7 }],
      [f.data, 'subagent-start', { ...subagentStart('a/1') }],
      [f.data, 'subagent-start', { ...subagentStart('a1'), agent_type: '' }],
      [f.data, 'post-agent', { ...postAgent('a1'), tool_response: 'text' }],
      [f.data, 'unknown-event', subagentStart('a1')],
      [undefined, 'subagent-start', subagentStart('a1')],
      ['relative/dir', 'subagent-start', subagentStart('a1')],
    ];
    for (const [data, event, input] of cases) {
      const r = hook(data, event, input);
      assert.equal(r.status, 0, JSON.stringify(input));
      assert.equal(r.stdout, '', JSON.stringify(input));
      assert.equal(r.stderr, '', JSON.stringify(input));
    }
    assert.equal(pending(f.data, 0).count, 0);
    // 탈출 목적지(<data>/escape.*)에 활성 표시를 심어 두어도 그 자리에 대기열·잠금이 생기지 않는다.
    await writeFile(join(f.data, 'escape.active.json'), JSON.stringify({ workId: WORK, sessionId: LEDGER }));
    for (const event of ['subagent-start', 'post-agent']) assert.equal(hook(f.data, event, { ...subagentStart('e1'), ...(event === 'post-agent' ? postAgent('e1') : {}), session_id: '../escape' }).status, 0);
    assert.deepEqual((await readdir(f.data)).sort(), ['escape.active.json', 'flow']);
    // 데이터 디렉터리 자리에 파일이 있어도 막지 않는다.
    const blocked = join(f.data, 'blocked');
    await writeFile(blocked, 'x');
    const r = hook(blocked, 'subagent-start', subagentStart('a2'));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    // 인자 없이 부른 훅과 시작 전 훅(서브에이전트 시작을 못 본 끝)도 조용하다.
    assert.equal(spawnSync(process.execPath, [script, 'hook'], { input: '{}', encoding: 'utf8' }).status, 0);
    assert.equal(hook(f.data, 'subagent-stop', subagentStop('never-started')).status, 0);
    assert.equal(pending(f.data, 0).count, 0);
  } finally { await f.cleanup(); }
});

test('훅이 시작·끝을 쓰고 메인에 알리며, pending은 고정된 이벤트를 내고 ack로 지운다', async () => {
  const f = await fixture();
  try {
    const started = start(f.data);
    assert.equal(started.claudeSession, SID);
    assert.equal(hook(f.data, 'subagent-start', subagentStart('a1')).stdout, '');
    // 메인의 Agent 호출이 끝나면 알림이 나온다. description의 단계 표식은 단계 ID로 기록된다.
    const notice = hook(f.data, 'post-agent', postAgent('a1', `로그인 구현 [stage:${STAGE}]`));
    assert.equal(notice.status, 0);
    const output = JSON.parse(notice.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /기록할 흐름 이벤트 1건/);
    assert.ok(context.includes('onidot-crew:work-record'));
    assert.ok(context.includes(`'${script}' pending --data '${f.data}' --claude-session '${SID}' --next-seq`), context);
    assert.ok(context.includes(`'${script}' ack --data '${f.data}' --claude-session '${SID}'`), context);
    // SubagentStop은 한 서브에이전트에 여러 번 올 수 있다. 보내기 전이면 마지막 하나로 모은다.
    hook(f.data, 'subagent-stop', subagentStop('a1'));
    await new Promise((r) => setTimeout(r, 15));
    hook(f.data, 'subagent-stop', subagentStop('a1'));
    const first = pending(f.data, 3);
    assert.equal(first.workId, WORK);
    assert.equal(first.sessionId, LEDGER);
    assert.equal(first.count, 2);
    assert.equal(first.nextSeq, 5);
    assert.deepEqual(first.events.map((e) => [e.type, e.producerSeq]), [['SUBAGENT_STARTED', 3], ['SUBAGENT_FINISHED', 4]]);
    for (const event of first.events) {
      assert.deepEqual(Object.keys(event), ['schemaVersion', 'eventId', 'sessionId', 'producerSeq', 'occurredAt', 'type', 'payload']);
      assert.equal(event.schemaVersion, 1);
      assert.equal(event.sessionId, LEDGER);
      assert.match(event.eventId, /^cc-flow:[0-9a-f]+\.[0-9a-f]{12}$/);
      assert.match(event.occurredAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.deepEqual(event.payload, { workId: WORK, stageId: STAGE, role: 'onidot-crew:worker', agentId: 'a1' });
    }
    assert.ok(first.events[0].occurredAt <= first.events[1].occurredAt);
    assert.deepEqual(first.ids, first.events.map((e) => e.eventId.slice('cc-flow:'.length)));
    assert.match(first.idempotencyKey, /^crew:flow:[0-9a-f]{24}$/);
    // 다시 꺼내도 같은 이벤트·순번·키가 나온다(재전송해도 중복되지 않게).
    const again = pending(f.data, 9);
    assert.deepEqual(again.events, first.events);
    assert.equal(again.idempotencyKey, first.idempotencyKey);
    assert.equal(again.nextSeq, 9);
    // 대기열에는 식별자·역할·시각만 있고 프롬프트·결과 본문은 없다.
    const queue = await readFile(join(f.data, 'flow', `${SID}.queue.jsonl`), 'utf8');
    for (const secret of ['비밀', 'sk-should', '프롬프트', '결과 본문', '/tmp/a.jsonl', '로그인 구현']) assert.equal(queue.includes(secret), false, secret);
    // 보낸 항목을 지운다. 일부만 지우면 남은 것만 나온다.
    const ack = cli(f.data, 'ack', first.ids[0]);
    assert.equal(ack.status, 0, ack.stderr);
    assert.deepEqual(JSON.parse(ack.stdout), { acked: 1, remaining: 1 });
    const rest = pending(f.data, 5);
    assert.deepEqual(rest.events, [first.events[1]]);
    assert.notEqual(rest.idempotencyKey, first.idempotencyKey);
    cli(f.data, 'ack', first.ids[1]);
    assert.equal(pending(f.data, 5).count, 0);
    // 보낼 것이 없으면 알리지 않는다.
    assert.equal(hook(f.data, 'post-agent', postAgent('a1')).stdout, '');
  } finally { await f.cleanup(); }
});

test('대기열 모드: 서브에이전트 끝이 post-agent 알림 전에 대기열에 있다(훅은 동기로 등록된다)', async () => {
  const f = await fixture();
  try {
    start(f.data);
    hook(f.data, 'subagent-start', subagentStart('a1'));
    hook(f.data, 'subagent-stop', subagentStop('a1'));
    const notice = hook(f.data, 'post-agent', postAgent('a1', `구현 [stage:${STAGE}]`));
    assert.match(JSON.parse(notice.stdout).hookSpecificOutput.additionalContext, /이벤트 2건/);
    assert.deepEqual(pending(f.data, 0).events.map((e) => e.type), ['SUBAGENT_STARTED', 'SUBAGENT_FINISHED']);
    // 등록 쪽: 이 순서를 보장하려면 SubagentStart·SubagentStop이 async가 아니어야 한다.
    const hooks = JSON.parse(await readFile(join(root, 'plugins/onidot-crew/claude/hooks.json'), 'utf8')).hooks;
    for (const ev of ['SubagentStart', 'SubagentStop', 'PostToolUse']) assert.equal(hooks[ev][0].hooks[0].async, undefined, ev);
    assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'SessionStart', 'SubagentStart', 'SubagentStop']);
  } finally { await f.cleanup(); }
});

test('서브에이전트 안의 Agent 호출과 단계 표식 없는 호출은 메인에 알리지 않거나 단계를 비운다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    hook(f.data, 'subagent-start', subagentStart('b1', 'onidot-crew:explorer'));
    const inside = hook(f.data, 'post-agent', { ...postAgent('b2'), agent_id: 'b1', agent_type: 'onidot-crew:explorer' });
    assert.equal(inside.status, 0);
    assert.equal(inside.stdout, '');
    // 다른 도구 이름은 무시한다.
    assert.equal(hook(f.data, 'post-agent', { ...postAgent('b1'), tool_name: 'Bash' }).stdout, '');
    const out = pending(f.data, 0);
    assert.equal(out.count, 1);
    assert.deepEqual(out.events[0].payload, { workId: WORK, role: 'onidot-crew:explorer', agentId: 'b1' });
  } finally { await f.cleanup(); }
});

test('병렬 훅 쓰기와 꺼내기·지우기가 겹쳐도 줄이 섞이거나 항목을 잃지 않는다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    hook(f.data, 'subagent-start', subagentStart('seed'));
    // 꺼내기가 대기열을 읽고 다시 쓰기 전에 400ms 머물게 한다. 그 사이에 훅 20개가 쓴다.
    // 잠금이 없으면 이 창에 쓴 줄은 다시 쓰기로 덮여 반드시 사라진다.
    const drain = cliAsync(f.data, ['pending', '--next-seq', '0'], { FLOW_QUEUE_TEST_DELAY_MS: '400' });
    await new Promise((r) => setTimeout(r, 120));
    const total = 20;
    const writers = await Promise.all(Array.from({ length: total }, (_, i) => hookAsync(f.data, 'subagent-start', subagentStart(`p${i}`))));
    const drained = await drain;
    assert.equal(drained.status, 0);
    assert.ok(writers.every((r) => r.status === 0));
    const first = JSON.parse(drained.stdout);
    // 지우기도 같은 창을 둔다.
    const ack = cliAsync(f.data, ['ack', ...first.ids], { FLOW_QUEUE_TEST_DELAY_MS: '400' });
    await new Promise((r) => setTimeout(r, 120));
    const more = await Promise.all(Array.from({ length: 10 }, (_, i) => hookAsync(f.data, 'subagent-start', subagentStart(`q${i}`))));
    assert.equal((await ack).status, 0);
    assert.ok(more.every((r) => r.status === 0));
    const rest = pending(f.data, first.nextSeq);
    const seen = [...first.events, ...rest.events].map((e) => e.payload.agentId);
    assert.equal(seen.length, 1 + total + 10);
    assert.equal(new Set(seen).size, seen.length);
    const lines = (await readFile(join(f.data, 'flow', `${SID}.queue.jsonl`), 'utf8')).split('\n').filter(Boolean);
    for (const line of lines) JSON.parse(line);
  } finally { await f.cleanup(); }
});

test('낡은 잠금은 치우고, 살아 있는 잠금은 3초 기다린 뒤 조용히 포기한다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    const lock = join(f.data, 'flow', `${SID}.lock`);
    await writeFile(lock, 'other.token');
    const past = new Date(Date.now() - 20_000);
    await utimes(lock, past, past);
    assert.equal(hook(f.data, 'subagent-start', subagentStart('s1')).status, 0);
    assert.equal(pending(f.data, 0).count, 1);
    // 막 잡힌 잠금은 기다리다 포기한다. 훅은 0, 명령은 1로 끝나고 남의 잠금을 지우지 않는다.
    await writeFile(lock, 'live.token');
    const began = Date.now();
    const r = hook(f.data, 'subagent-start', subagentStart('s2'));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(Date.now() - began >= 2900);
    const busy = cli(f.data, 'pending', '--next-seq', '0');
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /잠금/);
    assert.equal(await readFile(lock, 'utf8'), 'live.token');
    await rm(lock);
    assert.deepEqual(pending(f.data, 0).events.map((e) => e.payload.agentId), ['s1']);
  } finally { await f.cleanup(); }
});

test('대기열은 상한을 넘겨 커지지 않는다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    const path = join(f.data, 'flow', `${SID}.queue.jsonl`);
    const line = (i) => JSON.stringify({ k: 'event', id: `x${i}`, type: 'SUBAGENT_STARTED', agentId: `x${i}`, workId: WORK, sessionId: LEDGER, occurredAt: new Date().toISOString() });
    await writeFile(path, Array.from({ length: 500 }, (_, i) => line(i)).join('\n') + '\n');
    hook(f.data, 'subagent-start', subagentStart('over'));
    let lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 500);
    // 끝 이벤트도 상한을 넘기지 않는다(시작을 본 서브에이전트라도).
    await writeFile(path, JSON.stringify({ k: 'agent', agentId: 'seen', started: true }) + '\n' + lines.join('\n') + '\n');
    hook(f.data, 'subagent-stop', subagentStop('seen'));
    lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 501);
    // 서버는 한 요청에 이벤트 100개까지 받는다. 꺼내기는 100개씩 내고 남은 수를 알린다.
    const first = pending(f.data, 7);
    assert.equal(first.count, 100);
    assert.equal(first.more, 400);
    assert.equal(first.events[0].producerSeq, 7);
    assert.equal(first.events[99].producerSeq, 106);
    assert.equal(first.nextSeq, 507);
    assert.equal(cli(f.data, 'ack', ...first.ids).status, 0);
    const second = pending(f.data, 507);
    assert.equal(second.events[0].producerSeq, 107);
    assert.equal(second.more, 300);
  } finally { await f.cleanup(); }
});

test('stop은 보내지 않은 항목이 있으면 거부하고, 끄면 훅이 다시 조용해진다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    hook(f.data, 'subagent-start', subagentStart('c1'));
    const refused = cli(f.data, 'stop');
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /1건/);
    const status = JSON.parse(cli(f.data, 'status').stdout);
    assert.deepEqual(status, { active: true, workId: WORK, sessionId: LEDGER, pending: 1 });
    // 다른 작업으로 바꾸는 start도 남은 항목이 있으면 거부한다.
    assert.equal(cli(f.data, 'start', '--work', '0rwm9thxrwrk0', '--session', LEDGER).status, 3);
    assert.equal(cli(f.data, 'stop', '--discard').status, 0);
    assert.deepEqual(await files(f.data), []);
    assert.deepEqual(JSON.parse(cli(f.data, 'status').stdout), { active: false, pending: 0 });
    hook(f.data, 'subagent-start', subagentStart('c2'));
    assert.equal(hook(f.data, 'post-agent', postAgent('c2')).stdout, '');
    assert.deepEqual(await files(f.data), []);
    // 활성이 아니면 pending은 상태 오류다.
    assert.equal(cli(f.data, 'pending', '--next-seq', '0').status, 3);
  } finally { await f.cleanup(); }
});

test('명령 인자는 시작할 때 검증한다', async () => {
  const f = await fixture();
  try {
    const bad = [
      ['start', '--work', WORK],
      ['start', '--work', '../x', '--session', LEDGER],
      // 서버 ids.Decode가 받지 않는 형식: i·l·o·u, 첫 글자 8 이상, 길이, 0.
      ['start', '--work', '0rwm0wcpqz6mo', '--session', LEDGER],
      ['start', '--work', WORK, '--session', '8rwm1abcdefgh'],
      ['start', '--work', '0rwm0wcpqz6m', '--session', LEDGER],
      ['start', '--work', '0000000000000', '--session', LEDGER],
      ['start', '--work', WORK, '--session', LEDGER, '--claude-session', '../x'],
      ['pending'],
      ['pending', '--next-seq', '-1'],
      ['pending', '--next-seq', 'abc'],
      ['ack'],
      ['nope'],
    ];
    for (const args of bad) {
      const r = cli(f.data, ...args);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.ok(r.stderr.length > 0);
    }
    const relative = spawnSync(process.execPath, [script, 'status', '--data', 'relative'], { encoding: 'utf8', env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: SID } });
    assert.equal(relative.status, 2);
    const noSession = spawnSync(process.execPath, [script, 'status', '--data', f.data], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(noSession.status, 2);
    // 다른 세션 파일은 그 세션의 가장 최근 수정이 14일을 넘었을 때만 start가 함께 지운다.
    await mkdir(join(f.data, 'flow'), { recursive: true });
    const past = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    for (const name of ['old-session.queue.jsonl', 'old-session.active.json', 'live-session.active.json', 'live-session.queue.jsonl']) {
      await writeFile(join(f.data, 'flow', name), '');
      if (name !== 'live-session.queue.jsonl') await utimes(join(f.data, 'flow', name), past, past);
    }
    start(f.data);
    assert.deepEqual((await files(f.data)).sort(), [`${SID}.active.json`, 'live-session.active.json', 'live-session.queue.jsonl']);
    // 파일 권한은 사용자만 읽고 쓴다.
    assert.equal((await stat(join(f.data, 'flow', `${SID}.active.json`))).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test('대기열 항목은 서버의 금지 문자열·ID 규칙을 통과하는 값만 보낸다', async () => {
  // 서버 session_events.go sessionOptionalText와 같은 판정.
  for (const bad of ['task-runner', 'risk-reviewer', 'desk-1', 'Bearer x', 'authorization:x', '-----BEGIN x', 'ghp_x', 'github_pat_x', 'my_secret=1', 'password=x', 'api-key=x', ' ', '줄\n바꿈', 'x'.repeat(121)])
    assert.equal(serverText(bad, 120), false, bad);
  for (const good of ['onidot-crew:worker', 'secret', 'password manager', 'general-purpose', 'Explore']) assert.equal(serverText(good, 120), true, good);
  assert.equal(validRole('task-runner'), false);
  assert.equal(validAgentId('agent sk-1'), false);
  assert.equal(validAgentId('a9d0a96ce83bebff1'), true);
  for (const id of ['0rwm2stage0aa', '7zzzzzzzzzzzz']) assert.equal(isTsid(id), true, id);
  for (const id of ['0rwm2stage0ai', '0rwm2stage0al', '0rwm2stage0ao', '0rwm2stage0au', '8000000000000', '0000000000000', '0RWM2STAGE0AA', '0rwm2stage0a']) assert.equal(isTsid(id), false, id);
  // 무작위로 많이 만들어도 eventId는 항상 통과한다. 예전 형식(base36 시각-hex)은 'sk-'를 만들 수 있었다.
  assert.equal(serverText(`cc-flow:${(1791682945796).toString(36)}-0a1b2c`, 200), false);
  for (let i = 0; i < 20000; i++) { const eventId = eventIdOf(newId()); assert.equal(serverText(eventId, 200), true, eventId); }
});

test('서버 규칙에 걸리는 role은 빼고, agentId가 걸리면 그 항목을 적지 않는다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    hook(f.data, 'subagent-start', subagentStart('r1', 'task-runner'));
    hook(f.data, 'subagent-start', subagentStart('desk-1', 'onidot-crew:worker'));
    hook(f.data, 'subagent-stop', subagentStop('desk-1'));
    const out = pending(f.data, 0);
    assert.equal(out.count, 1);
    assert.deepEqual(out.events[0].payload, { workId: WORK, agentId: 'r1' });
    // 잘못된 단계 표식은 단계로 쓰지 않는다.
    hook(f.data, 'subagent-start', subagentStart('r2'));
    hook(f.data, 'post-agent', postAgent('r2', '구현 [stage:0rwm2stage0ao]'));
    assert.equal('stageId' in pending(f.data, 1).events[1].payload, false);
  } finally { await f.cleanup(); }
});

test('백그라운드 호출이 SubagentStart보다 먼저 끝나도 단계 연결을 잃지 않는다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    const launched = postAgent('bg1', `조사 [stage:${STAGE}]`, { tool_response: { isAsync: true, status: 'async_launched', agentId: 'bg1' } });
    assert.equal(hook(f.data, 'post-agent', launched).stdout, '');
    hook(f.data, 'subagent-start', subagentStart('bg1', 'onidot-crew:researcher'));
    hook(f.data, 'subagent-stop', subagentStop('bg1', 'onidot-crew:researcher'));
    const out = pending(f.data, 0);
    assert.deepEqual(out.events.map((e) => [e.type, e.payload.stageId]), [['SUBAGENT_STARTED', STAGE], ['SUBAGENT_FINISHED', STAGE]]);
    // 단계 연결만 있고 시작을 못 본 서브에이전트의 끝은 적지 않는다.
    hook(f.data, 'post-agent', postAgent('bg2', `조사 [stage:${STAGE}]`));
    hook(f.data, 'subagent-stop', subagentStop('bg2'));
    assert.equal(pending(f.data, 2).count, 2);
    // 옛 이름 Task도 받는다.
    hook(f.data, 'subagent-start', subagentStart('t1'));
    const task = hook(f.data, 'post-agent', { ...postAgent('t1', `x [stage:${STAGE}]`), tool_name: 'Task' });
    assert.match(task.stdout, /흐름 이벤트 3건/);
    // 끝 이벤트를 보내 지우면 그 서브에이전트 기록도 정리된다.
    cli(f.data, 'ack', ...pending(f.data, 2).ids);
    const queue = await readFile(join(f.data, 'flow', `${SID}.queue.jsonl`), 'utf8');
    assert.equal(queue.includes('"bg1"'), false);
  } finally { await f.cleanup(); }
});

test('훅은 항목마다 작업·세션을 적고, 켠 작업의 항목만 꺼낸다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    hook(f.data, 'subagent-start', subagentStart('w1'));
    const path = join(f.data, 'flow', `${SID}.queue.jsonl`);
    const line = JSON.parse((await readFile(path, 'utf8')).split('\n').filter(Boolean).at(-1));
    assert.equal(line.workId, WORK);
    assert.equal(line.sessionId, LEDGER);
    await writeFile(path, (await readFile(path, 'utf8')) + JSON.stringify({ ...line, id: 'f.1', agentId: 'w9', workId: '0rwm9thxrwrk0' }) + '\n');
    assert.deepEqual(pending(f.data, 0).events.map((e) => e.payload.agentId), ['w1']);
  } finally { await f.cleanup(); }
});

test('unstage는 빠진 단계의 ID만 떼고, 내용이 바뀌면 멱등 키도 바뀐다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    hook(f.data, 'subagent-start', subagentStart('u1'));
    hook(f.data, 'post-agent', postAgent('u1', `x [stage:${STAGE}]`));
    const before = pending(f.data, 0);
    assert.equal(before.events[0].payload.stageId, STAGE);
    assert.equal(cli(f.data, 'unstage').status, 2);
    const r = cli(f.data, 'unstage', '--stage', STAGE);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { unstaged: 1 });
    const after = pending(f.data, 0);
    assert.equal('stageId' in after.events[0].payload, false);
    assert.equal(after.events[0].eventId, before.events[0].eventId);
    assert.equal(after.events[0].producerSeq, before.events[0].producerSeq);
    assert.notEqual(after.idempotencyKey, before.idempotencyKey);
    // 이후 끝 이벤트에도 지운 단계가 다시 붙지 않는다.
    hook(f.data, 'subagent-stop', subagentStop('u1'));
    assert.equal('stageId' in pending(f.data, 1).events[1].payload, false);
  } finally { await f.cleanup(); }
});

test('SessionStart 훅은 절대경로가 든 명령 접두사를 메인에만 알린다', async () => {
  const f = await fixture();
  try {
    const r = hook(f.data, 'session-start', { session_id: SID, hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(r.status, 0);
    const output = JSON.parse(r.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    const context = output.hookSpecificOutput.additionalContext;
    assert.ok(context.includes(`node '${script}' <명령> --data '${f.data}' --claude-session '${SID}'`), context);
    assert.ok(Buffer.byteLength(r.stdout) <= 1000, `${Buffer.byteLength(r.stdout)} bytes`);
    // 알리기만 하고 디스크는 건드리지 않는다.
    assert.equal(await files(f.data), null);
    // 서브에이전트, 잘못된 세션 ID, 상대 경로 데이터, 데이터 없음에는 아무것도 내지 않는다.
    assert.equal(hook(f.data, 'session-start', { session_id: SID, agent_id: 'a1', agent_type: 'onidot-crew:worker' }).stdout, '');
    assert.equal(hook(f.data, 'session-start', { session_id: '../x' }).stdout, '');
    assert.equal(hook('relative/dir', 'session-start', { session_id: SID }).stdout, '');
    assert.equal(hook(null, 'session-start', { session_id: SID }).stdout, '');
    assert.equal(hook(f.data, 'session-start', 'not json').status, 0);
    // 알린 접두사를 셸(sh -c)로 그대로 실행해도 status가 돈다. 경로에 공백이 있어도 따옴표로 안전하다.
    const prefix = context.match(/node '[^\n]*?' <명령> --data '[^\n]*?' --claude-session '[^']*'/)?.[0];
    assert.ok(prefix, context);
    const shell = spawnSync('sh', ['-c', prefix.replace('<명령>', 'status')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(shell.status, 0, shell.stderr);
  } finally { await f.cleanup(); }
});

test('session-start는 깨진 활성 파일이 있어도 디스크를 읽지 않고 알린다', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.data, 'flow'), { recursive: true });
    await writeFile(join(f.data, 'flow', `${SID}.active.json`), '{깨진');
    const r = hook(f.data, 'session-start', { session_id: SID, hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('<명령>'));
  } finally { await f.cleanup(); }
});

test('start의 활성 표시는 임시 파일을 거쳐 쓰고 남기지 않는다', async () => {
  const f = await fixture();
  try {
    const r = cli(f.data, 'start', '--work', WORK, '--session', LEDGER);
    assert.equal(r.status, 0, r.stderr);
    const names = await files(f.data);
    assert.ok(names.includes(`${SID}.active.json`));
    assert.equal(names.some((n) => n.endsWith('.tmp')), false, names.join(','));
    assert.deepEqual(JSON.parse(await readFile(join(f.data, 'flow', `${SID}.active.json`), 'utf8')).workId, WORK);
  } finally { await f.cleanup(); }
});

// ---- 단계 ID 발급(ids) ----
const decodeTsid = (s) => [...s].reduce((u, c) => (u << 5n) | BigInt('0123456789abcdefghjkmnpqrstvwxyz'.indexOf(c)), 0n);
test('ids는 서버 형식의 겹치지 않는 단계 ID를 세션·데이터 경로 없이 발급한다', () => {
  const r = spawnSync(process.execPath, [script, 'ids', '--count', '50'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  const { ids } = JSON.parse(r.stdout);
  assert.equal(ids.length, 50);
  assert.equal(new Set(ids).size, 50);
  for (const id of ids) {
    assert.ok(isTsid(id), id);
    // 서버(2020-01-01 기준 밀리초 << 22)와 같은 시각 부분이어야 한다.
    const ms = Number(decodeTsid(id) >> 22n) + 1577836800000;
    assert.ok(Math.abs(ms - Date.now()) < 60_000, `${id} → ${new Date(ms).toISOString()}`);
  }
});
test('ids의 시각 부분은 서버가 만든 실제 ID와 같은 방식으로 읽힌다', async () => {
  const { encodeTsid, newTsids } = await import(script);
  // 운영 작업 0rwm0wcpqz6mg는 2026-10-11에 서버가 만든 ID다.
  const ms = Number(decodeTsid('0rwm0wcpqz6mg') >> 22n) + 1577836800000;
  assert.equal(new Date(ms).toISOString().slice(0, 10), '2026-10-11');
  assert.equal(encodeTsid(decodeTsid('0rwm0wcpqz6mg')), '0rwm0wcpqz6mg');
  const [a] = newTsids(1, ms);
  assert.equal(Number(decodeTsid(a) >> 22n) + 1577836800000, ms);
});
test('ids는 잘못된 개수를 거부한다', () => {
  for (const bad of ['0', '201', 'abc', '-1']) {
    const r = spawnSync(process.execPath, [script, 'ids', `--count=${bad}`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 2, `${bad}: ${r.stderr}`);
  }
});
test('newTsids는 난수 부분이 넘치면 다음 밀리초로 올리고 겹치지 않는다', async () => {
  const { newTsids } = await import(script);
  const now = Date.UTC(2026, 9, 11);
  const ids = newTsids(4, now, 0x3ffffe);
  assert.equal(new Set(ids).size, 4);
  assert.deepEqual([...ids].sort(), ids, '단조 증가');
  const parts = ids.map((id) => [Number(decodeTsid(id) >> 22n), Number(decodeTsid(id) & 0x3fffffn)]);
  const ms = now - 1577836800000;
  assert.deepEqual(parts, [[ms, 0x3ffffe], [ms, 0x3fffff], [ms + 1, 0], [ms + 1, 1]]);
});
// Codex처럼 플러그인 경로를 모르는 호스트가 쓰는 work-record의 한 줄 발급 명령도 서버 형식이어야 한다.
test('work-record 스킬의 한 줄 단계 ID 발급 명령은 서버 형식의 겹치지 않는 ID를 낸다', async () => {
  const skill = await readFile(join(root, 'source/crew/skills/work-record/SKILL.md'), 'utf8');
  const line = skill.split('\n').map((l) => l.trim()).find((l) => l.startsWith("node -e '"));
  assert.ok(line, '한 줄 명령을 찾지 못했다');
  const r = spawnSync('/bin/sh', ['-c', line.replace(/ 5$/, ' 30')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  const ids = r.stdout.trim().split(' ');
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, 30);
  for (const id of ids) {
    assert.ok(isTsid(id), id);
    const ms = Number(decodeTsid(id) >> 22n) + 1577836800000;
    assert.ok(Math.abs(ms - Date.now()) < 60_000, id);
  }
});

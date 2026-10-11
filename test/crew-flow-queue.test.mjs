import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'source/crew/runtime/flow-queue.mjs');
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
const cliAsync = (data, ...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args, '--data', data], { env: { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: SID } });
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
    assert.ok(context.includes(`'${script}' pending --data '${f.data}' --next-seq`), context);
    assert.ok(context.includes(`'${script}' ack --data '${f.data}'`), context);
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
      assert.match(event.eventId, /^cc-flow:[a-z0-9-]+$/);
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
    const total = 40;
    const writers = Array.from({ length: total }, (_, i) => hookAsync(f.data, 'subagent-start', subagentStart(`p${i}`)));
    const acked = new Set();
    let nextSeq = 0;
    const drainer = (async () => {
      for (let round = 0; round < 8; round++) {
        const r = await cliAsync(f.data, 'pending', '--next-seq', String(nextSeq));
        assert.equal(r.status, 0);
        const out = JSON.parse(r.stdout);
        nextSeq = out.nextSeq;
        if (out.ids.length) {
          const a = await cliAsync(f.data, 'ack', ...out.ids);
          assert.equal(a.status, 0);
          for (const event of out.events) acked.add(event.payload.agentId);
        }
      }
    })();
    const results = await Promise.all(writers);
    await drainer;
    assert.ok(results.every((r) => r.status === 0));
    const rest = pending(f.data, nextSeq);
    const seen = [...acked, ...rest.events.map((e) => e.payload.agentId)];
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total);
    const seqs = rest.events.map((e) => e.producerSeq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    const lines = (await readFile(join(f.data, 'flow', `${SID}.queue.jsonl`), 'utf8')).split('\n').filter(Boolean);
    for (const line of lines) JSON.parse(line);
  } finally { await f.cleanup(); }
});

test('대기열은 상한을 넘겨 커지지 않는다', async () => {
  const f = await fixture();
  try {
    start(f.data);
    const path = join(f.data, 'flow', `${SID}.queue.jsonl`);
    const line = (i) => JSON.stringify({ k: 'event', id: `x${i}`, type: 'SUBAGENT_STARTED', agentId: `x${i}`, occurredAt: new Date().toISOString() });
    await writeFile(path, Array.from({ length: 500 }, (_, i) => line(i)).join('\n') + '\n');
    hook(f.data, 'subagent-start', subagentStart('over'));
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 500);
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
    assert.equal(cli(f.data, 'start', '--work', '0rwm9otherwrk', '--session', LEDGER).status, 3);
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
    // 오래된 다른 세션 파일은 start가 정리한다.
    await mkdir(join(f.data, 'flow'), { recursive: true });
    const old = join(f.data, 'flow', 'old-session.queue.jsonl');
    await writeFile(old, '');
    const { utimes } = await import('node:fs/promises');
    const past = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    await utimes(old, past, past);
    start(f.data);
    assert.deepEqual((await files(f.data)).sort(), [`${SID}.active.json`]);
  } finally { await f.cleanup(); }
});

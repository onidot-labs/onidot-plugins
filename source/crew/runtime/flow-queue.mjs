#!/usr/bin/env node
// onidot crew 작업 흐름 대기열(Claude Code 전용).
// SubagentStart·SubagentStop 훅이 서브에이전트 시작·끝을 Claude 세션별 대기열에 한 줄씩 적고,
// 메인의 Agent 호출이 끝나면(PostToolUse) 보낼 항목이 있다고 메인에 알린다.
// Studio로 보내는 일은 메인이 work-record 스킬대로 MCP로 한다. 이 스크립트는 네트워크를 쓰지 않는다.
// 대기열에는 식별자·역할·단계 ID·시각만 적는다. 프롬프트·결과 본문·전사 경로는 적지 않는다.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT = fileURLToPath(import.meta.url);
const MAX_EVENTS = 500;
const BATCH = 100;
const LOCK_WAIT_MS = 3000;
const STALE_LOCK_MS = 10_000;
const KEEP_DAYS = 14;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT = /^[A-Za-z0-9_.:-]{1,200}$/;
const ROLE = /^[A-Za-z0-9_.:-]{1,120}$/;
const LEDGER_ID = /^[0-9a-z]{1,32}$/;
const STAGE_TAG = /\[stage:([0-9a-z]{13})\]/;

class UsageError extends Error {}
class StateError extends Error {}
class LockBusy extends Error {}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const paths = (data, sid) => {
  const dir = join(data, 'flow');
  return { dir, active: join(dir, `${sid}.active.json`), queue: join(dir, `${sid}.queue.jsonl`), lock: join(dir, `${sid}.lock`) };
};
const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
// 활성 표시는 메인이 work-record 스킬로 작업을 맡을 때 start로 켠다. 없으면 훅은 디스크를 건드리지 않는다.
const activeMarker = (p) => {
  const marker = readJson(p.active);
  return marker && typeof marker === 'object' && LEDGER_ID.test(marker.workId) && LEDGER_ID.test(marker.sessionId) ? marker : null;
};

// 세션별 잠금. 쓰기·꺼내기·지우기가 모두 이 잠금 안에서 일어나 줄이 섞이거나 항목을 잃지 않는다.
function withLock(p, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(p.lock, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(p.lock).mtimeMs > STALE_LOCK_MS) { rmSync(p.lock, { force: true }); continue; } } catch {}
      if (Date.now() > deadline) throw new LockBusy('대기열 잠금을 얻지 못했습니다.');
      sleep(15);
    }
  }
  try { return fn(); } finally { rmSync(p.lock, { force: true }); }
}

// 대기열 줄: {k:'agent', agentId, role?, stageId?} 또는 {k:'event', id, type, agentId, role?, occurredAt, seq?, stageId?}.
const readRecords = (p) => {
  let text;
  try { text = readFileSync(p.queue, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line); if (v && typeof v === 'object' && (v.k === 'agent' || v.k === 'event') && AGENT.test(v.agentId)) out.push(v); } catch {}
  }
  return out;
};
const writeRecords = (p, records) => {
  const tmp = `${p.queue}.${process.pid}.tmp`;
  writeFileSync(tmp, records.map((r) => JSON.stringify(r) + '\n').join(''));
  renameSync(tmp, p.queue);
};
const append = (p, ...records) => appendFileSync(p.queue, records.map((r) => JSON.stringify(r) + '\n').join(''));
const events = (records) => records.filter((r) => r.k === 'event');
const newId = () => `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
const shellQuote = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;

// ---- 훅 ----
function hookContext(raw) {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (!data || !isAbsolute(data)) return null;
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.session_id !== 'string' || !SESSION.test(input.session_id)) return null;
  const p = paths(data, input.session_id);
  const marker = activeMarker(p);
  return marker ? { data, input, p, marker } : null;
}
const subagent = (input) => {
  const agentId = input.agent_id, role = input.agent_type;
  // 내부 에이전트(프롬프트 제안 등)는 agent_type이 비어 있다.
  if (typeof agentId !== 'string' || !AGENT.test(agentId) || typeof role !== 'string' || !role) return null;
  return { agentId, ...(ROLE.test(role) ? { role } : {}) };
};

const hooks = {
  'subagent-start'(ctx) {
    const who = subagent(ctx.input);
    if (!who) return;
    withLock(ctx.p, () => {
      if (events(readRecords(ctx.p)).length >= MAX_EVENTS) return;
      append(ctx.p, { k: 'agent', ...who },
        { k: 'event', id: newId(), type: 'SUBAGENT_STARTED', ...who, occurredAt: new Date().toISOString() });
    });
  },
  'subagent-stop'(ctx) {
    const who = subagent(ctx.input);
    if (!who) return;
    withLock(ctx.p, () => {
      const records = readRecords(ctx.p);
      // 시작을 본 서브에이전트만 끝을 적는다. 활성 전에 시작했거나 내부 에이전트면 건너뛴다.
      if (!records.some((r) => r.k === 'agent' && r.agentId === who.agentId)) return;
      if (events(records).length >= MAX_EVENTS) return;
      append(ctx.p, { k: 'event', id: newId(), type: 'SUBAGENT_FINISHED', ...who, occurredAt: new Date().toISOString() });
    });
  },
  'post-agent'(ctx) {
    const { input, p } = ctx;
    if (input.tool_name !== 'Agent') return;
    const response = input.tool_response, description = input.tool_input?.description;
    const agentId = response && typeof response === 'object' ? response.agentId : undefined;
    const tag = typeof description === 'string' ? description.match(STAGE_TAG) : null;
    const count = withLock(p, () => {
      const records = readRecords(p);
      // 단계를 맡긴 호출의 description 끝 표식 [stage:<단계 ID>]만 읽어 그 서브에이전트에 단계를 붙인다.
      if (tag && typeof agentId === 'string' && records.some((r) => r.k === 'agent' && r.agentId === agentId)) append(p, { k: 'agent', agentId, stageId: tag[1] });
      return events(records).length;
    });
    // 서브에이전트 안의 Agent 호출에는 알리지 않는다. 작업 기록 쓰기는 메인만 한다.
    if (typeof input.agent_id === 'string' && input.agent_id || !count) return;
    const command = `node ${shellQuote(SCRIPT)}`;
    const context = [`onidot crew: 기록할 흐름 이벤트 ${count}건이 대기열에 있습니다(작업 ${ctx.marker.workId}). onidot-crew:work-record 스킬의 3절대로 append_work_session_events로 보내고, 성공하면 지우세요.`,
      `꺼내기: ${command} pending --data ${shellQuote(ctx.data)} --next-seq <다음 producerSeq>`,
      `보낸 뒤 지우기: ${command} ack --data ${shellQuote(ctx.data)} <꺼내기 출력의 ids>`].join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
  },
};

function runHook(name) {
  // 훅은 어떤 경우에도 Claude Code 작업을 막지 않는다. 오류는 조용히 버리고 종료 코드 0으로 끝낸다.
  const done = () => process.exit(0);
  const handler = Object.hasOwn(hooks, name ?? '') ? hooks[name] : null;
  if (!handler) { process.stdin.resume(); process.stdin.on('end', done).on('error', done); return; }
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; if (raw.length > 1_000_000) done(); });
  process.stdin.on('error', done);
  process.stdin.on('end', () => {
    try { const ctx = hookContext(raw); if (ctx) handler(ctx); } catch {}
    done();
  });
}

// ---- 메인이 부르는 명령 ----
function commandContext(values) {
  const data = values.data;
  if (!data || !isAbsolute(data)) throw new UsageError('--data에 플러그인 데이터 디렉터리의 절대경로를 주세요(스킬 본문의 ${CLAUDE_PLUGIN_DATA}).');
  const sid = values['claude-session'] ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid || !SESSION.test(sid)) throw new UsageError('Claude 세션 ID를 알 수 없습니다. Claude Code의 Bash에서 실행하거나 --claude-session을 주세요.');
  return { sid, p: paths(data, sid) };
}
const ledgerId = (value, flag) => {
  if (!value || !LEDGER_ID.test(value)) throw new UsageError(`${flag}에 작업 기록 ID(소문자·숫자)를 주세요.`);
  return value;
};
const out = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

const commands = {
  start(values, ctx) {
    const workId = ledgerId(values.work, '--work'), sessionId = ledgerId(values.session, '--session');
    mkdirSync(ctx.p.dir, { recursive: true });
    // 오래된 다른 세션의 표시·대기열은 정리한다.
    const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const name of readdirSync(ctx.p.dir)) {
      if (name.startsWith(`${ctx.sid}.`)) continue;
      const path = join(ctx.p.dir, name);
      try { if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true }); } catch {}
    }
    withLock(ctx.p, () => {
      const marker = activeMarker(ctx.p);
      const left = events(readRecords(ctx.p)).length;
      if (marker && (marker.workId !== workId || marker.sessionId !== sessionId) && left)
        throw new StateError(`다른 작업(${marker.workId})의 보내지 않은 흐름 이벤트 ${left}건이 있습니다. 먼저 보내고 ack하거나 stop --discard로 버리세요.`);
      if (marker && (marker.workId !== workId || marker.sessionId !== sessionId)) rmSync(ctx.p.queue, { force: true });
      writeFileSync(ctx.p.active, JSON.stringify({ workId, sessionId, startedAt: new Date().toISOString() }) + '\n');
    });
    out({ active: true, claudeSession: ctx.sid, workId, sessionId });
  },
  pending(values, ctx) {
    const raw = values['next-seq'];
    if (raw === undefined || !/^\d{1,15}$/.test(raw)) throw new UsageError('--next-seq에 다음 producerSeq(0 이상 정수)를 주세요.');
    const nextSeq = Number(raw);
    const marker = activeMarker(ctx.p);
    if (!marker) throw new StateError('켜진 작업 흐름 기록이 없습니다. start로 켜세요.');
    const result = withLock(ctx.p, () => {
      const all = readRecords(ctx.p);
      let records = all;
      const stages = new Map();
      for (const r of records) if (r.k === 'agent' && typeof r.stageId === 'string' && /^[0-9a-z]{13}$/.test(r.stageId)) stages.set(r.agentId, r.stageId);
      // 아직 순번을 받지 않은 같은 서브에이전트의 끝 이벤트는 마지막 하나만 남긴다.
      const lastFinish = new Map();
      for (const r of events(records)) if (r.type === 'SUBAGENT_FINISHED' && r.seq === undefined) {
        const prev = lastFinish.get(r.agentId);
        if (!prev || r.occurredAt >= prev.occurredAt) lastFinish.set(r.agentId, r);
      }
      records = records.filter((r) => !(r.k === 'event' && r.type === 'SUBAGENT_FINISHED' && r.seq === undefined && lastFinish.get(r.agentId) !== r));
      // 처음 꺼낼 때 순번과 단계를 정해 저장한다. 다시 꺼내도 같은 이벤트가 나와 재전송이 중복되지 않는다.
      let seq = nextSeq;
      for (const r of events(records)) if (Number.isSafeInteger(r.seq)) seq = Math.max(seq, r.seq + 1);
      const fresh = events(records).filter((r) => r.seq === undefined)
        .sort((a, b) => a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1);
      for (const r of fresh) {
        r.seq = seq++;
        const stageId = stages.get(r.agentId);
        if (stageId) r.stageId = stageId;
      }
      if (fresh.length || records.length !== all.length) writeRecords(ctx.p, records);
      return { list: events(records).sort((a, b) => a.seq - b.seq), nextSeq: seq };
    });
    // 서버는 한 요청에 이벤트 100개까지 받는다. 순번이 앞선 것부터 100개씩 낸다.
    const batch = result.list.slice(0, BATCH);
    const list = batch.map((r) => ({ schemaVersion: 1, eventId: `cc-flow:${r.id}`, sessionId: marker.sessionId, producerSeq: r.seq,
      occurredAt: r.occurredAt, type: r.type,
      payload: { workId: marker.workId, ...(r.stageId ? { stageId: r.stageId } : {}), ...(r.role ? { role: r.role } : {}), agentId: r.agentId } }));
    const ids = batch.map((r) => r.id);
    out({ workId: marker.workId, sessionId: marker.sessionId, count: list.length, more: result.list.length - batch.length,
      idempotencyKey: `crew:flow:${createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 24)}`,
      nextSeq: result.nextSeq, ids, events: list });
  },
  ack(values, ctx, positionals) {
    if (!positionals.length) throw new UsageError('지울 항목 ID를 주세요(pending 출력의 ids).');
    const drop = new Set(positionals);
    const result = withLock(ctx.p, () => {
      const records = readRecords(ctx.p);
      const kept = records.filter((r) => !(r.k === 'event' && drop.has(r.id)));
      if (kept.length !== records.length) writeRecords(ctx.p, kept);
      return { acked: records.length - kept.length, remaining: events(kept).length };
    });
    out(result);
  },
  status(values, ctx) {
    const marker = activeMarker(ctx.p);
    const left = events(readRecords(ctx.p)).length;
    out(marker ? { active: true, workId: marker.workId, sessionId: marker.sessionId, pending: left } : { active: false, pending: left });
  },
  stop(values, ctx) {
    withLock(ctx.p, () => {
      const left = events(readRecords(ctx.p)).length;
      if (left && !values.discard) throw new StateError(`보내지 않은 흐름 이벤트 ${left}건이 있습니다. 먼저 보내고 ack하거나 stop --discard로 버리세요.`);
      rmSync(ctx.p.active, { force: true });
      rmSync(ctx.p.queue, { force: true });
    });
    out({ active: false });
  },
};

function runCommand(argv) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      data: { type: 'string' }, 'claude-session': { type: 'string' }, work: { type: 'string' }, session: { type: 'string' },
      'next-seq': { type: 'string' }, discard: { type: 'boolean' } } });
    const [name, ...rest] = positionals;
    if (!Object.hasOwn(commands, name ?? '')) throw new UsageError('명령: start | pending | ack | status | stop | hook <subagent-start|subagent-stop|post-agent>');
    const ctx = commandContext(values);
    // 이 세션의 잠금 파일을 만들 디렉터리. status는 읽기만 하므로 만들지 않는다.
    if (name !== 'status') mkdirSync(ctx.p.dir, { recursive: true });
    commands[name](values, ctx, rest);
  } catch (e) {
    process.stderr.write(`flow-queue: ${e.message}\n`);
    process.exitCode = e instanceof UsageError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? 2
      : e instanceof StateError ? 3 : 1;
  }
}

if (process.argv[2] === 'hook') runHook(process.argv[3]);
else runCommand(process.argv.slice(2));

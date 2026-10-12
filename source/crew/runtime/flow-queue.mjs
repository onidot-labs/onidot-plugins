#!/usr/bin/env node
// onidot crew 작업 흐름 대기열(Claude Code 전용).
// 대기열 모드: SubagentStart·SubagentStop 훅이 서브에이전트 시작·끝을 Claude 세션별 대기열에 한 줄씩 적고,
// 메인의 Agent 호출이 끝나면(PostToolUse) 보낼 항목이 있다고 메인에 알린다. Studio로 보내는 일은 메인이
// work-record 스킬대로 MCP로 한다. 이 모드에서는 네트워크를 쓰지 않는다.
// 런타임 모드: 켤 때 `--mode runtime`을 주면 훅이 관측 이벤트를 이 PC의 `oni runtime`(127.0.0.1)으로 직접 보낸다.
// 닿지 않으면 `<oni data>/runtime/inbox/`에 이벤트당 파일 하나를 남기고, 대기열에는 적지 않는다.
// 대기열에는 식별자·역할·단계 ID·시각만 적는다. 프롬프트·결과 본문·전사 경로는 적지 않는다.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCRIPT = fileURLToPath(import.meta.url);
const MAX_EVENTS = 500;
const MAX_AGENTS = 1000;
const BATCH = 100;
const LOCK_WAIT_MS = 3000;
const STALE_LOCK_MS = 10_000;
const KEEP_DAYS = 14;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
// 서버 ids.Decode가 받고 0보다 큰 13자 TSID(Crockford 소문자, i·l·o·u 없음, 첫 글자 0-7).
const TSID = /^[0-7][0-9a-hjkmnp-tv-z]{12}$/;
export const isTsid = (v) => typeof v === 'string' && TSID.test(v) && v !== '0000000000000';
const STAGE_TAG = /\[stage:([0-9a-z]{13})\]/;

// 서버 session_events.go의 sessionOptionalText를 그대로 옮긴다. 이 규칙에 걸리는 문자열은 묶음 전체를 VALIDATION_FAILED로 만든다.
const FORBIDDEN_TOKENS = ['bearer ', 'authorization:', '-----begin ', 'sk-', 'ghp_', 'github_pat_'];
const FORBIDDEN_ASSIGNMENTS = ['api_key', 'api-key', 'password', 'access_token', 'refresh_token', 'secret'];
export function serverText(v, maxBytes) {
  if (typeof v !== 'string' || !v.trim() || /\p{Cs}/u.test(v) || Buffer.byteLength(v) > maxBytes || /\p{Cc}/u.test(v)) return false;
  const lower = v.toLowerCase();
  if (FORBIDDEN_TOKENS.some((t) => lower.includes(t))) return false;
  return !FORBIDDEN_ASSIGNMENTS.some((key) => lower.split(key).slice(1).some((rest) => rest.startsWith('=')));
}
// role·agentId는 서버 규칙에 더해 파일·셸에서 안전한 문자만 받는다.
const SAFE = /^[A-Za-z0-9_.:-]+$/;
export const validAgentId = (v) => serverText(v, 200) && SAFE.test(v);
export const validRole = (v) => serverText(v, 120) && SAFE.test(v);
// 항목 ID는 16진수와 점만 쓴다. 금지 문자열(sk-·ghp_ 등)과 키=값 꼴이 생길 수 없다.
// 서버 internal/ids와 같은 TSID: 2020-01-01부터의 밀리초 42비트 + 난수 22비트, 13자 Crockford 소문자.
const TSID_EPOCH = 1577836800000n;
const TSID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const encodeTsid = (u) => {
  let s = TSID_ALPHABET[Number(u >> 60n)];
  for (let i = 1; i < 13; i++) s += TSID_ALPHABET[Number((u >> BigInt(60 - 5 * i)) & 31n)];
  return s;
};
// 한 번에 여러 개를 만들 때는 난수 부분을 이어 붙여 같은 밀리초 안에서도 겹치지 않게 한다.
export function newTsids(count, now = Date.now(), seed = randomBytes(3).readUIntBE(0, 3) & 0x3fffff) {
  const ms = BigInt(now) - TSID_EPOCH;
  const rand = BigInt(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = (rand + BigInt(i)) & 0x3fffffn;
    const tick = ms + (rand + BigInt(i)) / 0x400000n;
    out.push(encodeTsid((tick << 22n) | r));
  }
  return out;
}
export const newId = () => `${Date.now().toString(16)}.${randomBytes(6).toString('hex')}`;
export const eventIdOf = (id) => `cc-flow:${id}`;

// ---- oni 런타임 연결 ----
// 경로 규칙은 onidot-studio internal/onipaths ResolvePaths와 같다(빈 문자열은 없는 것, 상대경로·루트는 오류).
// macOS는 모두 Application Support/onidot 아래. Linux는 XDG, runtime은 XDG_RUNTIME_DIR/onidot이고 없으면 최종 state/runtime이다.
// ONI_*_DIR가 마지막에 덮어쓴다. 잘못된 경로면 던진다.
export function oniDirs(env = process.env, home = homedir(), platform = process.platform) {
  const e = (k) => (typeof env[k] === 'string' ? env[k] : '');
  let realHome = home;
  try { realHome = realpathSync(home); } catch {}
  let p;
  if (platform === 'darwin') {
    const base = join(realHome, 'Library', 'Application Support', 'onidot');
    p = { config: join(base, 'config'), data: join(base, 'data'), state: join(base, 'state'), runtime: join(base, 'runtime') };
  } else {
    const xdg = (key, fallback) => join(e(key) || fallback, 'onidot');
    p = { config: xdg('XDG_CONFIG_HOME', join(realHome, '.config')), data: xdg('XDG_DATA_HOME', join(realHome, '.local', 'share')),
      state: xdg('XDG_STATE_HOME', join(realHome, '.local', 'state')) };
    p.runtime = e('XDG_RUNTIME_DIR') ? join(e('XDG_RUNTIME_DIR'), 'onidot') : '';
  }
  for (const [key, name] of [['config', 'ONI_CONFIG_DIR'], ['data', 'ONI_DATA_DIR'], ['state', 'ONI_STATE_DIR'], ['runtime', 'ONI_RUNTIME_DIR']])
    if (e(name)) p[key] = e(name);
  if (!p.runtime) p.runtime = join(p.state, 'runtime');
  for (const key of Object.keys(p)) {
    if (!isAbsolute(p[key]) || normalize(p[key]) === '/') throw new Error('사용자 디렉터리는 루트가 아닌 절대경로여야 합니다');
    p[key] = normalize(p[key]).replace(/(.)\/$/, '$1');
  }
  return p;
}

const SEND_TIMEOUT_MS = 300;
const HOST_DEPTH = 4;
const readTrim = (path) => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
function runtimeEndpoint(dirs) {
  let info = null;
  try { info = JSON.parse(readFileSync(join(dirs.runtime, 'oni-runtime.json'), 'utf8')); } catch {}
  const port = info?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'RUNTIME_NOT_RUNNING' };
  // 런타임이 SIGKILL로 죽어 실행 정보만 남았을 때 다른 사용자가 그 포트를 잡고 있을 수 있다.
  // pid가 살아 있고 내 소유일 때만 토큰을 보낸다(죽었으면 ESRCH, 다른 사용자면 EPERM).
  const pid = info?.pid;
  if (!Number.isInteger(pid) || pid < 1) return { error: 'RUNTIME_NOT_RUNNING' };
  try { process.kill(pid, 0); } catch { return { error: 'RUNTIME_NOT_RUNNING' }; }
  const token = readTrim(join(dirs.config, 'runtime-token'));
  return token ? { port, token } : { error: 'RUNTIME_TOKEN_MISSING' };
}
// 루프백 한 번 호출. 실패·시간 초과는 null, 아니면 {status, body}.
// node:http는 불러오는 데만 25ms가 들어(훅 하나가 50ms 안팎이어야 한다) HTTP/1.1을 직접 쓴다.
function parseResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) return null;
  const head = buf.subarray(0, sep).toString('latin1');
  const status = Number(head.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
  if (!status) return null;
  let rest = buf.subarray(sep + 4);
  if (/^transfer-encoding:\s*chunked/im.test(head)) {
    const parts = [];
    for (;;) {
      const eol = rest.indexOf('\r\n');
      if (eol < 0) break;
      const size = parseInt(rest.subarray(0, eol).toString('latin1'), 16);
      if (!(size > 0)) break;
      parts.push(rest.subarray(eol + 2, eol + 2 + size));
      rest = rest.subarray(eol + 2 + size + 2);
    }
    rest = Buffer.concat(parts);
  }
  return { status, body: rest.toString('utf8') };
}
const callRuntime = (ep, { method, path, body, timeoutMs }) => new Promise((resolve) => {
  let done = false;
  const chunks = [];
  const finish = (v) => { if (!done) { done = true; clearTimeout(timer); socket.destroy(); resolve(v); } };
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const socket = connect({ host: '127.0.0.1', port: ep.port });
  const timer = setTimeout(() => finish(null), timeoutMs);
  socket.on('connect', () => {
    socket.write([`${method} ${path} HTTP/1.1`, `Host: 127.0.0.1:${ep.port}`, `Authorization: Bearer ${ep.token}`, 'Connection: close',
      ...(payload ? ['Content-Type: application/json', `Content-Length: ${payload.length}`] : []), '', ''].join('\r\n'));
    if (payload) socket.write(payload);
  });
  socket.on('data', (d) => chunks.push(d));
  socket.on('end', () => finish(parseResponse(Buffer.concat(chunks))));
  socket.on('close', () => finish(parseResponse(Buffer.concat(chunks))));
  socket.on('error', () => finish(null));
});
// 이벤트 하나당 파일 하나. 임시 파일에 쓴 뒤 rename해 런타임이 반쯤 쓴 파일을 읽지 않게 한다.
function writeInbox(dirs, event) {
  try {
    const dir = join(dirs.data, 'runtime', 'inbox');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
    const tmp = join(dir, `.${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(event) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, join(dir, `${name}.json`));
    return true;
  } catch { return false; }
}
// 런타임에 보내고, 안 되면 inbox에 쓴다. 'runtime' | 'inbox' | 'lost'.
async function sendEvent(event, dirs) {
  try {
    dirs ??= oniDirs();
    const ep = runtimeEndpoint(dirs);
    if (!ep.error) {
      const r = await callRuntime(ep, { method: 'POST', path: '/v1/hook-events', body: { events: [event] }, timeoutMs: SEND_TIMEOUT_MS });
      if (r?.status === 200) return 'runtime';
    }
  } catch {}
  try { dirs ??= oniDirs(); } catch { return 'lost'; }
  return writeInbox(dirs, event) ? 'inbox' : 'lost';
}

// 봉투. eventId는 보내는 쪽이 정하는 고정 값이다(같은 사건을 다시 보내면 같은 값). 해시는 16진수라 금지 문자열이 생길 수 없다.
const eventIdFor = (...parts) => `cc-hook:${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`;
const KEY = {
  SESSION_STARTED: (e) => [e.occurredAt], SESSION_ENDED: (e) => [e.occurredAt], TURN_ENDED: (e) => [e.occurredAt],
  SUBAGENT_STARTED: (e) => [e.agentId], SUBAGENT_FINISHED: (e) => [e.agentId], AGENT_LINKED: (e) => [e.agentId, e.stageId],
  STAGE_STARTED: (e) => [e.stageId, e.data?.runId], STAGE_FINISHED: (e) => [e.stageId, e.data?.runId, e.data?.result],
  FLOW_BOUND: (e) => [e.data?.workId, e.data?.sessionId, e.flowStartedAt], FLOW_UNBOUND: (e) => [e.data?.workId, e.data?.sessionId, e.flowStartedAt],
};
function envelope(kind, sid, fields = {}) {
  const { flowStartedAt, ...rest } = fields;
  const body = Object.fromEntries(Object.entries({ host: 'claude-code', hostSession: sid, kind, occurredAt: new Date().toISOString(), ...rest }).filter(([, v]) => v !== undefined));
  return { schemaVersion: 1, eventId: eventIdFor(kind, sid, ...KEY[kind]({ ...body, flowStartedAt })), ...body };
}

// Claude Code 호스트 프로세스 찾기. ps로 조상을 4단계까지 올라간다.
function psRead(pid) {
  const run = (cols) => spawnSync('ps', ['-o', cols, '-p', String(pid)], { encoding: 'utf8', timeout: 500, env: { ...process.env, LC_ALL: 'C' } });
  const r = run('ppid=,lstart=,comm=');
  const m = r.status === 0 && r.stdout.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
  if (!m) return null;
  const info = { ppid: Number(m[1]), lstart: m[2], comm: m[3] };
  if (/^(node|bun)$/.test(basename(info.comm))) info.args = run('args=').stdout.trim();
  return info;
}
const isClaude = (p) => { const b = basename(p.comm ?? ''); return b === 'claude' || b === 'claude.exe' || (/^(node|bun)$/.test(b) && /claude/.test(p.args ?? '')); };
export function findHost(start = process.pid, ps = psRead) {
  try {
    let me = ps(start);
    for (let i = 0; i < HOST_DEPTH; i++) {
      if (!me || !(me.ppid > 1)) return {};
      const parent = ps(me.ppid);
      if (!parent) return {};
      if (isClaude(parent)) {
        const started = new Date(parent.lstart.replace(/\s+/g, ' '));
        return { hostPid: me.ppid, ...(Number.isNaN(started.getTime()) ? {} : { hostStartedAt: started.toISOString() }),
          ...(/claude-code\/(\d+\.\d+\.\d+)\//.test(parent.comm) ? { hostVersion: parent.comm.match(/claude-code\/(\d+\.\d+\.\d+)\//)[1] } : {}) };
      }
      me = parent;
    }
  } catch {}
  return {};
}

class UsageError extends Error {}
class StateError extends Error {}
class LockBusy extends Error {}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const testDelay = () => { const ms = Number(process.env.FLOW_QUEUE_TEST_DELAY_MS); if (ms > 0 && ms < 5000) sleep(ms); };
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
  return marker && typeof marker === 'object' && isTsid(marker.workId) && isTsid(marker.sessionId) ? marker : null;
};
const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

// 세션별 잠금. 쓰기·꺼내기·지우기가 모두 이 잠금 안에서 일어나 줄이 섞이거나 항목을 잃지 않는다.
// 잠금 파일에 소유 토큰을 적고, 낡은 잠금은 토큰이 그대로일 때만, 자기 잠금은 자기 토큰일 때만 지운다.
function withLock(p, fn) {
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(p.lock, 'wx', 0o600);
      writeSync(fd, token);
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const seen = readText(p.lock);
      let stale = false;
      try { stale = Date.now() - statSync(p.lock).mtimeMs > STALE_LOCK_MS; } catch {}
      if (stale && seen !== null && readText(p.lock) === seen) { rmSync(p.lock, { force: true }); continue; }
      if (Date.now() > deadline) throw new LockBusy('대기열 잠금을 얻지 못했습니다. 잠시 뒤 다시 실행하세요.');
      sleep(15);
    }
  }
  try { return fn(); } finally { if (readText(p.lock) === token) rmSync(p.lock, { force: true }); }
}

// 대기열 줄:
//   {k:'agent', agentId, started?:true, role?, stageId?}  서브에이전트 시작 또는 단계 연결
//   {k:'event', id, type, agentId, role?, workId, sessionId, occurredAt, seq?, stageId?}
const readRecords = (p) => {
  let text;
  try { text = readFileSync(p.queue, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line); if (v && typeof v === 'object' && (v.k === 'agent' || v.k === 'event') && validAgentId(v.agentId)) out.push(v); } catch {}
  }
  return out;
};
const writeRecords = (p, records) => {
  const tmp = `${p.queue}.${process.pid}.tmp`;
  writeFileSync(tmp, records.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
  renameSync(tmp, p.queue);
};
const append = (p, ...records) => appendFileSync(p.queue, records.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
const events = (records) => records.filter((r) => r.k === 'event');
const agents = (records) => records.filter((r) => r.k === 'agent');
const shellQuote = (v) => `'${String(v).replaceAll("'", `'\\''`)}'`;

// ---- 훅 ----
function hookContext(raw, name) {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (!data || !isAbsolute(data)) return null;
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.session_id !== 'string' || !SESSION.test(input.session_id)) return null;
  const p = paths(data, input.session_id);
  // 잠금 밖의 첫 확인. 활성 표시가 없으면 잠금 파일도 만들지 않는다.
  // session-start는 켜기 전에 알려야 하므로 먼저 검사해 통과시킨다(활성 표시가 깨졌어도 디스크를 읽지 않는다).
  return name === 'session-start' || activeMarker(p) ? { data, input, p, sid: input.session_id } : null;
}
const subagent = (input) => {
  const agentId = input.agent_id, role = input.agent_type;
  // 내부 에이전트(프롬프트 제안 등)는 agent_type이 비어 있다. agentId가 서버 규칙에 걸리면 기록하지 않는다.
  if (!validAgentId(agentId) || typeof role !== 'string' || !role) return null;
  // role은 선택 필드다. 서버 규칙에 걸리면(예: task-runner의 sk-) 빼고 적는다.
  return { agentId, ...(validRole(role) ? { role } : {}) };
};
const eventRecord = (type, who, marker) => ({ k: 'event', id: newId(), type, ...who, workId: marker.workId, sessionId: marker.sessionId, occurredAt: new Date().toISOString() });

const hooks = {
  // Bash 셸에는 CLAUDE_PLUGIN_ROOT·CLAUDE_PLUGIN_DATA가 없다(훅 명령에서만 치환된다).
  // 세션 시작 때 절대경로가 든 명령 접두사를 메인에 알려, work-record 스킬이 이것을 그대로 쓰게 한다.
  'session-start'(ctx) {
    // 서브에이전트 세션에는 알리지 않는다. 작업 기록 쓰기는 메인만 한다.
    if (typeof ctx.input.agent_id === 'string' && ctx.input.agent_id) return;
    const prefix = `node ${shellQuote(SCRIPT)} <명령> --data ${shellQuote(ctx.data)} --claude-session ${shellQuote(ctx.sid)}`;
    const context = `onidot crew 흐름 명령 접두사(work-record 스킬 3절 8번의 <flow>): ${prefix}\n<명령>은 start|pending|ack|unstage|status|stop|ids|readiness|stage 중 하나입니다.`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  },
  'subagent-start'(ctx) {
    const who = subagent(ctx.input);
    if (!who) return;
    withLock(ctx.p, () => {
      const marker = activeMarker(ctx.p);
      if (!marker) return;
      const records = readRecords(ctx.p);
      if (events(records).length >= MAX_EVENTS) return;
      append(ctx.p, ...(agents(records).length < MAX_AGENTS ? [{ k: 'agent', ...who, started: true }] : []), eventRecord('SUBAGENT_STARTED', who, marker));
    });
  },
  'subagent-stop'(ctx) {
    const who = subagent(ctx.input);
    if (!who) return;
    withLock(ctx.p, () => {
      const marker = activeMarker(ctx.p);
      if (!marker) return;
      const records = readRecords(ctx.p);
      // 시작을 본 서브에이전트만 끝을 적는다. 활성 전에 시작했거나 내부 에이전트면 건너뛴다.
      if (!records.some((r) => r.k === 'agent' && r.started && r.agentId === who.agentId)) return;
      if (events(records).length >= MAX_EVENTS) return;
      append(ctx.p, eventRecord('SUBAGENT_FINISHED', who, marker));
    });
  },
  'post-agent'(ctx) {
    const { input, p } = ctx;
    // Agent는 2.1.63 전 이름이 Task였다.
    if (input.tool_name !== 'Agent' && !(input.tool_name === 'Task' && typeof input.tool_input?.subagent_type === 'string')) return;
    const response = input.tool_response, description = input.tool_input?.description;
    const agentId = response && typeof response === 'object' ? response.agentId : undefined;
    const tag = typeof description === 'string' ? description.match(STAGE_TAG) : null;
    const state = withLock(p, () => {
      const marker = activeMarker(p);
      if (!marker) return null;
      const records = readRecords(p);
      // 단계를 맡긴 호출의 description 끝 표식 [stage:<단계 ID>]만 읽어 그 서브에이전트에 단계를 붙인다.
      // 백그라운드 호출은 SubagentStart보다 먼저 끝날 수 있으므로 시작 기록이 없어도 연결을 저장한다.
      if (tag && isTsid(tag[1]) && validAgentId(agentId) && agents(records).length < MAX_AGENTS) append(p, { k: 'agent', agentId, stageId: tag[1] });
      return { marker, count: events(records).length };
    });
    // 서브에이전트 안의 Agent 호출에는 알리지 않는다. 작업 기록 쓰기는 메인만 한다.
    if (!state || typeof input.agent_id === 'string' && input.agent_id || !state.count) return;
    const command = `node ${shellQuote(SCRIPT)}`, args = `--data ${shellQuote(ctx.data)} --claude-session ${shellQuote(ctx.sid)}`;
    const context = [`onidot crew: 기록할 흐름 이벤트 ${state.count}건이 대기열에 있습니다(작업 ${state.marker.workId}). onidot-crew:work-record 스킬의 3절 8번대로 append_work_session_events로 보내고, 성공하면 지우세요.`,
      `꺼내기: ${command} pending ${args} --next-seq <다음 producerSeq>`,
      `보낸 뒤 지우기: ${command} ack ${args} <꺼내기 출력의 ids>`].join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
  },
};

// 대기열 모드에서 이 훅들은 할 일이 없다. 런타임 모드에서만 이벤트를 보낸다.
hooks['session-end'] = () => {};
hooks.stop = () => {};

// 런타임 모드 훅. 대기열에 적지 않고 알림도 내지 않는다(SessionStart의 명령 접두사 안내만 유지).
const isSubagentInput = (input) => typeof input.agent_id === 'string' && input.agent_id !== '';
const runtimeHooks = {
  async 'session-start'(ctx) {
    hooks['session-start'](ctx);
    if (isSubagentInput(ctx.input)) return;
    await sendEvent(envelope('SESSION_STARTED', ctx.sid, findHost()));
  },
  async 'session-end'(ctx) { if (!isSubagentInput(ctx.input)) await sendEvent(envelope('SESSION_ENDED', ctx.sid)); },
  async stop(ctx) { if (!isSubagentInput(ctx.input)) await sendEvent(envelope('TURN_ENDED', ctx.sid)); },
  async 'subagent-start'(ctx) {
    const who = subagent(ctx.input);
    if (who) await sendEvent(envelope('SUBAGENT_STARTED', ctx.sid, { agentId: who.agentId, agentType: who.role, ...findHost() }));
  },
  async 'subagent-stop'(ctx) {
    const who = subagent(ctx.input);
    if (who) await sendEvent(envelope('SUBAGENT_FINISHED', ctx.sid, { agentId: who.agentId, agentType: who.role }));
  },
  async 'post-agent'(ctx) {
    const { input } = ctx;
    if (input.tool_name !== 'Agent' && !(input.tool_name === 'Task' && typeof input.tool_input?.subagent_type === 'string')) return;
    const agentId = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response.agentId : undefined;
    const description = input.tool_input?.description;
    const tag = typeof description === 'string' ? description.match(STAGE_TAG) : null;
    if (tag && isTsid(tag[1]) && validAgentId(agentId)) await sendEvent(envelope('AGENT_LINKED', ctx.sid, { agentId, stageId: tag[1] }));
  },
};

async function runHook(name) {
  // 훅은 어떤 경우에도 Claude Code 작업을 막지 않는다. 오류는 조용히 버리고 종료 코드 0으로 끝낸다.
  const done = () => process.exit(0);
  const handler = Object.hasOwn(hooks, name ?? '') ? hooks[name] : null;
  if (!handler) { process.stdin.resume(); process.stdin.on('end', done).on('error', done); return; }
  // 3초 안에 못 끝나는 일은 버린다(Claude Code의 훅 timeout보다 먼저 스스로 끝낸다).
  setTimeout(done, 3000).unref();
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; if (raw.length > 1_000_000) done(); });
  process.stdin.on('error', done);
  process.stdin.on('end', async () => {
    try {
      const ctx = hookContext(raw, name);
      if (ctx) {
        let marker = null;
        try { marker = activeMarker(ctx.p); } catch {}
        if (marker?.mode === 'runtime') await runtimeHooks[name](ctx);
        else handler(ctx);
      }
    } catch {}
    done();
  });
}

// ---- 메인이 부르는 명령 ----
function commandContext(values) {
  const data = values.data;
  if (!data || !isAbsolute(data)) throw new UsageError('--data에 플러그인 데이터 디렉터리의 절대경로를 주세요(세션 시작 때 훅이 알려 준 접두사의 --data 값).');
  // 스킬 치환이 안 된 환경에서는 빈 값이 오므로 Bash의 CLAUDE_CODE_SESSION_ID로 넘어간다.
  const sid = values['claude-session'] || process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid || !SESSION.test(sid)) throw new UsageError('Claude 세션 ID를 알 수 없습니다. Claude Code의 Bash에서 실행하거나 --claude-session을 주세요.');
  return { sid, p: paths(data, sid) };
}
const ledgerId = (value, flag) => {
  if (!isTsid(value)) throw new UsageError(`${flag}에 작업 기록 ID(13자 TSID)를 주세요.`);
  return value;
};
const out = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

// 다른 세션의 파일은 그 세션 파일 중 가장 최근 수정 시각이 기한을 넘었을 때만 함께 지운다.
function cleanup(dir, sid) {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
  const sessions = new Map();
  for (const name of readdirSync(dir)) {
    const owner = name.split('.')[0];
    if (owner === sid) continue;
    let mtime = 0;
    try { mtime = statSync(join(dir, name)).mtimeMs; } catch { continue; }
    const s = sessions.get(owner) ?? { latest: 0, names: [] };
    s.latest = Math.max(s.latest, mtime);
    s.names.push(name);
    sessions.set(owner, s);
  }
  for (const s of sessions.values()) if (s.latest < cutoff) for (const name of s.names) rmSync(join(dir, name), { force: true });
}

const commands = {
  async start(values, ctx) {
    const workId = ledgerId(values.work, '--work'), sessionId = ledgerId(values.session, '--session');
    const mode = values.mode ?? 'queue';
    if (mode !== 'queue' && mode !== 'runtime') throw new UsageError('--mode는 queue 또는 runtime이어야 합니다.');
    const spaceId = values.space === undefined ? undefined : ledgerId(values.space, '--space');
    if (mode === 'runtime' && !spaceId) throw new UsageError('--mode runtime에는 --space(Space ID)가 필요합니다.');
    cleanup(ctx.p.dir, ctx.sid);
    const startedAt = withLock(ctx.p, () => {
      const marker = activeMarker(ctx.p);
      const left = events(readRecords(ctx.p)).length;
      const same = marker && marker.workId === workId && marker.sessionId === sessionId;
      if (!same && left)
        throw new StateError(`보내지 않은 흐름 이벤트 ${left}건이 있습니다(작업 ${marker?.workId ?? '알 수 없음'}). 먼저 보내고 ack하거나 stop --discard로 버리세요.`);
      if (mode === 'runtime' && left)
        throw new StateError(`대기열에 보내지 않은 흐름 이벤트 ${left}건이 있어 runtime 모드로 바꿀 수 없습니다. 먼저 보내고 ack하거나 stop --discard로 버리세요.`);
      if (!same) rmSync(ctx.p.queue, { force: true });
      const startedAt = same && typeof marker.startedAt === 'string' ? marker.startedAt : new Date().toISOString();
      // 임시 파일에 쓴 뒤 rename해 읽는 쪽이 반쯤 쓴 활성 표시를 보지 않게 한다.
      const tmp = `${ctx.p.active}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ workId, sessionId, startedAt, mode, ...(spaceId ? { spaceId } : {}),
        ...(same && marker.stages && typeof marker.stages === 'object' ? { stages: marker.stages } : {}) }) + '\n', { mode: 0o600 });
      renameSync(tmp, ctx.p.active);
      return startedAt;
    });
    const bound = mode === 'runtime'
      ? await sendEvent(envelope('FLOW_BOUND', ctx.sid, { data: { spaceId, workId, sessionId }, flowStartedAt: startedAt })) : undefined;
    out({ active: true, claudeSession: ctx.sid, workId, sessionId, mode, ...(spaceId ? { spaceId } : {}), ...(bound ? { bound } : {}) });
  },
  // 런타임 모드의 단계 시작·끝. 증거·판정·완료는 MCP로 남기고, 단계 흐름만 런타임이 보낸다.
  async stage(values, ctx, positionals) {
    const sub = positionals[0];
    if (sub !== 'start' && sub !== 'finish') throw new UsageError('stage start|finish 중 하나를 주세요.');
    const stageId = values.stage;
    if (!isTsid(stageId)) throw new UsageError('--stage에 단계 ID(13자 TSID)를 주세요.');
    if (!serverText(values.summary, 1000)) throw new UsageError('--summary에 한 줄 요약(1000바이트 이하, 줄바꿈·비밀값 모양 문자열 없음)을 주세요.');
    let data;
    if (sub === 'start') {
      if (!validRole(values.role)) throw new UsageError('--role에 맡긴 역할 이름(예: onidot-crew:worker)을 주세요.');
      data = { role: values.role, summary: values.summary };
    } else {
      if (!['DONE', 'FAILED', 'BLOCKED'].includes(values.result)) throw new UsageError('--result는 DONE, FAILED, BLOCKED 중 하나여야 합니다.');
      data = { result: values.result, summary: values.summary };
    }
    // 실행 번호(runId): 끝나지 않은 단계의 start 재호출은 같은 번호(재시도), 끝난 뒤의 start는 새 번호다. 활성 표시에 단계별로 저장한다.
    const runId = withLock(ctx.p, () => {
      const marker = activeMarker(ctx.p);
      if (marker?.mode !== 'runtime') throw new StateError('runtime 모드로 켠 작업 흐름이 없습니다. stage 명령은 start --mode runtime 뒤에만 씁니다.');
      const stages = marker.stages && typeof marker.stages === 'object' ? marker.stages : {};
      const entry = stages[stageId] ?? { run: 0, open: false };
      const run = sub === 'start' ? (entry.open ? entry.run : entry.run + 1) : Math.max(entry.run, 1);
      stages[stageId] = { run, open: sub === 'start' };
      const tmp = `${ctx.p.active}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...marker, stages }) + '\n', { mode: 0o600 });
      renameSync(tmp, ctx.p.active);
      return run;
    });
    data.runId = runId;
    const sent = await sendEvent(envelope(sub === 'start' ? 'STAGE_STARTED' : 'STAGE_FINISHED', ctx.sid, { stageId, data }));
    out({ sent, stageId });
  },
  pending(values, ctx) {
    const raw = values['next-seq'];
    if (raw === undefined || !/^\d{1,15}$/.test(raw)) throw new UsageError('--next-seq에 다음 producerSeq(0 이상 정수)를 주세요.');
    const nextSeq = Number(raw);
    const result = withLock(ctx.p, () => {
      const marker = activeMarker(ctx.p);
      if (!marker) throw new StateError('켜진 작업 흐름 기록이 없습니다. start로 켜세요.');
      const all = readRecords(ctx.p);
      testDelay();
      // 지금 켜진 작업·세션의 항목만 낸다. 한 요청은 한 세션의 이벤트만 담는다.
      const mine = (r) => r.k === 'event' && r.workId === marker.workId && r.sessionId === marker.sessionId;
      const stages = new Map();
      for (const r of agents(all)) if (isTsid(r.stageId)) stages.set(r.agentId, r.stageId);
      // 아직 순번을 받지 않은 같은 서브에이전트의 끝 이벤트는 마지막 하나만 남긴다.
      const lastFinish = new Map();
      for (const r of all) if (mine(r) && r.type === 'SUBAGENT_FINISHED' && r.seq === undefined) {
        const prev = lastFinish.get(r.agentId);
        if (!prev || r.occurredAt >= prev.occurredAt) lastFinish.set(r.agentId, r);
      }
      const records = all.filter((r) => !(mine(r) && r.type === 'SUBAGENT_FINISHED' && r.seq === undefined && lastFinish.get(r.agentId) !== r));
      // 처음 꺼낼 때 순번과 단계를 정해 저장한다. 다시 꺼내도 같은 이벤트가 나와 재전송이 중복되지 않는다.
      let seq = nextSeq;
      for (const r of records) if (mine(r) && Number.isSafeInteger(r.seq)) seq = Math.max(seq, r.seq + 1);
      const fresh = records.filter((r) => mine(r) && r.seq === undefined)
        .sort((a, b) => a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1);
      for (const r of fresh) {
        r.seq = seq++;
        const stageId = stages.get(r.agentId);
        if (stageId) r.stageId = stageId;
      }
      if (fresh.length || records.length !== all.length) writeRecords(ctx.p, records);
      return { marker, list: records.filter(mine).sort((a, b) => a.seq - b.seq), nextSeq: seq };
    });
    // 서버는 한 요청에 이벤트 100개까지 받는다. 순번이 앞선 것부터 100개씩 낸다.
    const batch = result.list.slice(0, BATCH);
    const list = batch.map((r) => ({ schemaVersion: 1, eventId: eventIdOf(r.id), sessionId: r.sessionId, producerSeq: r.seq,
      occurredAt: r.occurredAt, type: r.type,
      payload: { workId: r.workId, ...(r.stageId ? { stageId: r.stageId } : {}), ...(r.role ? { role: r.role } : {}), agentId: r.agentId } }));
    const ids = batch.map((r) => r.id);
    out({ workId: result.marker.workId, sessionId: result.marker.sessionId, count: list.length, more: result.list.length - batch.length,
      // 키는 보낼 이벤트 내용 전체에서 만든다. 같은 묶음은 같은 키, 항목이나 단계가 바뀌면 다른 키다.
      idempotencyKey: `crew:flow:${createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 24)}`,
      nextSeq: result.nextSeq, ids, events: list });
  },
  ack(values, ctx, positionals) {
    if (!positionals.length) throw new UsageError('지울 항목 ID를 주세요(pending 출력의 ids).');
    const drop = new Set(positionals);
    const result = withLock(ctx.p, () => {
      const records = readRecords(ctx.p);
      testDelay();
      const removed = events(records).filter((r) => drop.has(r.id));
      let kept = records.filter((r) => !(r.k === 'event' && drop.has(r.id)));
      // 끝 이벤트를 보낸 서브에이전트의 기록은 남은 이벤트가 없으면 지운다. 다시 시작하면 새로 적힌다.
      const finished = new Set(removed.filter((r) => r.type === 'SUBAGENT_FINISHED').map((r) => r.agentId));
      const busy = new Set(events(kept).map((r) => r.agentId));
      kept = kept.filter((r) => !(r.k === 'agent' && finished.has(r.agentId) && !busy.has(r.agentId)));
      if (kept.length !== records.length) writeRecords(ctx.p, kept);
      return { acked: removed.length, remaining: events(kept).length };
    });
    out(result);
  },
  // 계획에서 빠진 단계(TARGET_MISMATCH)의 ID만 대기열 항목에서 떼어 나머지 내용으로 다시 보낼 수 있게 한다.
  unstage(values, ctx) {
    const stageId = values.stage;
    if (!isTsid(stageId)) throw new UsageError('--stage에 뗄 단계 ID(13자 TSID)를 주세요.');
    const result = withLock(ctx.p, () => {
      const records = readRecords(ctx.p);
      let changed = 0;
      for (const r of records) if (r.stageId === stageId) { delete r.stageId; if (r.k === 'event') changed++; }
      writeRecords(ctx.p, records.filter((r) => !(r.k === 'agent' && !r.started && !r.stageId)));
      return { unstaged: changed };
    });
    out(result);
  },
  status(values, ctx) {
    const marker = activeMarker(ctx.p);
    const left = events(readRecords(ctx.p)).length;
    out(marker ? { active: true, workId: marker.workId, sessionId: marker.sessionId, pending: left } : { active: false, pending: left });
  },
  async stop(values, ctx) {
    const marker = withLock(ctx.p, () => {
      const left = events(readRecords(ctx.p)).length;
      if (left && !values.discard) throw new StateError(`보내지 않은 흐름 이벤트 ${left}건이 있습니다. 먼저 보내고 ack하거나 stop --discard로 버리세요.`);
      const marker = activeMarker(ctx.p);
      rmSync(ctx.p.active, { force: true });
      rmSync(ctx.p.queue, { force: true });
      return marker;
    });
    if (marker?.mode === 'runtime')
      await sendEvent(envelope('FLOW_UNBOUND', ctx.sid, { data: { workId: marker.workId, sessionId: marker.sessionId }, flowStartedAt: marker.startedAt }));
    out({ active: false });
  },
};

// 종료 코드: 0 성공, 1 잠금 실패·예상 못 한 오류, 2 잘못된 인자, 3 상태 오류(꺼져 있음·보내지 않은 항목 있음).
// 런타임 준비 상태. 런타임 응답을 그대로 내고 runtime: true|false를 더한다.
async function readiness(values) {
  const spaceId = ledgerId(values.space, '--space');
  let dirs;
  try { dirs = oniDirs(); } catch { return out({ runtime: false, ready: false, reason: 'PATHS_INVALID' }); }
  const ep = runtimeEndpoint(dirs);
  if (ep.error) return out({ runtime: false, ready: false, reason: ep.error });
  const r = await callRuntime(ep, { method: 'GET', path: `/v1/readiness?spaceId=${spaceId}`, timeoutMs: 1500 });
  if (!r) return out({ runtime: false, ready: false, reason: 'RUNTIME_NOT_RUNNING' });
  if (r.status !== 200) return out({ runtime: true, ready: false, reason: `HTTP_${r.status}` });
  let body = null;
  try { body = JSON.parse(r.body); } catch {}
  out(body && typeof body === 'object' && !Array.isArray(body) ? { ...body, runtime: true } : { runtime: true, ready: false, reason: 'INVALID_RESPONSE' });
}

async function runCommand(argv) {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      data: { type: 'string' }, 'claude-session': { type: 'string' }, work: { type: 'string' }, session: { type: 'string' },
      'next-seq': { type: 'string' }, stage: { type: 'string' }, discard: { type: 'boolean' }, count: { type: 'string' },
      space: { type: 'string' }, mode: { type: 'string' }, role: { type: 'string' }, summary: { type: 'string' }, result: { type: 'string' } } });
    const [name, ...rest] = positionals;
    // ids는 대기열과 무관하게 작업 기록 단계 ID만 발급하므로 세션·데이터 경로가 없어도 된다.
    if (name === 'ids') {
      const raw = values.count ?? '1';
      if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 200) throw new UsageError('--count에 1~200 사이 개수를 주세요.');
      out({ ids: newTsids(Number(raw)) });
      return;
    }
    if (name === 'readiness') { await readiness(values); return; }
    if (!Object.hasOwn(commands, name ?? '')) throw new UsageError('명령: start | pending | ack | unstage | status | stop | ids | readiness | stage <start|finish> | hook <session-start|session-end|subagent-start|subagent-stop|post-agent|stop>');
    const ctx = commandContext(values);
    // 이 세션의 잠금 파일을 만들 디렉터리. status는 읽기만 하므로 만들지 않는다.
    if (name !== 'status') mkdirSync(ctx.p.dir, { recursive: true, mode: 0o700 });
    await commands[name](values, ctx, rest);
  } catch (e) {
    process.stderr.write(`flow-queue: ${e.message}\n`);
    process.exitCode = e instanceof UsageError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? 2
      : e instanceof StateError ? 3 : 1;
  }
}

// 시험이 검증 함수를 import할 수 있게, 직접 실행됐을 때만 명령을 처리한다.
const direct = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(SCRIPT); } catch { return false; } })();
if (direct) {
  if (process.argv[2] === 'hook') runHook(process.argv[3]);
  else await runCommand(process.argv.slice(2));
}

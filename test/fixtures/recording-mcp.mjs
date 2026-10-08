// Isolated model-client fixture. No production backend, authentication, or network calls.
import { createInterface } from 'node:readline';
import { mkdir, chmod, readFile, writeFile, appendFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const configuredDir = process.env.ONIDOT_RECORDING_FIXTURE_DIR;
const guideFile = process.env.ONIDOT_RECORDING_GUIDE_FILE;
const mode = process.env.ONIDOT_RECORDING_FIXTURE_MODE ?? 'write';
if (!configuredDir || !guideFile || !['write', 'read', 'fail'].includes(mode)) {
  process.stderr.write('ONIDOT_RECORDING_FIXTURE_DIR and ONIDOT_RECORDING_GUIDE_FILE are required; mode must be write|read|fail\n');
  process.exit(1);
}
const dir = resolve(configuredDir), recordsPath = join(dir, 'records.json'), callsPath = join(dir, 'calls.jsonl');
const defaultGuide = await readFile(guideFile, 'utf8');
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const spaces = [
  { id: 'fixture-personal', spaceId: 'fixture-personal', name: 'recording fixture 개인', type: 'PERSONAL' },
  { id: 'fixture-team', spaceId: 'fixture-team', name: 'recording fixture 프로젝트', type: 'TEAM' }
].map(space => ({ ...space, role: 'OWNER', connectionMode: mode === 'read' ? 'READ' : 'WRITE' }));
let records;
try { records = JSON.parse(await readFile(recordsPath, 'utf8')); await chmod(recordsPath, 0o600); }
catch (error) { if (error.code !== 'ENOENT') throw error; records = []; }
if (!Array.isArray(records)) throw new Error('Invalid fixture records');
const string = { type: 'string' }, kinds = ['FACT', 'ISSUE', 'LESSON', 'CORRECTION', 'DECISION', 'QUESTION', 'NOTE'];
const statuses = ['VERIFIED', 'ASSUMED', 'UNVERIFIED'], sourceKinds = ['PAGE', 'URL', 'COMMAND', 'FILE', 'USER', 'WORK'];
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const schemas = {
  get_onidot_guide: object(), list_spaces: object(), inspect_fixture: object(),
  get_assistant_context: object({ spaceId: string }, ['spaceId']),
  get_record: object({ recordId: string }, ['recordId']),
  recall: object({ query: string, spaceIds: { type: 'array', items: string }, kind: { ...string, enum: kinds }, status: { ...string, enum: statuses }, limit: { type: 'integer' } }),
  remember: object({ spaceId: string, kind: { ...string, enum: kinds }, title: string, body: string, status: { ...string, enum: statuses }, sources: { type: 'array', items: object({ kind: { ...string, enum: sourceKinds }, ref: string, note: string }, ['kind', 'ref']) }, recordId: string, expectedVersion: { type: 'integer' } }, ['spaceId', 'kind', 'title', 'body', 'status'])
};
const descriptions = {
  get_onidot_guide: 'onidot 기본 지침과 접근 가능한 격리 테스트 Space를 조회합니다.',
  get_assistant_context: '선택한 격리 Space의 지침을 읽습니다.',
  list_spaces: '접근 가능한 PERSONAL 및 TEAM 격리 Space를 조회합니다.',
  recall: '저장한 AI 기록을 검색어와 Space별로 찾아 다음 세션에서도 재사용합니다.',
  remember: 'AI 기록을 저장하거나 recordId·expectedVersion으로 갱신합니다. VERIFIED에는 sources 출처가 필요합니다. 반환 record의 id/version으로 성공을 확인합니다.',
  get_record: 'recordId로 저장 기록 전체를 조회합니다.',
  inspect_fixture: '합성 CSV 반입 작업의 관측 결과·원인·해결·검증 출처를 조회합니다. 실제 서비스 데이터가 아닙니다.'
};
const tools = Object.entries(schemas).filter(([name]) => mode !== 'read' || name !== 'remember').map(([name, inputSchema]) => ({ name, description: descriptions[name], inputSchema, annotations: { readOnlyHint: name !== 'remember', destructiveHint: false, openWorldHint: false } }));
const envelope = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const fail = message => { throw new Error(message); };
function validateSpace(spaceId) { if (!spaces.some(space => space.id === spaceId)) fail('FIXTURE_SPACE_NOT_FOUND'); }
async function call(name, args) {
  switch (name) {
    case 'get_onidot_guide': return { defaultGuide, spaces, connectionMode: mode === 'read' ? 'READ' : 'WRITE' };
    case 'list_spaces': return { spaces };
    case 'get_assistant_context':
      validateSpace(args.spaceId);
      return { spaceId: args.spaceId, defaultGuide, instructions: '이 Space는 격리된 합성 업무 검증용입니다. 일반화한 배움은 PERSONAL Space, 프로젝트 결과는 지정한 TEAM Space에 기록합니다.', connectionMode: mode === 'read' ? 'READ' : 'WRITE' };
    case 'inspect_fixture': return { fixture: true, totalRows: 12, invalidRows: 1, validRows: 11,
      observation: '입력 12개 중 잘못된 날짜 1개 때문에 전체 CSV 반입이 실패했습니다.',
      cause: 'invalid_date에서 전체 루프가 return했습니다.',
      resolution: '행별 오류를 수집하고 유효 11개를 처리하도록 변경하여 검증했습니다.',
      status: 'VERIFIED', sources: [{ kind: 'COMMAND', ref: 'inspect_fixture', note: '격리 합성 검사: 유효 11개 처리, 잘못된 날짜 1개 오류 수집' }] };
    case 'recall': {
      const terms = String(args.query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const found = records.filter(record => (!args.spaceIds?.length || args.spaceIds.includes(record.spaceId)) && (!args.kind || record.kind === args.kind) && (!args.status || record.status === args.status) && (!terms.length || terms.some(term => `${record.title} ${record.body}`.toLocaleLowerCase().includes(term))));
      return { records: found.slice(0, Math.max(1, Math.min(args.limit ?? 50, 100))), nextCursor: null };
    }
    case 'get_record': {
      const record = records.find(record => record.id === args.recordId);
      if (!record) fail('FIXTURE_RECORD_NOT_FOUND');
      return { record, history: [], historyHasMore: false };
    }
    case 'remember': {
      if (mode === 'read') fail('FIXTURE_READ_ONLY');
      if (mode === 'fail') fail('FIXTURE_REMEMBER_FAILED');
      validateSpace(args.spaceId);
      for (const key of ['kind', 'title', 'body', 'status']) if (typeof args[key] !== 'string' || !args[key].trim()) fail('FIXTURE_VALIDATION_FAILED');
      if (!kinds.includes(args.kind) || !statuses.includes(args.status)) fail('FIXTURE_VALIDATION_FAILED');
      const sources = args.sources ?? [];
      if (!Array.isArray(sources) || sources.some(source => !sourceKinds.includes(source.kind) || typeof source.ref !== 'string' || !source.ref.trim())) fail('FIXTURE_INVALID_SOURCE');
      if (args.status === 'VERIFIED' && !sources.length) fail('FIXTURE_VERIFIED_SOURCE_REQUIRED');
      const existing = args.recordId ? records.find(record => record.id === args.recordId && record.spaceId === args.spaceId) : undefined;
      if (args.recordId && !existing) fail('FIXTURE_RECORD_NOT_FOUND');
      if (existing && existing.version !== args.expectedVersion) fail('FIXTURE_REVISION_CONFLICT');
      const record = { id: existing?.id ?? `fixture-record-${randomUUID()}`, spaceId: args.spaceId, kind: args.kind, title: args.title, body: args.body, status: args.status, sources, version: (existing?.version ?? 0) + 1 };
      const similar = records.filter(other => other.id !== record.id && other.spaceId === record.spaceId && other.title === record.title).slice(0, 3);
      const next = existing ? records.map(other => other.id === record.id ? record : other) : [...records, record];
      const temporary = join(dir, 'records.pending.json');
      await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, recordsPath);
      records = next;
      return { record, similar };
    }
    default: fail('FIXTURE_UNKNOWN_TOOL');
  }
}
async function handle(request) {
  if (request.method === 'initialize') return { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'onidot-recording-test', version: '1.0.0' }, instructions: '연결된 onidot의 get_onidot_guide를 먼저 읽고 적용하세요. 이 서버는 격리된 모델 클라이언트 시험용입니다.' };
  if (request.method === 'ping') return {};
  if (request.method === 'tools/list') return { tools };
  if (request.method !== 'tools/call') throw new Error('METHOD_NOT_FOUND');
  const name = request.params?.name;
  let result, recordId = null;
  try { const value = await call(name, request.params?.arguments ?? {}); recordId = value.record?.id ?? null; result = envelope(value); }
  catch (error) { result = { content: [{ type: 'text', text: error.message }], isError: true }; }
  await appendFile(callsPath, JSON.stringify({ tool: name, success: result.isError !== true, recordId }) + '\n', { mode: 0o600 });
  await chmod(callsPath, 0o600);
  return result;
}
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); }
  catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
  if (request.id === undefined) continue;
  let response;
  try { response = { result: await handle(request) }; }
  catch (error) { response = { error: { code: error.message === 'METHOD_NOT_FOUND' ? -32601 : -32603, message: 'Fixture request failed' } }; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\n');
}

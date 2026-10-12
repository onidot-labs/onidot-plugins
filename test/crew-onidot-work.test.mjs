import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 작업 기록은 Studio가 아니라 각 PC의 oni 런타임(MCP 서버 onidot-work)이 맡는다(개정 설계 6절, W9).
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFile(join(root, path), 'utf8');
const WORK_RECORD = 'source/crew/skills/work-record/SKILL.md';

test('work-record 스킬은 onidot-work의 도구를 쓰고 spaceId를 보내지 않는다', async () => {
  const text = await read(WORK_RECORD);
  assert.ok(frontmatter(text).includes('onidot-work'));
  assert.ok(text.includes('MCP 서버 `onidot-work`'));
  // spaceId는 "보내지 않는다/무시" 설명 안에서만 나온다. 쓰기 입력 예시에는 없다.
  const lines = text.split('\n').filter((l) => l.includes('spaceId'));
  assert.ok(lines.length > 0, '보내지 않는다는 규칙 문장이 있어야 한다');
  for (const line of lines) assert.match(line, /보내지 않|무시/, line.slice(0, 80));
  assert.ok(/`spaceId`는 보내지 않는다[^\n]*IGNORED_FIELD/.test(text), '무시되고 warnings로 알린다는 사실');
  assert.equal(/accept_handoff[^\n]*`spaceId`/.test(text), false);
  assert.equal(/invalidate_work_evidence`\(`spaceId`/.test(text), false);
});

test('work-record 스킬은 deviceId·기기 일치 규칙을 두지 않고 HOOK_ONLY/MCP_ONLY로 세션 범위를 정한다', async () => {
  const text = await read(WORK_RECORD);
  for (const line of text.split('\n').filter((l) => l.includes('deviceId'))) assert.match(line, /보내지 않|보내도 무시/, line.slice(0, 80));
  assert.equal(text.includes('같은 `collectionScope`·`deviceId`'), false);
  assert.equal(text.includes('MCP_ONLY`로 다시 열고'), false, '기기 불일치로 거부되는 일이 없다');
  assert.ok(/`mode`가 `runtime`이면 `start_work_session`을 `collectionScope`: `HOOK_ONLY`로 연다/.test(text));
  assert.ok(/`collectionScope`: `MCP_ONLY`/.test(text));
});

test('work-record 스킬은 onidot-work 도구가 없으면 resume의 진행 기록(대화 안 체크리스트)으로 대신한다', async () => {
  const text = await read(WORK_RECORD);
  assert.ok(/`onidot-work`의 도구가 연결돼 있지 않으면[^\n]*작업 기록 도구가 없는 것으로 보고[^\n]*`onidot-crew:resume`[^\n]*대화 안 체크리스트/.test(text));
  assert.ok(/`onidot-work`의 작업 기록 도구\(create_work_checklist 등\)가 없으면 쓰지 않는다/.test(frontmatter(text)));
  assert.ok(text.includes('Studio(Wiki) 연결의 도구로는 작업 기록을 남기지 않는다'));
  const plan = await read('source/crew/skills/plan/SKILL.md');
  assert.ok(/`onidot-work`의 작업 기록 도구가 있으면[^\n]*`onidot-crew:resume`/.test(plan));
});

test('work-record 스킬은 단계 선행을 ref로 걸고 Studio 전용 설명과 get_work_activity를 두지 않는다', async () => {
  const text = await read(WORK_RECORD);
  assert.ok(/단계마다 `ref`[^\n]*`predecessorStageIds`에 적어 잇는다/.test(text));
  assert.ok(text.includes('`ref`를 `plan`으로 준다'), '계획 단계의 ref');
  assert.ok(/요청 안에서만 쓰는 짧은 이름/.test(text));
  assert.ok(text.includes('`get_work`가 돌려준 단계 `id`'), '이후 요청에서는 get_work의 id');
  for (const gone of ['get_work_activity', 'WIKI_PAGE', 'ids --count', 'TSID', 'node -e', 'WIKI_REVISION', '구 서버', '회사', '`SUMMARY` 메모']) {
    assert.equal(text.includes(gone), false, `남아 있으면 안 되는 문구: ${gone}`);
  }
});

test('crew 스킬·안내 어디에도 get_work_activity와 회사·집 사용 예시가 없다', async () => {
  for (const path of ['source/crew.json', 'source/crew/main/lead.md', 'source/crew/runtime/session-start.json', 'source/crew/skills/plan/SKILL.md',
    'source/crew/skills/resume/SKILL.md', 'source/crew/skills/run/SKILL.md', 'source/crew/skills/verify/SKILL.md', WORK_RECORD]) {
    const text = await read(path);
    assert.equal(text.includes('get_work_activity'), false, path);
    assert.equal(/회사 (로컬|작업|PC)|집 (셀프호스팅|인스턴스)/.test(text), false, path);
  }
});

test('생성물이 원본과 같다: crew work-record와 flow-queue', async () => {
  const version = JSON.parse(await read('source/crew.json')).version;
  assert.equal(await read('plugins/onidot-crew/skills/work-record/SKILL.md'), (await read(WORK_RECORD)).replaceAll('{{version}}', version));
  assert.equal(await read('plugins/onidot-crew/scripts/flow-queue.mjs'), await read('source/crew/runtime/flow-queue.mjs'));
});

test('onidot 플러그인은 작업 기록을 oni 런타임(onidot-work)에 한다고 안내하고 Studio 작업 도구 안내와 onidot-work 연결 등록 예시를 두지 않는다', async () => {
  const hook = JSON.parse(await read('source/runtime/claude-session-start.json')).hookSpecificOutput.additionalContext;
  assert.ok(hook.includes('작업 기록은 oni 런타임(onidot-work)에 한다'));
  assert.equal(hook.includes('작업 기록을 담고'), false, '저장소 설명에서 작업 기록을 뺀다');
  const guide = await read('source/skills/onidot-guide/SKILL.md');
  assert.ok(guide.includes('작업 기록(큰 일의 계획·진행·증거·인계)은 oni 런타임(`onidot-work`)에 한다'));
  assert.ok(guide.includes('onidot은 사용자의 지식·결정 저장소다'));
  const workTools = /create_work(_checklist)?|claim_work|start_work_session|get_work_flow|append_work_session_events|save_handoff/;
  for (const path of ['source/skills/onidot-guide/SKILL.md', 'source/skills/use-onidot/SKILL.md', 'source/skills/setup-onidot/SKILL.md', 'source/runtime/claude-session-start.json']) {
    assert.equal(workTools.test(await read(path)), false, `${path}에 Studio 작업 도구 안내가 남음`);
  }
  const setup = await read('source/skills/setup-onidot/SKILL.md');
  assert.equal(setup.includes('[mcp_servers.onidot-work]'), false, 'onidot-work는 연결 등록 대상이 아니다');
  assert.ok(setup.includes('별칭 `work`는 이 PC의 oni 런타임이 작업 기록용 MCP 서버 `onidot-work`로 쓰는 이름'));
  assert.equal(/회사 로컬|집 셀프호스팅|onidot-home|<집|<회사/.test(setup), false, '회사·집 예시');
  assert.equal(/집 셀프호스팅|회사 로컬/.test(await read('README.md')), false);
});

test('버전은 0.x이고 두 플러그인이 올랐다', async () => {
  const crew = JSON.parse(await read('source/crew.json')).version;
  const wiki = JSON.parse(await read('source/wiki.json')).version;
  assert.match(crew, /^0\.\d+\.\d+$/);
  assert.match(wiki, /^0\.\d+\.\d+$/);
  assert.equal(JSON.parse(await read('package.json')).version, wiki);
});

function frontmatter(text) {
  return text.split('\n---\n')[0];
}

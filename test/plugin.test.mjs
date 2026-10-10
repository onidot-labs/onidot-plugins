import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const readText = (path) => readFile(new URL(path, root), 'utf8');
const listDirs = async (path) => (await readdir(new URL(path, root), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const frontmatter = (markdown, key) => markdown.replace(/^---\n/, '').split('\n---')[0].split('\n').find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? '';
const SERVER_SKILLS = 'server-resources/wiki/skills/';

test('Claude 플러그인은 스킬만 제공하고 MCP는 계정 커넥터 또는 독립 설정에서 받는다', async () => {
  const dest = fileURLToPath(new URL('plugins/onidot/.mcp.json', root));
  await assert.rejects(readFile(dest), { code: 'ENOENT' });
  const claude = await readJson('plugins/onidot/.claude-plugin/plugin.json');
  assert.equal('mcpServers' in claude, false);
});

test('Codex와 Claude manifest는 같은 앱과 스킬을 제공하되 MCP는 연결별로 외부 등록한다', async () => {
  const source = await readJson('source/wiki.json');
  const pkg = await readJson('package.json');
  const codex = await readJson('plugins/onidot/.codex-plugin/plugin.json');
  const claude = await readJson('plugins/onidot/.claude-plugin/plugin.json');
  assert.equal(pkg.version, source.version);
  for (const manifest of [codex, claude]) {
    assert.equal(manifest.name, source.name);
    assert.equal(manifest.version, source.version);
    assert.equal(manifest.description, source.description);
    assert.deepEqual(await listDirs(`plugins/onidot/${manifest.skills}`), [...source.skills].sort());
    assert.equal(manifest.repository, 'https://github.com/onidot-labs/onidot-plugins');
  }
  assert.deepEqual(codex.mcpServers, {});
  assert.equal(await readText('plugins/onidot/scripts/oauth-helper.mjs'), await readText('source/runtime/oauth-helper.mjs'));
  assert.deepEqual(codex.interface.capabilities, ['Read', 'Write']);
});

test('Codex 연결 안내는 이전 설치의 invalid_target 원인과 복구 검사를 설명한다', async () => {
  const skill = await readText('source/skills/setup-onidot/SKILL.md');
  for (const required of ['invalid_target', 'codex plugin marketplace list', 'codex plugin marketplace remove onidot', 'codex plugin marketplace add', 'codex plugin add onidot@onidot', 'npm run verify:codex']) {
    assert.ok(skill.includes(required), required);
  }
});

test('스킬 원문의 frontmatter는 디렉터리 이름과 설명을 서버 리소스 메타데이터로 제공한다', async () => {
  const source = await readJson('source/wiki.json');
  for (const skill of source.skills) {
    const markdown = await readText(`source/skills/${skill}/SKILL.md`);
    assert.equal(frontmatter(markdown, 'name'), skill);
    assert.ok(frontmatter(markdown, 'description').length > 0, `${skill} description`);
  }
});

test('서버는 플러그인과 같은 스킬 원문을 MCP 리소스로 제공하도록 생성기가 vendoring한다', async () => {
  const source = await readJson('source/wiki.json');
  assert.deepEqual(await listDirs(SERVER_SKILLS), [...source.skills].sort());
  for (const skill of source.skills) {
    // 생성기는 원문의 {{version}}만 플러그인 버전으로 바꾼다.
    const expected = (await readText(`source/skills/${skill}/SKILL.md`)).replaceAll('{{version}}', source.version);
    assert.equal(await readText(`${SERVER_SKILLS}${skill}/SKILL.md`), expected, skill);
    assert.equal(await readText(`plugins/onidot/skills/${skill}/SKILL.md`), expected, skill);
  }
});

test('로컬 배포 카탈로그는 존재하는 Wiki와 crew만 참조한다', async () => {
  const codex = await readJson('.agents/plugins/marketplace.json');
  const claude = await readJson('.claude-plugin/marketplace.json');
  for (const marketplace of [codex, claude]) {
    assert.equal(marketplace.name, 'onidot');
    assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name), ['onidot', 'onidot-crew']);
  }
  assert.deepEqual(codex.plugins[0].source, { source: 'local', path: './plugins/onidot' });
  assert.equal(claude.plugins[0].source, './plugins/onidot');
});

test('저장소 루트 카탈로그는 GitHub 마켓플레이스 추가에서 같은 Wiki 플러그인을 가리킨다', async () => {
  const source = await readJson('source/wiki.json');
  const marketplace = await readJson('.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'onidot');
  assert.equal(marketplace.plugins.length, 2);
  assert.equal(marketplace.plugins[0].name, source.name);
  assert.equal(marketplace.plugins[0].version, source.version);
  assert.equal(marketplace.plugins[0].source, './plugins/onidot');
});

test('Wiki 스킬은 현재 초안·발행 및 권한 경계를 안내한다', async () => {
  const skill = await readFile(new URL('plugins/onidot/skills/use-onidot/SKILL.md', root), 'utf8');
  for (const required of ['list_spaces', 'get_page_draft', 'update_page_draft', 'publish_page', 'preview_page_change', 'draftVersion', 'Tasks', 'search_knowledge', 'grep_pages', 'read_page_excerpt', 'includeContent=false', 'incomplete', 'revisionId', '같은 H1으로 시작하지 않는다']) {
    assert.ok(skill.includes(required), required);
  }
  assert.ok(!skill.includes('createWikiPage'));
});

test('Wiki 스킬은 기존 문서 수정을 상태 조회 → 찾기 → 구간 읽기 → edit_page → 변경 요약 확인으로 안내한다', async () => {
  const skill = await readText('plugins/onidot/skills/use-onidot/SKILL.md');
  for (const required of ['상태 조회 → 찾기 → 필요한 구간 읽기 → edit_page → 변경 요약 확인', 'get_page_draft(includeContent=false)', 'hasUnpublishedChanges', 'replaceUniqueText', 'replaceAll=true', 'expectedMatches', 'append', 'setTitle', 'applied=false', 'newByteEnd', 'rangesTruncated', 'code=<CODE>', 'EDIT_TARGET_NOT_UNIQUE', 'REVISION_CONFLICT', 'UNRELATED_DRAFT_CHANGES', 'PAGE_NOT_PUBLISHED', 'UNNORMALIZED_ATTACHMENT_LINKS', 'responseMode=SUMMARY', 'get_page(includeContent=false)']) {
    assert.ok(skill.includes(required), required);
  }
  // 부분 수정 절차가 전체 저장 절차보다 먼저 나오고, 전체 저장은 새 문서·전체 교체용으로 구분한다.
  assert.ok(skill.indexOf('## 기존 문서 수정') >= 0 && skill.indexOf('## 기존 문서 수정') < skill.indexOf('## 새 문서·전체 교체와 임시 초안'));
});

test('Wiki 스킬은 키워드 관련성 검색의 정렬·호환 계약을 안내한다', async () => {
  const skill = await readFile(new URL('plugins/onidot/skills/use-onidot/SKILL.md', root), 'utf8');
  for (const required of ['raw literal', 'caseSensitive=true', 'caseSensitive=false', 'regex=true', 'sort="relevance"', 'sort="updated"', '정확한 제목·경로', '검증한 전체 문구', '어휘 관련성', '발행본 수정 시각', 'search_pages', '대소문자를 구분하지 않는 substring AND', '최신순 호환']) {
    assert.ok(skill.includes(required), required);
  }
  for (const removed of ['자연어', '표현이 다른', '의미 색인', '의미 확장', 'RRF']) assert.ok(!skill.includes(removed), removed);
});

test('연결 스킬은 커넥터 경로에서 서버 스킬 리소스를 안내하고 중복 등록을 막는다', async () => {
  const skill = await readText('plugins/onidot/skills/setup-onidot/SKILL.md');
  for (const required of ['MCP_URL', 'list_spaces', '사용자 지정 커넥터', 'skill://onidot/use-onidot/SKILL.md', 'Claude Code 클라우드', '중복 등록하지 않는다']) {
    assert.ok(skill.includes(required), required);
  }
});

test('연결 스킬은 옛 MCP 주소로 연결한 기존 등록을 자동 이전 대신 재연결 대상으로 안내한다', async () => {
  const skill = await readText('plugins/onidot/skills/setup-onidot/SKILL.md');
  for (const required of ['이전 주소', '재사용되지 않는다', '다시 연결']) {
    assert.ok(skill.includes(required), required);
  }
});

test('일반 작성 요청은 페이지 저장을 기본으로 하고 초안 보관은 명시적으로 구분한다', async () => {
  const codex = await readJson('plugins/onidot/.codex-plugin/plugin.json');
  assert.ok(codex.interface.defaultPrompt.some(prompt => prompt.includes('페이지로 저장')));
  assert.ok(codex.interface.defaultPrompt.every(prompt => !prompt.includes('초안')));
  const skill = await readFile(new URL('plugins/onidot/skills/use-onidot/SKILL.md', root), 'utf8');
  for (const required of ['save_page', 'expectedDraftVersion', 'expectedPublishedRevisionId', '별도의 발행 재확인을 요구하지 않는다', '초안으로만', 'get_page']) {
    assert.ok(skill.includes(required), required);
  }
});

test('Wiki 스킬은 제거된 Markdown 가져오기를 안내하지 않고 내보내기를 Space 소유자 전용으로 안내한다(옛 서버 #334)', async () => {
  const source = await readJson('source/wiki.json');
  for (const skill of source.skills) {
    const markdown = await readText(`source/skills/${skill}/SKILL.md`);
    for (const removed of ['preview_markdown_import', 'execute_markdown_import', 'get_import_status', '생성·이동·가져오기', '미리보기 계약']) {
      assert.ok(!markdown.includes(removed), `${skill}: ${removed}`);
    }
  }
  const skill = await readText('plugins/onidot/skills/use-onidot/SKILL.md');
  for (const required of ['가져오기 MCP 도구는 없다', '본문 전체를 바꾸는 요청은 위 `save_page` 전체 교체 절차', 'create_markdown_export', 'get_export_status', 'Space 소유자', 'scope="SPACE"', '페이지 첨부는 빠지고', 'includeDrafts=true', 'excludedPageAttachmentCount', 'excludedUnpublishedCount', 'job ID']) {
    assert.ok(skill.includes(required), required);
  }
});

test('Wiki 스킬은 요청자별 초안 계약을 안내한다(옛 서버 #337)', async () => {
  const skill = await readText('plugins/onidot/skills/use-onidot/SKILL.md');
  const lines = skill.split('\n');
  const lineWith = (marker) => {
    const found = lines.filter((line) => line.includes(marker));
    assert.equal(found.length, 1, marker);
    return found[0];
  };
  const section = (heading) => {
    const start = skill.indexOf(`## ${heading}\n`);
    assert.ok(start >= 0, heading);
    const next = skill.indexOf('\n## ', start + 3);
    return skill.slice(start, next < 0 ? undefined : next);
  };
  for (const removed of ['공동 초안', '다른 사람이 남긴 미발행 변경', '다른 작업자의 초안', '저장하지 않은 내 초안', 'currentPublishedRevisionId', '`basePublishedRevisionId`(현재 발행 Revision ID)를 `expectedPublishedRevisionId`로']) {
    assert.ok(!skill.includes(removed), removed);
  }
  for (const required of ['내 초안', '다른 사람의 초안은 보이지 않고', 'draftVersion=0', '가상 초안', 'expectedDraftVersion=0', '확인 없이']) {
    assert.ok(skill.includes(required), required);
  }
  // MCP 오류에는 Revision ID가 없으므로 현재 발행본을 조회하고, 사용자 확인 뒤에만 confirmStaleBase로 다시 발행한다.
  const stale = lineWith('`STALE_DRAFT_BASE`(409)로 실패');
  for (const required of ['publishedRevision.id', 'get_page_revision', '사용자가 덮어쓰기를 확인한 뒤에만', 'confirmStaleBase=true', '확인 없이']) assert.ok(stale.includes(required), required);
  // 기준이 밀린 내 초안은 현재 발행본으로 CAS하고 save_page로 그대로 저장하지 않는다.
  const current = lineWith('`expectedPublishedRevisionId`는 현재 발행 Revision ID다');
  for (const required of ['myDraft.stale', 'publishedRevision.id']) assert.ok(current.includes(required), required);
  assert.ok(lineWith('기준이 밀린 내 초안의 본문을 그대로 `save_page`로 저장하지 않는다').includes('사라진다'));
  // edit_page 절차는 남의 초안이 아니라 내 초안만 막는다고 안내한다.
  const editState = lineWith('1. **상태 조회**');
  for (const required of ['다른 사람의 초안은 `edit_page`를 막지 않는다', '발행하지 않은 내 초안', 'myDraft.stale']) assert.ok(editState.includes(required), required);
  // 초안이 없을 때 새 초안의 기준을 받는 도구마다 요약 절 밖의 실제 절차에서 basePublishedRevisionId 전달을 안내한다.
  const procedures = skill.replace(section('내 초안과 발행 기준'), '').split('\n');
  for (const tool of ['update_page_draft', 'restore_page_draft', 'add_page_attachment', 'commit_attachment_upload']) {
    assert.ok(procedures.some((line) => line.includes(tool) && line.includes('basePublishedRevisionId') && line.includes('draftVersion')), tool);
  }
  assert.ok(lineWith('`includeDrafts=true`는 요청자(소유자) 자신의 초안만').includes('초안 전체 백업이라고 보고하지 않는다'));
});

test('설치 안내의 Codex 캐시 경로는 현재 제품 버전을 가리킨다', async () => {
  const source = await readJson('source/wiki.json');
  for (const path of ['README.md', 'source/skills/setup-onidot/SKILL.md']) {
    const text = await readText(path);
    const versions = [...text.matchAll(/onidot\/(\d+\.\d+\.\d+)\/scripts/g)].map((match) => match[1]);
    assert.ok(versions.length > 0, path);
    assert.deepEqual([...new Set(versions)], [source.version], path);
  }
});

test('연결 스킬은 옛 주소 재연결·전용 오류 코드·마켓플레이스 갱신을 안내한다', async () => {
  const skill = await readText('plugins/onidot/skills/setup-onidot/SKILL.md');
  for (const required of ['이전 주소', 'OAUTH_RESOURCE_CHANGED_RELOGIN_REQUIRED', 'codex plugin marketplace upgrade onidot']) {
    assert.ok(skill.includes(required), required);
  }
});

test('Claude와 Codex는 command 시작 및 완료 훅을 클라이언트별로 제공한다', async () => {
  const claude = await readJson('plugins/onidot/.claude-plugin/plugin.json');
  const codex = await readJson('plugins/onidot/.codex-plugin/plugin.json');
  assert.equal(claude.hooks, './claude/hooks.json');
  assert.equal(codex.hooks, './codex/hooks.json');
  await assert.rejects(readFile(new URL('plugins/onidot/hooks/hooks.json', root)), { code: 'ENOENT' });
  const codexHooks = await readJson('plugins/onidot/codex/hooks.json');
  for (const event of ['SessionStart', 'Stop']) {
    const command = codexHooks.hooks[event][0].hooks[0];
    assert.equal(command.type, 'command');
    assert.ok(command.command.includes('PLUGIN_ROOT'));
  }
  assert.ok(codexHooks.hooks.Stop[0].hooks[0].command.includes('codex'));
  const hooks = await readJson('plugins/onidot/claude/hooks.json');
  const [entry] = hooks.hooks.SessionStart;
  assert.equal(entry.matcher, 'startup|resume|clear|compact');
  assert.equal(entry.hooks[0].type, 'command');
  assert.equal(entry.hooks[0].command, 'cat "${CLAUDE_PLUGIN_ROOT}/claude/session-start.json"');
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/recording-check.sh" claude');
  const output = await readJson('plugins/onidot/claude/session-start.json');
  const version = (await readJson('source/wiki.json')).version;
  assert.equal(await readText('plugins/onidot/claude/session-start.json'), (await readText('source/runtime/claude-session-start.json')).replaceAll('{{version}}', version));
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = output.hookSpecificOutput.additionalContext;
  for (const required of ['get_onidot_guide', 'onidot-guide', '로컬 지침', '적용 중인 지침', '기억', '개인 Space', '자체 메모리']) assert.ok(context.includes(required), required);
  // Space 선택 규칙은 서버 기본 지침에 있다. 시작 안내는 Space를 고르게 하지 않고 지침을 먼저 읽게 한다.
  for (const forbidden of ['list_spaces', '확인받']) assert.ok(!context.includes(forbidden), forbidden);
  assert.ok(context.length < 2000, `additionalContext ${context.length}자`);
});

test('onidot-guide 스킬은 기본 지침을 읽는 조건과 우선순위를 짧게 담는다', async () => {
  const skill = await readText('source/skills/onidot-guide/SKILL.md');
  const description = frontmatter(skill, 'description');
  for (const required of ['프로젝트', '이전 결정', '적용 중인 지침', '기억', '개인 Space']) assert.ok(description.includes(required), required);
  for (const required of ['get_onidot_guide', 'get_assistant_context', 'defaultGuide', 'use-onidot']) assert.ok(skill.includes(required), required);
  // 첫 단계는 Space 없이 기본 지침을 읽는 것이다. list_spaces는 이전 버전 서버용 대안으로만 남는다.
  const firstStep = skill.split('\n').find((line) => line.startsWith('1. '));
  assert.ok(firstStep.includes('get_onidot_guide'), firstStep);
  assert.ok(!skill.includes('확인받'), 'Space 확인 규칙은 서버 기본 지침에 둔다');
  assert.ok(skill.length < 3000, `skill ${skill.length}자`);
});

test('시작 안내와 onidot-guide 스킬은 설치된 플러그인 버전을 밝혀 AI가 최신 버전과 비교하게 한다', async () => {
  const { version } = await readJson('source/wiki.json');
  const notice = `onidot 플러그인 버전은 ${version}입니다`;
  for (const path of ['plugins/onidot/skills/onidot-guide/SKILL.md', `${SERVER_SKILLS}onidot-guide/SKILL.md`]) {
    const skill = await readText(path);
    assert.ok(skill.includes(notice), path);
    assert.ok(!skill.includes('{{version}}'), path);
  }
  const hook = (await readJson('plugins/onidot/claude/session-start.json')).hookSpecificOutput.additionalContext;
  assert.ok(hook.includes(notice), hook);
  for (const path of ['source/skills/onidot-guide/SKILL.md', 'source/runtime/claude-session-start.json']) {
    assert.ok((await readText(path)).includes('{{version}}'), path);
  }
  assert.ok((await readText('source/skills/onidot-guide/SKILL.md')).includes('updates'), '업데이트 정보 사용 안내');
});

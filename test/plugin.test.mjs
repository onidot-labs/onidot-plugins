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

test('Claude 플러그인은 원격 MCP를 선언하지 않는다: Claude는 claude.ai 커넥터로만 Wiki MCP를 받는다(이슈 #223)', async () => {
  const dest = fileURLToPath(new URL('plugins/doraft-wiki/.mcp.json', root));
  await assert.rejects(readFile(dest), { code: 'ENOENT' });
  const claude = await readJson('plugins/doraft-wiki/.claude-plugin/plugin.json');
  assert.equal('mcpServers' in claude, false);
});

test('Codex와 Claude manifest는 같은 앱과 스킬을 제공하되 MCP는 Codex만 인라인으로 선언한다', async () => {
  const source = await readJson('source/wiki.json');
  const pkg = await readJson('package.json');
  const codex = await readJson('plugins/doraft-wiki/.codex-plugin/plugin.json');
  const claude = await readJson('plugins/doraft-wiki/.claude-plugin/plugin.json');
  assert.equal(pkg.version, source.version);
  for (const manifest of [codex, claude]) {
    assert.equal(manifest.name, source.name);
    assert.equal(manifest.version, source.version);
    assert.equal(manifest.description, source.description);
    assert.deepEqual(await listDirs(`plugins/doraft-wiki/${manifest.skills}`), [...source.skills].sort());
    assert.equal(manifest.repository, 'https://github.com/doraft-labs/doraft-plugins');
  }
  assert.deepEqual(codex.mcpServers, { 'doraft-wiki': { type: 'http', url: source.endpoint } });
  assert.deepEqual(codex.interface.capabilities, ['Read', 'Write']);
});

test('Codex 연결 안내는 이전 설치의 invalid_target 원인과 복구 검사를 설명한다', async () => {
  const skill = await readText('source/skills/setup-doraft-wiki/SKILL.md');
  for (const required of ['invalid_target', 'codex plugin marketplace list', 'codex plugin marketplace remove doraft', 'codex plugin marketplace add', 'codex plugin add doraft-wiki@doraft', 'npm run verify:codex']) {
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
    assert.equal(await readText(`${SERVER_SKILLS}${skill}/SKILL.md`), await readText(`source/skills/${skill}/SKILL.md`), skill);
    assert.equal(await readText(`plugins/doraft-wiki/skills/${skill}/SKILL.md`), await readText(`source/skills/${skill}/SKILL.md`), skill);
  }
});

test('로컬 배포 카탈로그는 존재하는 Wiki만 참조한다', async () => {
  const codex = await readJson('.agents/plugins/marketplace.json');
  const claude = await readJson('.claude-plugin/marketplace.json');
  for (const marketplace of [codex, claude]) {
    assert.equal(marketplace.name, 'doraft');
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, 'doraft-wiki');
  }
  assert.deepEqual(codex.plugins[0].source, { source: 'local', path: './plugins/doraft-wiki' });
  assert.equal(claude.plugins[0].source, './plugins/doraft-wiki');
});

test('저장소 루트 카탈로그는 GitHub 마켓플레이스 추가에서 같은 Wiki 플러그인을 가리킨다', async () => {
  const source = await readJson('source/wiki.json');
  const marketplace = await readJson('.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'doraft');
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, source.name);
  assert.equal(marketplace.plugins[0].version, source.version);
  assert.equal(marketplace.plugins[0].source, './plugins/doraft-wiki');
});

test('Wiki 스킬은 현재 초안·발행 및 권한 경계를 안내한다', async () => {
  const skill = await readFile(new URL('plugins/doraft-wiki/skills/use-doraft-wiki/SKILL.md', root), 'utf8');
  for (const required of ['list_workspaces', 'get_page_draft', 'update_page_draft', 'publish_page', 'preview_page_change', 'draftVersion', 'Tasks', 'search_knowledge', 'grep_pages', 'read_page_excerpt', 'includeContent=false', 'incomplete', 'revisionId', '같은 H1으로 시작하지 않는다']) {
    assert.ok(skill.includes(required), required);
  }
  assert.ok(!skill.includes('createWikiPage'));
});

test('Wiki 스킬은 기존 문서 수정을 상태 조회 → 찾기 → 구간 읽기 → edit_page → 변경 요약 확인으로 안내한다', async () => {
  const skill = await readText('plugins/doraft-wiki/skills/use-doraft-wiki/SKILL.md');
  for (const required of ['상태 조회 → 찾기 → 필요한 구간 읽기 → edit_page → 변경 요약 확인', 'get_page_draft(includeContent=false)', 'hasUnpublishedChanges', 'replaceUniqueText', 'replaceAll=true', 'expectedMatches', 'append', 'setTitle', 'applied=false', 'newByteEnd', 'rangesTruncated', 'code=<CODE>', 'EDIT_TARGET_NOT_UNIQUE', 'REVISION_CONFLICT', 'UNRELATED_DRAFT_CHANGES', 'PAGE_NOT_PUBLISHED', 'UNNORMALIZED_ATTACHMENT_LINKS', 'responseMode=SUMMARY', 'get_page(includeContent=false)']) {
    assert.ok(skill.includes(required), required);
  }
  // 부분 수정 절차가 전체 저장 절차보다 먼저 나오고, 전체 저장은 새 문서·전체 교체용으로 구분한다.
  assert.ok(skill.indexOf('## 기존 문서 수정') >= 0 && skill.indexOf('## 기존 문서 수정') < skill.indexOf('## 새 문서·전체 교체와 임시 초안'));
});

test('Wiki 스킬은 키워드 관련성 검색의 정렬·호환 계약을 안내한다', async () => {
  const skill = await readFile(new URL('plugins/doraft-wiki/skills/use-doraft-wiki/SKILL.md', root), 'utf8');
  for (const required of ['raw literal', 'caseSensitive=true', 'caseSensitive=false', 'regex=true', 'sort="relevance"', 'sort="updated"', '정확한 제목·경로', '검증한 전체 문구', '어휘 관련성', '발행본 수정 시각', 'search_pages', '대소문자를 구분하지 않는 substring AND', '최신순 호환']) {
    assert.ok(skill.includes(required), required);
  }
  for (const removed of ['자연어', '표현이 다른', '의미 색인', '의미 확장', 'RRF']) assert.ok(!skill.includes(removed), removed);
});

test('연결 스킬은 커넥터 경로에서 서버 스킬 리소스를 안내하고 중복 등록을 막는다', async () => {
  const skill = await readText('plugins/doraft-wiki/skills/setup-doraft-wiki/SKILL.md');
  for (const required of ['https://mcp.doraft.com/wiki', 'list_workspaces', '사용자 지정 커넥터', 'skill://doraft/<skill>/SKILL.md', 'Claude Code 클라우드', '중복 등록하지 않는다']) {
    assert.ok(skill.includes(required), required);
  }
});

test('연결 스킬은 옛 MCP 주소로 연결한 기존 등록을 자동 이전 대신 재연결 대상으로 안내한다', async () => {
  const skill = await readText('plugins/doraft-wiki/skills/setup-doraft-wiki/SKILL.md');
  for (const required of ['https://api.doraft.com/mcp/wiki', 'https://api.doraft.com/mcp', '재사용되지 않는다', '다시 연결']) {
    assert.ok(skill.includes(required), required);
  }
});

test('일반 작성 요청은 페이지 저장을 기본으로 하고 초안 보관은 명시적으로 구분한다', async () => {
  const codex = await readJson('plugins/doraft-wiki/.codex-plugin/plugin.json');
  assert.ok(codex.interface.defaultPrompt.some(prompt => prompt.includes('페이지로 저장')));
  assert.ok(codex.interface.defaultPrompt.every(prompt => !prompt.includes('초안')));
  const skill = await readFile(new URL('plugins/doraft-wiki/skills/use-doraft-wiki/SKILL.md', root), 'utf8');
  for (const required of ['save_page', 'expectedDraftVersion', 'expectedPublishedRevisionId', '별도의 발행 재확인을 요구하지 않는다', '초안으로만', 'get_page']) {
    assert.ok(skill.includes(required), required);
  }
});

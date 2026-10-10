import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const json = async (path) => JSON.parse(await read(path));
const exists = (path) => readFile(new URL(path, root)).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; });
const BASE = 'plugins/onidot-crew/';

// front matter를 키·값 쌍과 YAML 목록으로 읽는다. 생성기가 쓰는 단순 형식만 다룬다.
const parseFrontMatter = (markdown) => {
  assert.ok(markdown.startsWith('---\n'));
  const end = markdown.indexOf('\n---\n\n', 4);
  assert.ok(end > 0, 'front matter 뒤 빈 줄');
  const fields = {};
  let list = null;
  for (const line of markdown.slice(4, end).split('\n')) {
    if (line.startsWith('  - ')) { fields[list].push(line.slice(4)); continue; }
    const at = line.indexOf(':');
    const key = line.slice(0, at), value = line.slice(at + 1).trim();
    if (value === '') { fields[key] = []; list = key; } else fields[key] = value.startsWith('"') ? JSON.parse(value) : value;
  }
  return { fields, body: markdown.slice(end + 6) };
};

test('crew manifest는 Wiki와 같은 모양이며 MCP·서버 반입·스크립트를 두지 않는다', async () => {
  const source = await json('source/crew.json');
  assert.equal(source.name, 'onidot-crew');
  assert.equal(source.version, '0.1.0');
  assert.equal(source.displayName, 'onidot crew');
  const claude = await json(`${BASE}.claude-plugin/plugin.json`);
  const codex = await json(`${BASE}.codex-plugin/plugin.json`);
  for (const manifest of [claude, codex]) {
    assert.equal(manifest.name, 'onidot-crew');
    assert.equal(manifest.version, '0.1.0');
    assert.equal(manifest.skills, './skills/');
  }
  assert.equal(claude.hooks, './claude/hooks.json');
  assert.equal('mcpServers' in claude, false);
  assert.deepEqual(codex.mcpServers, {});
  assert.equal(codex.hooks, './codex/hooks.json');
  assert.equal(codex.interface.displayName, 'onidot crew');
  assert.deepEqual(codex.interface.defaultPrompt, source.defaultPrompt);
  assert.equal(await exists('server-resources/crew/manifest.json'), false);
  assert.deepEqual(await readdir(new URL('server-resources/', root)), ['wiki']);
  assert.equal(await exists(`${BASE}scripts/recording-check.sh`), false);
  assert.equal(await exists(`${BASE}.mcp.json`), false);
});

test('crew 스킬 14개는 원본과 같고 front matter를 가진다', async () => {
  const source = await json('source/crew.json');
  assert.deepEqual(source.skills, ['plan', 'run', 'research', 'verify', 'resume', 'delegate', 'explore-domain', 'spec-first', 'tdd', 'debugging', 'review-work', 'frontend', 'plain-writing', 'setup-crew']);
  const dirs = (await readdir(new URL(`${BASE}skills/`, root))).sort();
  assert.deepEqual(dirs, [...source.skills].sort());
  for (const skill of source.skills) {
    const markdown = await read(`${BASE}skills/${skill}/SKILL.md`);
    assert.equal(markdown, (await read(`source/crew/skills/${skill}/SKILL.md`)).replaceAll('{{version}}', source.version));
    const { fields } = parseFrontMatter(markdown);
    assert.equal(fields.name, skill);
    assert.ok(fields.description.length > 0, skill);
  }
});

// 역할 본문 뒤에 모든 역할의 공통 규칙이 한 번 붙는다.
const expectedBody = async (id) =>
  [(await read(`source/crew/agents/${id}.md`)).trim(), (await read('source/crew/agents-common.md')).trim()].join('\n\n') + '\n';

test('Claude 서브에이전트는 원본 메타데이터대로 front matter와 본문을 가진다', async () => {
  const source = await json('source/crew.json');
  assert.equal(source.agents.length, 17);
  assert.deepEqual((await readdir(new URL(`${BASE}agents/`, root))).sort(), source.agents.map((a) => `${a.id}.md`).sort());
  for (const agent of source.agents) {
    const { fields, body } = parseFrontMatter(await read(`${BASE}agents/${agent.id}.md`));
    assert.equal(fields.name, agent.id);
    assert.equal(fields.description, agent.description);
    assert.equal(fields.model, agent.claude.model);
    assert.equal(fields.effort, agent.claude.effort);
    assert.equal(fields.tools, agent.claude.tools?.join(', '));
    assert.equal(fields.disallowedTools, agent.claude.disallowedTools?.join(', '));
    assert.deepEqual(fields.skills, agent.claude.skills);
    assert.ok(!('tools' in fields && 'disallowedTools' in fields), agent.id);
    assert.equal(body, await expectedBody(agent.id));
  }
  const scoper = parseFrontMatter(await read(`${BASE}agents/scoper.md`)).fields;
  assert.equal(scoper.disallowedTools, 'Write, Edit, NotebookEdit, Agent');
  assert.deepEqual(scoper.skills, ['explore-domain']);
  assert.equal(parseFrontMatter(await read(`${BASE}agents/explorer.md`)).fields.tools, 'Read, Grep, Glob, Bash');
  for (const agent of source.agents)
    assert.equal((await read(`${BASE}agents/${agent.id}.md`)).split('## 공통 규칙').length, 2, agent.id);
});

test('Codex 에이전트 TOML은 모델을 상속하고 본문을 삼중 따옴표 리터럴로 담는다', async () => {
  const source = await json('source/crew.json');
  assert.deepEqual((await readdir(new URL(`${BASE}codex/agents/`, root))).sort(), source.agents.map((a) => `crew-${a.id}.toml`).sort());
  for (const agent of source.agents) {
    const toml = await read(`${BASE}codex/agents/crew-${agent.id}.toml`);
    const head = toml.slice(0, toml.indexOf("developer_instructions = '''\n"));
    assert.equal(head, [`name = "crew-${agent.id}"`, `description = ${JSON.stringify(agent.description)}`,
      `model_reasoning_effort = "${agent.codex.reasoningEffort}"`, `sandbox_mode = "${agent.codex.sandboxMode}"`, ''].join('\n'));
    assert.doesNotMatch(toml, /^model\s*=/m);
    const body = await expectedBody(agent.id);
    assert.ok(toml.endsWith(`developer_instructions = '''\n${body}'''\n`), agent.id);
    assert.equal(toml.split("'''").length, 3, agent.id);
  }
});

test('crew 훅은 SessionStart 안내만 두고 Stop 훅을 두지 않는다', async () => {
  const claude = (await json(`${BASE}claude/hooks.json`)).hooks;
  const codex = (await json(`${BASE}codex/hooks.json`)).hooks;
  assert.deepEqual(Object.keys(claude), ['SessionStart']);
  assert.deepEqual(Object.keys(codex), ['SessionStart']);
  assert.equal(claude.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.equal(claude.SessionStart[0].hooks[0].command, 'cat "${CLAUDE_PLUGIN_ROOT}/claude/session-start.json"');
  assert.equal(codex.SessionStart[0].hooks[0].command, 'cat "${PLUGIN_ROOT}/claude/session-start.json"');
  const context = await json(`${BASE}claude/session-start.json`);
  assert.equal(context.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(context.hookSpecificOutput.additionalContext.includes('0.1.0'));
  assert.ok(!context.hookSpecificOutput.additionalContext.includes('{{version}}'));
});

test('두 marketplace와 catalog는 onidot과 onidot-crew를 함께 싣는다', async () => {
  const codex = await json('.agents/plugins/marketplace.json');
  const claude = await json('.claude-plugin/marketplace.json');
  assert.deepEqual(codex.plugins.find((p) => p.name === 'onidot-crew').source, { source: 'local', path: './plugins/onidot-crew' });
  const entry = claude.plugins.find((p) => p.name === 'onidot-crew');
  assert.equal(entry.source, './plugins/onidot-crew');
  assert.equal(entry.version, '0.1.0');
  assert.deepEqual((await json('catalog.json')).products.find((p) => p.id === 'crew'),
    { id: 'crew', name: 'onidot-crew', displayName: 'onidot crew', version: '0.1.0' });
});

// 원본 복사본에서 생성기를 돌려 잘못된 crew 정의를 생성 전에 거부하는지 본다.
const generateWith = async (mutate) => {
  const temp = await mkdtemp(join(tmpdir(), 'onidot-crew-test-'));
  try {
    for (const path of ['scripts', 'source']) await cp(new URL(path + '/', root), join(temp, path), { recursive: true });
    const crew = JSON.parse(await readFile(join(temp, 'source/crew.json'), 'utf8'));
    await mutate(crew, temp);
    await writeFile(join(temp, 'source/crew.json'), JSON.stringify(crew));
    const result = spawnSync(process.execPath, ['scripts/generate.mjs'], { cwd: temp, encoding: 'utf8' });
    const plugins = await readdir(join(temp, 'plugins')).catch(() => []);
    return { ...result, plugins };
  } finally { await rm(temp, { recursive: true, force: true }); }
};

test('잘못된 crew 에이전트 정의는 아무것도 쓰기 전에 거부한다', async () => {
  const agent = (crew, id) => crew.agents.find((a) => a.id === id);
  const cases = [
    [(crew) => { agent(crew, 'scoper').claude.model = 'gpt'; }, /scoper claude\.model/],
    [(crew) => { agent(crew, 'worker').claude.skills = ['missing-skill']; }, /worker claude\.skills/],
    [(crew, temp) => writeFile(join(temp, 'source/crew/agents/writer.md'), "본문\n'''\n끝\n"), /writer body contains '''/],
    [(crew) => { agent(crew, 'explorer').claude.disallowedTools = ['Bash']; }, /explorer tools and disallowedTools/],
    [(crew) => { agent(crew, 'gate').codex.sandboxMode = 'danger-full-access'; }, /gate codex\.sandboxMode/],
    [(crew) => { agent(crew, 'gate').codex.reasoningEffort = 'max'; }, /gate codex\.reasoningEffort/],
    [(crew) => { agent(crew, 'qa').claude.effort = 'extreme'; }, /qa claude\.effort/],
    [(crew) => { agent(crew, 'qa').description = ' '; }, /qa description/],
    [(crew) => { crew.agents.push({ ...agent(crew, 'qa') }); }, /id qa/],
    [(crew) => { agent(crew, 'qa').id = 'QA'; }, /id QA/],
    [(crew) => { agent(crew, 'mapper').claude.tools = 'Read'; }, /mapper claude\.tools/],
    [(crew, temp) => rm(join(temp, 'source/crew/agents/advisor.md')), /advisor body missing/],
    [(crew, temp) => writeFile(join(temp, 'source/crew/agents/advisor.md'), '\n  \n'), /advisor body empty/],
  ];
  for (const [mutate, message] of cases) {
    const result = await generateWith(mutate);
    assert.notEqual(result.status, 0, String(message));
    assert.match(result.stderr, message);
    assert.deepEqual(result.plugins, [], String(message));
  }
});

test('crew 본문이 가리키는 스킬과 역할은 모두 존재하고 세션 안내는 짧다', async () => {
  const source = await json('source/crew.json');
  const skills = new Set(source.skills), roles = new Set(source.agents.map((a) => a.id));
  const texts = [];
  for (const skill of source.skills) texts.push([`skill ${skill}`, await read(`source/crew/skills/${skill}/SKILL.md`)]);
  for (const agent of source.agents) texts.push([`agent ${agent.id}`, await read(`source/crew/agents/${agent.id}.md`)]);
  for (const [label, text] of texts) {
    for (const [, name] of text.matchAll(/\b([a-z][a-z-]*[a-z]) 스킬/g)) assert.ok(skills.has(name), `${label}: 없는 스킬 ${name}`);
    for (const [, name] of text.matchAll(/onidot-crew:([a-z][a-z-]*)/g)) assert.ok(roles.has(name) || skills.has(name), `${label}: 없는 이름 ${name}`);
  }
  const start = await read('source/crew/runtime/session-start.json');
  assert.ok(Buffer.byteLength(start) <= 3000, `세션 안내 ${Buffer.byteLength(start)} bytes`);
  const context = JSON.parse(start).hookSpecificOutput.additionalContext;
  for (const role of roles) assert.ok(context.includes(role), `세션 안내에 역할 ${role} 없음`);
});

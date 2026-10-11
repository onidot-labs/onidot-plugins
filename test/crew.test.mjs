import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const json = async (path) => JSON.parse(await read(path));
const exists = (path) => readFile(new URL(path, root)).then(() => true, (e) => { if (e.code === 'ENOENT') return false; throw e; });
const BASE = 'plugins/onidot-crew/';

// 스킬 원본의 front matter에서 한 줄짜리 키 값을 읽는다.
const frontLine = (markdown, key) => {
  assert.ok(markdown.startsWith('---\n'));
  const end = markdown.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'front matter 끝');
  return markdown.slice(4, end).split('\n').find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2);
};
// 생성된 서브에이전트 파일을 front matter 줄 목록과 본문으로 나눈다.
const splitAgent = (markdown) => {
  assert.ok(markdown.startsWith('---\n'));
  const end = markdown.indexOf('\n---\n\n', 4);
  assert.ok(end > 0, 'front matter 뒤 빈 줄');
  return { front: markdown.slice(4, end).split('\n'), body: markdown.slice(end + 6) };
};

test('crew manifest는 Wiki와 같은 모양이며 MCP·서버 반입·완료 기록 검사를 두지 않는다', async () => {
  const source = await json('source/crew.json');
  assert.equal(source.name, 'onidot-crew');
  assert.equal(source.version, '0.3.0');
  assert.equal(source.displayName, 'onidot crew');
  const claude = await json(`${BASE}.claude-plugin/plugin.json`);
  const codex = await json(`${BASE}.codex-plugin/plugin.json`);
  for (const manifest of [claude, codex]) {
    assert.equal(manifest.name, 'onidot-crew');
    assert.equal(manifest.version, '0.3.0');
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

test('crew 스킬 15개는 원본과 같고 front matter를 가진다', async () => {
  const source = await json('source/crew.json');
  assert.deepEqual(source.skills, ['plan', 'run', 'research', 'verify', 'resume', 'work-record', 'delegate', 'explore-domain', 'spec-first', 'tdd', 'debugging', 'review-work', 'frontend', 'plain-writing', 'setup-crew']);
  const dirs = (await readdir(new URL(`${BASE}skills/`, root))).sort();
  assert.deepEqual(dirs, [...source.skills].sort());
  for (const skill of source.skills) {
    const markdown = await read(`${BASE}skills/${skill}/SKILL.md`);
    assert.equal(markdown, (await read(`source/crew/skills/${skill}/SKILL.md`)).replaceAll('{{version}}', source.version));
    assert.equal(frontLine(markdown, 'name'), skill);
    assert.ok(frontLine(markdown, 'description')?.length > 0, skill);
  }
});

// 역할 본문 뒤에 모든 역할의 공통 규칙이 한 번 붙는다.
const expectedBody = async (id) =>
  [(await read(`source/crew/agents/${id}.md`)).trim(), (await read('source/crew/agents-common.md')).trim()].join('\n\n') + '\n';

test('Claude 서브에이전트는 원본 메타데이터대로 front matter와 본문을 가진다', async () => {
  const source = await json('source/crew.json');
  assert.equal(source.agents.length, 17);
  assert.deepEqual((await readdir(new URL(`${BASE}agents/`, root))).sort(), [...source.agents.map((a) => a.id), source.main.id].map((id) => `${id}.md`).sort());
  for (const agent of source.agents) {
    const { front, body } = splitAgent(await read(`${BASE}agents/${agent.id}.md`));
    const { claude } = agent;
    assert.ok(claude.tools || claude.disallowedTools, agent.id);
    assert.ok(!(claude.tools && claude.disallowedTools), agent.id);
    // description은 항상 큰따옴표 스칼라다. JSON 문자열은 YAML 큰따옴표 스칼라로도 같은 값이다.
    const description = front[1].match(/^description: (".*")$/);
    assert.ok(description, `${agent.id}: description은 큰따옴표로 감싼다`);
    assert.equal(JSON.parse(description[1]), agent.description);
    // 스킬은 플러그인 이름으로 한정해 사용자·프로젝트의 같은 이름 스킬이 먼저 잡히지 않게 한다.
    assert.deepEqual(front, [`name: ${agent.id}`, `description: ${JSON.stringify(agent.description)}`,
      `model: ${claude.model}`, `effort: ${claude.effort}`,
      ...(claude.tools ? [`tools: ${claude.tools.join(', ')}`] : []),
      ...(claude.disallowedTools ? [`disallowedTools: ${claude.disallowedTools.join(', ')}`] : []),
      ...(claude.skills?.length ? ['skills:', ...claude.skills.map((s) => `  - onidot-crew:${s}`)] : [])], agent.id);
    assert.equal(body, await expectedBody(agent.id));
  }
  const scoper = splitAgent(await read(`${BASE}agents/scoper.md`)).front;
  assert.ok(scoper.includes('disallowedTools: Write, Edit, NotebookEdit, Agent'));
  assert.deepEqual(scoper.slice(-2), ['skills:', '  - onidot-crew:explore-domain']);
  assert.ok(splitAgent(await read(`${BASE}agents/explorer.md`)).front.includes('tools: Read, Grep, Glob, Bash'));
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

test('리더 에이전트는 모델·도구를 상속하고 settings.json이 메인 스레드로 지정한다', async () => {
  const source = await json('source/crew.json');
  assert.deepEqual(source.main, { id: 'lead', description: 'onidot crew의 리더. 사용자와 대화하며 일을 판단하고 계획·위임·검증을 이끈다.' });
  assert.deepEqual(await json(`${BASE}settings.json`), { agent: 'lead' });
  const { front, body } = splitAgent(await read(`${BASE}agents/lead.md`));
  assert.deepEqual(front, ['name: lead', `description: ${JSON.stringify(source.main.description)}`]);
  for (const key of ['model', 'effort', 'tools', 'disallowedTools', 'skills']) assert.equal(frontLine(`---\n${front.join('\n')}\n---\n`, key), undefined, key);
  assert.equal(body, (await read('source/crew/main/lead.md')).trim() + '\n');
  assert.equal(body.includes('## 공통 규칙'), false);
  assert.equal(await exists(`${BASE}codex/agents/crew-lead.toml`), false);
  assert.equal((await readdir(new URL(`${BASE}codex/agents/`, root))).length, 17);
});

test('crew의 Claude 훅은 흐름 대기열 훅 셋뿐이고 Codex는 SessionStart 훅 하나만 둔다', async () => {
  // 리더 에이전트가 세션 안내를 맡으므로 Claude에는 SessionStart가 없다.
  assert.deepEqual(await readdir(new URL(`${BASE}claude/`, root)), ['hooks.json']);
  const flow = (event) => [{ type: 'command', command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/flow-queue.mjs" hook ${event} 2>/dev/null || true` }];
  assert.deepEqual(await json(`${BASE}claude/hooks.json`), { hooks: {
    SubagentStart: [{ hooks: flow('subagent-start') }],
    SubagentStop: [{ hooks: flow('subagent-stop') }],
    // 실제 Claude Code 2.1.284에서 서브에이전트 도구의 tool_name은 Agent다. 2.1.63 전 이름은 Task다.
    PostToolUse: [{ matcher: 'Agent|Task', hooks: flow('post-agent') }] } });
  assert.equal(await read(`${BASE}scripts/flow-queue.mjs`), await read('source/crew/runtime/flow-queue.mjs'));
  const codex = (await json(`${BASE}codex/hooks.json`)).hooks;
  assert.deepEqual(Object.keys(codex), ['SessionStart']);
  assert.equal(codex.SessionStart.length, 1);
  assert.equal(codex.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.equal(codex.SessionStart[0].hooks.length, 1);
  assert.equal(codex.SessionStart[0].hooks[0].command, 'cat "${PLUGIN_ROOT}/codex/session-start.json"');
  const context = await json(`${BASE}codex/session-start.json`);
  assert.equal(context.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(context.hookSpecificOutput.additionalContext.includes('0.3.0'));
  assert.ok(!context.hookSpecificOutput.additionalContext.includes('{{version}}'));
});

test('두 marketplace와 catalog는 onidot과 onidot-crew를 함께 싣는다', async () => {
  const codex = await json('.agents/plugins/marketplace.json');
  const claude = await json('.claude-plugin/marketplace.json');
  assert.deepEqual(codex.plugins.find((p) => p.name === 'onidot-crew').source, { source: 'local', path: './plugins/onidot-crew' });
  const entry = claude.plugins.find((p) => p.name === 'onidot-crew');
  assert.equal(entry.source, './plugins/onidot-crew');
  assert.equal(entry.version, '0.3.0');
  assert.deepEqual((await json('catalog.json')).products.find((p) => p.id === 'crew'),
    { id: 'crew', name: 'onidot-crew', displayName: 'onidot crew', version: '0.3.0' });
});

// 원본 복사본에서 생성기를 돌려 잘못된 crew 정의를 생성 전에 거부하는지 본다.
const copyRepo = async () => {
  const temp = await mkdtemp(join(tmpdir(), 'onidot-crew-test-'));
  for (const path of ['scripts', 'source']) await cp(new URL(path + '/', root), join(temp, path), { recursive: true });
  return temp;
};
const runGenerate = (temp, ...args) => spawnSync(process.execPath, ['scripts/generate.mjs', ...args], { cwd: temp, encoding: 'utf8' });
const editCrew = async (temp, mutate) => {
  const crew = JSON.parse(await readFile(join(temp, 'source/crew.json'), 'utf8'));
  await mutate(crew, temp);
  await writeFile(join(temp, 'source/crew.json'), JSON.stringify(crew));
};
const generateWith = async (mutate) => {
  const temp = await copyRepo();
  try {
    await editCrew(temp, mutate);
    const result = runGenerate(temp);
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
    // TOML에서 무효가 되는 제어 문자와 고립 서로게이트는 description에 받지 않는다.
    [(crew) => { agent(crew, 'qa').description = '줄\n바꿈'; }, /qa description/],
    [(crew) => { agent(crew, 'qa').description = '탭\t문자'; }, /qa description/],
    [(crew) => { agent(crew, 'qa').description = '삭제\x7f문자'; }, /qa description/],
    [(crew) => { agent(crew, 'qa').description = '고립 \ud800 서로게이트'; }, /qa description/],
    // 권한 키 오타는 권한이 조용히 빠지는 대신 거부한다.
    [(crew) => { const c = agent(crew, 'scoper').claude; c.disallowedtools = c.disallowedTools; delete c.disallowedTools; }, /scoper claude unknown key disallowedtools/],
    [(crew) => { agent(crew, 'gate').codex.sandbox_mode = 'read-only'; }, /gate codex unknown key sandbox_mode/],
    [(crew) => { agent(crew, 'gate').model = 'opus'; }, /gate agent unknown key model/],
    [(crew) => { delete agent(crew, 'advisor').claude.disallowedTools; }, /advisor claude\.tools or claude\.disallowedTools required/],
    // read-only 역할은 Claude 쪽에서도 쓰기 도구가 막혀야 한다.
    [(crew) => { agent(crew, 'gate').claude.tools.push('Edit'); }, /gate read-only role must not allow Edit/],
    [(crew) => { agent(crew, 'scoper').claude.disallowedTools = ['Write', 'Agent']; }, /scoper read-only role must disallow Edit, NotebookEdit/],
    // 리더(main) 정의 검증.
    [(crew) => { crew.main.model = 'opus'; }, /Invalid main: unknown key model/],
    [(crew) => { crew.main.id = 'qa'; }, /Invalid main: id qa duplicates a role/],
    [(crew) => { crew.main.id = 'Lead'; }, /Invalid main: id Lead/],
    [(crew) => { crew.main.description = '줄\n바꿈'; }, /Invalid main: description/],
    [(crew) => { crew.main.description = '고립 \ud800 서로게이트'; }, /Invalid main: description/],
    [(crew, temp) => writeFile(join(temp, 'source/crew/main/lead.md'), '\n \n'), /Invalid main: body empty/],
    [(crew, temp) => writeFile(join(temp, 'source/crew/main/lead.md'), "본문\n'''\n"), /Invalid main: body contains '''/],
    [(crew, temp) => rm(join(temp, 'source/crew/main/lead.md')), /Invalid main: body missing/],
  ];
  for (const [mutate, message] of cases) {
    const result = await generateWith(mutate);
    assert.notEqual(result.status, 0, String(message));
    assert.match(result.stderr, message);
    assert.deepEqual(result.plugins, [], String(message));
  }
});

test('생성 목록에서 빠진 crew 생성물은 generate가 지우고 --check가 보고한다', async () => {
  const temp = await copyRepo();
  try {
    assert.equal(runGenerate(temp).status, 0);
    const crewDir = join(temp, 'plugins/onidot-crew');
    const snapshot = async (dir) => {
      const out = {};
      for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }))
        if (entry.isFile()) { const path = join(entry.parentPath, entry.name); out[path] = await readFile(path, 'utf8'); }
      return out;
    };
    const wikiBefore = await snapshot(join(temp, 'plugins/onidot'));
    // 역할 하나를 지우고, 생성 목록에 없는 디렉터리·파일도 남겨 둔다.
    await editCrew(temp, (crew) => { crew.agents = crew.agents.filter((a) => a.id !== 'writer'); });
    await rm(join(temp, 'source/crew/agents/writer.md'));
    await mkdir(join(crewDir, 'skills/retired-skill'), { recursive: true });
    await writeFile(join(crewDir, 'skills/retired-skill/SKILL.md'), 'old\n');
    await writeFile(join(crewDir, 'skills/plan/extra.md'), 'old\n');
    // claude/에는 흐름 훅 설정만 생성된다. 옛 세션 안내 파일은 남은 생성물로 지운다.
    await writeFile(join(crewDir, 'claude/hooks.json'), '{}\n');
    await writeFile(join(crewDir, 'claude/session-start.json'), '{}\n');
    const check = runGenerate(temp, '--check');
    assert.equal(check.status, 1);
    assert.match(check.stderr, /재생성 필요: plugins\/onidot-crew\/claude\/hooks.json\n/);
    for (const path of ['agents/writer.md', 'claude/session-start.json', 'codex/agents/crew-writer.toml', 'skills/retired-skill', 'skills/plan/extra.md'])
      assert.ok(check.stderr.includes(`남은 생성물: plugins/onidot-crew/${path}\n`), `${path}\n${check.stderr}`);
    assert.equal(runGenerate(temp).status, 0);
    assert.deepEqual(await readdir(join(crewDir, 'claude')), ['hooks.json']);
    assert.ok(JSON.parse(await readFile(join(crewDir, 'claude/hooks.json'), 'utf8')).hooks.SubagentStart);
    assert.equal((await readdir(join(crewDir, 'agents'))).includes('writer.md'), false);
    assert.equal((await readdir(join(crewDir, 'agents'))).length, 17);
    assert.equal((await readdir(join(crewDir, 'codex/agents'))).includes('crew-writer.toml'), false);
    assert.equal((await readdir(join(crewDir, 'skills'))).includes('retired-skill'), false);
    assert.deepEqual(await readdir(join(crewDir, 'skills/plan')), ['SKILL.md']);
    assert.deepEqual(await snapshot(join(temp, 'plugins/onidot')), wikiBefore);
    const clean = runGenerate(temp, '--check');
    assert.equal(clean.status, 0, clean.stderr);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('crew 본문이 가리키는 스킬과 역할은 모두 존재하고 세션 안내는 짧다', async () => {
  const source = await json('source/crew.json');
  const skills = new Set(source.skills), roles = new Set(source.agents.map((a) => a.id));
  const texts = [], addressed = [];
  for (const skill of source.skills) texts.push([`skill ${skill}`, await read(`source/crew/skills/${skill}/SKILL.md`)]);
  for (const agent of source.agents) texts.push([`agent ${agent.id}`, await read(`source/crew/agents/${agent.id}.md`)]);
  for (const [label, text] of texts) {
    for (const [, name] of text.matchAll(/\b([a-z][a-z-]*[a-z]) 스킬/g)) assert.ok(skills.has(name), `${label}: 없는 스킬 ${name}`);
    for (const [, name] of text.matchAll(/onidot-crew:([a-z][a-z-]*)/g)) assert.ok(roles.has(name) || skills.has(name), `${label}: 없는 이름 ${name}`);
    // "explorer에게"처럼 한국어 조사 앞에 쓴 역할 이름도 실제 역할이어야 한다.
    for (const [, name] of text.matchAll(/([a-z][a-z-]*[a-z])에게/g)) {
      addressed.push(name);
      assert.ok(roles.has(name), `${label}: 없는 역할 ${name}`);
    }
  }
  assert.ok(addressed.length > 0, '본문에서 역할을 부르는 문장을 찾지 못했다');
  const start = await read('source/crew/runtime/session-start.json');
  assert.ok(Buffer.byteLength(start) <= 3000, `세션 안내 ${Buffer.byteLength(start)} bytes`);
  const context = JSON.parse(start).hookSpecificOutput.additionalContext;
  for (const role of roles) assert.ok(context.includes(role), `세션 안내에 역할 ${role} 없음`);
});

test('work-record 스킬은 증거 기록·gate 독립 검토·완료 절차를 담고 옛 금지 문장은 없다', async () => {
  const text = await read('source/crew/skills/work-record/SKILL.md');
  assert.equal(text.includes('완료 처리는 아직 하지 않는다'), false);
  assert.equal(text.includes('완료 처리는 하지 않았고'), false);
  for (const needle of [
    'append_work_evidence', 'GIT_COMMIT', 'record_work_verification', 'reviewBundles', 'hiddenEvidence',
    'evidenceSetHash', 'parentSessionId', ':gate', 'verifierSessionId', 'complete_work_stage', 'COMPLETED',
    'CONFIRMED', 'CHANGES_REQUIRED', 'HUMAN_REQUIRED', 'HEAVY', 'onidot-crew:gate', 'end_work_session',
  ]) assert.ok(text.includes(needle), `work-record에 ${needle} 없음`);
  // claim 뒤에는 세션 version이 올라가므로 bind 전에 get_work_session을 다시 읽는다.
  const claim = text.indexOf('`claim_work`로 작업 전체를 맡는다');
  const bind = text.indexOf('`bind_work_session`');
  const reread = text.indexOf('`get_work_session`', claim);
  assert.ok(claim > 0 && reread > claim && bind > reread, 'claim → get_work_session → bind 순서');
  assert.ok(text.includes('REVISION_CONFLICT'));
  // 작업 조건은 해시 없이 충족되도록 VERIFICATION 으로 계획한다.
  assert.equal(text.includes('"requiredEvidenceKinds": ["<위와 같은 종류>"]'), false);
  // gate 판정은 메인 세션과 분리: 검토 세션으로는 claim·증거·완료를 하지 않는다.
  assert.ok(/검토 세션[^\n]*(claim|담당)[^\n]*(증거|완료)/.test(text));
});

test('verify 스킬과 gate 에이전트와 run 스킬이 work-record 완료 절차로 이어진다', async () => {
  for (const file of ['source/crew/skills/verify/SKILL.md', 'source/crew/skills/run/SKILL.md', 'source/crew/agents/gate.md']) {
    assert.ok((await read(file)).includes('work-record'), `${file}에 work-record 연결 없음`);
  }
  assert.ok((await read('source/crew/agents/gate.md')).includes('MCP 도구'));
});

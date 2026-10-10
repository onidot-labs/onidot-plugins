import { readFile, writeFile, mkdir, rm, lstat, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(resolve(root, 'source/products.json'), 'utf8'));
const json = value => JSON.stringify(value, null, 2) + '\n';
const outputs = new Map();
const codexEntries = [], claudeEntries = [], released = [], managedDirs = [];
const ids = new Set(), names = new Set();
// Product-specific outputs. Wiki keeps its OAuth helper, recording check and server resources.
const profiles = {
  wiki: { skills: 'source/skills', sessionStart: 'source/runtime/claude-session-start.json',
    scripts: ['oauth-helper.mjs', 'recording-check.sh', 'catalog-check.mjs'], recordingCheck: true, serverResources: true },
  crew: { skills: 'source/crew/skills', sessionStart: 'source/crew/runtime/session-start.json',
    scripts: ['codex-agents.mjs'], scriptsDir: 'source/crew/runtime', recordingCheck: false, serverResources: false, agents: 'source/crew/agents',
    agentsCommon: 'source/crew/agents-common.md', main: 'source/crew/main',
    // The lead agent carries the session guidance for Claude, so only Codex gets a session-start hook.
    claudeHooks: false, sessionStartPath: 'codex/session-start.json',
    // These directories hold only generated files; anything not generated this run is a leftover.
    managedDirs: ['agents', 'codex/agents', 'skills'] }
};
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const CODEX_SANDBOXES = ['read-only', 'workspace-write'];
const AGENT_KEYS = { agent: ['id', 'description', 'claude', 'codex'], claude: ['model', 'effort', 'tools', 'disallowedTools', 'skills'],
  codex: ['reasoningEffort', 'sandboxMode'] };
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];
const stringList = (value, label) => {
  if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_:*().-]*$/.test(v)))
    throw Error(`Invalid agents: ${label} must be a non-empty string array`);
  return value;
};
// The optional main agent becomes the Claude main thread through the plugin's settings.json.
async function mainOutputs(app, dir, roleIds) {
  const main = app.main, fail = reason => { throw Error(`Invalid main: ${reason}`); };
  if (typeof main !== 'object' || main === null || Array.isArray(main)) fail('must be an object');
  for (const key of Object.keys(main)) if (!['id', 'description'].includes(key)) fail(`unknown key ${key}`);
  const id = main.id;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) fail(`id ${id}`);
  if (roleIds.has(id)) fail(`id ${id} duplicates a role`);
  if (typeof main.description !== 'string' || !main.description.trim() || /[\x00-\x1f\x7f]/.test(main.description) || /\p{Cs}/u.test(main.description)) fail('description');
  const body = await readFile(resolve(root, dir, `${id}.md`), 'utf8').catch(e => { if (e.code === 'ENOENT') fail('body missing'); throw e; });
  if (!body.trim()) fail('body empty');
  if (body.includes("'''")) fail("body contains '''");
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(body)) fail('body contains control characters');
  // No model, effort or tools: the lead inherits what the user chose.
  return [[`agents/${id}.md`, `---\nname: ${id}\ndescription: ${JSON.stringify(main.description)}\n---\n\n${body.trim().replaceAll('{{version}}', app.version)}\n`],
    ['settings.json', json({ agent: id })]];
}
async function agentOutputs(app, productId, dir, commonPath) {
  const files = [], seen = new Set();
  // Rules shared by every role live in one file and are appended to each role body.
  const common = commonPath ? (await readFile(resolve(root, commonPath), 'utf8')).trim() : '';
  if (common.includes("'''") || /[\x00-\x08\x0b-\x1f\x7f]/.test(common)) throw Error('Invalid agents: common rules');
  for (const agent of app.agents) {
    const id = agent?.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id) || seen.has(id)) throw Error(`Invalid agents: id ${id}`);
    seen.add(id);
    const fail = reason => { throw Error(`Invalid agents: ${id} ${reason}`); };
    // Control characters and lone surrogates make the TOML string invalid.
    if (typeof agent.description !== 'string' || !agent.description.trim() || /[\x00-\x1f\x7f]/.test(agent.description) || /\p{Cs}/u.test(agent.description)) fail('description');
    const claude = agent.claude ?? {}, codex = agent.codex ?? {};
    // A misspelled key would silently drop a permission, so unknown keys are rejected.
    for (const [label, value] of [['agent', agent], ['claude', claude], ['codex', codex]]) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`);
      for (const key of Object.keys(value)) if (!AGENT_KEYS[label].includes(key)) fail(`${label} unknown key ${key}`);
    }
    if (!CLAUDE_MODELS.includes(claude.model)) fail('claude.model');
    if (!CLAUDE_EFFORTS.includes(claude.effort)) fail('claude.effort');
    if (claude.tools !== undefined && claude.disallowedTools !== undefined) fail('tools and disallowedTools together');
    if (claude.tools === undefined && claude.disallowedTools === undefined) fail('claude.tools or claude.disallowedTools required');
    if (claude.tools !== undefined) stringList(claude.tools, `${id} claude.tools`);
    if (claude.disallowedTools !== undefined) stringList(claude.disallowedTools, `${id} claude.disallowedTools`);
    if (claude.skills !== undefined) {
      if (!Array.isArray(claude.skills) || claude.skills.some(s => !app.skills.includes(s))) fail('claude.skills references unknown skill');
    }
    if (!CODEX_EFFORTS.includes(codex.reasoningEffort)) fail('codex.reasoningEffort');
    if (!CODEX_SANDBOXES.includes(codex.sandboxMode)) fail('codex.sandboxMode');
    if (codex.sandboxMode === 'read-only') {
      // A read-only Codex role must not be able to write files on the Claude side either.
      const allowed = claude.tools ? WRITE_TOOLS.filter(t => claude.tools.includes(t)) : [];
      if (allowed.length) fail(`read-only role must not allow ${allowed.join(', ')}`);
      const missing = claude.disallowedTools ? WRITE_TOOLS.filter(t => !claude.disallowedTools.includes(t)) : [];
      if (missing.length) fail(`read-only role must disallow ${missing.join(', ')}`);
    }
    const body = await readFile(resolve(root, dir, `${id}.md`), 'utf8').catch(e => { if (e.code === 'ENOENT') fail('body missing'); throw e; });
    if (!body.trim()) fail('body empty');
    if (body.includes("'''")) fail("body contains '''");
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(body)) fail('body contains control characters');
    const text = [body.trim(), common].filter(Boolean).join('\n\n').replaceAll('{{version}}', app.version) + '\n';
    // A JSON string is also a valid YAML double-quoted scalar with the same value.
    const front = [`name: ${id}`, `description: ${JSON.stringify(agent.description)}`, `model: ${claude.model}`, `effort: ${claude.effort}`];
    if (claude.tools) front.push(`tools: ${claude.tools.join(', ')}`);
    if (claude.disallowedTools) front.push(`disallowedTools: ${claude.disallowedTools.join(', ')}`);
    // Qualified with the plugin name so a user or project skill with the same name is not picked first.
    if (claude.skills?.length) front.push('skills:', ...claude.skills.map(s => `  - ${app.name}:${s}`));
    files.push([`agents/${id}.md`, `---\n${front.join('\n')}\n---\n\n${text}`]);
    // Codex inherits the parent model; only effort and sandbox are pinned per role.
    files.push([`codex/agents/${productId}-${id}.toml`, [`name = ${JSON.stringify(`${productId}-${id}`)}`,
      `description = ${JSON.stringify(agent.description)}`, `model_reasoning_effort = ${JSON.stringify(codex.reasoningEffort)}`,
      `sandbox_mode = ${JSON.stringify(codex.sandboxMode)}`, `developer_instructions = '''`, `${text}'''`, ''].join('\n')]);
  }
  return files;
}
if (catalog.schemaVersion !== 1 || Object.hasOwn(catalog, 'issuer') || Object.hasOwn(catalog, 'mcpOrigin')) throw Error('Invalid instance-bound catalog');
for (const product of catalog.products) {
  if (!/^[a-z][a-z0-9-]*$/.test(product.id) || ids.has(product.id)) throw Error('Invalid/duplicate product id');
  ids.add(product.id);
  if (product.status === 'planned') {
    if (product.source || product.endpoint) throw Error('Planned products must not expose installable endpoints');
    continue;
  }
  if (product.status !== 'released' || !/^[a-z][a-z0-9-]*\.json$/.test(product.source)) throw Error('Invalid product source');
  const app = JSON.parse(await readFile(resolve(root, 'source', product.source), 'utf8'));
  if (app.name !== (product.id === 'wiki' ? 'onidot' : `onidot-${product.id}`) || names.has(app.name)) throw Error('Invalid/duplicate plugin name');
  if (Object.hasOwn(app, 'endpoint') || Object.hasOwn(app, 'issuer')) throw Error('Invalid instance-bound product endpoint/issuer');
  if (!/^\d+\.\d+\.\d+$/.test(app.version) || !app.displayName || !app.skills?.length) throw Error('Incomplete released product');
  if (new Set(app.skills).size !== app.skills.length || app.skills.some(s => !/^[a-z][a-z0-9-]*$/.test(s))) throw Error('Invalid skills');
  names.add(app.name);
  const profile = profiles[product.id];
  if (!profile) throw Error(`Invalid product profile: ${product.id}`);
  const base = `plugins/${app.name}`;
  const common = { name: app.name, version: app.version, description: app.description,
    author: { name: 'onidot', url: 'https://onidot.com' }, homepage: app.guide,
    repository: catalog.repository, skills: './skills/' };
  outputs.set(`${base}/.codex-plugin/plugin.json`, json({ ...common,
    // Connections are registered by alias in client config; the package never selects an instance.
    mcpServers: {}, hooks: './codex/hooks.json',
    interface: { displayName: app.displayName, shortDescription: app.shortDescription,
      longDescription: app.description, developerName: 'onidot', category: 'Productivity',
      capabilities: ['Read', 'Write'], websiteURL: 'https://onidot.com',
      defaultPrompt: app.defaultPrompt } }));
  // Claude account connector owns MCP. A root .mcp.json would silently attach a second server in Code.
  outputs.set(`${base}/.claude-plugin/plugin.json`, json(profile.claudeHooks === false ? common : { ...common, hooks: './claude/hooks.json' }));
  // Both clients declare their own path; no shared default hook file is generated.
  const claudeHooks = { SessionStart: [{ matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command: 'cat "${CLAUDE_PLUGIN_ROOT}/claude/session-start.json"' }] }] };
  const codexHooks = { SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command',
    command: `cat "\${PLUGIN_ROOT}/${profile.sessionStartPath ?? 'claude/session-start.json'}"` }] }] };
  if (profile.recordingCheck) {
    claudeHooks.Stop = [{ hooks: [{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/recording-check.sh" claude' }] }];
    codexHooks.Stop = [{ hooks: [{ type: 'command', command: 'sh "${PLUGIN_ROOT}/scripts/recording-check.sh" codex' }] }];
  }
  if (profile.claudeHooks !== false) outputs.set(`${base}/claude/hooks.json`, json({ hooks: claudeHooks }));
  outputs.set(`${base}/codex/hooks.json`, json({ hooks: codexHooks }));
  const sessionStart = (await readFile(resolve(root, profile.sessionStart), 'utf8')).replaceAll('{{version}}', app.version);
  if (JSON.parse(sessionStart).hookSpecificOutput?.hookEventName !== 'SessionStart') throw Error('Invalid session start context');
  outputs.set(`${base}/${profile.sessionStartPath ?? 'claude/session-start.json'}`, sessionStart);
  for (const script of profile.scripts)
    outputs.set(`${base}/scripts/${script}`, await readFile(resolve(root, `${profile.scriptsDir ?? 'source/runtime'}/${script}`), 'utf8'));
  const hashes = {};
  for (const skill of app.skills) {
    const markdown = (await readFile(resolve(root, `${profile.skills}/${skill}/SKILL.md`), 'utf8')).replaceAll('{{version}}', app.version);
    outputs.set(`${base}/skills/${skill}/SKILL.md`, markdown);
    if (profile.serverResources) {
      outputs.set(`server-resources/${product.id}/skills/${skill}/SKILL.md`, markdown);
      hashes[`skills/${skill}/SKILL.md`] = createHash('sha256').update(markdown).digest('hex');
    }
  }
  if (profile.serverResources)
    outputs.set(`server-resources/${product.id}/manifest.json`, json({schemaVersion:1, product:product.id,
      name:app.name, displayName:app.displayName, version:app.version, repository:catalog.repository,
      files:hashes}));
  for (const dir of profile.managedDirs ?? []) managedDirs.push(`${base}/${dir}`);
  if (profile.agents) {
    if (!Array.isArray(app.agents) || !app.agents.length) throw Error('Invalid agents: missing');
    for (const [path, content] of await agentOutputs(app, product.id, profile.agents, profile.agentsCommon)) outputs.set(`${base}/${path}`, content);
    if (profile.main && app.main !== undefined)
      for (const [path, content] of await mainOutputs(app, profile.main, new Set(app.agents.map(a => a.id)))) outputs.set(`${base}/${path}`, content);
  }
  codexEntries.push({name:app.name, source:{source:'local',path:`./${base}`},
    policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'});
  claudeEntries.push({name:app.name,source:`./${base}`,version:app.version,description:app.description});
  released.push({id:product.id,name:app.name,displayName:app.displayName,version:app.version});
}
outputs.set('.agents/plugins/marketplace.json', json({name:'onidot',interface:{displayName:'onidot'},plugins:codexEntries}));
outputs.set('.claude-plugin/marketplace.json', json({name:'onidot',owner:{name:'onidot'},metadata:{description:'onidot-studio AI 플러그인'},plugins:claudeEntries}));
outputs.set('catalog.json',json({schemaVersion:1,repository:catalog.repository,products:released}));
let different = false;
const check = process.argv.includes('--check');
// W5에서 이름이 바뀐 생성물만 정리한다. 설치된 사용자 캐시나 다른 제품은 건드리지 않는다.
for (const path of ['plugins/doraft-wiki', 'server-resources/wiki/skills/setup-doraft-wiki', 'server-resources/wiki/skills/use-doraft-wiki', 'plugins/onidot/hooks/hooks.json',
  // crew의 Claude 훅은 리더 에이전트로 대체되어 사라졌다.
  'plugins/onidot-crew/claude']) {
  const destination = resolve(root, path);
  if (check) {
    try { await lstat(destination); process.stderr.write(`은퇴한 생성물: ${path}\n`); different = true; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  } else await rm(destination, { recursive: true, force: true });
}
// Leftovers in generated-only directories (a removed role or skill) are deleted; --check reports them.
async function leftovers(dir) {
  const found = [];
  const entries = await readdir(resolve(root, dir), { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (![...outputs.keys()].some(output => output.startsWith(`${path}/`))) found.push(path);
      else found.push(...await leftovers(path));
    } else if (!outputs.has(path)) found.push(path);
  }
  return found;
}
for (const dir of managedDirs) for (const path of await leftovers(dir)) {
  const destination = resolve(root, path);
  if (!destination.startsWith(root)) throw Error('Output outside repository');
  if (check) { process.stderr.write(`남은 생성물: ${path}\n`); different = true; }
  else await rm(destination, { recursive: true, force: true });
}
for (const [path, content] of outputs) {
  const destination = resolve(root, path);
  if (!destination.startsWith(root)) throw Error('Output outside repository');
  if (check) {
    const actual = await readFile(destination,'utf8').catch(e=>{if(e.code==='ENOENT') return null; throw e;});
    if (actual !== content) { process.stderr.write(`재생성 필요: ${path}\n`); different = true; }
  } else { await mkdir(dirname(destination),{recursive:true}); await writeFile(destination,content); }
}
for (const app of released) {
  const stale = resolve(root,`plugins/${app.name}/.mcp.json`);
  if (check) {
    try { await readFile(stale); process.stderr.write('Claude 중복 MCP 파일: '+stale+'\n'); different=true; }
    catch(e) {if(e.code!=='ENOENT') throw e;}
  } else await rm(stale,{force:true});
}
if(different) process.exitCode=1;

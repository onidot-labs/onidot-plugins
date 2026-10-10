import { readFile, writeFile, mkdir, rm, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(resolve(root, 'source/products.json'), 'utf8'));
const json = value => JSON.stringify(value, null, 2) + '\n';
const outputs = new Map();
const codexEntries = [], claudeEntries = [], released = [];
const ids = new Set(), names = new Set();
// Product-specific outputs. Wiki keeps its OAuth helper, recording check and server resources.
const profiles = {
  wiki: { skills: 'source/skills', sessionStart: 'source/runtime/claude-session-start.json',
    scripts: ['oauth-helper.mjs', 'recording-check.sh', 'catalog-check.mjs'], recordingCheck: true, serverResources: true },
  crew: { skills: 'source/crew/skills', sessionStart: 'source/crew/runtime/session-start.json',
    scripts: ['codex-agents.mjs'], scriptsDir: 'source/crew/runtime', recordingCheck: false, serverResources: false, agents: 'source/crew/agents',
    agentsCommon: 'source/crew/agents-common.md' }
};
const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const CODEX_SANDBOXES = ['read-only', 'workspace-write'];
const yamlScalar = value => /^[\s'"&*!|>%@`{}\[\],?#-]|[:#]\s|:$|\s$/.test(value) ? JSON.stringify(value) : value;
const stringList = (value, label) => {
  if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_:*().-]*$/.test(v)))
    throw Error(`Invalid agents: ${label} must be a non-empty string array`);
  return value;
};
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
    if (typeof agent.description !== 'string' || !agent.description.trim() || /[\r\n]/.test(agent.description)) fail('description');
    const claude = agent.claude ?? {}, codex = agent.codex ?? {};
    if (!CLAUDE_MODELS.includes(claude.model)) fail('claude.model');
    if (!CLAUDE_EFFORTS.includes(claude.effort)) fail('claude.effort');
    if (claude.tools !== undefined && claude.disallowedTools !== undefined) fail('tools and disallowedTools together');
    if (claude.tools !== undefined) stringList(claude.tools, `${id} claude.tools`);
    if (claude.disallowedTools !== undefined) stringList(claude.disallowedTools, `${id} claude.disallowedTools`);
    if (claude.skills !== undefined) {
      if (!Array.isArray(claude.skills) || claude.skills.some(s => !app.skills.includes(s))) fail('claude.skills references unknown skill');
    }
    if (!CODEX_EFFORTS.includes(codex.reasoningEffort)) fail('codex.reasoningEffort');
    if (!CODEX_SANDBOXES.includes(codex.sandboxMode)) fail('codex.sandboxMode');
    const body = await readFile(resolve(root, dir, `${id}.md`), 'utf8').catch(e => { if (e.code === 'ENOENT') fail('body missing'); throw e; });
    if (!body.trim()) fail('body empty');
    if (body.includes("'''")) fail("body contains '''");
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(body)) fail('body contains control characters');
    const text = [body.trim(), common].filter(Boolean).join('\n\n').replaceAll('{{version}}', app.version) + '\n';
    const front = [`name: ${id}`, `description: ${yamlScalar(agent.description)}`, `model: ${claude.model}`, `effort: ${claude.effort}`];
    if (claude.tools) front.push(`tools: ${claude.tools.join(', ')}`);
    if (claude.disallowedTools) front.push(`disallowedTools: ${claude.disallowedTools.join(', ')}`);
    if (claude.skills?.length) front.push('skills:', ...claude.skills.map(s => `  - ${s}`));
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
  outputs.set(`${base}/.claude-plugin/plugin.json`, json({ ...common, hooks: './claude/hooks.json' }));
  // Both clients declare their own path; no shared default hook file is generated.
  const claudeHooks = { SessionStart: [{ matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command: 'cat "${CLAUDE_PLUGIN_ROOT}/claude/session-start.json"' }] }] };
  const codexHooks = { SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command',
    command: 'cat "${PLUGIN_ROOT}/claude/session-start.json"' }] }] };
  if (profile.recordingCheck) {
    claudeHooks.Stop = [{ hooks: [{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/recording-check.sh" claude' }] }];
    codexHooks.Stop = [{ hooks: [{ type: 'command', command: 'sh "${PLUGIN_ROOT}/scripts/recording-check.sh" codex' }] }];
  }
  outputs.set(`${base}/claude/hooks.json`, json({ hooks: claudeHooks }));
  outputs.set(`${base}/codex/hooks.json`, json({ hooks: codexHooks }));
  const sessionStart = (await readFile(resolve(root, profile.sessionStart), 'utf8')).replaceAll('{{version}}', app.version);
  if (JSON.parse(sessionStart).hookSpecificOutput?.hookEventName !== 'SessionStart') throw Error('Invalid session start context');
  outputs.set(`${base}/claude/session-start.json`, sessionStart);
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
  if (profile.agents) {
    if (!Array.isArray(app.agents) || !app.agents.length) throw Error('Invalid agents: missing');
    for (const [path, content] of await agentOutputs(app, product.id, profile.agents, profile.agentsCommon)) outputs.set(`${base}/${path}`, content);
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
for (const path of ['plugins/doraft-wiki', 'server-resources/wiki/skills/setup-doraft-wiki', 'server-resources/wiki/skills/use-doraft-wiki', 'plugins/onidot/hooks/hooks.json']) {
  const destination = resolve(root, path);
  if (check) {
    try { await lstat(destination); process.stderr.write(`은퇴한 생성물: ${path}\n`); different = true; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  } else await rm(destination, { recursive: true, force: true });
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

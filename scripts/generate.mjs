import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(resolve(root, 'source/products.json'), 'utf8'));
const json = value => JSON.stringify(value, null, 2) + '\n';
const outputs = new Map();
const codexEntries = [], claudeEntries = [], released = [];
const ids = new Set(), names = new Set();
if (catalog.schemaVersion !== 1 || catalog.issuer !== 'https://api.doraft.com' || !/^https:\/\/[a-z0-9.-]+$/.test(catalog.mcpOrigin)) throw Error('Unsupported catalog/issuer');
for (const product of catalog.products) {
  if (!/^[a-z][a-z0-9-]*$/.test(product.id) || ids.has(product.id)) throw Error('Invalid/duplicate product id');
  ids.add(product.id);
  if (product.status === 'planned') {
    if (product.source || product.endpoint) throw Error('Planned products must not expose installable endpoints');
    continue;
  }
  if (product.status !== 'released' || !/^[a-z][a-z0-9-]*\.json$/.test(product.source)) throw Error('Invalid product source');
  const app = JSON.parse(await readFile(resolve(root, 'source', product.source), 'utf8'));
  if (app.name !== `doraft-${product.id}` || names.has(app.name)) throw Error('Invalid/duplicate plugin name');
  if (app.endpoint !== `${catalog.mcpOrigin}/${product.id}`) throw Error('Canonical product endpoint required');
  if (!/^\d+\.\d+\.\d+$/.test(app.version) || !app.displayName || !app.skills?.length) throw Error('Incomplete released product');
  if (new Set(app.skills).size !== app.skills.length || app.skills.some(s => !/^[a-z][a-z0-9-]*$/.test(s))) throw Error('Invalid skills');
  names.add(app.name);
  const base = `plugins/${app.name}`;
  const common = { name: app.name, version: app.version, description: app.description,
    author: { name: 'Doraft', url: 'https://doraft.com' }, homepage: app.guide,
    repository: catalog.repository, skills: './skills/' };
  outputs.set(`${base}/.codex-plugin/plugin.json`, json({ ...common,
    mcpServers: { [app.name]: { type: 'http', url: app.endpoint,
      http_headers_helper: `node "\${CODEX_HOME:-$HOME/.codex}/plugins/cache/doraft/${app.name}/${app.version}/scripts/oauth-helper.mjs" headers` } },
    interface: { displayName: app.displayName, shortDescription: app.shortDescription,
      longDescription: app.description, developerName: 'Doraft', category: 'Productivity',
      capabilities: ['Read', 'Write'], websiteURL: 'https://doraft.com',
      privacyPolicyURL: 'https://doraft.com/privacy', termsOfServiceURL: 'https://doraft.com/terms',
      defaultPrompt: app.defaultPrompt } }));
  // Claude account connector owns MCP. A root .mcp.json would silently attach a second server in Code.
  outputs.set(`${base}/.claude-plugin/plugin.json`, json(common));
  outputs.set(`${base}/scripts/oauth-helper.mjs`, await readFile(resolve(root, 'source/runtime/oauth-helper.mjs'), 'utf8'));
  const hashes = {};
  for (const skill of app.skills) {
    const markdown = await readFile(resolve(root, `source/skills/${skill}/SKILL.md`), 'utf8');
    outputs.set(`${base}/skills/${skill}/SKILL.md`, markdown);
    outputs.set(`server-resources/${product.id}/skills/${skill}/SKILL.md`, markdown);
    hashes[`skills/${skill}/SKILL.md`] = createHash('sha256').update(markdown).digest('hex');
  }
  outputs.set(`server-resources/${product.id}/manifest.json`, json({schemaVersion:1, product:product.id,
    name:app.name, displayName:app.displayName, version:app.version, repository:catalog.repository,
    issuer:catalog.issuer, resource:app.endpoint, files:hashes}));
  codexEntries.push({name:app.name, source:{source:'local',path:`./${base}`},
    policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'});
  claudeEntries.push({name:app.name,source:`./${base}`,version:app.version,description:app.description});
  released.push({id:product.id,name:app.name,displayName:app.displayName,version:app.version,endpoint:app.endpoint});
}
outputs.set('.agents/plugins/marketplace.json', json({name:'doraft',interface:{displayName:'Doraft'},plugins:codexEntries}));
outputs.set('.claude-plugin/marketplace.json', json({name:'doraft',owner:{name:'Doraft'},metadata:{description:'Doraft 제품별 AI 플러그인'},plugins:claudeEntries}));
outputs.set('catalog.json',json({schemaVersion:1,issuer:catalog.issuer,repository:catalog.repository,products:released}));
let different = false;
const check = process.argv.includes('--check');
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

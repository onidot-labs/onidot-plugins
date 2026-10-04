import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {test} from 'node:test';
const root = new URL('../',import.meta.url);
const json = async p => JSON.parse(await readFile(new URL(p,root),'utf8'));
test('독립 레포의 패키지는 새 저장소를 참조한다',async()=>{
 for(const path of ['source/products.json','catalog.json','plugins/onidot/.codex-plugin/plugin.json','plugins/onidot/.claude-plugin/plugin.json','server-resources/wiki/manifest.json'])
  assert.equal((await json(path)).repository,'https://github.com/onidot-labs/onidot-plugins',path);
 assert.equal((await json('package.json')).name,'@onidot/plugins');
});
test('생성기는 다른 저장소 경로에 쓰지 않는다',async()=>{
 const s=await readFile(new URL('scripts/generate.mjs',root),'utf8');
 assert.ok(!s.includes('../../other-server'));
 assert.ok(!s.includes('../../.claude-plugin'));
});
test('이 저장소의 원본과 설치 카탈로그는 onidot Wiki만 포함한다',async()=>{
 const source=await json('source/products.json');
 assert.deepEqual(source.products,[{id:'wiki',status:'released',source:'wiki.json'}]);
 assert.deepEqual(await readdir(new URL('server-resources/',root)),['wiki']);
 for(const p of ['.agents/plugins/marketplace.json','.claude-plugin/marketplace.json'])
  assert.deepEqual((await json(p)).plugins.map(p=>p.name),['onidot']);
 assert.deepEqual((await json('catalog.json')).products.map(p=>p.id),['wiki']);
});
test('서버 반입 산출물의 해시는 실제 스킬 바이트와 일치한다',async()=>{
 const {createHash}=await import('node:crypto');
 const manifest=await json('server-resources/wiki/manifest.json');
 assert.equal(manifest.resource,'https://mcp.onidot.dev');
 for(const [path,hash] of Object.entries(manifest.files))
  assert.equal(createHash('sha256').update(await readFile(new URL('server-resources/wiki/'+path,root))).digest('hex'),hash);
});
test('같은 제품의 변형 이름과 제품 경로 탈출은 생성 전에 거부한다',async()=>{
 const {mkdtemp,cp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 for(const patch of [{name:'onidot-codex'},{name:'doraft-wiki'},{endpoint:'https://mcp.onidot.dev/wiki'},{endpoint:'https://mcp.onidot.dev/'},{endpoint:'https://api.doraft.com/mcp/wiki'},{skills:['../secret']}]) {
  const temp=await mkdtemp(join(tmpdir(),'onidot-plugin-test-'));
  try {
   await cp(new URL('scripts/',root),join(temp,'scripts'),{recursive:true});
   await cp(new URL('source/',root),join(temp,'source'),{recursive:true});
   const app={...await json('source/wiki.json'),...patch};
   await writeFile(join(temp,'source/wiki.json'),JSON.stringify(app));
   const result=spawnSync(process.execPath,['scripts/generate.mjs'],{cwd:temp,encoding:'utf8'});
   assert.notEqual(result.status,0);
   assert.match(result.stderr,/Invalid|Canonical/);
  } finally {await rm(temp,{recursive:true,force:true});}
 }
});

test('mcpOrigin 누락·http·끝 슬래시와 endpoint 불일치는 생성 전에 거부한다',async()=>{
 const {mkdtemp,cp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const base=await json('source/products.json');
 const {mcpOrigin,...withoutOrigin}=base;
 const cases=[[withoutOrigin,/mcpOrigin/],[{...base,mcpOrigin:'http://labs.onidot.com'},/mcpOrigin/],[{...base,mcpOrigin:'https://labs.onidot.com/'},/mcpOrigin/],[{...base,mcpOrigin:'https://other.example'},/Canonical/]];
 for(const [catalog,pattern] of cases){
  const temp=await mkdtemp(join(tmpdir(),'onidot-plugin-test-'));
  try {
   await cp(new URL('scripts/',root),join(temp,'scripts'),{recursive:true});
   await cp(new URL('source/',root),join(temp,'source'),{recursive:true});
   await writeFile(join(temp,'source/products.json'),JSON.stringify(catalog));
   const result=spawnSync(process.execPath,['scripts/generate.mjs'],{cwd:temp,encoding:'utf8'});
   assert.notEqual(result.status,0);
   assert.match(result.stderr,pattern);
  } finally {await rm(temp,{recursive:true,force:true});}
 }
});

// W5b 수용 기준: 설치 안내·메타데이터는 새 저장소를 사용하고 옛 주소는 은퇴 안내로만 남긴다.
test('설치 안내는 onidot 저장소를 사용하고 Notes를 안내하지 않는다',async()=>{
 for(const path of ['README.md','source/skills/setup-onidot/SKILL.md','plugins/onidot/skills/setup-onidot/SKILL.md','server-resources/wiki/skills/setup-onidot/SKILL.md']){
  const text=await readFile(new URL(path,root),'utf8');
  assert.ok(text.includes('codex plugin marketplace add https://github.com/onidot-labs/onidot-plugins.git'),path);
  assert.ok(text.includes('claude plugin marketplace add onidot-labs/onidot-plugins'),path);
  assert.ok(!/Notes|doraft-notes/.test(text),path);
  for(const line of text.split('\n').filter(line=>line.includes('onidot-labs/doraft-plugins')))
   assert.match(line,/은퇴한 주소/,path);
 }
});

test('다른 onidot 제품과 planned 제품을 지원해도 Doraft 플러그인을 생성하지 않는다',async()=>{
 const {mkdtemp,cp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 const temp=await mkdtemp(join(tmpdir(),'onidot-product-test-'));
 try{
  for(const path of ['scripts','source']) await cp(new URL(path+'/',root),join(temp,path),{recursive:true});
  const catalog=await json('source/products.json');
  catalog.products=[catalog.products[0],{id:'sample',status:'released',source:'sample.json'},{id:'future',status:'planned'}];
  await writeFile(join(temp,'source/products.json'),JSON.stringify(catalog));
  await writeFile(join(temp,'source/sample.json'),JSON.stringify({...await json('source/wiki.json'),name:'onidot-sample',endpoint:catalog.mcpOrigin+'/sample'}));
  const result=spawnSync(process.execPath,['scripts/generate.mjs'],{cwd:temp,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(await readFile(join(temp,'catalog.json'),'utf8'));
  assert.deepEqual(output.products.map(p=>p.name),['onidot','onidot-sample']);
  assert.deepEqual((await readdir(join(temp,'plugins'))).sort(),['onidot','onidot-sample']);
 }finally{await rm(temp,{recursive:true,force:true});}
});

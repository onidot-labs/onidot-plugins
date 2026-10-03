import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const root = new URL('../',import.meta.url);
const json = async p => JSON.parse(await readFile(new URL(p,root),'utf8'));
test('독립 레포의 패키지는 새 저장소를 참조한다',async()=>{
 const p=await json('plugins/doraft-wiki/.codex-plugin/plugin.json');
 assert.equal(p.repository,'https://github.com/doraft-labs/doraft-plugins');
});
test('생성기는 다른 저장소 경로에 쓰지 않는다',async()=>{
 const s=await readFile(new URL('scripts/generate.mjs',root),'utf8');
 assert.ok(!s.includes('../../doraft-server'));
 assert.ok(!s.includes('../../.claude-plugin'));
});
test('계획 중 Notes는 설치 카탈로그와 배포 resource에 노출되지 않는다',async()=>{
 const source=await json('source/products.json');
 assert.equal(source.products.find(p=>p.id==='notes').status,'planned');
 for(const p of ['.agents/plugins/marketplace.json','.claude-plugin/marketplace.json'])
  assert.deepEqual((await json(p)).plugins.map(p=>p.name),['doraft-wiki']);
 assert.deepEqual((await json('catalog.json')).products.map(p=>p.id),['wiki']);
});
test('서버 반입 산출물의 해시는 실제 스킬 바이트와 일치한다',async()=>{
 const {createHash}=await import('node:crypto');
 const manifest=await json('server-resources/wiki/manifest.json');
 assert.equal(manifest.resource,'https://labs.onidot.com/wiki');
 for(const [path,hash] of Object.entries(manifest.files))
  assert.equal(createHash('sha256').update(await readFile(new URL('server-resources/wiki/'+path,root))).digest('hex'),hash);
});
test('같은 제품의 변형 이름과 제품 경로 탈출은 생성 전에 거부한다',async()=>{
 const {mkdtemp,cp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {spawnSync}=await import('node:child_process');
 for(const patch of [{name:'doraft-wiki-codex'},{endpoint:'https://api.doraft.com/mcp/wiki'},{skills:['../secret']}]) {
  const temp=await mkdtemp(join(tmpdir(),'doraft-plugin-test-'));
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
  const temp=await mkdtemp(join(tmpdir(),'doraft-plugin-test-'));
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

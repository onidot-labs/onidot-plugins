import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareCatalog} from '../source/runtime/catalog-check.mjs';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const a = 'a'.repeat(64), b = 'b'.repeat(64);
const catalog = {schemaVersion:1, revision:a, tools:[{name:'recall',digest:a},{name:'remember',digest:b}]};
test('누락과 같은 개수 교체를 감지한다', () => {
 const r = compareCatalog({catalog, observed:[{name:'recall'},{name:'old_tool'}], complete:true});
 assert.equal(r.status,'refresh_required');
 assert.deepEqual(r.missing,['remember']);
 assert.deepEqual(r.extra,['old_tool']);
});
test('이름만 일치하면 스키마 성공을 주장하지 않는다', () => {
 assert.equal(compareCatalog({catalog,observed:catalog.tools.map(({name})=>({name})),complete:true}).status,'names_match');
});
test('revision과 digest 변경을 감지하고 순서는 무시한다', () => {
 assert.equal(compareCatalog({catalog,observed:[...catalog.tools].reverse(),complete:true}).status,'current');
 assert.equal(compareCatalog({catalog,observed:catalog.tools,previousRevision:b,complete:true}).status,'refresh_required');
 assert.equal(compareCatalog({catalog,observed:[{name:'recall',digest:b},catalog.tools[1]],complete:true}).status,'refresh_required');
});
test('부분 목록과 구버전 서버는 성공으로 판단하지 않는다', () => {
 assert.equal(compareCatalog({catalog,observed:[],complete:false}).status,'unverified');
 assert.equal(compareCatalog({observed:[],complete:true}).status,'unsupported');
});
test('READ catalog는 쓰기 도구를 요구하지 않는다', () => {
 const read = {...catalog,tools:[catalog.tools[0]]};
 assert.equal(compareCatalog({catalog:read,observed:read.tools,complete:true}).status,'current');
});
test('중복과 잘못된 digest는 거부하고 비밀 입력을 출력하지 않는다', () => {
 assert.throws(()=>compareCatalog({catalog,observed:[{name:'recall'},{name:'recall'}],complete:true}));
 const r = spawnSync(process.execPath,['source/runtime/catalog-check.mjs'],{input:'SECRET-invalid-json',encoding:'utf8'});
 assert.equal(r.status,1);
 assert.equal(r.stdout,'');
 assert.equal(r.stderr,'INVALID_CATALOG_INPUT\n');
});
test('생성된 배포 비교기를 실제 실행한다', () => {
 const r=spawnSync(process.execPath,['plugins/onidot/scripts/catalog-check.mjs'],{input:JSON.stringify({catalog,observed:[],complete:true}),encoding:'utf8'});
 assert.equal(r.status,2);
 assert.deepEqual(JSON.parse(r.stdout).missing,['recall','remember']);
 assert.match(readFileSync('plugins/onidot/claude/session-start.json','utf8'),/toolCatalog/);
});

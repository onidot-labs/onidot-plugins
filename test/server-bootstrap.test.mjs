import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
test('서버 지침 정본을 시작·재개에 읽고 오래된 보호 쓰기를 재조회한다',async()=>{
  const skill=await read('source/skills/use-doraft-wiki/SKILL.md');
  for(const contract of ['get_instruction_manifest','get_assistant_context','knownPolicyRevision','refresh_required','list_assistant_checkpoints','get_assistant_checkpoint','save_assistant_checkpoint','RECONCILIATION_REQUIRED','CLIENT_OBSERVATION']) assert.ok(skill.includes(contract),contract);
  assert.ok(skill.indexOf('## 서버 정본 bootstrap') < skill.indexOf('## 조회'));
  for(const boundary of ['이해·준수','외부 도구','job/lease','검토·활성화','서버 정본이 우선','호환 절차만']) assert.ok(skill.includes(boundary),boundary);
});
test('클라이언트 최초 설정 한계와 서버 변경의 재설치 불필요를 명시한다',async()=>{
  const setup=await read('source/skills/setup-doraft-wiki/SKILL.md');
  for(const contract of ['get_instruction_manifest','재설치','자동 호출','ChatGPT','OAuth grant','유료 모델','실제 세션']) assert.ok(setup.includes(contract),contract);
});

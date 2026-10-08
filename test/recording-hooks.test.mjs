import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'source/runtime/recording-check.sh');
const notice = 'onidot 완료 기록의 누락 확인이 불가합니다';
function invoke(client, body, fake) {
  const dir = mkdtempSync(join(tmpdir(), 'onidot-recording-'));
  try {
    if (fake) { writeFileSync(join(dir, 'oni'), fake); chmodSync(join(dir, 'oni'), 0o700); }
    return spawnSync('/bin/sh', [script, client], { input: body, encoding: 'utf8', env: { PATH: dir } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('완료 bridge는 입력과 고정 client 인자를 oni에 전달하고 JSON 결과를 유지한다', () => {
  for (const client of ['claude', 'codex']) {
    const result = invoke(client, '{"stop_hook_active":true}\n', '#!/bin/sh\n[ "$1 $2 $3" = "recording-check --client '+client+'" ] || exit 9\nIFS= read -r body\n[ "$body" = \'{"stop_hook_active":true}\' ] || exit 8\nprintf \'{"decision":"block","reason":"검토"}\\n\'\n');
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { decision: 'block', reason: '검토' });
  }
});
test('oni 미설치 또는 구버전 실패는 중단하지 않고 고정 미검증 안내를 반환한다', () => {
  for (const fake of [undefined, '#!/bin/sh\nprintf \'unknown command\\n\'\nexit 1\n', '#!/bin/sh\nexit 0\n']) {
    const result = invoke('codex', '{}', fake);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, undefined);
    assert.equal(output.continue, undefined);
    assert.equal(output.suppressOutput, false);
    assert.ok(output.systemMessage.includes(notice));
    assert.ok(output.systemMessage.includes('onidot-guide'));
    assert.ok(!output.systemMessage.includes('저장 완료'));
  }
});
test('정상 통과 JSON은 변경하지 않으며 Codex와 Claude 훅은 각 manifest에서 분리한다', () => {
  const result = invoke('codex', '{}', '#!/bin/sh\nprintf \'{}\\n\'\n');
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {});
  const codex = JSON.parse(readFileSync(join(root, 'plugins/onidot/.codex-plugin/plugin.json'), 'utf8'));
  const claude = JSON.parse(readFileSync(join(root, 'plugins/onidot/.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(codex.hooks, './codex/hooks.json');
  assert.equal(claude.hooks, './claude/hooks.json');
  const hooks = JSON.parse(readFileSync(join(root, 'plugins/onidot/codex/hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.SessionStart[0].hooks[0].command, 'cat "${PLUGIN_ROOT}/claude/session-start.json"');
  assert.equal(hooks.Stop[0].hooks[0].command, 'sh "${PLUGIN_ROOT}/scripts/recording-check.sh" codex');
});
test('bridge client 입력은 shell code가 아니라 허용 목록으로 제한한다', () => {
  const result = invoke('codex; exit 72', '{}');
  assert.equal(result.status, 0);
  assert.ok(JSON.parse(result.stdout).systemMessage.includes(notice));
});
test('공통 지침은 일반 작업의 최종 답변 전 선별 및 remember 성공 검증을 명시한다', () => {
  for (const path of ['source/skills/onidot-guide/SKILL.md', 'source/runtime/claude-session-start.json']) {
    const text = readFileSync(join(root, path), 'utf8');
    for (const value of ['최종 답변 전', 'recall', 'remember', 'id', 'version', '미저장', '대화 원문', '비밀', '억지']) assert.ok(text.includes(value), `${path}: ${value}`);
  }
});

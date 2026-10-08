import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connectionConfig, stateDirectory } from '../source/runtime/oauth-helper.mjs';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('W1-22 이름표의 옛 도구·인자·브랜드는 배포 스킬에 남지 않는다', async () => {
  const old = /list_workspaces|workspaceId|workspaceIds|Workspace|scope="WORKSPACE"|skill:\/\/doraft\/|Doraft-Policy-Revision|X-Doraft-|DoraftUpload/;
  for (const base of ['source/skills', 'plugins/onidot/skills', 'server-resources/wiki/skills']) {
    for (const skill of ['use-onidot', 'setup-onidot']) {
      const text = await read(`${base}/${skill}/SKILL.md`);
      assert.doesNotMatch(text, old, `${base}/${skill}`);
      assert.match(text, /쓰기는 읽기·쓰기 연결에, 읽기 전용 연결은 참고만/);
    }
  }
  const use = await read('source/skills/use-onidot/SKILL.md');
  for (const value of ['list_spaces', 'spaceId', 'Onidot-Policy-Revision', 'scope="SPACE"']) assert.ok(use.includes(value), value);
});

test('서버 W1-22 승인 스킬 snapshot과 업무 계약이 일치한다', async () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(hash(await read('source/skills/use-onidot/SKILL.md')), 'db67849f1ac8793b9860aa565b9ee72f271a098ddd2df58af39e9fecda2becac');
  const setup = await read('source/skills/setup-onidot/SKILL.md');
  const server = setup.slice(0, setup.indexOf('\n## 클라이언트별 수동 등록'));
  // S1(onidot-studio Wiki 0rv6m4w3zs92z): scope 안내 한 줄이 onidot:wiki:*로 바뀐 서버 스냅샷.
  assert.equal(hash(server), '5f0d6b9fad614a5d8239851252fc119f0719e8609b40afd368b1ed7d572d0fe3');
});

test('명시하지 않은 권한은 READ이며 별칭·주소·scope별로 OAuth 상태를 분리한다', () => {
  const env = { ONIDOT_APP_URL: 'https://app.example.invalid', ONIDOT_MCP_URL: 'https://mcp.example.invalid/mcp', ONIDOT_ALIAS: 'home' };
  const home = connectionConfig(env);
  assert.equal(home.scope, 'onidot:wiki:read offline_access');
  const location = stateDirectory('/synthetic/codex', home);
  assert.equal(stateDirectory('/synthetic/codex', connectionConfig(env)), location);
  for (const patch of [{ ONIDOT_ALIAS: 'work' }, { ONIDOT_APP_URL: 'https://second.example.invalid' },
    { ONIDOT_MCP_URL: 'http://127.0.0.1:7777/mcp' }, { ONIDOT_SCOPE: 'onidot:wiki:read onidot:wiki:write offline_access' }]) {
    assert.notEqual(stateDirectory('/synthetic/codex', connectionConfig({ ...env, ...patch })), location);
  }
  for (const patch of [{ ONIDOT_ALIAS: '../work' }, { ONIDOT_MCP_URL: 'http://public.example.invalid/mcp' },
    { ONIDOT_MCP_URL: 'https://user:secret@example.invalid/mcp' }, { ONIDOT_APP_URL: 'https://example.invalid/path' },
    { ONIDOT_SCOPE: 'onidot:write' }]) assert.throws(() => connectionConfig({ ...env, ...patch }), /INVALID_ONIDOT/);
});

test('manifest·카탈로그·스킬·스크립트는 인스턴스 주소나 단일 MCP 등록을 내장하지 않는다', async () => {
  for (const path of ['source/products.json', 'source/wiki.json', 'catalog.json',
    'plugins/onidot/.codex-plugin/plugin.json', 'plugins/onidot/.claude-plugin/plugin.json',
    '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json',
    'server-resources/wiki/manifest.json', 'source/runtime/oauth-helper.mjs',
    'scripts/generate.mjs', 'scripts/verify-codex-oauth.mjs',
    'source/skills/use-onidot/SKILL.md', 'source/skills/setup-onidot/SKILL.md']) {
    assert.doesNotMatch(await read(path), /(?:labs|app|mcp|api)\.(?:onidot\.(?:com|dev)|doraft\.com)/, path);
  }
  const codex = JSON.parse(await read('plugins/onidot/.codex-plugin/plugin.json'));
  assert.deepEqual(codex.mcpServers, {});
  assert.equal(JSON.parse(await read('source/wiki.json')).version, '0.15.6');
});

test('등록 안내는 별칭·URL·사람의 OAuth 단계와 실제 조회 검증을 제공한다', async () => {
  const setup = await read('source/skills/setup-onidot/SKILL.md');
  for (const value of ['APP_URL', 'MCP_URL', 'ALIAS', 'onidot-dev', 'onidot-work',
    'claude mcp add --transport http', '--scope user', 'codex mcp add',
    '[mcp_servers.onidot-dev]', 'codex mcp login', '사용자 지정 커넥터',
    '셀프호스팅', '사람이 직접', 'serverInfo.name=onidot', 'list_spaces', 'get_page']) assert.ok(setup.includes(value), value);
});

test('OAuth helper는 연결 정보 없이 실행하면 네트워크·상태 쓰기 전에 거부한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onidot-missing-connection-'));
  try {
  const env = { ...process.env, CODEX_HOME: dir };
  for (const key of Object.keys(env).filter(key => key.startsWith('ONIDOT_'))) delete env[key];
  const result = spawnSync(process.execPath, ['source/runtime/oauth-helper.mjs', 'headers'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ONIDOT_CONNECTION_REQUIRED/);
  assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

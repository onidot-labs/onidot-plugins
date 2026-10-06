// S1: the server names the OAuth scopes onidot:wiki:*; doraft:wiki:* was
// their name and servers keep accepting it. Synthetic connection only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectionConfig, stateDirectory, getHeaders, writeState } from '../source/runtime/oauth-helper.mjs';

const env = { ONIDOT_APP_URL: 'https://app.example.invalid', ONIDOT_MCP_URL: 'https://mcp.example.invalid/mcp', ONIDOT_ALIAS: 'home' };
// 0.14.0 keyed the state directory with ONIDOT_SCOPE as written (default
// 'doraft:wiki:read offline_access').
const key014 = (home, scope) => resolve(home, 'onidot-oauth', createHash('sha256')
  .update(JSON.stringify([env.ONIDOT_ALIAS, 'https://app.example.invalid', env.ONIDOT_MCP_URL, scope])).digest('hex'));

test('S1: 기본 scope는 onidot 이름이고 옛 이름 설정도 그대로 요청한다', () => {
  assert.equal(connectionConfig(env).scope, 'onidot:wiki:read offline_access');
  for (const scope of ['doraft:wiki:read', 'doraft:wiki:read doraft:wiki:write offline_access',
    'doraft:wiki:read onidot:wiki:write offline_access', 'onidot:wiki:read onidot:wiki:write offline_access']) {
    assert.equal(connectionConfig({ ...env, ONIDOT_SCOPE: scope }).scope, scope, scope);
  }
  for (const scope of ['doraft:wiki:write offline_access', 'onidot:wiki:write', 'doraft:wiki:read doraft:wiki:admin',
    'onidot:wiki:read onidot:notes:read', 'Doraft:wiki:read', 'onidot:wiki:read  offline_access', 'onidot:write']) {
    assert.throws(() => connectionConfig({ ...env, ONIDOT_SCOPE: scope }), /INVALID_ONIDOT_SCOPE/, scope);
  }
});

test('S1: 0.14.0의 로그인 상태는 옛·새 scope 이름 어느 설정에서도 그대로 쓴다', () => {
  const home = '/synthetic/codex';
  for (const [old, renamed] of [['doraft:wiki:read offline_access', 'onidot:wiki:read offline_access'],
    ['doraft:wiki:read doraft:wiki:write offline_access', 'onidot:wiki:read onidot:wiki:write offline_access'],
    ['doraft:wiki:read', 'onidot:wiki:read']]) {
    assert.equal(stateDirectory(home, connectionConfig({ ...env, ONIDOT_SCOPE: old })), key014(home, old), old);
    assert.equal(stateDirectory(home, connectionConfig({ ...env, ONIDOT_SCOPE: renamed })), key014(home, old), renamed);
  }
  assert.equal(stateDirectory(home, connectionConfig(env)), key014(home, 'doraft:wiki:read offline_access'), 'default');
  assert.notEqual(stateDirectory(home, connectionConfig({ ...env, ONIDOT_SCOPE: 'onidot:wiki:read offline_access' })),
    stateDirectory(home, connectionConfig({ ...env, ONIDOT_SCOPE: 'onidot:wiki:read onidot:wiki:write offline_access' })), 'READ와 WRITE는 다른 로그인');
});

async function refreshWith(configured, answered) {
  Object.assign(process.env, env, { ONIDOT_SCOPE: configured });
  const dir = await mkdtemp(join(tmpdir(), 'onidot-scope-names-'));
  try {
    await writeState(dir, { schema: 1, issuer: 'https://app.example.invalid', resource: env.ONIDOT_MCP_URL, clientId: 'test-client',
      accessToken: 'fake-old-access-123456789', refreshToken: 'fake-refresh-123456789', expiresAt: 0, pendingRefresh: false });
    const response = { access_token: 'fake-new-access-123456789', refresh_token: 'fake-new-refresh-123456789', expires_in: 900, token_type: 'Bearer', scope: answered };
    const headers = await getHeaders({ dir, requestTokens: async () => response });
    const state = JSON.parse(await readFile(join(dir, 'tokens.json'), 'utf8'));
    return { headers, state };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('S1: 갱신 응답 scope는 새 이름이든 옛 이름이든 승인한 범위 안이면 받는다', async () => {
  for (const [configured, answered] of [
    // 0.14.0 설정을 그대로 둔 연결이 새 서버에서 갱신한다.
    ['doraft:wiki:read doraft:wiki:write offline_access', 'offline_access onidot:wiki:read onidot:wiki:write'],
    // 옛 서버.
    ['doraft:wiki:read doraft:wiki:write offline_access', 'doraft:wiki:read doraft:wiki:write offline_access'],
    ['onidot:wiki:read offline_access', 'offline_access onidot:wiki:read'],
    ['onidot:wiki:read offline_access', 'doraft:wiki:read offline_access'],
  ]) {
    const { headers, state } = await refreshWith(configured, answered);
    assert.equal(headers.Authorization, 'Bearer fake-new-access-123456789', `${configured} / ${answered}`);
    assert.equal(state.pendingRefresh, false);
    assert.equal(state.refreshToken, 'fake-new-refresh-123456789');
  }
});

test('S1: 승인보다 넓거나 읽기가 없거나 모르는 scope 응답은 거부한다', async () => {
  for (const [configured, answered] of [
    ['doraft:wiki:read offline_access', 'offline_access onidot:wiki:read onidot:wiki:write'],
    ['onidot:wiki:read offline_access', 'doraft:wiki:read doraft:wiki:write offline_access'],
    ['onidot:wiki:read onidot:wiki:write offline_access', 'offline_access onidot:wiki:write'],
    ['onidot:wiki:read onidot:wiki:write offline_access', 'onidot:wiki:admin onidot:wiki:read'],
    ['onidot:wiki:read onidot:wiki:write offline_access', 'Onidot:wiki:read'],
  ]) {
    await assert.rejects(refreshWith(configured, answered), /INVALID_OAUTH_TOKEN_RESPONSE/, `${configured} / ${answered}`);
  }
});

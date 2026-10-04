import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCodexOAuth } from '../scripts/verify-codex-oauth.mjs';

const expected = {
  marketplaceRoot: '/workspace/doraft/doraft-plugins',
  marketplaceSource: '/workspace/doraft/doraft-plugins',
  version: '0.8.0',
  installedVersion: '0.8.0',
  endpoint: 'https://mcp.onidot.dev',
  installedEndpoint: 'https://mcp.onidot.dev',
  advertisedResource: 'https://mcp.onidot.dev',
};

test('Codex 설치와 운영 OAuth 리소스가 모두 일치하면 통과한다', () => {
  assert.deepEqual(assessCodexOAuth(expected), []);
});

test('이동 전 마켓플레이스와 오래된 MCP 설치를 각각 진단한다', () => {
  assert.deepEqual(assessCodexOAuth({
    ...expected,
    marketplaceSource: '/workspace/doraft/doraft-system/packages/doraft-integrations',
    installedVersion: '0.5.0',
    installedEndpoint: 'https://api.doraft.com/mcp/wiki',
  }), ['MARKETPLACE_SOURCE_MISMATCH', 'PLUGIN_VERSION_MISMATCH', 'PLUGIN_ENDPOINT_MISMATCH']);
});

test('운영 OAuth resource가 바뀌면 설치가 최신이어도 실패한다', () => {
  assert.deepEqual(assessCodexOAuth({
    ...expected,
    advertisedResource: 'https://api.doraft.com/mcp/wiki',
  }), ['OAUTH_RESOURCE_MISMATCH']);
});

test('정식 Git 카탈로그 설치도 경로 일치로 인정한다', () => {
  assert.deepEqual(assessCodexOAuth({...expected, marketplaceSource:'https://github.com/onidot-labs/doraft-plugins.git'}), []);
  assert.ok(assessCodexOAuth({...expected, marketplaceSource:'https://github.com/doraft-labs/doraft.git'}).includes('MARKETPLACE_SOURCE_MISMATCH'));
});

test('helper 경로가 누락되거나 달라지면 설치 진단이 실패한다',()=>{
 assert.ok(assessCodexOAuth({...expected,expectedHelper:'node helper headers',installedHelper:undefined}).includes('OAUTH_HELPER_MISMATCH'));
});

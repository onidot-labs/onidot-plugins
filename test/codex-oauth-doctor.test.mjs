import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCodexOAuth, diagnosticTarget } from '../scripts/verify-codex-oauth.mjs';

const expected = {
  marketplaceRoot: '/workspace/onidot/onidot-plugins',
  marketplaceSource: '/workspace/onidot/onidot-plugins',
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
    marketplaceSource: '/workspace/retired/integrations',
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
  for(const suffix of ['', '.git'])
    assert.deepEqual(assessCodexOAuth({...expected, marketplaceSource:'https://github.com/onidot-labs/onidot-plugins'+suffix}), []);
  // 은퇴한 주소는 새 설치의 정식 소스로 인정하지 않는다.
  assert.ok(assessCodexOAuth({...expected, marketplaceSource:'https://github.com/onidot-labs/doraft-plugins.git'}).includes('MARKETPLACE_SOURCE_MISMATCH'));
});

test('helper 경로가 누락되거나 달라지면 설치 진단이 실패한다',()=>{
 assert.ok(assessCodexOAuth({...expected,expectedHelper:'node helper headers',installedHelper:undefined}).includes('OAUTH_HELPER_MISMATCH'));
});

test('진단은 지정한 별칭과 리소스만 선택하며 주소·비밀값·scope 추측을 하지 않는다', () => {
  assert.deepEqual(diagnosticTarget(['--alias', 'work', '--mcp-url', 'http://127.0.0.1:7777/mcp']), {
    name: 'onidot-work', endpoint: 'http://127.0.0.1:7777/mcp',
  });
  for (const args of [[], ['--alias', '../home', '--mcp-url', 'https://example.invalid'],
    ['--alias', 'home', '--mcp-url', 'http://example.invalid'],
    ['--alias', 'home', '--mcp-url', 'https://user:secret@example.invalid'],
    ['--alias', 'home', '--mcp-url', 'https://example.invalid?token=secret']]) assert.throws(() => diagnosticTarget(args));
});

test('진단 CLI는 명시한 별칭 등록과 로컬 OAuth metadata의 resource를 실제로 대조한다', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createServer } = await import('node:http');
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'onidot-doctor-'));
  let resource;
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.url, '/.well-known/oauth-protected-resource/mcp');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ resource }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
    resource = endpoint;
    const cache = join(dir, 'plugins/cache/onidot/onidot/0.14.0/.codex-plugin');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'plugin.json'), JSON.stringify({ name: 'onidot', version: '0.14.0', mcpServers: {} }));
    const mock = join(dir, 'codex.mjs');
    await writeFile(mock, `#!${process.execPath}\nconst args=process.argv.slice(2);\n` +
      `if(args.join(' ')==='plugin marketplace list --json') console.log(JSON.stringify({marketplaces:[{name:'onidot',marketplaceSource:{sourceType:'git',source:'https://github.com/onidot-labs/onidot-plugins'}}]}));\n` +
      `else if(args.join(' ')==='plugin list --marketplace onidot --json') console.log(JSON.stringify({installed:[{pluginId:'onidot@onidot',version:'0.14.0',enabled:true}]}));\n` +
      `else if(args.join(' ')==='mcp get onidot-work --json') console.log(JSON.stringify({enabled:true,transport:{type:'streamable_http',url:${JSON.stringify(endpoint)}}}));\n` +
      `else process.exit(9);\n`, { mode: 0o700 });
    const args = [new URL('../scripts/verify-codex-oauth.mjs', import.meta.url).pathname, '--alias', 'work', '--mcp-url', endpoint];
    const env = { ...process.env, CODEX_HOME: dir, CODEX_BIN: mock };
    const good = await run(process.execPath, args, { env });
    assert.match(good.stdout, /onidot-work/);
    assert.equal(calls, 1);
    resource = 'https://different.example.invalid';
    await assert.rejects(run(process.execPath, args, { env }), error => error.code === 1 && /OAUTH_RESOURCE_MISMATCH/.test(error.stderr));
    assert.equal(calls, 2);
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});

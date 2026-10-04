import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { config, getHeaders, writeState } from '../source/runtime/oauth-helper.mjs';
import { metadataUrl } from '../scripts/verify-codex-oauth.mjs';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const json = async path => JSON.parse(await read(path));

// W5 수용 기준: 설치 이름·루트 주소를 전환하고 외부 MCP/OAuth 계약은 보존한다.
test('onidot 설치와 OAuth 발급자·루트 리소스가 모든 산출물에 일치한다', async () => {
  const source = await json('source/wiki.json');
  assert.equal(source.name, 'onidot');
  assert.deepEqual(source.skills, ['setup-onidot', 'use-onidot']);
  assert.equal(source.endpoint, 'https://mcp.onidot.dev');
  assert.equal(config.issuer, 'https://app.onidot.dev');
  assert.equal(config.resource, source.endpoint);
  assert.equal(config.scope, 'doraft:wiki:read doraft:wiki:write offline_access');
  const manifest = await json('server-resources/wiki/manifest.json');
  assert.equal(manifest.issuer, config.issuer);
  assert.equal(manifest.resource, config.resource);
  assert.equal(manifest.product, 'wiki');
  assert.equal(metadataUrl(config.resource), 'https://mcp.onidot.dev/.well-known/oauth-protected-resource');
  assert.equal(metadataUrl('https://mcp.doraft.com/wiki'), 'https://mcp.doraft.com/.well-known/oauth-protected-resource/wiki');
  const codex = await json('plugins/onidot/.codex-plugin/plugin.json');
  assert.deepEqual(Object.keys(codex.mcpServers), ['onidot']);
  assert.ok(codex.mcpServers.onidot.http_headers_helper.includes(`/plugins/cache/onidot/onidot/${source.version}/scripts/oauth-helper.mjs`));
  assert.deepEqual(await readdir(new URL('../plugins/', import.meta.url)), ['onidot']);
});

test('은퇴한 주소와 이전 설치를 새 이름·주소로 안내한다', async () => {
  const retired = ['https://labs.onidot.com/wiki', 'https://mcp.doraft.com/wiki'];
  for (const path of ['README.md', 'source/skills/setup-onidot/SKILL.md']) {
    const text = await read(path);
    for (const marker of ['은퇴한 주소', ...retired, 'https://mcp.onidot.dev', 'onidot@onidot', 'doraft-wiki@doraft']) {
      assert.ok(text.includes(marker), `${path}: ${marker}`);
    }
  }
});

test('옛 issuer와 resource는 갱신 요청 없이 재로그인을 요구하고 상태를 보존한다', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'onidot-migration-test-'));
  try {
    for (const resource of ['https://labs.onidot.com/wiki', 'https://mcp.doraft.com/wiki', config.resource]) {
      await writeState(dir, { schema: 1, issuer: 'https://api.doraft.com', resource,
        clientId: 'test', accessToken: 'fake-access-token-123456', refreshToken: 'fake-refresh-token-123456', expiresAt: 0, pendingRefresh: false });
      const before = await readFile(join(dir, 'tokens.json'), 'utf8');
      await assert.rejects(getHeaders({ dir, requestTokens: async () => assert.fail('옛 토큰 전송 금지') }), /OAUTH_RESOURCE_CHANGED_RELOGIN_REQUIRED/);
      assert.equal(await readFile(join(dir, 'tokens.json'), 'utf8'), before);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('재생성과 패키징은 은퇴한 생성물을 제거하고 onidot ZIP만 배포한다', async () => {
  const { mkdtemp, rm, cp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const dir = await mkdtemp(join(tmpdir(), 'onidot-package-test-'));
  try {
    for (const path of ['source', 'scripts']) await cp(new URL('../' + path, import.meta.url), join(dir, path), { recursive: true });
    execFileSync(process.execPath, ['scripts/generate.mjs'], { cwd: dir });
    await mkdir(join(dir, 'plugins/doraft-wiki'), { recursive: true });
    await mkdir(join(dir, 'server-resources/wiki/skills/use-doraft-wiki'), { recursive: true });
    const check = spawnSync(process.execPath, ['scripts/generate.mjs', '--check'], { cwd: dir, encoding: 'utf8' });
    assert.equal(check.status, 1);
    assert.match(check.stderr, /은퇴한 생성물/);
    execFileSync(process.execPath, ['scripts/generate.mjs'], { cwd: dir });
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist/doraft-wiki-0.13.0.zip'), 'retired fixture');
    execFileSync(process.execPath, ['scripts/package.mjs'], { cwd: dir });
    assert.deepEqual((await readdir(join(dir, 'dist'))).sort(), ['SHA256SUMS', 'onidot-0.13.0.zip']);
    const archive = join(dir, 'dist/onidot-0.13.0.zip');
    const files = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
    for (const path of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'skills/setup-onidot/SKILL.md', 'skills/use-onidot/SKILL.md', 'scripts/oauth-helper.mjs']) assert.ok(files.split('\n').includes(path), path);
    assert.ok(!files.includes('doraft-wiki'));
    assert.ok(!files.includes('.mcp.json'));
    const manifest = JSON.parse(execFileSync('unzip', ['-p', archive, '.codex-plugin/plugin.json'], { encoding: 'utf8' }));
    assert.equal(manifest.name, 'onidot');
    assert.equal(manifest.mcpServers.onidot.url, config.resource);
    const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
    assert.equal(await readFile(join(dir, 'dist/SHA256SUMS'), 'utf8'), `${hash}  onidot-0.13.0.zip\n`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

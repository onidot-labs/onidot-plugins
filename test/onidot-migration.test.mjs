import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { config, getHeaders, writeState } from './oauth-fixture.mjs';
import { metadataUrl } from '../scripts/verify-codex-oauth.mjs';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const json = async path => JSON.parse(await read(path));

// W1-22P: names remain stable while connections move out of the package.
test('onidot 설치 이름과 서버 반입 product ID를 유지하고 인스턴스를 내장하지 않는다', async () => {
  const source = await json('source/wiki.json');
  assert.equal(source.name, 'onidot');
  assert.deepEqual(source.skills, ['setup-onidot', 'use-onidot', 'onidot-guide']);
  assert.equal('endpoint' in source, false);
  assert.equal(config.scope, 'onidot:wiki:read onidot:wiki:write offline_access');
  const manifest = await json('server-resources/wiki/manifest.json');
  assert.equal('issuer' in manifest, false);
  assert.equal('resource' in manifest, false);
  assert.equal(manifest.product, 'wiki');
  assert.equal(metadataUrl(config.resource), 'https://mcp.example.invalid/.well-known/oauth-protected-resource');
  assert.equal(metadataUrl('https://remote.example.invalid/wiki'), 'https://remote.example.invalid/.well-known/oauth-protected-resource/wiki');
  const codex = await json('plugins/onidot/.codex-plugin/plugin.json');
  assert.deepEqual(codex.mcpServers, {});
  assert.deepEqual(await readdir(new URL('../plugins/', import.meta.url)), ['onidot']);
});

test('이전 설치는 새 별칭의 연결을 먼저 검증한 뒤 교체하도록 안내한다', async () => {
  const text = await read('source/skills/setup-onidot/SKILL.md');
  for (const marker of ['onidot@onidot', 'doraft-wiki@doraft', '이전 주소', '실제 조회를 검증한 뒤', '다른 플러그인']) assert.ok(text.includes(marker), marker);
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
    await writeFile(join(dir, 'dist/onidot-0.13.0.zip'), 'retired instance-bound fixture');
    execFileSync(process.execPath, ['scripts/package.mjs'], { cwd: dir });
    assert.deepEqual((await readdir(join(dir, 'dist'))).sort(), ['SHA256SUMS', 'onidot-0.15.7.zip']);
    const archive = join(dir, 'dist/onidot-0.15.7.zip');
    const files = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
    for (const path of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'skills/setup-onidot/SKILL.md', 'skills/use-onidot/SKILL.md', 'scripts/oauth-helper.mjs', 'scripts/recording-check.sh', 'claude/hooks.json', 'claude/session-start.json', 'codex/hooks.json']) assert.ok(files.split('\n').includes(path), path);
    assert.ok(!files.split('\n').includes('hooks/hooks.json'));
    assert.ok(!files.includes('doraft-wiki'));
    assert.ok(!files.includes('.mcp.json'));
    const manifest = JSON.parse(execFileSync('unzip', ['-p', archive, '.codex-plugin/plugin.json'], { encoding: 'utf8' }));
    assert.equal(manifest.name, 'onidot');
    assert.deepEqual(manifest.mcpServers, {});
    const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
    assert.equal(await readFile(join(dir, 'dist/SHA256SUMS'), 'utf8'), `${hash}  onidot-0.15.7.zip\n`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

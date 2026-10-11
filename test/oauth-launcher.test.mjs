import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { install } from '../source/runtime/oauth-helper-install.mjs';

const run = promisify(execFile);
const here = new URL('../source/runtime/', import.meta.url).pathname;
const tmp = async () => realpath(await mkdtemp(join(tmpdir(), 'onidot-launcher-')));
// 가짜 도우미: 자기 버전 표식, 인자, 환경, 종료 코드를 출력한다.
const fakeHelper = (label, code = 0) => `process.stdout.write(JSON.stringify({label:${JSON.stringify(label)},args:process.argv.slice(2),alias:process.env.ONIDOT_ALIAS??null,codexHome:process.env.CODEX_HOME??null})+'\\n');process.stderr.write('child-stderr\\n');process.exitCode=${code};\n`;
async function layout(home, versions, { fallback } = {}) {
  const bin = join(home, 'onidot-oauth/bin');
  await mkdir(bin, { recursive: true });
  await copyFile(join(here, 'oauth-launcher.mjs'), join(bin, 'oauth-helper.mjs'));
  for (const v of versions) {
    const dir = join(home, 'plugins/cache/onidot/onidot', v, 'scripts');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'oauth-helper.mjs'), fakeHelper(v));
  }
  if (fallback) await writeFile(join(bin, 'oauth-helper-fallback.mjs'), fakeHelper('fallback', fallback === 'fail' ? 3 : 0));
  return join(bin, 'oauth-helper.mjs');
}
const exec = (launcher, args, env = {}) => run(process.execPath, [launcher, ...args], { env: { PATH: process.env.PATH, ...env } }).catch((e) => e);

test('캐시된 여러 버전 중 semver가 가장 높은 도우미를 숫자로 비교해 실행한다', async () => {
  const home = await tmp();
  try {
    const launcher = await layout(home, ['0.15.9', '0.15.10', '0.9.0', 'junk', '0.15.10-beta']);
    const r = await exec(launcher, ['headers'], { ONIDOT_ALIAS: 'dev' });
    assert.equal(r.code ?? 0, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.label, '0.15.10');
    assert.deepEqual(out.args, ['headers']);
    assert.equal(out.alias, 'dev');
    // 실행기 위치에서 계산한 codex home을 자식 환경에 전달한다(CODEX_HOME이 없어도).
    assert.equal(out.codexHome, home);
    assert.equal(r.stdout.trim().split('\n').length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('캐시에 도우미가 없으면 설치 때 복사해 둔 사본으로 실행한다', async () => {
  const home = await tmp();
  try {
    const launcher = await layout(home, [], { fallback: true });
    const r = await exec(launcher, ['status']);
    assert.equal(JSON.parse(r.stdout).label, 'fallback');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('도우미의 종료 코드를 그대로 전달하고 stdout에는 도우미 출력만 나간다', async () => {
  const home = await tmp();
  try {
    const launcher = await layout(home, [], { fallback: 'fail' });
    const r = await exec(launcher, ['headers']);
    assert.equal(r.code, 3);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.match(r.stderr, /child-stderr/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('캐시도 사본도 없으면 stdout 없이 분명한 오류와 종료 코드 1', async () => {
  const home = await tmp();
  try {
    const launcher = await layout(home, []);
    const r = await exec(launcher, ['headers']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /ONIDOT_HELPER_NOT_FOUND/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

const lines = (text) => text.trim().split('\n');
test('설치: 새 설치는 실행기와 사본을 쓰고 config 한 줄에 절대경로를 낸다', async () => {
  const home = await tmp();
  try {
    const r = await install({ codexHome: home });
    assert.equal(r.conflicts.length, 0);
    const bin = join(home, 'onidot-oauth/bin');
    assert.equal(await readFile(join(bin, 'oauth-helper.mjs'), 'utf8'), await readFile(join(here, 'oauth-launcher.mjs'), 'utf8'));
    assert.equal(await readFile(join(bin, 'oauth-helper-fallback.mjs'), 'utf8'), await readFile(join(here, 'oauth-helper.mjs'), 'utf8'));
    assert.equal(lines(r.configLine).length, 1);
    assert.ok(r.configLine.startsWith('http_headers_helper = '));
    assert.ok(r.configLine.includes(`node "${join(bin, 'oauth-helper.mjs')}" headers`));
    for (const p of ['<별칭>', '<APP_URL>', '<MCP_URL>', '<SCOPE>']) assert.ok(r.configLine.includes(p), p);
    assert.ok(!/\d+\.\d+\.\d+/.test(r.configLine));
    // 설치된 실행기는 CLI로도 설치 명령이 출력하는 줄과 같은 stdout을 낸다.
    const cli = await run(process.execPath, [join(here, 'oauth-helper-install.mjs'), '--codex-home', home]);
    assert.equal(cli.stdout.trim(), r.configLine);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('설치: 우리가 쓴 파일은 재설치로 갱신하고 사용자가 고친 파일은 충돌로 남긴다', async () => {
  const home = await tmp();
  try {
    await install({ codexHome: home });
    const bin = join(home, 'onidot-oauth/bin');
    // 이전 버전이 쓴 파일(기록과 같은 해시)은 갱신된다: 기록을 옛 내용으로 맞춰 시뮬레이션.
    const again = await install({ codexHome: home });
    assert.deepEqual(again.results.map((x) => x.action), ['변경 없음', '변경 없음']);
    await writeFile(join(bin, 'oauth-helper.mjs'), '// user edit\n');
    const conflict = await install({ codexHome: home });
    assert.equal(conflict.conflicts.length, 1);
    assert.equal(conflict.conflicts[0].name, 'oauth-helper.mjs');
    assert.equal(await readFile(join(bin, 'oauth-helper.mjs'), 'utf8'), '// user edit\n');
    const cli = await run(process.execPath, [join(here, 'oauth-helper-install.mjs'), '--codex-home', home]).catch((e) => e);
    assert.equal(cli.code, 1);
    assert.equal(cli.stdout, '');
    assert.match(cli.stderr, /충돌/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('설치: 기록과 해시가 같은 옛 내용은 새 내용으로 갱신된다', async () => {
  const home = await tmp();
  try {
    await install({ codexHome: home });
    const bin = join(home, 'onidot-oauth/bin');
    const { createHash } = await import('node:crypto');
    const old = '// old launcher\n';
    await writeFile(join(bin, 'oauth-helper.mjs'), old);
    const recordPath = join(bin, '.onidot-helper.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    record.files['oauth-helper.mjs'] = createHash('sha256').update(old).digest('hex');
    await writeFile(recordPath, JSON.stringify(record));
    const r = await install({ codexHome: home });
    assert.equal(r.results.find((x) => x.name === 'oauth-helper.mjs').action, '갱신');
    assert.equal(await readFile(join(bin, 'oauth-helper.mjs'), 'utf8'), await readFile(join(here, 'oauth-launcher.mjs'), 'utf8'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('설치된 실행기와 사본은 설치 직후 캐시 없이도 동작한다', async () => {
  const home = await tmp();
  try {
    await install({ codexHome: home });
    const r = await exec(join(home, 'onidot-oauth/bin/oauth-helper.mjs'), ['headers']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ONIDOT_CONNECTION_REQUIRED/);
    assert.equal(r.stdout, '');
  } finally { await rm(home, { recursive: true, force: true }); }
});

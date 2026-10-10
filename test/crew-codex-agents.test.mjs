import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (text) => createHash('sha256').update(text).digest('hex');

// 패키지 모양(scripts, codex/agents, .claude-plugin)을 임시 디렉터리에 만든다.
async function fixture(files = { 'crew-a.toml': 'a1\n', 'crew-b.toml': 'b1\n' }, version = '1.0.0') {
  const dir = await mkdtemp(join(tmpdir(), 'crew-agents-'));
  const pkg = join(dir, 'pkg'), home = join(dir, 'home');
  await mkdir(join(pkg, 'scripts'), { recursive: true });
  await cp(join(root, 'source/crew/runtime/codex-agents.mjs'), join(pkg, 'scripts/codex-agents.mjs'));
  const f = { pkg, home, agents: join(home, 'agents'), dir };
  await setPackage(f, files, version);
  return f;
}
async function setPackage(f, files, version) {
  await rm(join(f.pkg, 'codex'), { recursive: true, force: true });
  await mkdir(join(f.pkg, 'codex/agents'), { recursive: true });
  await mkdir(join(f.pkg, '.claude-plugin'), { recursive: true });
  await writeFile(join(f.pkg, '.claude-plugin/plugin.json'), JSON.stringify({ version }));
  for (const [name, text] of Object.entries(files)) await writeFile(join(f.pkg, 'codex/agents', name), text);
}
const run = (f, args, env = {}) => {
  const r = spawnSync(process.execPath, [join(f.pkg, 'scripts/codex-agents.mjs'), ...args], {
    encoding: 'utf8', env: { ...process.env, CODEX_HOME: '', ...env } });
  return r;
};
const runHome = (f, command, ...extra) => run(f, [command, '--codex-home', f.home, '--json', ...extra]);
const parse = (r) => JSON.parse(r.stdout);
const record = async (f) => JSON.parse(await readFile(join(f.agents, '.onidot-crew.json'), 'utf8'));
const text = (f, name) => readFile(join(f.agents, name), 'utf8');

test('새 설치는 파일과 형식에 맞는 설치 기록을 만든다', async () => {
  const f = await fixture();
  const r = runHome(f, 'install');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await text(f, 'crew-a.toml'), 'a1\n');
  assert.deepEqual(await record(f), { schemaVersion: 1, package: 'onidot-crew', version: '1.0.0',
    files: { 'crew-a.toml': sha('a1\n'), 'crew-b.toml': sha('b1\n') } });
  assert.deepEqual((await readdir(f.agents)).filter((n) => n.endsWith('.tmp')), []);
});

test('재설치는 멱등이다', async () => {
  const f = await fixture();
  runHome(f, 'install');
  const before = await readFile(join(f.agents, '.onidot-crew.json'), 'utf8');
  const r = runHome(f, 'install');
  assert.equal(r.status, 0);
  assert.deepEqual(parse(r).results.map((x) => x.action), ['변경 없음', '변경 없음']);
  assert.equal(await readFile(join(f.agents, '.onidot-crew.json'), 'utf8'), before);
});

test('사용자의 동명 파일은 충돌로 보존하고 기록에 넣지 않는다', async () => {
  const f = await fixture();
  await mkdir(f.agents, { recursive: true });
  await writeFile(join(f.agents, 'crew-a.toml'), 'mine\n');
  const r = runHome(f, 'install');
  assert.equal(r.status, 0);
  assert.equal(parse(r).conflicts, 1);
  assert.equal(await text(f, 'crew-a.toml'), 'mine\n');
  assert.deepEqual(Object.keys((await record(f)).files), ['crew-b.toml']);
  assert.equal(parse(runHome(f, 'status')).results.find((x) => x.name === 'crew-a.toml').state, '충돌(사용자 파일)');
  const human = run(f, ['install', '--codex-home', f.home]);
  assert.match(human.stdout, /충돌/);
});

test('우리가 놓은 파일을 사용자가 고쳤으면 갱신하지 않고 보존한다', async () => {
  const f = await fixture();
  runHome(f, 'install');
  await writeFile(join(f.agents, 'crew-a.toml'), 'edited\n');
  await setPackage(f, { 'crew-a.toml': 'a2\n', 'crew-b.toml': 'b1\n' }, '1.1.0');
  const r = runHome(f, 'install');
  assert.equal(parse(r).conflicts, 1);
  assert.equal(await text(f, 'crew-a.toml'), 'edited\n');
  assert.ok(!('crew-a.toml' in (await record(f)).files));
});

test('버전을 올리면 교체하고 사라진 파일은 지운다', async () => {
  const f = await fixture();
  runHome(f, 'install');
  await setPackage(f, { 'crew-a.toml': 'a2\n', 'crew-c.toml': 'c1\n' }, '2.0.0');
  assert.equal(parse(runHome(f, 'status')).results.find((x) => x.name === 'crew-a.toml').state, '최신 아님');
  const r = runHome(f, 'install');
  assert.equal(r.status, 0);
  assert.equal(await text(f, 'crew-a.toml'), 'a2\n');
  assert.equal(await text(f, 'crew-c.toml'), 'c1\n');
  assert.deepEqual((await readdir(f.agents)).sort(), ['.onidot-crew.json', 'crew-a.toml', 'crew-c.toml']);
  const rec = await record(f);
  assert.equal(rec.version, '2.0.0');
  assert.deepEqual(Object.keys(rec.files).sort(), ['crew-a.toml', 'crew-c.toml']);
});

test('사라진 파일을 사용자가 고쳤으면 지우지 않는다', async () => {
  const f = await fixture();
  runHome(f, 'install');
  await writeFile(join(f.agents, 'crew-b.toml'), 'edited\n');
  await setPackage(f, { 'crew-a.toml': 'a1\n' }, '2.0.0');
  runHome(f, 'install');
  assert.equal(await text(f, 'crew-b.toml'), 'edited\n');
  assert.deepEqual(Object.keys((await record(f)).files), ['crew-a.toml']);
});

test('uninstall은 고친 파일을 남기고 기록을 지운다', async () => {
  const f = await fixture();
  runHome(f, 'install');
  await writeFile(join(f.agents, 'crew-a.toml'), 'edited\n');
  const r = runHome(f, 'uninstall');
  assert.equal(r.status, 0);
  assert.equal(parse(r).kept, 1);
  assert.deepEqual((await readdir(f.agents)).sort(), ['crew-a.toml']);
  assert.match(run(f, ['uninstall', '--codex-home', f.home]).stdout, /기록이 없어/);
});

test('crew- 접두어가 아닌 파일, 하위 디렉터리, 다른 플러그인 파일은 건드리지 않는다', async () => {
  const f = await fixture({ 'crew-a.toml': 'a1\n', 'other.toml': 'x\n' });
  await mkdir(join(f.agents, 'crew-dir.toml'), { recursive: true });
  await mkdir(join(f.agents, 'sub'), { recursive: true });
  await writeFile(join(f.agents, 'mine.toml'), 'm\n');
  await writeFile(join(f.agents, 'other-plugin.json'), '{}');
  await writeFile(join(f.agents, 'sub/crew-z.toml'), 'z\n');
  assert.equal(runHome(f, 'install').status, 0);
  assert.equal((await readdir(f.agents)).includes('other.toml'), false);
  await setPackage(f, { 'crew-a.toml': 'a1\n' }, '2.0.0');
  runHome(f, 'install');
  assert.equal(runHome(f, 'uninstall').status, 0);
  assert.deepEqual((await readdir(f.agents)).sort(), ['crew-dir.toml', 'mine.toml', 'other-plugin.json', 'sub']);
  assert.equal(await readFile(join(f.agents, 'sub/crew-z.toml'), 'utf8'), 'z\n');
});

test('변조된 기록의 경로 이탈 이름은 무시한다', async () => {
  const f = await fixture();
  await mkdir(f.agents, { recursive: true });
  await writeFile(join(f.home, 'victim.txt'), 'v');
  await writeFile(join(f.agents, '.onidot-crew.json'), JSON.stringify({ schemaVersion: 1, package: 'onidot-crew', version: '0',
    files: { '../victim.txt': sha('v') } }));
  assert.equal(runHome(f, 'uninstall').status, 0);
  assert.equal(await readFile(join(f.home, 'victim.txt'), 'utf8'), 'v');
});

test('입력 오류는 종료 코드 1이다', async () => {
  const f = await fixture();
  assert.equal(run(f, ['bogus']).status, 1);
  assert.equal(run(f, ['install', '--nope']).status, 1);
  assert.equal(run(f, ['install', '--codex-home', f.home, '--source', join(f.dir, 'missing')]).status, 1);
  await mkdir(f.agents, { recursive: true });
  await writeFile(join(f.agents, '.onidot-crew.json'), '{broken');
  assert.equal(runHome(f, 'status').status, 1);
});

test('대상 위치는 --codex-home, CODEX_HOME, 기본값 순으로 정한다', async () => {
  const f = await fixture();
  const viaEnv = join(f.dir, 'env-home');
  assert.equal(run(f, ['install'], { CODEX_HOME: viaEnv }).status, 0);
  assert.equal(await text({ agents: join(viaEnv, 'agents') }, 'crew-a.toml'), 'a1\n');
  const viaFlag = join(f.dir, 'flag-home');
  assert.equal(run(f, ['install', '--codex-home', viaFlag], { CODEX_HOME: viaEnv }).status, 0);
  assert.equal(await text({ agents: join(viaFlag, 'agents') }, 'crew-b.toml'), 'b1\n');
  // 기본값은 HOME 아래 .codex다. HOME을 임시 디렉터리로 돌려 실제 홈을 건드리지 않는다.
  const fakeHome = join(f.dir, 'fake-home');
  await mkdir(fakeHome);
  assert.equal(run(f, ['install'], { HOME: fakeHome, USERPROFILE: fakeHome }).status, 0);
  assert.equal(await text({ agents: join(fakeHome, '.codex/agents') }, 'crew-a.toml'), 'a1\n');
});

// 사전 로드 모듈로 N번째 기록 rename을 실패시킨다. 1번째는 파일을 쓰기 전 대기 기록, 2번째는 최종 기록이다.
const failRecord = pathToFileURL(join(root, 'test/fixtures/fail-record-rename.mjs')).href;
const runFailing = (f, at, command = 'install') => spawnSync(process.execPath,
  ['--import', failRecord, join(f.pkg, 'scripts/codex-agents.mjs'), command, '--codex-home', f.home, '--json'],
  { encoding: 'utf8', env: { ...process.env, CODEX_HOME: '', FAIL_RECORD_AT: String(at) } });
const LOCK = '.onidot-crew.lock';

test('최종 기록 쓰기가 실패하면 exit 1로 알리고 다음 실행에서 대기 기록으로 소유를 회수한다', async () => {
  const f = await fixture();
  const r = runFailing(f, 2);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /기록 실패/);
  assert.match(r.stderr, /파일 2개 설치됨/);
  assert.equal(await text(f, 'crew-a.toml'), 'a1\n');
  const pending = await record(f);
  assert.deepEqual(pending.files, {});
  assert.deepEqual(pending.pending, { 'crew-a.toml': sha('a1\n'), 'crew-b.toml': sha('b1\n') });
  // 대기 기록과 해시가 같으면 사용자 파일이 아니라 우리 파일로 보고 이어서 관리한다.
  assert.equal(parse(runHome(f, 'status')).results.find((x) => x.name === 'crew-a.toml').state, '설치됨');
  const again = runHome(f, 'install');
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(parse(again).results.map((x) => x.action), ['변경 없음', '변경 없음']);
  assert.deepEqual(await record(f), { schemaVersion: 1, package: 'onidot-crew', version: '1.0.0',
    files: { 'crew-a.toml': sha('a1\n'), 'crew-b.toml': sha('b1\n') } });
});

test('파일을 쓰기 전 대기 기록이 실패하면 아무 파일도 놓지 않고 exit 1이다', async () => {
  const f = await fixture();
  const r = runFailing(f, 1);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /기록 실패/);
  assert.match(r.stderr, /파일 0개 설치됨/);
  assert.deepEqual((await readdir(f.agents)).filter((n) => n.startsWith('crew-')), []);
  assert.equal((await readdir(f.agents)).includes(LOCK), false);
});

test('기록 경로가 디렉터리면 exit 1이고 파일을 놓지 않는다', async () => {
  const f = await fixture();
  await mkdir(join(f.agents, '.onidot-crew.json'), { recursive: true });
  const r = runHome(f, 'install');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /실행 실패|입력 오류/);
  assert.deepEqual((await readdir(f.agents)).filter((n) => n.startsWith('crew-')), []);
});

test('다른 설치가 잠금을 잡고 있으면 install·uninstall을 거부하고 잠금을 남긴다', async () => {
  const f = await fixture();
  await mkdir(f.agents, { recursive: true });
  // 살아 있는 PID(이 시험 프로세스)가 잡은 잠금이다.
  const lock = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  await writeFile(join(f.agents, LOCK), lock);
  for (const command of ['install', 'uninstall']) {
    const r = runHome(f, command);
    assert.equal(r.status, 1, command);
    assert.match(r.stderr, /다른 설치가 진행 중/);
    assert.match(r.stderr, new RegExp(`PID ${process.pid}`));
  }
  assert.equal(await readFile(join(f.agents, LOCK), 'utf8'), lock);
  assert.deepEqual((await readdir(f.agents)).filter((n) => n.startsWith('crew-')), []);
  // PID가 없는 잠금은 자동으로 지우지 않고 처리 방법을 안내한다.
  await writeFile(join(f.agents, LOCK), 'garbage');
  const unknown = runHome(f, 'install');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /잠금 파일을 지운 뒤 다시 실행/);
  assert.equal(await readFile(join(f.agents, LOCK), 'utf8'), 'garbage');
});

test('끝난 프로세스의 잠금은 안내 후 치우고 설치하며, 끝나면 잠금을 해제한다', async () => {
  const f = await fixture();
  await mkdir(f.agents, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  await writeFile(join(f.agents, LOCK), JSON.stringify({ pid: dead, startedAt: new Date(0).toISOString() }));
  const r = runHome(f, 'install');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /끝난 프로세스/);
  assert.equal(await text(f, 'crew-a.toml'), 'a1\n');
  assert.equal((await readdir(f.agents)).includes(LOCK), false);
});

test('대상이 심볼릭 링크면 끊어졌든 아니든 충돌로 두고 건드리지 않는다', async () => {
  const f = await fixture();
  await mkdir(f.agents, { recursive: true });
  const target = join(f.dir, 'target.toml');
  await writeFile(target, 'target\n');
  await symlink(target, join(f.agents, 'crew-a.toml'));
  await symlink(join(f.dir, 'missing.toml'), join(f.agents, 'crew-b.toml'));
  const r = runHome(f, 'install');
  assert.equal(r.status, 0, r.stderr);
  const out = parse(r);
  assert.equal(out.conflicts, 2);
  assert.deepEqual(out.results.map((x) => x.action), ['충돌', '충돌']);
  for (const name of ['crew-a.toml', 'crew-b.toml']) assert.ok((await lstat(join(f.agents, name))).isSymbolicLink(), name);
  assert.equal(await readFile(target, 'utf8'), 'target\n');
  assert.deepEqual((await record(f)).files, {});
  assert.ok(parse(runHome(f, 'status')).results.every((x) => x.state.startsWith('충돌')));
});

test('다른 파일이 같은 역할 이름을 쓰면 그 역할은 설치하지 않는다', async () => {
  const f = await fixture({ 'crew-a.toml': 'name = "crew-a"\nx = 1\n', 'crew-b.toml': 'name = "crew-b"\nx = 1\n' });
  await mkdir(f.agents, { recursive: true });
  await writeFile(join(f.agents, 'mine.toml'), '# 내 역할\nname = "crew-a"\n');
  const r = runHome(f, 'install');
  assert.equal(r.status, 0, r.stderr);
  const out = parse(r);
  assert.equal(out.conflicts, 1);
  const a = out.results.find((x) => x.name === 'crew-a.toml');
  assert.equal(a.action, '충돌');
  assert.match(a.detail, /mine\.toml/);
  assert.deepEqual((await readdir(f.agents)).filter((n) => n.startsWith('crew-')), ['crew-b.toml']);
  assert.deepEqual(Object.keys((await record(f)).files), ['crew-b.toml']);
  assert.equal(await readFile(join(f.agents, 'mine.toml'), 'utf8'), '# 내 역할\nname = "crew-a"\n');
});

test('생성된 crew 패키지에서 같은 스크립트로 실제 역할 17개를 설치한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crew-real-'));
  const script = join(root, 'plugins/onidot-crew/scripts/codex-agents.mjs');
  assert.equal(await readFile(script, 'utf8'), await readFile(join(root, 'source/crew/runtime/codex-agents.mjs'), 'utf8'));
  const r = spawnSync(process.execPath, [script, 'install', '--codex-home', dir, '--json'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: '' } });
  assert.equal(r.status, 0, r.stderr);
  const files = (await readdir(join(dir, 'agents'))).filter((n) => n.startsWith('crew-'));
  assert.equal(files.length, 17);
});

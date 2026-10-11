#!/usr/bin/env node
// 버전과 무관한 고정 경로 실행기. Codex의 http_headers_helper가 이 파일을 가리킨다.
// 실행할 때마다 플러그인 캐시에서 semver가 가장 높은 oauth-helper.mjs를 골라 같은 인자·환경으로 실행한다.
// 캐시에 없으면 설치 때 같은 폴더에 복사해 둔 사본을 쓴다. stdout에는 도우미의 출력만 나간다.
import { readdirSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const compare = (a, b) => { for (let i = 1; i <= 3; i++) { const d = Number(a[i]) - Number(b[i]); if (d) return d; } return 0; };

export function pickHelper(codexHome, fallbackDir) {
  const cache = join(codexHome, 'plugins/cache/onidot/onidot');
  let versions = [];
  try {
    versions = readdirSync(cache, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SEMVER.test(entry.name))
      .map((entry) => ({ name: entry.name, match: SEMVER.exec(entry.name) }))
      .filter((v) => existsSync(join(cache, v.name, 'scripts/oauth-helper.mjs')))
      .sort((a, b) => compare(b.match, a.match));
  } catch { /* 캐시 없음 */ }
  if (versions.length) return join(cache, versions[0].name, 'scripts/oauth-helper.mjs');
  const copy = join(fallbackDir, 'oauth-helper-fallback.mjs');
  return existsSync(copy) ? copy : null;
}

function main() {
  const bin = dirname(fileURLToPath(import.meta.url));
  // bin의 두 단계 위가 codex home이다(<home>/onidot-oauth/bin). 환경변수에 의존하지 않는다.
  const codexHome = resolve(bin, '../..');
  const helper = pickHelper(codexHome, bin);
  if (!helper) {
    process.stderr.write('onidot OAuth: ONIDOT_HELPER_NOT_FOUND (플러그인 캐시와 사본에 도우미가 없습니다. oauth-helper-install.mjs를 다시 실행하세요)\n');
    process.exitCode = 1;
    return;
  }
  const result = spawnSync(process.execPath, [helper, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: codexHome } });
  if (result.error) { process.stderr.write(`onidot OAuth: ONIDOT_HELPER_START_FAILED ${result.error.code ?? ''}\n`); process.exitCode = 1; return; }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();

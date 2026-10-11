import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const marketplaceName = 'onidot';
const pluginName = 'onidot';

export function diagnosticTarget(args) {
  if (args.length !== 4 || args[0] !== '--alias' || args[2] !== '--mcp-url' || !/^[a-z][a-z0-9-]{0,63}$/.test(args[1])) {
    throw new Error('사용법: npm run verify:codex -- --alias <별칭> --mcp-url <선택한 MCP URL>');
  }
  const url = new URL(args[3]);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('INVALID_ONIDOT_URL');
  return { name: `onidot-${args[1]}`, endpoint: args[3] };
}

// config.toml의 http_headers_helper 명령을 본다. 고정 실행기가 정상이고, 버전이 박힌 플러그인 캐시 경로는
// 갱신 때 사라질 수 있어 이전 대상이다(경로가 이미 없으면 지금 인증 헤더가 비어 401이 쌓이는 상태다).
export function assessHelperCommand(command, { codexHome, exists = existsSync } = {}) {
  if (!command) return [];
  const fixed = `${resolve(codexHome, 'onidot-oauth/bin/oauth-helper.mjs')}`;
  if (command.includes(fixed)) return exists(fixed) ? [] : ['OAUTH_HELPER_LAUNCHER_MISSING'];
  const versioned = /(["'\s=]|^)([^"'\s]*\/plugins\/cache\/onidot\/onidot\/\d+\.\d+\.\d+\/scripts\/oauth-helper\.mjs)/.exec(command);
  if (versioned) return [exists(versioned[2]) ? 'OAUTH_HELPER_VERSIONED_PATH' : 'OAUTH_HELPER_VERSIONED_PATH_GONE'];
  return [];
}
export const helperAdvice = {
  OAUTH_HELPER_LAUNCHER_MISSING: '고정 실행기 파일이 없습니다. 플러그인의 scripts/oauth-helper-install.mjs를 다시 실행하세요.',
  OAUTH_HELPER_VERSIONED_PATH_GONE: 'http_headers_helper가 이미 지워진 버전별 캐시 경로를 가리킵니다. 지금 인증 헤더가 비어 서버에 401이 쌓입니다. oauth-helper-install.mjs를 실행하고 출력된 고정 경로로 config.toml을 바꾸세요(로그인은 다시 하지 않아도 됩니다).',
  OAUTH_HELPER_VERSIONED_PATH: 'http_headers_helper가 버전별 캐시 경로를 가리킵니다. 플러그인을 갱신하면 사라집니다. oauth-helper-install.mjs를 실행하고 출력된 고정 경로로 바꾸세요.',
};

export function assessCodexOAuth(values) {
  const failures = [];
  if (![values.marketplaceRoot, 'https://github.com/onidot-labs/onidot-plugins.git', 'https://github.com/onidot-labs/onidot-plugins'].includes(values.marketplaceSource)) failures.push('MARKETPLACE_SOURCE_MISMATCH');
  if (values.installedVersion !== values.version) failures.push('PLUGIN_VERSION_MISMATCH');
  if (values.installedEndpoint !== values.endpoint) failures.push('PLUGIN_ENDPOINT_MISMATCH');
  if (values.advertisedResource !== values.endpoint) failures.push('OAUTH_RESOURCE_MISMATCH');
  if (values.expectedHelper && values.installedHelper !== values.expectedHelper) failures.push('OAUTH_HELPER_MISMATCH');
  if (values.helperCommand) failures.push(...assessHelperCommand(values.helperCommand, { codexHome: values.codexHome, exists: values.helperExists }));
  return failures;
}

export const metadataUrl = (endpoint) => { const url = new URL(endpoint); return `${url.origin}/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`; };
const json = (path) => readFile(path, 'utf8').then(JSON.parse);
const codex = (...args) => {
  try {
    return JSON.parse(execFileSync(process.env.CODEX_BIN || 'codex', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    throw new Error('Codex 설정 목록을 읽지 못했습니다. CLI와 해당 marketplace 또는 MCP 등록을 확인하세요.');
  }
};

// [mcp_servers.<name>] 표의 http_headers_helper 값을 읽는다. 없거나 파일이 없으면 undefined.
export async function readHelperCommand(path, name) {
  const text = await readFile(path, 'utf8').catch(() => '');
  let inTable = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { inTable = header[1].trim().replace(/"/g, '') === `mcp_servers.${name}`; continue; }
    const m = inTable && /^\s*http_headers_helper\s*=\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/.exec(line);
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

async function main() {
  const target = diagnosticTarget(process.argv.slice(2));
  const source = await json(resolve(root, 'source/wiki.json'));
  const manifest = await json(resolve(root, `plugins/${pluginName}/.codex-plugin/plugin.json`));
  if (Object.keys(manifest.mcpServers || {}).length) throw new Error('패키지가 인스턴스를 내장합니다. npm run generate를 실행하세요.');

  const marketplaces = codex('plugin', 'marketplace', 'list', '--json').marketplaces;
  const marketplace = marketplaces.find((item) => item.name === marketplaceName);
  const marketplaceSource = marketplace?.marketplaceSource?.sourceType === 'local'
    ? resolve(marketplace.marketplaceSource.source) : marketplace?.marketplaceSource?.source;
  const marketplaceRoot = resolve(root);
  // The installed list depends on a valid marketplace root; report the source mismatch first.
  if (assessCodexOAuth({ marketplaceSource, marketplaceRoot }).includes('MARKETPLACE_SOURCE_MISMATCH')) {
    throw new Error(`MARKETPLACE_SOURCE_MISMATCH: Codex의 ${marketplaceName} 마켓플레이스를 현재 경로로 다시 등록하세요: ${marketplaceRoot}`);
  }

  const installed = codex('plugin', 'list', '--marketplace', marketplaceName, '--json').installed
    .find((item) => item.pluginId === `${pluginName}@${marketplaceName}`);
  if (!installed?.enabled) throw new Error('Codex onidot 플러그인이 설치·활성화되지 않았습니다. codex plugin add onidot@onidot를 실행하세요.');
  const cachedManifestPath = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'plugins/cache', marketplaceName, pluginName, installed.version, '.codex-plugin/plugin.json');
  const cachedManifest = await json(cachedManifestPath).catch(() => null);
  if (!cachedManifest || cachedManifest.name !== pluginName || cachedManifest.version !== source.version || Object.keys(cachedManifest.mcpServers || {}).length) throw new Error('INSTALLED_MANIFEST_MISMATCH: 인스턴스 무관 플러그인을 다시 설치하세요.');
  const registration = codex('mcp', 'get', target.name, '--json');
  if (registration.enabled === false || registration.transport?.url !== target.endpoint) throw new Error('MCP_REGISTRATION_MISMATCH');
  const metadataResponse = await fetch(metadataUrl(target.endpoint), { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!metadataResponse.ok) throw new Error(`선택한 서버의 OAuth 메타데이터 조회에 실패했습니다: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const codexHome = process.env.CODEX_HOME || resolve(homedir(), '.codex');
  const helperCommand = await readHelperCommand(resolve(codexHome, 'config.toml'), target.name);
  const failures = assessCodexOAuth({
    helperCommand, codexHome,
    marketplaceRoot, marketplaceSource,
    version: source.version, installedVersion: installed.version,
    endpoint: target.endpoint,
    installedEndpoint: registration.transport.url,
    advertisedResource: metadata.resource,
  });
  if (failures.length) throw new Error(`${failures.join(', ')}: ${failures.map((code) => helperAdvice[code]).filter(Boolean).join(' ') || '플러그인을 다시 설치하고 OAuth 재연결을 확인하세요.'}`);
  process.stdout.write(`Codex onidot OAuth 경로 일치: ${source.version}, ${target.name}, ${target.endpoint}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

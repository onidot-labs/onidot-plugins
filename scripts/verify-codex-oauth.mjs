import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const marketplaceName = 'doraft';
const pluginName = 'doraft-wiki';

export function assessCodexOAuth(values) {
  const failures = [];
  if (![values.marketplaceRoot, 'https://github.com/doraft-labs/doraft-plugins.git', 'https://github.com/doraft-labs/doraft-plugins'].includes(values.marketplaceSource)) failures.push('MARKETPLACE_SOURCE_MISMATCH');
  if (values.installedVersion !== values.version) failures.push('PLUGIN_VERSION_MISMATCH');
  if (values.installedEndpoint !== values.endpoint) failures.push('PLUGIN_ENDPOINT_MISMATCH');
  if (values.advertisedResource !== values.endpoint) failures.push('OAUTH_RESOURCE_MISMATCH');
  if (values.expectedHelper && values.installedHelper !== values.expectedHelper) failures.push('OAUTH_HELPER_MISMATCH');
  return failures;
}

export const metadataUrl = (endpoint) => { const url = new URL(endpoint); return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`; };
const json = (path) => readFile(path, 'utf8').then(JSON.parse);
const codex = (...args) => {
  try {
    return JSON.parse(execFileSync(process.env.CODEX_BIN || 'codex', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`Codex 플러그인 목록을 읽지 못했습니다. 이동 전 마켓플레이스 경로라면 제거 후 현재 경로로 다시 등록하세요. ${detail}`);
  }
};

async function main() {
  const source = await json(resolve(root, 'source/wiki.json'));
  const manifest = await json(resolve(root, `plugins/${pluginName}/.codex-plugin/plugin.json`));
  if (manifest.mcpServers?.[pluginName]?.url !== source.endpoint) throw new Error('패키지 manifest의 MCP URL이 source/wiki.json과 다릅니다. npm run generate를 실행하세요.');

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
  if (!installed?.enabled) throw new Error('Codex Wiki 플러그인이 설치·활성화되지 않았습니다. codex plugin add doraft-wiki@doraft를 실행하세요.');
  const cachedManifestPath = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'plugins/cache', marketplaceName, pluginName, installed.version, '.codex-plugin/plugin.json');
  const cachedManifest = await json(cachedManifestPath).catch(() => null);
  const metadataResponse = await fetch(metadataUrl(source.endpoint), { signal: AbortSignal.timeout(10000) });
  if (!metadataResponse.ok) throw new Error(`운영 OAuth 메타데이터 조회에 실패했습니다: HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const failures = assessCodexOAuth({
    marketplaceRoot, marketplaceSource,
    version: source.version, installedVersion: installed.version,
    endpoint: source.endpoint,
    installedEndpoint: cachedManifest?.mcpServers?.[pluginName]?.url,
    advertisedResource: metadata.resource,
    expectedHelper: manifest.mcpServers?.[pluginName]?.http_headers_helper,
    installedHelper: cachedManifest?.mcpServers?.[pluginName]?.http_headers_helper,
  });
  if (failures.length) throw new Error(`${failures.join(', ')}: 플러그인을 다시 설치하고 OAuth 재연결을 확인하세요.`);
  process.stdout.write(`Codex Wiki OAuth 경로 일치: ${source.version}, ${source.endpoint}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

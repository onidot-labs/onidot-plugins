import {pathToFileURL} from 'node:url';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function entries(tools, requiredDigest) {
  if (!Array.isArray(tools) || tools.length > 2048) throw new Error('INVALID_CATALOG');
  const result = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name) || result.has(tool.name)
      || (requiredDigest && !digest(tool.digest)) || (tool.digest !== undefined && !digest(tool.digest))) throw new Error('INVALID_CATALOG');
    result.set(tool.name, tool.digest);
  }
  return result;
}

// Inputs must be from the SAME connection/credential. Never fill observed
// digests using the server's current catalog: that would prove nothing.
export function compareCatalog({catalog, observed, complete = false, previousRevision} = {}) {
  if (!catalog) return {status:'unsupported'};
  if (catalog.schemaVersion !== 1 || !digest(catalog.revision) || (previousRevision !== undefined && !digest(previousRevision))) throw new Error('INVALID_CATALOG');
  const expected = entries(catalog.tools, true), actual = entries(observed, false);
  if (!complete) return {status:'unverified', reason:'incomplete_client_inventory'};
  const missing = [...expected.keys()].filter(name => !actual.has(name)).sort();
  const extra = [...actual.keys()].filter(name => !expected.has(name)).sort();
  const changed = [...expected.keys()].filter(name => actual.has(name) && actual.get(name) !== undefined && actual.get(name) !== expected.get(name)).sort();
  const revisionChanged = previousRevision !== undefined && previousRevision !== catalog.revision;
  const schemaVerified = [...actual.values()].every(digest);
  return {status:missing.length || extra.length || changed.length || revisionChanged ? 'refresh_required' : schemaVerified ? 'current' : 'names_match',
    missing, extra, changed, revisionChanged, schemaVerified, revision:catalog.revision};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('INPUT_TOO_LARGE');
    }
    const result = compareCatalog(JSON.parse(input));
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.status === 'current' || result.status === 'names_match' ? 0 : 2;
  } catch {
    process.stderr.write('INVALID_CATALOG_INPUT\n');
    process.exitCode = 1;
  }
}

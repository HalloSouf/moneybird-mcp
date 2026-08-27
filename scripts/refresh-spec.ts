/**
 * Refreshes `spec/endpoints.json` from Moneybird's published OpenAPI document.
 *
 * Only the operation list is kept: it is what `test/tools/endpoints.test.ts` checks tool paths
 * against, and the full document is 2.4 MB of detail that would swamp every diff.
 *
 * Run `npm run spec:refresh`, then `npm test`. A failing endpoint test after a refresh means
 * Moneybird changed or withdrew a route a tool depends on.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SOURCE = 'https://raw.githubusercontent.com/moneybird/openapi/refs/heads/main/openapi.yml';
const METHODS = new Set(['get', 'post', 'patch', 'put', 'delete']);

interface Operation {
  method: string;
  path: string;
  operationId: string | undefined;
  summary: string;
  tag: string | undefined;
  paginated: boolean;
  filterable: boolean;
}

interface RawOperation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: Array<{ $ref?: string; name?: string }>;
}

function hasParameter(operation: RawOperation, name: string): boolean {
  return (operation.parameters ?? []).some(
    (parameter) => parameter.name === name || parameter.$ref?.endsWith(`/${name}`) === true,
  );
}

/**
 * Moneybird publishes YAML; parsing it would mean a dependency this package does not otherwise
 * need. The JSON rendering of the same document is fetched instead.
 */
async function fetchSpec(): Promise<{
  info: { version: string };
  paths: Record<string, Record<string, RawOperation>>;
}> {
  const response = await fetch(SOURCE);
  if (!response.ok) {
    throw new Error(`Could not fetch the Moneybird spec: HTTP ${response.status}`);
  }

  const yaml = await response.text();
  const { parse } = await import('yaml').catch(() => {
    throw new Error(
      'Refreshing the spec needs a YAML parser. Install it first with `npm i -D yaml`, then run this again.',
    );
  });
  return parse(yaml) as Awaited<ReturnType<typeof fetchSpec>>;
}

const spec = await fetchSpec();
const operations: Operation[] = [];

for (const [path, methods] of Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b))) {
  for (const [method, operation] of Object.entries(methods)) {
    if (!METHODS.has(method)) continue;
    operations.push({
      method: method.toUpperCase(),
      path,
      operationId: operation.operationId,
      summary: operation.summary ?? '',
      tag: operation.tags?.[0],
      paginated: hasParameter(operation, 'page') && hasParameter(operation, 'per_page'),
      filterable: hasParameter(operation, 'filter'),
    });
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'spec', 'endpoints.json');
await writeFile(
  target,
  `${JSON.stringify({ apiVersion: spec.info.version, operations }, null, 1)}\n`,
  'utf8',
);

process.stdout.write(`Wrote ${operations.length} operations (${spec.info.version}) to ${target}\n`);

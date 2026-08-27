import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards against invented endpoints.
 *
 * Every path a tool calls is checked against the pinned `spec/endpoints.json`, so a typo or a
 * hallucinated route fails here rather than at runtime against a live administration.
 */

const TOOLS_DIR = join(process.cwd(), 'src', 'tools');
const SPEC_FILE = join(process.cwd(), 'spec', 'endpoints.json');

interface SpecFile {
  apiVersion: string;
  operations: Array<{ method: string; path: string }>;
}

/** Collapses every path parameter to `*` so template literals and spec paths compare equal. */
function normalise(path: string): string {
  return path.replace(/\{[^}]+\}/g, '*').replace(/^\/+/, '');
}

async function knownEndpoints(): Promise<Set<string>> {
  const spec = JSON.parse(await readFile(SPEC_FILE, 'utf8')) as SpecFile;
  return new Set(
    spec.operations.map((operation) => {
      const path = normalise(
        operation.path.replace('{format}', '').replace('{administration_id}/', ''),
      );
      return `${operation.method} ${path}`;
    }),
  );
}

interface Call {
  file: string;
  line: number;
  method: string;
  path: string;
}

/**
 * Reads `client.get('…')` style calls out of the toolset sources.
 *
 * Interpolations become `*`, which also covers the lookup tables some toolsets use to serve several
 * document types from one tool. Those expand to a known prefix, so the suffix is what matters here.
 */
async function toolCalls(): Promise<Call[]> {
  const files = (await readdir(TOOLS_DIR)).filter(
    (name) => name.endsWith('.ts') && !['common.ts', 'registry.ts', 'index.ts'].includes(name),
  );

  const pattern = /client\.(get|post|patch|delete)(?:<[^>]*>)?\(\s*(`[^`]*`|'[^']*')/g;
  const calls: Call[] = [];

  for (const file of files) {
    const source = await readFile(join(TOOLS_DIR, file), 'utf8');
    for (const match of source.matchAll(pattern)) {
      const literal = match[2] as string;
      const path = literal
        .slice(1, -1)
        .replace(/\$\{[^}]*\}/g, '*')
        .replace(/^\/+/, '');
      calls.push({
        file,
        line: source.slice(0, match.index).split('\n').length,
        method: (match[1] as string).toUpperCase(),
        path,
      });
    }
  }

  return calls;
}

describe('tool endpoints', () => {
  it('finds endpoint calls to check', async () => {
    expect((await toolCalls()).length).toBeGreaterThan(50);
  });

  it('only calls paths that exist in the pinned Moneybird spec', async () => {
    const known = await knownEndpoints();
    const calls = await toolCalls();

    // A leading `*` means the prefix came from a lookup table, so only the suffix can be checked.
    const unverified = calls.filter((call) => {
      if (call.path.startsWith('*')) {
        const suffix = call.path.slice(call.path.indexOf('/') + 1);
        return ![...known].some(
          (entry) => entry === `${call.method} ${call.path}` || entry.endsWith(`/${suffix}`),
        );
      }
      return !known.has(`${call.method} ${call.path}`);
    });

    expect(
      unverified.map((call) => `${call.file}:${call.line} ${call.method} ${call.path}`),
    ).toEqual([]);
  });

  it('never sends a .json suffix, since the client appends it', async () => {
    const offenders = (await toolCalls()).filter((call) => call.path.includes('.json'));
    expect(offenders.map((call) => `${call.file}:${call.line}`)).toEqual([]);
  });
});

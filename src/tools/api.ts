import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { permissionsFor } from '../config/schema.js';
import {
  defineTool,
  listResult,
  textResult,
  type ToolAccess,
  type ToolDefinition,
} from './common.js';

export interface Operation {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Below the administration, e.g. `sales_invoices/{id}`; `administrations` is the one global. */
  path: string;
  summary: string;
  tag: string;
  scoped: boolean;
  paginated: boolean;
  filterable: boolean;
}

interface SpecFile {
  operations: Array<{
    method: string;
    path: string;
    summary: string;
    tag: string;
    paginated: boolean;
    filterable: boolean;
  }>;
}

// Actions that reach a customer, move money or book a mutation count as destructive: the API has
// no way to take them back.
const IRREVERSIBLE_SEGMENTS = new Set([
  'send_invoice',
  'send_estimate',
  'send_reminders',
  'payments',
  'register_payment',
  'register_payment_creditinvoice',
  'link_booking',
  'unlink_booking',
  'mark_as_dubious',
  'mark_as_uncollectible',
  'bill_estimate',
  'duplicate_creditinvoice',
]);

const SPEC_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'spec',
  'endpoints.json',
);

let operations: Promise<Operation[]> | undefined;

export function loadOperations(file: string = SPEC_FILE): Promise<Operation[]> {
  operations ??= readFile(file, 'utf8').then((raw) =>
    (JSON.parse(raw) as SpecFile).operations.map((operation) => {
      const scoped = operation.path.startsWith('/{administration_id}/');
      return {
        method: operation.method as Operation['method'],
        path: operation.path
          .replace('{format}', '')
          .replace(/^\/\{administration_id\}\//, '')
          .replace(/^\//, ''),
        summary: operation.summary,
        tag: operation.tag,
        scoped,
        paginated: operation.paginated,
        filterable: operation.filterable,
      };
    }),
  );
  return operations;
}

export function accessFor(method: Operation['method'], path: string): ToolAccess {
  if (method === 'GET') return 'read';
  if (method === 'DELETE') return 'destroy';
  return path.split('/').some((segment) => IRREVERSIBLE_SEGMENTS.has(segment))
    ? 'destroy'
    : 'write';
}

function matches(template: string, path: string): boolean {
  const expected = template.split('/');
  const actual = path.split('/');
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => {
      const value = actual[index] ?? '';
      return segment.startsWith('{') ? /^[A-Za-z0-9_-]+$/.test(value) : segment === value;
    })
  );
}

export function findOperation(
  all: readonly Operation[],
  method: string,
  path: string,
): Operation | undefined {
  return all.find((operation) => operation.method === method && matches(operation.path, path));
}

export function searchOperations(all: readonly Operation[], query: string): Operation[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length > 1);
  if (words.length === 0) return [];

  return all
    .map((operation) => {
      const haystack = `${operation.summary} ${operation.tag} ${operation.path}`.toLowerCase();
      const score = words.filter((word) => haystack.includes(word.replace(/s$/, ''))).length;
      return { operation, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map((entry) => entry.operation);
}

function describeOperation(operation: Operation): string {
  const flags = [
    operation.paginated ? 'paginated' : '',
    operation.filterable ? 'filterable' : '',
    accessFor(operation.method, operation.path) === 'destroy' ? 'irreversible' : '',
  ].filter(Boolean);
  return `${operation.method} ${operation.path} — ${operation.summary}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
}

export const apiTools: readonly ToolDefinition[] = [
  defineTool({
    name: 'find_moneybird_endpoint',
    title: 'Find a Moneybird API endpoint',
    description:
      'Search the Moneybird API for an endpoint the other tools do not cover (reports, assets, ' +
      'subscriptions, recurring invoices, documents, webhooks, …). Returns method, path and ' +
      'summary to use with moneybird_api.',
    toolset: 'core',
    access: 'read',
    essential: true,
    inputSchema: z.object({
      query: z.string().min(2).describe('What you are looking for, e.g. "profit loss report".'),
    }),
    handler: async (args) => {
      const found = searchOperations(await loadOperations(), args.query);
      if (found.length === 0) return textResult(`No endpoint matches "${args.query}".`);
      return textResult(
        [
          ...found.map(describeOperation),
          '',
          'Docs per resource: https://developer.moneybird.com/api/',
        ].join('\n'),
      );
    },
  }),

  defineTool({
    name: 'moneybird_api',
    title: 'Call the Moneybird API',
    description:
      'Call any Moneybird API endpoint found with find_moneybird_endpoint. Prefer a dedicated tool ' +
      'when one exists. Bodies follow the Moneybird API and are wrapped in the resource key, e.g. ' +
      '{"recurring_sales_invoice": {...}}. Writes and irreversible actions follow the same ' +
      'permissions as the dedicated tools.',
    toolset: 'core',
    access: 'read',
    essential: true,
    perCallAccess: true,
    inputSchema: z.object({
      method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']),
      path: z
        .string()
        .min(1)
        .describe('Path below the administration, with ids filled in, e.g. "reports/profit_loss".'),
      query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Query parameters, e.g. {"period": "this_year"}.'),
      body: z.record(z.string(), z.unknown()).optional().describe('JSON body for POST and PATCH.'),
      administration_id: z.string().optional().describe('Administration to act on.'),
    }),
    handler: async (args, context) => {
      const path = args.path.replace(/^\/+|\/+$/g, '').replace(/\.json$/, '');
      const operation = findOperation(await loadOperations(), args.method, path);
      if (!operation) {
        throw new Error(
          `${args.method} ${path} is not a Moneybird API endpoint. Use find_moneybird_endpoint.`,
        );
      }

      const access = accessFor(operation.method, operation.path);
      const permissions = permissionsFor(context.config);
      if (access === 'write' && !permissions.write) {
        throw new Error('Writing is disabled on this server (MONEYBIRD_ALLOW_WRITE).');
      }
      if (access === 'destroy' && !permissions.destroy) {
        throw new Error(
          'This action is irreversible and disabled on this server (MONEYBIRD_ALLOW_DELETE).',
        );
      }

      const response = await context.client.request({
        method: args.method,
        path,
        administrationScoped: operation.scoped,
        ...(args.administration_id ? { administrationId: args.administration_id } : {}),
        ...(args.query ? { query: args.query } : {}),
        ...(args.body ? { body: args.body } : {}),
      });
      if (response.data === undefined || response.data === null) {
        return textResult(`Done (${response.status}).`);
      }
      return listResult(response);
    },
  }),
];

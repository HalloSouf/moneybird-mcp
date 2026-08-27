import type {
  CallToolResult,
  InputRequiredResult,
  ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MoneybirdClient, MoneybirdResponse } from '../moneybird/client.js';
import type { ServerConfig, Toolset } from '../config/schema.js';
import { MAX_PER_PAGE } from '../moneybird/pagination.js';

export interface ToolContext {
  client: MoneybirdClient;
  config: ServerConfig;
}

/**
 * Permission tier a tool needs.
 *
 * `write` covers anything that creates or mutates; `destroy` is reserved for calls that remove
 * data or are irreversible from the API (deleting records, sending an invoice to a customer).
 */
export type ToolAccess = 'read' | 'write' | 'destroy';

/** Aliased from the SDK so tool results never drift from the protocol's own shape. */
export type ToolResult = CallToolResult;

/**
 * What a handler may return.
 *
 * `InputRequiredResult` lets a tool pause and ask the client for something — used by the connect
 * flow to open Moneybird in the browser and collect the token without leaving the conversation.
 */
export type ToolHandlerResult = CallToolResult | InputRequiredResult;

export interface ToolDefinition<Schema extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  access: ToolAccess;
  inputSchema: Schema;
  /** Marks a tool whose effect a caller cannot undo through the API. */
  irreversible?: boolean;
  handler: (
    args: z.infer<Schema>,
    context: ToolContext,
    mcp: ServerContext,
  ) => Promise<ToolHandlerResult>;
}

/** Preserves the literal schema type through registration so handler args stay inferred. */
export function defineTool<Schema extends z.ZodObject>(
  definition: ToolDefinition<Schema>,
): ToolDefinition<Schema> {
  return definition;
}

export const administrationIdField = z
  .string()
  .optional()
  .describe(
    'Administration to act on. Defaults to the administration this server was configured with; ' +
      'call list_administrations to discover the available ids.',
  );

export const paginationFields = {
  page: z.number().int().min(1).optional().describe('1-based page number.'),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(MAX_PER_PAGE)
    .optional()
    .describe(`Records per page (max ${MAX_PER_PAGE}, Moneybird defaults to 50).`),
};

export function filterField(examples: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .optional()
    .describe(
      `Comma-separated \`key:value\` filter, e.g. \`${examples}\`. ` +
        "Supplying a filter replaces Moneybird's defaults entirely, so restate every key you still want applied.",
    );
}

export interface QueryInput {
  page?: number | undefined;
  per_page?: number | undefined;
  filter?: string | undefined;
}

/** Maps the shared list arguments onto Moneybird query parameters, dropping absent ones. */
export function listQuery(args: QueryInput): Record<string, string | number | undefined> {
  return {
    ...(args.page !== undefined ? { page: args.page } : {}),
    ...(args.per_page !== undefined ? { per_page: args.per_page } : {}),
    ...(args.filter ? { filter: args.filter } : {}),
  };
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: stringify(value) }] };
}

/**
 * Renders a list response with the paging state Moneybird reported.
 *
 * Only about a third of collection endpoints paginate, so the footer is emitted only when the
 * response actually carried paging headers — otherwise it would imply pages that do not exist.
 */
export function listResult(response: MoneybirdResponse<unknown>): ToolResult {
  const { pageInfo } = response;
  const count = Array.isArray(response.data) ? response.data.length : undefined;

  const notes: string[] = [];
  if (count !== undefined) notes.push(`${count} record${count === 1 ? '' : 's'} returned`);
  if (pageInfo.totalCount !== undefined) notes.push(`${pageInfo.totalCount} total`);
  if (pageInfo.hasNextPage) {
    notes.push(`more available — request page ${pageInfo.nextPage ?? (pageInfo.page ?? 1) + 1}`);
  }

  const body = stringify(response.data);
  return {
    content: [
      { type: 'text', text: notes.length > 0 ? `${body}\n\n// ${notes.join(' · ')}` : body },
    ],
  };
}

/** Confirms a call that Moneybird answers with 204 and no body. */
export function emptyResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }] };
}

export interface ResourceRequest {
  path: string;
  administrationId?: string | undefined;
}

/** Resolves `administration_id` from the tool arguments, falling back to the client's default. */
export function scope(
  client: MoneybirdClient,
  administrationId: string | undefined,
): { administrationId: string | undefined } {
  return { administrationId: administrationId ?? client.defaultAdministrationId };
}

import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { ServerConfig, Toolset } from '../config/schema.js';
import { permissionsFor } from '../config/schema.js';
import {
  MoneybirdAuthError,
  MoneybirdError,
  MoneybirdRateLimitError,
  MoneybirdValidationError,
} from '../moneybird/errors.js';
import type { ToolContext, ToolDefinition, ToolResult } from './common.js';

export interface RegistrationSummary {
  registered: string[];
  skippedByToolset: string[];
  skippedByPermission: string[];
}

function isAllowed(
  definition: ToolDefinition,
  permissions: { write: boolean; destroy: boolean },
): boolean {
  if (definition.access === 'read') return true;
  if (definition.access === 'write') return permissions.write;
  return permissions.destroy;
}

/**
 * Turns a Moneybird failure into a tool error the model can act on.
 *
 * Tool errors are returned as content with `isError` rather than thrown, so the model sees the
 * message and can correct its arguments instead of the call surfacing as a transport failure.
 */
export function toToolError(error: unknown): ToolResult {
  if (error instanceof MoneybirdValidationError) {
    const fields = error.validation
      ? Object.entries(error.validation)
          .map(([field, messages]) => `  - ${field}: ${messages.join(', ')}`)
          .join('\n')
      : undefined;
    return {
      content: [
        {
          type: 'text',
          text: `Moneybird rejected the request (422).\n${fields ?? error.message}`,
        },
      ],
      isError: true,
    };
  }

  if (error instanceof MoneybirdAuthError) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Moneybird refused the credentials (${error.status}): ${error.message}\n` +
            'The token may be revoked, or it may lack the scope this endpoint requires. ' +
            'Run `moneybird-mcp login` to authenticate again with the needed scopes.',
        },
      ],
      isError: true,
    };
  }

  if (error instanceof MoneybirdRateLimitError) {
    const wait =
      error.retryAfterSeconds !== undefined ? ` Retry in ${error.retryAfterSeconds}s.` : '';
    return {
      content: [
        {
          type: 'text',
          text: `Moneybird rate limit reached (150 requests per 5 minutes per IP).${wait}`,
        },
      ],
      isError: true,
    };
  }

  if (error instanceof MoneybirdError) {
    return {
      content: [
        { type: 'text', text: `Moneybird request failed (${error.status}): ${error.message}` },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export interface RegisterOptions {
  server: McpServer;
  definitions: readonly ToolDefinition[];
  config: ServerConfig;
  context: ToolContext;
  /** Tools registered regardless of the configured toolsets and permissions. */
  always?: ReadonlySet<string>;
}

/** Registers every definition the configured toolsets and permissions allow. */
export function registerTools(options: RegisterOptions): RegistrationSummary {
  const { server, definitions, config, context } = options;
  const permissions = permissionsFor(config);
  const enabled = new Set<Toolset>(config.toolsets);

  const summary: RegistrationSummary = {
    registered: [],
    skippedByToolset: [],
    skippedByPermission: [],
  };

  for (const definition of definitions) {
    const unconditional = options.always?.has(definition.name) ?? false;

    if (!unconditional && !enabled.has(definition.toolset)) {
      summary.skippedByToolset.push(definition.name);
      continue;
    }
    if (!unconditional && !isAllowed(definition, permissions)) {
      summary.skippedByPermission.push(definition.name);
      continue;
    }

    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: {
          title: definition.title,
          readOnlyHint: definition.access === 'read',
          destructiveHint: definition.access === 'destroy',
          idempotentHint: definition.access === 'read',
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>, mcp: ServerContext) => {
        try {
          return await definition.handler(args as never, context, mcp);
        } catch (error) {
          return toToolError(error);
        }
      },
    );

    summary.registered.push(definition.name);
  }

  return summary;
}

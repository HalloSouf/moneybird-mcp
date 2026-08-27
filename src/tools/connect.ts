import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { APPLICATIONS_URL } from '../auth/oauth.js';
import { OAUTH_SCOPES } from '../config/schema.js';
import type { AuthSession } from '../auth/session.js';
import { defineTool, textResult, type ToolDefinition, type ToolResult } from './common.js';

const SETUP_INSTRUCTIONS =
  `Open ${APPLICATIONS_URL}, choose "personal API token", tick the scopes you need ` +
  `(${OAUTH_SCOPES.join(', ')}), and create it.`;

function summarise(
  session: AuthSession,
  administrations: Array<{ id: string | number; name?: string }>,
): ToolResult {
  const lines = administrations.map((administration) => {
    const marker = String(administration.id) === session.administrationId ? '→' : ' ';
    return `  ${marker} ${administration.id}  ${administration.name ?? ''}`.trimEnd();
  });

  return textResult(
    [
      'Connected to Moneybird.',
      `Credentials: ${session.storeLocation}`,
      administrations.length > 0
        ? '\nAdministrations:'
        : '\nNo administrations are reachable — check the token scopes.',
      ...lines,
      session.administrationId
        ? `\nDefault administration: ${session.administrationId}`
        : '\nNo default administration selected; pass administration_id to tools, or call select_administration.',
    ].join('\n'),
  );
}

/**
 * Setup tools.
 *
 * These are registered regardless of toolset and permission settings, because they are what a user
 * reaches for when nothing else works yet.
 */
export interface ElicitationSupport {
  /** The client can render a form, which is what collecting the token needs. */
  form: boolean;
  /** The client can open a URL, which turns the flow into a single click. */
  url: boolean;
}

export function connectTools(
  session: AuthSession,
  elicitation: () => ElicitationSupport,
): readonly ToolDefinition[] {
  return [
    defineTool({
      name: 'connect_moneybird',
      title: 'Connect to Moneybird',
      description:
        'Authenticate this server against a Moneybird account. Call it when other tools report ' +
        'missing or rejected credentials. It opens the Moneybird token page and stores the token you create.',
      toolset: 'core',
      access: 'read',
      inputSchema: z.object({
        token: z
          .string()
          .optional()
          .describe('A Moneybird API token to store directly, skipping the interactive prompt.'),
        administration_id: z
          .string()
          .optional()
          .describe('Administration to use by default. Omitted means the first one available.'),
      }),
      handler: async (args, _context, mcp) => {
        const supplied =
          args.token ??
          acceptedContent<{ token: string }>(mcp.mcpReq.inputResponses, 'token')?.token;

        if (!supplied) {
          if (session.isAuthenticated) {
            return summarise(session, await session.verify(await session.getToken()));
          }

          // Both elicitation modes are optional and advertised separately, so the flow degrades:
          // url+form opens the page and asks in one step, form alone asks with the link in the
          // message, and neither leaves the CLI as the only route.
          const support = elicitation();
          if (!support.form) {
            return textResult(
              [
                'Not connected to Moneybird, and this client cannot prompt for a token.',
                '',
                SETUP_INSTRUCTIONS,
                '',
                'Then either run `moneybird-mcp login`, or call this tool again with the token ' +
                  'in the `token` argument.',
              ].join('\n'),
            );
          }

          return inputRequired({
            inputRequests: {
              ...(support.url
                ? {
                    open: inputRequired.elicitUrl({
                      message: 'Create a Moneybird API token, then paste it back here.',
                      url: APPLICATIONS_URL,
                    }),
                  }
                : {}),
              token: inputRequired.elicit({
                message: support.url
                  ? 'Paste the Moneybird API token you just created.'
                  : `${SETUP_INSTRUCTIONS} Then paste the token here.`,
                requestedSchema: z.object({
                  token: z.string().describe('The Moneybird API token.'),
                }),
              }),
            },
          });
        }

        const administrations = await session.verify(supplied);
        const chosen =
          args.administration_id ??
          (administrations.length === 1 ? String(administrations[0]?.id) : undefined);

        await session.connect(supplied, chosen);
        return summarise(session, administrations);
      },
    }),

    defineTool({
      name: 'moneybird_connection_status',
      title: 'Moneybird connection status',
      description:
        'Report whether this server has working Moneybird credentials, which administration is ' +
        'selected, and which administrations the token can reach.',
      toolset: 'core',
      access: 'read',
      inputSchema: z.object({}),
      handler: async () => {
        if (!session.isAuthenticated) {
          return textResult(
            [
              'Not connected to Moneybird.',
              '',
              'Call connect_moneybird to authenticate from here, or run `moneybird-mcp login` in a terminal.',
              SETUP_INSTRUCTIONS,
            ].join('\n'),
          );
        }
        return summarise(session, await session.verify(await session.getToken()));
      },
    }),

    defineTool({
      name: 'select_administration',
      title: 'Select administration',
      description:
        'Change the administration that tools use when they are not given an explicit ' +
        'administration_id. Applies for the rest of this session.',
      toolset: 'core',
      access: 'read',
      inputSchema: z.object({
        administration_id: z.string().describe('Id from list_administrations.'),
      }),
      handler: async (args) => {
        const administrations = await session.verify(await session.getToken());
        const match = administrations.find(
          (administration) => String(administration.id) === args.administration_id,
        );
        if (!match) {
          throw new Error(
            `Administration ${args.administration_id} is not reachable with the current token. ` +
              `Available: ${administrations.map((entry) => entry.id).join(', ') || 'none'}.`,
          );
        }

        session.selectAdministration(args.administration_id);
        return textResult(
          `Default administration is now ${match.name ?? ''} (${match.id}).`.trim(),
        );
      },
    }),
  ];
}

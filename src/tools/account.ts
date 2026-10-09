import { inputRequired, inputResponse } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { UserAccount } from '../auth/airlock.js';
import type { ElicitationSupport } from './connect.js';
import { defineTool, textResult, type ToolDefinition, type ToolResult } from './common.js';

function status(account: UserAccount): ToolResult {
  if (account.administrations.length === 0) {
    return textResult(
      'No Moneybird administration is connected yet. Call connect_moneybird to connect one.',
    );
  }
  const lines = account.administrations.map(
    (entry) => `  ${entry.administrationId}  ${entry.name}`,
  );
  return textResult(
    [
      'Connected administrations:',
      ...lines,
      '',
      account.defaultAdministrationId
        ? `Tools act on ${account.defaultAdministrationId} unless given an administration_id.`
        : 'Pass administration_id to every tool. Call connect_moneybird to add another.',
    ].join('\n'),
  );
}

/** Setup tools for the `airlock` HTTP mode, registered regardless of toolsets and permissions. */
export function accountTools(
  account: UserAccount,
  elicitation: () => ElicitationSupport,
): readonly ToolDefinition[] {
  return [
    defineTool({
      name: 'connect_moneybird',
      title: 'Connect a Moneybird administration',
      description:
        'Get a link that connects a Moneybird administration to this user. Each authorization at ' +
        'Moneybird covers one administration; call this again to add another.',
      toolset: 'core',
      access: 'read',
      inputSchema: z.object({}),
      handler: async (_args, _context, mcp) => {
        if (inputResponse(mcp.mcpReq.inputResponses, 'open').kind !== 'missing') {
          return textResult(
            'Finish the authorization in the browser, then call moneybird_connection_status to confirm.',
          );
        }

        const url = await account.connectUrl();
        if (!elicitation().url) {
          return textResult(
            `Open this link to connect a Moneybird administration (valid for 10 minutes, single use):\n${url}\n\n` +
              'Afterwards, call moneybird_connection_status to confirm.',
          );
        }

        return inputRequired({
          inputRequests: {
            open: inputRequired.elicitUrl({
              message: 'Connect a Moneybird administration in your browser.',
              url,
            }),
          },
        });
      },
    }),

    defineTool({
      name: 'moneybird_connection_status',
      title: 'Moneybird connection status',
      description: 'List the Moneybird administrations connected for this user.',
      toolset: 'core',
      access: 'read',
      inputSchema: z.object({}),
      handler: async () => status(account),
    }),

    defineTool({
      name: 'disconnect_moneybird',
      title: 'Disconnect a Moneybird administration',
      description:
        'Forget the stored authorization for one administration. Revoke it in Moneybird as well ' +
        'to withdraw access completely.',
      toolset: 'core',
      access: 'read',
      inputSchema: z.object({
        administration_id: z.string().describe('Id from moneybird_connection_status.'),
      }),
      handler: async (args) => {
        const removed = await account.disconnect(args.administration_id);
        return textResult(
          removed
            ? `Disconnected administration ${args.administration_id}.`
            : `Administration ${args.administration_id} was not connected.`,
        );
      },
    }),
  ];
}

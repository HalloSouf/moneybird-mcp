import { z } from 'zod';
import {
  administrationIdField,
  defineTool,
  emptyResult,
  listResult,
  textResult,
  type ToolDefinition,
} from './common.js';

/**
 * The event names the OpenAPI spec actually shows, taken from the `action` field of the document
 * events it documents. Moneybird also accepts event groups; the canonical list is at
 * https://developer.moneybird.com/webhooks/events.
 */
const WEBHOOK_EVENTS =
  'contact_created, contact_changed, sales_invoice_created, sales_invoice_updated, ' +
  'sales_invoice_send_email, sales_invoice_send_si, sales_invoice_paused, sales_invoice_unpaused, ' +
  'sales_invoice_marked_as_dubious, sales_invoice_marked_as_uncollectible, ' +
  'sales_invoice_state_changed_to_open, sales_invoice_state_changed_to_paid, ' +
  'sales_invoice_state_changed_to_scheduled, sales_invoice_state_changed_to_uncollectible, ' +
  'sales_invoice_created_based_on_estimate, credit_invoice_created_from_original, ' +
  'recurring_sales_invoice_created, estimate_created, estimate_updated, estimate_send_email, ' +
  'estimate_mark_accepted, external_sales_invoice_created, external_sales_invoice_updated, ' +
  'external_sales_invoice_marked_as_dubious, external_sales_invoice_marked_as_uncollectible, ' +
  'external_sales_invoice_state_changed_to_uncollectible, document_saved, document_updated, ' +
  'time_entry_created, time_entry_updated, task_lists_task_created, task_lists_task_assigned, ' +
  'task_lists_task_completed, task_lists_task_reopened, task_lists_task_name';

export const webhooksTools: readonly ToolDefinition[] = [
  defineTool({
    name: 'list_webhooks',
    title: 'List webhooks',
    description:
      'List the webhooks registered on the administration, with their url, subscribed events and the ' +
      'status code Moneybird last got back from each. There is no endpoint for a single webhook, so ' +
      'read one from this list.',
    toolset: 'webhooks',
    access: 'read',
    inputSchema: z.object({ administration_id: administrationIdField }),
    handler: async (args, { client }) => {
      const response = await client.get('webhooks', {
        administrationId: args.administration_id,
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'create_webhook',
    title: 'Create webhook',
    description:
      'Register a webhook: Moneybird will POST a payload to `url` whenever a subscribed event happens in ' +
      'this administration, so the endpoint receives contact, invoice and document data from then on. ' +
      'Use HTTPS — over plain HTTP that data travels in the clear. The url must answer 200 at creation. ' +
      `Leave \`enabled_events\` empty to receive everything, or name events: ${WEBHOOK_EVENTS}. ` +
      'The response carries a `secret` that is returned only once; it signs the payloads Moneybird sends.',
    toolset: 'webhooks',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      url: z.string().describe('HTTPS endpoint that will receive the event payloads.'),
      enabled_events: z
        .array(z.string())
        .optional()
        .describe('Events or event groups to subscribe to. Omit to receive all events.'),
    }),
    handler: async (args, { client }) => {
      // Unlike the rest of the API this body carries no resource envelope.
      const response = await client.post(
        'webhooks',
        {
          url: args.url,
          ...(args.enabled_events ? { enabled_events: args.enabled_events } : {}),
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'activate_webhook',
    title: 'Activate webhook',
    description: 'Reactivate a deactivated webhook so it receives event notifications again.',
    toolset: 'webhooks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      webhook_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `webhooks/${encodeURIComponent(args.webhook_id)}/activate`,
        undefined,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'deactivate_webhook',
    title: 'Deactivate webhook',
    description:
      'Stop a webhook from receiving new events without removing it; retries already queued still run. ' +
      'Reversible with activate_webhook, which makes this the safer alternative to delete_webhook.',
    toolset: 'webhooks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      webhook_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `webhooks/${encodeURIComponent(args.webhook_id)}/deactivate`,
        undefined,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_webhook',
    title: 'Delete webhook',
    description:
      'Permanently remove a webhook registration. Re-creating it later yields a new token and secret, ' +
      'so deactivate_webhook is the better choice for a temporary pause.',
    toolset: 'webhooks',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      webhook_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`webhooks/${encodeURIComponent(args.webhook_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Webhook ${args.webhook_id} deleted.`);
    },
  }),

  defineTool({
    name: 'create_customer_portal_link',
    title: 'Create customer portal link',
    description:
      "Mint a temporary link into a contact's customer portal, where they can see their own invoices, " +
      'estimates and subscriptions. The url authenticates on its own — anyone holding it reaches that ' +
      "contact's documents without logging in — so hand it only to that contact. It expires after 1 hour.",
    toolset: 'webhooks',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string().describe('Contact whose portal the link opens.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `customer_contact_portal/${encodeURIComponent(args.contact_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_customer_portal_invoices_link',
    title: 'Create customer portal invoices link',
    description:
      "Mint a temporary link that opens the invoices page of a contact's customer portal. The url grants " +
      "access to that contact's invoices to whoever holds it, and expires after 1 hour.",
    toolset: 'webhooks',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `customer_contact_portal/${encodeURIComponent(args.contact_id)}/invoices`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_customer_portal_subscription_link',
    title: 'Create customer portal subscription link',
    description:
      "Mint a temporary link that opens one subscription in a contact's customer portal. The subscription " +
      'must belong to that contact and have a subscription template, otherwise Moneybird answers 404. ' +
      'The url grants access to that subscription to whoever holds it, and expires after 1 hour.',
    toolset: 'webhooks',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string(),
      subscription_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `customer_contact_portal/${encodeURIComponent(args.contact_id)}/subscriptions/${encodeURIComponent(args.subscription_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'list_verifications',
    title: 'List verifications',
    description:
      'List what the administration has verified about itself: its confirmed sender email addresses and ' +
      'bank account numbers, plus its chamber of commerce and tax number. Keys are absent while a ' +
      'verification is still pending, which makes this the way to check whether sending or direct debit ' +
      'is ready to use.',
    toolset: 'webhooks',
    access: 'read',
    inputSchema: z.object({ administration_id: administrationIdField }),
    handler: async (args, { client }) => {
      const response = await client.get('verifications', {
        administrationId: args.administration_id,
      });
      return textResult(response.data);
    },
  }),
] as const;

import { z } from 'zod';
import {
  administrationIdField,
  defineTool,
  emptyResult,
  filterField,
  listQuery,
  listResult,
  paginationFields,
  textResult,
  type ToolDefinition,
} from './common.js';

const MUTATION_FILTER_KEYS =
  'period (named period such as this_month/prev_quarter/this_year, or a range like 20260101..20260131), ' +
  'state (all|unprocessed|processed|auto_booked), mutation_type (all|debit|credit), financial_account_id, ' +
  'amount_from, amount_to';

const PURCHASE_TRANSACTION_FILTER_KEYS =
  'state (all|open|pending_payment|paid|cancelled), period (named period or a range like 20260101..20260131), ' +
  'unbatched (true|false)';

/** Every record type a mutation can be booked against, per the link_booking schema. */
const BOOKING_TYPES = [
  'SalesInvoice',
  'Document',
  'LedgerAccount',
  'PaymentTransactionBatch',
  'PurchaseTransaction',
  'NewPurchaseInvoice',
  'NewReceipt',
  'PaymentTransaction',
  'PurchaseTransactionBatch',
  'ExternalSalesInvoice',
  'Payment',
  'VatDocument',
] as const;

export const bankingTools: readonly ToolDefinition[] = [
  defineTool({
    name: 'list_financial_accounts',
    title: 'List financial accounts',
    description:
      'List the bank and payment provider accounts of the administration, with the ids that financial ' +
      'mutations and statements reference as `financial_account_id`.',
    toolset: 'banking',
    access: 'read',
    inputSchema: z.object({ administration_id: administrationIdField }),
    handler: async (args, { client }) => {
      const response = await client.get('financial_accounts', {
        administrationId: args.administration_id,
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'list_financial_mutations',
    title: 'List financial mutations',
    description:
      'List bank transactions. Without a filter Moneybird returns the current financial year only, so pass ' +
      'an explicit `period` to look further back.',
    toolset: 'banking',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('period:prev_month,state:unprocessed').describe(
        `Comma-separated \`key:value\` filter. Keys: ${MUTATION_FILTER_KEYS}. ` +
          "A filter replaces Moneybird's `period:this_year` default entirely. " +
          '`state` and `mutation_type` accept pipe-separated values, e.g. `state:unprocessed|processed`.',
      ),
    }),
    handler: async (args, { client }) => {
      const response = await client.get('financial_mutations', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_financial_mutation',
    title: 'Get financial mutation',
    description:
      'Retrieve one bank transaction by id, including the payments and ledger bookings currently linked to it.',
    toolset: 'banking',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      financial_mutation_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `financial_mutations/${encodeURIComponent(String(args.financial_mutation_id))}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'link_booking',
    title: 'Link booking to financial mutation',
    description:
      'Book a bank transaction against a record: an invoice, a purchase transaction or a ledger account. ' +
      'This posts to the ledger. Omit `price` to book the full mutation amount.',
    toolset: 'banking',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      financial_mutation_id: z.union([z.string(), z.number()]),
      booking_type: z.enum(BOOKING_TYPES).describe('The kind of record to book against.'),
      booking_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'Id of the record. Required for every booking_type except `LedgerAccount` bookings by amount.',
        ),
      price: z
        .string()
        .optional()
        .describe('Amount to book, decimal string. Defaults to the full mutation amount.'),
      price_base: z
        .string()
        .optional()
        .describe(
          'Amount in the administration currency when the booked document is in a foreign currency.',
        ),
      description: z.string().optional(),
      payment_batch_identifier: z.string().optional(),
      project_id: z.union([z.string(), z.number()]).optional(),
      mark_open_sepa_transaction_as_paid: z.boolean().optional(),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `financial_mutations/${encodeURIComponent(String(args.financial_mutation_id))}/link_booking`,
        {
          booking_type: args.booking_type,
          ...(args.booking_id !== undefined ? { booking_id: args.booking_id } : {}),
          ...(args.price !== undefined ? { price: args.price } : {}),
          ...(args.price_base !== undefined ? { price_base: args.price_base } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.payment_batch_identifier !== undefined
            ? { payment_batch_identifier: args.payment_batch_identifier }
            : {}),
          ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
          ...(args.mark_open_sepa_transaction_as_paid !== undefined
            ? { mark_open_sepa_transaction_as_paid: args.mark_open_sepa_transaction_as_paid }
            : {}),
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'unlink_booking',
    title: 'Unlink booking from financial mutation',
    description:
      'Remove a payment or ledger booking from a bank transaction, returning the mutation to unprocessed. ' +
      'Call get_financial_mutation first to read the `booking_id` off the existing link.',
    toolset: 'banking',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      financial_mutation_id: z.union([z.string(), z.number()]),
      booking_type: z.enum(['Payment', 'LedgerAccountBooking']),
      booking_id: z
        .union([z.string(), z.number()])
        .describe('Id of the existing link, not of the booked document.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.delete(
        `financial_mutations/${encodeURIComponent(String(args.financial_mutation_id))}/unlink_booking`,
        {
          body: { booking_type: args.booking_type, booking_id: args.booking_id },
          administrationId: args.administration_id,
        },
      );
      return textResult(response.data ?? `Booking ${args.booking_id} unlinked.`);
    },
  }),

  defineTool({
    name: 'get_payment',
    title: 'Get payment',
    description:
      'Retrieve a payment by id, whichever document it belongs to. Payment ids appear on invoices, receipts ' +
      'and on the bookings of a financial mutation.',
    toolset: 'banking',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      payment_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(`payments/${encodeURIComponent(String(args.payment_id))}`, {
        administrationId: args.administration_id,
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'list_purchase_transactions',
    title: 'List purchase transactions',
    description:
      'List outgoing payment instructions (purchase transactions). Moneybird defaults to `unbatched:true`, ' +
      'so pass an explicit filter to see transactions already collected into a batch.',
    toolset: 'banking',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('state:open,unbatched:false').describe(
        `Comma-separated \`key:value\` filter. Keys: ${PURCHASE_TRANSACTION_FILTER_KEYS}. ` +
          "A filter replaces Moneybird's defaults entirely. " +
          '`state` accepts pipe-separated values, e.g. `state:open|pending_payment`.',
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('purchase_transactions', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_purchase_transaction',
    title: 'Get purchase transaction',
    description:
      'Retrieve one purchase transaction by id, with its amount, state and the document it pays.',
    toolset: 'banking',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      purchase_transaction_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `purchase_transactions/${encodeURIComponent(String(args.purchase_transaction_id))}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_purchase_transaction',
    title: 'Delete purchase transaction',
    description: 'Delete a purchase transaction, cancelling the payment instruction it represents.',
    toolset: 'banking',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      purchase_transaction_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `purchase_transactions/${encodeURIComponent(String(args.purchase_transaction_id))}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`Purchase transaction ${args.purchase_transaction_id} deleted.`);
    },
  }),
] as const;

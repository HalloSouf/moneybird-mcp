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

const SALES_INVOICE_FILTER_KEYS =
  'state (all|draft|open|scheduled|pending_payment|late|reminded|paid|uncollectible, pipe-separated for several), ' +
  'period (this_week|prev_week|next_week|this_month|prev_month|next_month|this_quarter|prev_quarter|next_quarter|' +
  'this_year|prev_year|next_year, or a range like 20130101..20130131), reference, contact_id, ' +
  'recurring_sales_invoice_id, workflow_id, created_after, updated_after';

const ESTIMATE_FILTER_KEYS =
  'state (all|draft|open|late|accepted|rejected|billed|archived, pipe-separated for several), ' +
  'period (named period or a range like 20130101..20130131), contact_id, workflow_id';

const EXTERNAL_SALES_INVOICE_FILTER_KEYS =
  'state (all|new|open|late|paid, pipe-separated for several), ' +
  'period (named period or a range like 20130101..20130131), contact_id';

const RECURRING_SALES_INVOICE_FILTER_KEYS =
  'state (active|inactive), frequency (all|day|week|month|quarter|year), auto_send (true|false), ' +
  'contact_id, workflow_id';

const recordId = z.union([z.string(), z.number()]);

/** Moneybird accepts both `"10,95"` and `10.95` for every money field. */
const money = z.union([z.string(), z.number()]);

const customFieldsAttributes = z
  .record(z.string(), z.object({ id: recordId, value: z.string() }))
  .optional()
  .describe(
    'Keyed by index, e.g. `{"0": {"id": "123", "value": "abc"}}`. Ids come from list_custom_fields.',
  );

/**
 * One line on an invoice or estimate.
 *
 * Passthrough for the same reason contact attributes are: the document detail carries fields
 * beyond the ones worth naming here, and rejecting them would block bodies the API accepts.
 */
const detailLine = z
  .object({
    id: recordId
      .optional()
      .describe('Id of an existing line. Required to change or remove a line, omit to add one.'),
    description: z
      .string()
      .optional()
      .describe('Line text, e.g. the product or service delivered.'),
    price: money.optional().describe('Unit price as a decimal string, e.g. "150.0".'),
    amount: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Quantity, e.g. 1, 5 or "0.5". Defaults to 1.'),
    tax_rate_id: recordId
      .optional()
      .describe(
        'Tax rate for this line, from list_tax_rates. Defaults to the administration default.',
      ),
    ledger_account_id: recordId
      .optional()
      .describe('Ledger account (category) to book this line to, from list_ledger_accounts.'),
    product_id: recordId
      .optional()
      .describe(
        'Product to take price, description, tax rate and ledger account from, from list_products. ' +
          'Values you supply explicitly still win.',
      ),
    project_id: recordId
      .optional()
      .describe('Project to attribute this line to, for per-project reporting.'),
    period: z
      .string()
      .optional()
      .describe(
        'Period the line covers, e.g. `20240101..20241231` or `this_month`. Revenue is deferred over it ' +
          'in the profit and loss report.',
      ),
    row_order: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Display position on the document, starting at 0.'),
    _destroy: z
      .boolean()
      .optional()
      .describe('Set to true, together with `id`, to remove the line.'),
  })
  .loose();

/** Estimates additionally support lines the customer can opt into. */
const estimateDetailLine = detailLine.extend({
  is_optional: z
    .boolean()
    .optional()
    .describe('Shown on the estimate but excluded from the total until the customer selects it.'),
  is_selected: z.boolean().optional().describe('Whether an optional line has been selected.'),
});

const salesInvoiceAttributes = z
  .object({
    contact_id: recordId.optional(),
    contact_person_id: recordId.optional(),
    update_contact: z
      .boolean()
      .optional()
      .describe('Refresh the address and details on the invoice from the current contact record.'),
    original_estimate_id: recordId.optional(),
    document_style_id: recordId.optional(),
    workflow_id: recordId.optional(),
    reference: z
      .string()
      .optional()
      .describe('Your own reference, e.g. a PO number. Visible to the recipient.'),
    invoice_sequence_id: recordId
      .optional()
      .describe('Numbering sequence to draw the invoice number from.'),
    remove_invoice_sequence_id: z
      .boolean()
      .optional()
      .describe(
        'Drop the assigned numbering sequence and fall back to the administration default.',
      ),
    invoice_date: z
      .string()
      .optional()
      .describe('YYYY-MM-DD. Filled in on sending when left empty.'),
    first_due_interval: z
      .number()
      .int()
      .optional()
      .describe('Days after the invoice date before payment is due.'),
    currency: z.string().length(3).optional().describe('ISO 4217 currency code.'),
    prices_are_incl_tax: z.boolean().optional(),
    payment_conditions: z.string().optional().describe('Free text printed on the invoice.'),
    discount: money.optional().describe('Discount percentage over the whole invoice.'),
    time_entry_ids: z
      .array(recordId)
      .optional()
      .describe('Time entries to bill on this invoice; they are marked as invoiced.'),
    details_attributes: z.array(detailLine).optional().describe('The invoice lines, in order.'),
    custom_fields_attributes: customFieldsAttributes,
  })
  .loose();

const estimateAttributes = z
  .object({
    contact_id: recordId.optional(),
    contact_person_id: recordId.optional(),
    update_contact: z
      .boolean()
      .optional()
      .describe('Refresh the address and details on the estimate from the current contact record.'),
    document_style_id: recordId.optional(),
    workflow_id: recordId.optional(),
    reference: z
      .string()
      .optional()
      .describe('Your own reference, e.g. a project code. Visible to the recipient.'),
    estimate_date: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
    estimate_sequence_id: recordId.optional(),
    remove_estimate_sequence_id: z.boolean().optional(),
    language: z
      .string()
      .optional()
      .describe(
        'Document language: bg, cs, da, de, el, en, es, fr, hr, hu, it, no, nl, nl-be, pl, pt, ro, sv, tr or uk.',
      ),
    currency: z.string().length(3).optional().describe('ISO 4217 currency code.'),
    prices_are_incl_tax: z.boolean().optional(),
    show_tax: z.boolean().optional().describe('Print tax amounts on the document.'),
    first_due_interval: z
      .number()
      .int()
      .optional()
      .describe('Days after the estimate date before it expires.'),
    pre_text: z.string().optional().describe('Text above the lines.'),
    post_text: z.string().optional().describe('Text below the lines.'),
    discount: money.optional().describe('Discount percentage over the whole estimate.'),
    original_sales_invoice_id: recordId.optional(),
    details_attributes: z
      .array(estimateDetailLine)
      .optional()
      .describe('The estimate lines, in order.'),
    custom_fields_attributes: customFieldsAttributes,
  })
  .loose();

const recurringSalesInvoiceAttributes = z
  .object({
    contact_id: recordId.optional(),
    contact_person_id: recordId.optional(),
    update_contact: z
      .boolean()
      .optional()
      .describe('Refresh the contact details on every invoice this schedule generates.'),
    document_style_id: recordId.optional(),
    workflow_id: recordId.optional(),
    reference: z.string().optional().describe('Reference printed on every generated invoice.'),
    invoice_date: z
      .string()
      .optional()
      .describe('YYYY-MM-DD of the first invoice; must be in the future.'),
    currency: z.string().length(3).optional().describe('ISO 4217 currency code.'),
    first_due_interval: z.number().int().optional(),
    prices_are_incl_tax: z.boolean().optional(),
    discount: money.optional(),
    frequency_type: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
    frequency: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Multiplier on `frequency_type`, e.g. 2 with `month` bills every two months.'),
    has_desired_count: z.boolean().optional().describe('Stop after `desired_count` invoices.'),
    desired_count: z.union([z.string(), z.number()]).optional(),
    auto_send: z
      .boolean()
      .optional()
      .describe('Send each generated invoice to the contact automatically.'),
    mergeable: z
      .boolean()
      .optional()
      .describe('Allow merging with other invoices for the same contact before sending.'),
    details_attributes: z.array(detailLine).optional().describe('The invoice lines, in order.'),
    custom_fields_attributes: customFieldsAttributes,
  })
  .loose();

const externalSalesInvoiceAttributes = z
  .object({
    contact_id: recordId.optional(),
    reference: z
      .string()
      .optional()
      .describe('Invoice number or order id from the external system.'),
    date: z.string().optional().describe('YYYY-MM-DD invoice date.'),
    due_date: z.string().optional().describe('YYYY-MM-DD payment due date.'),
    currency: z.string().length(3).optional().describe('ISO 4217 currency code.'),
    prices_are_incl_tax: z.boolean().optional(),
    source: z
      .string()
      .optional()
      .describe('Name of the system the invoice came from, e.g. your webshop.'),
    source_url: z.string().optional().describe('Link back to the invoice in that system.'),
    details_attributes: z.array(detailLine).optional().describe('The invoice lines, in order.'),
  })
  .loose();

const paymentAttributes = z
  .object({
    payment_date: z.string().describe('YYYY-MM-DD the payment was received.'),
    price: money.describe('Amount received, as a decimal string.'),
    price_base: money
      .optional()
      .describe('Amount in the administration currency when the invoice is foreign.'),
    financial_account_id: recordId
      .optional()
      .describe('Bank account the payment landed on, from list_financial_accounts.'),
    financial_mutation_id: recordId
      .optional()
      .describe('Bank mutation to match this payment against.'),
    transaction_identifier: z
      .string()
      .optional()
      .describe('External reference, e.g. a bank or PSP transaction id.'),
    manual_payment_action: z
      .string()
      .optional()
      .describe(
        'One of `private_payment` (needs financial_account_id), `payment_without_proof`, `cash_payment` ' +
          '(needs financial_account_id), `rounding_error`, `bank_transfer` (needs financial_mutation_id), ' +
          '`balance_settlement` or `invoices_settlement`.',
      ),
    ledger_account_id: recordId.optional(),
    invoice_id: recordId
      .optional()
      .describe('Other invoice to settle against, for `invoices_settlement`.'),
  })
  .loose();

export const invoicingTools: readonly ToolDefinition[] = [
  defineTool({
    name: 'list_sales_invoices',
    title: 'List sales invoices',
    description:
      'List sales invoices. Defaults to the current financial year, so pass an explicit `period` in the filter ' +
      'to look further back.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('state:late,period:this_year').describe(
        `Comma-separated \`key:value\` filter. Keys: ${SALES_INVOICE_FILTER_KEYS}. ` +
          "A filter replaces Moneybird's default of `period:this_year` entirely. Several states can be " +
          'combined with a pipe (`state:draft|scheduled`). A draft without an `invoice_date` is only matched ' +
          'by a period containing today, so list drafts with `state:draft` and no period.',
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('sales_invoices', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_sales_invoice',
    title: 'Get sales invoice',
    description:
      'Retrieve one sales invoice by its Moneybird id, including its lines, payments and notes.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `sales_invoices/${encodeURIComponent(args.sales_invoice_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'find_sales_invoice_by_invoice_id',
    title: 'Find sales invoice by invoice number',
    description:
      'Look up a sales invoice by its printed invoice number, e.g. "2025-0001". Drafts have no invoice number ' +
      'and are never found this way.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      invoice_id: z.string().describe('The invoice number as shown on the document.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `sales_invoices/find_by_invoice_id/${encodeURIComponent(args.invoice_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'find_sales_invoice_by_reference',
    title: 'Find sales invoice by reference',
    description:
      'Look up a sales invoice by the `reference` you set on it, e.g. a PO or project code.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      reference: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `sales_invoices/find_by_reference/${encodeURIComponent(args.reference)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_sales_invoice',
    title: 'Create sales invoice',
    description:
      'Create a sales invoice as a draft. Supply `contact_id` and the lines in `details_attributes`; ' +
      'send it afterwards with send_sales_invoice.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice: salesInvoiceAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'sales_invoices',
        { sales_invoice: args.sales_invoice },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_sales_invoice',
    title: 'Update sales invoice',
    description:
      'Update a sales invoice. Only the attributes you supply change. Supplying `details_attributes` without ' +
      'the `id` of an existing line adds a line rather than replacing the set.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice_id: z.string(),
      sales_invoice: salesInvoiceAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `sales_invoices/${encodeURIComponent(args.sales_invoice_id)}`,
        { sales_invoice: args.sales_invoice },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_sales_invoice',
    title: 'Delete sales invoice',
    description:
      'Delete a sales invoice. Moneybird refuses this when the invoice has payments or falls in a locked ' +
      'bookkeeping period.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`sales_invoices/${encodeURIComponent(args.sales_invoice_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Sales invoice ${args.sales_invoice_id} deleted.`);
    },
  }),

  defineTool({
    name: 'send_sales_invoice',
    title: 'Send sales invoice',
    description:
      'Send a sales invoice to the customer, or schedule it for a future date. With no arguments the contact ' +
      'and workflow defaults are used. This reaches the customer and cannot be recalled.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice_id: z.string(),
      delivery_method: z.enum(['Email', 'Peppol', 'Manual']).optional(),
      sending_scheduled: z
        .boolean()
        .optional()
        .describe('Schedule instead of sending now; combine with `invoice_date`.'),
      invoice_date: z.string().optional().describe('YYYY-MM-DD to send on, when scheduling.'),
      email_address: z
        .string()
        .optional()
        .describe('Overrides the contact default. Email delivery only.'),
      email_message: z
        .string()
        .optional()
        .describe('Overrides the workflow text. Email delivery only.'),
      deliver_ubl: z
        .boolean()
        .optional()
        .describe('Attach a UBL e-invoicing file. Email delivery only.'),
      mergeable: z
        .boolean()
        .optional()
        .describe(
          'Merge with other scheduled invoices for the same contact that share every document setting.',
        ),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `sales_invoices/${encodeURIComponent(args.sales_invoice_id)}/send_invoice`,
        {
          sales_invoice_sending: {
            ...(args.delivery_method ? { delivery_method: args.delivery_method } : {}),
            ...(args.sending_scheduled !== undefined
              ? { sending_scheduled: args.sending_scheduled }
              : {}),
            ...(args.invoice_date ? { invoice_date: args.invoice_date } : {}),
            ...(args.email_address ? { email_address: args.email_address } : {}),
            ...(args.email_message ? { email_message: args.email_message } : {}),
            ...(args.deliver_ubl !== undefined ? { deliver_ubl: args.deliver_ubl } : {}),
            ...(args.mergeable !== undefined ? { mergeable: args.mergeable } : {}),
          },
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'register_sales_invoice_payment',
    title: 'Register sales invoice payment',
    description:
      'Record a payment against a sales invoice, marking it (partly) paid. This books a mutation; ' +
      'correcting it means deleting the payment again.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice_id: z.string(),
      payment: paymentAttributes,
    }),
    handler: async (args, { client }) => {
      // The documented `register_payment` action is deprecated in favour of this nested collection.
      const response = await client.post(
        `sales_invoices/${encodeURIComponent(args.sales_invoice_id)}/payments`,
        { payment: args.payment },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'mark_sales_invoice_as_dubious',
    title: 'Mark sales invoice as dubious',
    description:
      'Flag a sales invoice as doubtful debt. Bookkeeping only; it does not write the invoice off.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice_id: z.string(),
      dubious_date: z
        .string()
        .optional()
        .describe('YYYY-MM-DD to book the flag on. Defaults to today.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `sales_invoices/${encodeURIComponent(args.sales_invoice_id)}/mark_as_dubious`,
        { ...(args.dubious_date ? { dubious_date: args.dubious_date } : {}) },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'mark_sales_invoice_as_uncollectible',
    title: 'Mark sales invoice as uncollectible',
    description:
      'Write a sales invoice off as uncollectible. This books a correction in the ledger and closes the invoice.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice_id: z.string(),
      uncollectible_date: z
        .string()
        .optional()
        .describe('YYYY-MM-DD to book the write-off on. Defaults to today.'),
      book_method: z.literal('revenue').optional().describe('Book the write-off against revenue.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `sales_invoices/${encodeURIComponent(args.sales_invoice_id)}/mark_as_uncollectible`,
        {
          ...(args.uncollectible_date ? { uncollectible_date: args.uncollectible_date } : {}),
          ...(args.book_method ? { book_method: args.book_method } : {}),
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'download_sales_invoice_pdf',
    title: 'Download sales invoice PDF',
    description:
      'Return a download URL for the invoice PDF. The link is signed and expires after 30 seconds, so use it ' +
      'immediately.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice_id: z.string(),
      media: z
        .literal('stationery')
        .optional()
        .describe('Renders without sender address and logo, for printing on letterhead.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `sales_invoices/${encodeURIComponent(args.sales_invoice_id)}/download_pdf`,
        {
          administrationId: args.administration_id,
          query: { ...(args.media ? { media: args.media } : {}) },
          manualRedirect: true,
        },
      );
      return textResult(response.redirectUrl ? { url: response.redirectUrl } : response.data);
    },
  }),

  defineTool({
    name: 'add_sales_invoice_note',
    title: 'Add note to sales invoice',
    description:
      'Attach an internal note to a sales invoice. Notes are never shown to the customer and can be flagged ' +
      'as a to-do with an assignee.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice_id: z.string(),
      note: z.string(),
      todo: z.boolean().optional().describe('Mark the note as a to-do.'),
      assignee_id: recordId.optional().describe('User to assign the to-do to, from list_users.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `sales_invoices/${encodeURIComponent(args.sales_invoice_id)}/notes`,
        {
          note: {
            note: args.note,
            ...(args.todo !== undefined ? { todo: args.todo } : {}),
            ...(args.assignee_id !== undefined ? { assignee_id: args.assignee_id } : {}),
          },
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'list_estimates',
    title: 'List estimates',
    description:
      'List estimates (quotes). Defaults to the current financial year, so pass an explicit `period` in the ' +
      'filter to look further back.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('state:accepted,period:this_year').describe(
        `Comma-separated \`key:value\` filter. Keys: ${ESTIMATE_FILTER_KEYS}. ` +
          "A filter replaces Moneybird's default of `period:this_year` entirely. Several states can be " +
          'combined with a pipe (`state:draft|open`).',
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('estimates', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_estimate',
    title: 'Get estimate',
    description:
      'Retrieve one estimate by its Moneybird id, or by the estimate number printed on the document ' +
      '(`estimate_number`, e.g. "2025-0001").',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      estimate_id: z.string().optional().describe('Moneybird estimate id.'),
      estimate_number: z
        .string()
        .optional()
        .describe('The estimate number as shown on the document.'),
    }),
    handler: async (args, { client }) => {
      if (!args.estimate_id && !args.estimate_number) {
        throw new Error('Provide either estimate_id or estimate_number.');
      }
      const path = args.estimate_id
        ? `estimates/${encodeURIComponent(args.estimate_id)}`
        : `estimates/find_by_estimate_id/${encodeURIComponent(args.estimate_number as string)}`;
      const response = await client.get(path, { administrationId: args.administration_id });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_estimate',
    title: 'Create estimate',
    description:
      'Create an estimate (quote) as a draft. Supply `contact_id` and the lines in `details_attributes`; ' +
      'send it afterwards with send_estimate.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      estimate: estimateAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'estimates',
        { estimate: args.estimate },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_estimate',
    title: 'Update estimate',
    description: 'Update an estimate. Only the attributes you supply change.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      estimate_id: z.string(),
      estimate: estimateAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `estimates/${encodeURIComponent(args.estimate_id)}`,
        { estimate: args.estimate },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_estimate',
    title: 'Delete estimate',
    description: 'Delete an estimate.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      estimate_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`estimates/${encodeURIComponent(args.estimate_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Estimate ${args.estimate_id} deleted.`);
    },
  }),

  defineTool({
    name: 'send_estimate',
    title: 'Send estimate',
    description:
      'Send an estimate to the customer. With no arguments the contact and workflow defaults are used. ' +
      'This reaches the customer and cannot be recalled.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      estimate_id: z.string(),
      delivery_method: z.enum(['Email', 'Manual']).optional(),
      email_address: z
        .string()
        .optional()
        .describe('Overrides the contact default. Email delivery only.'),
      email_message: z
        .string()
        .optional()
        .describe('Overrides the workflow text. Email delivery only.'),
      sign_online: z
        .boolean()
        .optional()
        .describe('Let the customer accept and sign the estimate online.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `estimates/${encodeURIComponent(args.estimate_id)}/send_estimate`,
        {
          estimate_sending: {
            ...(args.delivery_method ? { delivery_method: args.delivery_method } : {}),
            ...(args.email_address ? { email_address: args.email_address } : {}),
            ...(args.email_message ? { email_message: args.email_message } : {}),
            ...(args.sign_online !== undefined ? { sign_online: args.sign_online } : {}),
          },
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'bill_estimate',
    title: 'Bill estimate',
    description:
      'Turn an accepted or open estimate into a sales invoice. The invoice is created as a draft; send it ' +
      'separately with send_sales_invoice.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      estimate_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `estimates/${encodeURIComponent(args.estimate_id)}/bill_estimate`,
        {},
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'download_estimate_pdf',
    title: 'Download estimate PDF',
    description:
      'Return a download URL for the estimate PDF. The link is signed and expires after 30 seconds, so use it ' +
      'immediately.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      estimate_id: z.string(),
      media: z
        .literal('stationery')
        .optional()
        .describe('Renders without sender address and logo, for printing on letterhead.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `estimates/${encodeURIComponent(args.estimate_id)}/download_pdf`,
        {
          administrationId: args.administration_id,
          query: { ...(args.media ? { media: args.media } : {}) },
          manualRedirect: true,
        },
      );
      return textResult(response.redirectUrl ? { url: response.redirectUrl } : response.data);
    },
  }),

  defineTool({
    name: 'list_recurring_sales_invoices',
    title: 'List recurring sales invoices',
    description:
      'List the recurring invoice schedules. Only active schedules are returned unless the filter says otherwise.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('state:active,frequency:month').describe(
        `Comma-separated \`key:value\` filter. Keys: ${RECURRING_SALES_INVOICE_FILTER_KEYS}. ` +
          "A filter replaces Moneybird's default of `state:active` entirely.",
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('recurring_sales_invoices', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_recurring_sales_invoice',
    title: 'Get recurring sales invoice',
    description:
      'Retrieve one recurring invoice schedule, including its lines and next invoice date.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      recurring_sales_invoice_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `recurring_sales_invoices/${encodeURIComponent(args.recurring_sales_invoice_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_recurring_sales_invoice',
    title: 'Create recurring sales invoice',
    description:
      'Create a schedule that generates sales invoices automatically. Needs `contact_id`, `details_attributes` ' +
      'and a planning: `invoice_date` for the first invoice plus `frequency` and `frequency_type`.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      recurring_sales_invoice: recurringSalesInvoiceAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'recurring_sales_invoices',
        { recurring_sales_invoice: args.recurring_sales_invoice },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_recurring_sales_invoice',
    title: 'Update recurring sales invoice',
    description:
      'Update a recurring invoice schedule. Moneybird refuses this while an active subscription drives the schedule.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      recurring_sales_invoice_id: z.string(),
      recurring_sales_invoice: recurringSalesInvoiceAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `recurring_sales_invoices/${encodeURIComponent(args.recurring_sales_invoice_id)}`,
        { recurring_sales_invoice: args.recurring_sales_invoice },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_recurring_sales_invoice',
    title: 'Delete recurring sales invoice',
    description:
      'Stop a recurring invoice schedule. It is deleted when it never produced an invoice, and deactivated ' +
      'otherwise so the invoices it created stay intact.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      recurring_sales_invoice_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `recurring_sales_invoices/${encodeURIComponent(args.recurring_sales_invoice_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(
        `Recurring sales invoice ${args.recurring_sales_invoice_id} deleted or deactivated.`,
      );
    },
  }),

  defineTool({
    name: 'list_external_sales_invoices',
    title: 'List external sales invoices',
    description:
      'List revenue invoiced outside Moneybird, e.g. by a webshop or POS. Defaults to the current financial ' +
      'year, so pass an explicit `period` in the filter to look further back.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('state:open,period:this_year').describe(
        `Comma-separated \`key:value\` filter. Keys: ${EXTERNAL_SALES_INVOICE_FILTER_KEYS}. ` +
          "A filter replaces Moneybird's default of `period:this_year` entirely. Several states can be " +
          'combined with a pipe (`state:new|open`).',
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('external_sales_invoices', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_external_sales_invoice',
    title: 'Get external sales invoice',
    description: 'Retrieve one external sales invoice, including its lines and payments.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      external_sales_invoice_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `external_sales_invoices/${encodeURIComponent(args.external_sales_invoice_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_external_sales_invoice',
    title: 'Create external sales invoice',
    description:
      'Book revenue that was invoiced outside Moneybird. Unlike a sales invoice this is never sent to the ' +
      'customer; it only records the amounts and their ledger accounts.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      external_sales_invoice: externalSalesInvoiceAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'external_sales_invoices',
        { external_sales_invoice: args.external_sales_invoice },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_external_sales_invoice',
    title: 'Update external sales invoice',
    description: 'Update an external sales invoice. Only the attributes you supply change.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      external_sales_invoice_id: z.string(),
      external_sales_invoice: externalSalesInvoiceAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `external_sales_invoices/${encodeURIComponent(args.external_sales_invoice_id)}`,
        { external_sales_invoice: args.external_sales_invoice },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_external_sales_invoice',
    title: 'Delete external sales invoice',
    description: 'Delete an external sales invoice and the revenue it booked.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      external_sales_invoice_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `external_sales_invoices/${encodeURIComponent(args.external_sales_invoice_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`External sales invoice ${args.external_sales_invoice_id} deleted.`);
    },
  }),

  defineTool({
    name: 'register_external_sales_invoice_payment',
    title: 'Register external sales invoice payment',
    description:
      'Record a payment against an external sales invoice, marking it (partly) paid. This books a mutation.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      external_sales_invoice_id: z.string(),
      payment: paymentAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `external_sales_invoices/${encodeURIComponent(args.external_sales_invoice_id)}/payments`,
        { payment: args.payment },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'list_subscriptions',
    title: 'List subscriptions',
    description:
      'List the subscriptions of one contact. Moneybird has no administration-wide subscription list, so ' +
      '`contact_id` is required.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string().describe('Contact whose subscriptions to list.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.get('subscriptions', {
        administrationId: args.administration_id,
        query: { contact_id: args.contact_id },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_subscription',
    title: 'Get subscription',
    description:
      'Retrieve one subscription, including its product, billing cycle and recurring invoice.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      subscription_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `subscriptions/${encodeURIComponent(args.subscription_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_subscription',
    title: 'Create subscription',
    description:
      'Subscribe a contact to a product. Moneybird creates the recurring sales invoice behind it and bills ' +
      'from `start_date`, at the earliest tomorrow.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      subscription: z
        .object({
          start_date: z.string().describe('YYYY-MM-DD the subscription starts billing.'),
          product_id: recordId.describe(
            'Product carrying the price, description and frequency, from list_products.',
          ),
          contact_id: recordId.optional(),
          contact_person_id: recordId.optional(),
          amount: z
            .union([z.string(), z.number()])
            .optional()
            .describe('Quantity billed each period.'),
          discount: money.optional().describe('Discount percentage on the subscription.'),
          end_date: z.string().optional().describe('YYYY-MM-DD the subscription stops.'),
          reference: z.string().optional().describe('Reference printed on the generated invoices.'),
          document_style_id: recordId.optional(),
          frequency: z
            .number()
            .int()
            .optional()
            .describe('Periods between invoices; must be compatible with the product frequency.'),
          frequency_type: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
          mergeable: z.boolean().optional(),
          prices_are_incl_tax: z.boolean().optional(),
        })
        .loose(),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'subscriptions',
        { subscription: args.subscription },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_subscription',
    title: 'Update subscription',
    description:
      'Change the product, quantity or settings of a subscription. Switching product makes Moneybird bill ' +
      'the price difference for the remaining period on a one-off invoice.',
    toolset: 'invoicing',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      subscription_id: z.string(),
      subscription: z
        .object({
          product_id: recordId.optional().describe('New product to switch to.'),
          start_date: z.string().optional().describe('YYYY-MM-DD the change takes effect.'),
          amount: z
            .union([z.string(), z.number()])
            .optional()
            .describe('Quantity billed each period.'),
          discount: money.optional(),
          contact_person_id: recordId.optional(),
          document_style_id: recordId.optional(),
          reference: z.string().optional(),
          mergeable: z.boolean().optional(),
          prices_are_incl_tax: z.boolean().optional(),
        })
        .loose(),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `subscriptions/${encodeURIComponent(args.subscription_id)}`,
        { subscription: args.subscription },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'cancel_subscription',
    title: 'Cancel subscription',
    description:
      'Cancel a subscription and stop its recurring invoices. Pass `end_date` to let it run until a future date.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      subscription_id: z.string(),
      end_date: z.string().optional().describe('YYYY-MM-DD to stop on. Omit to stop immediately.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.delete(
        `subscriptions/${encodeURIComponent(args.subscription_id)}`,
        {
          administrationId: args.administration_id,
          body: { subscription: { ...(args.end_date ? { end_date: args.end_date } : {}) } },
        },
      );
      return textResult(response.data ?? `Subscription ${args.subscription_id} cancelled.`);
    },
  }),

  defineTool({
    name: 'list_subscription_templates',
    title: 'List subscription templates',
    description:
      'List the subscription templates of the administration. Requires the `settings` scope rather than ' +
      '`sales_invoices`.',
    toolset: 'invoicing',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('subscription_templates', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'delete_sales_invoice_payment',
    title: 'Delete sales invoice payment',
    description:
      'Remove a payment from a sales invoice, returning the invoice to unpaid for that amount. ' +
      'Payment ids come from the invoice itself via get_sales_invoice.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      sales_invoice_id: z.string(),
      payment_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `sales_invoices/${encodeURIComponent(args.sales_invoice_id)}/payments/${encodeURIComponent(args.payment_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(
        `Payment ${args.payment_id} removed from sales invoice ${args.sales_invoice_id}.`,
      );
    },
  }),

  defineTool({
    name: 'delete_external_sales_invoice_payment',
    title: 'Delete external sales invoice payment',
    description:
      'Remove a payment from an external sales invoice. Payment ids come from get_external_sales_invoice.',
    toolset: 'invoicing',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      external_sales_invoice_id: z.string(),
      payment_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `external_sales_invoices/${encodeURIComponent(args.external_sales_invoice_id)}/payments/${encodeURIComponent(args.payment_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(
        `Payment ${args.payment_id} removed from external sales invoice ${args.external_sales_invoice_id}.`,
      );
    },
  }),
] as const;

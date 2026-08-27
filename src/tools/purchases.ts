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

const DOCUMENT_FILTER_KEYS =
  'period (named period such as this_year/prev_quarter, or a range like 20260101..20260131), ' +
  'state (all|new|saved|open|paid|late|pending_payment — paid, late and pending_payment only apply to ' +
  'purchase invoices and receipts), recurring (all|enabled|disabled), attachment (all|with|without), ' +
  'reference, contact_id, ledger_account_id, updated_after (ISO 8601 UTC)';

const FILTER_NOTE =
  'Moneybird defaults to `period:this_year`, so pass an explicit `period` to look outside the current ' +
  'financial year. Values for `state`, `recurring` and `attachment` may be combined with a pipe, e.g. `state:open|paid`.';

/** Every document type in this toolset lives under the same `documents/` namespace. */
const DOCUMENT_PATHS = {
  purchase_invoice: 'documents/purchase_invoices',
  receipt: 'documents/receipts',
  general_document: 'documents/general_documents',
  general_journal_document: 'documents/general_journal_documents',
  typeless_document: 'documents/typeless_documents',
} as const;

const notableDocumentType = z
  .enum(['purchase_invoice', 'receipt', 'general_document', 'general_journal_document'])
  .describe('Typeless documents do not accept notes.');

const attachableDocumentType = z.enum([
  'purchase_invoice',
  'receipt',
  'general_document',
  'general_journal_document',
  'typeless_document',
]);

const payableDocumentType = z
  .enum(['purchase_invoice', 'receipt'])
  .describe('Only these two document types have a payment lifecycle.');

const money = z
  .union([z.string(), z.number()])
  .describe('Amount of money; a decimal string such as "10.95" is safest.');

/**
 * A document line, as accepted by purchase invoices and receipts.
 *
 * Passthrough for the same reason `contactAttributes` is: Moneybird accepts more keys on a detail
 * than are worth enumerating, and rejecting them here would block requests the API allows.
 */
const detailAttributes = z
  .object({
    id: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Id of an existing line to update or remove.'),
    description: z.string().optional(),
    period: z
      .string()
      .optional()
      .describe(
        'Range like `20260101..20261231` or a preset such as `this_quarter`; defers the amount over that period.',
      ),
    price: money.optional(),
    amount: z.union([z.string(), z.number()]).optional().describe('Quantity, defaults to 1.'),
    tax_rate_id: z.union([z.string(), z.number()]).optional(),
    ledger_account_id: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Category this line books against.'),
    project_id: z.union([z.string(), z.number()]).optional(),
    product_id: z.union([z.string(), z.number()]).optional(),
    row_order: z.union([z.string(), z.number()]).optional(),
    automated_tax_enabled: z.boolean().optional(),
    _destroy: z.boolean().optional().describe('Removes the line named by `id`.'),
  })
  .loose();

/** Moneybird accepts nested attributes either as a list or as an object keyed by index. */
const detailsAttributesField = z
  .union([z.array(detailAttributes), z.record(z.string(), detailAttributes)])
  .optional()
  .describe('Document lines, as a list or as an object keyed by index, e.g. `{"0": {...}}`.');

const fiscalAllocationAttributes = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    ledger_account_id: z.union([z.string(), z.number()]).optional(),
    private_ledger_account_id: z.union([z.string(), z.number()]).optional(),
    percentage: money.optional().describe('Share booked to the private ledger account.'),
    _destroy: z.boolean().optional(),
  })
  .loose();

const fiscalAllocationsAttributesField = z
  .union([z.array(fiscalAllocationAttributes), z.record(z.string(), fiscalAllocationAttributes)])
  .optional()
  .describe(
    'Splits the document between business and private use, as a list or an index-keyed object.',
  );

const purchaseInvoiceAttributes = z
  .object({
    contact_id: z.union([z.string(), z.number()]).optional().describe('The supplier.'),
    reference: z.string().optional().describe("The supplier's invoice number."),
    date: z.string().optional().describe('Invoice date, `YYYY-MM-DD`.'),
    due_date: z.string().optional().describe('`YYYY-MM-DD`.'),
    currency: z.string().length(3).optional().describe('ISO 4217 currency code.'),
    prices_are_incl_tax: z.boolean().optional(),
    revenue_invoice: z
      .boolean()
      .optional()
      .describe(
        'Books the document as income instead of expense, e.g. a credit note from a supplier.',
      ),
    details_attributes: detailsAttributesField,
    fiscal_allocations_attributes: fiscalAllocationsAttributesField,
  })
  .loose();

const receiptAttributes = z
  .object({
    contact_id: z.union([z.string(), z.number()]).optional().describe('The supplier.'),
    reference: z.string().optional(),
    date: z.string().optional().describe('Receipt date, `YYYY-MM-DD`.'),
    currency: z.string().length(3).optional().describe('ISO 4217 currency code.'),
    prices_are_incl_tax: z.boolean().optional(),
    details_attributes: detailsAttributesField,
    fiscal_allocations_attributes: fiscalAllocationsAttributesField,
  })
  .loose();

const generalDocumentAttributes = z
  .object({
    reference: z.string().optional().describe('Required when creating.'),
    date: z.string().optional().describe('`YYYY-MM-DD`. Required when creating.'),
    due_date: z.string().optional(),
    reminder_date: z.string().optional(),
    contact_id: z.union([z.string(), z.number()]).optional(),
    reminder: z
      .object({
        date: z.string(),
        message: z.string().optional(),
      })
      .loose()
      .optional()
      .describe('Creates a reminder to-do for this document.'),
  })
  .loose();

const generalJournalDocumentEntry = z
  .object({
    id: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Id of an existing entry to update or remove.'),
    ledger_account_id: z.union([z.string(), z.number()]).optional(),
    tax_rate_id: z.union([z.string(), z.number()]).optional(),
    description: z.string().optional(),
    debit: money.optional().describe('Set this or `credit`, not both.'),
    credit: money.optional().describe('Set this or `debit`, not both.'),
    project_id: z.union([z.string(), z.number()]).optional(),
    contact_id: z.union([z.string(), z.number()]).optional(),
    row_order: z.union([z.string(), z.number()]).optional(),
    _destroy: z.boolean().optional().describe('Removes the entry named by `id`.'),
  })
  .loose();

const generalJournalDocumentAttributes = z
  .object({
    reference: z.string().optional(),
    date: z.string().optional().describe('`YYYY-MM-DD`, defaults to today.'),
    journal_type: z
      .string()
      .optional()
      .describe('`fiscal_year_ending` for a year-end entry; omit for a normal one.'),
    general_journal_document_entries_attributes: z
      .union([
        z.array(generalJournalDocumentEntry),
        z.record(z.string(), generalJournalDocumentEntry),
      ])
      .optional()
      .describe('Journal entries, as a list or as an object keyed by index, e.g. `{"0": {...}}`.'),
  })
  .loose();

const typelessDocumentAttributes = z
  .object({
    reference: z.string().optional(),
    date: z.string().optional().describe('`YYYY-MM-DD`, defaults to today.'),
    contact_id: z.union([z.string(), z.number()]).optional(),
  })
  .loose();

const paymentFields = {
  payment_date: z.string().describe('`YYYY-MM-DD`.'),
  price: money,
  price_base: money
    .optional()
    .describe('Amount in the administration currency when the document is in a foreign currency.'),
  financial_account_id: z.union([z.string(), z.number()]).optional(),
  financial_mutation_id: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Bank mutation this payment settles.'),
  transaction_identifier: z
    .string()
    .optional()
    .describe('External reference, e.g. a bank transaction id.'),
  manual_payment_action: z
    .enum([
      'private_payment',
      'payment_without_proof',
      'cash_payment',
      'rounding_error',
      'bank_transfer',
      'balance_settlement',
      'invoices_settlement',
    ])
    .optional()
    .describe(
      '`private_payment` and `cash_payment` need `financial_account_id`, `bank_transfer` needs ' +
        '`financial_mutation_id`, `balance_settlement` needs `ledger_account_id`, `invoices_settlement` needs `invoice_id`.',
    ),
  ledger_account_id: z.union([z.string(), z.number()]).optional(),
  invoice_id: z.union([z.string(), z.number()]).optional(),
};

function paymentBody(args: {
  payment_date: string;
  price: string | number;
  price_base?: string | number | undefined;
  financial_account_id?: string | number | undefined;
  financial_mutation_id?: string | number | undefined;
  transaction_identifier?: string | undefined;
  manual_payment_action?: string | undefined;
  ledger_account_id?: string | number | undefined;
  invoice_id?: string | number | undefined;
}): { payment: Record<string, unknown> } {
  const { payment_date, price, ...optional } = args;
  const payment: Record<string, unknown> = { payment_date, price };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) payment[key] = value;
  }
  return { payment };
}

export const purchasesTools: readonly ToolDefinition[] = [
  defineTool({
    name: 'list_purchase_invoices',
    title: 'List purchase invoices',
    description:
      'List purchase invoices (bills received from suppliers), newest first. ' +
      `Narrow with \`filter\`; keys: ${DOCUMENT_FILTER_KEYS}.`,
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('period:prev_year,state:open').describe(
        `Comma-separated \`key:value\` filter. Keys: ${DOCUMENT_FILTER_KEYS}. ${FILTER_NOTE}`,
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('documents/purchase_invoices', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_purchase_invoice',
    title: 'Get purchase invoice',
    description:
      'Retrieve one purchase invoice by id, with its lines, payments, attachments and notes.',
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      purchase_invoice_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `documents/purchase_invoices/${encodeURIComponent(args.purchase_invoice_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_purchase_invoice',
    title: 'Create purchase invoice',
    description:
      'Book a supplier invoice. Supply `contact_id` for the supplier, the supplier `reference` and `date`, ' +
      'and one line per amount in `details_attributes`.',
    toolset: 'purchases',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      purchase_invoice: purchaseInvoiceAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'documents/purchase_invoices',
        { purchase_invoice: args.purchase_invoice },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_purchase_invoice',
    title: 'Update purchase invoice',
    description:
      'Update a purchase invoice. Only the attributes you supply change; to edit a line pass its `id` ' +
      'inside `details_attributes`, and to drop one pass its `id` with `_destroy: true`.',
    toolset: 'purchases',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      purchase_invoice_id: z.string(),
      purchase_invoice: purchaseInvoiceAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `documents/purchase_invoices/${encodeURIComponent(args.purchase_invoice_id)}`,
        { purchase_invoice: args.purchase_invoice },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_purchase_invoice',
    title: 'Delete purchase invoice',
    description: 'Permanently delete a purchase invoice, including its lines and bookings.',
    toolset: 'purchases',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      purchase_invoice_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `documents/purchase_invoices/${encodeURIComponent(args.purchase_invoice_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`Purchase invoice ${args.purchase_invoice_id} deleted.`);
    },
  }),

  defineTool({
    name: 'register_purchase_invoice_payment',
    title: 'Register purchase invoice payment',
    description:
      'Record a payment against a purchase invoice, marking it (partly) paid. Give `payment_date` and `price`, ' +
      'plus either `financial_mutation_id` to settle a bank mutation or a `manual_payment_action`.',
    toolset: 'purchases',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      purchase_invoice_id: z.string(),
      ...paymentFields,
    }),
    handler: async (args, { client }) => {
      const { administration_id, purchase_invoice_id, ...payment } = args;
      const response = await client.post(
        `documents/purchase_invoices/${encodeURIComponent(purchase_invoice_id)}/payments`,
        paymentBody(payment),
        { administrationId: administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'list_receipts',
    title: 'List receipts',
    description:
      'List receipts (expenses paid on the spot, without a supplier invoice). ' +
      `Narrow with \`filter\`; keys: ${DOCUMENT_FILTER_KEYS}.`,
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('period:this_quarter,state:open').describe(
        `Comma-separated \`key:value\` filter. Keys: ${DOCUMENT_FILTER_KEYS}. ${FILTER_NOTE}`,
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('documents/receipts', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_receipt',
    title: 'Get receipt',
    description: 'Retrieve one receipt by id, with its lines, payments, attachments and notes.',
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      receipt_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `documents/receipts/${encodeURIComponent(args.receipt_id)}`,
        {
          administrationId: args.administration_id,
        },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_receipt',
    title: 'Create receipt',
    description:
      'Book a receipt. Pass `financial_account_id` to record it as already paid from that account.',
    toolset: 'purchases',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      receipt: receiptAttributes,
      financial_account_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Marks the receipt as paid from this financial account.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'documents/receipts',
        {
          receipt: args.receipt,
          ...(args.financial_account_id !== undefined
            ? { payment: { financial_account_id: args.financial_account_id } }
            : {}),
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_receipt',
    title: 'Update receipt',
    description:
      'Update a receipt. Only the attributes you supply change; to edit a line pass its `id` inside ' +
      '`details_attributes`, and to drop one pass its `id` with `_destroy: true`.',
    toolset: 'purchases',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      receipt_id: z.string(),
      receipt: receiptAttributes,
      financial_account_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Marks the receipt as paid from this financial account.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `documents/receipts/${encodeURIComponent(args.receipt_id)}`,
        {
          receipt: args.receipt,
          ...(args.financial_account_id !== undefined
            ? { payment: { financial_account_id: args.financial_account_id } }
            : {}),
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_receipt',
    title: 'Delete receipt',
    description: 'Permanently delete a receipt, including its lines and bookings.',
    toolset: 'purchases',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      receipt_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`documents/receipts/${encodeURIComponent(args.receipt_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Receipt ${args.receipt_id} deleted.`);
    },
  }),

  defineTool({
    name: 'register_receipt_payment',
    title: 'Register receipt payment',
    description:
      'Record a payment against a receipt, marking it (partly) paid. Give `payment_date` and `price`, plus ' +
      'either `financial_mutation_id` to settle a bank mutation or a `manual_payment_action`.',
    toolset: 'purchases',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      receipt_id: z.string(),
      ...paymentFields,
    }),
    handler: async (args, { client }) => {
      const { administration_id, receipt_id, ...payment } = args;
      const response = await client.post(
        `documents/receipts/${encodeURIComponent(receipt_id)}/payments`,
        paymentBody(payment),
        { administrationId: administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'list_general_documents',
    title: 'List general documents',
    description:
      'List general documents: filed paperwork such as contracts and correspondence that carries a date and ' +
      `reference but no amounts. Narrow with \`filter\`; keys: ${DOCUMENT_FILTER_KEYS}.`,
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('period:this_year,attachment:with').describe(
        `Comma-separated \`key:value\` filter. Keys: ${DOCUMENT_FILTER_KEYS}. ${FILTER_NOTE}`,
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('documents/general_documents', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_general_document',
    title: 'Get general document',
    description: 'Retrieve one general document by id, with its attachments and notes.',
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      general_document_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `documents/general_documents/${encodeURIComponent(args.general_document_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_general_document',
    title: 'Create general document',
    description: 'File a general document. `reference` and `date` are required.',
    toolset: 'purchases',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      general_document: generalDocumentAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'documents/general_documents',
        { general_document: args.general_document },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_general_document',
    title: 'Update general document',
    description:
      'Update a general document. Set `remove_contact` to detach the contact currently linked to it.',
    toolset: 'purchases',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      general_document_id: z.string(),
      general_document: generalDocumentAttributes,
      remove_contact: z.boolean().optional().describe('Unlinks the document from its contact.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `documents/general_documents/${encodeURIComponent(args.general_document_id)}`,
        {
          general_document: args.general_document,
          ...(args.remove_contact !== undefined ? { remove_contact: args.remove_contact } : {}),
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_general_document',
    title: 'Delete general document',
    description: 'Permanently delete a general document and its attachments.',
    toolset: 'purchases',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      general_document_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `documents/general_documents/${encodeURIComponent(args.general_document_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`General document ${args.general_document_id} deleted.`);
    },
  }),

  defineTool({
    name: 'list_general_journal_documents',
    title: 'List general journal documents',
    description:
      'List general journal documents (manual journal entries). ' +
      `Narrow with \`filter\`; keys: ${DOCUMENT_FILTER_KEYS}.`,
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('period:prev_year').describe(
        `Comma-separated \`key:value\` filter. Keys: ${DOCUMENT_FILTER_KEYS}. ${FILTER_NOTE}`,
      ),
      exclude_new_general_journal_documents: z
        .boolean()
        .optional()
        .describe('Leaves out entries that are still in the `new` state.'),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('documents/general_journal_documents', {
        administrationId: args.administration_id,
        query: {
          ...listQuery(args),
          ...(args.exclude_new_general_journal_documents !== undefined
            ? { exclude_new_general_journal_documents: args.exclude_new_general_journal_documents }
            : {}),
        },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_general_journal_document',
    title: 'Get general journal document',
    description: 'Retrieve one general journal document by id, with its debit and credit entries.',
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      general_journal_document_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `documents/general_journal_documents/${encodeURIComponent(args.general_journal_document_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_general_journal_document',
    title: 'Create general journal document',
    description:
      'Book a manual journal entry. `general_journal_document_entries_attributes` takes either a list of ' +
      'entries or an object keyed by index — the two forms are interchangeable, so pick one and do not mix them. ' +
      'Each entry names a `ledger_account_id` and carries either `debit` or `credit`, never both, and the debit ' +
      'total must equal the credit total.',
    toolset: 'purchases',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      general_journal_document: generalJournalDocumentAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'documents/general_journal_documents',
        { general_journal_document: args.general_journal_document },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_general_journal_document',
    title: 'Update general journal document',
    description:
      'Update a manual journal entry. Entries you pass in `general_journal_document_entries_attributes` need ' +
      'their `id` to be changed or `_destroy: true` to be removed; entries you leave out stay as they are, and ' +
      'the debit and credit totals must still match afterwards.',
    toolset: 'purchases',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      general_journal_document_id: z.string(),
      general_journal_document: generalJournalDocumentAttributes,
      all_taxes: z
        .boolean()
        .optional()
        .describe('Allows every tax rate to be picked on the entries, not just the usual ones.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `documents/general_journal_documents/${encodeURIComponent(args.general_journal_document_id)}`,
        {
          general_journal_document: args.general_journal_document,
          ...(args.all_taxes !== undefined ? { all_taxes: args.all_taxes } : {}),
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_general_journal_document',
    title: 'Delete general journal document',
    description: 'Permanently delete a manual journal entry and reverse its bookings.',
    toolset: 'purchases',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      general_journal_document_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `documents/general_journal_documents/${encodeURIComponent(args.general_journal_document_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`General journal document ${args.general_journal_document_id} deleted.`);
    },
  }),

  defineTool({
    name: 'list_typeless_documents',
    title: 'List typeless documents',
    description:
      'List typeless documents: uploads parked in Moneybird that have not been classified as an invoice, ' +
      `receipt or anything else yet. Narrow with \`filter\`; keys: ${DOCUMENT_FILTER_KEYS}.`,
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('period:this_month').describe(
        `Comma-separated \`key:value\` filter. Keys: ${DOCUMENT_FILTER_KEYS}. ${FILTER_NOTE}`,
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('documents/typeless_documents', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_typeless_document',
    title: 'Get typeless document',
    description: 'Retrieve one typeless document by id, with its attachments.',
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      typeless_document_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `documents/typeless_documents/${encodeURIComponent(args.typeless_document_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_typeless_document',
    title: 'Create typeless document',
    description:
      'Create a typeless document to park an upload that has not been classified yet. Moneybird offers no ' +
      'update endpoint for this type, so its reference, date and contact are fixed at creation — only its ' +
      'attachments can be changed afterwards. Delete and recreate it to correct a mistake.',
    toolset: 'purchases',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      typeless_document: typelessDocumentAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'documents/typeless_documents',
        { typeless_document: args.typeless_document },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_typeless_document',
    title: 'Delete typeless document',
    description: 'Permanently delete a typeless document and its attachments.',
    toolset: 'purchases',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      typeless_document_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `documents/typeless_documents/${encodeURIComponent(args.typeless_document_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`Typeless document ${args.typeless_document_id} deleted.`);
    },
  }),

  defineTool({
    name: 'add_document_note',
    title: 'Add note to document',
    description:
      'Attach a note to a purchase invoice, receipt, general document or general journal document. ' +
      'A note can be flagged as a to-do and assigned to a user.',
    toolset: 'purchases',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      document_type: notableDocumentType,
      document_id: z.string(),
      note: z.string(),
      todo: z.boolean().optional().describe('Turns the note into a to-do.'),
      assignee_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe('User the to-do is assigned to.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `${DOCUMENT_PATHS[args.document_type]}/${encodeURIComponent(args.document_id)}/notes`,
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
    name: 'download_document_attachment',
    title: 'Download document attachment',
    description:
      'Return a temporary download URL for one attachment of a document. Get the attachment ids from the ' +
      'document itself with get_purchase_invoice, get_receipt or the matching get tool.',
    toolset: 'purchases',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      document_type: attachableDocumentType,
      document_id: z.string(),
      attachment_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `${DOCUMENT_PATHS[args.document_type]}/${encodeURIComponent(args.document_id)}` +
          `/attachments/${encodeURIComponent(args.attachment_id)}/download`,
        { administrationId: args.administration_id, manualRedirect: true },
      );
      return textResult({ url: response.redirectUrl });
    },
  }),

  defineTool({
    name: 'delete_document_attachment',
    title: 'Delete document attachment',
    description: 'Permanently remove one attachment from a document; the document itself is kept.',
    toolset: 'purchases',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      document_type: attachableDocumentType,
      document_id: z.string(),
      attachment_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `${DOCUMENT_PATHS[args.document_type]}/${encodeURIComponent(args.document_id)}` +
          `/attachments/${encodeURIComponent(args.attachment_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`Attachment ${args.attachment_id} deleted.`);
    },
  }),

  defineTool({
    name: 'delete_document_payment',
    title: 'Delete document payment',
    description:
      'Remove a payment from a purchase invoice or receipt, putting the document back to unpaid for that amount.',
    toolset: 'purchases',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      document_type: payableDocumentType,
      document_id: z.string(),
      payment_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `${DOCUMENT_PATHS[args.document_type]}/${encodeURIComponent(args.document_id)}` +
          `/payments/${encodeURIComponent(args.payment_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`Payment ${args.payment_id} deleted.`);
    },
  }),
] as const;

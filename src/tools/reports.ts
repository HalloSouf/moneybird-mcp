import { z } from 'zod';
import {
  administrationIdField,
  defineTool,
  emptyResult,
  listQuery,
  listResult,
  paginationFields,
  textResult,
  type ToolDefinition,
} from './common.js';

/**
 * Appended to every `reports/*` tool description.
 *
 * Reports are metered separately from the rest of the API, so a model that fans out across a
 * handful of report tools exhausts the budget while the other toolsets are still untouched.
 */
const RATE_LIMIT_NOTE =
  ' Reports have their own tighter rate limit of 50 requests per 5 minutes (the rest of the API allows 150), ' +
  'so pick the one report that answers the question instead of calling several.';

const PERIOD_RANGE_FORMATS =
  'Ranges are `YYYYMMDD..YYYYMMDD` (e.g. `20250101..20250331`), `YYYYMM..YYYYMM` (e.g. `202501..202503`) or a ' +
  'single `YYYYMM` (e.g. `202501`), and must cover whole months.';

const periodField = z
  .string()
  .optional()
  .describe(
    `Reporting period, defaults to \`this_month\`. ${PERIOD_RANGE_FORMATS} ` +
      'Presets: `this_month`, `prev_month`, `next_month`, `this_quarter`, `prev_quarter`, `next_quarter`, ' +
      '`this_year`, `prev_year`, `next_year`. Maximum span is 12 months.',
  );

const periodMonthField = z
  .string()
  .optional()
  .describe(
    'Reporting period, defaults to `this_month`. This endpoint accepts exactly one whole month: `YYYYMM` ' +
      '(e.g. `202501`), `YYYYMM..YYYYMM` with the same month on both sides, or `YYYYMMDD..YYYYMMDD` spanning ' +
      'one whole month. Presets: `this_month`, `prev_month`, `next_month`. Quarter and year presets are rejected here.',
  );

const periodUntilField = z
  .string()
  .optional()
  .describe(
    'Cut-off period the ageing is calculated up to, defaults to `this_month`. Either `YYYYMM` (e.g. `202501`) ' +
      'or one of `this_month`, `prev_month`, `this_quarter`, `prev_quarter`, `this_year`, `prev_year`.',
  );

/** The `period_month` parameter is named `period` on the wire; only its accepted values differ. */
function periodQuery(period: string | undefined): Record<string, string | undefined> {
  return period ? { period } : {};
}

const exportYearField = z
  .string()
  .describe('Calendar year to export, e.g. "2024". Must contain journal entries.');

const financialMutationAttributes = z
  .object({
    id: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Id of an existing mutation to update; omit when adding a new one.'),
    date: z.string().optional().describe('Transaction date, YYYY-MM-DD.'),
    valutation_date: z
      .string()
      .optional()
      .describe('Value date, YYYY-MM-DD, when it differs from `date`.'),
    message: z.string().optional().describe('Bank narrative of the transaction.'),
    amount: z
      .string()
      .optional()
      .describe('Decimal string; negative for money leaving the account.'),
    contra_account_name: z.string().optional().describe("Counterparty's account holder name."),
    contra_account_number: z.string().optional().describe('Counterparty IBAN.'),
    batch_reference: z.string().optional(),
    offset: z.number().int().optional().describe('Position of this mutation within the statement.'),
    account_servicer_transaction_id: z
      .string()
      .optional()
      .describe('Bank-assigned transaction id, used for deduplication.'),
    _destroy: z
      .boolean()
      .optional()
      .describe('Set to true to remove this mutation from the statement.'),
  })
  .loose();

const financialMutationsField = z
  .union([z.array(financialMutationAttributes), z.record(z.string(), financialMutationAttributes)])
  .optional()
  .describe(
    'Either an array of mutations, or an index-keyed object such as `{"0": {...}, "1": {...}}`.',
  );

export const reportsTools: readonly ToolDefinition[] = [
  defineTool({
    name: 'get_profit_loss_report',
    title: 'Profit and loss report',
    description:
      'Profit and loss over a period, broken down per ledger account. Nested ledger accounts are listed flat, ' +
      'so a parent amount excludes its children and the items of a section sum to that section without double counting. ' +
      'Sections are not signed alike: revenue and other income are credit minus debit, direct costs and expenses are ' +
      'debit minus credit.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodField,
      project_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Limit the report to one project.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/profit_loss', {
        administrationId: args.administration_id,
        query: {
          ...periodQuery(args.period),
          ...(args.project_id !== undefined ? { project_id: String(args.project_id) } : {}),
        },
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'get_balance_sheet_report',
    title: 'Balance sheet report',
    description:
      'Balance sheet showing assets, liabilities and equity as they stand at the end of the period.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodField,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/balance_sheet', {
        administrationId: args.administration_id,
        query: periodQuery(args.period),
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'get_general_ledger_report',
    title: 'General ledger report',
    description:
      'Every ledger account with its opening balance, movements and closing balance over the period.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodField,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/general_ledger', {
        administrationId: args.administration_id,
        query: periodQuery(args.period),
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'get_cash_flow_report',
    title: 'Cash flow report',
    description:
      'Cash received and cash paid during the period, optionally for a single financial account.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
      financial_account_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'Limit the report to one bank account; call list_financial_accounts for the ids.',
        ),
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/cash_flow', {
        administrationId: args.administration_id,
        query: {
          ...periodQuery(args.period),
          ...(args.financial_account_id !== undefined
            ? { financial_account_id: String(args.financial_account_id) }
            : {}),
        },
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'get_tax_report',
    title: 'Tax report',
    description:
      'VAT return figures for the period: turnover and VAT per rate, plus input VAT to reclaim.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/tax', {
        administrationId: args.administration_id,
        query: periodQuery(args.period),
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'get_assets_report',
    title: 'Assets report',
    description:
      'Fixed asset overview for the period, with purchase value, depreciation and book value per asset.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/assets', {
        administrationId: args.administration_id,
        query: periodQuery(args.period),
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'get_subscriptions_report',
    title: 'Subscriptions report',
    description:
      "Recurring revenue for the period, based on the administration's subscriptions." +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/subscriptions', {
        administrationId: args.administration_id,
        query: periodQuery(args.period),
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'get_journal_entries_report',
    title: 'Journal entries report',
    description:
      'Individual bookings in the period, narrowed by project, contact or ledger account. At least one of ' +
      '`project_id`, `contact_id` or `ledger_account_id` is required, and `account_type` additionally requires ' +
      '`contact_id` or `project_id`. This is the drill-down behind the revenue and expenses reports: pair ' +
      '`account_type: "revenue"` with a project or contact for revenue detail, and run `"expenses"` and ' +
      '`"direct_costs"` separately for expense detail.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
      project_id: z
        .string()
        .optional()
        .describe('Project id, or the literal "null" for entries without a project.'),
      contact_id: z
        .string()
        .optional()
        .describe('Contact id, or the literal "null" for entries without a contact.'),
      ledger_account_id: z.union([z.string(), z.number()]).optional(),
      account_type: z
        .enum([
          'non_current_assets',
          'current_assets',
          'equity',
          'non_current_liabilities',
          'current_liabilities',
          'revenue',
          'direct_costs',
          'expenses',
          'other_income_expenses',
          'other',
          'temporary',
          'provisions',
        ])
        .optional()
        .describe('Restrict to ledger accounts of this type.'),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      if (!args.project_id && !args.contact_id && args.ledger_account_id === undefined) {
        throw new Error('Provide at least one of project_id, contact_id or ledger_account_id.');
      }
      if (args.account_type && !args.contact_id && !args.project_id) {
        throw new Error('account_type also requires contact_id or project_id.');
      }
      const response = await client.get('reports/journal_entries', {
        administrationId: args.administration_id,
        query: {
          ...listQuery(args),
          ...periodQuery(args.period),
          ...(args.project_id ? { project_id: args.project_id } : {}),
          ...(args.contact_id ? { contact_id: args.contact_id } : {}),
          ...(args.ledger_account_id !== undefined
            ? { ledger_account_id: String(args.ledger_account_id) }
            : {}),
          ...(args.account_type ? { account_type: args.account_type } : {}),
        },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_ledger_account_report',
    title: 'Ledger account report',
    description:
      'Bookings on a single ledger account for the period. Deprecated by Moneybird in favour of ' +
      'get_journal_entries_report with `ledger_account_id`; prefer that tool for new work.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      ledger_account_id: z.string(),
      period: periodMonthField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `reports/ledger_accounts/${encodeURIComponent(args.ledger_account_id)}`,
        {
          administrationId: args.administration_id,
          query: { ...listQuery(args), ...periodQuery(args.period) },
        },
      );
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_revenue_by_contact_report',
    title: 'Revenue by contact report',
    description:
      'Revenue in the period totalled per contact. Use get_journal_entries_report with the contact id for the ' +
      'underlying bookings.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/revenue_by_contact', {
        administrationId: args.administration_id,
        query: { ...listQuery(args), ...periodQuery(args.period) },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_expenses_by_contact_report',
    title: 'Expenses by contact report',
    description:
      'Expenses in the period totalled per contact (supplier). Use get_journal_entries_report with the contact id ' +
      'for the underlying bookings.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/expenses_by_contact', {
        administrationId: args.administration_id,
        query: { ...listQuery(args), ...periodQuery(args.period) },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_revenue_by_project_report',
    title: 'Revenue by project report',
    description: 'Revenue in the period totalled per project.' + RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/revenue_by_project', {
        administrationId: args.administration_id,
        query: { ...listQuery(args), ...periodQuery(args.period) },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_expenses_by_project_report',
    title: 'Expenses by project report',
    description: 'Expenses in the period totalled per project.' + RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/expenses_by_project', {
        administrationId: args.administration_id,
        query: { ...listQuery(args), ...periodQuery(args.period) },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_debtors_report',
    title: 'Debtors report',
    description: 'Outstanding customer balances at the end of the period.' + RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/debtors', {
        administrationId: args.administration_id,
        query: { ...listQuery(args), ...periodQuery(args.period) },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_creditors_report',
    title: 'Creditors report',
    description: 'Outstanding supplier balances at the end of the period.' + RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period: periodMonthField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/creditors', {
        administrationId: args.administration_id,
        query: { ...listQuery(args), ...periodQuery(args.period) },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_debtors_aging_report',
    title: 'Debtors aging report',
    description:
      'Outstanding customer balances bucketed by how long they have been overdue, up to `period_until`.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period_until: periodUntilField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/debtors_aging', {
        administrationId: args.administration_id,
        query: {
          ...listQuery(args),
          ...(args.period_until ? { period_until: args.period_until } : {}),
        },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_creditors_aging_report',
    title: 'Creditors aging report',
    description:
      'Outstanding supplier balances bucketed by how long they have been overdue, up to `period_until`.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      period_until: periodUntilField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('reports/creditors_aging', {
        administrationId: args.administration_id,
        query: {
          ...listQuery(args),
          ...(args.period_until ? { period_until: args.period_until } : {}),
        },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'export_auditfile',
    title: 'Export auditfile',
    description:
      'Queue an XAF auditfile export for a calendar year. Returns nothing: the file is prepared asynchronously and ' +
      'shows up in list_downloads, from where get_download_url hands out the link. Fails when ledger accounts have ' +
      'missing or duplicate account ids, or when the year holds no journal entries.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      year: exportYearField,
      version: z
        .enum(['3.2', '4.0'])
        .optional()
        .describe('XAF version; Moneybird defaults to 3.2.'),
    }),
    handler: async (args, { client }) => {
      await client.post(
        'reports/export/auditfile',
        { year: args.year, ...(args.version ? { version: args.version } : {}) },
        { administrationId: args.administration_id },
      );
      return emptyResult(
        `Auditfile export for ${args.year} queued. Poll list_downloads with download_type "auditfile" until it appears.`,
      );
    },
  }),

  defineTool({
    name: 'export_brugstaat',
    title: 'Export brugstaat',
    description:
      'Queue a brugstaat XML export for a calendar year. Returns nothing: the file is prepared asynchronously and ' +
      'shows up in list_downloads, from where get_download_url hands out the link. Requires every ledger account to ' +
      'carry a valid RGS taxonomy code.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      year: exportYearField,
    }),
    handler: async (args, { client }) => {
      await client.post(
        'reports/export/brugstaat',
        { year: args.year },
        { administrationId: args.administration_id },
      );
      return emptyResult(
        `Brugstaat export for ${args.year} queued. Poll list_downloads with download_type "brugstaat" until it appears.`,
      );
    },
  }),

  defineTool({
    name: 'export_ledger_accounts',
    title: 'Export ledger accounts',
    description:
      'Queue an Excel export of the ledger account cards (grootboekkaarten) with all bookings for a calendar year. ' +
      'Returns nothing: the file is prepared asynchronously and shows up in list_downloads, from where ' +
      'get_download_url hands out the link.' +
      RATE_LIMIT_NOTE,
    toolset: 'reports',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      year: exportYearField,
    }),
    handler: async (args, { client }) => {
      await client.post(
        'reports/export/ledger_accounts',
        { year: args.year },
        { administrationId: args.administration_id },
      );
      return emptyResult(
        `Ledger accounts export for ${args.year} queued. Poll list_downloads with download_type ` +
          '"export_ledger_account_report" until it appears.',
      );
    },
  }),

  defineTool({
    name: 'list_downloads',
    title: 'List downloads',
    description:
      'List the prepared export files of the administration, newest first, with their id, type and status. ' +
      'This is where the files queued by export_auditfile, export_brugstaat and export_ledger_accounts arrive.',
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      download_type: z
        .string()
        .optional()
        .describe(
          'Narrow to one type, e.g. `auditfile`, `brugstaat`, `export_ledger_account_report`, `export_contacts`. ' +
            'The `download_type` field of a listed download shows the exact values in use.',
        ),
      downloaded: z
        .boolean()
        .optional()
        .describe('Only downloads that have (or have not) been fetched before.'),
      failed: z
        .boolean()
        .optional()
        .describe('Only downloads whose preparation failed, or only those that succeeded.'),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('downloads', {
        administrationId: args.administration_id,
        query: {
          ...listQuery(args),
          ...(args.download_type ? { download_type: args.download_type } : {}),
          ...(args.downloaded !== undefined ? { downloaded: args.downloaded } : {}),
          ...(args.failed !== undefined ? { failed: args.failed } : {}),
        },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_download_url',
    title: 'Get download URL',
    description:
      'Return the temporary URL of a prepared export file. Takes the download id from list_downloads; the URL is ' +
      'valid for 30 seconds, so fetch it right away.',
    toolset: 'reports',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      download_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `downloads/${encodeURIComponent(args.download_id)}/download`,
        undefined,
        { administrationId: args.administration_id, manualRedirect: true },
      );
      return textResult({ download_url: response.redirectUrl, valid_for_seconds: 30 });
    },
  }),

  defineTool({
    name: 'create_financial_statement',
    title: 'Create financial statement',
    description:
      'Create a bank statement on a financial account and group transactions into it. Each transaction becomes a ' +
      'financial mutation that can then be reconciled against documents.',
    toolset: 'reports',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      financial_account_id: z
        .union([z.string(), z.number()])
        .describe(
          'Bank account the statement belongs to; call list_financial_accounts for the ids.',
        ),
      reference: z
        .string()
        .describe('Unique reference, e.g. the bank statement number. Required by Moneybird.'),
      official_date: z
        .string()
        .optional()
        .describe('Date of the official bank balance, YYYY-MM-DD.'),
      official_balance: z
        .string()
        .optional()
        .describe('Official bank balance as a decimal string.'),
      financial_mutations_attributes: financialMutationsField,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'financial_statements',
        {
          financial_statement: {
            financial_account_id: args.financial_account_id,
            ...(args.reference ? { reference: args.reference } : {}),
            ...(args.official_date ? { official_date: args.official_date } : {}),
            ...(args.official_balance ? { official_balance: args.official_balance } : {}),
            ...(args.financial_mutations_attributes
              ? { financial_mutations_attributes: args.financial_mutations_attributes }
              : {}),
          },
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_financial_statement',
    title: 'Update financial statement',
    description:
      'Update a bank statement. Only the attributes you supply change. Mutations carrying an `id` are updated, ' +
      'those without one are added, and `_destroy: true` removes one from the statement.',
    toolset: 'reports',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      financial_statement_id: z.string(),
      reference: z.string().optional(),
      official_date: z
        .string()
        .optional()
        .describe('Date of the official bank balance, YYYY-MM-DD.'),
      official_balance: z
        .string()
        .optional()
        .describe('Official bank balance as a decimal string.'),
      financial_mutations_attributes: financialMutationsField,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `financial_statements/${encodeURIComponent(args.financial_statement_id)}`,
        {
          financial_statement: {
            ...(args.reference ? { reference: args.reference } : {}),
            ...(args.official_date ? { official_date: args.official_date } : {}),
            ...(args.official_balance ? { official_balance: args.official_balance } : {}),
            ...(args.financial_mutations_attributes
              ? { financial_mutations_attributes: args.financial_mutations_attributes }
              : {}),
          },
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_financial_statement',
    title: 'Delete financial statement',
    description:
      'Delete a bank statement together with the financial mutations it groups, removing those transactions from ' +
      'the administration.',
    toolset: 'reports',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      financial_statement_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `financial_statements/${encodeURIComponent(args.financial_statement_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`Financial statement ${args.financial_statement_id} deleted.`);
    },
  }),
] as const;

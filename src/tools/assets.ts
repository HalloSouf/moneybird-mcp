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

const VALUE_CHANGE_DATE =
  'Date of the value change, YYYY-MM-DD. Must be after the purchase date, and may be neither in the future nor ' +
  'inside the locked period of the administration.';

const assetIdField = z.string().describe('Moneybird asset id.');

const valueChangePlanAttributes = z
  .object({
    lifespan_in_years: z.union([z.string(), z.number()]).describe('Depreciation period in years.'),
    residual_value: z
      .string()
      .optional()
      .describe('Value left at the end of the lifespan, decimal string. Defaults to "0".'),
  })
  .loose();

const assetAttributes = z
  .object({
    name: z.string().optional(),
    ledger_account_id: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Fixed asset ledger account to book on; call list_ledger_accounts for the ids.'),
    purchase_date: z.string().optional().describe('YYYY-MM-DD.'),
    purchase_value: z.string().optional().describe('Decimal string, e.g. "12500.00".'),
    value_change_plan_attributes: valueChangePlanAttributes.optional(),
  })
  .loose();

export const assetsTools: readonly ToolDefinition[] = [
  defineTool({
    name: 'list_assets',
    title: 'List assets',
    description:
      'List the fixed assets of the administration with their purchase value, depreciation plan and current book value. ' +
      'Only active assets are returned unless `active` is set to false.',
    toolset: 'assets',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      ledger_account_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Only assets booked on this ledger account.'),
      active: z
        .boolean()
        .optional()
        .describe('Defaults to true. Set to false to include disposed and future assets as well.'),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('assets', {
        administrationId: args.administration_id,
        query: {
          ...listQuery(args),
          ...(args.ledger_account_id !== undefined
            ? { ledger_account_id: String(args.ledger_account_id) }
            : {}),
          ...(args.active !== undefined ? { active: args.active } : {}),
        },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_asset',
    title: 'Get asset',
    description:
      'Retrieve one fixed asset with its value changes, sources and disposal. Also the way to check the result of ' +
      'create_asset_retroactive_value_changes, which runs asynchronously.',
    toolset: 'assets',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
    }),
    handler: async (args, { client }) => {
      const response = await client.get(`assets/${encodeURIComponent(args.asset_id)}`, {
        administrationId: args.administration_id,
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_asset',
    title: 'Create asset',
    description:
      'Create a fixed asset. `name`, `ledger_account_id`, `purchase_date` and `purchase_value` are required. ' +
      'Supply `value_change_plan_attributes` for the depreciation plan; assets on a land or building ledger account ' +
      'never depreciate and must leave it out, every other ledger account requires it.',
    toolset: 'assets',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset: assetAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'assets',
        { asset: args.asset },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_asset',
    title: 'Update asset',
    description:
      'Update a fixed asset. Once the asset is active — its purchase date has passed — Moneybird accepts a change ' +
      'to `name` only.',
    toolset: 'assets',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
      asset: assetAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `assets/${encodeURIComponent(args.asset_id)}`,
        { asset: args.asset },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_asset',
    title: 'Delete asset',
    description:
      'Delete a fixed asset together with its depreciation history. Moneybird refuses this once bookings depend on it.',
    toolset: 'assets',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
    }),
    handler: async (args, { client }) => {
      await client.delete(`assets/${encodeURIComponent(args.asset_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Asset ${args.asset_id} deleted.`);
    },
  }),

  defineTool({
    name: 'create_asset_manual_value_change',
    title: 'Create manual value change',
    description:
      'Book a one-off depreciation or revaluation on an asset at a given date. A negative amount lowers the value, ' +
      'a positive amount raises it; an amount above the value at that date is rejected. This writes to the ' +
      'depreciation history and the booking cannot be undone through the API.',
    toolset: 'assets',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
      date: z.string().describe(VALUE_CHANGE_DATE),
      amount: z
        .string()
        .describe('Decimal string; negative decreases the asset value, positive increases it.'),
      description: z.string(),
      externally_booked: z
        .boolean()
        .optional()
        .describe(
          'True when the change is already booked elsewhere and Moneybird should not book it. Defaults to false.',
        ),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `assets/${encodeURIComponent(args.asset_id)}/value_changes/manual`,
        {
          date: args.date,
          amount: args.amount,
          description: args.description,
          ...(args.externally_booked !== undefined
            ? { externally_booked: args.externally_booked }
            : {}),
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_asset_arbitrary_value_change',
    title: 'Create arbitrary value change',
    description:
      'Book a value change that breaks the depreciation schedule, for example an impairment. Every linear value ' +
      'change after this date is removed; call create_asset_retroactive_value_changes afterwards to rebuild the ' +
      'schedule. Irreversible through the API.',
    toolset: 'assets',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
      date: z.string().describe(VALUE_CHANGE_DATE),
      amount: z
        .string()
        .describe('Decimal string; negative decreases the asset value, positive increases it.'),
      description: z.string(),
      externally_booked: z
        .boolean()
        .optional()
        .describe(
          'True when the change is already booked elsewhere and Moneybird should not book it. Defaults to false.',
        ),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `assets/${encodeURIComponent(args.asset_id)}/value_changes/arbitrary`,
        {
          date: args.date,
          amount: args.amount,
          description: args.description,
          ...(args.externally_booked !== undefined
            ? { externally_booked: args.externally_booked }
            : {}),
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_asset_divestment',
    title: 'Create divestment value change',
    description:
      'Divest an asset at a date: its remaining value leaves the balance sheet and the profit is booked as book ' +
      'result. Moneybird sets the amount itself, creates a disposal and drops every linear value change after the ' +
      'date. Irreversible through the API.',
    toolset: 'assets',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
      date: z.string().describe(VALUE_CHANGE_DATE),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `assets/${encodeURIComponent(args.asset_id)}/value_changes/divestment`,
        { date: args.date },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_asset_full_depreciation',
    title: 'Create full depreciation value change',
    description:
      'Write an asset off completely at a date: its remaining value leaves the balance sheet without a book result. ' +
      'Moneybird sets the amount itself, creates a disposal and drops every linear value change after the date. ' +
      'Irreversible through the API.',
    toolset: 'assets',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
      date: z.string().describe(VALUE_CHANGE_DATE),
      description: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `assets/${encodeURIComponent(args.asset_id)}/value_changes/full_depreciation`,
        { date: args.date, description: args.description },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_asset_retroactive_value_changes',
    title: 'Create retroactive linear value changes',
    description:
      'Fill in the linear depreciation entries an asset is still missing, from its purchase date or last arbitrary ' +
      'value change up to the last month of the administration. Needs an asset with a depreciation plan, remaining ' +
      'value and gaps outside the locked period. Runs asynchronously and returns nothing — poll get_asset for the result.',
    toolset: 'assets',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
    }),
    handler: async (args, { client }) => {
      await client.post(
        `assets/${encodeURIComponent(args.asset_id)}/value_changes/retroactive_linear_value_changes`,
        undefined,
        { administrationId: args.administration_id },
      );
      return emptyResult(
        `Retroactive linear value changes queued for asset ${args.asset_id}. Call get_asset to check the result.`,
      );
    },
  }),

  defineTool({
    name: 'create_asset_disposal',
    title: 'Create asset disposal',
    description:
      'Record that an asset left the administration on a date, with a reason. Requires the asset to be fully ' +
      'depreciated — its value at the disposal date must be zero — and to have no disposal yet. Irreversible ' +
      'through the API.',
    toolset: 'assets',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
      date: z
        .string()
        .describe(
          'Disposal date, YYYY-MM-DD. Must be after the purchase date, and neither in the future nor inside the ' +
            'locked period of the administration.',
        ),
      reason: z.enum(['out_of_use', 'sold', 'private_withdrawal', 'divested']),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `assets/${encodeURIComponent(args.asset_id)}/disposals`,
        { date: args.date, reason: args.reason },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'add_asset_source',
    title: 'Add source to asset',
    description:
      'Link the booking an asset was purchased with to that asset. Provide exactly one of `detail_id` (a line of a ' +
      'purchase invoice or receipt) or `general_journal_document_entry_id` — never both. The booking must sit on the ' +
      'same ledger account as the asset.',
    toolset: 'assets',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
      detail_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'Id of a document detail line. Mutually exclusive with general_journal_document_entry_id.',
        ),
      general_journal_document_entry_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Id of a general journal document entry. Mutually exclusive with detail_id.'),
    }),
    handler: async (args, { client }) => {
      const hasDetail = args.detail_id !== undefined;
      const hasEntry = args.general_journal_document_entry_id !== undefined;
      if (hasDetail === hasEntry) {
        throw new Error('Provide exactly one of detail_id or general_journal_document_entry_id.');
      }
      const response = await client.post(
        `assets/${encodeURIComponent(args.asset_id)}/sources`,
        hasDetail
          ? { detail_id: args.detail_id }
          : { general_journal_document_entry_id: args.general_journal_document_entry_id },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_asset_source',
    title: 'Delete asset source',
    description:
      'Unlink a source booking from an asset. The booking and the asset themselves stay; only the link is removed.',
    toolset: 'assets',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
      source_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `assets/${encodeURIComponent(args.asset_id)}/sources/${encodeURIComponent(args.source_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`Source ${args.source_id} removed from asset ${args.asset_id}.`);
    },
  }),

  defineTool({
    name: 'create_asset_reinvestment_reserve_purchase',
    title: 'Fund asset from reinvestment reserve',
    description:
      "Record that part of the asset's purchase value is funded from the reinvestment reserve " +
      '(herinvesteringsreserve). The amount may not exceed the depreciatable value (purchase value minus residual ' +
      'value), and the purchase date may not lie in the locked period.',
    toolset: 'assets',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
      amount: z.string().describe('Amount taken from the reinvestment reserve, decimal string.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `assets/${encodeURIComponent(args.asset_id)}/reinvestment_reserve_purchase`,
        { amount: args.amount },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_asset_reinvestment_reserve_purchase',
    title: 'Delete reinvestment reserve purchase',
    description: 'Remove the reinvestment reserve funding from an asset.',
    toolset: 'assets',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `assets/${encodeURIComponent(args.asset_id)}/reinvestment_reserve_purchase`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`Reinvestment reserve purchase removed from asset ${args.asset_id}.`);
    },
  }),

  defineTool({
    name: 'create_asset_reinvestment_reserve_sale',
    title: 'Book disposal result to reinvestment reserve',
    description:
      "Book the book result of an asset's disposal to the reinvestment reserve (herinvesteringsreserve). Requires " +
      'the asset to already have a disposal whose date lies outside the locked period.',
    toolset: 'assets',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
      amount: z.string().describe('Part of the book result booked to the reserve, decimal string.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `assets/${encodeURIComponent(args.asset_id)}/reinvestment_reserve_sale`,
        { amount: args.amount },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_asset_reinvestment_reserve_sale',
    title: 'Delete reinvestment reserve sale',
    description: "Remove the reinvestment reserve booking from an asset's disposal.",
    toolset: 'assets',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      asset_id: assetIdField,
    }),
    handler: async (args, { client }) => {
      await client.delete(`assets/${encodeURIComponent(args.asset_id)}/reinvestment_reserve_sale`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Reinvestment reserve sale removed from asset ${args.asset_id}.`);
    },
  }),
] as const;

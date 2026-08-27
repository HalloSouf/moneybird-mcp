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

const TIME_ENTRY_FILTER_KEYS =
  'period (named period such as this_week/prev_month/this_year, or a range like 20260101..20260131), ' +
  'state (all|open|non_billable), contact_id, project_id, user_id, day (YYYY-MM-DD), ' +
  'include_nil_contacts (true|false), include_active (true|false)';

const TIMESTAMP_NOTE =
  'ISO 8601 timestamp, e.g. `2026-08-27T09:00:00.000Z`. A value without an offset is read in the ' +
  'administration time zone the server sends as the `Time-Zone` header. Moneybird rounds down to whole minutes.';

export const timeTools: readonly ToolDefinition[] = [
  defineTool({
    name: 'list_time_entries',
    title: 'List time entries',
    description:
      'List tracked time. Without a filter Moneybird returns the current financial year, so pass an explicit ' +
      '`period` to look further back, and `include_active:true` to see timers that are still running.',
    toolset: 'time',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      query: z.string().optional().describe('Free-text search over the time entry description.'),
      filter: filterField('period:this_month,state:open,project_id:123').describe(
        `Comma-separated \`key:value\` filter. Keys: ${TIME_ENTRY_FILTER_KEYS}. ` +
          "A filter replaces Moneybird's `period:this_year` default entirely. " +
          '`state` accepts pipe-separated values, e.g. `state:open|non_billable`.',
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('time_entries', {
        administrationId: args.administration_id,
        query: {
          ...listQuery(args),
          ...(args.query ? { query: args.query } : {}),
        },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_time_entry',
    title: 'Get time entry',
    description:
      'Retrieve a single time entry by id, with its contact, project, user and billable state.',
    toolset: 'time',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      time_entry_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `time_entries/${encodeURIComponent(String(args.time_entry_id))}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_time_entry',
    title: 'Create time entry',
    description:
      'Log time for a user. `user_id`, `started_at` and `description` are required; call list_users for the id. ' +
      'Omitting `ended_at` starts a running timer.',
    toolset: 'time',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      user_id: z
        .union([z.string(), z.number()])
        .describe('User the time is booked on; see list_users.'),
      started_at: z.string().describe(TIMESTAMP_NOTE),
      description: z.string().describe('How the time was spent. May appear on the invoice.'),
      ended_at: z
        .string()
        .optional()
        .describe(`${TIMESTAMP_NOTE} Omit to leave the timer running.`),
      contact_id: z.union([z.string(), z.number()]).optional(),
      project_id: z.union([z.string(), z.number()]).optional(),
      sales_invoice_id: z.union([z.string(), z.number()]).optional(),
      billable: z.boolean().optional().describe('Defaults to true.'),
      paused_duration: z
        .number()
        .int()
        .optional()
        .describe('Paused time in seconds, rounded down to whole minutes.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'time_entries',
        {
          time_entry: {
            user_id: args.user_id,
            started_at: args.started_at,
            description: args.description,
            ...(args.ended_at !== undefined ? { ended_at: args.ended_at } : {}),
            ...(args.contact_id !== undefined ? { contact_id: args.contact_id } : {}),
            ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
            ...(args.sales_invoice_id !== undefined
              ? { sales_invoice_id: args.sales_invoice_id }
              : {}),
            ...(args.billable !== undefined ? { billable: args.billable } : {}),
            ...(args.paused_duration !== undefined
              ? { paused_duration: args.paused_duration }
              : {}),
          },
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_time_entry',
    title: 'Update time entry',
    description:
      'Update a time entry. Only the attributes you supply are changed. `user_id` cannot be changed after creation.',
    toolset: 'time',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      time_entry_id: z.union([z.string(), z.number()]),
      started_at: z.string().optional().describe(TIMESTAMP_NOTE),
      ended_at: z.string().optional().describe(TIMESTAMP_NOTE),
      description: z.string().optional(),
      contact_id: z.union([z.string(), z.number()]).optional(),
      project_id: z.union([z.string(), z.number()]).optional(),
      sales_invoice_id: z.union([z.string(), z.number()]).optional(),
      billable: z.boolean().optional(),
      paused_duration: z
        .number()
        .int()
        .optional()
        .describe('Paused time in seconds, rounded down to whole minutes.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `time_entries/${encodeURIComponent(String(args.time_entry_id))}`,
        {
          time_entry: {
            ...(args.started_at !== undefined ? { started_at: args.started_at } : {}),
            ...(args.ended_at !== undefined ? { ended_at: args.ended_at } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.contact_id !== undefined ? { contact_id: args.contact_id } : {}),
            ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
            ...(args.sales_invoice_id !== undefined
              ? { sales_invoice_id: args.sales_invoice_id }
              : {}),
            ...(args.billable !== undefined ? { billable: args.billable } : {}),
            ...(args.paused_duration !== undefined
              ? { paused_duration: args.paused_duration }
              : {}),
          },
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'stop_time_entry',
    title: 'Stop time entry',
    description: 'Stop a running timer, setting `ended_at` to now.',
    toolset: 'time',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      time_entry_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `time_entries/${encodeURIComponent(String(args.time_entry_id))}/stop`,
        undefined,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'resume_time_entry',
    title: 'Resume time entry',
    description: 'Restart a stopped time entry, clearing `ended_at` so the timer runs again.',
    toolset: 'time',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      time_entry_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `time_entries/${encodeURIComponent(String(args.time_entry_id))}/resume`,
        undefined,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_time_entry',
    title: 'Delete time entry',
    description: 'Permanently delete a time entry.',
    toolset: 'time',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      time_entry_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      await client.delete(`time_entries/${encodeURIComponent(String(args.time_entry_id))}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Time entry ${args.time_entry_id} deleted.`);
    },
  }),

  defineTool({
    name: 'add_time_entry_note',
    title: 'Add note to time entry',
    description: 'Attach a note to a time entry, optionally flagged as a to-do with an assignee.',
    toolset: 'time',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      time_entry_id: z.union([z.string(), z.number()]),
      note: z.string(),
      todo: z.boolean().optional().describe('Mark the note as a to-do.'),
      assignee_id: z.union([z.string(), z.number()]).optional(),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `time_entries/${encodeURIComponent(String(args.time_entry_id))}/notes`,
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
    name: 'delete_time_entry_note',
    title: 'Delete note from time entry',
    description: 'Remove a note from a time entry.',
    toolset: 'time',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      time_entry_id: z.union([z.string(), z.number()]),
      note_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `time_entries/${encodeURIComponent(String(args.time_entry_id))}/notes/${encodeURIComponent(String(args.note_id))}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`Note ${args.note_id} deleted.`);
    },
  }),

  defineTool({
    name: 'list_projects',
    title: 'List projects',
    description:
      'List projects. Moneybird returns only active projects unless the filter says otherwise. Time entries ' +
      'reference these by `project_id`.',
    toolset: 'time',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('state:all').describe(
        'Comma-separated `key:value` filter. The only key is `state` (all|active|archived); ' +
          'Moneybird defaults to `state:active`.',
      ),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('projects', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_project',
    title: 'Get project',
    description: 'Retrieve a single project by id, with its name, state and budget.',
    toolset: 'time',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      project_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(`projects/${encodeURIComponent(String(args.project_id))}`, {
        administrationId: args.administration_id,
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_project',
    title: 'Create project',
    description:
      'Create a project to book time and costs against. The name must be unique in the administration.',
    toolset: 'time',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      name: z.string(),
      budget: z.string().optional().describe('Project budget as a decimal string, e.g. "40.0".'),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'projects',
        {
          project: {
            name: args.name,
            ...(args.budget !== undefined ? { budget: args.budget } : {}),
          },
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_project',
    title: 'Update project',
    description:
      'Rename a project or change its budget. Moneybird requires `name` on every update.',
    toolset: 'time',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      project_id: z.union([z.string(), z.number()]),
      name: z.string(),
      budget: z.string().optional().describe('Project budget as a decimal string, e.g. "40.0".'),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `projects/${encodeURIComponent(String(args.project_id))}`,
        {
          project: {
            name: args.name,
            ...(args.budget !== undefined ? { budget: args.budget } : {}),
          },
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_project',
    title: 'Delete project',
    description:
      'Delete a project. Moneybird refuses this while time entries are still booked on it.',
    toolset: 'time',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      project_id: z.union([z.string(), z.number()]),
    }),
    handler: async (args, { client }) => {
      await client.delete(`projects/${encodeURIComponent(String(args.project_id))}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Project ${args.project_id} deleted.`);
    },
  }),
] as const;

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

const reportType = z
  .enum(['balance_sheet', 'profit_loss', 'debtor', 'creditor', 'assets'])
  .describe('Report the tasks are generated from. Changing it regenerates them.');

/** PATCH accepts only these three; the period bounds are settable at creation time only. */
const taskListAttributes = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    deadline_on: z.string().optional().describe('Date, YYYY-MM-DD.'),
  })
  .loose();

const newTaskListAttributes = taskListAttributes.extend({
  period_begin: z.string().optional().describe('Start of the period the list covers, YYYY-MM-DD.'),
  period_end: z.string().optional().describe('End of the period the list covers, YYYY-MM-DD.'),
});

const groupAttributes = z
  .object({
    name: z.string().optional(),
    report_type: reportType.optional(),
  })
  .loose();

const taskAttributes = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    report_type: reportType.optional(),
    assignee_id: z
      .union([z.string(), z.number()])
      .optional()
      .describe('User id to assign the task to.'),
    related_entity_id: z
      .union([z.string(), z.number()])
      .nullable()
      .optional()
      .describe('Ledger account id to link to the task.'),
    generate_subtasks: z
      .boolean()
      .optional()
      .describe('Generate a subtask per child of the related ledger account.'),
  })
  .loose();

const taskListTemplateAttributes = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    period: z
      .string()
      .optional()
      .describe('ISO 8601 duration (P1M, P3M, P1Y) or `monthly`, `quarterly`, `yearly`, `none`.'),
    deadline_after: z
      .string()
      .optional()
      .describe('ISO 8601 duration offsetting the deadline from the period end, e.g. `P14D`.'),
  })
  .loose();

export const tasksTools: readonly ToolDefinition[] = [
  defineTool({
    name: 'list_task_lists',
    title: 'List task lists',
    description:
      'List the task lists of an administration. Moneybird returns 30 per page; the response does not ' +
      'include the tasks themselves, so call get_task_list for the contents of one.',
    toolset: 'tasks',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('task_lists', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_task_list',
    title: 'Get task list',
    description: 'Retrieve one task list with its groups, tasks and subtasks.',
    toolset: 'tasks',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_list_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(`task_lists/${encodeURIComponent(args.task_list_id)}`, {
        administrationId: args.administration_id,
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_task_list',
    title: 'Create task list',
    description:
      'Create a task list. `name` is required. Pass `template_id` to build it from a task list template, ' +
      'which is the same as calling create_task_list_from_template.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_list: newTaskListAttributes.extend({
        name: z.string(),
        template_id: z.union([z.string(), z.number()]).optional(),
      }),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'task_lists',
        { task_list: args.task_list },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_task_list',
    title: 'Update task list',
    description: 'Update the name, description or deadline of a task list.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_list_id: z.string(),
      task_list: taskListAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `task_lists/${encodeURIComponent(args.task_list_id)}`,
        { task_list: args.task_list },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_task_list',
    title: 'Delete task list',
    description: 'Permanently delete a task list together with all its groups and tasks.',
    toolset: 'tasks',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_list_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`task_lists/${encodeURIComponent(args.task_list_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Task list ${args.task_list_id} deleted.`);
    },
  }),

  defineTool({
    name: 'create_task_list_group',
    title: 'Create task list group',
    description:
      'Add a group to a task list. Groups hold the tasks; give a `report_type` to have Moneybird ' +
      "generate the group's tasks from that report instead of adding them by hand.",
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_list_id: z.string(),
      group: groupAttributes.extend({ name: z.string() }),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `task_lists/${encodeURIComponent(args.task_list_id)}/groups`,
        { group: args.group },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'get_task_list_group',
    title: 'Get task list group',
    description: 'Retrieve one task list group with its tasks.',
    toolset: 'tasks',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      group_id: z.string().describe('Task list group id.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(`task_list_groups/${encodeURIComponent(args.group_id)}`, {
        administrationId: args.administration_id,
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_task_list_group',
    title: 'Update task list group',
    description:
      'Rename a task list group or change its report type. Changing `report_type` destroys the existing ' +
      'tasks in the group and regenerates them from the new report.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      group_id: z.string(),
      group: groupAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `task_list_groups/${encodeURIComponent(args.group_id)}`,
        { group: args.group },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_task_list_group',
    title: 'Delete task list group',
    description: 'Permanently delete a task list group and every task in it.',
    toolset: 'tasks',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      group_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`task_list_groups/${encodeURIComponent(args.group_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Task list group ${args.group_id} deleted.`);
    },
  }),

  defineTool({
    name: 'create_task',
    title: 'Create task',
    description:
      'Add a task to a task list group. Needs the group id, not the task list id — get_task_list lists ' +
      'the groups with their ids.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      group_id: z.string().describe('Task list group id to add the task to.'),
      task: taskAttributes.extend({ name: z.string() }),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `task_list_groups/${encodeURIComponent(args.group_id)}/tasks`,
        { task: args.task },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'get_task',
    title: 'Get task',
    description: 'Retrieve one task with its subtasks, notes and events.',
    toolset: 'tasks',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(`task_list_tasks/${encodeURIComponent(args.task_id)}`, {
        administrationId: args.administration_id,
      });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_task',
    title: 'Update task',
    description: 'Update a task. Only the attributes you supply are changed.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_id: z.string(),
      task: taskAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `task_list_tasks/${encodeURIComponent(args.task_id)}`,
        { task: args.task },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_task',
    title: 'Delete task',
    description:
      'Permanently delete a task and its subtasks. Moneybird refuses this for generated tasks — ' +
      'delete or re-type their group instead.',
    toolset: 'tasks',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`task_list_tasks/${encodeURIComponent(args.task_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Task ${args.task_id} deleted.`);
    },
  }),

  defineTool({
    name: 'assign_task',
    title: 'Assign task',
    description:
      'Assign a user to a task, or clear the assignment by omitting `assignee_id`. The user must already ' +
      'have access to the task; Moneybird answers 404 when they do not. list_users gives the user ids.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_id: z.string(),
      assignee_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe('User id to assign. Omit to unassign the task.'),
    }),
    handler: async (args, { client }) => {
      const path = `task_list_tasks/${encodeURIComponent(args.task_id)}/assignment`;
      if (args.assignee_id === undefined) {
        await client.delete(path, { administrationId: args.administration_id });
        return emptyResult(`Task ${args.task_id} unassigned.`);
      }
      const response = await client.post(
        path,
        { assignee_id: args.assignee_id },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'complete_task',
    title: 'Complete task',
    description: 'Mark a task and all of its subtasks as completed.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `task_list_tasks/${encodeURIComponent(args.task_id)}/completion`,
        undefined,
        { administrationId: args.administration_id },
      );
      return textResult(response.data ?? `Task ${args.task_id} completed.`);
    },
  }),

  defineTool({
    name: 'reopen_task',
    title: 'Reopen task',
    description:
      'Reopen a completed task, along with any parent tasks that were completed with it.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.delete(
        `task_list_tasks/${encodeURIComponent(args.task_id)}/completion`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data ?? `Task ${args.task_id} reopened.`);
    },
  }),

  defineTool({
    name: 'add_task_note',
    title: 'Add note to task',
    description: 'Attach a note to a task, optionally flagged as a to-do.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_id: z.string(),
      note: z.string(),
      todo: z.boolean().optional().describe('Mark the note as a to-do item.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `task_list_tasks/${encodeURIComponent(args.task_id)}/notes`,
        { note: { note: args.note, ...(args.todo !== undefined ? { todo: args.todo } : {}) } },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'list_task_list_templates',
    title: 'List task list templates',
    description:
      'List the task list templates of an administration. Templates are the blueprints that ' +
      'create_task_list_from_template instantiates.',
    toolset: 'tasks',
    access: 'read',
    inputSchema: z.object({ administration_id: administrationIdField }),
    handler: async (args, { client }) => {
      const response = await client.get('task_list_templates', {
        administrationId: args.administration_id,
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_task_list_template',
    title: 'Get task list template',
    description: 'Retrieve one task list template with its groups and tasks.',
    toolset: 'tasks',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      template_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `task_list_templates/${encodeURIComponent(args.template_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_task_list_template',
    title: 'Create task list template',
    description:
      'Create a task list template. `name` is required; `period` and `deadline_after` control the ' +
      'recurrence and deadline of the lists made from it.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      task_list_template: taskListTemplateAttributes.extend({ name: z.string() }),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'task_list_templates',
        { task_list_template: args.task_list_template },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_task_list_template',
    title: 'Update task list template',
    description:
      'Update a task list template. Existing task lists already created from it are not changed.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      template_id: z.string(),
      task_list_template: taskListTemplateAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `task_list_templates/${encodeURIComponent(args.template_id)}`,
        { task_list_template: args.task_list_template },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_task_list_template',
    title: 'Delete task list template',
    description: 'Permanently delete a task list template and all its groups and tasks.',
    toolset: 'tasks',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      template_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`task_list_templates/${encodeURIComponent(args.template_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Task list template ${args.template_id} deleted.`);
    },
  }),

  defineTool({
    name: 'create_task_list_template_group',
    title: 'Create task list template group',
    description:
      'Add a group to a task list template, so lists made from it start with that group.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      template_id: z.string(),
      group: groupAttributes.extend({ name: z.string() }),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `task_list_templates/${encodeURIComponent(args.template_id)}/groups`,
        { group: args.group },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_task_list_from_template',
    title: 'Create task list from template',
    description:
      'Instantiate a task list template into a new task list, copying its groups and tasks. Every ' +
      'attribute is optional and falls back to the template.',
    toolset: 'tasks',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      template_id: z.string(),
      task_list: newTaskListAttributes.optional(),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `task_list_templates/${encodeURIComponent(args.template_id)}/task_lists`,
        args.task_list ? { task_list: args.task_list } : undefined,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'list_workflows',
    title: 'List workflows',
    description:
      'List the invoice and estimate workflows of the administration, with their reminder steps. ' +
      'Contacts and documents reference these by `invoice_workflow_id` and `estimate_workflow_id`.',
    toolset: 'tasks',
    access: 'read',
    inputSchema: z.object({ administration_id: administrationIdField }),
    handler: async (args, { client }) => {
      const response = await client.get('workflows', {
        administrationId: args.administration_id,
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_workflow',
    title: 'Get workflow',
    description:
      'Retrieve one workflow, including its currency, language, payment methods and reminder steps.',
    toolset: 'tasks',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      workflow_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(`workflows/${encodeURIComponent(args.workflow_id)}`, {
        administrationId: args.administration_id,
      });
      return textResult(response.data);
    },
  }),
] as const;

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

const CONTACT_FILTER_KEYS =
  'created_after, updated_after, first_name, last_name, contact_type (all|company|private_individual), ' +
  'delivery_method (all|email|post|manual|peppol|simplerinvoicing), trusted_type (all|trusted|not_trusted), ' +
  'estimate_workflow_id, invoice_workflow_id';

/**
 * Contact attributes accepted on create and update.
 *
 * Passthrough is deliberate: Moneybird's contact body carries 36 documented fields plus
 * administration-specific custom fields, and rejecting unknown keys here would block valid
 * requests the API itself accepts.
 */
const contactAttributes = z
  .object({
    company_name: z.string().optional(),
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    address1: z.string().optional(),
    address2: z.string().optional(),
    zipcode: z.string().optional(),
    city: z.string().optional(),
    country: z.string().length(2).optional().describe('ISO 3166-1 alpha-2 country code.'),
    phone: z.string().optional(),
    email: z.string().optional().describe('Comma-separated for multiple recipients.'),
    tax_number: z.string().optional(),
    chamber_of_commerce: z.string().optional(),
    bank_account: z.string().optional(),
    customer_id: z.string().optional().describe('Your own reference for this contact.'),
    send_invoices_to_email: z.string().optional(),
    send_invoices_to_attention: z.string().optional(),
    send_estimates_to_email: z.string().optional(),
    send_estimates_to_attention: z.string().optional(),
    sepa_active: z.boolean().optional(),
    sepa_iban: z.string().optional(),
    sepa_iban_account_name: z.string().optional(),
    sepa_mandate_id: z.string().optional(),
    sepa_mandate_date: z.string().optional(),
    invoice_workflow_id: z.union([z.string(), z.number()]).optional(),
    estimate_workflow_id: z.union([z.string(), z.number()]).optional(),
    delivery_method: z.enum(['Email', 'Simplerinvoicing', 'Post', 'Manual', 'Peppol']).optional(),
    custom_fields_attributes: z
      .record(z.string(), z.object({ id: z.union([z.string(), z.number()]), value: z.string() }))
      .optional()
      .describe('Keyed by index, e.g. `{"0": {"id": "123", "value": "abc"}}`.'),
  })
  .loose();

const contactPersonAttributes = z
  .object({
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    department: z.string().optional(),
  })
  .loose();

const productAttributes = z
  .object({
    description: z.string().optional(),
    title: z.string().optional(),
    price: z.string().optional().describe('Decimal string, e.g. "150.0".'),
    currency: z.string().length(3).optional().describe('ISO 4217 currency code.'),
    frequency: z.union([z.string(), z.number()]).optional(),
    frequency_type: z.string().optional(),
    tax_rate_id: z.union([z.string(), z.number()]).optional(),
    ledger_account_id: z.union([z.string(), z.number()]).optional(),
    identifier: z.string().optional(),
    sku: z.string().optional(),
  })
  .loose();

const ledgerAccountAttributes = z
  .object({
    name: z.string().optional(),
    account_id: z.string().optional(),
    account_type: z.string().optional(),
    parent_id: z.union([z.string(), z.number()]).optional(),
    allowed_document_types: z.array(z.string()).optional(),
  })
  .loose();

const identityAttributes = z
  .object({
    company_name: z.string().optional(),
    address1: z.string().optional(),
    address2: z.string().optional(),
    zipcode: z.string().optional(),
    city: z.string().optional(),
    country: z.string().length(2).optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    tax_number: z.string().optional(),
    chamber_of_commerce: z.string().optional(),
    bank_account_name: z.string().optional(),
    bank_account_iban: z.string().optional(),
    bank_account_bic: z.string().optional(),
  })
  .loose();

export const coreTools: readonly ToolDefinition[] = [
  defineTool({
    name: 'list_administrations',
    title: 'List administrations',
    description:
      'List every Moneybird administration this token can access, with id, name, language, currency and country. ' +
      'Use this first to discover the administration id other tools need.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({}),
    handler: async (_args, { client }) => {
      const response = await client.get('administrations', { administrationScoped: false });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'list_contacts',
    title: 'List contacts',
    description:
      'List or search contacts (customers and suppliers). Supply `query` for free-text search across name, ' +
      'email, phone, customer id, tax number and address, or `filter` for structured narrowing.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      query: z.string().optional().describe('Free-text search term.'),
      filter: filterField('contact_type:company,updated_after:2026-01-01T00:00:00Z').describe(
        `Comma-separated \`key:value\` filter. Keys: ${CONTACT_FILTER_KEYS}. ` +
          "A filter replaces Moneybird's defaults entirely.",
      ),
      include_archived: z.boolean().optional(),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      // `/contacts/filter` is a superset of `/contacts`, but only it accepts `filter`.
      const path = args.filter ? 'contacts/filter' : 'contacts';
      const response = await client.get(path, {
        administrationId: args.administration_id,
        query: {
          ...listQuery(args),
          ...(args.query ? { query: args.query } : {}),
          ...(args.include_archived !== undefined
            ? { include_archived: args.include_archived }
            : {}),
        },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_contact',
    title: 'Get contact',
    description:
      'Retrieve a single contact by its Moneybird id, or by your own `customer_id` reference.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string().optional().describe('Moneybird contact id.'),
      customer_id: z.string().optional().describe('Your own customer reference.'),
    }),
    handler: async (args, { client }) => {
      if (!args.contact_id && !args.customer_id) {
        throw new Error('Provide either contact_id or customer_id.');
      }
      const path = args.contact_id
        ? `contacts/${encodeURIComponent(args.contact_id)}`
        : `contacts/customer_id/${encodeURIComponent(args.customer_id as string)}`;
      const response = await client.get(path, { administrationId: args.administration_id });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_contact',
    title: 'Create contact',
    description:
      'Create a contact. Supply `company_name` for a company, or `firstname` and `lastname` for a person.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact: contactAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'contacts',
        { contact: args.contact },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_contact',
    title: 'Update contact',
    description: 'Update a contact. Only the attributes you supply are changed.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string(),
      contact: contactAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `contacts/${encodeURIComponent(args.contact_id)}`,
        { contact: args.contact },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'archive_contact',
    title: 'Archive contact',
    description:
      'Archive a contact, hiding it from pickers while keeping its history. Prefer this over deleting.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `contacts/${encodeURIComponent(args.contact_id)}/archive`,
        undefined,
        { administrationId: args.administration_id },
      );
      return textResult(response.data ?? `Contact ${args.contact_id} archived.`);
    },
  }),

  defineTool({
    name: 'delete_contact',
    title: 'Delete contact',
    description:
      'Permanently delete a contact. Moneybird refuses this when the contact still has documents attached; ' +
      'archive it instead in that case.',
    toolset: 'core',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`contacts/${encodeURIComponent(args.contact_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Contact ${args.contact_id} deleted.`);
    },
  }),

  defineTool({
    name: 'create_contact_person',
    title: 'Create contact person',
    description: 'Add a contact person to an existing contact.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string(),
      contact_person: contactPersonAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `contacts/${encodeURIComponent(args.contact_id)}/contact_people`,
        { contact_person: args.contact_person },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_contact_person',
    title: 'Update contact person',
    description: 'Update a contact person belonging to a contact.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string(),
      contact_person_id: z.string(),
      contact_person: contactPersonAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `contacts/${encodeURIComponent(args.contact_id)}/contact_people/${encodeURIComponent(args.contact_person_id)}`,
        { contact_person: args.contact_person },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_contact_person',
    title: 'Delete contact person',
    description: 'Remove a contact person from a contact.',
    toolset: 'core',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string(),
      contact_person_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(
        `contacts/${encodeURIComponent(args.contact_id)}/contact_people/${encodeURIComponent(args.contact_person_id)}`,
        { administrationId: args.administration_id },
      );
      return emptyResult(`Contact person ${args.contact_person_id} deleted.`);
    },
  }),

  defineTool({
    name: 'add_contact_note',
    title: 'Add note to contact',
    description:
      'Attach a note to a contact. Notes can optionally be flagged as a to-do with an assignee.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      contact_id: z.string(),
      note: z.string(),
      todo: z.boolean().optional().describe('Mark the note as a to-do.'),
      assignee_id: z.union([z.string(), z.number()]).optional(),
      todo_date: z.string().optional().describe('Due date, ISO 8601.'),
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        `contacts/${encodeURIComponent(args.contact_id)}/notes`,
        {
          note: {
            note: args.note,
            ...(args.todo !== undefined ? { todo: args.todo } : {}),
            ...(args.assignee_id !== undefined ? { assignee_id: args.assignee_id } : {}),
            ...(args.todo_date ? { todo_date: args.todo_date } : {}),
          },
        },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'list_products',
    title: 'List products',
    description: 'List the product catalogue, optionally narrowed by free-text query or currency.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      query: z.string().optional(),
      currency: z.string().length(3).optional(),
      active: z.boolean().optional(),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('products', {
        administrationId: args.administration_id,
        query: {
          ...listQuery(args),
          ...(args.query ? { query: args.query } : {}),
          ...(args.currency ? { currency: args.currency } : {}),
          ...(args.active !== undefined ? { active: args.active } : {}),
        },
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_product',
    title: 'Get product',
    description: 'Retrieve a product by Moneybird id or by its `identifier`.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      product_id: z.string().optional(),
      identifier: z.string().optional(),
    }),
    handler: async (args, { client }) => {
      if (!args.product_id && !args.identifier) {
        throw new Error('Provide either product_id or identifier.');
      }
      const path = args.product_id
        ? `products/${encodeURIComponent(args.product_id)}`
        : `products/identifier/${encodeURIComponent(args.identifier as string)}`;
      const response = await client.get(path, { administrationId: args.administration_id });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_product',
    title: 'Create product',
    description: 'Add a product to the catalogue.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      product: productAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'products',
        { product: args.product },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_product',
    title: 'Update product',
    description: 'Update a product in the catalogue.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      product_id: z.string(),
      product: productAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `products/${encodeURIComponent(args.product_id)}`,
        { product: args.product },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_product',
    title: 'Delete product',
    description: 'Delete a product from the catalogue.',
    toolset: 'core',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      product_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`products/${encodeURIComponent(args.product_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Product ${args.product_id} deleted.`);
    },
  }),

  defineTool({
    name: 'list_tax_rates',
    title: 'List tax rates',
    description:
      'List the VAT rates configured for the administration. Invoice lines reference these by `tax_rate_id`.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      filter: filterField('percentage:21,tax_rate_type:sales_invoice'),
      ...paginationFields,
    }),
    handler: async (args, { client }) => {
      const response = await client.get('tax_rates', {
        administrationId: args.administration_id,
        query: listQuery(args),
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'list_ledger_accounts',
    title: 'List ledger accounts',
    description:
      'List the chart of accounts. Bookings and invoice lines reference these by `ledger_account_id`.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({ administration_id: administrationIdField }),
    handler: async (args, { client }) => {
      const response = await client.get('ledger_accounts', {
        administrationId: args.administration_id,
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_ledger_account',
    title: 'Get ledger account',
    description: 'Retrieve a single ledger account.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      ledger_account_id: z.string(),
    }),
    handler: async (args, { client }) => {
      const response = await client.get(
        `ledger_accounts/${encodeURIComponent(args.ledger_account_id)}`,
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_ledger_account',
    title: 'Create ledger account',
    description: 'Add an account to the chart of accounts.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      ledger_account: ledgerAccountAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'ledger_accounts',
        { ledger_account: args.ledger_account },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_ledger_account',
    title: 'Update ledger account',
    description: 'Update an account in the chart of accounts.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      ledger_account_id: z.string(),
      ledger_account: ledgerAccountAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.patch(
        `ledger_accounts/${encodeURIComponent(args.ledger_account_id)}`,
        { ledger_account: args.ledger_account },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_ledger_account',
    title: 'Delete ledger account',
    description: 'Delete an account from the chart of accounts.',
    toolset: 'core',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      ledger_account_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`ledger_accounts/${encodeURIComponent(args.ledger_account_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Ledger account ${args.ledger_account_id} deleted.`);
    },
  }),

  defineTool({
    name: 'list_identities',
    title: 'List identities',
    description:
      'List the identities (sender profiles) an administration can invoice under, including the default one.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({ administration_id: administrationIdField }),
    handler: async (args, { client }) => {
      const response = await client.get('identities', {
        administrationId: args.administration_id,
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'get_identity',
    title: 'Get identity',
    description: 'Retrieve one identity, or the administration default when no id is given.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({
      administration_id: administrationIdField,
      identity_id: z.string().optional().describe('Omit to fetch the default identity.'),
    }),
    handler: async (args, { client }) => {
      const path = args.identity_id
        ? `identities/${encodeURIComponent(args.identity_id)}`
        : 'identities/default';
      const response = await client.get(path, { administrationId: args.administration_id });
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'create_identity',
    title: 'Create identity',
    description: 'Create a new sender identity for the administration.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      identity: identityAttributes,
    }),
    handler: async (args, { client }) => {
      const response = await client.post(
        'identities',
        { identity: args.identity },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'update_identity',
    title: 'Update identity',
    description: 'Update a sender identity, or the default one when no id is given.',
    toolset: 'core',
    access: 'write',
    inputSchema: z.object({
      administration_id: administrationIdField,
      identity_id: z.string().optional().describe('Omit to update the default identity.'),
      identity: identityAttributes,
    }),
    handler: async (args, { client }) => {
      const path = args.identity_id
        ? `identities/${encodeURIComponent(args.identity_id)}`
        : 'identities/default';
      const response = await client.patch(
        path,
        { identity: args.identity },
        { administrationId: args.administration_id },
      );
      return textResult(response.data);
    },
  }),

  defineTool({
    name: 'delete_identity',
    title: 'Delete identity',
    description: 'Delete a sender identity.',
    toolset: 'core',
    access: 'destroy',
    irreversible: true,
    inputSchema: z.object({
      administration_id: administrationIdField,
      identity_id: z.string(),
    }),
    handler: async (args, { client }) => {
      await client.delete(`identities/${encodeURIComponent(args.identity_id)}`, {
        administrationId: args.administration_id,
      });
      return emptyResult(`Identity ${args.identity_id} deleted.`);
    },
  }),

  defineTool({
    name: 'list_custom_fields',
    title: 'List custom fields',
    description:
      'List the custom fields defined for contacts, sales invoices and identities, with the ids needed to set them.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({ administration_id: administrationIdField }),
    handler: async (args, { client }) => {
      const response = await client.get('custom_fields', {
        administrationId: args.administration_id,
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'list_document_styles',
    title: 'List document styles',
    description: 'List the document styles (invoice and estimate layouts) of the administration.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({ administration_id: administrationIdField }),
    handler: async (args, { client }) => {
      const response = await client.get('document_styles', {
        administrationId: args.administration_id,
      });
      return listResult(response);
    },
  }),

  defineTool({
    name: 'list_users',
    title: 'List users',
    description:
      'List the users with access to the administration, with their ids and permissions.',
    toolset: 'core',
    access: 'read',
    inputSchema: z.object({ administration_id: administrationIdField }),
    handler: async (args, { client }) => {
      const response = await client.get('users', { administrationId: args.administration_id });
      return listResult(response);
    },
  }),
] as const;

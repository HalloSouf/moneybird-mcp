import type { ToolDefinition } from './common.js';
import { assetsTools } from './assets.js';
import { bankingTools } from './banking.js';
import { coreTools } from './core.js';
import { invoicingTools } from './invoicing.js';
import { purchasesTools } from './purchases.js';
import { reportsTools } from './reports.js';
import { tasksTools } from './tasks.js';
import { timeTools } from './time.js';
import { webhooksTools } from './webhooks.js';

/** Every tool this server knows about; the registry filters by toolset and permission. */
export const allTools: readonly ToolDefinition[] = [
  ...coreTools,
  ...invoicingTools,
  ...purchasesTools,
  ...bankingTools,
  ...timeTools,
  ...reportsTools,
  ...assetsTools,
  ...tasksTools,
  ...webhooksTools,
];

export * from './common.js';
export * from './registry.js';

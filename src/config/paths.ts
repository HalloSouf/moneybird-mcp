import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR = 'moneybird-mcp';

/** Base directory for stored credentials, honouring `XDG_CONFIG_HOME` and Windows `APPDATA`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['MONEYBIRD_MCP_CONFIG_DIR'];
  if (override) return override;

  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg) return join(xdg, APP_DIR);

  if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    if (appData) return join(appData, APP_DIR);
  }

  return join(homedir(), '.config', APP_DIR);
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'credentials.json');
}

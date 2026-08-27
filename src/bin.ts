#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ConfigError, configFromEnv, resolveToolsets, type ServerConfig } from './config/schema.js';
import { FileCredentialStore } from './config/store.js';
import { MissingCredentialsError } from './auth/provider.js';
import { login, logout } from './cli/login.js';
import { listTools, status } from './cli/status.js';
import { out } from './cli/prompt.js';
import { serveStdio } from './server/stdio.js';
import { serveHttp, type HttpAuthMode } from './server/http.js';

const USAGE = `moneybird-mcp — Model Context Protocol server for the Moneybird API

Usage
  moneybird-mcp serve [options]     Start the MCP server (default command)
  moneybird-mcp login [options]     Authenticate and store credentials
  moneybird-mcp logout              Remove stored credentials
  moneybird-mcp status              Show configuration and verify the connection
  moneybird-mcp tools [--json]      List the tools the current settings expose

Serve options
  --http                  Serve over Streamable HTTP instead of stdio
  --host <host>           Bind address for --http (default 127.0.0.1)
  --port <port>           Port for --http (default 3000)
  --toolsets <list>       Comma-separated; "all", or "-name" to drop one from the defaults
  --allow-write           Enable tools that create or modify data
  --allow-delete          Enable tools that delete data (requires --allow-write)
  --administration <id>   Default administration id

Login options
  --oauth                 Use the OAuth application flow (needs client id and secret)
  --oob                   Show the authorization code in the browser instead of redirecting
  --port <port>           Loopback port for the OAuth redirect (default 51739)
  --token <token>         Store a token non-interactively

Environment
  MONEYBIRD_API_TOKEN         Token to use, bypassing stored credentials
  MONEYBIRD_ADMINISTRATION_ID Default administration
  MONEYBIRD_TOOLSETS          Toolsets to enable
  MONEYBIRD_ALLOW_WRITE       "true" to enable write tools
  MONEYBIRD_ALLOW_DELETE      "true" to enable delete tools
  MONEYBIRD_TRANSPORT         "stdio" or "http"
  MONEYBIRD_HTTP_AUTH         "none", "shared-token" or "passthrough"
  MONEYBIRD_MCP_AUTH_TOKEN    Shared secret for --http with "shared-token"
  MONEYBIRD_TIME_ZONE         IANA time zone for date-sensitive endpoints
  MONEYBIRD_CLIENT_ID         OAuth application client id
  MONEYBIRD_CLIENT_SECRET     OAuth application client secret

Full documentation: https://github.com/HalloSouf/moneybird-mcp
`;

interface Flags {
  command: string;
  values: Map<string, string>;
  booleans: Set<string>;
}

function parseArgv(argv: readonly string[]): Flags {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const positional: string[] = [];

  const withValue = new Set(['host', 'port', 'toolsets', 'administration', 'token', 'endpoint']);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      if (!name) continue;
      if (withValue.has(name)) {
        const value = inline ?? argv[index + 1];
        if (inline === undefined) index += 1;
        if (value !== undefined) values.set(name, value);
      } else {
        booleans.add(name);
      }
      continue;
    }
    positional.push(arg);
  }

  return { command: positional[0] ?? 'serve', values, booleans };
}

/** CLI flags win over the environment, so an explicit invocation is never overridden by ambient config. */
function applyFlags(config: ServerConfig, flags: Flags): ServerConfig {
  const next: ServerConfig = { ...config };

  const toolsets = flags.values.get('toolsets');
  if (toolsets) next.toolsets = resolveToolsets(toolsets) as ServerConfig['toolsets'];
  if (flags.booleans.has('allow-write')) next.allowWrite = true;
  if (flags.booleans.has('allow-delete')) {
    next.allowWrite = true;
    next.allowDelete = true;
  }
  if (flags.booleans.has('http')) next.transport = 'http';

  const host = flags.values.get('host');
  if (host) next.host = host;

  const port = flags.values.get('port');
  if (port && flags.command !== 'login') {
    const parsed = Number.parseInt(port, 10);
    if (Number.isFinite(parsed)) next.port = parsed;
  }

  const administration = flags.values.get('administration');
  if (administration) next.administrationId = administration;

  return next;
}

async function packageVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function httpAuthMode(env: NodeJS.ProcessEnv): HttpAuthMode {
  const explicit = env['MONEYBIRD_HTTP_AUTH']?.toLowerCase();
  if (explicit === 'none' || explicit === 'shared-token' || explicit === 'passthrough') {
    return explicit;
  }
  return env['MONEYBIRD_MCP_AUTH_TOKEN'] ? 'shared-token' : 'none';
}

async function runServe(config: ServerConfig, flags: Flags, version: string): Promise<void> {
  if (config.transport === 'http') {
    const authMode = httpAuthMode(process.env);
    const sharedToken = process.env['MONEYBIRD_MCP_AUTH_TOKEN'];

    if (authMode === 'shared-token' && !sharedToken) {
      throw new ConfigError(
        'MONEYBIRD_HTTP_AUTH=shared-token requires MONEYBIRD_MCP_AUTH_TOKEN to be set.',
      );
    }
    if (authMode === 'none' && config.host !== '127.0.0.1' && config.host !== 'localhost') {
      out.warn(
        `Serving on ${config.host} with no authentication. Set MONEYBIRD_MCP_AUTH_TOKEN, ` +
          'or put the server behind a proxy that authenticates callers.',
      );
    }

    const endpoint = flags.values.get('endpoint');
    const handle = await serveHttp({
      config,
      authMode,
      ...(sharedToken ? { sharedToken } : {}),
      ...(endpoint ? { endpoint } : {}),
      version,
      onError: (error) => out.error(error.message),
    });

    out.ok(`moneybird-mcp ${version} listening on ${handle.url} (auth: ${authMode})`);

    const shutdown = () => {
      void handle.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const handle = await serveStdio({ config, version });
  out.line(`moneybird-mcp ${version} ready on stdio — ${handle.toolCount} tools`);

  const shutdown = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const flags = parseArgv(argv);

  if (flags.booleans.has('help') || flags.booleans.has('h') || flags.command === 'help') {
    process.stderr.write(USAGE);
    return 0;
  }

  const version = await packageVersion();
  if (flags.booleans.has('version') || flags.booleans.has('v') || flags.command === 'version') {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const config = applyFlags(configFromEnv(), flags);
  const store = new FileCredentialStore();

  switch (flags.command) {
    case 'login':
      await login({
        config,
        store,
        oauth: flags.booleans.has('oauth'),
        oob: flags.booleans.has('oob'),
        ...(flags.values.get('port')
          ? { port: Number.parseInt(flags.values.get('port') as string, 10) }
          : {}),
        ...(flags.values.get('token') ? { token: flags.values.get('token') } : {}),
        ...(config.administrationId ? { administrationId: config.administrationId } : {}),
      });
      return 0;

    case 'logout':
      await logout(store);
      return 0;

    case 'status':
      return (await status({ config, store })) ? 0 : 1;

    case 'tools':
      listTools(config, flags.booleans.has('json'));
      return 0;

    case 'serve':
      await runServe(config, flags, version);
      return 0;

    default:
      out.error(`Unknown command "${flags.command}".`);
      process.stderr.write(USAGE);
      return 2;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError || error instanceof MissingCredentialsError) {
      out.error(error.message);
      process.exit(2);
    }
    out.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

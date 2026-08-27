import { randomUUID } from 'node:crypto';
import {
  APPLICATIONS_URL,
  OOB_REDIRECT_URI,
  buildAuthorizeUrl,
  exchangeCode,
} from '../auth/oauth.js';
import { LoopbackServer } from '../auth/loopback.js';
import { OAUTH_SCOPES, type OAuthScope, type ServerConfig } from '../config/schema.js';
import {
  FileCredentialStore,
  type CredentialStore,
  type StoredCredentials,
} from '../config/store.js';
import { MoneybirdClient } from '../moneybird/client.js';
import { openInBrowser } from '../util/browser.js';
import { ask, choose, confirm, out } from './prompt.js';

interface Administration {
  id: string | number;
  name?: string;
  country?: string;
  currency?: string;
}

export interface LoginOptions {
  config: ServerConfig;
  store?: CredentialStore;
  /** Forces the OAuth application flow even when only a personal token could be used. */
  oauth?: boolean;
  /** Uses Moneybird's out-of-band redirect, which shows the code in the browser instead of calling back. */
  oob?: boolean;
  /** Port for the loopback redirect; must match the one registered with the OAuth application. */
  port?: number;
  token?: string | undefined;
  administrationId?: string | undefined;
  openBrowser?: (url: string) => Promise<boolean>;
  fetch?: typeof globalThis.fetch;
}

/** Prints a URL and opens it, falling back to the printed link when no browser can be launched. */
async function presentUrl(
  url: string,
  open: (url: string) => Promise<boolean>,
  label: string,
): Promise<void> {
  out.step(label);
  out.line(`  ${url}`);
  const opened = await open(url);
  if (!opened) out.warn('Could not open a browser here — open the link above manually.');
}

async function verifyToken(
  token: string,
  config: ServerConfig,
  fetchImpl: typeof globalThis.fetch | undefined,
): Promise<Administration[]> {
  const client = new MoneybirdClient({
    token,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    maxRetries: 0,
  });

  const response = await client.get<Administration[]>('administrations', {
    administrationScoped: false,
  });
  return Array.isArray(response.data) ? response.data : [];
}

async function pickAdministration(
  administrations: Administration[],
  preselected: string | undefined,
): Promise<Administration | undefined> {
  if (administrations.length === 0) return undefined;

  if (preselected) {
    const match = administrations.find((entry) => String(entry.id) === preselected);
    if (match) return match;
    out.warn(`Administration ${preselected} is not accessible with this token.`);
  }

  return choose(
    '\nWhich administration should this server use by default?',
    administrations.map((administration) => ({
      label: `${administration.name ?? 'Unnamed'} (${administration.id})${
        administration.country ? ` — ${administration.country}` : ''
      }`,
      value: administration,
    })),
  );
}

async function personalTokenFlow(options: LoginOptions): Promise<string> {
  const open = options.openBrowser ?? openInBrowser;

  out.line('Moneybird issues personal API tokens from its application settings page.');
  out.line('On that page: pick "personal API token", tick the scopes you want, and create it.');
  out.line(`Scopes available: ${OAUTH_SCOPES.join(', ')}.`);

  await presentUrl(APPLICATIONS_URL, open, 'Opening Moneybird so you can create a token:');

  for (;;) {
    const token = await ask('\nPaste the token here: ');
    if (token !== '') return token;
    out.warn('No token entered.');
  }
}

async function oauthFlow(options: LoginOptions): Promise<{
  token: string;
  refreshToken: string | undefined;
  scopes: string[];
  expiresAt: number | undefined;
}> {
  const oauth = options.config.oauth;
  if (!oauth) {
    throw new Error(
      'OAuth needs MONEYBIRD_CLIENT_ID and MONEYBIRD_CLIENT_SECRET. ' +
        `Register an application at ${APPLICATIONS_URL} to obtain them.`,
    );
  }

  const open = options.openBrowser ?? openInBrowser;
  const state = randomUUID();
  const scopes: readonly OAuthScope[] = oauth.scopes;

  if (options.oob) {
    const url = buildAuthorizeUrl({
      clientId: oauth.clientId,
      redirectUri: OOB_REDIRECT_URI,
      scopes,
      state,
    });
    await presentUrl(url, open, 'Authorize this application in Moneybird:');
    const code = await ask('\nPaste the authorization code Moneybird shows: ');
    const tokens = await exchangeCode({
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      code,
      redirectUri: OOB_REDIRECT_URI,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return {
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
      expiresAt: tokens.expiresAt,
    };
  }

  const port = options.port ?? 51_739;
  const loopback = new LoopbackServer({ port, expectedState: state });
  const redirectUri = oauth.redirectUri ?? `http://127.0.0.1:${port}/callback`;

  out.line(`\nThis flow redirects to ${redirectUri}.`);
  out.line(
    'Moneybird requires an exact match, so that URI must be registered with your application.',
  );

  const url = buildAuthorizeUrl({ clientId: oauth.clientId, redirectUri, scopes, state });
  await presentUrl(url, open, 'Authorize this application in Moneybird:');
  out.line('\nWaiting for Moneybird to redirect back…');

  const { code } = await loopback.waitForCode();
  const tokens = await exchangeCode({
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
    code,
    redirectUri,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    token: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    scopes: tokens.scopes,
    expiresAt: tokens.expiresAt,
  };
}

/**
 * Interactive authentication.
 *
 * Two routes exist because Moneybird supports no dynamic client registration: either the user
 * creates a personal API token by hand (no application needed), or they register their own OAuth
 * application and supply its credentials. There is no flow that works without one of the two.
 */
export async function login(options: LoginOptions): Promise<StoredCredentials> {
  const store = options.store ?? new FileCredentialStore();
  const useOAuth = options.oauth ?? options.config.oauth !== undefined;

  let credentials: StoredCredentials;

  if (options.token) {
    credentials = { version: 1, kind: 'personal_access_token', accessToken: options.token };
  } else if (useOAuth) {
    const result = await oauthFlow(options);
    const oauth = options.config.oauth;
    credentials = {
      version: 1,
      kind: 'oauth',
      accessToken: result.token,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
      ...(result.scopes.length > 0 ? { scopes: result.scopes } : {}),
      ...(oauth ? { clientId: oauth.clientId, clientSecret: oauth.clientSecret } : {}),
    };
  } else {
    const token = await personalTokenFlow(options);
    credentials = { version: 1, kind: 'personal_access_token', accessToken: token };
  }

  out.step('Verifying the token…');
  const administrations = await verifyToken(credentials.accessToken, options.config, options.fetch);

  if (administrations.length === 0) {
    out.warn('The token works but reaches no administrations. Check the scopes you granted.');
  }

  const administration = await pickAdministration(administrations, options.administrationId);
  if (administration) {
    credentials.administrationId = String(administration.id);
    if (administration.name) credentials.administrationName = administration.name;
  }

  credentials.createdAt = new Date().toISOString();
  await store.write(credentials);

  out.ok(`Credentials saved to ${store.location}`);
  if (administration) {
    out.ok(
      `Default administration: ${administration.name ?? administration.id} (${administration.id})`,
    );
  }

  out.step('Add the server to Claude Code with:');
  out.line('  claude mcp add moneybird -- npx -y moneybird-mcp serve');
  out.line('\nWrite access is off by default. To enable it:');
  out.line(
    '  claude mcp add moneybird --env MONEYBIRD_ALLOW_WRITE=true -- npx -y moneybird-mcp serve',
  );

  return credentials;
}

export async function logout(store: CredentialStore = new FileCredentialStore()): Promise<void> {
  const existing = await store.read();
  if (!existing) {
    out.line('No stored credentials to remove.');
    return;
  }

  if (!(await confirm(`Remove the credentials at ${store.location}?`))) {
    out.line('Left unchanged.');
    return;
  }

  await store.clear();
  out.ok('Credentials removed.');
  if (existing.kind === 'oauth') {
    out.line(
      'The Moneybird authorization itself still exists — revoke it in Moneybird to fully withdraw access.',
    );
  }
}

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** The spec caps a document at 5 kB, which is ample and keeps a hostile server from filling memory. */
const MAX_BYTES = 5 * 1024;
/** Discovery happens while a user waits on a redirect, so a slow document must not hang the flow. */
const FETCH_TIMEOUT_MS = 5_000;
const MIN_CACHE_MS = 60_000;
const MAX_CACHE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_MS = 15 * 60 * 1000;

/** Authentication methods that would require a shared secret the client cannot safely hold. */
const SYMMETRIC_AUTH_METHODS = new Set([
  'client_secret_post',
  'client_secret_basic',
  'client_secret_jwt',
]);

export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientMetadataError';
  }
}

export interface ClientMetadataDocument {
  clientId: string;
  clientName: string | undefined;
  redirectUris: string[];
}

/**
 * Whether a `client_id` is a Client Identifier URL rather than a registered id.
 *
 * https, a path, no userinfo and no fragment — the shape the draft requires. Anything else is
 * treated as an ordinary registered client id, so the two mechanisms coexist without ambiguity.
 */
export function isClientIdentifierUrl(value: string): boolean {
  if (!value.startsWith('https://')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.pathname !== '/' &&
    url.pathname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === ''
  );
}

function ipv4IsSpecial(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, and the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return a === 255 && b === 255 && c === 255 && d === 255;
}

function ipv6IsSpecial(address: string): boolean {
  const normalised = address.toLowerCase().split('%')[0] ?? '';
  if (normalised === '::' || normalised === '::1') return true;

  // An IPv4-mapped address reaches the IPv4 host, so it inherits that address's verdict.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  if (mapped?.[1]) return ipv4IsSpecial(mapped[1]);

  const head = normalised.split(':')[0] ?? '';
  const prefix = Number.parseInt(head.padEnd(4, '0'), 16);
  if (!Number.isFinite(prefix)) return true;

  if ((prefix & 0xfe00) === 0xfc00) return true; // unique local
  if ((prefix & 0xffc0) === 0xfe80) return true; // link-local
  if ((prefix & 0xff00) === 0xff00) return true; // multicast
  return normalised.startsWith('2001:db8:'); // documentation
}

/** Rejects the addresses the draft calls special-use, which is what makes this not an SSRF hole. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !ipv4IsSpecial(address);
  if (version === 6) return !ipv6IsSpecial(address);
  return false;
}

function cacheMsFrom(header: string | null): number {
  if (!header) return DEFAULT_CACHE_MS;
  if (/no-store|no-cache/i.test(header)) return MIN_CACHE_MS;
  const maxAge = /max-age\s*=\s*(\d+)/i.exec(header);
  if (!maxAge?.[1]) return DEFAULT_CACHE_MS;
  const seconds = Number.parseInt(maxAge[1], 10);
  if (!Number.isFinite(seconds)) return DEFAULT_CACHE_MS;
  return Math.min(Math.max(seconds * 1000, MIN_CACHE_MS), MAX_CACHE_MS);
}

async function readCapped(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new ClientMetadataError(`The document is larger than ${limit} bytes.`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function parseDocument(raw: string, clientIdUrl: string): ClientMetadataDocument {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ClientMetadataError('The document is not JSON.');
  }

  // Simple string comparison, as the draft requires: no normalising of ports or trailing slashes,
  // because any normalisation lets two different urls claim to be the same client.
  if (body['client_id'] !== clientIdUrl) {
    throw new ClientMetadataError("The document's client_id does not match the url it came from.");
  }

  const redirectUris = body['redirect_uris'];
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new ClientMetadataError('The document declares no redirect_uris.');
  }
  const uris = redirectUris.filter((entry): entry is string => typeof entry === 'string');
  if (uris.length === 0) {
    throw new ClientMetadataError('The document declares no usable redirect_uris.');
  }

  const authMethod = body['token_endpoint_auth_method'];
  if (typeof authMethod === 'string' && SYMMETRIC_AUTH_METHODS.has(authMethod)) {
    throw new ClientMetadataError(
      `A client identified by url cannot authenticate with ${authMethod}.`,
    );
  }

  return {
    clientId: clientIdUrl,
    clientName: typeof body['client_name'] === 'string' ? body['client_name'] : undefined,
    redirectUris: uris,
  };
}

export interface ClientMetadataFetcherOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Resolves a hostname to addresses; injectable so tests do not depend on live DNS. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

async function resolveWithDns(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * Fetches and caches Client ID Metadata Documents.
 *
 * A client identified by url needs no registration: the url *is* the identity, and this resolves
 * it to the metadata that would otherwise have been registered. Everything here is defensive,
 * because the url comes from whoever started the authorization: the address must be public, the
 * response must be a direct 200, the body is capped, and the document has to name itself.
 */
export class ClientMetadataFetcher {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly resolveHost: (hostname: string) => Promise<string[]>;
  private readonly cache = new Map<string, { document: ClientMetadataDocument; until: number }>();

  constructor(options: ClientMetadataFetcherOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.resolveHost = options.resolveHost ?? resolveWithDns;
  }

  async resolve(clientIdUrl: string): Promise<ClientMetadataDocument> {
    const cached = this.cache.get(clientIdUrl);
    if (cached && cached.until > this.now()) return cached.document;

    if (!isClientIdentifierUrl(clientIdUrl)) {
      throw new ClientMetadataError('Not a valid client identifier url.');
    }

    const url = new URL(clientIdUrl);
    await this.assertPublicHost(url.hostname);

    let response: Response;
    try {
      response = await this.fetchImpl(clientIdUrl, {
        // Following a redirect would let a public url hand off to somewhere the address check
        // never saw, so the draft forbids it outright.
        redirect: 'manual',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ClientMetadataError(
        `Could not fetch the client metadata: ${error instanceof Error ? error.message : 'failed'}.`,
      );
    }

    if (response.status !== 200) {
      throw new ClientMetadataError(`The document returned HTTP ${response.status}.`);
    }

    const document = parseDocument(await readCapped(response, MAX_BYTES), clientIdUrl);

    // Only successes are cached; an error must not stick to a client that fixes its document.
    this.cache.set(clientIdUrl, {
      document,
      until: this.now() + cacheMsFrom(response.headers.get('cache-control')),
    });
    return document;
  }

  private async assertPublicHost(hostname: string): Promise<void> {
    const literal = hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal)) {
      if (!isPublicAddress(literal)) {
        throw new ClientMetadataError('Client metadata may not be hosted on a private address.');
      }
      return;
    }

    let addresses: string[];
    try {
      addresses = await this.resolveHost(hostname);
    } catch {
      throw new ClientMetadataError(`Could not resolve ${hostname}.`);
    }

    if (addresses.length === 0 || !addresses.every((address) => isPublicAddress(address))) {
      throw new ClientMetadataError('Client metadata may not be hosted on a private address.');
    }
  }
}

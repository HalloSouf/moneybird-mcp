import {
  MoneybirdError,
  MoneybirdNetworkError,
  createErrorForStatus,
  parseErrorBody,
} from './errors.js';
import { readPageInfo, type PageInfo } from './pagination.js';
import {
  GENERAL_BUDGET,
  REPORTS_BUDGET,
  SlidingWindowLimiter,
  backoffDelay,
  readRateLimit,
  type RateLimitSnapshot,
} from './rate-limit.js';

export const DEFAULT_BASE_URL = 'https://moneybird.com/api/v2';

/** Resolves the bearer token for a request; may refresh an expired OAuth token. */
export type TokenProvider = () => string | Promise<string>;

/** Resolves the default administration, which can change while the server is running. */
export type AdministrationProvider = () => string | undefined;

export interface MoneybirdClientOptions {
  token: string | TokenProvider;
  /** Administration used by every request that does not name one explicitly. */
  administrationId?: string | AdministrationProvider | undefined;
  baseUrl?: string;
  /** IANA time zone applied to date-sensitive endpoints, e.g. `Europe/Amsterdam`. */
  timeZone?: string | undefined;
  userAgent?: string;
  /** Attempts after the first for retryable failures. */
  maxRetries?: number;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Disables the client-side pacing that keeps requests inside Moneybird's published budget. */
  disableRateLimiting?: boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path below the administration, e.g. `sales_invoices/123`. Leading slash optional. */
  path: string;
  /** Overrides the client's default administration for this request. */
  administrationId?: string | undefined;
  /** Set to `false` for the one global endpoint, `GET /administrations`. */
  administrationScoped?: boolean;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Returns the `Location` of a 3xx instead of following it. Moneybird serves every file
   * download as a 302 to a short-lived URL, which is more useful to a caller than the bytes.
   */
  manualRedirect?: boolean;
  signal?: AbortSignal | undefined;
}

export interface MoneybirdResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  rateLimit: RateLimitSnapshot;
  pageInfo: PageInfo;
  /** Set when `manualRedirect` was requested and Moneybird answered with a 3xx. */
  redirectUrl?: string;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function isReportsPath(path: string): boolean {
  return path.replace(/^\/+/, '').startsWith('reports/');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin, typed transport over the Moneybird REST API.
 *
 * It owns URL construction, authentication, retries and error mapping; it deliberately knows
 * nothing about individual resources so that tool modules stay the single source of truth
 * for request and response shapes.
 */
export class MoneybirdClient {
  private readonly baseUrl: string;
  private readonly getToken: TokenProvider;
  private readonly resolveAdministrationId: AdministrationProvider;
  private readonly timeZone: string | undefined;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly generalLimiter: SlidingWindowLimiter | undefined;
  private readonly reportsLimiter: SlidingWindowLimiter | undefined;
  private lastRateLimit: RateLimitSnapshot | undefined;

  constructor(options: MoneybirdClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.getToken =
      typeof options.token === 'string' ? () => options.token as string : options.token;
    this.resolveAdministrationId =
      typeof options.administrationId === 'function'
        ? options.administrationId
        : () => options.administrationId as string | undefined;
    this.timeZone = options.timeZone;
    this.userAgent = options.userAgent ?? 'moneybird-mcp';
    this.maxRetries = options.maxRetries ?? 3;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;

    if (!options.disableRateLimiting) {
      const now = options.now;
      this.generalLimiter = new SlidingWindowLimiter(
        GENERAL_BUDGET.limit,
        GENERAL_BUDGET.windowMs,
        now,
      );
      this.reportsLimiter = new SlidingWindowLimiter(
        REPORTS_BUDGET.limit,
        REPORTS_BUDGET.windowMs,
        now,
      );
    }
  }

  /** The `RateLimit-*` state reported by the most recent response, if any. */
  get rateLimitState(): RateLimitSnapshot | undefined {
    return this.lastRateLimit;
  }

  get defaultAdministrationId(): string | undefined {
    return this.resolveAdministrationId();
  }

  async request<T = unknown>(options: RequestOptions): Promise<MoneybirdResponse<T>> {
    const url = this.buildUrl(options);
    const method = options.method ?? 'GET';

    let lastError: MoneybirdError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.awaitRateLimitSlot(options.path);

      let response: Response;
      try {
        response = await this.send(url, method, options);
      } catch (cause) {
        lastError = this.toNetworkError(cause, method, url);
        if (attempt === this.maxRetries) throw lastError;
        await this.sleep(backoffDelay({ attempt, random: this.random }));
        continue;
      }

      this.lastRateLimit = readRateLimit(response.headers);

      if (options.manualRedirect && response.status >= 300 && response.status < 400) {
        return this.toRedirectResponse<T>(response, options);
      }

      if (response.ok) {
        return this.toSuccessResponse<T>(response, options);
      }

      const error = await this.toApiError(response, method, url);
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === this.maxRetries) throw error;

      lastError = error;
      await this.sleep(
        backoffDelay({
          attempt,
          retryAfterSeconds: this.lastRateLimit.retryAfterSeconds,
          random: this.random,
        }),
      );
    }

    /* c8 ignore next -- the loop either returns or throws on its final attempt. */
    throw lastError ?? new MoneybirdError('Request failed', { status: 0, method, url });
  }

  get<T = unknown>(path: string, options: Omit<RequestOptions, 'path' | 'method'> = {}) {
    return this.request<T>({ ...options, path, method: 'GET' });
  }

  post<T = unknown>(
    path: string,
    body?: unknown,
    options: Omit<RequestOptions, 'path' | 'method' | 'body'> = {},
  ) {
    return this.request<T>({ ...options, path, method: 'POST', body });
  }

  patch<T = unknown>(
    path: string,
    body?: unknown,
    options: Omit<RequestOptions, 'path' | 'method' | 'body'> = {},
  ) {
    return this.request<T>({ ...options, path, method: 'PATCH', body });
  }

  delete<T = unknown>(path: string, options: Omit<RequestOptions, 'path' | 'method'> = {}) {
    return this.request<T>({ ...options, path, method: 'DELETE' });
  }

  /**
   * Every documented path carries a `{format}` segment defaulting to `.json`. It is appended
   * here rather than exposed, so callers pass plain resource paths.
   */
  buildUrl(options: RequestOptions): string {
    const path = options.path.replace(/^\/+/, '').replace(/\/+$/, '');
    const scoped = options.administrationScoped ?? true;

    let prefix = '';
    if (scoped) {
      const administrationId = options.administrationId ?? this.resolveAdministrationId();
      if (!administrationId) {
        throw new MoneybirdError(
          'No administration selected. Set MONEYBIRD_ADMINISTRATION_ID or pass administration_id.',
          { status: 0, method: options.method ?? 'GET', url: `${this.baseUrl}/${path}` },
        );
      }
      prefix = `${encodeURIComponent(administrationId)}/`;
    }

    const url = new URL(`${this.baseUrl}/${prefix}${path}.json`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async send(url: string, method: string, options: RequestOptions): Promise<Response> {
    const token = await this.getToken();
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'user-agent': this.userAgent,
    });
    if (this.timeZone) headers.set('time-zone', this.timeZone);
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    return this.fetchImpl(url, {
      method,
      headers,
      signal,
      redirect: options.manualRedirect ? 'manual' : 'follow',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  }

  private async awaitRateLimitSlot(path: string): Promise<void> {
    const limiter = isReportsPath(path) ? this.reportsLimiter : this.generalLimiter;
    if (!limiter) return;
    const delay = limiter.delayUntilSlot();
    if (delay > 0) await this.sleep(delay);
    limiter.record();
  }

  private async toSuccessResponse<T>(
    response: Response,
    options: RequestOptions,
  ): Promise<MoneybirdResponse<T>> {
    return {
      data: (await readBody(response)) as T,
      status: response.status,
      headers: response.headers,
      rateLimit: readRateLimit(response.headers),
      pageInfo: readPageInfo(response.headers, {
        page: numeric(options.query?.['page']),
        perPage: numeric(options.query?.['per_page']),
      }),
    };
  }

  private toRedirectResponse<T>(response: Response, options: RequestOptions): MoneybirdResponse<T> {
    const location = response.headers.get('location') ?? '';
    return {
      data: { url: location } as T,
      status: response.status,
      headers: response.headers,
      rateLimit: readRateLimit(response.headers),
      pageInfo: readPageInfo(response.headers, {
        page: numeric(options.query?.['page']),
        perPage: numeric(options.query?.['per_page']),
      }),
      redirectUrl: location,
    };
  }

  private async toApiError(
    response: Response,
    method: string,
    url: string,
  ): Promise<MoneybirdError> {
    const body = await readBody(response);
    return createErrorForStatus(response.status, parseErrorBody(response.status, body), {
      method,
      url,
      body,
      requestId: response.headers.get('x-request-id') ?? undefined,
      retryAfterSeconds: readRateLimit(response.headers).retryAfterSeconds,
    });
  }

  private toNetworkError(cause: unknown, method: string, url: string): MoneybirdNetworkError {
    const isTimeout = cause instanceof Error && cause.name === 'TimeoutError';
    const message = isTimeout
      ? `Request timed out after ${this.requestTimeoutMs}ms`
      : `Network request failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    return new MoneybirdNetworkError(message, { method, url, cause });
  }
}

function numeric(value: string | number | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Returns parsed JSON, raw text, or `null` for the 55 endpoints that answer without a body. */
async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.trim() === '') return null;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return text;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

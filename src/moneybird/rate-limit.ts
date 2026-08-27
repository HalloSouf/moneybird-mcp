/**
 * Client-side pacing for Moneybird's published budget of 150 requests per 5 minutes per IP
 * (50 per 5 minutes for `/reports/*`), plus the state carried by `RateLimit-*` response headers.
 */

export interface RateLimitSnapshot {
  limit: number | undefined;
  remaining: number | undefined;
  /** Unix epoch seconds at which the window resets. */
  reset: number | undefined;
  retryAfterSeconds: number | undefined;
}

export const GENERAL_BUDGET = { limit: 150, windowMs: 5 * 60 * 1000 } as const;
export const REPORTS_BUDGET = { limit: 50, windowMs: 5 * 60 * 1000 } as const;

function intHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readRateLimit(headers: Headers): RateLimitSnapshot {
  return {
    limit: intHeader(headers, 'ratelimit-limit'),
    remaining: intHeader(headers, 'ratelimit-remaining'),
    reset: intHeader(headers, 'ratelimit-reset'),
    retryAfterSeconds: intHeader(headers, 'retry-after'),
  };
}

/**
 * A sliding-window request counter.
 *
 * Moneybird counts per IP, so several server instances behind one NAT share a budget this
 * limiter cannot observe. It therefore prevents self-inflicted 429s only; the client still
 * has to honour a 429 when one arrives.
 */
export class SlidingWindowLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds to wait before a request would fit inside the window; 0 when it fits now. */
  delayUntilSlot(): number {
    this.evictExpired();
    if (this.timestamps.length < this.limit) return 0;
    const oldest = this.timestamps[0];
    if (oldest === undefined) return 0;
    return Math.max(0, oldest + this.windowMs - this.now());
  }

  record(): void {
    this.evictExpired();
    this.timestamps.push(this.now());
  }

  get inFlightWindowCount(): number {
    this.evictExpired();
    return this.timestamps.length;
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.windowMs;
    let drop = 0;
    while (drop < this.timestamps.length && (this.timestamps[drop] ?? 0) <= cutoff) drop += 1;
    if (drop > 0) this.timestamps.splice(0, drop);
  }
}

export interface BackoffOptions {
  attempt: number;
  baseMs?: number;
  maxMs?: number;
  retryAfterSeconds?: number | undefined;
  random?: () => number;
}

/** Full-jitter exponential backoff; a server-supplied `Retry-After` always wins. */
export function backoffDelay({
  attempt,
  baseMs = 500,
  maxMs = 30_000,
  retryAfterSeconds,
  random = Math.random,
}: BackoffOptions): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, maxMs);
  }
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(random() * ceiling);
}

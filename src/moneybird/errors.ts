/**
 * Error types for the Moneybird API.
 *
 * Moneybird returns two distinct error shapes, described at
 * https://developer.moneybird.com/introduction:
 *
 * - "symbolic":     `{ "error": "Invalid credentials" }`
 * - "non-symbolic": `{ "error": { "field": ["msg"] }, "details": { "field": [{ "error": "blank" }] } }`
 */

/** Field name to the list of human-readable messages Moneybird returned for it. */
export type ValidationMessages = Record<string, string[]>;

/** Field name to the list of machine-readable error codes Moneybird returned for it. */
export type ValidationDetails = Record<string, Array<Record<string, string>>>;

export interface MoneybirdErrorOptions {
  status: number;
  method: string;
  url: string;
  requestId?: string | undefined;
  validation?: ValidationMessages | undefined;
  details?: ValidationDetails | undefined;
  body?: unknown;
  cause?: unknown;
}

/** Any failure originating from the Moneybird API or from talking to it. */
export class MoneybirdError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly requestId: string | undefined;
  readonly validation: ValidationMessages | undefined;
  readonly details: ValidationDetails | undefined;
  readonly body: unknown;

  constructor(message: string, options: MoneybirdErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'MoneybirdError';
    this.status = options.status;
    this.method = options.method;
    this.url = options.url;
    this.requestId = options.requestId;
    this.validation = options.validation;
    this.details = options.details;
    this.body = options.body;
  }

  /** True when retrying the identical request could plausibly succeed. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

/** 401/403 — the token is missing, revoked, or lacks the scope for this endpoint. */
export class MoneybirdAuthError extends MoneybirdError {
  constructor(message: string, options: MoneybirdErrorOptions) {
    super(message, options);
    this.name = 'MoneybirdAuthError';
  }
}

/** 404 — the resource does not exist, or the token cannot see this administration. */
export class MoneybirdNotFoundError extends MoneybirdError {
  constructor(message: string, options: MoneybirdErrorOptions) {
    super(message, options);
    this.name = 'MoneybirdNotFoundError';
  }
}

/** 422 — the request was well-formed but rejected by Moneybird's validations. */
export class MoneybirdValidationError extends MoneybirdError {
  constructor(message: string, options: MoneybirdErrorOptions) {
    super(message, options);
    this.name = 'MoneybirdValidationError';
  }
}

/** 429 — the per-IP request budget is exhausted. */
export class MoneybirdRateLimitError extends MoneybirdError {
  /** Seconds to wait before retrying, from the `Retry-After` header. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    options: MoneybirdErrorOptions & { retryAfterSeconds?: number | undefined },
  ) {
    super(message, options);
    this.name = 'MoneybirdRateLimitError';
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** The request never produced an HTTP response (DNS failure, socket reset, timeout). */
export class MoneybirdNetworkError extends MoneybirdError {
  constructor(message: string, options: Omit<MoneybirdErrorOptions, 'status'>) {
    super(message, { ...options, status: 0 });
    this.name = 'MoneybirdNetworkError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMessages(value: unknown): ValidationMessages | undefined {
  if (!isRecord(value)) return undefined;
  const out: ValidationMessages = {};
  for (const [field, messages] of Object.entries(value)) {
    if (Array.isArray(messages)) out[field] = messages.map(String);
    else if (typeof messages === 'string') out[field] = [messages];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toDetails(value: unknown): ValidationDetails | undefined {
  if (!isRecord(value)) return undefined;
  const out: ValidationDetails = {};
  for (const [field, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) continue;
    out[field] = entries.filter(isRecord).map((entry) => {
      const normalised: Record<string, string> = {};
      for (const [key, val] of Object.entries(entry)) normalised[key] = String(val);
      return normalised;
    });
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Renders a validation map as `field: message; field: message` for a single-line error. */
function summariseValidation(validation: ValidationMessages): string {
  return Object.entries(validation)
    .map(([field, messages]) => `${field}: ${messages.join(', ')}`)
    .join('; ');
}

const STATUS_FALLBACKS: Record<number, string> = {
  400: 'Bad request',
  401: 'Invalid or missing API token',
  402: 'Payment required — the Moneybird subscription does not cover this action',
  403: 'Forbidden — the token lacks the required scope for this endpoint',
  404: 'Not found',
  405: 'Method not allowed',
  406: 'Not acceptable',
  422: 'Unprocessable entity',
  429: 'Rate limit exceeded',
  500: 'Moneybird server error',
};

export interface ParsedErrorBody {
  message: string;
  validation: ValidationMessages | undefined;
  details: ValidationDetails | undefined;
}

/** Reduces either Moneybird error shape to a message plus, when present, the field errors. */
export function parseErrorBody(status: number, body: unknown): ParsedErrorBody {
  const fallback = STATUS_FALLBACKS[status] ?? `HTTP ${status}`;

  if (typeof body === 'string' && body.trim() !== '') {
    return { message: body.trim(), validation: undefined, details: undefined };
  }
  if (!isRecord(body)) {
    return { message: fallback, validation: undefined, details: undefined };
  }

  const error = body['error'];
  const details = toDetails(body['details']);

  if (typeof error === 'string') {
    return { message: error, validation: undefined, details };
  }

  const validation = toMessages(error);
  if (validation) {
    return { message: summariseValidation(validation), validation, details };
  }

  const message = body['message'];
  return {
    message: typeof message === 'string' ? message : fallback,
    validation: undefined,
    details,
  };
}

/** Maps an HTTP status onto the matching {@link MoneybirdError} subclass. */
export function createErrorForStatus(
  status: number,
  parsed: ParsedErrorBody,
  options: Omit<MoneybirdErrorOptions, 'status' | 'validation' | 'details'> & {
    retryAfterSeconds?: number | undefined;
  },
): MoneybirdError {
  const base: MoneybirdErrorOptions = {
    ...options,
    status,
    validation: parsed.validation,
    details: parsed.details,
  };

  if (status === 401 || status === 403) return new MoneybirdAuthError(parsed.message, base);
  if (status === 404) return new MoneybirdNotFoundError(parsed.message, base);
  if (status === 422) return new MoneybirdValidationError(parsed.message, base);
  if (status === 429) {
    return new MoneybirdRateLimitError(parsed.message, {
      ...base,
      retryAfterSeconds: options.retryAfterSeconds,
    });
  }
  return new MoneybirdError(parsed.message, base);
}

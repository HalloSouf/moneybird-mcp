/** Parsing of Moneybird's pagination signals: the RFC 8288 `Link` header and `X-Total-Count`. */

export interface PageInfo {
  page: number | undefined;
  perPage: number | undefined;
  /** Present only on the subset of endpoints that emit `X-Total-Count`. */
  totalCount: number | undefined;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextPage: number | undefined;
  previousPage: number | undefined;
}

/** Moneybird caps `per_page` at 100; larger values are rejected rather than clamped. */
export const MAX_PER_PAGE = 100;
export const DEFAULT_PER_PAGE = 50;

/** Extracts `rel` -> URL pairs from a `Link` header. */
export function parseLinkHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const links: Record<string, string> = {};
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/.exec(part.trim());
    if (match?.[1] && match[2]) links[match[2].trim()] = match[1].trim();
  }
  return links;
}

function pageNumberFrom(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const value = new URL(url).searchParams.get('page');
    if (value === null) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function intHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readPageInfo(
  headers: Headers,
  requested: { page?: number | undefined; perPage?: number | undefined } = {},
): PageInfo {
  const links = parseLinkHeader(headers.get('link'));
  const nextPage = pageNumberFrom(links['next']);
  const previousPage = pageNumberFrom(links['prev'] ?? links['previous']);

  return {
    page: requested.page,
    perPage: requested.perPage,
    totalCount: intHeader(headers, 'x-total-count'),
    hasNextPage: links['next'] !== undefined,
    hasPreviousPage: links['prev'] !== undefined || links['previous'] !== undefined,
    nextPage,
    previousPage,
  };
}

/**
 * Builds a `key:value,key:value` filter string.
 *
 * Moneybird replaces its default filter entirely when one is supplied, so a caller
 * narrowing on a single key must restate every key it still wants applied.
 */
export function buildFilter(
  filters: Record<string, string | number | boolean | undefined>,
): string {
  return Object.entries(filters)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}:${value}`)
    .join(',');
}

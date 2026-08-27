import { vi } from 'vitest';

export interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Thrown instead of resolving, to simulate a transport-level failure. */
  throws?: Error;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: string | undefined;
}

export interface FetchStub {
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
  /** The single request made, asserting exactly one happened. */
  lastRequest(): RecordedRequest;
}

function toResponse(stub: StubResponse): Response {
  const headers = new Headers(stub.headers ?? {});
  const status = stub.status ?? 200;

  if (stub.body === undefined || status === 204) {
    return new Response(null, { status, headers });
  }
  if (typeof stub.body === 'string') {
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain');
    return new Response(stub.body, { status, headers });
  }
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(stub.body), { status, headers });
}

/** A `fetch` replacement that answers from a queue and records what it was called with. */
export function stubFetch(responses: StubResponse | StubResponse[]): FetchStub {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const requests: RecordedRequest[] = [];
  let last: StubResponse | undefined;

  const fetchImpl = vi.fn(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });

      let body: unknown;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }

      requests.push({
        url,
        method: init?.method ?? 'GET',
        headers,
        body,
        redirect: init?.redirect,
      });

      const next = queue.shift() ?? last;
      if (!next) throw new Error(`No stubbed response for ${init?.method ?? 'GET'} ${url}`);
      last = next;

      if (next.throws) throw next.throws;
      return toResponse(next);
    },
  );

  return {
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    requests,
    lastRequest(): RecordedRequest {
      if (requests.length !== 1) {
        throw new Error(`Expected exactly one request, saw ${requests.length}`);
      }
      return requests[0] as RecordedRequest;
    },
  };
}

/** Resolves immediately so retry backoff does not slow the suite down. */
export const instantSleep = async (): Promise<void> => undefined;

import { Announcer } from '../src/index.js';
import type { AnnouncerOptions } from '../src/index.js';

export interface StubResponse {
  status?: number;
  /** Serialised to JSON. Use `raw` to send a body verbatim (or an empty one). */
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch double that plays back a queue of responses and records every call. */
export function stubFetch(responses: StubResponse[]): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const queue = [...responses];
  const calls: RecordedCall[] = [];

  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    const next = queue.shift();
    if (!next) throw new Error(`stubFetch: unexpected call number ${calls.length} to ${input}`);

    const status = next.status ?? 200;
    const payload = next.raw ?? (next.body === undefined ? '' : JSON.stringify(next.body));
    return new Response(status === 204 || payload === '' ? null : payload, {
      status,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  };

  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

/** A client wired to a stub, with retries off unless a test asks for them. */
export function testClient(
  responses: StubResponse[],
  options: AnnouncerOptions = {},
): { client: Announcer; calls: RecordedCall[] } {
  const { fetch, calls } = stubFetch(responses);
  const client = new Announcer({
    apiKey: 'ann_test_key',
    baseUrl: 'https://api.example.test',
    maxRetries: 0,
    fetch,
    ...options,
  });
  return { client, calls };
}

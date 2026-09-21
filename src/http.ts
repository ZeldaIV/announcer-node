import { AnnouncerError, ConnectionError, ProblemBody, errorFromResponse } from './errors.js';

/** Where the hosted API lives. */
export const DEFAULT_BASE_URL = 'https://mail.misralo.com';

export interface AnnouncerOptions {
  /** Your `ann_...` key. Defaults to `process.env.ANNOUNCER_API_KEY`. */
  apiKey?: string;
  /** API root. Defaults to `process.env.ANNOUNCER_BASE_URL`, then the hosted API. */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Default 30000. */
  timeout?: number;
  /** Extra attempts after a failure. Default 2, so three attempts in all. */
  maxRetries?: number;
  /** Swap in your own fetch (undici, a test double, a proxy-aware wrapper). */
  fetch?: typeof globalThis.fetch;
  /** Appended to the SDK's own User-Agent. Name your app here. */
  userAgent?: string;
  /** Headers added to every request. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Treat 409 as retryable. Set for sends carrying an Idempotency-Key, where a
   * 409 means "the original attempt is still in flight" rather than a real
   * conflict — waiting is exactly the right response.
   */
  retryOn409?: boolean;
  /** Caller-supplied cancellation, combined with the per-attempt timeout. */
  signal?: AbortSignal;
  /** Passed to the error factory so a 422 on the send path can be typed precisely. */
  errorContext?: { recipient?: string };
}

const SDK_VERSION = '0.1.1';

/** Statuses worth trying again. Everything else is the caller's problem. */
function isRetryableStatus(status: number, retryOn409: boolean): boolean {
  if (status === 408 || status === 429) return true;
  if (status === 409 && retryOn409) return true;
  return status >= 500;
}

/**
 * Exponential backoff with full jitter, capped at 8s. Jitter matters: without
 * it, every client that hit the same rate limit retries in lockstep and hits it
 * again together.
 */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(8000, 500 * 2 ** attempt);
  return Math.random() * ceiling;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Keys whose values are tenant data and must not be rewritten. */
const PASSTHROUGH_KEYS = new Set(['payload', 'detail']);

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The API is inconsistent about casing — hand-written responses are camelCase,
 * serde-derived list rows are snake_case. Normalising here is the difference
 * between an SDK and a thin `fetch` wrapper.
 *
 * Free-form objects (`payload`, `detail`) are copied through untouched: their
 * keys belong to the tenant, and rewriting them would corrupt real data.
 */
export function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (value !== null && typeof value === 'object' && (value as object).constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const camel = toCamel(key);
      out[camel] = PASSTHROUGH_KEYS.has(camel) ? nested : camelize(nested);
    }
    return out;
  }
  return value;
}

/**
 * The transport: auth, JSON, timeouts, retries, and error typing. Everything
 * public is a thin wrapper over `request`.
 */
export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly userAgent: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: AnnouncerOptions = {}) {
    const env: Record<string, string | undefined> =
      typeof process !== 'undefined' && process.env ? process.env : {};

    const apiKey = options.apiKey ?? env.ANNOUNCER_API_KEY;
    if (!apiKey) {
      throw new Error(
        'No Announcer API key. Pass one to the constructor — new Announcer("ann_...") — ' +
          'or set the ANNOUNCER_API_KEY environment variable.',
      );
    }
    this.apiKey = apiKey;

    const baseUrl = options.baseUrl ?? env.ANNOUNCER_BASE_URL ?? DEFAULT_BASE_URL;
    this.baseUrl = baseUrl.replace(/\/+$/, '');

    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.extraHeaders = options.headers ?? {};

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error(
        'No global fetch available. Use Node 18 or newer, or pass a fetch implementation ' +
          'via the `fetch` option.',
      );
    }
    // Bound so undici's fetch keeps its `this` when called off the instance.
    this.fetchImpl = fetchImpl.bind(globalThis);

    this.userAgent = options.userAgent
      ? `announcer-node/${SDK_VERSION} ${options.userAgent}`
      : `announcer-node/${SDK_VERSION}`;
  }

  private url(path: string, query?: RequestOptions['query']): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Runs one request, retrying transient failures, and returns the parsed body. */
  async request<T>(options: RequestOptions): Promise<T> {
    const url = this.url(options.path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      ...this.extraHeaders,
      ...options.headers,
    };
    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    let lastError: AnnouncerError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // A fresh controller per attempt: an aborted signal cannot be reused.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      const onExternalAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onExternalAbort, { once: true });

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: options.method,
          headers,
          body: payload,
          signal: controller.signal,
        });
      } catch (cause) {
        // The caller cancelling is not a transient failure; surface it as-is.
        if (options.signal?.aborted) throw cause;
        lastError = new ConnectionError(
          `Could not reach the Announcer API at ${this.baseUrl}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        );
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onExternalAbort);
      }

      if (response.ok) return (await this.parse(response)) as T;

      const body = (await this.parseErrorBody(response)) as ProblemBody | undefined;
      lastError = errorFromResponse(response.status, body, response.headers, {
        path: options.path,
        recipient: options.errorContext?.recipient,
      });

      if (
        isRetryableStatus(response.status, options.retryOn409 === true) &&
        attempt < this.maxRetries
      ) {
        // The server's own Retry-After beats our guess — it knows when the
        // per-tenant window actually rolls.
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 60_000)
          : backoffMs(attempt);
        await sleep(delay);
        continue;
      }
      throw lastError;
    }

    /* c8 ignore next */
    throw lastError ?? new ConnectionError('Request failed for an unknown reason.');
  }

  /** 204s and empty bodies become null; everything else is camelized JSON. */
  private async parse(response: Response): Promise<unknown> {
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    return camelize(JSON.parse(text));
  }

  /**
   * Error bodies are parsed but never camelized: `errors` is keyed by real
   * field names (`from`, `Idempotency-Key`) that must survive verbatim. Several
   * 404 handlers send no body at all, which is why this tolerates junk.
   */
  private async parseErrorBody(response: Response): Promise<unknown> {
    try {
      const text = await response.text();
      if (!text) return undefined;
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
}

/**
 * The API answers errors in four different shapes. Every one of them has to
 * land on a useful exception here, or the SDK is just `fetch` with extra steps.
 *
 *   RFC 9457 problem+json   { type, title, status, detail }
 *   validation              { type, title, status, errors: { field: [msg] } }
 *   two 409 paths           { error: "..." }
 *   several 404 handlers    (no body at all)
 */

/** The raw JSON body of an error response, in any of the four shapes. */
export interface ProblemBody {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  errors?: Record<string, string[]>;
  error?: string;
}

export interface AnnouncerErrorInit {
  status: number;
  title?: string;
  detail?: string;
  requestId?: string;
  raw?: unknown;
}

/** Base class for everything this SDK throws. Catch this to catch them all. */
export class AnnouncerError extends Error {
  /** HTTP status, or 0 when the request never reached the API. */
  readonly status: number;
  /** The problem's `title`, when the API sent one. */
  readonly title?: string;
  /** The problem's `detail` — usually the most human-readable part. */
  readonly detail?: string;
  /** Value of the response's `x-request-id`, when present. Quote this in support. */
  readonly requestId?: string;
  /** The parsed error body, exactly as the API sent it. */
  readonly raw?: unknown;

  constructor(message: string, init: AnnouncerErrorInit) {
    super(message);
    this.name = new.target.name;
    this.status = init.status;
    this.title = init.title;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.raw = init.raw;
    // Restores the prototype chain under `target: ES5`-style downlevelling, so
    // `err instanceof RateLimitError` keeps working for consumers on old configs.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 — the key is missing, malformed, or revoked. */
export class AuthenticationError extends AnnouncerError {}

/**
 * 403 — the key is valid but not allowed to do this. In practice one of:
 * a send-scoped key touching `/v1/domains` or `/v1/keys`; sending from a domain
 * this account has not registered; or sending from a registered-but-unverified
 * domain while the server requires verification.
 */
export class PermissionError extends AnnouncerError {}

/** 404 — no such resource, or it belongs to another account. */
export class NotFoundError extends AnnouncerError {}

/**
 * 409 — a domain is already registered, or a send with this Idempotency-Key is
 * still in flight. The in-flight case is retried automatically first; seeing
 * this means the retry budget ran out while the original was still running.
 */
export class ConflictError extends AnnouncerError {}

/** 400 — one or more fields were rejected. See {@link ValidationError.errors}. */
export class ValidationError extends AnnouncerError {
  /** Field name to the messages explaining why it was rejected. */
  readonly errors: Record<string, string[]>;

  constructor(message: string, init: AnnouncerErrorInit & { errors?: Record<string, string[]> }) {
    super(message, init);
    this.errors = init.errors ?? {};
  }
}

/** 422 — the request was well-formed but cannot be carried out. */
export class UnprocessableError extends AnnouncerError {}

/**
 * 422 from `emails.send` — the recipient is on this account's suppression list
 * because they previously hard-bounced or complained. The attempt is still
 * recorded and still counts against quota; sending to them again requires
 * removing them from the list.
 */
export class SuppressedRecipientError extends UnprocessableError {
  /** The address that was refused. */
  readonly recipient?: string;

  constructor(message: string, init: AnnouncerErrorInit & { recipient?: string }) {
    super(message, init);
    this.recipient = init.recipient;
  }
}

/** 429 — a rate limit or a durable quota. Check {@link RateLimitError.retryAfter}. */
export class RateLimitError extends AnnouncerError {
  /** Seconds to wait, from the `Retry-After` header. */
  readonly retryAfter?: number;

  constructor(message: string, init: AnnouncerErrorInit & { retryAfter?: number }) {
    super(message, init);
    this.retryAfter = init.retryAfter;
  }
}

/** 5xx — the API failed. Retried automatically before you see this. */
export class ServerError extends AnnouncerError {}

/** The request never got an answer: DNS, TCP, TLS, or the client-side timeout. */
export class ConnectionError extends AnnouncerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { status: 0, raw: options?.cause });
    this.cause = options?.cause;
  }
}

/** A webhook's `X-Announcer-Signature` did not check out. Treat the delivery as hostile. */
export class SignatureVerificationError extends AnnouncerError {
  constructor(message: string) {
    super(message, { status: 0 });
  }
}

/** Fallback wording when the API sends a status with no usable body — the 404s. */
const GENERIC: Record<number, string> = {
  400: 'The request was rejected as invalid.',
  401: 'Invalid or revoked API key.',
  403: 'This API key is not permitted to perform that action.',
  404: 'Not found.',
  409: 'Conflict.',
  422: 'The request could not be processed.',
  429: 'Rate limit exceeded.',
};

/**
 * Picks the most useful sentence out of whichever error shape arrived.
 * Order matters: `detail` is written for humans, `errors` is specific about
 * which field is wrong, and `title` is generic boilerplate that only helps
 * when nothing better exists.
 */
function messageFor(status: number, body: ProblemBody | undefined): string {
  if (body) {
    if (typeof body.detail === 'string' && body.detail) return body.detail;
    if (typeof body.error === 'string' && body.error) return body.error;
    if (body.errors) {
      const parts = Object.entries(body.errors).map(
        ([field, messages]) => `${field}: ${(messages ?? []).join(' ')}`,
      );
      if (parts.length) return parts.join('; ');
    }
    if (typeof body.title === 'string' && body.title) return body.title;
  }
  return GENERIC[status] ?? `Announcer API returned HTTP ${status}.`;
}

/** Reads `Retry-After`, which the API sends as a whole number of seconds. */
function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Maps an unsuccessful response onto the right exception subclass. */
export function errorFromResponse(
  status: number,
  body: ProblemBody | undefined,
  headers: Headers,
  context?: { path?: string; recipient?: string },
): AnnouncerError {
  const message = messageFor(status, body);
  const init: AnnouncerErrorInit = {
    status,
    title: body?.title,
    detail: body?.detail,
    requestId: headers.get('x-request-id') ?? undefined,
    raw: body,
  };

  switch (status) {
    case 400:
      return new ValidationError(message, { ...init, errors: body?.errors });
    case 401:
      return new AuthenticationError(message, init);
    case 403:
      return new PermissionError(message, init);
    case 404:
      return new NotFoundError(message, init);
    case 409:
      return new ConflictError(message, init);
    case 422:
      // Only the send path can produce a suppression refusal, and its detail
      // always names the address. Anything else 422 is a plain unprocessable.
      if (context?.path === '/v1/emails') {
        return new SuppressedRecipientError(message, { ...init, recipient: context.recipient });
      }
      return new UnprocessableError(message, init);
    case 429:
      return new RateLimitError(message, { ...init, retryAfter: parseRetryAfter(headers) });
    default:
      if (status >= 500) return new ServerError(message, init);
      return new AnnouncerError(message, init);
  }
}

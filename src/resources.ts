import { randomUUID } from 'node:crypto';

import { AnnouncerError } from './errors.js';
import type { HttpClient } from './http.js';
import type {
  ApiKey,
  CreatedApiKey,
  CreatedDomain,
  CreatedWebhookEndpoint,
  Domain,
  DomainDns,
  KeyScope,
  ListMessagesQuery,
  Message,
  MessageEvent,
  SendEmailOptions,
  SentEmail,
  Suppression,
  Usage,
  WebhookEndpoint,
  WebhookEvent,
} from './types.js';
import { verifyWebhook, type VerifyOptions } from './webhook-signature.js';

/** Shapes as they leave the transport: camelized, but not yet reshaped. */
interface RawMessage {
  id: string;
  messageId: string | null;
  headerFrom: string;
  recipient: string;
  recipientCount: number;
  replyTo: string | null;
  subject: string | null;
  status: Message['status'];
  createdAt: string;
}

function toMessage(raw: RawMessage): Message {
  // `headerFrom`/`recipient` are the database's names for these. The webhook
  // payload already calls them `from`/`to`; one vocabulary is worth the mapping.
  return {
    id: raw.id,
    messageId: raw.messageId ?? null,
    from: raw.headerFrom,
    to: raw.recipient,
    recipientCount: raw.recipientCount ?? 1,
    replyTo: raw.replyTo ?? null,
    subject: raw.subject ?? null,
    status: raw.status,
    createdAt: raw.createdAt,
  };
}

/** The first address of a list, for error reporting. */
function firstAddress(list: string | string[]): string | undefined {
  return Array.isArray(list) ? list[0] : list;
}

export class Emails {
  constructor(private readonly http: HttpClient) {}

  /**
   * Sends one email.
   *
   * ```ts
   * await announcer.emails.send({
   *   from: 'Acme <billing@acme.com>',
   *   to: 'customer@example.com',
   *   subject: 'Your receipt',
   *   text: 'Thanks!',
   * });
   * ```
   *
   * `to`, `cc` and `bcc` each take one address or several. Everything in `to`
   * and `cc` is one email whose recipients see each other; `bcc` recipients see
   * nobody. At most 50 addresses across the three.
   *
   * ```ts
   * await announcer.emails.send({
   *   from: 'billing@acme.com',
   *   to: ['customer@example.com', 'partner@example.com'],
   *   cc: 'accounting@acme.com',
   *   replyTo: 'support@acme.com',
   *   subject: 'Your receipt',
   *   text: 'Thanks!',
   * });
   * ```
   *
   * An `Idempotency-Key` is generated when you do not supply one, so the SDK's
   * automatic retries can never send twice. Supply your own — an order id, a job
   * id — to extend that guarantee across process restarts.
   *
   * A recipient on your suppression list is dropped and reported in
   * {@link SentEmail.suppressed}; the rest of the message still goes out. Only
   * when every recipient is suppressed does this throw.
   *
   * @throws {PermissionError} the `from` domain is not registered, or not verified.
   * @throws {SuppressedRecipientError} every recipient previously bounced or complained.
   * @throws {RateLimitError} a per-second limit or a daily/monthly quota. Note
   * that quota counts recipients, so one call can consume several.
   */
  async send(options: SendEmailOptions): Promise<SentEmail> {
    if (!options.text && !options.html) {
      throw new TypeError('Provide `text`, `html`, or both — an email needs a body.');
    }
    if (Array.isArray(options.to) && options.to.length === 0) {
      throw new TypeError('Provide at least one `to` recipient.');
    }

    const idempotencyKey = options.idempotencyKey ?? randomUUID();

    const raw = await this.http.request<{
      id: string;
      messageId: string | null;
      status: SentEmail['status'];
      idempotentReplay?: boolean;
      recipients?: number;
      suppressed?: string[];
    }>({
      method: 'POST',
      path: '/v1/emails',
      body: {
        from: options.from,
        to: options.to,
        cc: options.cc,
        bcc: options.bcc,
        // The API accepts `replyTo` too, but its documented request shape is
        // snake_case; send the spelling the docs show.
        reply_to: options.replyTo,
        subject: options.subject,
        text: options.text,
        html: options.html,
      },
      headers: { 'Idempotency-Key': idempotencyKey },
      // Carrying a key makes a 409 mean "the original is still in flight", so
      // waiting and asking again is right. Without one it would be a real conflict.
      retryOn409: true,
      errorContext: { recipient: firstAddress(options.to) },
    });

    return {
      id: raw.id,
      messageId: raw.messageId ?? null,
      status: raw.status,
      idempotentReplay: raw.idempotentReplay === true,
      // Older deployments predate both fields; a successful send is at least
      // one recipient and dropped nobody.
      recipients: raw.recipients ?? 1,
      suppressed: raw.suppressed ?? [],
    };
  }

  /**
   * Sends the same message to several recipients as **separate emails**, one
   * API call each, and returns a result per recipient. One failure does not
   * stop the rest unless you pass `stopOnError`.
   *
   * This is not the same as passing an array to {@link Emails.send}:
   *
   * - `send({ to: [a, b] })` is one email. A and B see each other in the `To:`
   *   header, it costs one request, and one bounce marks one message.
   * - `sendMany([a, b], …)` is two emails. Neither knows the other exists, each
   *   gets its own idempotency key and its own bounce, and one failure leaves
   *   the other untouched.
   *
   * Use this one for anything list-shaped — a newsletter, a digest, a
   * notification fan-out. Use `send` with an array when the recipients are
   * genuinely on the same thread.
   */
  async sendMany(
    recipients: readonly string[],
    message: Omit<SendEmailOptions, 'to'>,
    options: { stopOnError?: boolean } = {},
  ): Promise<BatchSendResult[]> {
    const results: BatchSendResult[] = [];

    for (const [index, to] of recipients.entries()) {
      // Derived rather than shared: one key across the batch would make every
      // recipient after the first an idempotent replay of the first.
      const idempotencyKey = message.idempotencyKey
        ? `${message.idempotencyKey}-${index}`
        : undefined;
      try {
        const result = await this.send({ ...message, to, idempotencyKey });
        results.push({ to, ok: true, result });
      } catch (error) {
        if (!(error instanceof AnnouncerError)) throw error;
        results.push({ to, ok: false, error });
        if (options.stopOnError) break;
      }
    }
    return results;
  }

  /** Send history, newest first. Filter by status or by a substring of the recipient. */
  async list(query: ListMessagesQuery = {}): Promise<Message[]> {
    const raw = await this.http.request<RawMessage[]>({
      method: 'GET',
      path: '/v1/messages',
      query: { limit: query.limit, status: query.status, search: query.search },
    });
    return raw.map(toMessage);
  }

  /** The audit trail for one message: every status transition, oldest first. */
  async events(messageId: string): Promise<MessageEvent[]> {
    return this.http.request<MessageEvent[]>({
      method: 'GET',
      path: `/v1/messages/${encodeURIComponent(messageId)}/events`,
    });
  }
}

/** One recipient's outcome from `emails.sendMany`. */
export interface BatchSendResult {
  to: string;
  ok: boolean;
  /** Present when `ok`. */
  result?: SentEmail;
  /** Present when not `ok`. */
  error?: AnnouncerError;
}

export class Domains {
  constructor(private readonly http: HttpClient) {}

  /**
   * Registers a sending domain and returns the DNS record to publish.
   *
   * Registration generates an RSA keypair, so it is rate-limited hard — roughly
   * one a minute. Publish every record in `dns`, then call {@link verify}.
   */
  async create(domain: string): Promise<CreatedDomain> {
    return this.http.request<CreatedDomain>({
      method: 'POST',
      path: '/v1/domains',
      body: { domain },
    });
  }

  /** Every domain on the account, newest first. */
  async list(): Promise<Domain[]> {
    const raw = await this.http.request<Omit<Domain, 'verified'>[]>({
      method: 'GET',
      path: '/v1/domains',
    });
    return raw.map((row) => ({ ...row, verified: row.verifiedAt !== null }));
  }

  /**
   * The records for a domain, re-derived from the stored public key — so
   * "what was I supposed to publish?" is answerable after registration.
   */
  async dns(id: string): Promise<DomainDns> {
    return this.http.request<DomainDns>({
      method: 'GET',
      path: `/v1/domains/${encodeURIComponent(id)}/dns`,
    });
  }

  /**
   * Resolves the DKIM record and compares it to the key we issued. This is a
   * real DNS lookup, not a self-report: it only succeeds on an actual match.
   *
   * @throws {UnprocessableError} the record is missing or does not match. DNS
   * propagation takes minutes to hours — retry rather than re-registering.
   */
  async verify(id: string): Promise<{ id: string; verified: boolean }> {
    return this.http.request<{ id: string; verified: boolean }>({
      method: 'POST',
      path: `/v1/domains/${encodeURIComponent(id)}/verify`,
    });
  }

  /**
   * Removes the domain and its signing key. Send history survives; sending from
   * the domain stops immediately.
   */
  async delete(id: string): Promise<void> {
    await this.http.request<null>({
      method: 'DELETE',
      path: `/v1/domains/${encodeURIComponent(id)}`,
    });
  }
}

export class ApiKeys {
  constructor(private readonly http: HttpClient) {}

  /**
   * Issues a key. The secret is in the response and nowhere else — the API
   * stores only its hash.
   *
   * Prefer `'send'` for anything that only sends mail: a leaked send key cannot
   * register domains, mint more keys, or reach billing.
   */
  async create(name: string, scope: KeyScope = 'full'): Promise<CreatedApiKey> {
    return this.http.request<CreatedApiKey>({
      method: 'POST',
      path: '/v1/keys',
      body: { name, scope },
    });
  }

  /** Every key on the account. Secrets are never included. */
  async list(): Promise<ApiKey[]> {
    const raw = await this.http.request<Omit<ApiKey, 'revoked'>[]>({
      method: 'GET',
      path: '/v1/keys',
    });
    return raw.map((row) => ({ ...row, revoked: row.revokedAt !== null }));
  }

  /** Revokes a key. The row stays, so `lastUsedAt` remains auditable. */
  async revoke(id: string): Promise<void> {
    await this.http.request<null>({
      method: 'DELETE',
      path: `/v1/keys/${encodeURIComponent(id)}`,
    });
  }
}

export class Webhooks {
  constructor(private readonly http: HttpClient) {}

  /**
   * Registers an endpoint. Maximum two active per account.
   *
   * The returned `secret` crosses the wire exactly once — store it now and pass
   * it to {@link verify} on every delivery.
   */
  async create(url: string): Promise<CreatedWebhookEndpoint> {
    return this.http.request<CreatedWebhookEndpoint>({
      method: 'POST',
      path: '/v1/webhooks',
      body: { url },
    });
  }

  /** Every endpoint on the account, including disabled ones. */
  async list(): Promise<WebhookEndpoint[]> {
    const raw = await this.http.request<Omit<WebhookEndpoint, 'disabled'>[]>({
      method: 'GET',
      path: '/v1/webhooks',
    });
    return raw.map((row) => ({ ...row, disabled: row.disabledAt !== null }));
  }

  /** Disables an endpoint. Pending deliveries stop; history stays auditable. */
  async delete(id: string): Promise<void> {
    await this.http.request<null>({
      method: 'DELETE',
      path: `/v1/webhooks/${encodeURIComponent(id)}`,
    });
  }

  /**
   * Verifies a delivery's signature and returns the parsed event. Pass the raw
   * request body, not a re-serialised object.
   *
   * ```ts
   * app.post('/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
   *   const event = announcer.webhooks.verify(
   *     req.body,
   *     req.header('X-Announcer-Signature'),
   *     process.env.ANNOUNCER_WEBHOOK_SECRET!,
   *   );
   *   res.sendStatus(200);
   * });
   * ```
   *
   * @throws {SignatureVerificationError} on a bad, missing, or stale signature.
   */
  verify(
    rawBody: string | Buffer | Uint8Array,
    signatureHeader: string | null | undefined,
    secret: string,
    options?: VerifyOptions,
  ): WebhookEvent {
    return verifyWebhook(rawBody, signatureHeader, secret, options);
  }
}

export class Suppressions {
  constructor(private readonly http: HttpClient) {}

  /**
   * Addresses Announcer refuses to send to, newest first. Entries are added
   * automatically on a hard bounce or a complaint.
   */
  async list(query: { limit?: number } = {}): Promise<Suppression[]> {
    return this.http.request<Suppression[]>({
      method: 'GET',
      path: '/v1/suppressions',
      query: { limit: query.limit },
    });
  }
}

/** Re-exported so callers can type the usage response without reaching into `types`. */
export type { Usage };

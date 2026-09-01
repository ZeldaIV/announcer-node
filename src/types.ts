/** Where a message currently sits. `failed` and `bounced` are terminal. */
export type MessageStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'suppressed';

/** The transitions that produce a webhook delivery and a `message_events` row. */
export type EventType = 'sent' | 'delivered' | 'bounced' | 'complained' | 'suppressed';

/**
 * What an API key may do. Give integrations `send`: a leaked send key cannot
 * register domains, mint successor keys, or touch billing.
 */
export type KeyScope = 'full' | 'send';

/**
 * An email to send.
 *
 * `from` and `to` accept either a bare address (`billing@acme.com`) or a
 * display name (`Acme Billing <billing@acme.com>`). At least one of `text` or
 * `html` is required.
 */
export interface SendEmailOptions {
  /** Sender. Its domain must be registered to this account. */
  from: string;
  /** The single recipient. For several, use `emails.sendMany`. */
  to: string;
  subject?: string;
  /** Plain-text body. Supply this even alongside `html` — filters like seeing both. */
  text?: string;
  /** HTML body. */
  html?: string;
  /**
   * Makes the send exactly-once. Left unset, the SDK generates one per call so
   * its own retries cannot double-send; set it yourself to keep that guarantee
   * across process restarts (e.g. a job id).
   */
  idempotencyKey?: string;
}

/** The result of a successful send. */
export interface SentEmail {
  /** Announcer's id for the message. Use it with `emails.events`. */
  id: string;
  /** The RFC 5322 `Message-ID` the MTA assigned. */
  messageId: string | null;
  status: MessageStatus;
  /**
   * True when this Idempotency-Key had already been used: nothing was sent
   * a second time and these are the original send's details.
   */
  idempotentReplay: boolean;
}

/** One row of send history. */
export interface Message {
  id: string;
  /** RFC 5322 `Message-ID`, absent for messages that never reached the MTA. */
  messageId: string | null;
  /** The `From:` header that went out. */
  from: string;
  /** The recipient. */
  to: string;
  subject: string | null;
  status: MessageStatus;
  createdAt: string;
}

export interface ListMessagesQuery {
  /** 1-200, default 50. */
  limit?: number;
  status?: MessageStatus;
  /** Substring match on the recipient address. */
  search?: string;
}

/** One entry in a message's audit trail. */
export interface MessageEvent {
  id: number;
  event: EventType;
  /** Event-specific data, passed through exactly as the API sent it. */
  payload: Record<string, unknown>;
  createdAt: string;
}

/** A DNS record the domain owner has to publish. */
export interface DnsRecord {
  type: 'TXT';
  /** The record name, e.g. `mail._domainkey.acme.com`. */
  name: string;
  /** The record value, e.g. `v=DKIM1; k=rsa; p=MIIBIjANBg...`. */
  value: string;
  /** Why this record exists, in a sentence you can show a user. */
  purpose: string;
}

/** A sending domain. */
export interface Domain {
  id: string;
  domain: string;
  /** The DKIM selector. Always `mail`; the API ignores client-supplied selectors. */
  selector: string;
  /** Whether the DKIM record has been seen in DNS and matched. */
  verified: boolean;
  /** When verification first succeeded, or null. */
  verifiedAt: string | null;
  createdAt: string;
}

/** A freshly registered domain, including the record to publish. */
export interface CreatedDomain {
  id: string;
  domain: string;
  selector: string;
  verified: boolean;
  /** Publish every record here, then call `domains.verify(id)`. */
  dns: DnsRecord[];
}

/** The records for an existing domain, re-derived from the stored public key. */
export interface DomainDns {
  id: string;
  domain: string;
  verified: boolean;
  dns: DnsRecord[];
}

/** An API key, minus the secret. */
export interface ApiKey {
  id: string;
  name: string;
  /** The first few characters of the key, for telling keys apart in a list. */
  prefix: string;
  scope: KeyScope;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Convenience for `revokedAt !== null`. */
  revoked: boolean;
}

/** A newly minted key. `key` is shown this once and never again — store it now. */
export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  scope: KeyScope;
  /** The full secret. Only ever present here. */
  key: string;
}

/** A registered webhook endpoint. */
export interface WebhookEndpoint {
  id: string;
  url: string;
  createdAt: string;
  disabledAt: string | null;
  /** Convenience for `disabledAt !== null`. */
  disabled: boolean;
}

/** A newly registered endpoint. `secret` is shown this once — store it now. */
export interface CreatedWebhookEndpoint {
  id: string;
  url: string;
  /** The `whsec_...` secret to pass to `webhooks.verify`. */
  secret: string;
}

/** A suppressed address. Announcer refuses to send to these. */
export interface Suppression {
  id: string;
  email: string;
  /** Why it was suppressed, e.g. `hard bounce (5.1.1 ...)`. */
  reason: string;
  createdAt: string;
}

/** One day of the 14-day sending series. */
export interface UsagePoint {
  /** `YYYY-MM-DD`. */
  date: string;
  sent: number;
  delivered: number;
  /** Bounced + complained + failed. A subset of `sent`, not additional to it. */
  failed: number;
}

/** Consumption against this account's limits. */
export interface Usage {
  sentToday: number;
  dailySendLimit: number;
  domains: number;
  maxDomains: number;
  plan: string;
  sentThisPeriod: number;
  periodStart: string;
  /** Null on plans with no monthly accounting. */
  monthlyIncludedMessages: number | null;
  /** The spend ceiling. Null when uncapped. */
  monthlyHardCap: number | null;
  /** What the current period's overage would cost, in minor units. */
  overageMinorUnits: number | null;
  /** The last 14 days, oldest first. Days with no sends are present as zeroes. */
  series: UsagePoint[];
}

/** The message summary carried on a webhook delivery. */
export interface WebhookEventMessage {
  id: string;
  from: string;
  to: string;
  subject: string | null;
  status: MessageStatus;
}

/** A verified webhook delivery. */
export interface WebhookEvent {
  event: EventType;
  occurredAt: string;
  message: WebhookEventMessage;
  /** Event-specific data, e.g. `{ dsnStatus: "5.1.1 ..." }` on a bounce. */
  detail: Record<string, unknown>;
}

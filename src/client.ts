import { HttpClient, type AnnouncerOptions } from './http.js';
import { ApiKeys, Domains, Emails, Suppressions, Webhooks } from './resources.js';
import type { SendEmailOptions, SentEmail, Usage } from './types.js';

/**
 * The Announcer client.
 *
 * ```ts
 * import { Announcer } from 'announcer-sdk';
 *
 * const announcer = new Announcer(process.env.ANNOUNCER_API_KEY);
 *
 * await announcer.send({
 *   from: 'Acme <billing@acme.com>',
 *   to: 'customer@example.com',
 *   subject: 'Your receipt',
 *   text: 'Thanks for your order.',
 * });
 * ```
 *
 * Reuse one instance for the life of your process; it holds no per-request state.
 */
export class Announcer {
  /** Sending mail and reading send history. Works with either key scope. */
  readonly emails: Emails;
  /** Registering and verifying sending domains. Needs a `full`-scoped key. */
  readonly domains: Domains;
  /** Issuing and revoking API keys. Needs a `full`-scoped key. */
  readonly apiKeys: ApiKeys;
  /** Webhook endpoints, and verifying their deliveries. Needs a `full`-scoped key. */
  readonly webhooks: Webhooks;
  /** Addresses that hard-bounced or complained. Works with either key scope. */
  readonly suppressions: Suppressions;

  private readonly http: HttpClient;

  /**
   * @param apiKey Your `ann_...` key. Falls back to `ANNOUNCER_API_KEY`.
   * @param options Base URL, timeout, retries, custom fetch.
   */
  constructor(apiKey?: string | AnnouncerOptions, options: AnnouncerOptions = {}) {
    // Accepts either `new Announcer('ann_...')` or `new Announcer({ apiKey })`,
    // because both are the first thing people try.
    const resolved: AnnouncerOptions =
      typeof apiKey === 'string' ? { ...options, apiKey } : { ...options, ...(apiKey ?? {}) };

    this.http = new HttpClient(resolved);
    this.emails = new Emails(this.http);
    this.domains = new Domains(this.http);
    this.apiKeys = new ApiKeys(this.http);
    this.webhooks = new Webhooks(this.http);
    this.suppressions = new Suppressions(this.http);
  }

  /** The API root this client talks to. */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /** Shorthand for {@link Emails.send}. The one call most integrations ever make. */
  send(options: SendEmailOptions): Promise<SentEmail> {
    return this.emails.send(options);
  }

  /** Consumption against this account's limits, plus a 14-day sending series. */
  usage(): Promise<Usage> {
    return this.http.request<Usage>({ method: 'GET', path: '/v1/usage' });
  }
}

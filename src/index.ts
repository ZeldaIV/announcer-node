export { Announcer } from './client.js';
export { DEFAULT_BASE_URL, type AnnouncerOptions } from './http.js';

export {
  ApiKeys,
  Domains,
  Emails,
  Suppressions,
  Webhooks,
  type BatchSendResult,
} from './resources.js';

export {
  verifyWebhook,
  DEFAULT_TOLERANCE_SECONDS,
  type VerifyOptions,
} from './webhook-signature.js';

export {
  AnnouncerError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  SignatureVerificationError,
  SuppressedRecipientError,
  UnprocessableError,
  ValidationError,
  type ProblemBody,
} from './errors.js';

export type {
  ApiKey,
  CreatedApiKey,
  CreatedDomain,
  CreatedWebhookEndpoint,
  DnsRecord,
  Domain,
  DomainDns,
  EventType,
  KeyScope,
  ListMessagesQuery,
  Message,
  MessageEvent,
  MessageStatus,
  SendEmailOptions,
  SentEmail,
  Suppression,
  Usage,
  UsagePoint,
  WebhookEndpoint,
  WebhookEvent,
  WebhookEventMessage,
} from './types.js';

export { Announcer as default } from './client.js';

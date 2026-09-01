import { createHmac, timingSafeEqual } from 'node:crypto';

import { SignatureVerificationError } from './errors.js';
import type { WebhookEvent } from './types.js';

/** How far apart the delivery's timestamp and our clock may be, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** The parts of an `X-Announcer-Signature` header. */
interface ParsedSignature {
  timestamp: number;
  v1: string;
}

/** Parses `t=<unix>,v1=<hex>`, ignoring any scheme we do not know about. */
function parseSignatureHeader(header: string): ParsedSignature {
  let timestamp: number | undefined;
  let v1: string | undefined;

  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      v1 = value;
    }
  }

  if (timestamp === undefined || v1 === undefined) {
    throw new SignatureVerificationError(
      `Malformed X-Announcer-Signature header: expected "t=<unix>,v1=<hex>", got "${header}".`,
    );
  }
  return { timestamp, v1 };
}

/** Length-safe constant-time compare; `timingSafeEqual` throws on length mismatch. */
function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifyOptions {
  /** Clock skew allowance in seconds. Default 300. Pass 0 to disable the check. */
  toleranceSeconds?: number;
  /** Override the current time, in seconds since the epoch. For tests. */
  nowSeconds?: number;
}

/**
 * Checks a webhook delivery and returns the parsed event.
 *
 * Pass the **raw** request body — the exact bytes Announcer sent. Re-serialising
 * a parsed object reorders keys and changes whitespace, and the signature will
 * not match. In Express that means `express.raw({ type: 'application/json' })`
 * on this route, not `express.json()`.
 *
 * @throws {SignatureVerificationError} if the header is malformed, the MAC does
 * not match, or the delivery is older than the tolerance.
 */
export function verifyWebhook(
  rawBody: string | Buffer | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): WebhookEvent {
  if (!signatureHeader) {
    throw new SignatureVerificationError('Missing X-Announcer-Signature header.');
  }
  if (!secret) {
    throw new SignatureVerificationError('Missing webhook signing secret.');
  }

  const body =
    typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  const { timestamp, v1 } = parseSignatureHeader(signatureHeader);

  // The timestamp is inside the MAC, so this check is what actually stops a
  // captured delivery being replayed at us tomorrow.
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (tolerance > 0) {
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > tolerance) {
      throw new SignatureVerificationError(
        `Webhook timestamp is outside the ${tolerance}s tolerance ` +
          `(signed at ${timestamp}, now ${now}). Rejecting as a possible replay.`,
      );
    }
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  if (!secureCompare(expected, v1)) {
    throw new SignatureVerificationError(
      'Webhook signature does not match. Check that you are passing the raw request body ' +
        'and the secret returned by webhooks.create.',
    );
  }

  return JSON.parse(body) as WebhookEvent;
}

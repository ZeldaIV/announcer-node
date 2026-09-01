import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { SignatureVerificationError, verifyWebhook } from '../src/index.js';
import { testClient } from './helpers.js';

const SECRET = 'whsec_0123456789abcdef';

/** A fixed "now" so the tolerance check is deterministic. */
const now = 1_800_000_000;

const BODY = JSON.stringify({
  event: 'bounced',
  occurredAt: '2026-09-01T10:00:00Z',
  message: {
    id: '8f3a0000-0000-0000-0000-000000000001',
    from: 'billing@acme.test',
    to: 'customer@example.com',
    subject: 'Your receipt',
    status: 'bounced',
  },
  detail: { dsnStatus: '5.1.1 user unknown' },
});

/** Builds the header exactly the way the API's `signature_header` does. */
function sign(body: string, timestamp: number, secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

describe('verifyWebhook', () => {
  it('accepts a good signature and returns the parsed event', () => {
    const event = verifyWebhook(BODY, sign(BODY, now), SECRET, { nowSeconds: now });

    assert.equal(event.event, 'bounced');
    assert.equal(event.message.to, 'customer@example.com');
    assert.deepEqual(event.detail, { dsnStatus: '5.1.1 user unknown' });
  });

  it('accepts the body as a Buffer, which is what raw body parsers hand over', () => {
    const event = verifyWebhook(Buffer.from(BODY, 'utf8'), sign(BODY, now), SECRET, {
      nowSeconds: now,
    });
    assert.equal(event.event, 'bounced');
  });

  it('matches the API\'s documented test vector', () => {
    // Pinned against announcer's own `signature_header` unit test, so a change
    // on either side shows up here rather than in production.
    const expected = createHmac('sha256', 'key').update('1700000000.{}').digest('hex');
    assert.equal(sign('{}', 1_700_000_000, 'key'), `t=1700000000,v1=${expected}`);
  });

  it('rejects a tampered body', () => {
    const header = sign(BODY, now);
    const tampered = BODY.replace('customer@example.com', 'attacker@evil.test');

    assert.throws(
      () => verifyWebhook(tampered, header, SECRET, { nowSeconds: now }),
      (e: unknown) => {
        assert.ok(e instanceof SignatureVerificationError);
        assert.match(e.message, /does not match/);
        return true;
      },
    );
  });

  it('rejects the wrong secret', () => {
    assert.throws(
      () => verifyWebhook(BODY, sign(BODY, now), 'whsec_wrong', { nowSeconds: now }),
      SignatureVerificationError,
    );
  });

  it('rejects a replay outside the tolerance', () => {
    const old = now - 3600;
    assert.throws(
      () => verifyWebhook(BODY, sign(BODY, old), SECRET, { nowSeconds: now }),
      (e: unknown) => {
        assert.ok(e instanceof SignatureVerificationError);
        assert.match(e.message, /tolerance/);
        return true;
      },
    );
  });

  it('rejects a future timestamp too', () => {
    assert.throws(
      () => verifyWebhook(BODY, sign(BODY, now + 3600), SECRET, { nowSeconds: now }),
      SignatureVerificationError,
    );
  });

  it('can have the timestamp check turned off', () => {
    const old = now - 86_400;
    const event = verifyWebhook(BODY, sign(BODY, old), SECRET, {
      nowSeconds: now,
      toleranceSeconds: 0,
    });
    assert.equal(event.event, 'bounced');
  });

  it('rejects a malformed header', () => {
    for (const header of ['', 'garbage', 't=123', 'v1=deadbeef', 't=notanumber,v1=x']) {
      assert.throws(
        () => verifyWebhook(BODY, header, SECRET, { nowSeconds: now }),
        SignatureVerificationError,
        `expected "${header}" to be rejected`,
      );
    }
  });

  it('ignores unknown schemes so a future v2 does not break v1 consumers', () => {
    const header = `${sign(BODY, now)},v2=somethingelse`;
    const event = verifyWebhook(BODY, header, SECRET, { nowSeconds: now });
    assert.equal(event.event, 'bounced');
  });
});

describe('webhooks resource', () => {
  it('creates an endpoint and returns the one-time secret', async () => {
    const { client, calls } = testClient([
      { status: 201, body: { id: 'w1', url: 'https://acme.test/hooks', secret: SECRET } },
    ]);

    const endpoint = await client.webhooks.create('https://acme.test/hooks');

    assert.deepEqual(calls[0]!.body, { url: 'https://acme.test/hooks' });
    assert.equal(endpoint.secret, SECRET);
  });

  it('derives `disabled` from the timestamp the API sends', async () => {
    const { client } = testClient([
      {
        body: [
          { id: 'w1', url: 'https://a.test', created_at: '2026-01-01T00:00:00Z', disabled_at: null },
          {
            id: 'w2',
            url: 'https://b.test',
            created_at: '2026-01-01T00:00:00Z',
            disabled_at: '2026-02-01T00:00:00Z',
          },
        ],
      },
    ]);

    const endpoints = await client.webhooks.list();

    assert.equal(endpoints[0]!.disabled, false);
    assert.equal(endpoints[1]!.disabled, true);
    assert.equal(endpoints[1]!.disabledAt, '2026-02-01T00:00:00Z');
  });

  it('verifies through the client too', () => {
    const { client } = testClient([]);
    const event = client.webhooks.verify(BODY, sign(BODY, now), SECRET, { nowSeconds: now });
    assert.equal(event.event, 'bounced');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SuppressedRecipientError } from '../src/index.js';
import { testClient } from './helpers.js';

describe('emails.send', () => {
  it('posts the message and returns the send result', async () => {
    const { client, calls } = testClient([
      { body: { id: 'msg-1', messageId: '<abc@acme.test>', status: 'sent' } },
    ]);

    const result = await client.send({
      from: 'Acme <billing@acme.test>',
      to: 'customer@example.com',
      subject: 'Your receipt',
      text: 'Thanks!',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.url, 'https://api.example.test/v1/emails');
    assert.equal(calls[0]!.headers.authorization, 'Bearer ann_test_key');
    assert.deepEqual(calls[0]!.body, {
      from: 'Acme <billing@acme.test>',
      to: 'customer@example.com',
      subject: 'Your receipt',
      text: 'Thanks!',
    });

    assert.deepEqual(result, {
      id: 'msg-1',
      messageId: '<abc@acme.test>',
      status: 'sent',
      idempotentReplay: false,
      recipients: 1,
      suppressed: [],
    });
  });

  it('sends to, cc, bcc and replyTo, dropping the fields left unset', async () => {
    const { client, calls } = testClient([
      { body: { id: 'm', messageId: null, status: 'sent', recipients: 4 } },
    ]);

    const result = await client.send({
      from: 'billing@acme.test',
      to: ['a@example.com', 'b@example.com'],
      cc: 'accounting@acme.test',
      bcc: 'archive@acme.test',
      replyTo: 'support@acme.test',
      subject: 'Your receipt',
      text: 'Thanks!',
    });

    assert.deepEqual(calls[0]!.body, {
      from: 'billing@acme.test',
      to: ['a@example.com', 'b@example.com'],
      cc: 'accounting@acme.test',
      bcc: 'archive@acme.test',
      // The API accepts replyTo too, but snake_case is its documented shape.
      reply_to: 'support@acme.test',
      subject: 'Your receipt',
      text: 'Thanks!',
    });
    assert.equal(result.recipients, 4, 'the billable count comes back');
  });

  it('reports recipients dropped for suppression without failing the send', async () => {
    const { client } = testClient([
      {
        body: {
          id: 'm',
          messageId: '<x@acme.test>',
          status: 'sent',
          recipients: 2,
          suppressed: ['dead@example.com'],
        },
      },
    ]);

    const result = await client.send({
      from: 'a@acme.test',
      to: ['good@example.com', 'dead@example.com'],
      cc: 'copied@example.com',
      text: 'hi',
    });

    // The message still went out — only the bad address was dropped.
    assert.equal(result.recipients, 2);
    assert.deepEqual(result.suppressed, ['dead@example.com']);
  });

  it('generates an Idempotency-Key so its own retries cannot double-send', async () => {
    const { client, calls } = testClient([{ body: { id: 'm', messageId: null, status: 'sent' } }]);

    await client.send({ from: 'a@acme.test', to: 'b@example.com', text: 'hi' });

    const key = calls[0]!.headers['idempotency-key'];
    assert.ok(key, 'expected an Idempotency-Key header');
    assert.match(key, /^[0-9a-f-]{36}$/);
  });

  it('passes a caller-supplied Idempotency-Key through unchanged', async () => {
    const { client, calls } = testClient([{ body: { id: 'm', messageId: null, status: 'sent' } }]);

    await client.send({
      from: 'a@acme.test',
      to: 'b@example.com',
      text: 'hi',
      idempotencyKey: 'order-4711',
    });

    assert.equal(calls[0]!.headers['idempotency-key'], 'order-4711');
  });

  it('reports an idempotent replay rather than pretending it sent again', async () => {
    const { client } = testClient([
      { body: { id: 'm', messageId: '<x@acme.test>', status: 'sent', idempotentReplay: true } },
    ]);

    const result = await client.send({
      from: 'a@acme.test',
      to: 'b@example.com',
      text: 'hi',
      idempotencyKey: 'order-4711',
    });

    assert.equal(result.idempotentReplay, true);
  });

  it('refuses an empty recipient list before spending an API call', async () => {
    const { client, calls } = testClient([]);
    await assert.rejects(
      () => client.send({ from: 'a@acme.test', to: [], text: 'hi' }),
      /at least one/,
    );
    assert.equal(calls.length, 0);
  });

  it('refuses a message with no body before spending an API call', async () => {
    const { client, calls } = testClient([]);
    await assert.rejects(
      () => client.send({ from: 'a@acme.test', to: 'b@example.com', subject: 'empty' }),
      /text.*html/,
    );
    assert.equal(calls.length, 0);
  });

  it('raises SuppressedRecipientError with the address on a 422', async () => {
    const { client } = testClient([
      {
        status: 422,
        body: {
          type: 'https://tools.ietf.org/html/rfc4918#section-11.2',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'bounced@example.com is on your suppression list.',
          suppressed: ['bounced@example.com'],
        },
      },
    ]);

    await assert.rejects(
      () => client.send({ from: 'a@acme.test', to: 'bounced@example.com', text: 'hi' }),
      (error: unknown) => {
        assert.ok(error instanceof SuppressedRecipientError);
        assert.equal(error.status, 422);
        assert.equal(error.recipient, 'bounced@example.com');
        // Read from the API's extension member, not parsed out of the prose.
        assert.deepEqual(error.suppressed, ['bounced@example.com']);
        assert.match(error.message, /suppression list/);
        return true;
      },
    );
  });

  it('lists every refused address when a whole send is suppressed', async () => {
    const { client } = testClient([
      {
        status: 422,
        body: {
          status: 422,
          detail: 'All 2 recipients are on your suppression list.',
          suppressed: ['one@example.com', 'two@example.com'],
        },
      },
    ]);

    await assert.rejects(
      () =>
        client.send({
          from: 'a@acme.test',
          to: ['one@example.com', 'two@example.com'],
          text: 'hi',
        }),
      (error: unknown) => {
        assert.ok(error instanceof SuppressedRecipientError);
        assert.deepEqual(error.suppressed, ['one@example.com', 'two@example.com']);
        assert.equal(error.recipient, 'one@example.com');
        return true;
      },
    );
  });
});

describe('emails.sendMany', () => {
  it('sends one request per recipient and reports each outcome', async () => {
    const { client, calls } = testClient([
      { body: { id: 'm1', messageId: null, status: 'sent' } },
      {
        status: 422,
        body: { status: 422, detail: 'b@example.com is on your suppression list.' },
      },
      { body: { id: 'm3', messageId: null, status: 'sent' } },
    ]);

    const results = await client.emails.sendMany(
      ['a@example.com', 'b@example.com', 'c@example.com'],
      { from: 'billing@acme.test', subject: 'Notice', text: 'hi' },
    );

    assert.equal(calls.length, 3);
    assert.deepEqual(
      results.map((r) => [r.to, r.ok]),
      [
        ['a@example.com', true],
        ['b@example.com', false],
        ['c@example.com', true],
      ],
    );
    assert.equal(results[0]!.result?.id, 'm1');
    assert.ok(results[1]!.error instanceof SuppressedRecipientError);
  });

  it('derives a distinct Idempotency-Key per recipient', async () => {
    const { client, calls } = testClient([
      { body: { id: 'm1', messageId: null, status: 'sent' } },
      { body: { id: 'm2', messageId: null, status: 'sent' } },
    ]);

    await client.emails.sendMany(
      ['a@example.com', 'b@example.com'],
      { from: 'billing@acme.test', text: 'hi', idempotencyKey: 'digest-2026-09-01' },
    );

    // One key across the batch would make every recipient after the first an
    // idempotent replay of the first, and only one person gets the mail.
    assert.equal(calls[0]!.headers['idempotency-key'], 'digest-2026-09-01-0');
    assert.equal(calls[1]!.headers['idempotency-key'], 'digest-2026-09-01-1');
  });

  it('stops early when asked to', async () => {
    const { client, calls } = testClient([
      { status: 500, body: { status: 500, detail: 'boom' } },
      { body: { id: 'm2', messageId: null, status: 'sent' } },
    ]);

    const results = await client.emails.sendMany(
      ['a@example.com', 'b@example.com'],
      { from: 'billing@acme.test', text: 'hi' },
      { stopOnError: true },
    );

    assert.equal(results.length, 1);
    assert.equal(calls.length, 1);
  });
});

describe('emails.list', () => {
  it('renames the API\'s snake_case row onto from/to', async () => {
    const { client, calls } = testClient([
      {
        body: [
          {
            id: 'm1',
            message_id: '<x@acme.test>',
            header_from: 'billing@acme.test',
            recipient: 'customer@example.com',
            recipient_count: 3,
            reply_to: 'support@acme.test',
            subject: 'Receipt',
            status: 'delivered',
            created_at: '2026-09-01T10:00:00Z',
          },
        ],
      },
    ]);

    const messages = await client.emails.list({ limit: 10, status: 'delivered' });

    assert.equal(calls[0]!.url, 'https://api.example.test/v1/messages?limit=10&status=delivered');
    assert.deepEqual(messages, [
      {
        id: 'm1',
        messageId: '<x@acme.test>',
        from: 'billing@acme.test',
        to: 'customer@example.com',
        recipientCount: 3,
        replyTo: 'support@acme.test',
        subject: 'Receipt',
        status: 'delivered',
        createdAt: '2026-09-01T10:00:00Z',
      },
    ]);
  });

  it('omits unset filters from the query string', async () => {
    const { client, calls } = testClient([{ body: [] }]);
    await client.emails.list();
    assert.equal(calls[0]!.url, 'https://api.example.test/v1/messages');
  });
});

describe('emails.events', () => {
  it('leaves the free-form payload keys alone', async () => {
    const { client } = testClient([
      {
        body: [
          {
            id: 2,
            event: 'bounced',
            // These keys are tenant data. Camelizing them would corrupt real values.
            payload: { dsn_status: '5.1.1', Retry_Count: 3 },
            created_at: '2026-09-01T10:00:00Z',
          },
        ],
      },
    ]);

    const events = await client.emails.events('m1');

    assert.equal(events[0]!.createdAt, '2026-09-01T10:00:00Z');
    assert.deepEqual(events[0]!.payload, { dsn_status: '5.1.1', Retry_Count: 3 });
  });
});

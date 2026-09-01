import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConflictError, ConnectionError, ValidationError } from '../src/index.js';
import { stubFetch, testClient } from './helpers.js';
import { Announcer } from '../src/index.js';

describe('retries', () => {
  it('retries a 500 and returns the eventual success', async () => {
    const { client, calls } = testClient(
      [
        { status: 500, body: { status: 500, detail: 'boom' } },
        { body: { id: 'm', messageId: null, status: 'sent' } },
      ],
      { maxRetries: 2 },
    );

    const result = await client.send({ from: 'a@acme.test', to: 'b@example.com', text: 'hi' });

    assert.equal(calls.length, 2);
    assert.equal(result.id, 'm');
  });

  it('reuses the same Idempotency-Key across retries', async () => {
    const { client, calls } = testClient(
      [
        { status: 500, body: { status: 500 } },
        { body: { id: 'm', messageId: null, status: 'sent' } },
      ],
      { maxRetries: 2 },
    );

    await client.send({ from: 'a@acme.test', to: 'b@example.com', text: 'hi' });

    // The whole point: the second attempt must be recognisable to the API as
    // the same operation, or a timeout on the first would send twice.
    assert.equal(calls[0]!.headers['idempotency-key'], calls[1]!.headers['idempotency-key']);
  });

  it('retries a 409 on the send path, because it means the original is in flight', async () => {
    const { client, calls } = testClient(
      [
        { status: 409, body: { error: 'A request with this Idempotency-Key is already in flight.' } },
        { body: { id: 'm', messageId: null, status: 'sent', idempotentReplay: true } },
      ],
      { maxRetries: 2 },
    );

    const result = await client.send({ from: 'a@acme.test', to: 'b@example.com', text: 'hi' });

    assert.equal(calls.length, 2);
    assert.equal(result.idempotentReplay, true);
  });

  it('gives up on a 409 once the budget is spent', async () => {
    const { client } = testClient(
      [
        { status: 409, body: { error: 'already in flight' } },
        { status: 409, body: { error: 'already in flight' } },
      ],
      { maxRetries: 1 },
    );

    await assert.rejects(
      () => client.send({ from: 'a@acme.test', to: 'b@example.com', text: 'hi' }),
      ConflictError,
    );
  });

  it('does not retry a 409 outside the send path', async () => {
    const { client, calls } = testClient(
      [{ status: 409, body: { error: 'Domain acme.test is already registered.' } }],
      { maxRetries: 2 },
    );

    await assert.rejects(() => client.domains.create('acme.test'), ConflictError);
    assert.equal(calls.length, 1, 'a duplicate domain is a real conflict, not a transient one');
  });

  it('does not retry a 400', async () => {
    const { client, calls } = testClient(
      [{ status: 400, body: { status: 400, errors: { from: ['Not a valid address.'] } } }],
      { maxRetries: 2 },
    );

    await assert.rejects(
      () => client.send({ from: 'junk', to: 'b@example.com', text: 'hi' }),
      ValidationError,
    );
    assert.equal(calls.length, 1);
  });

  it('honours Retry-After over its own backoff', async () => {
    const { fetch, calls } = stubFetch([
      { status: 429, headers: { 'retry-after': '1' }, body: { status: 429 } },
      { body: { sentToday: 1 } },
    ]);
    const client = new Announcer({
      apiKey: 'ann_test_key',
      baseUrl: 'https://api.example.test',
      maxRetries: 1,
      fetch,
    });

    const started = Date.now();
    await client.usage();
    const elapsed = Date.now() - started;

    assert.equal(calls.length, 2);
    // Slack below 1000ms for timer coarseness; the point is that it waited
    // roughly the second the server asked for rather than its own ~250ms guess.
    assert.ok(elapsed >= 900, `expected to wait ~1s, waited ${elapsed}ms`);
  });

  it('retries a transport failure', async () => {
    let attempts = 0;
    const flaky = (async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('ECONNRESET');
      return new Response(JSON.stringify({ sentToday: 5 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new Announcer({
      apiKey: 'ann_test_key',
      baseUrl: 'https://api.example.test',
      maxRetries: 2,
      fetch: flaky,
    });

    const usage = await client.usage();
    assert.equal(attempts, 3);
    assert.equal(usage.sentToday, 5);
  });

  it('stops retrying a transport failure once the budget is spent', async () => {
    const failing = (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    const client = new Announcer({
      apiKey: 'ann_test_key',
      baseUrl: 'https://api.example.test',
      maxRetries: 1,
      fetch: failing,
    });

    await assert.rejects(() => client.usage(), ConnectionError);
  });
});

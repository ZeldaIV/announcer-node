import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AuthenticationError,
  ConflictError,
  ConnectionError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  UnprocessableError,
  ValidationError,
} from '../src/index.js';
import { testClient } from './helpers.js';

describe('error mapping', () => {
  it('maps 401 onto AuthenticationError', async () => {
    const { client } = testClient([
      { status: 401, body: { title: 'Unauthorized', status: 401, detail: 'Invalid API key.' } },
    ]);
    await assert.rejects(() => client.usage(), (e: unknown) => {
      assert.ok(e instanceof AuthenticationError);
      assert.equal(e.message, 'Invalid API key.');
      return true;
    });
  });

  it('maps 403 onto PermissionError and keeps the detail', async () => {
    const { client } = testClient([
      {
        status: 403,
        body: {
          status: 403,
          detail: 'Your account is not authorized to send from acme.test. Register the domain first.',
        },
      },
    ]);
    await assert.rejects(
      () => client.send({ from: 'x@acme.test', to: 'y@example.com', text: 'hi' }),
      (e: unknown) => {
        assert.ok(e instanceof PermissionError);
        assert.match(e.message, /Register the domain first/);
        return true;
      },
    );
  });

  it('exposes the per-field messages on a 400', async () => {
    const { client } = testClient([
      {
        status: 400,
        body: {
          title: 'One or more validation errors occurred.',
          status: 400,
          errors: { from: ['Not a valid address.'] },
        },
      },
    ]);
    await assert.rejects(
      () => client.send({ from: 'nonsense', to: 'y@example.com', text: 'hi' }),
      (e: unknown) => {
        assert.ok(e instanceof ValidationError);
        assert.deepEqual(e.errors, { from: ['Not a valid address.'] });
        // The field name has to survive verbatim, so error bodies are never camelized.
        assert.equal(e.message, 'from: Not a valid address.');
        return true;
      },
    );
  });

  it('handles the bare {"error": ...} shape the two 409 paths use', async () => {
    const { client } = testClient([
      { status: 409, body: { error: 'Domain acme.test is already registered.' } },
    ]);
    await assert.rejects(() => client.domains.create('acme.test'), (e: unknown) => {
      assert.ok(e instanceof ConflictError);
      assert.equal(e.message, 'Domain acme.test is already registered.');
      return true;
    });
  });

  it('survives a 404 with no body at all', async () => {
    // Several handlers answer `StatusCode::NOT_FOUND` with nothing in the body.
    const { client } = testClient([{ status: 404, raw: '' }]);
    await assert.rejects(() => client.domains.delete('missing'), (e: unknown) => {
      assert.ok(e instanceof NotFoundError);
      assert.equal(e.message, 'Not found.');
      return true;
    });
  });

  it('reads Retry-After off a 429', async () => {
    const { client } = testClient([
      {
        status: 429,
        headers: { 'retry-after': '3600' },
        body: { status: 429, detail: 'Daily send limit of 100 messages reached.' },
      },
    ]);
    await assert.rejects(
      () => client.send({ from: 'x@acme.test', to: 'y@example.com', text: 'hi' }),
      (e: unknown) => {
        assert.ok(e instanceof RateLimitError);
        assert.equal(e.retryAfter, 3600);
        return true;
      },
    );
  });

  it('maps 422 outside the send path onto a plain UnprocessableError', async () => {
    const { client } = testClient([
      { status: 422, body: { status: 422, detail: 'No TXT record found at mail._domainkey.acme.test.' } },
    ]);
    await assert.rejects(() => client.domains.verify('d1'), (e: unknown) => {
      assert.ok(e instanceof UnprocessableError);
      assert.equal(e.constructor.name, 'UnprocessableError');
      return true;
    });
  });

  it('maps 5xx onto ServerError', async () => {
    const { client } = testClient([{ status: 503, body: { status: 503, detail: 'Refusing to send unsigned.' } }]);
    await assert.rejects(
      () => client.send({ from: 'x@acme.test', to: 'y@example.com', text: 'hi' }),
      (e: unknown) => {
        assert.ok(e instanceof ServerError);
        return true;
      },
    );
  });

  it('wraps a transport failure in ConnectionError', async () => {
    const failing = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const { client } = testClient([], { fetch: failing });
    await assert.rejects(() => client.usage(), (e: unknown) => {
      assert.ok(e instanceof ConnectionError);
      assert.equal(e.status, 0);
      assert.match(e.message, /Could not reach the Announcer API/);
      return true;
    });
  });

  it('surfaces x-request-id for support', async () => {
    const { client } = testClient([
      { status: 500, headers: { 'x-request-id': 'req_abc123' }, body: { status: 500 } },
    ]);
    await assert.rejects(() => client.usage(), (e: unknown) => {
      assert.ok(e instanceof ServerError);
      assert.equal(e.requestId, 'req_abc123');
      return true;
    });
  });
});

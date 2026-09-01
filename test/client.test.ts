import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Announcer, DEFAULT_BASE_URL } from '../src/index.js';
import { stubFetch, testClient } from './helpers.js';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('construction', () => {
  it('takes the key positionally', () => {
    const client = new Announcer('ann_positional');
    assert.equal(client.baseUrl, DEFAULT_BASE_URL);
  });

  it('takes an options object instead', () => {
    const client = new Announcer({ apiKey: 'ann_object', baseUrl: 'https://self.hosted.test' });
    assert.equal(client.baseUrl, 'https://self.hosted.test');
  });

  it('falls back to ANNOUNCER_API_KEY and ANNOUNCER_BASE_URL', async () => {
    process.env.ANNOUNCER_API_KEY = 'ann_from_env';
    process.env.ANNOUNCER_BASE_URL = 'http://localhost:8080';

    const { fetch, calls } = stubFetch([{ body: { sentToday: 0 } }]);
    const client = new Announcer({ fetch });

    assert.equal(client.baseUrl, 'http://localhost:8080');
    await client.usage();
    assert.equal(calls[0]!.headers.authorization, 'Bearer ann_from_env');
  });

  it('explains itself when no key is available anywhere', () => {
    delete process.env.ANNOUNCER_API_KEY;
    assert.throws(() => new Announcer(), /ANNOUNCER_API_KEY/);
  });

  it('trims a trailing slash off the base URL', () => {
    const client = new Announcer({ apiKey: 'k', baseUrl: 'https://api.example.test/' });
    assert.equal(client.baseUrl, 'https://api.example.test');
  });

  it('names the caller in the User-Agent when asked', async () => {
    const { fetch, calls } = stubFetch([{ body: { sentToday: 0 } }]);
    const client = new Announcer({ apiKey: 'k', fetch, userAgent: 'acme-billing/2.1' });
    await client.usage();
    assert.match(calls[0]!.headers['user-agent']!, /^announcer-node\/\S+ acme-billing\/2\.1$/);
  });
});

describe('domains', () => {
  it('returns the record to publish on create', async () => {
    const { client, calls } = testClient([
      {
        status: 201,
        body: {
          id: 'd1',
          domain: 'acme.test',
          selector: 'mail',
          verified: false,
          dns: [
            {
              type: 'TXT',
              name: 'mail._domainkey.acme.test',
              value: 'v=DKIM1; k=rsa; p=MIIBIjANBg',
              purpose: 'DKIM public key.',
            },
          ],
        },
      },
    ]);

    const domain = await client.domains.create('acme.test');

    assert.deepEqual(calls[0]!.body, { domain: 'acme.test' });
    assert.equal(domain.dns[0]!.name, 'mail._domainkey.acme.test');
  });

  it('derives `verified` from verified_at, which is all the list endpoint sends', async () => {
    const { client } = testClient([
      {
        body: [
          {
            id: 'd1',
            domain: 'acme.test',
            selector: 'mail',
            verified_at: '2026-08-01T09:00:00Z',
            created_at: '2026-07-01T09:00:00Z',
          },
          {
            id: 'd2',
            domain: 'beta.test',
            selector: 'mail',
            verified_at: null,
            created_at: '2026-07-02T09:00:00Z',
          },
        ],
      },
    ]);

    const domains = await client.domains.list();

    assert.equal(domains[0]!.verified, true);
    assert.equal(domains[1]!.verified, false);
    assert.equal(domains[0]!.verifiedAt, '2026-08-01T09:00:00Z');
  });

  it('sends DELETE and tolerates the empty 204', async () => {
    const { client, calls } = testClient([{ status: 204 }]);
    await client.domains.delete('d1');
    assert.equal(calls[0]!.method, 'DELETE');
    assert.equal(calls[0]!.url, 'https://api.example.test/v1/domains/d1');
  });
});

describe('apiKeys', () => {
  it('defaults the scope to full and returns the one-time secret', async () => {
    const { client, calls } = testClient([
      { status: 201, body: { id: 'k1', name: 'ci', prefix: 'ann_abc123', scope: 'full', key: 'ann_secret' } },
    ]);

    const key = await client.apiKeys.create('ci');

    assert.deepEqual(calls[0]!.body, { name: 'ci', scope: 'full' });
    assert.equal(key.key, 'ann_secret');
  });

  it('passes a send scope through', async () => {
    const { client, calls } = testClient([
      { status: 201, body: { id: 'k1', name: 'app', prefix: 'ann_x', scope: 'send', key: 'ann_s' } },
    ]);
    await client.apiKeys.create('app', 'send');
    assert.deepEqual(calls[0]!.body, { name: 'app', scope: 'send' });
  });

  it('derives `revoked` from revoked_at', async () => {
    const { client } = testClient([
      {
        body: [
          {
            id: 'k1',
            name: 'old',
            prefix: 'ann_a',
            scope: 'full',
            created_at: '2026-01-01T00:00:00Z',
            last_used_at: '2026-02-01T00:00:00Z',
            revoked_at: '2026-03-01T00:00:00Z',
          },
        ],
      },
    ]);

    const keys = await client.apiKeys.list();
    assert.equal(keys[0]!.revoked, true);
    assert.equal(keys[0]!.lastUsedAt, '2026-02-01T00:00:00Z');
  });
});

describe('usage', () => {
  it('passes the already-camelCase response through unchanged', async () => {
    const { client } = testClient([
      {
        body: {
          sentToday: 12,
          dailySendLimit: 100,
          domains: 1,
          maxDomains: 3,
          plan: 'free',
          sentThisPeriod: 40,
          periodStart: '2026-09-01T00:00:00Z',
          monthlyIncludedMessages: null,
          monthlyHardCap: null,
          overageMinorUnits: null,
          series: [{ date: '2026-09-01', sent: 12, delivered: 10, failed: 1 }],
        },
      },
    ]);

    const usage = await client.usage();

    assert.equal(usage.sentToday, 12);
    assert.equal(usage.series[0]!.date, '2026-09-01');
    assert.equal(usage.monthlyHardCap, null);
  });
});

describe('suppressions', () => {
  it('lists suppressed addresses', async () => {
    const { client, calls } = testClient([
      {
        body: [
          {
            id: 's1',
            email: 'bounced@example.com',
            reason: 'hard bounce (5.1.1 user unknown)',
            created_at: '2026-08-30T12:00:00Z',
          },
        ],
      },
    ]);

    const suppressions = await client.suppressions.list({ limit: 25 });

    assert.equal(calls[0]!.url, 'https://api.example.test/v1/suppressions?limit=25');
    assert.equal(suppressions[0]!.email, 'bounced@example.com');
    assert.equal(suppressions[0]!.createdAt, '2026-08-30T12:00:00Z');
  });
});

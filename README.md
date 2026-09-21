# announcer-sdk

Node.js SDK for [Announcer](https://misralo.com) — send transactional email from
your own domain, DKIM-signed.

Zero runtime dependencies. ESM and CommonJS. Full TypeScript types.

```bash
npm install announcer-sdk
```

## Send an email

```ts
import { Announcer } from 'announcer-sdk';

const announcer = new Announcer(process.env.ANNOUNCER_API_KEY);

await announcer.send({
  from: 'Acme <billing@acme.com>',
  to: 'customer@example.com',
  subject: 'Your receipt',
  text: 'Thanks for your order.',
  html: '<p>Thanks for your order.</p>',
});
```

That's the whole integration. The key can also come from the `ANNOUNCER_API_KEY`
environment variable, in which case `new Announcer()` is enough.

`to`, `cc` and `bcc` each take one address or an array, and `replyTo` sets the
reply address — see [Several recipients](#several-recipients).

CommonJS works the same way:

```js
const { Announcer } = require('announcer-sdk');
```

## Before your first send

You need a registered, verified sending domain — Announcer will not let you send
`From:` a domain you have not proved you control.

```ts
const domain = await announcer.domains.create('acme.com');

for (const record of domain.dns) {
  console.log(`${record.type}  ${record.name}  ${record.value}`);
}
// TXT  mail._domainkey.acme.com  v=DKIM1; k=rsa; p=MIIBIjANBg...

// Publish that record, wait for DNS, then:
await announcer.domains.verify(domain.id);
```

One TXT record is the entire ask. SPF and MX stay on Announcer's own bounce
domain, so your root domain's DNS is untouched.

## What the SDK does for you

**Retries are safe.** Every send carries an `Idempotency-Key`, generated per call
when you do not supply one. A timeout, a 500, or a 429 gets retried with
exponential backoff and jitter — and because the key travels with the retry, the
API recognises it as the same operation instead of sending twice.

Supply your own key to extend that guarantee across process restarts:

```ts
await announcer.send({
  from: 'billing@acme.com',
  to: 'customer@example.com',
  subject: 'Your receipt',
  text: 'Thanks!',
  idempotencyKey: `receipt-${order.id}`, // this order mails exactly once, ever
});
```

A replay tells you so rather than pretending it sent again:

```ts
const result = await announcer.send({ /* ... */ idempotencyKey: 'receipt-4711' });
if (result.idempotentReplay) {
  // Already sent earlier. Nothing went out a second time.
}
```

**Errors are typed.** Catch the case you can actually handle:

```ts
import { SuppressedRecipientError, RateLimitError, PermissionError } from 'announcer-sdk';

try {
  await announcer.send({ from, to, subject, text });
} catch (error) {
  if (error instanceof SuppressedRecipientError) {
    // They hard-bounced or complained before. Don't retry; mark them inactive.
  } else if (error instanceof RateLimitError) {
    console.log(`Slow down for ${error.retryAfter}s`);
  } else if (error instanceof PermissionError) {
    // Domain not registered, not verified, or this key is send-scoped.
  } else {
    throw error;
  }
}
```

The full set: `ValidationError` (with a per-field `.errors` map),
`AuthenticationError`, `PermissionError`, `NotFoundError`, `ConflictError`,
`UnprocessableError`, `SuppressedRecipientError`, `RateLimitError`,
`ServerError`, `ConnectionError`. All extend `AnnouncerError`.

**Field names are consistent.** The API mixes `camelCase` and `snake_case`
depending on the endpoint. The SDK normalises everything to camelCase, maps
`header_from`/`recipient` onto the `from`/`to` you already used to send, and
derives the booleans you actually want (`domain.verified`, `key.revoked`,
`endpoint.disabled`). Free-form `payload` and `detail` objects pass through
untouched — those keys are your data.

## Several recipients

`to`, `cc` and `bcc` each take one address or an array. Everything in `to` and
`cc` is **one email** whose recipients see each other; `bcc` recipients see
nobody, not even each other:

```ts
await announcer.send({
  from: 'billing@acme.com',
  to: ['customer@example.com', 'partner@example.com'],
  cc: 'accounting@acme.com',
  bcc: 'archive@acme.com',
  replyTo: 'support@acme.com',
  subject: 'Your receipt',
  text: 'Thanks!',
});
```

At most 50 addresses across the three. `replyTo` is a header only — it costs
nothing and cannot bounce.

**Recipients are the billable unit.** That call counts four against your quota,
not one. It is also what keeps `monthlyHardCap` meaningful: otherwise a leaked
key could send fifty times your ceiling by padding the array.

### One email, or many?

For anything list-shaped — a newsletter, a digest, a fan-out — you want
`sendMany`, not an array:

```ts
const results = await announcer.emails.sendMany(
  ['a@example.com', 'b@example.com', 'c@example.com'],
  { from: 'news@acme.com', subject: 'September update', html: body },
);

for (const { to, ok, error } of results) {
  if (!ok) console.warn(`${to} failed: ${error!.message}`);
}
```

|  | `send({ to: [a, b] })` | `sendMany([a, b], …)` |
|---|---|---|
| Emails sent | one | two |
| Do they see each other? | yes, in `To:` | no |
| API requests | one | two |
| Idempotency key | one | one each, derived |
| One address fails | the send reports it | the others are unaffected |

### Suppressed recipients

A recipient on your suppression list is dropped and the rest still goes out:

```ts
const result = await announcer.send({
  from: 'billing@acme.com',
  to: ['good@example.com', 'bounced-before@example.com'],
  subject: 'Your receipt',
  text: 'Thanks!',
});

result.recipients; // 1 — what actually went out and what you were billed
result.suppressed; // ['bounced-before@example.com']
```

`SuppressedRecipientError` is thrown only when *every* recipient is suppressed
(or every `to` recipient — a message with no visible primary recipient is
refused rather than sent). Its `.suppressed` array names them all.

## Webhooks

Register an endpoint, store the secret, verify every delivery:

```ts
const endpoint = await announcer.webhooks.create('https://acme.com/hooks/announcer');
console.log(endpoint.secret); // whsec_... — shown once, store it now
```

```ts
import express from 'express';
import { Announcer, SignatureVerificationError } from 'announcer-sdk';

const app = express();
const announcer = new Announcer();

// express.raw, NOT express.json — verification needs the exact bytes that
// were signed. A re-serialised object will not match.
app.post('/hooks/announcer', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = announcer.webhooks.verify(
      req.body,
      req.header('X-Announcer-Signature'),
      process.env.ANNOUNCER_WEBHOOK_SECRET!,
    );
  } catch (error) {
    if (error instanceof SignatureVerificationError) return res.sendStatus(400);
    throw error;
  }

  switch (event.event) {
    case 'delivered':  markDelivered(event.message.id); break;
    case 'bounced':    deactivate(event.message.to);    break;
    case 'complained': deactivate(event.message.to);    break;
  }

  res.sendStatus(200);
});
```

Verification checks the HMAC **and** the timestamp, rejecting anything more than
five minutes old so a captured delivery cannot be replayed at you. Tune it with
`{ toleranceSeconds }`.

Events: `sent`, `delivered`, `bounced`, `complained`, `suppressed`.

## API reference

### Client

```ts
new Announcer(apiKey?: string, options?: AnnouncerOptions)
new Announcer(options: AnnouncerOptions)
```

| Option      | Default                              | Notes |
|-------------|--------------------------------------|-------|
| `apiKey`    | `process.env.ANNOUNCER_API_KEY`      | Required, one way or the other. |
| `baseUrl`   | `process.env.ANNOUNCER_BASE_URL`, then `https://mail.misralo.com` | |
| `timeout`   | `30000`                              | Per attempt, in milliseconds. |
| `maxRetries`| `2`                                  | Extra attempts after a failure. |
| `fetch`     | global `fetch`                       | Swap in undici, a proxy wrapper, or a test double. |
| `userAgent` | —                                    | Appended to the SDK's own. Name your app. |
| `headers`   | —                                    | Added to every request. |

### Methods

| Call | Does |
|------|------|
| `announcer.send(msg)` | Shorthand for `emails.send`. |
| `announcer.usage()` | Quota consumption plus a 14-day sending series. |
| `emails.send(msg)` | Sends one email. `to`/`cc`/`bcc` take one address or many. |
| `emails.sendMany(recipients, msg, opts?)` | Separate emails, one per recipient. |
| `emails.list(query?)` | Send history. Filter by `status` or `search`. |
| `emails.events(id)` | A message's audit trail. |
| `domains.create(domain)` | Registers a domain, returns the DNS record. |
| `domains.list()` | Every domain on the account. |
| `domains.dns(id)` | The records again, for a domain you already registered. |
| `domains.verify(id)` | Resolves DNS and checks the published key. |
| `domains.delete(id)` | Removes the domain and its signing key. |
| `apiKeys.create(name, scope?)` | Issues a key. Secret shown once. |
| `apiKeys.list()` | Every key, without secrets. |
| `apiKeys.revoke(id)` | Revokes a key; history survives. |
| `webhooks.create(url)` | Registers an endpoint. Max 2 active. |
| `webhooks.list()` | Every endpoint. |
| `webhooks.delete(id)` | Disables an endpoint. |
| `webhooks.verify(body, header, secret, opts?)` | Verifies a delivery. |
| `suppressions.list(query?)` | Addresses that bounced or complained. |

`domains.*` and `apiKeys.*` and `webhooks.*` need a `full`-scoped key.
Everything else works with a `send` key too — give integrations `send`.

## Scopes

Mint a `send`-scoped key for anything that only sends mail:

```ts
const key = await announcer.apiKeys.create('production-worker', 'send');
```

A leaked send key cannot register domains, mint successor keys, or touch
billing. It is the difference between an incident and a catastrophe.

## Contributing

```bash
npm install
npm test        # 59 tests, no network
npm run build   # dist/esm + dist/cjs
```

## License

MIT

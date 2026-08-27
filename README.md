# Waka

Waka is a self-hosted, Resend-compatible transactional email API. It runs a Bun + TypeScript server, stores data in PostgreSQL, and sends mail through Amazon SES.

It is for developers who want to run their own email API and pay AWS SES usage costs instead of a hosted email API subscription. You need an AWS account with SES access, a PostgreSQL database, and a machine that can run Docker. AWS, database, domain, and DNS costs are separate; Waka has no service fee.

## Quick start

The shortest local path uses Docker Compose. It starts PostgreSQL, runs the migration, and starts the API.

```bash
git clone https://github.com/DesgnSpace/waka.git waka
cd waka
cp .env.example .env
```

Edit `.env` and replace the placeholder values. Then run:

```bash
docker compose up --build -d
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "a-password-of-12-plus-characters"}'
```

Open `http://localhost:3000` and sign in with the email and password you signed up with. The full ordered setup, including PostgreSQL, is in [SETUP.md](SETUP.md). Use [DEPLOYMENT.md](DEPLOYMENT.md) for production Docker Compose deployment.

## What happens next

1. Add a sending domain in the dashboard.
2. Add the DNS records shown by Waka at your DNS provider.
3. Wait for DNS changes, then verify the domain.
4. Create an API key for the verified domain.
5. Send mail through `POST /api/emails` or a Resend client pointed at `https://your-host.example/api`.

Waka does not create DNS records automatically. It shows the SES verification, DKIM, SPF, DMARC, and optional custom MAIL FROM records that you must add yourself.

## Documentation

- [SETUP.md](SETUP.md): local setup, environment variables, SES, and the first email
- [DEPLOYMENT.md](DEPLOYMENT.md): Docker Compose production deployment
- [CONTRIBUTING.md](CONTRIBUTING.md): development and pull request rules

## API examples

Create a domain and API key in the dashboard first. Then send an email with the key:

```bash
curl -X POST https://your-host.example/api/emails \
  -H "Authorization: Bearer wka_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@example.com",
    "to": ["recipient@example.com"],
    "subject": "Hello",
    "html": "<p>Hello from Waka.</p>"
  }'
```

The Resend Node.js SDK can use the same API key when its base URL is set to `https://your-host.example/api`.

## Retry safety

Send an `Idempotency-Key` header with `POST /api/emails` to make client retries safe. Use a unique value per message (up to 255 characters) and resend it unchanged if a request times out or the response is lost.

- While the first request with a key is still running, repeats get `409 Conflict`. Wait briefly and retry.
- Once it finishes, repeats return the original status and body instead of sending again.
- If the first attempt was rejected before SES accepted it, the key is released and a retry sends normally.
- Keys are scoped to the API key that sent them and expire after 24 hours.

Requests without an `Idempotency-Key` are unaffected.

## Suppressions

Addresses that permanently bounced or were marked as spam are blocked per domain. The SES webhook records them automatically; later sends to the same address on that domain are refused before any quota or rate-limit is consumed. Transient bounces (for example, a full mailbox) are not blocked.

- A send is checked against `to`, `cc`, and `bcc`. If any recipient is suppressed the entire request is rejected with `400` and a list of the blocked addresses. Remove those addresses or clear them from the suppression list and send again.
- Suppressions are scoped to the sending domain. One domain's blocks never affect another, even for the same recipient address.
- Manage them per domain: `GET /api/domains/:id/suppressions` lists blocked addresses, `DELETE /api/domains/:id/suppressions/:email` removes one.

## Per-key limits

Each API key can carry its own caps so a leaked or noisy key is contained without throttling the rest of the account. Both fields are optional; a key with no limits behaves exactly as before.

- `rateLimitPerMinute` — maximum sends per rolling 60-second window for that key.
- `dailySendLimit` — maximum sends per calendar day for that key.

Set them when creating a key and change them later:

```bash
curl -X POST https://your-host.example/api/api-keys \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"domainId":"<uuid>","keyName":"mobile","rateLimitPerMinute":30,"dailySendLimit":500}'

curl -X PUT https://your-host.example/api/api-keys/<key-id> \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"rateLimitPerMinute":10,"dailySendLimit":null}'
```

Pass `null` to clear a limit. The dashboard's key creation form exposes the same two fields. Limits are enforced on `POST /api/emails` in addition to the existing account (`60/min` + `1,000/day` by default) and IP (`20/min`) limits — the strictest limit that applies wins. When a per-key limit is what rejected the request the error says so explicitly:

- per-minute: `This API key has reached its per-minute limit. Wait a moment and try again, or raise the limit for this key.` (`429`)
- per-day: `This API key has reached its daily sending limit.` (`429`)

The dashboard's test-email action is rate-limited by the same account and IP buckets and counts against the daily quota.

## Batch sending

`POST /api/emails/batch` sends up to 100 emails in one request. The body is a JSON array where each element uses the same shape as `POST /api/emails` (`from`, `to`, `subject`, `html`/`text`, etc.). The endpoint is Resend-compatible (`POST /emails/batch`).

- **Authentication and domain**: same `wka_` API key as single send; the key's domain must be verified and `from` on every item must match it. A missing or unverified domain fails the whole batch.
- **Cap**: at most 100 items per request (`400` naming the limit when exceeded). The server also enforces a 15 MB JSON body ceiling, so the cap sits comfortably inside that limit for typical emails.
- **Per-item checks**: each item runs the same validation, `from` domain check, suppression check, rate-limit and daily-quota checks, and SES send as the single endpoint. Suppressing or quota is evaluated before SES, so blocked items never burn quota.
- **Rate and quota**: counted per email, not per request. A batch of 50 consumes 50 quota units and 50 points against the `60/min` account, `20/min` IP, and any per-key limits. When a quota or rate bucket empties mid-batch, remaining items fail individually with `429`.
- **Concurrency**: items are sent sequentially to keep the small Postgres pool (`max 5`) from being exhausted. One batch holds at most one DB connection at a time.
- **Partial failures**: the response always contains `data` in request order so the client can match items. Success entries carry `{id, from, to, created_at}`; failures carry `{error, message, statusCode}` plus `code` or `suppressed` when relevant. The overall status is `200` when every item succeeded and `207 Multi-Status` when some failed (including when all failed, so a mixed batch never looks like a total success or a single top-level error).
- **Idempotency**: `Idempotency-Key` is supported per batch (same header as single send). A replay returns the stored batch response with `idempotency-replayed: true`; a concurrent retry gets `409`.

Example:

```bash
curl -X POST https://your-host.example/api/emails/batch \
  -H "Authorization: Bearer wka_your_api_key" \
  -H "Content-Type: application/json" \
  -d '[
    {"from":"hello@example.com","to":["a@example.com"],"subject":"Hi A","text":"Hello A"},
    {"from":"hello@example.com","to":["b@example.com"],"subject":"Hi B","text":"Hello B"}
  ]'
```

### Scheduled sending

Add `scheduled_at` to the same request to have Waka deliver the email later. Accepts an ISO 8601 timestamp (include `Z` or a UTC offset) or a relative offset like `in 30 minutes`, at most 72 hours ahead:

```bash
curl -X POST https://your-host.example/api/emails \
  -H "Authorization: Bearer wka_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@example.com",
    "to": ["recipient@example.com"],
    "subject": "Later",
    "text": "This arrives at the scheduled time.",
    "scheduled_at": "2026-09-01T09:00:00Z"
  }'
```

The response returns the same `id` shape as an immediate send, right away. A worker picks up the message within a minute of its send time; until then it has status `scheduled` and appears in `GET /api/emails/logs?status=scheduled`. The daily quota counts a scheduled message when it is submitted. A message whose delivery fails retries up to 5 times, 5 minutes apart, before its status becomes `failed` permanently.

### Outbound webhooks

Register an HTTPS endpoint to receive email events — `delivery`, `bounce`, `complaint`, `open`, `click` — as signed JSON. Waka signs every delivery; you verify the signature to prove it came from your instance.

Manage endpoints with your dashboard JWT (`Authorization: Bearer <jwt>`):

```bash
# register
curl -X POST https://your-host.example/api/webhooks \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/waka-events"}'
# → { data: { webhook: { id, url, enabled }, secret: "<64-hex>" } }

# list
curl https://your-host.example/api/webhooks -H "Authorization: Bearer <jwt>"

# reveal secret
curl https://your-host.example/api/webhooks/<id>/secret -H "Authorization: Bearer <jwt>"

# rotate secret
curl -X POST https://your-host.example/api/webhooks/<id>/rotate -H "Authorization: Bearer <jwt>"
# → { data: { secret: "<new-64-hex>" } }

# delete
curl -X DELETE https://your-host.example/api/webhooks/<id> -H "Authorization: Bearer <jwt>"
```

Each endpoint belongs to the user who created it and only receives events for that user's domains. An endpoint must be a public `https://` URL; `http://`, loopback, link-local, and private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`) are rejected. Literal IP addresses in those ranges and hostnames such as `localhost` are rejected at registration, and the same check is re-applied at delivery time via DNS resolution so a hostname that later points to a private address is still blocked and the delivery is marked `dead` without retry.

**Delivery**: a background worker (`Bun.cron` every minute, guarded by a Postgres advisory lock) POSTs the JSON payload to your URL with a 10s timeout and up to 5 concurrent deliveries per tick. The SNS handler enqueues the delivery but never waits on your endpoint and never fails because your endpoint failed.

**Payload** (JSON):

```json
{
  "type": "delivered",
  "created_at": "2026-08-26T12:00:00.000Z",
  "data": {
    "email_id": "uuid",
    "ses_message_id": "0100...",
    "source": "sender@example.com",
    "destination": ["recipient@example.com"],
    "timestamp": "2026-08-26T12:00:00.000Z",
    "bounce": null,
    "complaint": null,
    "open": { "ipAddress": "203.0.113.9", "userAgent": "Test/1.0" },
    "click": { "link": "https://example.com", "ipAddress": "...", "userAgent": "..." }
  }
}
```

**Headers** on every delivery:

- `X-Waka-Timestamp`: Unix seconds as a decimal string, e.g. `1724600000`.
- `X-Waka-Signature`: `v1=<hex>` where `<hex>` is HMAC-SHA256 hex of the signed string.

**Signed string**: `"<timestamp>.<rawBody>"` where `rawBody` is the exact JSON bytes sent. Example: `1724600000.{"type":"delivered","created_at":"..."}`.

**Verifying** (Node.js):

```js
import crypto from "node:crypto";
function verify(secret, timestamp, rawBody, signatureHeader) {
  const signed = `${timestamp}.${rawBody}`;
  const expected = "v1=" + crypto.createHmac("sha256", secret).update(signed).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
// fetch handler:
const ts = req.headers["x-waka-timestamp"];
const sig = req.headers["x-waka-signature"];
if (!verify(process.env.WAKA_WEBHOOK_SECRET, ts, rawBody, sig)) throw new Error("invalid signature");
if (Math.abs(Date.now()/1000 - Number(ts)) > 300) throw new Error("stale timestamp");
```

Include the timestamp in the comparison so a captured payload cannot be replayed after 5 minutes. Reject if the timestamp differs from `Date.now()` by more than 300 seconds.

**Retries**: exponential backoff with a maximum of 8 attempts. After the first immediate attempt, the delays are 60s, 120s, 240s, 480s, 960s, 1920s, 3840s, then capped at 14400s (4h). Only transient failures are retried: `5xx`, `429 Too Many Requests`, `408 Request Timeout`, and network/timeout errors. Other `4xx` responses (e.g. `400`, `404`, `410`) are permanent and the delivery is marked `dead` immediately without further attempts. A delivery that resolves to a private or blocked address is also `dead` immediately. After the 8th retryable failure the delivery is marked `dead` and not retried. A repeatedly failing endpoint is disabled after 5 consecutive dead deliveries; it stays disabled until you delete it or create a new one. New events are not retried to a disabled endpoint.

## Routes

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/signup`
- `GET /api/auth/me`
- `GET|POST /api/domains`
- `GET|DELETE /api/domains/:id`
- `POST /api/domains/:id/verify`
- `GET /api/domains/:id/suppressions`
- `DELETE /api/domains/:id/suppressions/:email`
- `GET|POST /api/api-keys`
- `PUT|DELETE /api/api-keys/:id`
- `POST /api/emails`
- `POST /api/emails/batch`
- `GET /api/emails/logs`
- `GET /api/emails/:id`
- `POST /api/webhooks/ses`
- `GET|POST /api/webhooks`
- `DELETE /api/webhooks/:id`
- `GET /api/webhooks/:id/secret`
- `POST /api/webhooks/:id/rotate`
- `POST /api/tools/email-dns-checker`

Dashboard routes are `/`, `/login`, `/logout`, `/dashboard`, and the domain and log views under `/ui/`.

## License

MIT. See [LICENSE](LICENSE).

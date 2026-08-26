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

## Routes

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/signup`
- `GET /api/auth/me`
- `GET|POST /api/domains`
- `GET|DELETE /api/domains/:id`
- `POST /api/domains/:id/verify`
- `GET|POST /api/api-keys` — `POST` body: `{ domainId, keyName, permissions?: ["send"], expiresAt?: string|null }`. `expiresAt` is an ISO 8601 timestamp; `null` or omitted means the key never expires. Keys that carry only the removed permissions `receive`/`webhooks` are rejected; existing keys that stored them remain without `send` and continue to be denied without being widened.
- `PUT|DELETE /api/api-keys/:id` — `PUT` body: `{ permissions?: ["send"], expiresAt?: string|null }` (at least one required). Clearing expiry uses `null` or `""`.
- `POST /api/emails`
- `GET /api/emails/logs` — paged (`page`, `limit`, default 50). Query filters (all optional, combined with AND): `domain_id` (UUID), `status` (`pending`|`sent`|`failed`|`delivered`|`bounced`|`complained`), `recipient` (substring match against `to`/`cc`/`bcc`, case-insensitive), `subject` (substring, case-insensitive), `from`/`to` (ISO 8601 timestamps; aliases `from_date`/`to_date`/`start_date`/`end_date`/`startDate`/`endDate`; date-only `YYYY-MM-DD` treats `to` as end-of-day), `message_id`/`messageId` (exact match against `id`, `ses_message_id`, or `message_id`). Tenant-isolated: API keys see only their domain, dashboard JWT sees only owned domains. Dashboard filter form at `/ui/domains/:id/logs` uses the same query path.
- `GET /api/emails/:id`
- `GET /api/usage` — per-day counts for `sent`, `delivered`, `bounced`, `complained`, `opened`, `clicked`. Auth: `Bearer wka_` (scoped to its domain) or `Bearer <JWT>` (all owned domains). Query: `from=YYYY-MM-DD` and `to=YYYY-MM-DD`, inclusive. Defaults to the last 30 days when omitted; maximum range is 90 days. Every day in the range is returned, including zeros. Response: `{ success: true, data: { from, to, usage: [{ date, sent, delivered, bounced, complained, opened, clicked }] } }`. Aggregated in a single SQL query using `generate_series` and left-joined log/event counts; uses index `idx_email_logs_domain_id_created_at (domain_id, created_at DESC)` for the log time range.
- `POST /api/webhooks/ses`
- `POST /api/tools/email-dns-checker`

API keys with `expires_at` in the past are rejected with `401 { error: "This API key has expired. Create a new API key for this domain to continue." }`. A key without `expires_at` never expires. The only accepted permission is `send`; `receive` and `webhooks` were removed because no route enforced them.

Dashboard routes are `/`, `/login`, `/logout`, `/dashboard`, and the domain and log views under `/ui/`.

## License

MIT. See [LICENSE](LICENSE).

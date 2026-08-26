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
curl -X POST http://localhost:3000/api/setup
```

Open `http://localhost:3000` and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. The full ordered setup, including PostgreSQL, is in [SETUP.md](SETUP.md). Use [DEPLOYMENT.md](DEPLOYMENT.md) for production Docker Compose deployment.

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

## Routes

- `GET /api/health`
- `POST /api/setup`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET|POST /api/domains`
- `GET|DELETE /api/domains/:id`
- `POST /api/domains/:id/verify`
- `GET|POST /api/api-keys`
- `PUT|DELETE /api/api-keys/:id`
- `POST /api/emails`
- `GET /api/emails/logs`
- `GET /api/emails/:id`
- `POST /api/webhooks/ses`
- `POST /api/tools/email-dns-checker`

Dashboard routes are `/`, `/login`, `/logout`, `/dashboard`, and the domain and log views under `/ui/`.

## License

MIT. See [LICENSE](LICENSE).

# Project Summary

## Runtime

- `server.ts` starts the Bun HTTP server on `PORT` or `3000`.
- The server runs `src/lib/migrate.ts` before accepting traffic.
- SQL files in `migrations/` are applied in sorted order and recorded in `schema_migrations`.
- `src/server/` contains the HTTP routes, handlers, dashboard HTML, and SES webhook.
- `src/lib/` contains PostgreSQL, authentication, API key, domain, SES, SNS, and DNS logic.

## Services

- PostgreSQL stores users, domains, API keys, email logs, email events, and webhook events.
- Amazon SES verifies domains and sends email.
- Amazon SNS sends signed SES event notifications to `POST /api/webhooks/ses`.
- A browser may use the dashboard at `/`; API clients use `/api/*`.

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

Dashboard routes include `/`, `/login`, `/logout`, `/dashboard`, and domain and log views under `/ui/`.

## Database

The source of truth is `migrations/001_baseline.sql`. It creates `users`, `domains`, `api_keys`, `email_logs`, `email_events`, and `webhook_events`, plus indexes and timestamp triggers. The application migration runs at startup for Docker Compose deployments.

## Configuration

See the complete environment variable table in [SETUP.md](SETUP.md) and the safe template in `.env.example`. Deployment differences are documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## Request flow

1. The operator starts the server with PostgreSQL and AWS credentials.
2. The startup migration creates or updates the schema.
3. The operator creates the first dashboard user with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
4. The dashboard verifies a domain in SES and shows DNS records.
5. The operator verifies DNS, then creates a domain API key.
6. A client sends mail to `/api/emails` with that key.
7. SES sends event notifications through SNS to the public webhook.

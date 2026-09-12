# Setup

This guide runs Waka locally with Docker Compose. It assumes macOS or Linux, Docker, and an AWS account. The database migration runs automatically when the API starts.

## Local setup

Run these steps in order from a fresh clone:

1. Clone the repository and copy the environment template:

   ```bash
   git clone https://github.com/DesgnSpace/waka.git waka
   cd waka
   cp .env.example .env
   ```

2. Edit `.env`:

- Set `NEXTAUTH_SECRET` to a long random value.
- Set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` to an IAM identity that can use SES.
- Leave `DATABASE_URL` as-is for the Compose database unless you use another PostgreSQL service.
- Leave `DATABASE_SSL=false` for the private Compose network.

3. Start PostgreSQL and Waka:

   ```bash
   docker compose up --build -d
   ```

   The API waits for PostgreSQL, then applies every unrecorded `.sql` file in `migrations/`. Applied files are recorded in `schema_migrations`. PostgreSQL 16 provides the `gen_random_uuid()` function used by the schema.

4. Check the API and create your dashboard account:

   ```bash
   curl http://localhost:3000/api/health
   curl -X POST http://localhost:3000/api/auth/signup \
     -H "Content-Type: application/json" \
     -d '{"email": "you@example.com", "password": "a-password-of-12-plus-characters"}'
   ```

   The password needs at least 12 characters.

5. Open `http://localhost:3000`. Sign in with the email and password you signed up with.

To stop the services without deleting the database volume:

```bash
docker compose down
```

To remove the local database volume too:

```bash
docker compose down -v
```

## Environment variables

The application reads these variables. `.env.example` contains the same list and safe placeholder values.

| Variable | Required | Purpose | Safe example |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string for queries and startup migrations. | `postgresql://waka:change-me@postgres:5432/waka` |
| `POSTGRES_PASSWORD` | Compose only | Password for the PostgreSQL container in `docker-compose.yml`. The Bun application does not read it. Keep it equal to the password in `DATABASE_URL`. | `change-me` |
| `DATABASE_SSL` | No | PostgreSQL TLS mode. `false`, `disable`, or an empty value disables TLS; `true` or `require` verifies the certificate; `no-verify` or `insecure` uses TLS without certificate verification. | `false` |
| `NEXTAUTH_SECRET` | Yes | Secret used to sign dashboard and API JWTs. | `replace-with-a-long-random-secret` |
| `AWS_REGION` | No | AWS SES region. Defaults to `us-east-1`. | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | Yes | IAM access key used for SES API calls. | `replace-with-aws-access-key-id` |
| `AWS_SECRET_ACCESS_KEY` | Yes | Secret half of the IAM access key pair. | `replace-with-aws-secret-access-key` |
| `NODE_ENV` | No | Controls the default Sentry environment and whether the session cookie gets the `Secure` flag. | `development` |
| `PORT` | No | HTTP port. Defaults to `3000`. | `3000` |
| `CORS_ORIGIN` | No | Comma-separated browser origins allowed by CORS. Empty means same-origin only unless `DOMAIN` is set. | `https://app.example.com` |
| `DOMAIN` | No | Canonical host or origin used as the CORS origin when `CORS_ORIGIN` is empty. | `api.example.com` |
| `TRUST_PROXY` | No | Set to `true`, `1`, or `yes` when all traffic passes through one reverse proxy that sets `X-Real-IP` or appends the client to `X-Forwarded-For`. Per-IP rate limits then use `X-Real-IP`, else the rightmost `X-Forwarded-For` entry, which is the one the proxy appended. Unset (default) uses the connection address, which behind a proxy means all clients share one bucket. | `true` |
| `SES_CONFIGURATION_SET` | No | Account-wide SES configuration set attached to sends. Defaults to `waka-events`. | `waka-events` |
| `SES_SNS_TOPIC_ARN` | No | If set, only signed SNS messages from this topic are accepted by the SES webhook. | `arn:aws:sns:us-east-1:123456789012:waka-events` |
| `SENTRY_DSN` | No | Enables Sentry error reporting when non-empty. | `https://examplePublicKey@o0.ingest.sentry.io/0` |
| `LOG_RETENTION_DAYS` | No | Days a sent email keeps its HTML/text body and raw webhook payloads. Each night a job clears those fields from older rows but keeps the rows, so log history stays. `0` disables the job and keeps everything. Defaults to `90`. | `90` |

Do not put real credentials in `.env.example`, source control, a Dockerfile, or a container image. Use `.env` locally and a secret store in production.

## AWS SES setup

Waka calls SES for domain verification, DKIM, configuration sets, sending, and custom MAIL FROM. Create a dedicated IAM user or role with this policy, then place its access key values in the environment:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ses:SendEmail",
        "ses:SendRawEmail",
        "ses:VerifyDomainIdentity",
        "ses:GetIdentityVerificationAttributes",
        "ses:CreateConfigurationSet",
        "ses:VerifyDomainDkim",
        "ses:GetIdentityDkimAttributes",
        "ses:SetIdentityMailFromDomain"
      ],
      "Resource": "*"
    }
  ]
}
```

When a domain is added, the application creates a per-domain SES configuration set named `waka-<domain-with-dashes>`. Email sends use the separate account-wide configuration set named by `SES_CONFIGURATION_SET`, which defaults to `waka-events`. Create that send configuration set in the SES console before the first send, or set `SES_CONFIGURATION_SET` to an existing set. To receive delivery, bounce, complaint, open, and click updates, configure the send configuration set in the SES console to publish to an SNS topic. The topic must deliver HTTP(S) notifications to:

```text
https://your-public-host.example/api/webhooks/ses
```

That URL must be reachable from the public internet over HTTPS. It must accept `POST` requests, and the proxy must pass the request body unchanged. The endpoint validates the AWS SNS signature and confirms the subscription by calling the AWS `SubscribeURL`. Set `SES_SNS_TOPIC_ARN` to the topic ARN to reject messages from other topics.

### SES sandbox

New SES accounts start in sandbox mode in each AWS region. In sandbox mode, SES limits sending and normally requires both sender and recipient addresses to be verified. A message to an unverified recipient is rejected. Request production access in the SES console before sending to arbitrary recipients. Sandbox status is regional, so use the same region in `AWS_REGION` when you request access and when the app sends mail.

### Domain and DNS

Add a domain in the dashboard. Copy the records shown by Waka to your DNS provider. The records include SES verification, DKIM, SPF, and DMARC. If you configure a custom MAIL FROM domain in the dashboard, also add the MX and SPF records shown for that domain. DNS changes can take time to appear. Verify the domain after the records are visible.

## First email

After the domain status is `verified`, create an API key in the dashboard. The full key is shown only once. Send a test message:

```bash
curl -X POST http://localhost:3000/api/emails \
  -H "Authorization: Bearer wka_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@example.com",
    "to": ["recipient@example.com"],
    "subject": "Waka test",
    "text": "This is a test message."
  }'
```

The `from` domain must match the verified domain attached to the API key. In SES sandbox mode, the recipient must also be verified.

To make client retries safe, send an `Idempotency-Key` header with a unique value per message; see [README.md](README.md).

To send later instead of now, add `scheduled_at` to the same request with an ISO 8601 timestamp or a relative offset like `in 30 minutes` (72 hours maximum). Waka stores the message, replies with its `id` immediately, and a background worker delivers it within a minute of that time. Failed deliveries retry up to 5 times before the status becomes `failed`. The daily quota counts the message when it is scheduled, not when it is sent.

## Troubleshooting

- `DATABASE_URL` errors: check that PostgreSQL is running and that the database exists.
- SES `AccessDenied`: check the IAM policy and the AWS region.
- SES recipient rejection: check whether the account is still in sandbox mode.
- Domain remains pending: check the exact DNS names and values shown in the dashboard.
- Webhook events do not arrive: check that the SNS subscription is confirmed and the HTTPS endpoint is public.

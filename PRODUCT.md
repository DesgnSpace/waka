# Product

## Purpose

FreeResend is a self-hosted, Resend-compatible transactional email API. It uses Amazon SES for delivery and PostgreSQL for users, domains, API keys, email logs, and SES event records.

## Users

Developers who can run Docker or Kubernetes, manage PostgreSQL, configure AWS SES, and edit DNS records. They want control of their email infrastructure and AWS-based usage costs instead of a hosted email API subscription.

## Supported behavior

- Dashboard login with JWT-based sessions.
- Domain verification through Amazon SES.
- SES DKIM and optional custom MAIL FROM setup.
- Manual DNS record display for SES verification, DKIM, SPF, and DMARC.
- Per-domain API keys with send permissions.
- Resend-compatible email sending, including HTML, text, attachments, reply-to addresses, and tags.
- Email logs and signed SNS/SES delivery, bounce, complaint, open, and click events.
- Docker Compose and Kubernetes deployment files.

## Limits and dependencies

- Amazon SES account status and sending limits control delivery.
- SES sandbox mode limits recipients until AWS grants production access.
- DNS records must be created by the operator.
- A reachable PostgreSQL database is required.
- The SES webhook needs a public HTTPS endpoint.
- FreeResend has no hosted service fee. Operators pay AWS, database, compute, DNS, and network costs.

## Out of scope

FreeResend does not provide hosted infrastructure, automatic DNS changes, email templates, scheduling, an SMTP server, or multi-user role management.

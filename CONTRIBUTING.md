# Contributing

FreeResend is a Bun + TypeScript service. Read [README.md](README.md) for the product and [SETUP.md](SETUP.md) for local setup.

## Development

```bash
git clone https://github.com/DesgnSpace/waka.git freeresend
cd freeresend
bun install --frozen-lockfile
cp .env.example .env
```

Set the local PostgreSQL and AWS values in `.env`, then start the stack:

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://freeresend:change-me@localhost:5432/freeresend bun run dev
```

The inline `DATABASE_URL` points the host Bun process at the published PostgreSQL port. The server applies pending migrations before it listens. Use `docker compose up --build` when you want to test the image instead of the local Bun process. Do not commit `.env` or real credentials.

## Changes

- Keep API paths and request shapes compatible with the documented routes.
- Add or update migrations when the database schema changes.
- Update [SETUP.md](SETUP.md) when an environment variable or required service changes.
- Keep deployment changes in [DEPLOYMENT.md](DEPLOYMENT.md) and `docker-compose.yml` or `Dockerfile`.
- Do not claim a feature in documentation unless it exists in the server code.
- Include tests or a clear manual check for behavior changes.

## Checks

Available package scripts are `start` and `dev`. There is no `test`, `lint`, or `build` script in `package.json`. For a local type check, run:

```bash
bunx tsc --noEmit
```

For a container check, run:

```bash
docker build -t freeresend:local .
```

## Pull requests

1. Create a focused branch.
2. Explain the behavior change.
3. List checks that passed and checks that were not run.
4. Update docs for user-visible setup or deployment changes.
5. Use a clear Conventional Commit message when committing.

Report security issues privately rather than posting credentials or exploit details in a public issue.

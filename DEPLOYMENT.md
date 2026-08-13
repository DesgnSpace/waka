# Deployment

FreeResend is a long-running Bun HTTP server. Docker Compose is the supported deployment path. The project does not support the old Vercel, Next.js, or Node.js deployment instructions that were previously in this file.

Read [SETUP.md](SETUP.md) for the environment variable table, SES permissions, SES sandbox, DNS, and webhook setup. This file only covers deployment.

## Production with Docker Compose

`docker-compose.yml` starts a PostgreSQL 16 container and the FreeResend API. The API runs migrations before it accepts requests.

1. Create the environment file:

   ```bash
   cp .env.example .env
   ```

2. Set real values in `.env`, including `NEXTAUTH_SECRET`, both admin values, and the three AWS values.

3. Start the stack:

   ```bash
   docker compose up --build -d
   ```

4. Check the API:

   ```bash
   curl http://localhost:3000/api/health
   docker compose ps
   ```

For production:

- Publish port `3000` through an HTTPS reverse proxy or load balancer.
- Use a strong `NEXTAUTH_SECRET` and a strong PostgreSQL password.
- Use `NODE_ENV=production` so the dashboard cookie is marked `Secure`.
- Set `DATABASE_SSL=require` when the database endpoint requires verified TLS.
- Store `.env` outside source control. `.env` is ignored and is not copied into the image.
- Replace the local PostgreSQL service with a managed PostgreSQL service when you need backups and high availability; set `DATABASE_URL` to that service.
- Set `DOMAIN` or `CORS_ORIGIN` only when browser clients need cross-origin access.
- Configure the SES SNS webhook with the public HTTPS URL described in [SETUP.md](SETUP.md).

Stop the stack with `docker compose down`. Add `-v` only when you intend to delete the local PostgreSQL data volume.

## Updates and operations

Rebuild the app image after each release and restart the stack:

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f waka
```

Back up PostgreSQL before upgrades. Do not run `docker compose down -v` unless the local database data is no longer needed.

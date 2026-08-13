# Deployment

Waka is a long-running Bun HTTP server. Docker Compose is the supported deployment path. The project does not support the old Vercel, Next.js, or Node.js deployment instructions that were previously in this file.

Read [SETUP.md](SETUP.md) for the environment variable table, SES permissions, SES sandbox, DNS, and webhook setup. This file only covers deployment.

## Production with Docker Compose

`docker-compose.yml` starts a PostgreSQL 16 container and the Waka API. The API runs migrations before it accepts requests.

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

## Upgrade from the previous product name

This upgrade changes the PostgreSQL database name and login role from the values used by the previous release to `waka`. It keeps the existing database in place and does not drop or recreate it.

Run these steps in order while the app is stopped:

1. Stop only the app container. Keep PostgreSQL running:

   ```bash
   docker compose stop waka
   ```

2. Set connection variables for the current database and an administrator connection to the PostgreSQL maintenance database. Replace the placeholders with the values from the current deployment:

   ```bash
   export OLD_DATABASE_URL='postgresql://<current-user>:<password>@<host>:5432/<current-database>'
   export ADMIN_DATABASE_URL='postgresql://<admin-user>:<password>@<host>:5432/postgres'
   export OLD_DATABASE_NAME='<current-database-name>'
   export OLD_DATABASE_USER='<current-database-user>'
   export NEW_DATABASE_URL='postgresql://waka:<password>@<host>:5432/waka'
   ```

3. Create a backup before changing names:

   ```bash
   pg_dump --format=custom --file=waka-before-rename.dump "$OLD_DATABASE_URL"
   ```

4. Rename the existing database and role. These commands preserve all rows, tables, indexes, and migration history:

   ```bash
   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$OLD_DATABASE_NAME\" RENAME TO waka;"
   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "ALTER ROLE \"$OLD_DATABASE_USER\" RENAME TO waka;"
   ```

5. Update the environment file to use the renamed role and database. Keep the existing password unless you also change it in PostgreSQL:

   ```bash
   perl -0pi -e 's/^DATABASE_URL=.*/DATABASE_URL=$ENV{NEW_DATABASE_URL}/m' .env
   ```

6. Confirm the new connection before starting the app:

   ```bash
   psql "$NEW_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT current_database(), current_user;'
   ```

7. Start Waka. Startup migrations are safe to run against the existing schema:

   ```bash
   docker compose up --build -d
   docker compose ps
   ```

The application environment variable names do not change. `DATABASE_URL` keeps the same key; only its default connection value changes to the `waka` role and database. `POSTGRES_PASSWORD` also keeps the same key and password.

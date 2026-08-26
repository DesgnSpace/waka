import * as Sentry from "@sentry/bun";

// Opt-in error telemetry: set SENTRY_DSN to enable, leave unset for a no-op.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? "development",
});

import { serveOptions } from "@/server/app";
import { migrate } from "@/lib/migrate";
import { bindServer } from "@/lib/rate-limit";

const port = Number(process.env.PORT ?? 3000);

// Apply pending schema migrations before accepting traffic. Fail fast: a
// half-migrated schema serving requests is worse than a failed deploy.
try {
  await migrate();
} catch (err) {
  Sentry.captureException(err);
  await Sentry.flush(2000);
  throw err;
}

// Drop-in replacement for the previous Next.js app: identical /api/* paths,
// JSON shapes, auth, and env, plus an HTMX dashboard. Business logic is reused
// unchanged from src/lib.
const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  ...serveOptions(),
});

console.log(`waka listening on http://${server.hostname}:${server.port}`);
bindServer(server);

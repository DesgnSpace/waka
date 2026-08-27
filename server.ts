import * as Sentry from "@sentry/bun";

// Opt-in error telemetry: set SENTRY_DSN to enable, leave unset for a no-op.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? "development",
});

import { serveOptions } from "@/server/app";
import { migrate } from "@/lib/migrate";
import { purgeExpiredIdempotencyKeys } from "@/lib/idempotency";
import { purgeExpiredRateLimitBuckets } from "@/lib/rate-limit";
import { startPruneJob } from "@/lib/prune";
import { startScheduledSendJob } from "@/lib/scheduled-sends";
import { startOutboundWebhookJob } from "@/lib/outbound-webhooks";
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

// Delete expired idempotency keys hourly. Concurrent containers may run this
// at once; a duplicate delete is harmless. Each pass schedules the next only
// after it settles, so passes never overlap.
const IDEMPOTENCY_PURGE_INTERVAL_MS = 60 * 60 * 1000;
function scheduleIdempotencyPurge(): void {
  setTimeout(() => {
    purgeExpiredIdempotencyKeys()
      .catch((err: unknown) => console.error("Failed to purge expired idempotency keys:", err))
      .finally(scheduleIdempotencyPurge);
  }, IDEMPOTENCY_PURGE_INTERVAL_MS);
}
scheduleIdempotencyPurge();

const RATE_LIMIT_PURGE_INTERVAL_MS = 60 * 60 * 1000;
function scheduleRateLimitPurge(): void {
  setTimeout(() => {
    purgeExpiredRateLimitBuckets()
      .catch((err: unknown) => console.error("Failed to purge expired rate-limit buckets:", err))
      .finally(scheduleRateLimitPurge);
  }, RATE_LIMIT_PURGE_INTERVAL_MS);
}
if (typeof (Bun as unknown as { cron?: unknown }).cron === "function") {
  (Bun as unknown as { cron: (expr: string, fn: () => Promise<void>) => void }).cron(
    "0 * * * *",
    purgeExpiredRateLimitBuckets,
  );
} else {
  scheduleRateLimitPurge();
}

// Nightly retention job: clears old email bodies and raw webhook payloads.
startPruneJob();

// Minute-by-minute worker: delivers emails scheduled for a future send time.
startScheduledSendJob();

// Minute-by-minute worker: delivers email events to registered customer endpoints.
startOutboundWebhookJob();

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

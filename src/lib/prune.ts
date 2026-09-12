import * as Sentry from "@sentry/bun";
import type { PoolClient } from "pg";
import { db } from "./database";

// App-wide advisory lock so concurrent containers (rolling deploys) never
// prune simultaneously; the second waits, finds little left, and moves on.
// Advisory lock keys in use: 724242 migrate, 724243 prune, 724244 outbound
// webhooks, 724245 rate-limit purge.
const PRUNE_LOCK_KEY = 724_243;

const BATCH_SIZE = 500;
export const DEFAULT_RETENTION_DAYS = 90;

// Nightly at 03:00 server time.
const PRUNE_SCHEDULE = "0 3 * * *";

// Returns the retention window in days, or null when retention is off.
// Unset falls back to the default; zero or negative keeps everything; a
// non-integer value keeps everything too, since pruning on a misparsed
// config deletes more than intended.
export function parseRetentionDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days)) {
    console.warn(`Ignoring invalid LOG_RETENTION_DAYS "${raw}"; expected an integer number of days.`);
    return null;
  }
  return days > 0 ? days : null;
}

export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

// A full batch may leave more rows behind; anything smaller means the table
// has no further qualifying rows older than the cutoff.
export function isLastBatch(updated: number): boolean {
  return updated < BATCH_SIZE;
}

async function clearInBatches(
  client: PoolClient,
  sql: string,
  cutoff: Date,
): Promise<number> {
  let cleared = 0;
  for (;;) {
    const result = await client.query(sql, [cutoff, BATCH_SIZE]);
    const updated = result.rowCount ?? 0;
    cleared += updated;
    if (isLastBatch(updated)) break;
  }
  return cleared;
}

// Empties oversized columns on rows past the cutoff instead of deleting the
// rows, so send and delivery history survives without the payloads:
//   email_logs      html_content, text_content, webhook_data -> NULL
//   webhook_events  event_data                               -> '{}' (NOT NULL column)
export async function pruneOnce(
  retentionDays: number,
): Promise<{ logs: number; events: number }> {
  const cutoff = retentionCutoff(new Date(), retentionDays);
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [PRUNE_LOCK_KEY]);
    const logs = await clearInBatches(
      client,
      `UPDATE email_logs
       SET html_content = NULL, text_content = NULL, webhook_data = NULL
       WHERE id IN (
         SELECT id FROM email_logs
         WHERE created_at < $1
           AND (html_content IS NOT NULL OR text_content IS NOT NULL OR webhook_data IS NOT NULL)
         LIMIT $2
       )`,
      cutoff,
    );
    const events = await clearInBatches(
      client,
      `UPDATE webhook_events
       SET event_data = '{}'::jsonb
       WHERE id IN (
         SELECT id FROM webhook_events
         WHERE created_at < $1 AND event_data <> '{}'::jsonb
         LIMIT $2
       )`,
      cutoff,
    );
    return { logs, events };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [PRUNE_LOCK_KEY]);
    client.release();
  }
}

export function startPruneJob(): void {
  const days = parseRetentionDays(process.env.LOG_RETENTION_DAYS);
  if (days === null) return;
  Bun.cron(PRUNE_SCHEDULE, async () => {
    try {
      const { logs, events } = await pruneOnce(days);
      if (logs > 0 || events > 0) {
        console.log(
          `Retention: cleared bodies from ${logs} emails and payloads from ${events} webhook events`,
        );
      }
    } catch (err) {
      console.error("Retention prune failed:", err);
      Sentry.captureException(err);
    }
  });
}

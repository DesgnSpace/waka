import { db, query } from "./database";

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const result = await query(
    `INSERT INTO rate_limit_buckets (bucket_key, window_started_at, request_count)
     VALUES ($1, NOW(), 1)
     ON CONFLICT (bucket_key) DO UPDATE SET
       window_started_at = CASE
         WHEN rate_limit_buckets.window_started_at <= NOW() - ($3::bigint * INTERVAL '1 millisecond')
           THEN NOW()
         ELSE rate_limit_buckets.window_started_at
       END,
       request_count = CASE
         WHEN rate_limit_buckets.window_started_at <= NOW() - ($3::bigint * INTERVAL '1 millisecond')
           THEN 1
         ELSE rate_limit_buckets.request_count + 1
       END
     WHERE rate_limit_buckets.window_started_at <= NOW() - ($3::bigint * INTERVAL '1 millisecond')
        OR rate_limit_buckets.request_count < $2
     RETURNING window_started_at, request_count`,
    [key, limit, windowMs],
  );

  if (result.rowCount === 1) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.ceil(windowMs / 1000),
  };
}

const RATE_LIMIT_PURGE_LOCK_KEY = 724_243;

export async function purgeExpiredRateLimitBuckets(): Promise<void> {
  const client = await db.connect();
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [
      RATE_LIMIT_PURGE_LOCK_KEY,
    ]);
    if (!lock.rows[0]?.acquired) return;
    try {
      await client.query(
        "DELETE FROM rate_limit_buckets WHERE window_started_at < NOW() - INTERVAL '1 day'",
      );
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [RATE_LIMIT_PURGE_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export function requestAddress(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || req.headers.get("x-real-ip")?.trim();
  return (address || "unknown").slice(0, 128);
}

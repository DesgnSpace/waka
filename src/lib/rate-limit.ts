import type { Server } from "bun";

import { db, query, transaction } from "./database";

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const result = await transaction(async (client) => {
    await client.query(
      "DELETE FROM rate_limit_buckets WHERE window_started_at < NOW() - INTERVAL '1 day'",
    );
    return client.query(
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
  });

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

// Set once after Bun.serve() so requestAddress can read the socket address.
let bunServer: Server<undefined> | null = null;

export function bindServer(server: Server<undefined>): void {
  bunServer = server;
}

function peerAddress(req: Request): string | null {
  try {
    return bunServer?.requestIP(req)?.address ?? null;
  } catch {
    return null;
  }
}

const TRUST_PROXY_VALUES = new Set(["1", "true", "yes"]);

function proxyTrusted(): boolean {
  return TRUST_PROXY_VALUES.has((process.env.TRUST_PROXY ?? "").trim().toLowerCase());
}

// Proxies append to X-Forwarded-For, so only the last entry was written by the
// trusted hop; everything to its left is supplied by the client.
function lastForwardedValue(value: string): string {
  const entries = value.split(",");
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index].trim();
    if (entry) return entry;
  }
  return "";
}

export function requestAddress(req: Request): string {
  if (proxyTrusted()) {
    const forwarded = req.headers.get("x-forwarded-for");
    const proxyClient = forwarded ? lastForwardedValue(forwarded) : "";
    const address =
      req.headers.get("x-real-ip")?.trim() || proxyClient || peerAddress(req) || "unknown";
    return address.slice(0, 128);
  }
  return (peerAddress(req) || "unknown").slice(0, 128);
}

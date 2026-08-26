import type { Server } from "bun";

import { transaction } from "./database";

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

function firstForwardedValue(value: string): string {
  // With one trusted proxy the leftmost entry is the originating client;
  // every later entry was appended by a proxy and is attacker-writable.
  return value.split(",")[0].trim();
}

export function requestAddress(req: Request): string {
  if (proxyTrusted()) {
    const forwarded = req.headers.get("x-forwarded-for");
    const client = forwarded ? firstForwardedValue(forwarded) : "";
    const address = client || req.headers.get("x-real-ip")?.trim() || peerAddress(req) || "unknown";
    return address.slice(0, 128);
  }
  return (peerAddress(req) || "unknown").slice(0, 128);
}

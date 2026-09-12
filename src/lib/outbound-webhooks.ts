import crypto from "node:crypto";
import net from "node:net";
import { lookup } from "node:dns/promises";
import * as Sentry from "@sentry/bun";
import { db, query, transaction } from "./database";

export const WEBHOOK_TIMESTAMP_HEADER = "X-Waka-Timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "X-Waka-Signature";
export const WEBHOOK_SIGNATURE_VERSION = "v1";

export const MAX_DELIVERY_ATTEMPTS = 8;
export const INITIAL_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 60 * 60 * 4;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const DELIVERY_BATCH_SIZE = 25;
export const DISABLE_AFTER_CONSECUTIVE_FAILURES = 5;
export const OUTBOUND_LOCK_KEY = 724_244;
export const OUTBOUND_CRON_SCHEDULE = "* * * * *";

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function buildSignedString(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(buildSignedString(timestamp, rawBody)).digest("hex");
}

export function buildSignatureHeader(signature: string): string {
  return `${WEBHOOK_SIGNATURE_VERSION}=${signature}`;
}

export function verifySignature(secret: string, timestamp: string, rawBody: string, headerValue: string): boolean {
  const expected = buildSignatureHeader(computeSignature(secret, timestamp, rawBody));
  if (expected.length !== headerValue.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerValue));
}

export function backoffDelaySeconds(attempts: number): number {
  if (attempts <= 0) return 0;
  const exp = INITIAL_DELAY_SECONDS * Math.pow(2, attempts - 1);
  return Math.min(exp, MAX_DELAY_SECONDS);
}

export function nextAttemptAt(attempts: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + backoffDelaySeconds(attempts) * 1000);
}

export type DeliveryPlan =
  | { action: "retry"; retryAt: Date }
  | { action: "dead" };

export function planAfterDeliveryFailure(attempts: number, now: Date = new Date()): DeliveryPlan {
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return { action: "dead" };
  return { action: "retry", retryAt: nextAttemptAt(attempts, now) };
}

function isIPv4Private(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

function isIPv6Private(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;
  if (lower.includes(".")) {
    const lastColon = lower.lastIndexOf(":");
    const v4 = lower.slice(lastColon + 1);
    if (net.isIP(v4) === 4 && isIPv4Private(v4)) return true;
  }
  if (lower === "::ffff:127.0.0.1") return true;
  return false;
}

export function isPrivateIP(host: string): boolean {
  const clean = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = net.isIP(clean);
  if (family === 4) return isIPv4Private(clean);
  if (family === 6) return isIPv6Private(clean);
  return false;
}

function isBlockedHostname(host: string): boolean {
  const clean = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const h = clean.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return false;
}

export function isValidWebhookUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    if (!url.hostname) return false;
    if (url.username || url.password) return false;
    const host = url.hostname;
    if (isBlockedHostname(host)) return false;
    if (isPrivateIP(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export function shouldRetryWebhookStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

async function isDeliveryUrlBlocked(urlStr: string): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(urlStr).hostname;
  } catch {
    return true;
  }
  if (isBlockedHostname(hostname)) return true;
  if (isPrivateIP(hostname)) return true;
  const clean = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (net.isIP(clean) !== 0) return false;
  try {
    const addresses = await lookup(hostname, { all: true });
    for (const a of addresses) {
      if (isPrivateIP(a.address)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export interface WebhookEndpointRow {
  id: string;
  user_id: string;
  url: string;
  secret: string;
  enabled: boolean;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  email_log_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  next_attempt_at: string;
  status: string;
  last_error: string | null;
  last_status_code: number | null;
  created_at: string;
  updated_at: string;
}

export async function createWebhookEndpoint(userId: string, url: string): Promise<WebhookEndpointRow & { secret: string }> {
  if (!isValidWebhookUrl(url)) {
    throw new Error("URL must be a valid public HTTPS URL — private, loopback, and link-local addresses are not allowed.");
  }
  const secret = generateWebhookSecret();
  const result = await query<WebhookEndpointRow>(
    `INSERT INTO webhook_endpoints (user_id, url, secret) VALUES ($1, $2, $3)
     RETURNING id, user_id, url, secret, enabled, consecutive_failures, created_at, updated_at`,
    [userId, url, secret],
  );
  return result.rows[0] as WebhookEndpointRow & { secret: string };
}

export async function listWebhookEndpoints(userId: string): Promise<Omit<WebhookEndpointRow, "secret">[]> {
  const result = await query<Omit<WebhookEndpointRow, "secret">>(
    `SELECT id, user_id, url, enabled, consecutive_failures, created_at, updated_at
     FROM webhook_endpoints WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows as Omit<WebhookEndpointRow, "secret">[];
}

export async function deleteWebhookEndpoint(id: string, userId: string): Promise<void> {
  const result = await query(`DELETE FROM webhook_endpoints WHERE id = $1 AND user_id = $2`, [id, userId]);
  if ((result.rowCount ?? 0) === 0) throw new Error("Webhook endpoint not found.");
}

export async function getWebhookEndpointSecret(id: string, userId: string): Promise<string> {
  const result = await query<{ secret: string }>(
    `SELECT secret FROM webhook_endpoints WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (result.rows.length === 0) throw new Error("Webhook endpoint not found.");
  return result.rows[0].secret;
}

export async function rotateWebhookEndpointSecret(id: string, userId: string): Promise<string> {
  const secret = generateWebhookSecret();
  const result = await query(
    `UPDATE webhook_endpoints SET secret = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
    [secret, id, userId],
  );
  if ((result.rowCount ?? 0) === 0) throw new Error("Webhook endpoint not found.");
  return secret;
}

export async function enqueueOutboundDeliveries(
  emailLogId: string,
  domainId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const rawPayload = JSON.stringify(payload);
  return transaction(async (client) => {
    const endpoints = await client.query<WebhookEndpointRow>(
      `SELECT id, user_id, url, secret, enabled, consecutive_failures, created_at, updated_at
       FROM webhook_endpoints
       WHERE user_id = (SELECT user_id FROM domains WHERE id = $1)
         AND enabled = true`,
      [domainId],
    );
    if (endpoints.rows.length === 0) return 0;
    let inserted = 0;
    for (const ep of endpoints.rows) {
      await client.query(
        `INSERT INTO webhook_deliveries (endpoint_id, email_log_id, event_type, payload, attempts, next_attempt_at, status)
         VALUES ($1, $2, $3, $4::jsonb, 0, NOW(), 'pending')`,
        [ep.id, emailLogId, eventType, rawPayload],
      );
      inserted += 1;
    }
    return inserted;
  });
}

export interface DeliveryAttemptResult {
  status: "success" | "retry" | "dead";
  statusCode: number | null;
  error: string | null;
}

async function deliverOnce(
  delivery: WebhookDeliveryRow & { url: string; secret: string },
  rawBody: string,
): Promise<DeliveryAttemptResult> {
  if (await isDeliveryUrlBlocked(delivery.url)) {
    return { status: "dead", statusCode: null, error: "Webhook URL resolves to a private or blocked address" };
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = computeSignature(delivery.secret, timestamp, rawBody);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "waka-webhooks/1.0",
        [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
        [WEBHOOK_SIGNATURE_HEADER]: buildSignatureHeader(signature),
      },
      body: rawBody,
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.ok) return { status: "success", statusCode: res.status, error: null };
    if (res.status >= 300 && res.status < 400) {
      return { status: "dead", statusCode: res.status, error: `HTTP ${res.status}: redirects are not followed` };
    }
    const text = await res.text().catch(() => "");
    const retry = shouldRetryWebhookStatus(res.status);
    return { status: retry ? "retry" : "dead", statusCode: res.status, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 500)}` : ""}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "retry", statusCode: null, error: message.slice(0, 1000) };
  } finally {
    clearTimeout(timeout);
  }
}

async function claimPendingDeliveries(): Promise<Array<WebhookDeliveryRow & { url: string; secret: string }>> {
  return transaction(async (client) => {
    const result = await client.query<WebhookDeliveryRow & { url: string; secret: string }>(
      `WITH due AS (
         SELECT wd.id FROM webhook_deliveries wd
         WHERE wd.status = 'pending' AND wd.next_attempt_at <= NOW()
         ORDER BY wd.next_attempt_at ASC, wd.id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE webhook_deliveries wd
       SET attempts = wd.attempts + 1, updated_at = NOW()
       FROM due
       WHERE wd.id = due.id
       RETURNING wd.*, (SELECT url FROM webhook_endpoints we WHERE we.id = wd.endpoint_id) as url,
                 (SELECT secret FROM webhook_endpoints we WHERE we.id = wd.endpoint_id) as secret`,
      [DELIVERY_BATCH_SIZE],
    );
    return result.rows as Array<WebhookDeliveryRow & { url: string; secret: string }>;
  });
}

export interface OutboundTickResult {
  success: number;
  retried: number;
  dead: number;
}

const OUTBOUND_CONCURRENCY = 5;

export async function runOutboundWebhookTick(): Promise<OutboundTickResult> {
  const deliveries = await claimPendingDeliveries();
  const counts: OutboundTickResult = { success: 0, retried: 0, dead: 0 };

  async function handleDelivery(d: (typeof deliveries)[number]): Promise<void> {
    const rawBody = typeof d.payload === "string" ? d.payload : JSON.stringify(d.payload);
    const result = await deliverOnce(d, rawBody);
    if (result.status === "success") {
      await query(
        `UPDATE webhook_deliveries SET status = 'success', last_status_code = $2, last_error = NULL, updated_at = NOW() WHERE id = $1`,
        [d.id, result.statusCode],
      );
      await query(`UPDATE webhook_endpoints SET consecutive_failures = 0, updated_at = NOW() WHERE id = $1`, [d.endpoint_id]);
      counts.success += 1;
    } else {
      const plan = result.status === "dead" ? ({ action: "dead" } as const) : planAfterDeliveryFailure(d.attempts);
      if (plan.action === "dead") {
        await query(
          `UPDATE webhook_deliveries SET status = 'dead', last_error = $2, last_status_code = $3, updated_at = NOW() WHERE id = $1`,
          [d.id, result.error, result.statusCode],
        );
        const ep = await query<{ consecutive_failures: number; enabled: boolean }>(
          `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1, updated_at = NOW() WHERE id = $1 RETURNING consecutive_failures, enabled`,
          [d.endpoint_id],
        );
        const failures = ep.rows[0]?.consecutive_failures ?? 0;
        if (failures >= DISABLE_AFTER_CONSECUTIVE_FAILURES) {
          await query(`UPDATE webhook_endpoints SET enabled = false, updated_at = NOW() WHERE id = $1`, [d.endpoint_id]);
        }
        counts.dead += 1;
      } else {
        await query(
          `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = $2, last_error = $3, last_status_code = $4, updated_at = NOW() WHERE id = $1`,
          [d.id, plan.retryAt, result.error, result.statusCode],
        );
        counts.retried += 1;
      }
    }
  }

  for (let i = 0; i < deliveries.length; i += OUTBOUND_CONCURRENCY) {
    const chunk = deliveries.slice(i, i + OUTBOUND_CONCURRENCY);
    await Promise.all(chunk.map(handleDelivery));
  }
  return counts;
}

export function startOutboundWebhookJob(): Bun.CronJob {
  return Bun.cron(
    OUTBOUND_CRON_SCHEDULE,
    async () => {
      const client = await db.connect();
      let acquired = false;
      try {
        const res = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [OUTBOUND_LOCK_KEY]);
        acquired = Boolean(res.rows[0]?.acquired);
        if (!acquired) return;
        try {
          const { success, retried, dead } = await runOutboundWebhookTick();
          if (success + retried + dead > 0) {
            console.log(`Outbound webhooks: ${success} delivered, ${retried} retrying, ${dead} dead`);
          }
        } catch (err) {
          console.error("Outbound webhook tick failed:", err);
          Sentry.captureException(err);
        }
      } finally {
        if (acquired) await client.query("SELECT pg_advisory_unlock($1)", [OUTBOUND_LOCK_KEY]);
        client.release();
      }
    },
  );
}

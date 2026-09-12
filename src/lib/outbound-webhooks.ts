import crypto from "node:crypto";
import net from "node:net";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
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
export const MAX_ERROR_BODY_BYTES = 4096;
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

const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

// [network, prefix length] for 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16,
// 172.16/12, 192.168/16, 224/4 multicast and 240/4 reserved.
const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0a80000, 16],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function parseIPv4Octets(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function parseHextets(parts: string[], allowEmbeddedIPv4: boolean): number[] | null {
  const bytes: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.includes(".")) {
      if (!allowEmbeddedIPv4 || i !== parts.length - 1) return null;
      const octets = parseIPv4Octets(part);
      if (!octets) return null;
      bytes.push(...octets);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    const value = Number.parseInt(part, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function parseIPv6Bytes(literal: string): Uint8Array | null {
  const halves = literal.split("%")[0].split("::");
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const head = halves[0] ? parseHextets(halves[0].split(":"), !compressed) : [];
  const tail = compressed && halves[1] ? parseHextets(halves[1].split(":"), true) : [];
  if (!head || !tail) return null;
  if (!compressed) return head.length === 16 ? Uint8Array.from(head) : null;
  const gap = 16 - head.length - tail.length;
  if (gap < 1) return null;
  return Uint8Array.from([...head, ...Array<number>(gap).fill(0), ...tail]);
}

function addressBytes(literal: string): Uint8Array | null {
  const family = net.isIP(literal);
  if (family === 4) {
    const octets = parseIPv4Octets(literal);
    return octets ? Uint8Array.from([...IPV4_MAPPED_PREFIX, ...octets]) : null;
  }
  if (family === 6) return parseIPv6Bytes(literal);
  return null;
}

function embedsIPv4(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, 10).some((b) => b !== 0)) return false;
  return (bytes[10] === 0 && bytes[11] === 0) || (bytes[10] === 0xff && bytes[11] === 0xff);
}

function isBlockedIPv4(bytes: Uint8Array): boolean {
  const value = ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
  return BLOCKED_IPV4_RANGES.some(([network, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === network;
  });
}

function isBlockedAddress(bytes: Uint8Array): boolean {
  if (embedsIPv4(bytes)) return isBlockedIPv4(bytes);
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xff) return true;
  return false;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function isPrivateIP(host: string): boolean {
  const bracketed = host.startsWith("[") && host.endsWith("]");
  const bytes = addressBytes(bracketed ? host.slice(1, -1) : host);
  return bytes ? isBlockedAddress(bytes) : bracketed;
}

function isBlockedHostname(host: string): boolean {
  const h = stripBrackets(host).toLowerCase();
  return h === "localhost" || h.endsWith(".localhost");
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

export async function isDeliveryUrlBlocked(urlStr: string): Promise<boolean> {
  let hostname: string;
  try {
    hostname = new URL(urlStr).hostname;
  } catch {
    return true;
  }
  if (isBlockedHostname(hostname)) return true;
  if (isPrivateIP(hostname)) return true;
  if (net.isIP(stripBrackets(hostname)) !== 0) return false;
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return true;
  }
  if (addresses.length === 0) return true;
  return addresses.some((a) => isPrivateIP(a.address));
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

async function readErrorBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    return "";
  } finally {
    reader.cancel().catch(() => {});
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(buffer.subarray(0, MAX_ERROR_BODY_BYTES));
}

async function deliverOnce(
  delivery: WebhookDeliveryRow & { url: string; secret: string },
  rawBody: string,
): Promise<DeliveryAttemptResult> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = computeSignature(delivery.secret, timestamp, rawBody);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    if (await isDeliveryUrlBlocked(delivery.url)) {
      return { status: "dead", statusCode: null, error: "Webhook URL resolves to a private or blocked address" };
    }
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
    const text = await readErrorBody(res);
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

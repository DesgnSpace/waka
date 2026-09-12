import * as Sentry from "@sentry/bun";
import { query, transaction, type DbRow } from "./database";
import { errorMessage } from "./errors";
import { sendEmail, type EmailAttachment } from "./ses";
import { bareAddress, findSuppressed } from "./suppression";

// Cron granularity is one minute, matching Resend's scheduling precision.
const CRON_SCHEDULE = "* * * * *";

// A message gets MAX_SEND_ATTEMPTS delivery tries in total — counting claims
// reclaimed after a crash, so a poison message cannot loop forever — and then
// stops in terminal 'failed'. Attempts between retries wait
// RETRY_DELAY_SECONDS so transient SES errors can clear.
export const MAX_SEND_ATTEMPTS = 5;
export const RETRY_DELAY_SECONDS = 300;
// A claimed row whose updated_at is older than this was left behind by a
// process that died between claiming and sending, and becomes claimable again.
export const STALE_CLAIM_SECONDS = 600;
export const CLAIM_BATCH_SIZE = 25;
// Matches Resend's maximum scheduling horizon.
const MAX_HORIZON_MS = 72 * 3600 * 1000;

export type ScheduleParse =
  | { ok: true; at: Date | null }
  | { ok: false; reason: string };

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|z|[+-]\d{2}:?\d{2})?)?$/;
const RELATIVE_OFFSET = /^in\s+(\d+)\s+(second|minute|hour|day)s?$/i;

// JavaScript Date parsing silently rolls impossible dates forward (Feb 30 ->
// Mar 2), so the calendar fields are checked before trusting a timestamp.
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

// Accepts what Resend accepts for scheduled_at: an ISO-8601 timestamp, a
// relative offset like "in 10 minutes", or nothing (send immediately). Times
// already in the past are valid and simply become due immediately. Timestamps
// without a zone suffix are read in the server's local timezone.
export function parseScheduledAt(
  raw: string | null | undefined,
  now: Date = new Date(),
): ScheduleParse {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { ok: true, at: null };
  }
  const input = raw.trim();
  let at: Date;
  const iso = ISO_TIMESTAMP.exec(input);
  if (iso) {
    const [, year, month, day, hour, minute, second] = iso;
    if (
      !isValidCalendarDate(Number(year), Number(month), Number(day)) ||
      (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? "0") > 60))
    ) {
      return { ok: false, reason: `Invalid scheduled_at "${input}". Use ISO 8601 or "in <n> minutes".` };
    }
    at = new Date(input);
  } else {
    const match = RELATIVE_OFFSET.exec(input);
    if (!match) {
      return { ok: false, reason: `Invalid scheduled_at "${input}". Use ISO 8601 or "in <n> minutes".` };
    }
    at = new Date(now.getTime() + Number(match[1]) * UNIT_MS[match[2].toLowerCase()]);
  }
  if (at.getTime() - now.getTime() > MAX_HORIZON_MS) {
    return { ok: false, reason: "scheduled_at can be at most 72 hours in the future." };
  }
  return { ok: true, at };
}

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export interface DueCandidate {
  status: string;
  scheduled_at: Date | string | null;
  updated_at: Date | string;
}

// Mirrors the WHERE clause of claimDueSends(): a row needs the worker when it
// is scheduled and its time has arrived, or when it was claimed long enough
// ago that its process must have died before confirming.
export function isDue(row: DueCandidate, now: Date = new Date()): boolean {
  if (row.status === "scheduled") {
    return row.scheduled_at !== null && toMs(row.scheduled_at) <= now.getTime();
  }
  if (row.status === "sending") {
    return toMs(row.updated_at) < now.getTime() - STALE_CLAIM_SECONDS * 1000;
  }
  return false;
}

export type AttemptPlan =
  | { action: "retry"; retryAt: Date }
  | { action: "abandon" };

// Decides the next state after a failed delivery attempt; attempts includes
// the attempt that just failed.
export function planAfterFailure(attempts: number, now: Date = new Date()): AttemptPlan {
  if (attempts >= MAX_SEND_ATTEMPTS) return { action: "abandon" };
  return { action: "retry", retryAt: new Date(now.getTime() + RETRY_DELAY_SECONDS * 1000) };
}

// The exact request body to send later. Stored whole so a claim needs no
// reconstruction from display columns, which keep attachments as metadata only.
interface StoredPayload {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: EmailAttachment[];
  replyTo?: string[];
  tags?: Array<{ name: string; value: string }>;
}

export interface AttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
}

export interface ScheduleEmailInput {
  apiKeyId: string;
  domainId: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: EmailAttachment[];
  attachmentMeta: AttachmentMeta[];
  replyTo?: string[];
  tags?: Array<{ name: string; value: string }>;
  sendAt: Date;
}

// Records an accepted message that the worker delivers once sendAt arrives.
export async function storeScheduledEmail(input: ScheduleEmailInput): Promise<string> {
  const payload: StoredPayload = {
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html,
    text: input.text,
    attachments: input.attachments,
    replyTo: input.replyTo,
    tags: input.tags,
  };
  const result = await query<{ id: string }>(
    `INSERT INTO email_logs (
       api_key_id, domain_id, from_email, to_emails, cc_emails, bcc_emails,
       subject, html_content, text_content, attachments, status, scheduled_at,
       payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      input.apiKeyId,
      input.domainId,
      input.from,
      JSON.stringify(input.to),
      JSON.stringify(input.cc ?? []),
      JSON.stringify(input.bcc ?? []),
      input.subject,
      input.html ?? null,
      input.text ?? null,
      JSON.stringify(input.attachmentMeta),
      "scheduled",
      input.sendAt,
      JSON.stringify(payload),
    ],
  );
  return result.rows[0].id;
}

type ClaimedRow = DbRow<{
  id: string;
  domain_id: string;
  send_attempts: number;
  payload: unknown;
}>;

type CurrentDeliveryState = DbRow<{
  api_key_id: string | null;
  expires_at: Date | string | null;
  domain_status: string | null;
}>;

async function claimDueSends(): Promise<ClaimedRow[]> {
  return transaction(async (client) => {
    // SKIP LOCKED lets concurrent containers share the queue without ever
    // claiming the same message twice.
    const result = await client.query<ClaimedRow>(
      `WITH due AS (
         SELECT id FROM email_logs
         WHERE (status = 'scheduled' AND scheduled_at <= NOW())
            OR (status = 'sending' AND updated_at < NOW() - ($1::text || ' seconds')::interval)
         ORDER BY scheduled_at ASC NULLS LAST, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE email_logs el
       SET status = 'sending', send_attempts = el.send_attempts + 1
       FROM due
       WHERE el.id = due.id
       RETURNING el.id, el.domain_id, el.send_attempts, el.payload`,
      [String(STALE_CLAIM_SECONDS), CLAIM_BATCH_SIZE],
    );
    return result.rows;
  });
}

type DeliveryOutcome = "sent" | "retried" | "failed";

class PermanentDeliveryError extends Error {}

async function validateCurrentDelivery(row: ClaimedRow, payload: StoredPayload): Promise<void> {
  const state = await query<CurrentDeliveryState>(
    `SELECT ak.id AS api_key_id, ak.expires_at, d.status AS domain_status
     FROM email_logs el
     LEFT JOIN api_keys ak ON ak.id = el.api_key_id
     LEFT JOIN domains d ON d.id = el.domain_id
     WHERE el.id = $1`,
    [row.id],
  );
  const current = state.rows[0];

  if (!current?.api_key_id) {
    throw new PermanentDeliveryError("API key revoked");
  }
  if (current.expires_at && new Date(current.expires_at).getTime() <= Date.now()) {
    throw new PermanentDeliveryError("API key expired");
  }
  if (current.domain_status !== "verified") {
    throw new PermanentDeliveryError("Domain no longer verified");
  }

  const recipients = [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])].map(bareAddress);
  const suppressed = await findSuppressed(row.domain_id, recipients);
  if (suppressed.length === 0) return;

  const list = suppressed.join(", ");
  const message =
    suppressed.length === 1
      ? `Recipient ${list} previously bounced or was marked as spam for this domain and won't receive mail. Remove it from the suppression list to send again.`
      : `Recipients ${list} previously bounced or were marked as spam for this domain and won't receive mail. Remove them from the suppression list to send again.`;
  throw new PermanentDeliveryError(message);
}

async function deliver(row: ClaimedRow): Promise<DeliveryOutcome> {
  try {
    const payload = row.payload as StoredPayload | null;
    if (!payload || typeof payload.from !== "string") {
      throw new Error("Scheduled email has no stored payload");
    }
    await validateCurrentDelivery(row, payload);
    const messageId = await sendEmail(payload);
    await query(
      `UPDATE email_logs
       SET status = 'sent', ses_message_id = $2, error_message = NULL, payload = NULL
       WHERE id = $1`,
      [row.id, messageId],
    );
    return "sent";
  } catch (err) {
    const reason = errorMessage(err);
    if (err instanceof PermanentDeliveryError) {
      await query(`UPDATE email_logs SET status = 'failed', error_message = $2 WHERE id = $1`, [
        row.id,
        reason,
      ]);
      return "failed";
    }
    const plan = planAfterFailure(row.send_attempts);
    if (plan.action === "abandon") {
      await query(`UPDATE email_logs SET status = 'failed', error_message = $2 WHERE id = $1`, [
        row.id,
        reason,
      ]);
      return "failed";
    }
    await query(
      `UPDATE email_logs SET status = 'scheduled', scheduled_at = $2, error_message = $3 WHERE id = $1`,
      [row.id, plan.retryAt, reason],
    );
    return "retried";
  }
}

export interface TickResult {
  sent: number;
  retried: number;
  failed: number;
}

export async function runScheduledSendTick(): Promise<TickResult> {
  const rows = await claimDueSends();
  const settled = await Promise.allSettled(rows.map(deliver));
  const counts: TickResult = { sent: 0, retried: 0, failed: 0 };
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") counts[outcome.value] += 1;
    else console.error("Scheduled send could not be recorded:", outcome.reason);
  }
  return counts;
}

// Registers the minute-by-minute worker and returns its handle so callers can
// stop it. Bun never overlaps fires — the next one is scheduled only after the
// previous tick settles — so a slow batch cannot stack ticks.
export function startScheduledSendJob(): Bun.CronJob {
  return Bun.cron(CRON_SCHEDULE, async () => {
    try {
      const { sent, retried, failed } = await runScheduledSendTick();
      if (sent + retried + failed > 0) {
        console.log(`Scheduled sends: ${sent} sent, ${retried} waiting to retry, ${failed} failed`);
      }
    } catch (err) {
      console.error("Scheduled send tick failed:", err);
      Sentry.captureException(err);
    }
  });
}

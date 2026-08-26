import { z } from "zod";
import { promises as dns } from "node:dns";

import {
  json,
  requireUser,
  requireApiKey,
  HttpError,
  jsonBody,
  pathUuid,
  type Req,
} from "./http";
import { authenticateUser, createUser, generateJWT } from "@/lib/auth";
import {
  addDomain,
  getUserDomains,
  getDomainById,
  deleteDomain,
  checkDomainVerification,
} from "@/lib/domains";
import {
  generateApiKey,
  getUserApiKeys,
  deleteApiKey,
  updateApiKeyLimits,
  updateApiKeyPermissions,
} from "@/lib/api-keys";
import { sendEmail } from "@/lib/ses";
import {
  analyzeEmailDnsRecords,
  normalizeDkimSelector,
  normalizeDomain,
} from "@/lib/email-dns-readiness";
import { query, type DbRow } from "@/lib/database";
import { errorCode, errorHttpStatus, errorMessage, errorName } from "@/lib/errors";
import { checkRateLimit, requestAddress } from "@/lib/rate-limit";
import { reserveApiKeyDailySend, reserveDailySend } from "@/lib/quotas";
import { parseScheduledAt, storeScheduledEmail } from "@/lib/scheduled-sends";
import {
  completeIdempotencyKey,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
} from "@/lib/idempotency";
import { parseJsonArray, parseJsonObject } from "@/lib/serialization";
import { findSuppressed, listSuppressions, removeSuppression } from "@/lib/suppression";

type DomainIdRow = DbRow<{ id: string }>;
type EmailLogRow = DbRow<{
  id: string;
  api_key_id: string | null;
  domain_id: string;
  message_id: string | null;
  from_email: string;
  to_emails: unknown;
  cc_emails: unknown;
  bcc_emails: unknown;
  subject: string | null;
  html_content: string | null;
  text_content: string | null;
  attachments: unknown;
  status: string;
  ses_message_id: string | null;
  error_message: string | null;
  webhook_data: unknown;
  created_at: string;
  updated_at: string;
  domain_name: string | null;
  api_key_name: string | null;
}>;
type EmailDetailRow = EmailLogRow & { domain_user_id: string };
type EmailCountRow = DbRow<{ count: string }>;
type WebhookEventRow = DbRow<{
  id: string;
  event_type: string;
  event_data: unknown;
  created_at: string;
}>;

// ----------------------------------------------------------------------------
// health + setup
// ----------------------------------------------------------------------------

export function health(): Response {
  return json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "Waka",
    version: "1.0.0",
  });
}

export async function setup(): Promise<Response> {
  throw new HttpError(404, { error: "Not found" });
}

// ----------------------------------------------------------------------------
// auth
// ----------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email("Invalid email format").max(255).transform((email) => email.toLowerCase()),
  password: z.string().min(1, "Password is required").max(200).refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "Password is too long",
  ),
});

export async function login(req: Req): Promise<Response> {
  const { email, password } = loginSchema.parse(await jsonBody(req));
  const ipRate = await checkRateLimit(`auth:login:${requestAddress(req)}`, 10, 60_000);
  const emailRate = await checkRateLimit(`auth:login:${email}`, 10, 60_000);
  if (!ipRate.allowed || !emailRate.allowed) {
    throw new HttpError(429, { error: "Too many sign-in attempts. Try again later." });
  }
  const user = await authenticateUser(email, password);
  if (!user) return json({ error: "Invalid email or password" }, 401);
  const token = generateJWT(user);
  return json({ success: true, data: { user, token } });
}

const signupSchema = z.object({
  email: z.string().email("Invalid email format").max(255).transform((email) => email.toLowerCase()),
  password: z.string().min(12, "Password must be at least 12 characters").max(200).refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "Password is too long",
  ),
  name: z.string().trim().min(1).max(255).optional(),
});

export async function signup(req: Req): Promise<Response> {
  const { email, password, name } = signupSchema.parse(await jsonBody(req));
  const ipRate = await checkRateLimit(`auth:signup:${requestAddress(req)}`, 3, 60 * 60_000);
  const emailRate = await checkRateLimit(`auth:signup:${email}`, 3, 60 * 60_000);
  const globalRate = await checkRateLimit("auth:signup:global", 100, 60 * 60_000);
  if (!ipRate.allowed || !emailRate.allowed || !globalRate.allowed) {
    throw new HttpError(429, { error: "Too many sign-up attempts. Try again later." });
  }

  const signupResponse = () =>
    json({ success: true, message: "If the email can be used, sign in to continue." }, 202);
  try {
    await createUser(email, password, name);
  } catch (error) {
    if (errorCode(error) === "23505") {
      return signupResponse();
    }
    throw error;
  }

  return signupResponse();
}

export function me(req: Req): Response {
  const user = requireUser(req);
  return json({ success: true, data: { user } });
}

// ----------------------------------------------------------------------------
// domains
// ----------------------------------------------------------------------------

const addDomainSchema = z.object({ domain: z.string().min(1, "Domain is required") });

export async function listDomains(req: Req): Promise<Response> {
  const user = requireUser(req);
  const domains = await getUserDomains(user.id);
  return json({ success: true, data: { domains } });
}

export async function createDomain(req: Req): Promise<Response> {
  const user = requireUser(req);
  const { domain } = addDomainSchema.parse(await jsonBody(req));
  const result = await addDomain(user.id, domain);
  return json({ success: true, data: result });
}

export async function getDomain(req: Req): Promise<Response> {
  const user = requireUser(req);
  const domain = await getDomainById(pathUuid(req), user.id);
  if (!domain) {
    return json({ error: "Domain not found" }, 404);
  }
  return json({ success: true, data: { domain } });
}

export async function removeDomain(req: Req): Promise<Response> {
  const user = requireUser(req);
  await deleteDomain(pathUuid(req), user.id);
  return json({ success: true, message: "Domain deleted." });
}

export async function verifyDomain(req: Req): Promise<Response> {
  const user = requireUser(req);
  const domainId = pathUuid(req);
  const domain = await getDomainById(domainId, user.id);
  if (!domain) {
    return json({ error: "Domain not found" }, 404);
  }
  const status = await checkDomainVerification(domainId, user.id);
  return json({
    success: true,
    data: { status, verified: status === "verified" },
    message:
      status === "verified"
        ? "Domain verified."
        : "Domain verification is pending. Check DNS records and try again.",
  });
}

export async function listSuppressionsHandler(req: Req): Promise<Response> {
  const user = requireUser(req);
  const domainId = pathUuid(req);
  const domain = await getDomainById(domainId, user.id);
  if (!domain) return json({ error: "Domain not found" }, 404);
  const suppressions = await listSuppressions(domainId);
  return json({ success: true, data: { suppressions } });
}

export async function removeSuppressionHandler(req: Req): Promise<Response> {
  const user = requireUser(req);
  const domainId = pathUuid(req);
  const domain = await getDomainById(domainId, user.id);
  if (!domain) return json({ error: "Domain not found" }, 404);
  const raw = req.params.email ? decodeURIComponent(req.params.email) : "";
  const email = raw.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Provide a valid email address." }, 400);
  }
  const removed = await removeSuppression(domainId, email);
  if (!removed) return json({ error: "Suppression not found" }, 404);
  return json({ success: true, message: "Suppression removed." });
}


// ----------------------------------------------------------------------------
// api keys
// ----------------------------------------------------------------------------

const limitField = z.number().int().min(1).max(1_000_000).nullable().optional();
const createApiKeySchema = z.object({
  domainId: z.string().uuid("Invalid domain ID"),
  keyName: z.string().trim().min(1, "Key name is required").max(255),
  permissions: z.array(z.enum(["send", "receive", "webhooks"])).max(3).optional().default(["send"]),
  rateLimitPerMinute: limitField,
  dailySendLimit: limitField,
});

const updateApiKeySchema = z.object({
  permissions: z.array(z.enum(["send", "receive", "webhooks"])).min(1).max(3).optional(),
  rateLimitPerMinute: limitField,
  dailySendLimit: limitField,
}).refine((v) => v.permissions !== undefined || v.rateLimitPerMinute !== undefined || v.dailySendLimit !== undefined, {
  message: "Provide at least one field to update.",
});

export async function listApiKeys(req: Req): Promise<Response> {
  const user = requireUser(req);
  const apiKeys = await getUserApiKeys(user.id);
  return json({ success: true, data: { apiKeys } });
}

export async function createApiKey(req: Req): Promise<Response> {
  const user = requireUser(req);
  const { domainId, keyName, permissions, rateLimitPerMinute, dailySendLimit } =
    createApiKeySchema.parse(await jsonBody(req));

  const domain = await getDomainById(domainId, user.id);
  if (!domain) {
    return json({ error: "Domain not found or you don't have access." }, 404);
  }
  if (domain.status !== "verified") {
    return json({ error: "Verify the domain before creating API keys." }, 400);
  }

  const apiKey = await generateApiKey(user.id, domainId, keyName, permissions, {
    rateLimitPerMinute: rateLimitPerMinute ?? null,
    dailySendLimit: dailySendLimit ?? null,
  });
  return json({
    success: true,
    data: { apiKey },
    message: "API key created. Copy it now — it won't be shown again.",
  });
}

export async function updateApiKey(req: Req): Promise<Response> {
  const user = requireUser(req);
  const { permissions, rateLimitPerMinute, dailySendLimit } =
    updateApiKeySchema.parse(await jsonBody(req));
  if (permissions !== undefined) {
    await updateApiKeyPermissions(pathUuid(req), user.id, permissions);
  }
  if (rateLimitPerMinute !== undefined || dailySendLimit !== undefined) {
    await updateApiKeyLimits(pathUuid(req), user.id, {
      ...(rateLimitPerMinute !== undefined ? { rateLimitPerMinute } : {}),
      ...(dailySendLimit !== undefined ? { dailySendLimit } : {}),
    });
  }
  return json({ success: true, message: "API key updated." });
}

export async function removeApiKey(req: Req): Promise<Response> {
  const user = requireUser(req);
  await deleteApiKey(pathUuid(req), user.id);
  return json({ success: true, message: "API key deleted." });
}

// ----------------------------------------------------------------------------
// emails (send + logs)
// ----------------------------------------------------------------------------

const MAX_ATTACHMENTS = 20;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024; // SES raw-message hard limit
const decodedBase64Bytes = (b64: string) =>
  Math.floor(b64.replace(/\s+/g, "").length * 0.75);

const SEND_IN_PROGRESS =
  "An email with this Idempotency-Key is still being processed. Wait a moment and retry.";

const MAX_BATCH_SIZE = 100;

function jsonResponse(data: unknown, status: number, extraHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

// No header means no idempotency; a present but empty or oversized value is a
// bad request rather than a silently ignored header.
function idempotencyKeyOf(req: Req): string | null {
  const header = req.headers.get("idempotency-key");
  if (header === null) return null;
  const key = header.trim();
  if (!key || key.length > 255) {
    throw new HttpError(400, {
      error: "The Idempotency-Key header must be between 1 and 255 characters.",
    });
  }
  return key;
}

// Extract the bare address from "Name <addr@host>" (or return it unchanged).
function bareAddress(input: string): string {
  const m = input.match(/<([^>]+)>/);
  return (m ? m[1] : input).trim();
}

const attachmentSchema = z.object({
  filename: z.string().min(1).regex(/^[^\r\n"]+$/, "Invalid attachment filename"),
  content: z
    .string()
    .refine((c) => /^[A-Za-z0-9+/]+={0,2}$/.test(c.replace(/\s+/g, "")), {
      message: "Attachment content must be base64-encoded.",
    }),
  contentType: z.string().regex(/^[^\r\n]+$/, "Invalid content type").optional(),
  content_type: z.string().regex(/^[^\r\n]+$/, "Invalid content type").optional(), // Resend uses snake_case
}).passthrough();

// Resend accepts addresses as "addr@host" or "Name <addr@host>", and
// to/cc/bcc/reply_to as either a single string or an array. Normalize to arrays
// and validate loosely (display names allowed) for drop-in Resend compatibility.
const addressField = z
  .string()
  .max(320)
  .refine((v) => !/[\r\n]/.test(v), "Invalid email address")
  .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bareAddress(v)), "Invalid email address");
const asArray = (v: unknown) => (typeof v === "string" ? [v] : v);

const sendEmailSchema = z
  .object({
    from: addressField,
     to: z.preprocess(asArray, z.array(addressField).min(1, "Add at least one recipient.").max(100)),
     cc: z.preprocess(asArray, z.array(addressField).max(100).optional()),
     bcc: z.preprocess(asArray, z.array(addressField).max(100).optional()),
    subject: z
      .string()
      .min(1, "Subject is required.")
      .max(500)
      .regex(/^[^\r\n]*$/, "Subject can't contain line breaks."),
    // Some clients send the unused body as null (not omitted) — accept null too.
    html: z.string().max(10 * 1024 * 1024).nullish().transform((v) => v ?? undefined),
    text: z.string().max(10 * 1024 * 1024).nullish().transform((v) => v ?? undefined),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
    reply_to: z.preprocess(asArray, z.array(addressField).max(20).optional()),
    // Resend tags are [{name,value}]; clients commonly send this key even when
    // empty ([]). Also accept a legacy { k: v } record. Empty/absent => undefined.
    tags: z.preprocess(
      (v) => {
        if (v == null) return undefined;
        if (Array.isArray(v)) return v;
        if (typeof v === "object" && v !== null) {
          const record = z.record(z.unknown()).parse(v);
          return Object.entries(record).map(([name, value]) => ({ name, value: String(value) }));
        }
        return v;
      },
      z.array(z.object({ name: z.string().min(1).max(256), value: z.string().max(256) })).max(50).optional()
    ),
    scheduled_at: z.string().max(64).optional(),
  })
  .refine((data) => data.html || data.text, {
    message: "Include either html or text content.",
  })
  .refine(
    (data) =>
      (data.attachments ?? []).reduce((sum, a) => sum + decodedBase64Bytes(a.content), 0) <=
      MAX_TOTAL_ATTACHMENT_BYTES,
    { message: "Attachments must be 10 MB or smaller in total." }
  );

type ValidatedSend = z.infer<typeof sendEmailSchema>;

async function deliverOne(
  apiKey: { id: string; user_id: string; rate_limit_per_minute: number | null; daily_send_limit: number | null },
  domain: { id: string; domain: string },
  data: ValidatedSend,
  reqForAddress: Request,
): Promise<{ id: string; from: string; to: string[]; created_at: string }> {
  const { from, to, cc, bcc, subject, html, text, attachments, reply_to, tags } = data;

  if (bareAddress(from).split("@")[1]?.toLowerCase() !== domain.domain.toLowerCase()) {
    throw new HttpError(400, { error: `From email must use the domain ${domain.domain}.` });
  }

  {
    const allRecipients = [...to, ...(cc ?? []), ...(bcc ?? [])].map((a) => bareAddress(a));
    const suppressed = await findSuppressed(domain.id, allRecipients);
    if (suppressed.length > 0) {
      const list = suppressed.join(", ");
      const error =
        suppressed.length === 1
          ? `Recipient ${list} previously bounced or was marked as spam for this domain and won't receive mail. Remove it from the suppression list to send again.`
          : `Recipients ${list} previously bounced or were marked as spam for this domain and won't receive mail. Remove them from the suppression list to send again.`;
      throw new HttpError(400, { error, message: error, suppressed });
    }
  }

  const schedule = parseScheduledAt(data.scheduled_at);
  if (!schedule.ok) throw new HttpError(422, { error: schedule.reason });

  if (apiKey.rate_limit_per_minute != null) {
    const perKeyRate = await checkRateLimit(`send:key:${apiKey.id}`, apiKey.rate_limit_per_minute, 60_000);
    if (!perKeyRate.allowed) {
      throw new HttpError(429, { error: "This API key has reached its per-minute limit. Wait a moment and try again, or raise the limit for this key." });
    }
  }
  const sendRate = await checkRateLimit(`send:${apiKey.user_id}`, 60, 60_000);
  const ipRate = await checkRateLimit(`send-ip:${requestAddress(reqForAddress)}`, 20, 60_000);
  if (!sendRate.allowed || !ipRate.allowed) {
    throw new HttpError(429, { error: "Sending too quickly. Try again later." });
  }
  if (apiKey.daily_send_limit != null) {
    if (!(await reserveApiKeyDailySend(apiKey.id, apiKey.daily_send_limit))) {
      throw new HttpError(429, { error: "This API key has reached its daily sending limit." });
    }
  }
  if (!(await reserveDailySend(apiKey.user_id))) {
    throw new HttpError(429, { error: "Daily sending limit reached." });
  }

  const sesAttachments = attachments?.map((att) => ({
    filename: att.filename,
    content: att.content,
    contentType: att.contentType || att.content_type || "application/octet-stream",
  }));

  const attachmentMeta = (attachments ?? []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType || a.content_type || "application/octet-stream",
    size: decodedBase64Bytes(a.content),
  }));

  if (schedule.at) {
    try {
      const id = await storeScheduledEmail({
        apiKeyId: apiKey.id,
        domainId: domain.id,
        from,
        to,
        cc,
        bcc,
        subject,
        html,
        text,
        attachments: sesAttachments,
        attachmentMeta,
        replyTo: reply_to,
        tags,
        sendAt: schedule.at,
      });
      return { id, from, to, created_at: new Date().toISOString() };
    } catch (error) {
      console.error("Failed to record scheduled email:", error);
      throw new HttpError(500, {
        error: "Could not schedule the email. Nothing was queued.",
        message: "Could not schedule the email. Nothing was queued.",
      });
    }
  }

  let messageId: string;
  try {
    messageId = await sendEmail({
      from,
      to,
      cc,
      bcc,
      subject,
      html,
      text,
      attachments: sesAttachments,
      replyTo: reply_to,
      tags,
    });
  } catch (err) {
    const name = errorName(err);
    const reason = errorMessage(err);
    const statusCode = errorHttpStatus(err) ?? 0;
    console.error("SES send failed:", name, reason);
    const detail = reason || "Email provider rejected the message.";
    try {
      await query(
        `INSERT INTO email_logs (
            api_key_id, domain_id, from_email, to_emails, cc_emails, bcc_emails,
            subject, html_content, text_content, attachments, status, ses_message_id, error_message
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          apiKey.id,
          domain.id,
          from,
          JSON.stringify(to),
          JSON.stringify(cc || []),
          JSON.stringify(bcc || []),
          subject,
          html,
          text,
          JSON.stringify(attachmentMeta),
          "failed",
          null,
          name ? `${name}: ${detail}` : detail,
        ]
      );
    } catch (logError) {
      console.error("Failed to record rejected email:", logError);
    }
    const status = statusCode >= 400 && statusCode < 500 ? statusCode : 502;
    throw new HttpError(status, { error: detail, message: detail, code: name });
  }

  try {
    const result = await query<{ id: string }>(
      `INSERT INTO email_logs (
          api_key_id, domain_id, from_email, to_emails, cc_emails, bcc_emails,
          subject, html_content, text_content, attachments, status, ses_message_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id`,
      [
        apiKey.id,
        domain.id,
        from,
        JSON.stringify(to),
        JSON.stringify(cc || []),
        JSON.stringify(bcc || []),
        subject,
        html,
        text,
        JSON.stringify(attachmentMeta),
        "sent",
        messageId,
      ]
    );
    const emailLogId = result.rows[0]?.id;
    return {
      id: emailLogId || messageId,
      from,
      to,
      created_at: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Failed to record sent email:", error);
    throw new HttpError(500, {
      error: "Email sent but could not be recorded.",
      message: "Email sent but could not be recorded.",
      id: messageId,
      from,
      to,
      created_at: new Date().toISOString(),
    });
  }
}

export async function sendEmailHandler(req: Req): Promise<Response> {
  const apiKey = await requireApiKey(req);
  if (!apiKey.permissions.includes("send")) {
    return json({ error: "This API key can't send email. Create a key with send permission." }, 403);
  }

  const idempotencyKey = idempotencyKeyOf(req);
  const parsed = sendEmailSchema.parse(await jsonBody(req));

  const domain = await getDomainById(apiKey.domain_id, apiKey.user_id);
  if (!domain) return json({ error: "Domain not found" }, 404);
  if (domain.status !== "verified") return json({ error: "Domain isn't verified. Verify DNS and try again." }, 400);

  let claim: { id: string } | null = null;
  if (idempotencyKey) {
    const reservation = await reserveIdempotencyKey(apiKey.id, idempotencyKey);
    if (reservation.kind === "replay") {
      return jsonResponse(reservation.body, reservation.status, { "idempotency-replayed": "true" });
    }
    if (reservation.kind === "conflict") {
      return jsonResponse({ error: SEND_IN_PROGRESS, message: SEND_IN_PROGRESS }, 409, { "retry-after": "1" });
    }
    claim = reservation;
  }

  try {
    const result = await deliverOne(apiKey, domain, parsed, req);
    if (claim) {
      await completeIdempotencyKey(claim.id, 200, result);
      claim = null;
    }
    return json(result);
  } catch (err) {
    if (claim) {
      if (
        err instanceof HttpError &&
        err.status === 500 &&
        typeof (err.body as Record<string, unknown>)?.error === "string" &&
        String((err.body as Record<string, unknown>).error).includes("could not be recorded")
      ) {
        const b = err.body as Record<string, unknown>;
        const success = { id: b.id, from: b.from, to: b.to, created_at: b.created_at };
        try {
          await completeIdempotencyKey(claim.id, 200, success);
        } catch (completeError) {
          console.error("Failed to store idempotent outcome:", completeError);
        }
      } else {
        await releaseIdempotencyKey(claim.id);
      }
    }
    if (err instanceof HttpError && err.status === 400) {
      return json(err.body, 400);
    }
    throw err;
  }
}

export async function sendBatchHandler(req: Req): Promise<Response> {
  const apiKey = await requireApiKey(req);
  if (!apiKey.permissions.includes("send")) {
    return json({ error: "This API key can't send email. Create a key with send permission." }, 403);
  }

  const idempotencyKey = idempotencyKeyOf(req);
  let claim: { id: string } | null = null;
  if (idempotencyKey) {
    const reservation = await reserveIdempotencyKey(apiKey.id, idempotencyKey);
    if (reservation.kind === "replay") {
      return jsonResponse(reservation.body, reservation.status, { "idempotency-replayed": "true" });
    }
    if (reservation.kind === "conflict") {
      return jsonResponse({ error: SEND_IN_PROGRESS, message: SEND_IN_PROGRESS }, 409, { "retry-after": "1" });
    }
    claim = reservation;
  }

  const rawBody = await jsonBody(req);
  if (!Array.isArray(rawBody)) {
    if (claim) await releaseIdempotencyKey(claim.id);
    throw new HttpError(400, { error: "Request body must be a JSON array of email objects." });
  }
  if (rawBody.length === 0) {
    if (claim) await releaseIdempotencyKey(claim.id);
    throw new HttpError(400, { error: "Batch must contain at least one email." });
  }
  if (rawBody.length > MAX_BATCH_SIZE) {
    if (claim) await releaseIdempotencyKey(claim.id);
    throw new HttpError(400, { error: `Batch size exceeds maximum of ${MAX_BATCH_SIZE} emails.` });
  }

  const domain = await getDomainById(apiKey.domain_id, apiKey.user_id);
  if (!domain) {
    if (claim) await releaseIdempotencyKey(claim.id);
    return json({ error: "Domain not found" }, 404);
  }
  if (domain.status !== "verified") {
    if (claim) await releaseIdempotencyKey(claim.id);
    return json({ error: "Domain isn't verified. Verify DNS and try again." }, 400);
  }

  const results: Array<Record<string, unknown>> = [];
  let hasSuccess = false;
  let hasError = false;

  for (let i = 0; i < rawBody.length; i++) {
    const raw = rawBody[i];
    let parsed: ValidatedSend;
    try {
      parsed = sendEmailSchema.parse(raw);
    } catch (err) {
      hasError = true;
      if (err instanceof z.ZodError) {
        const reasons = err.issues.map((iss) => {
          const path = iss.path.join(".");
          return path ? `${path}: ${iss.message}` : iss.message;
        });
        const reason = reasons.length ? reasons.join("; ") : "Invalid request data";
        results.push({ error: reason, message: reason, statusCode: 422, details: err.issues });
      } else {
        results.push({ error: errorMessage(err), message: errorMessage(err), statusCode: 422 });
      }
      continue;
    }

    try {
      const delivered = await deliverOne(apiKey, domain, parsed, req);
      hasSuccess = true;
      results.push(delivered as unknown as Record<string, unknown>);
    } catch (err) {
      hasError = true;
      if (err instanceof HttpError) {
        const body = err.body as Record<string, unknown>;
        results.push({ statusCode: err.status, ...body });
      } else if (err instanceof z.ZodError) {
        const reasons = err.issues.map((iss) => {
          const path = iss.path.join(".");
          return path ? `${path}: ${iss.message}` : iss.message;
        });
        const reason = reasons.length ? reasons.join("; ") : "Invalid request data";
        results.push({ error: reason, message: reason, statusCode: 422, details: err.issues });
      } else {
        const msg = errorMessage(err);
        results.push({ error: msg, message: msg, statusCode: 500 });
      }
    }
  }

  const responseBody = { data: results };
  const status = hasError && hasSuccess ? 207 : hasError ? 207 : 200;

  if (claim) {
    try {
      await completeIdempotencyKey(claim.id, status, responseBody);
    } catch (completeError) {
      console.error("Failed to store idempotent batch outcome:", completeError);
    }
  }

  return jsonResponse(responseBody, status, {});
}

export async function emailLogs(req: Req): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return json({ error: "Missing authorization header" }, 401);
  }

  const url = new URL(req.url);
  const params = z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    domain_id: z.string().uuid().optional(),
    status: z
      .enum(["pending", "sent", "failed", "delivered", "bounced", "complained", "scheduled", "sending"])
      .optional(),
  }).parse(Object.fromEntries(url.searchParams));
  const { page, limit, domain_id: domainId, status } = params;
  const offset = (page - 1) * limit;

  let domainIds: string[] = [];
  let scopedUserId: string | null = null;
  if (auth.startsWith("Bearer wka_")) {
    const apiKey = await requireApiKey(req);
    domainIds = [apiKey.domain_id];
    scopedUserId = apiKey.user_id;
  } else {
    const user = requireUser(req);
    scopedUserId = user.id;
    const result = await query<DomainIdRow>("SELECT id FROM domains WHERE user_id = $1", [user.id]);
    domainIds = result.rows.map((d) => d.id);
  }

  if (domainIds.length === 0) {
    return json({
      success: true,
      data: { emails: [], pagination: { page, limit, total: 0, totalPages: 0 } },
    });
  }

  const queryParams: (string | string[] | number | null)[] = [
    domainIds,
    domainId ?? null,
    status ?? null,
    scopedUserId,
  ];

  const countResult = await query<EmailCountRow>(
    `SELECT COUNT(*) as count FROM email_logs el
     WHERE el.domain_id = ANY($1)
       AND ($2::uuid IS NULL OR el.domain_id = $2)
       AND ($3::text IS NULL OR el.status = $3)
       AND EXISTS (SELECT 1 FROM domains d WHERE d.id = el.domain_id AND d.user_id = $4)`,
    queryParams
  );
  const totalCount = parseInt(countResult.rows[0].count);

  const emailLogsResult = await query<EmailLogRow>(
     `SELECT el.*, d.domain as domain_name, ak.key_name as api_key_name
      FROM email_logs el
      JOIN domains d ON el.domain_id = d.id AND d.user_id = $4
     LEFT JOIN api_keys ak ON el.api_key_id = ak.id
       AND ak.user_id = d.user_id AND ak.domain_id = el.domain_id
     WHERE el.domain_id = ANY($1)
       AND ($2::uuid IS NULL OR el.domain_id = $2)
       AND ($3::text IS NULL OR el.status = $3)
     ORDER BY el.created_at DESC
     LIMIT $5 OFFSET $6`,
     [...queryParams, limit, offset]
  );

  // payload carries the raw scheduled request body (attachment bytes included)
  // and is for the sender, never for API readers.
  const emails = emailLogsResult.rows.map(({ payload: _payload, ...row }) => ({
    ...row,
    to_emails: parseJsonArray(row.to_emails, "to_emails"),
    cc_emails: parseJsonArray(row.cc_emails, "cc_emails"),
    bcc_emails: parseJsonArray(row.bcc_emails, "bcc_emails"),
    attachments: parseJsonArray(row.attachments, "attachments"),
    domains: row.domain_name ? { domain: row.domain_name } : null,
    api_keys: row.api_key_name ? { key_name: row.api_key_name } : null,
  }));

  return json({
    success: true,
    data: {
      emails,
      pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) },
    },
  });
}

export async function getEmail(req: Req): Promise<Response> {
  const user = requireUser(req);
  const emailResult = await query<EmailDetailRow>(
    `SELECT el.*, d.domain as domain_name, d.user_id as domain_user_id, ak.key_name as api_key_name
     FROM email_logs el
     JOIN domains d ON el.domain_id = d.id AND d.user_id = $2
     LEFT JOIN api_keys ak ON el.api_key_id = ak.id
       AND ak.user_id = d.user_id AND ak.domain_id = el.domain_id
     WHERE el.id = $1`,
    [pathUuid(req), user.id]
  );
  if (emailResult.rows.length === 0) return json({ error: "Email not found" }, 404);

  const emailData = emailResult.rows[0];
  const webhookResult = await query<WebhookEventRow>(
    `SELECT id, event_type, event_data, created_at
      FROM webhook_events we
      JOIN email_logs el ON el.id = we.email_log_id
      JOIN domains d ON d.id = el.domain_id AND d.user_id = $2
      WHERE we.email_log_id = $1
      ORDER BY we.created_at DESC`,
    [pathUuid(req), user.id]
  );

  const email = {
    ...emailData,
    to_emails: parseJsonArray(emailData.to_emails, "to_emails"),
    cc_emails: parseJsonArray(emailData.cc_emails, "cc_emails"),
    bcc_emails: parseJsonArray(emailData.bcc_emails, "bcc_emails"),
    attachments: parseJsonArray(emailData.attachments, "attachments"),
    domains: { domain: emailData.domain_name, user_id: emailData.domain_user_id },
    api_keys: emailData.api_key_name ? { key_name: emailData.api_key_name } : null,
    webhook_events: webhookResult.rows.map((row) => ({
      ...row,
      event_data: parseJsonObject(row.event_data, "event_data"),
    })),
  };

  return json({ success: true, data: { email } });
}

// ----------------------------------------------------------------------------
// tools: email DNS checker (no auth, parity with original)
// ----------------------------------------------------------------------------

async function resolveTxt(name: string, errors: string[]): Promise<string[]> {
  try {
    const records = await dns.resolveTxt(name);
    return records.map((parts) => parts.join(""));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "ENOENT") return [];
    errors.push(`${name}: TXT lookup failed`);
    return [];
  }
}

async function resolveMx(name: string, errors: string[]): Promise<string[]> {
  try {
    const records = await dns.resolveMx(name);
    return records.sort((a, b) => a.priority - b.priority).map((r) => `${r.priority} ${r.exchange}`);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "ENOENT") return [];
    errors.push(`${name}: MX lookup failed`);
    return [];
  }
}

async function resolveCname(name: string, errors: string[]): Promise<string[]> {
  try {
    return await dns.resolveCname(name);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "ENOENT") return [];
    errors.push(`${name}: CNAME lookup failed`);
    return [];
  }
}

export async function emailDnsChecker(req: Req): Promise<Response> {
  const body = z.object({
    domain: z.string().min(1),
    dkimSelector: z.string().nullable().optional(),
  }).parse(await jsonBody(req));

  try {
    const domain = normalizeDomain(body.domain);
    const dkimSelector = normalizeDkimSelector(body.dkimSelector);
    const lookupErrors: string[] = [];
    const dkimName = dkimSelector ? `${dkimSelector}._domainkey.${domain}` : null;

    const [rootTxt, dmarcTxt, mxRecords, dkimTxtRecords, dkimCnameRecords] = await Promise.all([
      resolveTxt(domain, lookupErrors),
      resolveTxt(`_dmarc.${domain}`, lookupErrors),
      resolveMx(domain, lookupErrors),
      dkimName ? resolveTxt(dkimName, lookupErrors) : Promise.resolve([]),
      dkimName ? resolveCname(dkimName, lookupErrors) : Promise.resolve([]),
    ]);

    return json(
      analyzeEmailDnsRecords({
        domain,
        dkimSelector,
        spfRecords: rootTxt,
        dmarcRecords: dmarcTxt,
        dkimTxtRecords,
        dkimCnameRecords,
        mxRecords,
        lookupErrors,
      })
    );
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
}

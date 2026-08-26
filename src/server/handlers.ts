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
  updateApiKey as updateApiKeyRecord,
} from "@/lib/api-keys";
import { sendEmail } from "@/lib/ses";
import {
  analyzeEmailDnsRecords,
  normalizeDkimSelector,
  normalizeDomain,
} from "@/lib/email-dns-readiness";
import { query, transaction, type DbRow } from "@/lib/database";
import { createHealthChecker } from "@/lib/health-check";
import { errorCode, errorHttpStatus, errorMessage, errorName } from "@/lib/errors";
import { checkRateLimit, requestAddress } from "@/lib/rate-limit";
import { reserveDailySend } from "@/lib/quotas";
import { parseJsonArray, parseJsonObject } from "@/lib/serialization";
import { searchEmailLogs } from "@/lib/email-logs";

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
// health
// ----------------------------------------------------------------------------

const healthChecks = createHealthChecker((run) => transaction((client) => run(client)));

export async function health(): Promise<Response> {
  const report = await healthChecks.report();
  return json(report, report.status === "healthy" ? 200 : 503);
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


// ----------------------------------------------------------------------------
// api keys
// ----------------------------------------------------------------------------

const expiresAtInput = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z
    .union([
      z
        .string()
        .refine((s) => !isNaN(Date.parse(s)), { message: "Invalid expiry date. Use ISO 8601 format." }),
      z.null(),
    ])
    .optional()
);

const createApiKeySchema = z.object({
  domainId: z.string().uuid("Invalid domain ID"),
  keyName: z.string().trim().min(1, "Key name is required").max(255),
  permissions: z.array(z.enum(["send"])).max(1).optional().default(["send"]),
  expiresAt: expiresAtInput,
  expires_at: expiresAtInput.optional(),
});

const updateApiKeySchema = z
  .object({
    permissions: z.array(z.enum(["send"])).min(1).max(1).optional(),
    expiresAt: expiresAtInput,
    expires_at: expiresAtInput.optional(),
  })
  .refine((d) => d.permissions !== undefined || d.expiresAt !== undefined || d.expires_at !== undefined, {
    message: "Provide permissions or expiresAt to update.",
  });

export async function listApiKeys(req: Req): Promise<Response> {
  const user = requireUser(req);
  const apiKeys = await getUserApiKeys(user.id);
  return json({ success: true, data: { apiKeys } });
}

export async function createApiKey(req: Req): Promise<Response> {
  const user = requireUser(req);
  const parsed = createApiKeySchema.parse(await jsonBody(req));
  const domainId = parsed.domainId;
  const keyName = parsed.keyName;
  const permissions = parsed.permissions;
  const expiresAt = parsed.expiresAt ?? parsed.expires_at ?? null;

  const domain = await getDomainById(domainId, user.id);
  if (!domain) {
    return json({ error: "Domain not found or you don't have access." }, 404);
  }
  if (domain.status !== "verified") {
    return json({ error: "Verify the domain before creating API keys." }, 400);
  }

  const apiKey = await generateApiKey(user.id, domainId, keyName, permissions, expiresAt ?? null);
  return json({
    success: true,
    data: { apiKey },
    message: "API key created. Copy it now — it won't be shown again.",
  });
}

export async function updateApiKey(req: Req): Promise<Response> {
  const user = requireUser(req);
  const parsed = updateApiKeySchema.parse(await jsonBody(req));
  const expiresAt = parsed.expiresAt ?? parsed.expires_at;
  await updateApiKeyRecord(pathUuid(req), user.id, {
    permissions: parsed.permissions ?? undefined,
    expiresAt: expiresAt as string | null | undefined,
  });
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

export async function sendEmailHandler(req: Req): Promise<Response> {
  const apiKey = await requireApiKey(req);
  if (!apiKey.permissions.includes("send")) {
    return json({ error: "This API key can't send email. Create a key with send permission." }, 403);
  }

  const { from, to, cc, bcc, subject, html, text, attachments, reply_to, tags } =
    sendEmailSchema.parse(await jsonBody(req));

  const domain = await getDomainById(apiKey.domain_id, apiKey.user_id);
  if (!domain) return json({ error: "Domain not found" }, 404);
  if (domain.status !== "verified") return json({ error: "Domain isn't verified. Verify DNS and try again." }, 400);

  if (bareAddress(from).split("@")[1]?.toLowerCase() !== domain.domain.toLowerCase()) {
    return json({ error: `From email must use the domain ${domain.domain}.` }, 400);
  }

  const sendRate = await checkRateLimit(`send:${apiKey.user_id}`, 60, 60_000);
  const ipRate = await checkRateLimit(`send-ip:${requestAddress(req)}`, 20, 60_000);
  if (!sendRate.allowed || !ipRate.allowed) {
    throw new HttpError(429, { error: "Sending too quickly. Try again later." });
  }
  if (!(await reserveDailySend(apiKey.user_id))) {
    throw new HttpError(429, { error: "Daily sending limit reached." });
  }

  const sesAttachments = attachments?.map((att) => ({
    filename: att.filename,
    content: att.content,
    contentType: att.contentType || att.content_type || "application/octet-stream",
  }));

  // Persist attachment metadata only — never the raw base64 payload.
  const attachmentMeta = (attachments ?? []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType || a.content_type || "application/octet-stream",
    size: decodedBase64Bytes(a.content),
  }));

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
    // Surface the provider's real reason (e.g. "Email address is not verified",
    // "AccessDenied") instead of a blank 500, so the caller can act on it.
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
    throw new HttpError(status, {
      error: detail,
      message: detail,
      code: name,
    });
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
    return json({
      id: emailLogId || messageId,
      from,
      to,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Failed to record sent email:", error);
    throw new HttpError(500, {
      error: "Email sent but could not be recorded.",
      message: "Email sent but could not be recorded.",
    });
  }
}

export async function emailLogs(req: Req): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return json({ error: "Missing authorization header" }, 401);
  }

  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const allowedStatus = ["pending", "sent", "failed", "delivered", "bounced", "complained"] as const;
  const paginated = z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    domain_id: z.string().uuid().optional(),
    status: z.enum(allowedStatus).optional(),
    recipient: z.string().max(320).optional(),
    subject: z.string().max(500).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    from_date: z.string().optional(),
    to_date: z.string().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    message_id: z.string().max(255).optional(),
    messageId: z.string().max(255).optional(),
  }).parse(raw);

  const page = paginated.page;
  const limit = paginated.limit;
  const offset = (page - 1) * limit;

  const recipient = (paginated.recipient ?? "").trim() || undefined;
  const subject = (paginated.subject ?? "").trim() || undefined;
  const fromDate = (paginated.from ?? paginated.from_date ?? paginated.start_date ?? "").trim() || undefined;
  const toDate = (paginated.to ?? paginated.to_date ?? paginated.end_date ?? "").trim() || undefined;
  const messageId = (paginated.message_id ?? paginated.messageId ?? "").trim() || undefined;

  if (fromDate && isNaN(Date.parse(fromDate))) throw new HttpError(400, { error: "Invalid from date. Use ISO 8601." });
  if (toDate && isNaN(Date.parse(toDate))) throw new HttpError(400, { error: "Invalid to date. Use ISO 8601." });

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

  const toIsoEnd = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T23:59:59.999Z`).toISOString() : new Date(v).toISOString();
  const { logs: emails, total: totalCount } = await searchEmailLogs({
    domainIds,
    scopedUserId: scopedUserId!,
    filters: {
      domainId: paginated.domain_id ?? null,
      status: paginated.status ?? null,
      recipient: recipient ?? null,
      subject: subject ?? null,
      fromDate: fromDate ? new Date(fromDate).toISOString() : null,
      toDate: toDate ? toIsoEnd(toDate) : null,
      messageId: messageId ?? null,
    },
    limit,
    offset,
  });

  return json({
    success: true,
    data: {
      emails,
      pagination: { page, limit, total: totalCount, totalPages: Math.ceil(totalCount / limit) },
    },
  });
}

const MAX_USAGE_DAYS = 90;
const DEFAULT_USAGE_DAYS = 30;

function parseUsageDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, { error: `Invalid date: ${value}. Use YYYY-MM-DD.` });
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, { error: `Invalid date: ${value}.` });
  return d;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type UsageRow = DbRow<{
  day: string;
  sent: string;
  delivered: string;
  bounced: string;
  complained: string;
  opened: string;
  clicked: string;
}>;

export async function usage(req: Req): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return json({ error: "Missing authorization header" }, 401);
  }

  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const fromRaw = (raw.from ?? raw.start_date ?? raw.startDate ?? raw.start ?? "") as string | undefined;
  const toRaw = (raw.to ?? raw.end_date ?? raw.endDate ?? raw.end ?? "") as string | undefined;
  const hasFrom = typeof fromRaw === "string" && fromRaw.length > 0;
  const hasTo = typeof toRaw === "string" && toRaw.length > 0;

  const today = new Date();
  const todayStr = toDateOnly(today);

  let fromStr: string;
  let toStr: string;
  if (!hasFrom && !hasTo) {
    const fromDate = new Date(`${todayStr}T00:00:00.000Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - (DEFAULT_USAGE_DAYS - 1));
    fromStr = toDateOnly(fromDate);
    toStr = todayStr;
  } else if (hasFrom && hasTo) {
    fromStr = fromRaw as string;
    toStr = toRaw as string;
  } else if (hasFrom) {
    fromStr = fromRaw as string;
    const fromDate = parseUsageDate(fromStr);
    const toDate = new Date(fromDate);
    toDate.setUTCDate(toDate.getUTCDate() + (DEFAULT_USAGE_DAYS - 1));
    const cappedTo = toDateOnly(toDate);
    toStr = cappedTo > todayStr ? todayStr : cappedTo;
  } else {
    toStr = toRaw as string;
    const toDate = parseUsageDate(toStr);
    const fromDate = new Date(toDate);
    fromDate.setUTCDate(fromDate.getUTCDate() - (DEFAULT_USAGE_DAYS - 1));
    fromStr = toDateOnly(fromDate);
  }

  const fromDate = parseUsageDate(fromStr);
  const toDate = parseUsageDate(toStr);
  if (fromDate.getTime() > toDate.getTime()) {
    throw new HttpError(400, { error: "`from` must be on or before `to`." });
  }
  const daysInclusive = Math.floor((toDate.getTime() - fromDate.getTime()) / 86400000) + 1;
  if (daysInclusive > MAX_USAGE_DAYS) {
    throw new HttpError(400, { error: `Date range too large. Maximum ${MAX_USAGE_DAYS} days.` });
  }

  let domainIds: string[] = [];
  let scopedUserId: string;
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

  const fromParam = toDateOnly(fromDate);
  const toParam = toDateOnly(toDate);

  const result = await query<UsageRow>(
    `WITH days AS (
       SELECT generate_series($2::date, $3::date, '1 day'::interval)::date AS day
     ),
     log_counts AS (
       SELECT date_trunc('day', el.created_at)::date AS day,
         COUNT(*) FILTER (WHERE el.status = 'sent') AS sent,
         COUNT(*) FILTER (WHERE el.status = 'delivered') AS delivered,
         COUNT(*) FILTER (WHERE el.status = 'bounced') AS bounced,
         COUNT(*) FILTER (WHERE el.status = 'complained') AS complained
       FROM email_logs el
       WHERE el.domain_id = ANY($1)
         AND el.created_at >= $2::date::timestamptz
         AND el.created_at < ($3::date + INTERVAL '1 day')::timestamptz
         AND EXISTS (SELECT 1 FROM domains d WHERE d.id = el.domain_id AND d.user_id = $4)
       GROUP BY 1
     ),
     event_counts AS (
       SELECT date_trunc('day', ee.created_at)::date AS day,
         COUNT(*) FILTER (WHERE ee.type = 'open') AS opened,
         COUNT(*) FILTER (WHERE ee.type = 'click') AS clicked
       FROM email_events ee
       JOIN email_logs el ON el.id = ee.email_log_id
       WHERE el.domain_id = ANY($1)
         AND ee.created_at >= $2::date::timestamptz
         AND ee.created_at < ($3::date + INTERVAL '1 day')::timestamptz
         AND EXISTS (SELECT 1 FROM domains d WHERE d.id = el.domain_id AND d.user_id = $4)
       GROUP BY 1
     )
     SELECT
       days.day::text AS day,
       COALESCE(l.sent, 0)::text AS sent,
       COALESCE(l.delivered, 0)::text AS delivered,
       COALESCE(l.bounced, 0)::text AS bounced,
       COALESCE(l.complained, 0)::text AS complained,
       COALESCE(e.opened, 0)::text AS opened,
       COALESCE(e.clicked, 0)::text AS clicked
     FROM days
     LEFT JOIN log_counts l ON l.day = days.day
     LEFT JOIN event_counts e ON e.day = days.day
     ORDER BY days.day`,
    [domainIds, fromParam, toParam, scopedUserId]
  );

  const usage = result.rows.map((row) => ({
    date: row.day.slice(0, 10),
    sent: Number(row.sent),
    delivered: Number(row.delivered),
    bounced: Number(row.bounced),
    complained: Number(row.complained),
    opened: Number(row.opened),
    clicked: Number(row.clicked),
  }));

  return json({ success: true, data: { from: fromParam, to: toParam, usage } });
}

export async function getEmail(req: Req): Promise<Response> {
  let scopedUserId: string;
  let scopedDomainId: string | null = null;
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer wka_")) {
    const apiKey = await requireApiKey(req);
    if (!apiKey.permissions.includes("send")) {
      return json(
        { error: "This API key can't retrieve emails. Create a key with send permission." },
        403,
      );
    }
    scopedUserId = apiKey.user_id;
    scopedDomainId = apiKey.domain_id;
  } else {
    scopedUserId = requireUser(req).id;
  }

  const emailResult = await query<EmailDetailRow>(
    `SELECT el.*, d.domain as domain_name, d.user_id as domain_user_id, ak.key_name as api_key_name
     FROM email_logs el
     JOIN domains d ON el.domain_id = d.id AND d.user_id = $2
     LEFT JOIN api_keys ak ON el.api_key_id = ak.id
       AND ak.user_id = d.user_id AND ak.domain_id = el.domain_id
     WHERE el.id = $1
       AND ($3::uuid IS NULL OR el.domain_id = $3)`,
    [pathUuid(req), scopedUserId, scopedDomainId]
  );
  if (emailResult.rows.length === 0) return json({ error: "Email not found" }, 404);

  const emailData = emailResult.rows[0];
  const webhookResult = await query<WebhookEventRow>(
    `SELECT id, event_type, event_data, created_at
      FROM webhook_events we
      JOIN email_logs el ON el.id = we.email_log_id
      JOIN domains d ON d.id = el.domain_id AND d.user_id = $2
      WHERE we.email_log_id = $1
        AND ($3::uuid IS NULL OR el.domain_id = $3)
      ORDER BY we.created_at DESC`,
    [pathUuid(req), scopedUserId, scopedDomainId]
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

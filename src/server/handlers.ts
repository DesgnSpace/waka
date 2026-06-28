import { z } from "zod";
import { promises as dns } from "node:dns";

import { json, requireUser, requireApiKey, type Req } from "./http";
import { authenticateUser, generateJWT, initializeDefaultUser } from "@/lib/auth";
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
  updateApiKeyPermissions,
} from "@/lib/api-keys";
import { sendEmail } from "@/lib/ses";
import {
  analyzeEmailDnsRecords,
  normalizeDkimSelector,
  normalizeDomain,
} from "@/lib/email-dns-readiness";
import { query } from "@/lib/database";

// JSONB columns can come back as string or already-parsed; normalize to array.
function safeParseEmailArray(value: unknown): unknown[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function safeParseJSON(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

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
  try {
    await initializeDefaultUser();
    return json({ success: true, message: "Default user initialized successfully" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ success: false, error: message }, 500);
  }
}

// ----------------------------------------------------------------------------
// auth
// ----------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});

export async function login(req: Req): Promise<Response> {
  const { email, password } = loginSchema.parse(await req.json());
  const user = await authenticateUser(email, password);
  if (!user) return json({ error: "Invalid email or password" }, 401);
  const token = generateJWT(user);
  return json({ success: true, data: { user, token } });
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
  const { domain } = addDomainSchema.parse(await req.json());
  const result = await addDomain(user.id, domain);
  return json({ success: true, data: result });
}

export async function getDomain(req: Req): Promise<Response> {
  const user = requireUser(req);
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return json({ error: "Domain not found" }, 404);
  }
  return json({ success: true, data: { domain } });
}

export async function removeDomain(req: Req): Promise<Response> {
  const user = requireUser(req);
  await deleteDomain(req.params.id, user.id);
  return json({ success: true, message: "Domain deleted." });
}

export async function verifyDomain(req: Req): Promise<Response> {
  const user = requireUser(req);
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return json({ error: "Domain not found" }, 404);
  }
  const status = await checkDomainVerification(req.params.id);
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

const createApiKeySchema = z.object({
  domainId: z.string().uuid("Invalid domain ID"),
  keyName: z.string().min(1, "Key name is required"),
  permissions: z.array(z.string()).optional().default(["send"]),
});

const updateApiKeySchema = z.object({
  permissions: z.array(z.string()).min(1, "At least one permission is required"),
});

export async function listApiKeys(req: Req): Promise<Response> {
  const user = requireUser(req);
  const apiKeys = await getUserApiKeys(user.id);
  return json({ success: true, data: { apiKeys } });
}

export async function createApiKey(req: Req): Promise<Response> {
  const user = requireUser(req);
  const { domainId, keyName, permissions } = createApiKeySchema.parse(await req.json());

  const domain = await getDomainById(domainId);
  if (!domain || domain.user_id !== user.id) {
    return json({ error: "Domain not found or you don't have access." }, 404);
  }
  if (domain.status !== "verified") {
    return json({ error: "Verify the domain before creating API keys." }, 400);
  }

  const apiKey = await generateApiKey(user.id, domainId, keyName, permissions);
  return json({
    success: true,
    data: { apiKey },
    message: "API key created. Copy it now — it won't be shown again.",
  });
}

export async function updateApiKey(req: Req): Promise<Response> {
  const user = requireUser(req);
  const { permissions } = updateApiKeySchema.parse(await req.json());
  await updateApiKeyPermissions(req.params.id, user.id, permissions);
  return json({ success: true, message: "API key permissions updated." });
}

export async function removeApiKey(req: Req): Promise<Response> {
  const user = requireUser(req);
  await deleteApiKey(req.params.id, user.id);
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
  .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bareAddress(v)), "Invalid email address");
const asArray = (v: unknown) => (typeof v === "string" ? [v] : v);

const sendEmailSchema = z
  .object({
    from: addressField,
    to: z.preprocess(asArray, z.array(addressField).min(1, "Add at least one recipient.")),
    cc: z.preprocess(asArray, z.array(addressField).optional()),
    bcc: z.preprocess(asArray, z.array(addressField).optional()),
    subject: z
      .string()
      .min(1, "Subject is required.")
      .regex(/^[^\r\n]*$/, "Subject can't contain line breaks."),
    // Some clients send the unused body as null (not omitted) — accept null too.
    html: z.string().nullish().transform((v) => v ?? undefined),
    text: z.string().nullish().transform((v) => v ?? undefined),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
    reply_to: z.preprocess(asArray, z.array(addressField).optional()),
    // Resend tags are [{name,value}]; clients commonly send this key even when
    // empty ([]). Also accept a legacy { k: v } record. Empty/absent => undefined.
    tags: z.preprocess(
      (v) => {
        if (v == null) return undefined;
        if (Array.isArray(v)) return v;
        if (typeof v === "object") {
          return Object.entries(v as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) }));
        }
        return v;
      },
      z.array(z.object({ name: z.string(), value: z.string() })).optional()
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
    sendEmailSchema.parse(await req.json());

  const domain = await getDomainById(apiKey.domain_id);
  if (!domain) return json({ error: "Domain not found" }, 404);
  if (domain.status !== "verified") return json({ error: "Domain isn't verified. Verify DNS and try again." }, 400);

  if (bareAddress(from).split("@")[1] !== domain.domain) {
    return json({ error: `From email must use the domain ${domain.domain}.` }, 400);
  }

  const sesAttachments = attachments?.map((att) => ({
    filename: att.filename,
    content: att.content,
    contentType: att.contentType || att.content_type || "application/octet-stream",
  }));

  const messageId = await sendEmail({
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

  // Persist attachment metadata only — never the raw base64 payload.
  const attachmentMeta = (attachments ?? []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType || a.content_type || "application/octet-stream",
    size: decodedBase64Bytes(a.content),
  }));

  let emailLogId: string | undefined;
  try {
    const result = await query(
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
    emailLogId = result.rows[0]?.id;
  } catch (logError) {
    console.error("Failed to log email:", logError);
  }

  return json({
    id: emailLogId || messageId,
    from,
    to,
    created_at: new Date().toISOString(),
  });
}

export async function emailLogs(req: Req): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return json({ error: "Missing authorization header" }, 401);
  }

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const domainId = url.searchParams.get("domain_id");
  const status = url.searchParams.get("status");
  const offset = (page - 1) * limit;

  let domainIds: string[] = [];
  if (auth.startsWith("Bearer wka_")) {
    const apiKey = await requireApiKey(req);
    domainIds = [apiKey.domain_id];
  } else {
    const user = requireUser(req);
    const result = await query("SELECT id FROM domains WHERE user_id = $1", [user.id]);
    domainIds = result.rows.map((d) => d.id);
  }

  if (domainIds.length === 0) {
    return json({
      success: true,
      data: { emails: [], pagination: { page, limit, total: 0, totalPages: 0 } },
    });
  }

  const whereConditions = ["el.domain_id = ANY($1)"];
  const queryParams: (string | string[])[] = [domainIds];
  if (domainId) {
    whereConditions.push(`el.domain_id = $${queryParams.length + 1}`);
    queryParams.push(domainId);
  }
  if (status) {
    whereConditions.push(`el.status = $${queryParams.length + 1}`);
    queryParams.push(status);
  }
  const whereClause = whereConditions.join(" AND ");

  const countResult = await query(
    `SELECT COUNT(*) as count FROM email_logs el WHERE ${whereClause}`,
    queryParams
  );
  const totalCount = parseInt(countResult.rows[0].count);

  const emailLogsResult = await query(
    `SELECT el.*, d.domain as domain_name, ak.key_name as api_key_name
     FROM email_logs el
     LEFT JOIN domains d ON el.domain_id = d.id
     LEFT JOIN api_keys ak ON el.api_key_id = ak.id
     WHERE ${whereClause}
     ORDER BY el.created_at DESC
     LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
    [...queryParams, limit, offset]
  );

  const emails = emailLogsResult.rows.map((row) => ({
    ...row,
    to_emails: safeParseEmailArray(row.to_emails),
    cc_emails: safeParseEmailArray(row.cc_emails),
    bcc_emails: safeParseEmailArray(row.bcc_emails),
    attachments: safeParseEmailArray(row.attachments),
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
  const emailResult = await query(
    `SELECT el.*, d.domain as domain_name, d.user_id as domain_user_id, ak.key_name as api_key_name
     FROM email_logs el
     LEFT JOIN domains d ON el.domain_id = d.id
     LEFT JOIN api_keys ak ON el.api_key_id = ak.id
     WHERE el.id = $1`,
    [req.params.id]
  );
  if (emailResult.rows.length === 0) return json({ error: "Email not found" }, 404);

  const emailData = emailResult.rows[0];
  if (emailData.domain_user_id !== user.id) return json({ error: "Email not found" }, 404);

  const webhookResult = await query(
    `SELECT id, event_type, event_data, created_at
     FROM webhook_events WHERE email_log_id = $1 ORDER BY created_at DESC`,
    [req.params.id]
  );

  const email = {
    ...emailData,
    to_emails: safeParseEmailArray(emailData.to_emails),
    cc_emails: safeParseEmailArray(emailData.cc_emails),
    bcc_emails: safeParseEmailArray(emailData.bcc_emails),
    attachments: safeParseEmailArray(emailData.attachments),
    domains: { domain: emailData.domain_name, user_id: emailData.domain_user_id },
    api_keys: emailData.api_key_name ? { key_name: emailData.api_key_name } : null,
    webhook_events: webhookResult.rows.map((row) => ({
      ...row,
      event_data: safeParseJSON(row.event_data),
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
    const code = (error as NodeJS.ErrnoException).code;
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "ENOENT") return [];
    errors.push(`${name}: MX lookup failed`);
    return [];
  }
}

async function resolveCname(name: string, errors: string[]): Promise<string[]> {
  try {
    return await dns.resolveCname(name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "ENOENT") return [];
    errors.push(`${name}: CNAME lookup failed`);
    return [];
  }
}

export async function emailDnsChecker(req: Req): Promise<Response> {
  let body: { domain?: unknown; dkimSelector?: unknown };
  try {
    body = (await req.json()) as { domain?: unknown; dkimSelector?: unknown };
  } catch {
    return json({ error: "Send a JSON body with a domain." }, 400);
  }
  if (typeof body.domain !== "string") {
    return json({ error: "Domain is required." }, 400);
  }

  try {
    const domain = normalizeDomain(body.domain);
    const dkimSelector = normalizeDkimSelector(
      typeof body.dkimSelector === "string" ? body.dkimSelector : null
    );
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
    return json({ error: (error as Error).message }, 400);
  }
}

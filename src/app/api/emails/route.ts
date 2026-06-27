import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyApiKey } from "@/lib/api-keys";
import { sendEmail } from "@/lib/ses";
import { getDomainById } from "@/lib/domains";
import { query } from "@/lib/database";

const MAX_ATTACHMENTS = 20;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024; // SES raw-message hard limit

const decodedBase64Bytes = (b64: string) =>
  Math.floor(b64.replace(/\s+/g, "").length * 0.75);

const attachmentSchema = z.object({
  filename: z.string().min(1).regex(/^[^\r\n"]+$/, "Invalid attachment filename"),
  content: z
    .string()
    .refine((c) => /^[A-Za-z0-9+/]+={0,2}$/.test(c.replace(/\s+/g, "")), {
      message: "Attachment content must be base64-encoded.",
    }),
  contentType: z.string().regex(/^[^\r\n]+$/, "Invalid content type").optional(),
});

const sendEmailSchema = z
  .object({
    from: z.string().email("Invalid from email"),
    to: z
      .array(z.string().email("Invalid to email"))
      .min(1, "At least one recipient is required"),
    cc: z.array(z.string().email("Invalid cc email")).optional(),
    bcc: z.array(z.string().email("Invalid bcc email")).optional(),
    subject: z
      .string()
      .min(1, "Subject is required")
      .regex(/^[^\r\n]*$/, "Subject must not contain line breaks"),
    html: z.string().optional(),
    text: z.string().optional(),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
    reply_to: z.array(z.string().email("Invalid reply_to email")).optional(),
    tags: z.record(z.string(), z.string()).optional(),
  })
  .refine((data) => data.html || data.text, {
    message: "Include either html or text content.",
  })
  .refine(
    (data) =>
      (data.attachments ?? []).reduce(
        (sum, a) => sum + decodedBase64Bytes(a.content),
        0
      ) <= MAX_TOTAL_ATTACHMENT_BYTES,
    { message: "Attachments must be 10 MB or smaller in total." }
  );

function cors(response: NextResponse) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return response;
}

export async function POST(request: NextRequest) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return cors(new NextResponse(null, { status: 200 }));
  }

  try {
    // Check authorization (API key required)
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return cors(NextResponse.json(
        { error: "Include an API key in the Authorization header." },
        { status: 401 }
      ));
    }

    const apiKeyValue = authHeader.substring(7);
    const apiKey = await verifyApiKey(apiKeyValue);
    if (!apiKey) {
      return cors(NextResponse.json(
        { error: "API key is invalid or revoked." },
        { status: 401 }
      ));
    }

    // Authorize before doing any work.
    if (!apiKey.permissions.includes("send")) {
      return cors(NextResponse.json(
        { error: "This API key can't send email. Create a key with send permission." },
        { status: 403 }
      ));
    }

    // Parse and validate request body
    const body = await request.json();
    const validatedData = sendEmailSchema.parse(body);
    
    const {
      from,
      to,
      cc,
      bcc,
      subject,
      html,
      text,
      attachments,
      reply_to,
      tags,
    } = validatedData;

    // Verify the from domain is authorized for this API key
    const domain = await getDomainById(apiKey.domain_id);
    if (!domain) {
      return cors(NextResponse.json({ error: "Domain not found." }, { status: 404 }));
    }

    if (domain.status !== "verified") {
      return cors(NextResponse.json(
        { error: "Domain isn't verified. Verify DNS and try again." },
        { status: 400 }
      ));
    }

    // Validate from email domain
    const fromDomain = from.split("@")[1];
    if (fromDomain !== domain.domain) {
      return cors(NextResponse.json(
        { error: `From email must be from domain: ${domain.domain}` },
        { status: 400 }
      ));
    }

    const sesAttachments = attachments?.map((att) => ({
      filename: att.filename,
      content: att.content,
      contentType: att.contentType || "application/octet-stream",
    }));

    // Send email via SES (to/cc/bcc/reply_to are already arrays via the schema).
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

    // Persist attachment metadata only — never the raw base64 payload, which
    // would bloat the table and store recipient content/PII indefinitely.
    const attachmentMeta = (attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType || "application/octet-stream",
      size: decodedBase64Bytes(a.content),
    }));

    // Log email in database
    let emailLog = null;
    try {
      const result = await query(
        `INSERT INTO email_logs (
          api_key_id, domain_id, from_email, to_emails, cc_emails, bcc_emails,
          subject, html_content, text_content, attachments, status, ses_message_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
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
      emailLog = result.rows[0];
    } catch (logError) {
      console.error("Failed to log email:", logError);
    }

    return cors(NextResponse.json({
      id: emailLog?.id || messageId,
      from,
      to,
      created_at: new Date().toISOString(),
    }));
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return cors(NextResponse.json(
        { error: "Invalid request data", details: error.issues },
        { status: 400 }
      ));
    }

    console.error("API Error:", error);
    return cors(NextResponse.json(
      { error: "Something went wrong. Try again in a moment." },
      { status: 500 }
    ));
  }
}
import {
  SESClient,
  SendEmailCommand,
  SendRawEmailCommand,
  VerifyDomainIdentityCommand,
  GetIdentityVerificationAttributesCommand,
  DeleteIdentityCommand,
  CreateConfigurationSetCommand,
  VerifyDomainDkimCommand,
  GetIdentityDkimAttributesCommand,
} from "@aws-sdk/client-ses";
import crypto from "crypto";

const sesClient = new SESClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface SendEmailOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: EmailAttachment[];
  replyTo?: string[];
  tags?: Record<string, string>;
}

export interface SESVerificationResult {
  verificationToken: string;
  status: "Pending" | "Success" | "Failed" | "TemporaryFailure" | "NotStarted";
}

// --- RFC 5322 / 2045 header + MIME helpers -----------------------------------
// Every value that is interpolated into a header must be CRLF-free, or a caller
// could inject arbitrary headers / MIME parts (e.g. a smuggled Bcc).

function assertNoCRLF(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Illegal line break in ${field}`);
  }
}

// RFC 2047 encoded-word for header values containing non-ASCII (subjects,
// filenames). ASCII values pass through unchanged.
function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

// Wrap base64 to 76-char lines per RFC 2045.
function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function randomBoundary(tag: string): string {
  return `=_${tag}_${crypto.randomBytes(16).toString("hex")}`;
}

export async function sendEmail(options: SendEmailOptions): Promise<string> {
  const { from, to, cc, bcc, subject, html, text, replyTo, tags } = options;

  if (options.attachments && options.attachments.length > 0) {
    // Use raw email for attachments
    return sendRawEmail(options);
  }

  const command = new SendEmailCommand({
    Source: from,
    Destination: {
      ToAddresses: to,
      CcAddresses: cc,
      BccAddresses: bcc,
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: "UTF-8",
      },
      Body: {
        Html: html
          ? {
              Data: html,
              Charset: "UTF-8",
            }
          : undefined,
        Text: text
          ? {
              Data: text,
              Charset: "UTF-8",
            }
          : undefined,
      },
    },
    ReplyToAddresses: replyTo,
    Tags: tags
      ? Object.entries(tags).map(([Name, Value]) => ({ Name, Value }))
      : undefined,
  });

  const response = await sesClient.send(command);
  return response.MessageId!;
}

// Builds a raw multipart MIME message (required by SES for attachments) and
// sends it. Bodies and attachments are base64-encoded so arbitrary content can
// never collide with a MIME boundary or break SMTP line-length limits; all
// header values are CRLF-guarded and non-ASCII ones RFC 2047 encoded.
export async function sendRawEmail(options: SendEmailOptions): Promise<string> {
  const {
    from,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    attachments = [],
    replyTo,
  } = options;

  for (const addr of [from, ...to, ...(cc ?? []), ...(replyTo ?? [])]) {
    assertNoCRLF(addr, "address");
  }
  assertNoCRLF(subject, "subject");

  const mixed = randomBoundary("mixed");
  const alt = randomBoundary("alt");
  const recipients = [...to, ...(cc ?? []), ...(bcc ?? [])];

  const lines: string[] = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    ...(cc?.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(replyTo?.length ? [`Reply-To: ${replyTo.join(", ")}`] : []),
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
  ];

  const addBodyPart = (contentType: string, body: string) => {
    lines.push(
      `--${alt}`,
      `Content-Type: ${contentType}; charset=UTF-8`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(body, "utf8").toString("base64")),
      ""
    );
  };
  if (text) addBodyPart("text/plain", text);
  if (html) addBodyPart("text/html", html);
  lines.push(`--${alt}--`, "");

  for (const att of attachments) {
    assertNoCRLF(att.filename, "attachment filename");
    assertNoCRLF(att.contentType, "attachment content type");
    lines.push(
      `--${mixed}`,
      `Content-Type: ${att.contentType}`,
      `Content-Disposition: attachment; filename="${encodeHeaderWord(att.filename)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(att.content.replace(/\s+/g, "")),
      ""
    );
  }
  lines.push(`--${mixed}--`, "");

  const command = new SendRawEmailCommand({
    Source: from,
    Destinations: recipients,
    RawMessage: { Data: new TextEncoder().encode(lines.join("\r\n")) },
  });

  const response = await sesClient.send(command);
  if (!response.MessageId) {
    throw new Error("SES did not return a MessageId");
  }
  return response.MessageId;
}

export async function verifyDomain(
  domain: string
): Promise<SESVerificationResult> {
  const command = new VerifyDomainIdentityCommand({
    Domain: domain,
  });

  const response = await sesClient.send(command);

  return {
    verificationToken: response.VerificationToken!,
    status: "Pending",
  };
}

export async function getDomainVerificationStatus(
  domain: string
): Promise<string> {
  const command = new GetIdentityVerificationAttributesCommand({
    Identities: [domain],
  });

  const response = await sesClient.send(command);
  const attributes = response.VerificationAttributes?.[domain];

  return attributes?.VerificationStatus || "NotStarted";
}

export async function enableDomainDkim(domain: string): Promise<string[]> {
  const command = new VerifyDomainDkimCommand({
    Domain: domain,
  });

  const response = await sesClient.send(command);
  return response.DkimTokens || [];
}

export async function getDomainDkimTokens(domain: string): Promise<string[]> {
  const command = new GetIdentityDkimAttributesCommand({
    Identities: [domain],
  });

  const response = await sesClient.send(command);
  const attributes = response.DkimAttributes?.[domain];

  return attributes?.DkimTokens || [];
}

export async function deleteDomainIdentity(domain: string): Promise<void> {
  const command = new DeleteIdentityCommand({
    Identity: domain,
  });

  await sesClient.send(command);
}

export async function createConfigurationSet(domain: string): Promise<string> {
  const configSetName = `waka-${domain.replace(/\./g, "-")}`;

  try {
    const command = new CreateConfigurationSetCommand({
      ConfigurationSet: {
        Name: configSetName,
      },
    });

    await sesClient.send(command);

    return configSetName;
  } catch (error: unknown) {
    const awsError = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    // Handle various ways AWS might indicate the configuration set already exists
    if (
      awsError.name === "AlreadyExistsException" ||
      awsError.name === "ConfigurationSetAlreadyExistsException" ||
      awsError.message?.includes("already exists") ||
      awsError.message?.includes("Configuration set") ||
      awsError.$metadata?.httpStatusCode === 409
    ) {
      console.log(
        `Configuration set ${configSetName} already exists, continuing...`
      );
      return configSetName;
    }
    console.error("SES Configuration Set Error:", error);
    throw error;
  }
}

export function generateDNSRecords(
  domain: string,
  verificationToken: string,
  dkimTokens: string[] = []
) {
  const records = [
    {
      type: "TXT",
      name: `_amazonses.${domain}`,
      value: verificationToken,
      ttl: 300,
      description: "SES Domain Verification",
    },
    {
      type: "MX",
      name: domain,
      value: "10 inbound-smtp.us-east-1.amazonaws.com.", // Trailing dot required by Digital Ocean
      ttl: 300,
      description: "SES Inbound Email",
    },
    {
      type: "TXT",
      name: domain,
      value: "v=spf1 include:amazonses.com ~all",
      ttl: 300,
      description: "SPF Record for SES",
    },
    {
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: "v=DMARC1; p=quarantine; rua=mailto:dmarc@" + domain,
      ttl: 300,
      description: "DMARC Policy",
    },
  ];

  // Add DKIM CNAME records
  dkimTokens.forEach((token) => {
    records.push({
      type: "CNAME",
      name: `${token}._domainkey.${domain}`,
      value: `${token}.dkim.amazonses.com.`, // Trailing dot required
      ttl: 300,
      description: `DKIM Record (${token.substring(0, 8)}...)`,
    });
  });

  return records;
}

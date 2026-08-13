import { json, jsonBody, type Req } from "./http";
import { query } from "@/lib/database";
import { validateSnsMessage, confirmSubscription, type SnsMessage } from "@/lib/sns";
import { z } from "zod";

interface SESMessage {
  // Config-set events use PascalCase `eventType` ("Delivery"); identity
  // notifications use `notificationType`. Normalized to lower-case below.
  eventType?: string;
  notificationType?: string;
  mail: { messageId: string; timestamp: string; source: string; destination: string[] };
  bounce?: {
    bouncedRecipients: Array<{ emailAddress: string; diagnosticCode: string }>;
  };
  complaint?: { complainedRecipients: Array<{ emailAddress: string }> };
  open?: { timestamp?: string; ipAddress?: string; userAgent?: string };
  click?: { timestamp?: string; ipAddress?: string; userAgent?: string; link?: string };
}

const sesMessageSchema = z.object({
  eventType: z.string().optional(),
  notificationType: z.string().optional(),
  mail: z.object({
    messageId: z.string().min(1),
    timestamp: z.string(),
    source: z.string(),
    destination: z.array(z.string()),
  }),
  bounce: z.object({
    bouncedRecipients: z.array(z.object({ emailAddress: z.string(), diagnosticCode: z.string() })),
  }).optional(),
  complaint: z.object({ complainedRecipients: z.array(z.object({ emailAddress: z.string() })) }).optional(),
  open: z.object({ timestamp: z.string().optional(), ipAddress: z.string().optional(), userAgent: z.string().optional() }).optional(),
  click: z.object({ timestamp: z.string().optional(), ipAddress: z.string().optional(), userAgent: z.string().optional(), link: z.string().optional() }).optional(),
}).refine((message) => Boolean(message.eventType || message.notificationType), "Missing SES event type");

const snsMessageSchema = z.object({
  Type: z.enum(["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"]),
  MessageId: z.string().min(1),
  Token: z.string().optional(),
  TopicArn: z.string().optional(),
  Subject: z.string().optional(),
  Message: z.string(),
  SubscribeURL: z.string().url().optional(),
  Timestamp: z.string().min(1),
  SignatureVersion: z.enum(["1", "2"]),
  Signature: z.string().min(1),
  SigningCertURL: z.string().url().optional(),
  SigningCertUrl: z.string().url().optional(),
  UnsubscribeURL: z.string().url().optional(),
});

async function processSESEvent(message: SESMessage): Promise<void> {
  try {
    const emailResult = await query(
      `SELECT el.id, el.domain_id, el.status
       FROM email_logs el
       JOIN domains d ON d.id = el.domain_id
       WHERE el.ses_message_id = $1
       LIMIT 1`,
      [message.mail.messageId]
    );
    if (emailResult.rows.length === 0) {
      console.warn(`Email log not found for message ID: ${message.mail.messageId}`);
      return;
    }

    const emailLog = emailResult.rows[0];
    const eventType = (message.eventType ?? message.notificationType ?? "").toLowerCase();

    // Engagement events fire once PER open/click — record every one in
    // email_events (counts are derived on read); never overwrite delivery status.
    if (eventType === "open" || eventType === "click") {
      const isClick = eventType === "click";
      const ev = isClick ? message.click : message.open;
      await query(
        "INSERT INTO email_events (email_log_id, type, link, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)",
        [emailLog.id, eventType, isClick ? message.click?.link ?? null : null, ev?.ipAddress ?? null, ev?.userAgent ?? null]
      );
      await query(
        "INSERT INTO webhook_events (email_log_id, event_type, event_data, processed) VALUES ($1, $2, $3, $4)",
        [emailLog.id, eventType, JSON.stringify(message), true]
      );
      return;
    }

    // Delivery-lifecycle events update the message status.
    let newStatus = emailLog.status;
    let errorMessage: string | null = null;
    switch (eventType) {
      case "delivery":
        newStatus = "delivered";
        break;
      case "bounce":
        newStatus = "bounced";
        errorMessage =
          message.bounce?.bouncedRecipients
            .map((r) => `${r.emailAddress}: ${r.diagnosticCode}`)
            .join("; ") ?? null;
        break;
      case "complaint":
        newStatus = "complained";
        errorMessage = `Complaint from: ${message.complaint?.complainedRecipients
          .map((r) => r.emailAddress)
          .join(", ")}`;
        break;
      case "reject":
        newStatus = "failed";
        errorMessage = "Email rejected by SES";
        break;
    }

    await query(
      "UPDATE email_logs SET status = $1, error_message = $2, webhook_data = $3 WHERE id = $4",
      [newStatus, errorMessage, JSON.stringify(message), emailLog.id]
    );
    await query(
      "INSERT INTO webhook_events (email_log_id, event_type, event_data, processed) VALUES ($1, $2, $3, $4)",
      [emailLog.id, eventType, JSON.stringify(message), true]
    );
  } catch (error) {
    console.error("Failed to process SES event:", error);
    try {
      await query(
        "INSERT INTO webhook_events (email_log_id, event_type, event_data, processed) VALUES ($1, $2, $3, $4)",
        [null, message.eventType ?? message.notificationType ?? null, JSON.stringify(message), false]
      );
    } catch (insertError) {
      console.error("Failed to create webhook event record:", insertError);
    }
  }
}

export async function snsWebhook(req: Req): Promise<Response> {
  const parsed = snsMessageSchema.safeParse(await jsonBody(req));
  if (!parsed.success) return json({ error: "Invalid SNS message" }, 400);
  const body: SnsMessage = parsed.data;

  // Reject anything without a valid AWS SNS signature.
  if (!(await validateSnsMessage(body))) {
    console.warn("Rejected SNS message with invalid signature");
    return json({ error: "Invalid signature" }, 403);
  }

  // Optionally pin to a specific topic (set SES_SNS_TOPIC_ARN to enable).
  const expectedTopic = process.env.SES_SNS_TOPIC_ARN;
  if (!expectedTopic) {
    return json({ error: "Webhook topic is not configured." }, 503);
  }
  if (body.TopicArn !== expectedTopic) {
    console.warn(`Rejected SNS message from unexpected topic: ${body.TopicArn}`);
    return json({ error: "Unexpected topic" }, 403);
  }

  if (body.Type === "SubscriptionConfirmation") {
    const confirmed = await confirmSubscription(body);
    return json(
      { message: confirmed ? "Subscription confirmed" : "Confirmation failed" },
      confirmed ? 200 : 502
    );
  }

  if (body.Type === "UnsubscribeConfirmation") {
    console.log(`SNS unsubscribe confirmation for topic ${body.TopicArn}`);
    return json({ message: "Acknowledged" });
  }

  if (body.Type === "Notification") {
    let message: SESMessage;
    try {
      message = sesMessageSchema.parse(JSON.parse(body.Message));
    } catch {
      return json({ error: "Invalid SES event" }, 400);
    }
    await processSESEvent(message);
    return json({ message: "Event processed" });
  }

  return json({ message: "Unknown event type" });
}

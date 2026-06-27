import { json, type Req } from "./http";
import { query } from "@/lib/database";
import { validateSnsMessage, confirmSubscription, type SnsMessage } from "@/lib/sns";

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
}

async function processSESEvent(message: SESMessage): Promise<void> {
  try {
    const emailResult = await query(
      "SELECT * FROM email_logs WHERE ses_message_id = $1 LIMIT 1",
      [message.mail.messageId]
    );
    if (emailResult.rows.length === 0) {
      console.warn(`Email log not found for message ID: ${message.mail.messageId}`);
      return;
    }

    const emailLog = emailResult.rows[0];
    let newStatus = emailLog.status;
    let errorMessage: string | null = null;

    const eventType = (message.eventType ?? message.notificationType ?? "").toLowerCase();
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
  const body = (await req.json()) as SnsMessage;

  // Reject anything without a valid AWS SNS signature.
  if (!(await validateSnsMessage(body))) {
    console.warn("Rejected SNS message with invalid signature");
    return json({ error: "Invalid signature" }, 403);
  }

  // Optionally pin to a specific topic (set SES_SNS_TOPIC_ARN to enable).
  const expectedTopic = process.env.SES_SNS_TOPIC_ARN;
  if (expectedTopic && body.TopicArn !== expectedTopic) {
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
    await processSESEvent(JSON.parse(body.Message) as SESMessage);
    return json({ message: "Event processed" });
  }

  return json({ message: "Unknown event type" });
}

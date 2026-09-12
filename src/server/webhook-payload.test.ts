import { expect, test } from "bun:test";
import { buildOutboundPayload, parseSesMessage } from "./webhooks";

const mail = {
  messageId: "ses-message-1",
  timestamp: "2026-09-12T00:00:00.000Z",
  source: "sender@example.com",
  destination: ["reader@example.com"],
};

type Payload = { type: string; data: Record<string, Record<string, unknown> | null> };

test("forwards bounce and complaint objects with every SES field", () => {
  const bounce = parseSesMessage({
    eventType: "Bounce",
    mail,
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [
        { emailAddress: "reader@example.com", action: "failed", status: "5.1.1", diagnosticCode: "smtp; 550" },
      ],
      feedbackId: "feedback-1",
      reportingMTA: "dns; mta.example",
    },
  });
  const bouncePayload = buildOutboundPayload(bounce, "bounce", "log-1") as Payload;
  expect(bouncePayload.data.bounce?.reportingMTA).toBe("dns; mta.example");
  expect((bouncePayload.data.bounce?.bouncedRecipients as Array<Record<string, unknown>>)[0].status).toBe("5.1.1");

  const complaint = parseSesMessage({
    eventType: "Complaint",
    mail,
    complaint: {
      complainedRecipients: [{ emailAddress: "reader@example.com" }],
      complaintFeedbackType: "abuse",
      feedbackId: "feedback-2",
    },
  });
  const complaintPayload = buildOutboundPayload(complaint, "complaint", "log-1") as Payload;
  expect(complaintPayload.data.complaint?.complaintFeedbackType).toBe("abuse");
  expect(complaintPayload.data.bounce).toBeNull();
});

test("forwards delivery delays with their details", () => {
  const message = parseSesMessage({
    eventType: "DeliveryDelay",
    mail,
    deliveryDelay: {
      delayType: "TransientCommunicationFailure",
      expirationTime: "2026-09-12T12:00:00.000Z",
      delayedRecipients: [{ emailAddress: "reader@example.com", status: "4.4.1", diagnosticCode: "smtp; 421" }],
    },
  });
  const payload = buildOutboundPayload(message, "deliverydelay", "log-1") as Payload;
  expect(payload.type).toBe("deliverydelay");
  expect(payload.data.deliveryDelay?.delayType).toBe("TransientCommunicationFailure");
  expect(payload.data.click).toBeNull();
});

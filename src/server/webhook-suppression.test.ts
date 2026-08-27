import { beforeEach, expect, mock, test } from "bun:test";
import { executedQueries, installFakeDatabase, onFakeQuery } from "@/lib/fake-database";

installFakeDatabase("@/lib/database");
mock.module("@/lib/sns", () => ({
  validateSnsMessage: async () => true,
  confirmSubscription: async () => true,
}));

const { snsWebhook } = await import("./webhooks");

function snsBody(message: unknown, topic = "arn:aws:sns:us-east-1:123456789012:waka-events") {
  return {
    Type: "Notification",
    MessageId: "msg-1",
    Message: JSON.stringify(message),
    TopicArn: topic,
    Timestamp: new Date().toISOString(),
    SignatureVersion: "1" as const,
    Signature: "sig",
    SigningCertURL: "https://example.com/cert.pem",
  };
}

const baseMail = {
  messageId: "ses-123",
  timestamp: "2024-01-01T00:00:00Z",
  source: "sender@example.com",
  destination: ["recipient@example.com"],
};

beforeEach(() => {
  executedQueries.length = 0;
  process.env.SES_SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:waka-events";
  onFakeQuery((sql) => {
    if (sql.includes("SELECT el.id")) {
      return { rows: [{ id: "log1", domain_id: "domain1", status: "sent" }], rowCount: 1 };
    }
    if (sql.includes("UPDATE email_logs") || sql.includes("INSERT INTO webhook_events") || sql.includes("INSERT INTO email_events") || sql.includes("INSERT INTO suppressions")) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});

test("permanent bounce inserts suppression for each bounced recipient", async () => {
  const req = new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snsBody({
      notificationType: "Bounce",
      mail: baseMail,
      bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "bad@example.com", diagnosticCode: "550 5.1.1" }, { emailAddress: "also@example.com" }] },
    })),
  }) as unknown as import("./http").Req;

  const res = await snsWebhook(req as never);
  expect(res.status).toBe(200);
  const inserts = executedQueries.filter((q) => q.sql.includes("INSERT INTO suppressions"));
  expect(inserts.length).toBe(2);
  expect(inserts[0].params[1]).toBe("bad@example.com");
  expect(inserts[1].params[1]).toBe("also@example.com");
  expect(inserts[0].params[0]).toBe("domain1");
});

test("transient bounce does not insert suppression", async () => {
  const req = new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snsBody({
      notificationType: "Bounce",
      mail: baseMail,
      bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "full@example.com" }] },
    })),
  }) as unknown as import("./http").Req;

  const res = await snsWebhook(req as never);
  expect(res.status).toBe(200);
  const inserts = executedQueries.filter((q) => q.sql.includes("INSERT INTO suppressions"));
  expect(inserts.length).toBe(0);
});

test("bounce without type does not suppress", async () => {
  const req = new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snsBody({
      notificationType: "Bounce",
      mail: baseMail,
      bounce: { bouncedRecipients: [{ emailAddress: "no-type@example.com" }] },
    })),
  }) as unknown as import("./http").Req;

  const res = await snsWebhook(req as never);
  expect(res.status).toBe(200);
  const inserts = executedQueries.filter((q) => q.sql.includes("INSERT INTO suppressions"));
  expect(inserts.length).toBe(0);
});

test("complaint inserts suppression", async () => {
  const req = new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snsBody({
      notificationType: "Complaint",
      mail: baseMail,
      complaint: { complainedRecipients: [{ emailAddress: "spam@example.com" }] },
    })),
  }) as unknown as import("./http").Req;

  const res = await snsWebhook(req as never);
  expect(res.status).toBe(200);
  const inserts = executedQueries.filter((q) => q.sql.includes("INSERT INTO suppressions"));
  expect(inserts.length).toBe(1);
  expect(inserts[0].params[1]).toBe("spam@example.com");
});

test("suppression insert is per-domain and idempotent via ON CONFLICT", async () => {
  const body = snsBody({
    eventType: "Bounce",
    mail: baseMail,
    bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "dup@example.com" }] },
  });
  const req1 = new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("./http").Req;
  const req2 = new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as import("./http").Req;

  await snsWebhook(req1 as never);
  await snsWebhook(req2 as never);
  const inserts = executedQueries.filter((q) => q.sql.includes("INSERT INTO suppressions"));
  expect(inserts.length).toBe(2);
  for (const q of inserts) expect(q.sql).toMatch(/ON CONFLICT DO NOTHING/);
});

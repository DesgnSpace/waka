import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { db } from "../lib/database";
import { processSESEvent } from "./webhooks";

// These tests manage their own database: they only run when DATABASE_URL
// points at <scratch>, which is dropped and recreated from migrations/. Any
// other DATABASE_URL (or none) skips them untouched.
const SCRATCH_DB = "waka_ses_ingest_test";
const appUrl = process.env.DATABASE_URL ?? "";
const enabled = new RegExp(`/${SCRATCH_DB}(\\?|$)`).test(appUrl);
function adminConnectionString(): string {
  const url = new URL(appUrl);
  url.pathname = "/postgres";
  url.search = "";
  return url.toString();
}

const SES_ID_1 = "0f9d2e6b-a1c1-4f3e-9d5f-000000000001";
const SES_ID_2 = "0f9d2e6b-a1c1-4f3e-9d5f-000000000002";

let domainId = "";
let log1Id = "";
let log2Id = "";

function sesMessage(sesMessageId: string, eventType: string, extra: object = {}) {
  return {
    eventType,
    mail: {
      messageId: sesMessageId,
      timestamp: new Date().toISOString(),
      source: "noreply@example.com",
      destination: ["reader@example.com"],
    },
    ...extra,
  };
}

async function scalar(sql: string, params: unknown[] = []): Promise<string> {
  const result = await db.query(sql, params);
  return String(Object.values(result.rows[0])[0]);
}

async function logStatus(logId: string): Promise<string> {
  return scalar("SELECT status FROM email_logs WHERE id = $1", [logId]);
}

async function webhookEventCount(logId: string): Promise<number> {
  return Number(await scalar("SELECT COUNT(*) FROM webhook_events WHERE email_log_id = $1", [logId]));
}

async function engagementCount(logId: string, type: string): Promise<number> {
  return Number(
    await scalar("SELECT COUNT(*) FROM email_events WHERE email_log_id = $1 AND type = $2", [logId, type])
  );
}

const t = enabled ? test : test.skip;

beforeAll(async () => {
  if (!enabled) return;
  const admin = new Client({ connectionString: adminConnectionString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }

  const scratch = new Client({ connectionString: appUrl });
  await scratch.connect();
  try {
    const dir = path.join(import.meta.dir, "../../migrations");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      await scratch.query(await Bun.file(path.join(dir, file)).text());
    }
    const user = await scratch.query<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ('ses-ingest-test@example.com', 'x') RETURNING id"
    );
    const domain = await scratch.query<{ id: string }>(
      "INSERT INTO domains (user_id, domain) VALUES ($1, 'ses-ingest-test.example') RETURNING id",
      [user.rows[0].id]
    );
    domainId = domain.rows[0].id;
    for (const sesMessageId of [SES_ID_1, SES_ID_2]) {
      const log = await scratch.query<{ id: string }>(
        `INSERT INTO email_logs (domain_id, from_email, to_emails, ses_message_id)
         VALUES ($1, 'noreply@example.com', '["reader@example.com"]', $2) RETURNING id`,
        [domainId, sesMessageId]
      );
      if (sesMessageId === SES_ID_1) log1Id = log.rows[0].id;
      else log2Id = log.rows[0].id;
    }
  } finally {
    await scratch.end();
  }
});

afterAll(async () => {
  if (!enabled) return;
  await db.end();
  const admin = new Client({ connectionString: adminConnectionString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }
});

t("records a delivery once and treats its SNS redelivery as already handled", async () => {
  await processSESEvent(sesMessage(SES_ID_1, "delivery"), "sns-delivery-1");
  expect(await logStatus(log1Id)).toBe("delivered");
  expect(await webhookEventCount(log1Id)).toBe(1);

  await processSESEvent(sesMessage(SES_ID_1, "delivery"), "sns-delivery-1");
  expect(await logStatus(log1Id)).toBe("delivered");
  expect(await webhookEventCount(log1Id)).toBe(1);
});

t("a bounce supersedes an earlier delivery and carries the diagnostic", async () => {
  await processSESEvent(
    sesMessage(SES_ID_1, "bounce", {
      bounce: { bouncedRecipients: [{ emailAddress: "reader@example.com", diagnosticCode: "SMTP; 550 mailbox full" }] },
    }),
    "sns-bounce-1"
  );
  expect(await logStatus(log1Id)).toBe("bounced");
  expect(await scalar("SELECT error_message FROM email_logs WHERE id = $1", [log1Id])).toContain(
    "550 mailbox full"
  );
});

t("a late delivery notification cannot regress a bounced message", async () => {
  await processSESEvent(sesMessage(SES_ID_1, "delivery"), "sns-late-delivery");
  expect(await logStatus(log1Id)).toBe("bounced");
  expect(await webhookEventCount(log1Id)).toBe(3);
});

t("a complaint sticks even when delivery and bounce arrive afterwards", async () => {
  await processSESEvent(
    sesMessage(SES_ID_1, "complaint", {
      complaint: { complainedRecipients: [{ emailAddress: "reader@example.com" }] },
    }),
    "sns-complaint-1"
  );
  expect(await logStatus(log1Id)).toBe("complained");

  await processSESEvent(sesMessage(SES_ID_1, "delivery"), "sns-post-complaint-delivery");
  await processSESEvent(
    sesMessage(SES_ID_1, "bounce", {
      bounce: { bouncedRecipients: [{ emailAddress: "reader@example.com", diagnosticCode: "SMTP; 421" }] },
    }),
    "sns-post-complaint-bounce"
  );
  expect(await logStatus(log1Id)).toBe("complained");
});

t("every redelivered open is stored once while distinct opens each count", async () => {
  const open = { open: { ipAddress: "203.0.113.9", userAgent: "Test/1.0" } };
  await processSESEvent(sesMessage(SES_ID_1, "open", open), "sns-open-1");
  expect(await engagementCount(log1Id, "open")).toBe(1);

  await processSESEvent(sesMessage(SES_ID_1, "open", open), "sns-open-1");
  expect(await engagementCount(log1Id, "open")).toBe(1);

  await processSESEvent(sesMessage(SES_ID_1, "open", open), "sns-open-2");
  expect(await engagementCount(log1Id, "open")).toBe(2);
  expect(await logStatus(log1Id)).toBe("complained");
});

t("a click stores its destination link and client metadata once per notification", async () => {
  await processSESEvent(
    sesMessage(SES_ID_1, "click", {
      click: { link: "https://example.com/pricing", ipAddress: "203.0.113.10", userAgent: "Test/1.0" },
    }),
    "sns-click-1"
  );
  expect(await engagementCount(log1Id, "click")).toBe(1);

  await processSESEvent(sesMessage(SES_ID_1, "click"), "sns-click-1");
  expect(await engagementCount(log1Id, "click")).toBe(1);

  const link = await scalar(
    "SELECT link FROM email_events WHERE email_log_id = $1 AND type = 'click' LIMIT 1",
    [log1Id]
  );
  expect(link).toBe("https://example.com/pricing");
});

t("an unknown event type is archived without touching status", async () => {
  const before = await webhookEventCount(log1Id);
  await processSESEvent(sesMessage(SES_ID_1, "subscription-rotated"), "sns-unknown-1");
  expect(await webhookEventCount(log1Id)).toBe(before + 1);
  expect(await logStatus(log1Id)).toBe("complained");
});

t("a rejection is superseded by later delivery evidence", async () => {
  await processSESEvent(sesMessage(SES_ID_2, "reject"), "sns-reject-1");
  expect(await logStatus(log2Id)).toBe("failed");

  await processSESEvent(sesMessage(SES_ID_2, "send"), "sns-send-1");
  expect(await logStatus(log2Id)).toBe("failed");

  await processSESEvent(sesMessage(SES_ID_2, "delivery"), "sns-delivery-2");
  expect(await logStatus(log2Id)).toBe("delivered");
});

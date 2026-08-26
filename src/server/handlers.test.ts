import { beforeEach, expect, mock, test } from "bun:test";

import { HttpError } from "./http";
import type { Req } from "./http";
import { executedQueries, installFakeDatabase, onFakeQuery } from "@/lib/fake-database";
import { fakeRateLimitModule } from "@/lib/fake-rate-limit";

const userId = "11111111-1111-4111-8111-111111111111";
const apiKeyId = "22222222-2222-4222-8222-222222222222";
const domainId = "33333333-3333-4333-8333-333333333333";
const logId = "44444444-4444-4444-8444-444444444444";

const apiKey = {
  id: apiKeyId,
  user_id: userId,
  domain_id: domainId,
  key_name: "test key",
  key_prefix: "wka_test",
  permissions: ["send"],
};

const payload = {
  from: "sender@example.com",
  to: ["dest@example.com"],
  subject: "Hello",
  text: "Hi there",
};

let sendResult: { ok: true; messageId: string } | { ok: false; error: unknown };
const sendEmail = mock(async () => {
  if (!sendResult.ok) throw sendResult.error;
  return sendResult.messageId;
});

installFakeDatabase("@/lib/database");
mock.module("@/lib/auth", () => ({
  authenticateUser: async () => null,
  createUser: async () => {},
  generateJWT: () => "jwt",
  verifyJWT: () => null,
}));
mock.module("@/lib/api-keys", () => ({
  verifyApiKey: async () => apiKey,
  generateApiKey: async () => {
    throw new Error("not used");
  },
  getUserApiKeys: async () => [],
  deleteApiKey: async () => {},
  updateApiKeyPermissions: async () => {},
}));
const unusedSesFn = async () => {
  throw new Error("not used");
};
mock.module("@/lib/ses", () => ({
  sendEmail,
  sendRawEmail: unusedSesFn,
  verifyDomain: unusedSesFn,
  getDomainVerificationStatus: unusedSesFn,
  enableDomainDkim: unusedSesFn,
  getDomainDkimTokens: unusedSesFn,
  createConfigurationSet: unusedSesFn,
  generateDNSRecords: () => [],
  mailFromRecords: () => [],
  setMailFromDomain: unusedSesFn,
}));
mock.module("@/lib/rate-limit", () => fakeRateLimitModule);
mock.module("@/lib/quotas", () => ({ reserveDailySend: async () => true }));

const { sendEmailHandler } = await import("./handlers");

const domainRow = {
  id: domainId,
  user_id: userId,
  domain: "example.com",
  status: "verified",
  ses_identity_arn: null,
  ses_configuration_set: null,
  do_domain_id: null,
  mail_from_domain: null,
  dns_records: [],
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};

beforeEach(() => {
  executedQueries.length = 0;
  onFakeQuery((sql, params = []) => {
    if (sql.includes("FROM domains")) {
      return params[0] === domainId && params[1] === userId
        ? { rows: [domainRow], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [{ id: logId }], rowCount: 1 };
  });
});

function sendRequest(): Req {
  return new Request("http://localhost/api/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer wka_test_000000000000`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  }) as Req;
}

const sesRejection = Object.assign(new Error("Email address is not verified."), {
  name: "MessageRejected",
  $metadata: { httpStatusCode: 403 },
});

function emailLogInserts() {
  return executedQueries.filter((q) => q.sql.includes("INSERT INTO email_logs"));
}

test("a rejected SES send records a failed email_logs row and still fails the request", async () => {
  sendResult = { ok: false, error: sesRejection };

  let thrown: unknown;
  try {
    await sendEmailHandler(sendRequest());
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(HttpError);
  const httpError = thrown as HttpError;
  expect(httpError.status).toBe(403);
  expect(httpError.body).toEqual({
    error: "Email address is not verified.",
    message: "Email address is not verified.",
    code: "MessageRejected",
  });

  const inserts = emailLogInserts();
  expect(inserts.length).toBe(1);
  const params = inserts[0].params;
  expect(params[0]).toBe(apiKeyId);
  expect(params[1]).toBe(domainId);
  expect(params[2]).toBe(payload.from);
  expect(params[10]).toBe("failed");
  expect(params[11]).toBeNull();
  expect(params[12]).toBe("MessageRejected: Email address is not verified.");
});

test("a successful send logs status sent with the SES message id and returns the log id", async () => {
  const sesMessageId = "01000192a1b2c3d4-e1f2a3b4-0000-0000-0000-1234567890ab-000000";
  sendResult = { ok: true, messageId: sesMessageId };

  const res = await sendEmailHandler(sendRequest());

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe(logId);

  const inserts = emailLogInserts();
  expect(inserts.length).toBe(1);
  expect(inserts[0].params[10]).toBe("sent");
  expect(inserts[0].params[11]).toBe(sesMessageId);
});

test("the request still fails with the provider error when the failed row cannot be written", async () => {
  onFakeQuery((sql, params = []) => {
    if (sql.includes("INSERT INTO email_logs")) throw new Error("db down");
    if (sql.includes("FROM domains")) {
      return params[0] === domainId && params[1] === userId
        ? { rows: [domainRow], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  sendResult = { ok: false, error: sesRejection };

  let thrown: unknown;
  try {
    await sendEmailHandler(sendRequest());
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(HttpError);
  expect((thrown as HttpError).status).toBe(403);
  expect((thrown as HttpError).body).toEqual({
    error: "Email address is not verified.",
    message: "Email address is not verified.",
    code: "MessageRejected",
  });
});

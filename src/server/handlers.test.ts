import { beforeEach, expect, mock, test } from "bun:test";

import { HttpError } from "./http";
import type { Req } from "./http";
import { executedQueries, installFakeDatabase, onFakeQuery } from "@/lib/fake-database";
import type { FakeQueryResult } from "@/lib/fake-database";
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

const otherApiKeyId = "55555555-5555-4555-8555-555555555555";
const otherApiKey = { ...apiKey, id: otherApiKeyId, key_name: "other key" };

let currentApiKey = apiKey;

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
  verifyApiKey: async () => currentApiKey,
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
mock.module("@/lib/quotas", () => ({ reserveDailySend: async () => true, reserveApiKeyDailySend: async () => true }));

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
  currentApiKey = apiKey;
  sendEmail.mockClear();
  executedQueries.length = 0;
  onFakeQuery((sql, params = []) => {
    if (sql.includes("FROM suppressions")) return { rows: [], rowCount: 0 };
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

function requestWithKey(idempotencyKey: string): Req {
  const req = new Request("http://localhost/api/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer wka_test_000000000000`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  }) as Req;
  return req;
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

// --- idempotency -------------------------------------------------------------

type StoredClaim = {
  id: string;
  status: string;
  response_status?: number;
  response_body?: unknown;
  updated_at: Date;
};

// Stateful stand-in for the idempotency_keys table: claims are keyed by
// (api_key_id, key) exactly like the unique index, so scoping and conflict
// behavior flow through the real SQL parameters.
function idempotencyStore() {
  const rows = new Map<string, StoredClaim>();
  const releasedIds: string[] = [];
  let claimSeq = 0;

  const impl = (sql: string, params: unknown[]): FakeQueryResult | null => {
    if (sql.includes("INTO idempotency_keys")) {
      const mapKey = `${params[0]}|${params[1]}`;
      if (!rows.has(mapKey)) {
        const id = `aaaaaaaa-0000-4000-8000-${String(++claimSeq).padStart(12, "0")}`;
        rows.set(mapKey, { id, status: "pending", updated_at: new Date() });
        return { rows: [{ id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("DELETE FROM idempotency_keys")) {
      for (const [mapKey, row] of [...rows.entries()]) {
        if (row.id === params[0]) {
          rows.delete(mapKey);
          releasedIds.push(params[0] as string);
          return { rows: [], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM idempotency_keys")) {
      const row = rows.get(`${params[0]}|${params[1]}`);
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("UPDATE idempotency_keys") && sql.includes("status = 'completed'")) {
      const row = [...rows.values()].find((r) => r.id === params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = "completed";
      row.response_status = params[1] as number;
      row.response_body = JSON.parse(params[2] as string);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE idempotency_keys")) {
      const row = [...rows.values()].find((r) => r.id === params[0]);
      const staleBefore = params[1] as Date;
      if (!row || row.status !== "pending" || row.updated_at.getTime() >= staleBefore.getTime()) {
        return { rows: [], rowCount: 0 };
      }
      row.updated_at = new Date();
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    return null;
  };

  const route = (sql: string, params: unknown[] = []): FakeQueryResult =>
    impl(sql, params) ??
    (sql.includes("FROM suppressions")
      ? { rows: [], rowCount: 0 }
      : sql.includes("FROM domains")
        ? params[0] === domainId && params[1] === userId
          ? { rows: [domainRow], rowCount: 1 }
          : { rows: [], rowCount: 0 }
        : { rows: [{ id: logId }], rowCount: 1 });

  return { rows, releasedIds, route };
}

test("a retried Idempotency-Key replays the original response without sending again", async () => {
  const store = idempotencyStore();
  onFakeQuery(store.route);
  sendResult = { ok: true, messageId: "ses-first" };

  const first = await sendEmailHandler(requestWithKey("retry-key"));
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.id).toBe(logId);

  const second = await sendEmailHandler(requestWithKey("retry-key"));
  const secondBody = await second.json();

  expect(second.status).toBe(200);
  expect(secondBody).toEqual(firstBody);
  expect(second.headers.get("idempotency-replayed")).toBe("true");
  expect(sendEmail.mock.calls.length).toBe(1);
  expect(emailLogInserts().length).toBe(1);
});

test("a repeat while the first send is still in flight gets a 409 conflict, not a second send", async () => {
  const store = idempotencyStore();
  onFakeQuery(store.route);
  store.rows.set(`${apiKeyId}|busy-key`, {
    id: "cccccccc-0000-4000-8000-000000000001",
    status: "pending",
    updated_at: new Date(),
  });
  sendResult = { ok: true, messageId: "ses-never" };

  const res = await sendEmailHandler(requestWithKey("busy-key"));

  expect(res.status).toBe(409);
  const conflictMessage =
    "An email with this Idempotency-Key is still being processed. Wait a moment and retry.";
  expect(await res.json()).toEqual({ error: conflictMessage, message: conflictMessage });
  expect(res.headers.get("retry-after")).toBe("1");
  expect(sendEmail.mock.calls.length).toBe(0);
});

test("the same key string under two API keys claims separately per key", async () => {
  const store = idempotencyStore();
  onFakeQuery(store.route);

  sendResult = { ok: true, messageId: "ses-a" };
  const first = await sendEmailHandler(requestWithKey("shared-key"));
  expect(first.status).toBe(200);

  currentApiKey = otherApiKey;
  sendResult = { ok: true, messageId: "ses-b" };
  const second = await sendEmailHandler(requestWithKey("shared-key"));
  expect(second.status).toBe(200);

  expect([...store.rows.keys()].sort()).toEqual(
    [`${apiKeyId}|shared-key`, `${otherApiKeyId}|shared-key`].sort()
  );
  expect(sendEmail.mock.calls.length).toBe(2);
});

test("a rejected send releases the key so a retry can send normally", async () => {
  const store = idempotencyStore();
  onFakeQuery(store.route);
  sendResult = { ok: false, error: sesRejection };

  let thrown: unknown;
  try {
    await sendEmailHandler(requestWithKey("failing-key"));
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect((thrown as HttpError).status).toBe(403);
  expect(store.releasedIds.length).toBe(1);

  sendResult = { ok: true, messageId: "ses-after-failure" };
  const retry = await sendEmailHandler(requestWithKey("failing-key"));
  expect(retry.status).toBe(200);
  expect(sendEmail.mock.calls.length).toBe(2);
  expect(emailLogInserts().length).toBe(2);
});

test("a stale pending claim from a dead request is taken over instead of blocking forever", async () => {
  const store = idempotencyStore();
  onFakeQuery(store.route);
  store.rows.set(`${apiKeyId}|crashed-key`, {
    id: "cccccccc-0000-4000-8000-000000000009",
    status: "pending",
    updated_at: new Date(Date.now() - 10 * 60_000),
  });
  sendResult = { ok: true, messageId: "ses-after-crash" };

  const res = await sendEmailHandler(requestWithKey("crashed-key"));

  expect(res.status).toBe(200);
  expect(sendEmail.mock.calls.length).toBe(1);
});

test("requests without an Idempotency-Key touch no idempotency tables", async () => {
  sendResult = { ok: true, messageId: "ses-plain" };

  const res = await sendEmailHandler(sendRequest());

  expect(res.status).toBe(200);
  expect(executedQueries.some((q) => q.sql.includes("idempotency_keys"))).toBe(false);
});

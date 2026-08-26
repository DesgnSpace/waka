import { beforeEach, expect, mock, test } from "bun:test";
import { HttpError } from "./http";
import type { Req } from "./http";
import { executedQueries, installFakeDatabase, onFakeQuery } from "@/lib/fake-database";
import { fakeRateLimitModule } from "@/lib/fake-rate-limit";

const userId = "11111111-1111-4111-8111-111111111111";
const apiKeyId = "22222222-2222-4222-8222-222222222222";
const domainId = "33333333-3333-4333-8333-333333333333";

const apiKey = {
  id: apiKeyId,
  user_id: userId,
  domain_id: domainId,
  key_name: "test key",
  key_prefix: "wka_test",
  permissions: ["send"],
  rate_limit_per_minute: null as number | null,
  daily_send_limit: null as number | null,
};

let currentApiKey: typeof apiKey = { ...apiKey };

let sesBehavior: (opts: unknown) => Promise<string>;
const sendEmail = mock(async (opts: unknown) => sesBehavior(opts));

installFakeDatabase("@/lib/database");
mock.module("@/lib/auth", () => ({
  authenticateUser: async () => null,
  createUser: async () => {},
  generateJWT: () => "jwt",
  verifyJWT: () => null,
}));
mock.module("@/lib/api-keys", () => ({
  verifyApiKey: async () => currentApiKey,
  generateApiKey: async () => { throw new Error("not used"); },
  getUserApiKeys: async () => [],
  deleteApiKey: async () => {},
  updateApiKeyPermissions: async () => {},
  updateApiKeyLimits: async () => {},
}));
mock.module("@/lib/ses", () => ({
  sendEmail,
  sendRawEmail: async () => { throw new Error("not used"); },
  verifyDomain: async () => { throw new Error("not used"); },
  getDomainVerificationStatus: async () => { throw new Error("not used"); },
  enableDomainDkim: async () => { throw new Error("not used"); },
  getDomainDkimTokens: async () => { throw new Error("not used"); },
  createConfigurationSet: async () => { throw new Error("not used"); },
  generateDNSRecords: () => [],
  mailFromRecords: () => [],
  setMailFromDomain: async () => { throw new Error("not used"); },
}));

// per-test mutable mocks
let rateLimitShouldFail = false;
let quotaFailAfter: number | null = null;
let quotaCalls = 0;
let apiKeyQuotaFailAfter: number | null = null;
let apiKeyQuotaCalls = 0;

mock.module("@/lib/rate-limit", () => ({
  ...fakeRateLimitModule,
  checkRateLimit: async () => ({ allowed: !rateLimitShouldFail, retryAfterSeconds: 60 }),
}));
mock.module("@/lib/quotas", () => ({
  reserveDailySend: async () => {
    quotaCalls++;
    if (quotaFailAfter != null && quotaCalls > quotaFailAfter) return false;
    return true;
  },
  reserveApiKeyDailySend: async () => {
    apiKeyQuotaCalls++;
    if (apiKeyQuotaFailAfter != null && apiKeyQuotaCalls > apiKeyQuotaFailAfter) return false;
    return true;
  },
}));

const { sendBatchHandler } = await import("./handlers");

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
  currentApiKey = { ...apiKey };
  rateLimitShouldFail = false;
  quotaFailAfter = null;
  quotaCalls = 0;
  apiKeyQuotaFailAfter = null;
  apiKeyQuotaCalls = 0;
  sesBehavior = async () => `ses-${Math.random().toString(36).slice(2, 8)}`;
  sendEmail.mockClear();
  executedQueries.length = 0;
  onFakeQuery((sql, params = []) => {
    if (sql.includes("FROM suppressions")) {
      const emails = (params[1] as string[]) ?? [];
      const suppressed = emails.filter((e) => e.toLowerCase() === "blocked@example.com");
      return { rows: suppressed.map((email) => ({ email })), rowCount: suppressed.length };
    }
    if (sql.includes("FROM domains")) {
      return params[0] === domainId && params[1] === userId ? { rows: [domainRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO email_logs")) return { rows: [{ id: `log-${Math.random()}` }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

function batchRequest(body: unknown, extraHeaders: Record<string, string> = {}): Req {
  return new Request("http://localhost/api/emails/batch", {
    method: "POST",
    headers: { authorization: `Bearer wka_test_000000000000`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  }) as Req;
}

const goodItem = (to: string) => ({
  from: "sender@example.com",
  to: [to],
  subject: "Hello",
  text: "Hi",
});

test("all-success batch returns 200 with ids in order", async () => {
  let seq = 0;
  sesBehavior = async () => `ses-${++seq}`;
  const res = await sendBatchHandler(batchRequest([goodItem("a@example.com"), goodItem("b@example.com")]));
  expect(res.status).toBe(200);
  const body = await res.json() as { data: Array<{ id: string }> };
  expect(body.data.length).toBe(2);
  expect(body.data[0].id).toBeDefined();
  expect(body.data[1].id).toBeDefined();
  expect(sendEmail.mock.calls.length).toBe(2);
  expect(quotaCalls).toBe(2);
});

test("mixed batch returns 207 with per-item success and error", async () => {
  sesBehavior = async (opts: unknown) => {
    const o = opts as { to: string[] };
    if (o.to.includes("fail@example.com")) {
      const err = Object.assign(new Error("rejected"), { name: "MessageRejected", $metadata: { httpStatusCode: 400 } });
      throw err;
    }
    return "ses-ok";
  };
  const res = await sendBatchHandler(
    batchRequest([
      goodItem("ok@example.com"),
      goodItem("blocked@example.com"),
      { from: "sender@example.com", to: ["x@example.com"], subject: "", text: "no subject" },
      goodItem("fail@example.com"),
    ])
  );
  expect(res.status).toBe(207);
  const body = await res.json() as { data: Array<Record<string, unknown>> };
  expect(body.data.length).toBe(4);
  // item 0 success
  expect(body.data[0].id).toBeDefined();
  // item 1 suppressed -> 400
  expect(body.data[1].statusCode).toBe(400);
  expect(String(body.data[1].error)).toMatch(/suppression/i);
  // item 2 validation -> 422
  expect(body.data[2].statusCode).toBe(422);
  // item 3 SES rejection -> 400
  expect(body.data[3].statusCode).toBe(400);
  // only 2 SES attempts: ok and fail (blocked and invalid never hit SES)
  expect(sendEmail.mock.calls.length).toBe(2);
});

test("over-cap batch is rejected with 400 naming the limit", async () => {
  const big = Array.from({ length: 101 }, (_, i) => goodItem(`u${i}@example.com`));
  let thrown: unknown;
  try {
    await sendBatchHandler(batchRequest(big));
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect((thrown as HttpError).status).toBe(400);
  const body = (thrown as HttpError).body as { error: string };
  expect(body.error).toMatch(/100/);
  expect(sendEmail.mock.calls.length).toBe(0);
});

test("quota accounting across a batch: third item fails when daily quota exhausted", async () => {
  quotaFailAfter = 2;
  const res = await sendBatchHandler(
    batchRequest([goodItem("a@example.com"), goodItem("b@example.com"), goodItem("c@example.com")])
  );
  expect(res.status).toBe(207);
  const body = await res.json() as { data: Array<Record<string, unknown>> };
  expect(body.data.length).toBe(3);
  expect(body.data[0].id).toBeDefined();
  expect(body.data[1].id).toBeDefined();
  expect(body.data[2].statusCode).toBe(429);
  expect(String(body.data[2].error)).toMatch(/Daily/);
  expect(quotaCalls).toBe(3);
  expect(sendEmail.mock.calls.length).toBe(2);
});

test("non-array body is rejected with 400", async () => {
  let thrown: unknown;
  try {
    await sendBatchHandler(batchRequest({ from: "sender@example.com", to: ["a@example.com"], subject: "hi", text: "hi" }));
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect((thrown as HttpError).status).toBe(400);
});

import { beforeEach, expect, mock, test } from "bun:test";
import { HttpError } from "./http";
import type { Req } from "./http";
import { executedQueries, installFakeDatabase, onFakeQuery } from "@/lib/fake-database";

const userId = "11111111-1111-4111-8111-111111111111";
const apiKeyId = "22222222-2222-4222-8222-222222222222";
const domainId = "33333333-3333-4333-8333-333333333333";
const logId = "44444444-4444-4444-8444-444444444444";

function makeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: apiKeyId,
    user_id: userId,
    domain_id: domainId,
    key_name: "test key",
    key_prefix: "wka_test",
    permissions: ["send"],
    rate_limit_per_minute: null as number | null,
    daily_send_limit: null as number | null,
    ...overrides,
  };
}

let currentApiKey: ReturnType<typeof makeKey> = makeKey();

const payload = {
  from: "sender@example.com",
  to: ["dest@example.com"],
  subject: "Hello",
  text: "Hi there",
};

let rateLimitCalls: string[] = [];
let accountDailyShouldFail = false;
let apiKeyDailyUsage = new Map<string, number>();

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
const sendEmail = mock(async () => "ses-msg-id");
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

// Real-like mocks that respect per-key limits; per-key bucket key is `send:key:<id>`
mock.module("@/lib/rate-limit", () => ({
  checkRateLimit: async (key: string, limit: number) => {
    rateLimitCalls.push(key);
    // Simulate per-key bucket: fail when limit is 1 and second call happens
    // For testing, we use a simple counter keyed by bucket.
    // The test controls expected behavior by setting currentApiKey.rate_limit_per_minute.
    // If the bucket is per-key and limit is 1, second call within window fails.
    // We store call counts in a global map.
    const counts = (globalThis as unknown as { __rateCounts?: Map<string, number> }).__rateCounts ?? new Map<string, number>();
    (globalThis as unknown as { __rateCounts: Map<string, number> }).__rateCounts = counts;
    const prev = counts.get(key) ?? 0;
    if (key.startsWith("send:key:") && limit === 1 && prev >= 1) {
      return { allowed: false, retryAfterSeconds: 60 };
    }
    counts.set(key, prev + 1);
    return { allowed: true, retryAfterSeconds: 0 };
  },
  requestAddress: () => "127.0.0.1",
}));
mock.module("@/lib/quotas", () => ({
  reserveDailySend: async () => !accountDailyShouldFail,
  reserveApiKeyDailySend: async (keyId: string, limit: number) => {
    const prev = apiKeyDailyUsage.get(keyId) ?? 0;
    if (prev >= limit) return false;
    apiKeyDailyUsage.set(keyId, prev + 1);
    return true;
  },
}));

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
  currentApiKey = makeKey();
  rateLimitCalls = [];
  accountDailyShouldFail = false;
  apiKeyDailyUsage = new Map();
  (globalThis as unknown as { __rateCounts?: Map<string, number> }).__rateCounts = new Map();
  sendEmail.mockClear();
  executedQueries.length = 0;
  onFakeQuery((sql, params = []) => {
    if (sql.includes("FROM suppressions")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM domains")) {
      return params[0] === domainId && params[1] === userId ? { rows: [domainRow], rowCount: 1 } : { rows: [], rowCount: 0 };
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

test("key under its per-minute limit succeeds", async () => {
  currentApiKey = makeKey({ rate_limit_per_minute: 5 });
  const res = await sendEmailHandler(sendRequest());
  expect(res.status).toBe(200);
  expect(rateLimitCalls).toContain(`send:key:${apiKeyId}`);
});

test("key over its per-minute limit is refused with per-key message", async () => {
  currentApiKey = makeKey({ rate_limit_per_minute: 1 });
  // first succeeds
  const first = await sendEmailHandler(sendRequest());
  expect(first.status).toBe(200);
  // second hits per-key bucket
  let thrown: unknown;
  try {
    await sendEmailHandler(sendRequest());
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  const http = thrown as HttpError;
  expect(http.status).toBe(429);
  expect((http.body as { error: string }).error).toMatch(/per-minute limit/i);
  expect(rateLimitCalls.filter((k) => k === `send:key:${apiKeyId}`).length).toBe(2);
});

test("key over its daily limit is refused with per-key message", async () => {
  currentApiKey = makeKey({ daily_send_limit: 1 });
  const first = await sendEmailHandler(sendRequest());
  expect(first.status).toBe(200);
  let thrown: unknown;
  try {
    await sendEmailHandler(sendRequest());
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect((thrown as HttpError).status).toBe(429);
  expect(((thrown as HttpError).body as { error: string }).error).toMatch(/daily sending limit/i);
  // per-key message must name the key, not generic
  expect(((thrown as HttpError).body as { error: string }).error).toMatch(/API key/i);
});

test("key with no limits set is unaffected and does not check per-key buckets", async () => {
  currentApiKey = makeKey({ rate_limit_per_minute: null, daily_send_limit: null });
  const res = await sendEmailHandler(sendRequest());
  expect(res.status).toBe(200);
  expect(rateLimitCalls.some((k) => k.startsWith("send:key:"))).toBe(false);
  expect(apiKeyDailyUsage.size).toBe(0);
});

test("account-level limit still applies when per-key limit is not hit", async () => {
  currentApiKey = makeKey({ rate_limit_per_minute: 100, daily_send_limit: 100 });
  accountDailyShouldFail = true;
  let thrown: unknown;
  try {
    await sendEmailHandler(sendRequest());
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect((thrown as HttpError).status).toBe(429);
  // generic daily message, not per-key
  expect(((thrown as HttpError).body as { error: string }).error).toBe("Daily sending limit reached.");
});

test("per-key daily reservation is atomic under concurrency (simulated)", async () => {
  currentApiKey = makeKey({ daily_send_limit: 2 });
  // fire 5 sends in parallel; only 2 should succeed, rest get per-key daily error
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => sendEmailHandler(sendRequest())));
  const fulfilled = results.filter((r) => r.status === "fulfilled").length;
  const rejected = results.filter((r) => r.status === "rejected").length;
  expect(fulfilled).toBe(2);
  expect(rejected).toBe(3);
  for (const r of results) {
    if (r.status === "rejected") {
      expect((r.reason as HttpError).status).toBe(429);
      expect(((r.reason as HttpError).body as { error: string }).error).toMatch(/daily sending limit/i);
    }
  }
  // cannot truly verify atomicity without real Postgres; this exercises the
  // in-memory counter's conditional increment which mirrors the WHERE clause
  // of the atomic upsert: `WHERE window < today OR send_count < $2`.
});

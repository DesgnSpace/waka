import { beforeEach, expect, mock, test } from "bun:test";
import { executedQueries, installFakeDatabase, onFakeQuery } from "@/lib/fake-database";
import { fakeRateLimitModule } from "@/lib/fake-rate-limit";

const userId = "11111111-1111-4111-8111-111111111111";
const domainId = "33333333-3333-4333-8333-333333333333";
const otherDomainId = "33333333-3333-4333-8333-333333333334";
const apiKeyId = "22222222-2222-4222-8222-222222222222";
const logId = "44444444-4444-4444-8444-444444444444";

const apiKey = {
  id: apiKeyId,
  user_id: userId,
  domain_id: domainId,
  key_name: "test key",
  key_prefix: "wka_test",
  permissions: ["send"],
};

let sendCalled = 0;
const sendEmail = mock(async () => {
  sendCalled++;
  return "ses-msg";
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
  generateApiKey: async () => { throw new Error("not used"); },
  getUserApiKeys: async () => [],
  deleteApiKey: async () => {},
}));
const unused = async () => { throw new Error("not used"); };
mock.module("@/lib/ses", () => ({
  sendEmail,
  sendRawEmail: unused,
  verifyDomain: unused,
  getDomainVerificationStatus: unused,
  enableDomainDkim: unused,
  getDomainDkimTokens: unused,
  createConfigurationSet: unused,
  generateDNSRecords: () => [],
  mailFromRecords: () => [],
  setMailFromDomain: unused,
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

function baseRequest(overrides: Record<string, unknown> = {}) {
  const payload = {
    from: "sender@example.com",
    to: ["dest@example.com"],
    subject: "Hello",
    text: "Hi",
    ...overrides,
  };
  return new Request("http://localhost/api/emails", {
    method: "POST",
    headers: { authorization: `Bearer wka_test_000000000000`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  }) as unknown as import("./http").Req;
}

beforeEach(() => {
  sendCalled = 0;
  sendEmail.mockClear();
  executedQueries.length = 0;
});

function routeWithSuppression(suppressedEmails: string[]) {
  const lowerSuppressed = new Set(suppressedEmails.map((e) => e.toLowerCase()));
  onFakeQuery((sql, params = []) => {
    if (sql.includes("FROM suppressions")) {
      const domain = params[0] as string;
      const emails = params[1] as string[];
      // findSuppressed query: SELECT email FROM suppressions WHERE domain_id = $1 AND LOWER(email) = ANY($2)
      if (domain === domainId) {
        const matched = emails.filter((e) => lowerSuppressed.has(e.toLowerCase()));
        return { rows: matched.map((email) => ({ email })), rowCount: matched.length };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM domains")) {
      return { rows: [domainRow], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO email_logs")) {
      return { rows: [{ id: logId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

test("a suppressed recipient is refused with 400 and no SES call", async () => {
  routeWithSuppression(["dest@example.com"]);
  const res = await sendEmailHandler(baseRequest());
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/previously bounced|marked as spam/i);
  expect(body.suppressed).toEqual(["dest@example.com"]);
  expect(sendCalled).toBe(0);
  expect(executedQueries.some((q) => q.sql.includes("INSERT INTO email_logs"))).toBe(false);
});

test("suppressing is case-insensitive and matches bare address in display name", async () => {
  routeWithSuppression(["dest@example.com"]);
  const res = await sendEmailHandler(baseRequest({ to: ["Dest <DEST@EXAMPLE.COM>"] }));
  expect(res.status).toBe(400);
  expect(sendCalled).toBe(0);
});

test("multi-recipient send fails if any recipient is suppressed", async () => {
  routeWithSuppression(["blocked@example.com"]);
  const res = await sendEmailHandler(baseRequest({ to: ["ok@example.com", "blocked@example.com"], cc: ["other@example.com"] }));
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.suppressed).toContain("blocked@example.com");
  expect(sendCalled).toBe(0);
});

test("sends to non-suppressed recipients still succeed when cc/bcc are clean", async () => {
  routeWithSuppression(["other@example.com"]);
  const res = await sendEmailHandler(baseRequest({ to: ["ok@example.com"], cc: ["clean@example.com"] }));
  expect(res.status).toBe(200);
  expect(sendCalled).toBe(1);
});

test("suppression in cc or bcc is also blocked", async () => {
  routeWithSuppression(["blocked@example.com"]);
  const res = await sendEmailHandler(baseRequest({ to: ["ok@example.com"], cc: ["blocked@example.com"] }));
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.suppressed).toContain("blocked@example.com");
});

test("cross-tenant isolation: suppression for one domain does not block another", async () => {
  // Suppress dest@example.com for otherDomainId, but our apiKey is bound to domainId
  const otherSuppressed = new Set(["dest@example.com"]);
  onFakeQuery((sql, params = []) => {
    if (sql.includes("FROM suppressions")) {
      const domain = params[0] as string;
      if (domain === otherDomainId) {
        const emails = params[1] as string[];
        const matched = emails.filter((e) => otherSuppressed.has(e.toLowerCase()));
        return { rows: matched.map((email) => ({ email })), rowCount: matched.length };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM domains")) return { rows: [domainRow], rowCount: 1 };
    if (sql.includes("INSERT INTO email_logs")) return { rows: [{ id: logId }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const res = await sendEmailHandler(baseRequest());
  expect(res.status).toBe(200);
  expect(sendCalled).toBe(1);
});

test("suppressed send returns actionable message mentioning suppression list", async () => {
  routeWithSuppression(["dest@example.com"]);
  const res = await sendEmailHandler(baseRequest());
  const body = await res.json();
  expect(body.error).toMatch(/suppression list/i);
});

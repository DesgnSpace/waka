import { beforeEach, expect, mock, test } from "bun:test";
import { HttpError } from "./http";
import type { Req } from "./http";
import { executedQueries, installFakeDatabase, onFakeQuery } from "@/lib/fake-database";
import { fakeRateLimitModule } from "@/lib/fake-rate-limit";

process.env.NEXTAUTH_SECRET ??= "test-secret-test-secret-test-secret-32";

const userId = "11111111-1111-4111-8111-111111111111";
const apiKeyId = "22222222-2222-4222-8222-222222222222";
const domainId = "33333333-3333-4333-8333-333333333333";
const logId = "44444444-4444-4444-8444-444444444444";

import { ExpiredApiKeyError } from "@/lib/api-keys";

const apiKeyBase = {
  id: apiKeyId,
  user_id: userId,
  domain_id: domainId,
  key_name: "test key",
  key_prefix: "wka_test",
  permissions: ["send"],
  expires_at: null as string | null,
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
mock.module("@/lib/auth", () => {
  const jwt = require("jsonwebtoken");
  return {
    authenticateUser: async () => null,
    createUser: async () => {},
    generateJWT: (user: { id: string; email: string; name?: string }) =>
      jwt.sign({ id: user.id, email: user.email, name: user.name }, process.env.NEXTAUTH_SECRET!, { algorithm: "HS256", expiresIn: "1h" }),
    verifyJWT: (token: string) => {
      try {
        const dec = jwt.verify(token, process.env.NEXTAUTH_SECRET!, { algorithms: ["HS256"] }) as Record<string, unknown>;
        if (typeof dec.id === "string" && typeof dec.email === "string") return { id: dec.id as string, email: dec.email as string, name: dec.name as string | undefined };
        return null;
      } catch { return null; }
    },
  };
});
mock.module("@/lib/api-keys", () => ({
  verifyApiKey: async (token: string) => {
    if (token.startsWith("wka_expired")) throw new ExpiredApiKeyError(new Date(Date.now() - 60000).toISOString());
    if (token.startsWith("wka_future")) return { ...apiKeyBase, key_prefix: "wka_future", expires_at: new Date(Date.now() + 3600000).toISOString() };
    if (token.startsWith("wka_noexpiry")) return { ...apiKeyBase, key_prefix: "wka_noexpiry", expires_at: null };
    if (token.startsWith("wka_test")) return apiKeyBase;
    if (token.startsWith("wka_send"))
      return { id: "00000000-0000-4000-a000-0000000000cc", user_id: "00000000-0000-4000-a000-00000000000a", domain_id: "00000000-0000-4000-a000-0000000000aa", key_name: "test key", key_prefix: "wka_send", permissions: ["send"], expires_at: null };
    if (token.startsWith("wka_nosend"))
      return { id: "00000000-0000-4000-a000-00000000000a", user_id: "00000000-0000-4000-a000-00000000000a", domain_id: "00000000-0000-4000-a000-0000000000aa", key_name: "test key", key_prefix: "wka_nosend", permissions: [], expires_at: null };
    return null;
  },
  generateApiKey: async () => { throw new Error("not used"); },
  getUserApiKeys: async () => [],
  deleteApiKey: async () => {},
  updateApiKey: async () => {},
  updateApiKeyPermissions: async () => {},
}));
const unusedSesFn = async () => { throw new Error("not used"); };
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

const { sendEmailHandler, getEmail, createApiKey, updateApiKey } = await import("./handlers");
const { generateJWT } = await import("@/lib/auth");

const domainRow = {
  id: domainId, user_id: userId, domain: "example.com", status: "verified",
  ses_identity_arn: null, ses_configuration_set: null, do_domain_id: null, mail_from_domain: null,
  dns_records: [], created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
};

beforeEach(() => {
  executedQueries.length = 0;
  sendResult = { ok: true, messageId: "ses-id" };
  onFakeQuery((sql, params = []) => {
    if (sql.includes("FROM suppressions")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM domains")) return params[0] === domainId && params[1] === userId ? { rows: [domainRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes("FROM api_keys")) return { rows: [], rowCount: 0 };
    if (sql.includes("rate_limit_buckets")) return { rows: [], rowCount: 0 };
    if (sql.includes("idempotency_keys")) return { rows: [], rowCount: 0 };
    return { rows: [{ id: logId }], rowCount: 1 };
  });
});

function sendReq(token: string): Req {
  return new Request("http://localhost/api/emails", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) }) as Req;
}

test("unexpired key works - send succeeds", async () => {
  const future = `wka_future_${"a".repeat(32)}`;
  const res = await sendEmailHandler(sendReq(future));
  expect(res.status).toBe(200);
});

test("expired key is refused with distinct error", async () => {
  const expired = `wka_expired_${"a".repeat(32)}`;
  let thrown: unknown;
  try { await sendEmailHandler(sendReq(expired)); } catch (e) { thrown = e; }
  expect(thrown).toBeInstanceOf(HttpError);
  expect((thrown as HttpError).status).toBe(401);
  expect((thrown as HttpError).body).toEqual({ error: "This API key has expired. Create a new API key for this domain to continue." });
});

test("key with no expiry is unaffected", async () => {
  const noexpiry = `wka_noexpiry_${"a".repeat(32)}`;
  const res = await sendEmailHandler(sendReq(noexpiry));
  expect(res.status).toBe(200);
});

test("permission kept (send) is enforced - key without send cannot send", async () => {
  const nosend = `wka_nosend_${"a".repeat(32)}`;
  const res = await sendEmailHandler(sendReq(nosend));
  // handler returns 403 json, not throw
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toContain("can't send");
});

test("permission kept (send) enforced on getEmail", async () => {
  const nosend = `wka_nosend_${"a".repeat(32)}`;
  const req = new Request(`http://localhost/api/emails/${logId}`, { headers: { authorization: `Bearer ${nosend}` } }) as Req;
  (req as unknown as { params: Record<string,string> }).params = { id: logId };
  const res = await getEmail(req);
  expect(res.status).toBe(403);
});

test("createApiKey rejects receive permission via schema", async () => {
  const token = generateJWT({ id: userId, email: "a@example.com" });
  const req = new Request("http://localhost/api/api-keys", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ domainId, keyName: "k", permissions: ["receive"] }) }) as unknown as Req;
  let thrown: unknown;
  try { await createApiKey(req); } catch (e) { thrown = e; }
  expect(thrown).toBeDefined();
  expect(String(thrown)).toContain("receive");
});

test("createApiKey rejects webhooks permission", async () => {
  const token = generateJWT({ id: userId, email: "a@example.com" });
  const req = new Request("http://localhost/api/api-keys", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ domainId, keyName: "k", permissions: ["webhooks"] }) }) as unknown as Req;
  let thrown: unknown;
  try { await createApiKey(req); } catch (e) { thrown = e; }
  expect(thrown).toBeDefined();
  expect(String(thrown)).toContain("webhooks");
});

import { beforeEach, expect, mock, test } from "bun:test";

import type { Req } from "@/server/http";
import { executedQueries, installFakeDatabase, onFakeQuery } from "./fake-database";

process.env.NEXTAUTH_SECRET ??= "test-secret-test-secret-test-secret-32";

mock.module("@/lib/auth", () => {
  const jwt = require("jsonwebtoken");
  return {
    authenticateUser: async () => null,
    createUser: async () => {},
    generateJWT: (user: { id: string; email: string; name?: string }) =>
      jwt.sign(
        { id: user.id, email: user.email, name: user.name },
        process.env.NEXTAUTH_SECRET!,
        { algorithm: "HS256", expiresIn: "1h" },
      ),
    verifyJWT: (token: string) => {
      try {
        const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET!, {
          algorithms: ["HS256"],
        }) as Record<string, unknown>;
        if (typeof decoded.id === "string" && typeof decoded.email === "string") {
          return { id: decoded.id as string, email: decoded.email as string, name: decoded.name as string | undefined };
        }
        return null;
      } catch {
        return null;
      }
    },
  };
});
mock.module("@/lib/api-keys", () => ({
  verifyApiKey: async (token: string) => {
    if (token.startsWith("wka_send"))
      return {
        id: "00000000-0000-4000-a000-0000000000cc",
        user_id: "00000000-0000-4000-a000-00000000000a",
        domain_id: "00000000-0000-4000-a000-0000000000aa",
        key_name: "test key",
        key_prefix: "wka_send",
        permissions: ["send"],
      };
    if (token.startsWith("wka_nosend"))
      return {
        id: "00000000-0000-4000-a000-0000000000cc",
        user_id: "00000000-0000-4000-a000-00000000000a",
        domain_id: "00000000-0000-4000-a000-0000000000aa",
        key_name: "test key",
        key_prefix: "wka_nosend",
        permissions: ["webhooks"],
      };
    if (token.startsWith("wka_test"))
      return {
        id: "22222222-2222-4222-8222-222222222222",
        user_id: "11111111-1111-4111-8111-111111111111",
        domain_id: "33333333-3333-4333-8333-333333333333",
        key_name: "test key",
        key_prefix: "wka_test",
        permissions: ["send"],
      };
    return null;
  },
  generateApiKey: async () => {
    throw new Error("not used");
  },
  getUserApiKeys: async () => [],
  deleteApiKey: async () => {},
  updateApiKeyPermissions: async () => {},
}));

const accountA = "00000000-0000-4000-a000-00000000000a";
const accountB = "00000000-0000-4000-a000-00000000000b";
const domainA = "00000000-0000-4000-a000-0000000000aa";
const domainB = "00000000-0000-4000-a000-0000000000bb";
const keySendToken = "wka_send_1_abcdefghijklmnopqrstuvwxyzabcdef";
const keyNoSendToken = "wka_nosend_1_abcdefghijklmnopqrstuvwxyzabcdef";
const keyId = "00000000-0000-4000-a000-0000000000cc";

const messages: Record<string, { user_id: string; domain_id: string }> = {
  "00000000-0000-4000-a000-0000000000a1": { user_id: accountA, domain_id: domainA },
  "00000000-0000-4000-a000-0000000000b2": { user_id: accountB, domain_id: domainB },
};

const emailLogRow = (id: string, ownerId: string) => ({
  id,
  api_key_id: keyId,
  domain_id: messages[id].domain_id,
  from_email: "hello@sender.example",
  to_emails: JSON.stringify(["dest@example.com"]),
  cc_emails: JSON.stringify([]),
  bcc_emails: JSON.stringify([]),
  subject: "Hello",
  html_content: null,
  text_content: "Hi there",
  attachments: JSON.stringify([]),
  status: "delivered",
  ses_message_id: "ses-message-1",
  error_message: null,
  webhook_data: null,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  domain_name: "sender.example",
  domain_user_id: ownerId,
  api_key_name: "test key",
});

installFakeDatabase("./database");

const { getDomainById } = await import("./domains");
const { generateJWT } = await import("./auth");
const { getEmail } = await import("@/server/handlers");

beforeEach(() => {
  executedQueries.length = 0;
  onFakeQuery((sql, params = []) => {
    if (sql.includes("FROM domains")) {
      return params[1] === accountB
        ? { rows: [{ id: domainB, user_id: accountB, dns_records: [] }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM email_logs el")) {
      const message = messages[String(params[0])];
      const inScope =
        message !== undefined &&
        message.user_id === params[1] &&
        (params[2] === null || params[2] === message.domain_id);
      return inScope ? { rows: [emailLogRow(String(params[0]), message.user_id)], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
});

function emailRequest(id: string, token?: string): Req {
  const request = new Request(`http://localhost/api/emails/${id}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }) as Req;
  request.params = { id };
  return request;
}

function emailFetchQueries() {
  return executedQueries.filter((q) => q.sql.includes("FROM email_logs el"));
}

test("an account cannot read another account's domain by id", async () => {
  const result = await getDomainById(domainB, accountA);

  expect(result).toBeNull();
  const call = executedQueries.find((q) => q.sql.includes("WHERE id = $1 AND user_id = $2"));
  expect(call?.params).toEqual([domainB, accountA]);
});

test("the owning account can read its domain by id", async () => {
  const result = await getDomainById(domainB, accountB);

  expect(result?.id).toBe(domainB);
  expect(result?.user_id).toBe(accountB);
});

test("a domain query always binds the account id", async () => {
  await getDomainById(domainB, accountA);

  const last = executedQueries.at(-1);
  expect(last?.params).toEqual([domainB, accountA]);
});

test("an API key reads back a message from its own domain", async () => {
  const res = await getEmail(emailRequest("00000000-0000-4000-a000-0000000000a1", keySendToken));

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.email.id).toBe("00000000-0000-4000-a000-0000000000a1");

  const fetch = emailFetchQueries()[0];
  expect(fetch.params).toEqual([
    "00000000-0000-4000-a000-0000000000a1",
    accountA,
    domainA,
  ]);
  expect(fetch.sql).toContain("el.domain_id = $3");
});

test("an API key cannot fetch another domain's message by id", async () => {
  const res = await getEmail(emailRequest("00000000-0000-4000-a000-0000000000b2", keySendToken));

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Email not found" });
  expect(emailFetchQueries()[0]?.params).toEqual([
    "00000000-0000-4000-a000-0000000000b2",
    accountA,
    domainA,
  ]);
});

test("a foreign-domain message and a missing message are indistinguishable", async () => {
  const foreign = await getEmail(
    emailRequest("00000000-0000-4000-a000-0000000000b2", keySendToken),
  );
  const missing = await getEmail(
    emailRequest("00000000-0000-4000-a000-000000000099", keySendToken),
  );

  expect(missing.status).toBe(foreign.status);
  expect(await missing.json()).toEqual(await foreign.json());
});

test("a key without send permission cannot fetch messages", async () => {
  const res = await getEmail(emailRequest("00000000-0000-4000-a000-0000000000a1", keyNoSendToken));

  expect(res.status).toBe(403);
  expect(emailFetchQueries()).toHaveLength(0);
});

test("a dashboard JWT reads back its own message with no domain narrowing", async () => {
  const token = generateJWT({ id: accountA, email: "a@example.com" });
  const res = await getEmail(emailRequest("00000000-0000-4000-a000-0000000000a1", token));

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.email.domain_user_id).toBe(accountA);

  const fetch = emailFetchQueries()[0];
  expect(fetch.params).toEqual([
    "00000000-0000-4000-a000-0000000000a1",
    accountA,
    null,
  ]);
});

test("a dashboard JWT still cannot read another account's message", async () => {
  const token = generateJWT({ id: accountA, email: "a@example.com" });
  const res = await getEmail(emailRequest("00000000-0000-4000-a000-0000000000b2", token));

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "Email not found" });
});

test("an expired or invalid dashboard session keeps the dashboard 401", async () => {
  let thrown: unknown;
  try {
    await getEmail(emailRequest("00000000-0000-4000-a000-0000000000a1", "not-a-jwt"));
  } catch (error) {
    thrown = error;
  }

  expect((thrown as { status: number }).status).toBe(401);
  expect((thrown as { body: unknown }).body).toEqual({ error: "Your session expired. Sign in again." });
});

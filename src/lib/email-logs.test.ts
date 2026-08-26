import { beforeEach, expect, mock, test } from "bun:test";
import { executedQueries, installFakeDatabase, onFakeQuery } from "./fake-database";

process.env.NEXTAUTH_SECRET ??= "test-secret-test-secret-test-secret-32";

mock.module("@/lib/auth", () => {
  const jwt = require("jsonwebtoken");
  return {
    authenticateUser: async () => null,
    createUser: async () => {},
    generateJWT: (user: { id: string; email: string }) =>
      jwt.sign({ id: user.id, email: user.email }, process.env.NEXTAUTH_SECRET!, { algorithm: "HS256", expiresIn: "1h" }),
    verifyJWT: (token: string) => {
      try {
        const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET!, { algorithms: ["HS256"] }) as Record<string, unknown>;
        if (typeof decoded.id === "string" && typeof decoded.email === "string") return { id: decoded.id, email: decoded.email };
        return null;
      } catch { return null; }
    },
  };
});
mock.module("@/lib/api-keys", () => ({
  ExpiredApiKeyError: class ExpiredApiKeyError extends Error { expiresAt: string; constructor(v: string) { super(v); this.expiresAt = v; this.name = "ExpiredApiKeyError"; } },
  verifyApiKey: async (token: string) => {
    if (token.startsWith("wka_test"))
      return { id: "22222222-2222-4222-8222-222222222222", user_id: "11111111-1111-4111-8111-111111111111", domain_id: "33333333-3333-4333-8333-333333333333", key_name: "k", key_prefix: "wka_test", permissions: ["send"] };
    return null;
  },
  generateApiKey: async () => { throw new Error("not used"); },
  getUserApiKeys: async () => [],
  deleteApiKey: async () => {},
  updateApiKey: async () => {},
}));

installFakeDatabase("@/lib/database");
const { searchEmailLogs } = await import("./email-logs");

const userA = "11111111-1111-4111-8111-111111111111";
const userB = "99999999-9999-4999-8999-999999999999";
const domainA = "33333333-3333-4333-8333-333333333333";
const domainB = "44444444-4444-4444-8444-444444444444";

function fakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    api_key_id: "22222222-2222-4222-8222-222222222222",
    domain_id: domainA,
    message_id: null,
    from_email: "from@example.com",
    to_emails: JSON.stringify(["to@example.com"]),
    cc_emails: JSON.stringify([]),
    bcc_emails: JSON.stringify([]),
    subject: "Hello world",
    html_content: null,
    text_content: "hi",
    attachments: JSON.stringify([]),
    status: "sent",
    ses_message_id: "ses-1",
    error_message: null,
    webhook_data: null,
    created_at: new Date("2026-01-15T12:00:00Z").toISOString(),
    updated_at: new Date("2026-01-15T12:00:00Z").toISOString(),
    domain_name: "example.com",
    api_key_name: "k",
    ...overrides,
  };
}

beforeEach(() => {
  executedQueries.length = 0;
  onFakeQuery((sql) => {
    if (sql.includes("COUNT(*) as count")) return { rows: [{ count: "1" }], rowCount: 1 };
    if (sql.includes("FROM email_logs el")) return { rows: [fakeRow()], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

test("no filters keeps status and domain null params and no extra clauses", async () => {
  await searchEmailLogs({ domainIds: [domainA], scopedUserId: userA, filters: {}, limit: 50, offset: 0 });
  const countSql = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.sql;
  expect(countSql).toContain("($3::uuid IS NULL OR el.domain_id = $3::uuid)");
  expect(countSql).toContain("($4::text IS NULL OR el.status = $4::text)");
  expect(countSql).not.toContain("recipient_search");
  expect(countSql).not.toContain("lower(el.subject)");
});

test("recipient filter adds LIKE clause with parameter", async () => {
  await searchEmailLogs({ domainIds: [domainA], scopedUserId: userA, filters: { recipient: "alice@example.com" }, limit: 50, offset: 0 });
  const sql = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.sql;
  expect(sql).toContain("recipient_search LIKE");
  const params = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.params as unknown[];
  expect(params).toContain("alice@example.com");
  // verify not interpolated
  expect(sql).not.toContain("alice@example.com");
});

test("subject filter adds lower(subject) LIKE", async () => {
  await searchEmailLogs({ domainIds: [domainA], scopedUserId: userA, filters: { subject: "Welcome" }, limit: 50, offset: 0 });
  const sql = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.sql;
  expect(sql).toContain("lower(el.subject) LIKE");
  const params = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.params as unknown[];
  expect(params).toContain("Welcome");
  expect(sql).not.toContain("Welcome");
});

test("date range adds both bounds", async () => {
  await searchEmailLogs({
    domainIds: [domainA], scopedUserId: userA,
    filters: { fromDate: "2026-01-01T00:00:00.000Z", toDate: "2026-01-31T23:59:59.999Z" },
    limit: 50, offset: 0,
  });
  const sql = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.sql;
  expect(sql).toContain("el.created_at >=");
  expect(sql).toContain("el.created_at <=");
});

test("messageId adds OR clause across id columns", async () => {
  await searchEmailLogs({ domainIds: [domainA], scopedUserId: userA, filters: { messageId: "ses-1" }, limit: 50, offset: 0 });
  const sql = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.sql;
  expect(sql).toContain("el.id::text =");
  expect(sql).toContain("el.ses_message_id =");
  expect(sql).toContain("el.message_id =");
  const params = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.params as unknown[];
  expect(params).toContain("ses-1");
});

test("combined filters all appear with AND", async () => {
  await searchEmailLogs({
    domainIds: [domainA], scopedUserId: userA,
    filters: { recipient: "bob@example.com", subject: "Invoice", fromDate: "2026-01-01T00:00:00.000Z", toDate: "2026-02-01T00:00:00.000Z", messageId: "abc", status: "sent", domainId: domainA },
    limit: 20, offset: 0,
  });
  const sql = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.sql;
  expect(sql).toContain("recipient_search LIKE");
  expect(sql).toContain("lower(el.subject) LIKE");
  expect(sql).toContain("el.created_at >=");
  expect(sql).toContain("el.created_at <=");
  expect(sql).toContain("el.id::text =");
  // status and domain are equality checks
  expect(sql).toContain("el.status =");
  expect(sql).toContain("el.domain_id =");
});

test("tenant isolation always scopes by domainIds and user", async () => {
  await searchEmailLogs({ domainIds: [domainA], scopedUserId: userA, filters: { recipient: "leak@example.com" }, limit: 50, offset: 0 });
  const sql = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.sql;
  expect(sql).toContain("el.domain_id = ANY($1)");
  expect(sql).toContain("EXISTS (SELECT 1 FROM domains d WHERE d.id = el.domain_id AND d.user_id = $2)");
  const params = executedQueries.find((q) => q.sql.includes("COUNT(*)"))!.params as unknown[];
  expect(params[0]).toEqual([domainA]);
  expect(params[1]).toBe(userA);
});

test("empty domainIds returns empty without querying", async () => {
  executedQueries.length = 0;
  const res = await searchEmailLogs({ domainIds: [], scopedUserId: userA, filters: { subject: "x" }, limit: 50, offset: 0 });
  expect(res.total).toBe(0);
  expect(res.logs).toEqual([]);
  expect(executedQueries).toHaveLength(0);
});

test("filter values are passed as parameters never interpolated", async () => {
  const evil = "'; DROP TABLE email_logs; --";
  await searchEmailLogs({ domainIds: [domainA], scopedUserId: userA, filters: { subject: evil, recipient: evil, messageId: evil }, limit: 10, offset: 0 });
  for (const q of executedQueries) {
    expect(q.sql).not.toContain("DROP TABLE");
  }
  const params = executedQueries.flatMap((q) => q.params as unknown[]);
  expect(params).toContain(evil);
});

test("pagination limit/offset are parameterized", async () => {
  await searchEmailLogs({ domainIds: [domainA], scopedUserId: userA, filters: {}, limit: 25, offset: 50 });
  const dataQ = executedQueries.find((q) => q.sql.includes("LIMIT $"))!;
  expect(dataQ.sql).toContain("LIMIT $");
  expect(dataQ.sql).toContain("OFFSET $");
  const params = dataQ.params as unknown[];
  expect(params.at(-2)).toBe(25);
  expect(params.at(-1)).toBe(50);
});

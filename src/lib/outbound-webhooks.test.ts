import { beforeEach, expect, test } from "bun:test";
import { executedQueries, installFakeDatabase, onFakeQuery } from "./fake-database";

installFakeDatabase("./database");

const {
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  MAX_DELIVERY_ATTEMPTS,
  INITIAL_DELAY_SECONDS,
  MAX_DELAY_SECONDS,
  DISABLE_AFTER_CONSECUTIVE_FAILURES,
  buildSignedString,
  computeSignature,
  buildSignatureHeader,
  verifySignature,
  backoffDelaySeconds,
  nextAttemptAt,
  planAfterDeliveryFailure,
  isValidWebhookUrl,
  generateWebhookSecret,
} = await import("./outbound-webhooks");

test("signed string is timestamp dot raw body", () => {
  expect(buildSignedString("1724600000", '{"type":"delivered"}')).toBe('1724600000.{"type":"delivered"}');
  expect(buildSignedString("0", "")).toBe("0.");
});

test("signature is deterministic HMAC-SHA256 hex", () => {
  const secret = "a".repeat(64);
  const timestamp = "1724600000";
  const body = '{"type":"delivered"}';
  const sig1 = computeSignature(secret, timestamp, body);
  const sig2 = computeSignature(secret, timestamp, body);
  expect(sig1).toBe(sig2);
  expect(sig1).toMatch(/^[a-f0-9]{64}$/);
});

test("signature changes when timestamp changes", () => {
  const secret = "secret123";
  const body = '{"hello":"world"}';
  const a = computeSignature(secret, "1000", body);
  const b = computeSignature(secret, "1001", body);
  expect(a).not.toBe(b);
});

test("signature changes when body changes", () => {
  const secret = "secret123";
  const ts = "1000";
  expect(computeSignature(secret, ts, '{"a":1}')).not.toBe(computeSignature(secret, ts, '{"a":2}'));
});

test("signature changes when secret changes", () => {
  const ts = "1000";
  const body = "{}";
  expect(computeSignature("secret1", ts, body)).not.toBe(computeSignature("secret2", ts, body));
});

test("buildSignatureHeader prefixes with version", () => {
  expect(buildSignatureHeader("abc123")).toBe(`${WEBHOOK_SIGNATURE_VERSION}=abc123`);
});

test("verifySignature accepts correct header and rejects tampered", () => {
  const secret = generateWebhookSecret();
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ type: "bounce", created_at: new Date().toISOString() });
  const sig = computeSignature(secret, ts, body);
  const header = buildSignatureHeader(sig);
  expect(verifySignature(secret, ts, body, header)).toBe(true);
  expect(verifySignature(secret, ts, body, "v1=0" + sig.slice(1))).toBe(false);
  expect(verifySignature(secret, (Number(ts) + 1).toString(), body, header)).toBe(false);
  expect(verifySignature("other-secret", ts, body, header)).toBe(false);
  expect(verifySignature(secret, ts, body + " ", header)).toBe(false);
});

test("isValidWebhookUrl only allows https", () => {
  expect(isValidWebhookUrl("https://example.com/hooks")).toBe(true);
  expect(isValidWebhookUrl("https://example.com:8443/path?x=1")).toBe(true);
  expect(isValidWebhookUrl("http://example.com/hooks")).toBe(false);
  expect(isValidWebhookUrl("https://")).toBe(false);
  expect(isValidWebhookUrl("not-a-url")).toBe(false);
  expect(isValidWebhookUrl("")).toBe(false);
  expect(isValidWebhookUrl("ftp://example.com")).toBe(false);
});

test("generateWebhookSecret is hex 64 chars and unique", () => {
  const a = generateWebhookSecret();
  const b = generateWebhookSecret();
  expect(a).toMatch(/^[a-f0-9]{64}$/);
  expect(b).toMatch(/^[a-f0-9]{64}$/);
  expect(a).not.toBe(b);
});

test("backoff delays exponential and capped", () => {
  expect(backoffDelaySeconds(0)).toBe(0);
  expect(backoffDelaySeconds(1)).toBe(INITIAL_DELAY_SECONDS);
  expect(backoffDelaySeconds(2)).toBe(INITIAL_DELAY_SECONDS * 2);
  expect(backoffDelaySeconds(3)).toBe(INITIAL_DELAY_SECONDS * 4);
  expect(backoffDelaySeconds(4)).toBe(INITIAL_DELAY_SECONDS * 8);
  // exponential until cap
  const attemptThatHitsCap = Math.ceil(Math.log2(MAX_DELAY_SECONDS / INITIAL_DELAY_SECONDS)) + 1;
  expect(backoffDelaySeconds(attemptThatHitsCap)).toBe(MAX_DELAY_SECONDS);
  expect(backoffDelaySeconds(attemptThatHitsCap + 5)).toBe(MAX_DELAY_SECONDS);
  // ensure strictly increasing until cap
  for (let i = 1; i < 6; i++) {
    expect(backoffDelaySeconds(i + 1)).toBeGreaterThan(backoffDelaySeconds(i));
  }
});

test("nextAttemptAt adds delay to now", () => {
  const now = new Date("2026-08-26T12:00:00.000Z");
  expect(nextAttemptAt(0, now)).toEqual(now);
  expect(nextAttemptAt(1, now)).toEqual(new Date(now.getTime() + INITIAL_DELAY_SECONDS * 1000));
  expect(nextAttemptAt(2, now)).toEqual(new Date(now.getTime() + INITIAL_DELAY_SECONDS * 2 * 1000));
});

test("planAfterDeliveryFailure retries until max attempts then dead", () => {
  const now = new Date("2026-08-26T12:00:00.000Z");
  // attempts counts the attempt that just failed; 1..MAX-1 retry, MAX dead
  for (let attempts = 1; attempts < MAX_DELIVERY_ATTEMPTS; attempts++) {
    const plan = planAfterDeliveryFailure(attempts, now);
    expect(plan.action).toBe("retry");
    if (plan.action === "retry") {
      expect(plan.retryAt.getTime()).toBeGreaterThan(now.getTime());
    }
  }
  // 0 attempts is immediate (not used in worker which increments before delivery)
  expect(planAfterDeliveryFailure(0, now).action).toBe("retry");
  expect(planAfterDeliveryFailure(MAX_DELIVERY_ATTEMPTS, now)).toEqual({ action: "dead" });
  expect(planAfterDeliveryFailure(MAX_DELIVERY_ATTEMPTS + 5, now)).toEqual({ action: "dead" });
});

test("header names are the documented ones", () => {
  expect(WEBHOOK_TIMESTAMP_HEADER).toBe("X-Waka-Timestamp");
  expect(WEBHOOK_SIGNATURE_HEADER).toBe("X-Waka-Signature");
});

test("disable threshold is documented constant", () => {
  expect(DISABLE_AFTER_CONSECUTIVE_FAILURES).toBe(5);
});

const userA = "00000000-0000-0000-0000-0000000000aa";
const userB = "00000000-0000-0000-0000-0000000000bb";
const endpointA = "00000000-0000-0000-0000-00000000a001";

const outbound = await import("./outbound-webhooks");

test("listWebhookEndpoints binds the caller user id", async () => {
  executedQueries.length = 0;
  onFakeQuery(() => ({ rows: [], rowCount: 0 }));
  await outbound.listWebhookEndpoints(userA);
  const call = executedQueries.find((q) => q.sql.includes("FROM webhook_endpoints"));
  expect(call?.params).toEqual([userA]);
  expect(call?.sql).toMatch(/WHERE user_id = \$1/);
});

test("deleteWebhookEndpoint binds both id and user id", async () => {
  executedQueries.length = 0;
  onFakeQuery(() => ({ rows: [], rowCount: 1 }));
  await outbound.deleteWebhookEndpoint(endpointA, userA);
  const call = executedQueries.find((q) => q.sql.includes("DELETE FROM webhook_endpoints"));
  expect(call?.params).toEqual([endpointA, userA]);
});

test("an account cannot delete another account endpoint via user scoping", async () => {
  executedQueries.length = 0;
  onFakeQuery(() => ({ rows: [], rowCount: 0 }));
  let err: unknown;
  try {
    await outbound.deleteWebhookEndpoint(endpointA, userB);
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  const call = executedQueries.find((q) => q.sql.includes("DELETE FROM webhook_endpoints"));
  expect(call?.params).toEqual([endpointA, userB]);
});

test("getWebhookEndpointSecret binds both id and user id", async () => {
  executedQueries.length = 0;
  onFakeQuery(() => ({ rows: [{ secret: "abc" }], rowCount: 1 }));
  const secret = await outbound.getWebhookEndpointSecret(endpointA, userA);
  expect(secret).toBe("abc");
  const call = executedQueries.find((q) => q.sql.includes("SELECT secret FROM webhook_endpoints"));
  expect(call?.params).toEqual([endpointA, userA]);
});

test("rotateWebhookEndpointSecret binds both id and user id", async () => {
  executedQueries.length = 0;
  onFakeQuery(() => ({ rows: [], rowCount: 1 }));
  const secret = await outbound.rotateWebhookEndpointSecret(endpointA, userA);
  expect(secret).toMatch(/^[a-f0-9]{64}$/);
  const call = executedQueries.find((q) => q.sql.includes("UPDATE webhook_endpoints SET secret"));
  expect(call?.params?.[1]).toBe(endpointA);
  expect(call?.params?.[2]).toBe(userA);
});

test("createWebhookEndpoint inserts with caller user id", async () => {
  executedQueries.length = 0;
  onFakeQuery((sql, params = []) => {
    if (sql.includes("INSERT INTO webhook_endpoints")) {
      return { rows: [{ id: endpointA, user_id: params[0], url: params[1], secret: params[2], enabled: true, consecutive_failures: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await outbound.createWebhookEndpoint(userA, "https://example.com/hook");
  expect(result.user_id).toBe(userA);
  const call = executedQueries.find((q) => q.sql.includes("INSERT INTO webhook_endpoints"));
  expect(call?.params?.[0]).toBe(userA);
  expect(call?.params?.[1]).toBe("https://example.com/hook");
});

test("enqueueOutboundDeliveries scopes to domain owner", async () => {
  executedQueries.length = 0;
  const domainId = "00000000-0000-0000-0000-0000000000dd";
  onFakeQuery((sql, params = []) => {
    if (sql.includes("FROM webhook_endpoints")) {
      expect(params?.[0]).toBe(domainId);
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  await outbound.enqueueOutboundDeliveries("email-log-id", domainId, "delivered", { type: "delivered" });
  const call = executedQueries.find((q) => q.sql.includes("FROM webhook_endpoints"));
  expect(call?.sql).toMatch(/SELECT user_id FROM domains WHERE id = \$1/);
});

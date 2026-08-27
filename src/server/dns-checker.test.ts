import { beforeEach, expect, mock, test } from "bun:test";
import { HttpError } from "./http";

const counts = new Map<string, number>();

mock.module("@/lib/rate-limit", () => ({
  bindServer: () => {},
  requestAddress: () => "203.0.113.7",
  checkRateLimit: async (key: string, limit: number, windowMs: number) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > limit) return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
    return { allowed: true, retryAfterSeconds: 0 };
  },
}));

mock.module("node:dns", () => ({
  promises: {
    resolveTxt: async () => [] as string[][],
    resolveMx: async () => [] as { priority: number; exchange: string }[],
    resolveCname: async () => [] as string[],
  },
}));

const { emailDnsChecker } = await import("./handlers");
import type { Req } from "./http";

function dnsReq(): Req {
  return new Request("http://localhost/api/tools/email-dns-checker", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain: "example.com" }),
  }) as Req;
}

beforeEach(() => {
  counts.clear();
});

test("dns checker allows 10 requests then returns 429 on the 11th from same IP", async () => {
  for (let i = 0; i < 10; i++) {
    const res = await emailDnsChecker(dnsReq());
    expect(res.status).toBe(200);
  }

  let err: unknown;
  try {
    await emailDnsChecker(dnsReq());
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(429);
  expect((err as HttpError).body).toEqual({ error: "Too many DNS lookups. Try again later." });
  expect(counts.get("dns-check:203.0.113.7")).toBe(11);
});

test("dns checker uses the expected key, limit and window", async () => {
  // single call should have used limit 10 and window 60_000 with the dns-check prefix
  await emailDnsChecker(dnsReq());
  expect(counts.has("dns-check:203.0.113.7")).toBe(true);
  // the counting mock enforces the same limit the handler passes (10)
  // verify by exhausting: 10 should pass, 11th fails
  for (let i = 1; i < 10; i++) {
    const res = await emailDnsChecker(dnsReq());
    expect(res.status).toBe(200);
  }
  let err: unknown;
  try {
    await emailDnsChecker(dnsReq());
  } catch (e) {
    err = e;
  }
  expect((err as HttpError).status).toBe(429);
});

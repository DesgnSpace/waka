import { afterEach, beforeEach, expect, test } from "bun:test";
import { bindServer, requestAddress } from "./rate-limit";

function req(headers: Record<string, string>): Request {
  return new Request("https://waka.test/", { headers });
}

let savedTrustProxy: string | undefined;

beforeEach(() => {
  savedTrustProxy = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
});

afterEach(() => {
  if (savedTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = savedTrustProxy;
});

test("ignores forwarded headers when TRUST_PROXY is unset", () => {
  expect(
    requestAddress(req({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.2" })),
  ).toBe("unknown");
});

test("rejects unknown TRUST_PROXY values", () => {
  for (const value of ["false", "0", "no", "ture", ""]) {
    process.env.TRUST_PROXY = value;
    expect(requestAddress(req({ "x-forwarded-for": "203.0.113.7" }))).toBe("unknown");
  }
});

test("accepts canonical TRUST_PROXY values", () => {
  const request = req({ "x-forwarded-for": "203.0.113.7" });
  for (const value of ["true", "TRUE", "1", "yes", " true "]) {
    process.env.TRUST_PROXY = value;
    expect(requestAddress(request)).toBe("203.0.113.7");
  }
});

test("takes the rightmost entry of a forwarded chain when trusted", () => {
  process.env.TRUST_PROXY = "true";
  const request = req({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" });
  expect(requestAddress(request)).toBe("150.172.238.178");
});

test("ignores a forwarded entry the client put in front of the proxy entry", () => {
  process.env.TRUST_PROXY = "true";
  expect(requestAddress(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe(
    "203.0.113.7",
  );
});

test("trims whitespace around the proxy entry", () => {
  process.env.TRUST_PROXY = "yes";
  expect(requestAddress(req({ "x-forwarded-for": "70.41.3.18, 203.0.113.7 , " }))).toBe(
    "203.0.113.7",
  );
});

test("prefers x-real-ip over a spoofed forwarded chain when trusted", () => {
  process.env.TRUST_PROXY = "1";
  expect(
    requestAddress(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "198.51.100.2" })),
  ).toBe("198.51.100.2");
});

test("falls back to x-forwarded-for when trusted and x-real-ip is absent", () => {
  process.env.TRUST_PROXY = "1";
  expect(requestAddress(req({ "x-forwarded-for": "198.51.100.2" }))).toBe("198.51.100.2");
});

test("skips an empty forwarded chain and falls back further", () => {
  process.env.TRUST_PROXY = "true";
  expect(requestAddress(req({ "x-forwarded-for": " , " }))).toBe("unknown");
});

test("caps the resolved address at 128 characters", () => {
  process.env.TRUST_PROXY = "true";
  const long = `${"a".repeat(200)}.example`;
  expect(requestAddress(req({ "x-forwarded-for": long }))).toHaveLength(128);
});

test("uses the socket address over a live connection", async () => {
  let captured = "";
  let socket = "";
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      captured = requestAddress(request);
      socket = server.requestIP(request)!.address;
      return new Response("ok");
    },
  });
  bindServer(server);

  try {
    await fetch(new URL("/", server.url), {
      headers: { "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.2" },
    });
    expect(captured).toBe(socket);
    expect(captured).not.toBe("203.0.113.7");
  } finally {
    server.stop(true);
  }
});

test("re-reads TRUST_PROXY per request over a live connection", async () => {
  const seen: string[] = [];
  let socket = "";
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      socket = server.requestIP(request)!.address;
      seen.push(requestAddress(request));
      return new Response("ok");
    },
  });
  bindServer(server);

  try {
    process.env.TRUST_PROXY = "true";
    await fetch(new URL("/", server.url), { headers: { "x-forwarded-for": "203.0.113.7" } });
    delete process.env.TRUST_PROXY;
    await fetch(new URL("/", server.url), { headers: { "x-forwarded-for": "203.0.113.7" } });
    expect(seen).toEqual(["203.0.113.7", socket]);
  } finally {
    server.stop(true);
  }
});

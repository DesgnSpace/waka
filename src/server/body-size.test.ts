import { afterAll, expect, test } from "bun:test";
import { MAX_REQUEST_BODY_BYTES, serveOptions } from "./app";
import { HttpError, MAX_JSON_BODY_BYTES, jsonBody } from "./http";

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", ...serveOptions() });
const url = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

test("request bodies above the ceiling are cut off with 413", async () => {
  const res = await fetch(`${url}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
  });
  expect(res.status).toBe(413);
});

test("a request body exactly at the ceiling still reaches the route", async () => {
  const res = await fetch(`${url}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "x".repeat(MAX_REQUEST_BODY_BYTES),
  });
  // The route rejects the missing CSRF token; the transport did not intervene.
  expect(res.status).toBe(403);
});

test("normal form posts are unaffected by the ceiling", async () => {
  const res = await fetch(`${url}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=test@example.com&password=secret",
  });
  expect(res.status).toBe(403);
});

test("oversized JSON bodies keep the API's JSON 413 error body", async () => {
  const req = new Request("https://waka.test/api/emails", {
    method: "POST",
    headers: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
    body: "{}",
  });

  let caught: unknown;
  try {
    await jsonBody(req);
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(413);
  expect((caught as HttpError).body).toEqual({ error: "Request body is too large." });
});

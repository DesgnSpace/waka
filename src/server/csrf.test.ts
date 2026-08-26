import { expect, test } from "bun:test";
import { createCsrfToken, csrfCookie, isValidCsrfToken } from "./http";

function requestWithToken(token: string): Request {
  return new Request("https://example.test/dashboard", {
    headers: { cookie: csrfCookie(token).split(";")[0] },
  });
}

test("accepts a matching CSRF cookie and form token", () => {
  const token = createCsrfToken();
  const form = new FormData();
  form.set("csrf", token);

  expect(isValidCsrfToken(requestWithToken(token), form.get("csrf"))).toBe(true);
});

test("rejects missing or mismatched CSRF tokens", () => {
  const token = createCsrfToken();
  const request = requestWithToken(token);
  const form = new FormData();

  expect(isValidCsrfToken(request, null)).toBe(false);
  form.set("csrf", createCsrfToken());
  expect(isValidCsrfToken(request, form.get("csrf"))).toBe(false);
});

test("sets the CSRF cookie as HttpOnly so scripts cannot read it", () => {
  const attributes = csrfCookie(createCsrfToken()).split(";").map((a) => a.trim());
  expect(attributes).toContain("HttpOnly");
});

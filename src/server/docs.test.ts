import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import jwt from "jsonwebtoken";
import { serveOptions } from "./app";
import { sessionCookie } from "./http";
import { DOC_TOPICS } from "./docs";

process.env.NEXTAUTH_SECRET ??= "test-secret-test-secret-test-secret-32";

const operator = { id: "11111111-1111-4111-8111-111111111111", email: "operator@example.com" };

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", ...serveOptions() });
const url = `http://127.0.0.1:${server.port}`;

const session = sessionCookie(
  jwt.sign(operator, process.env.NEXTAUTH_SECRET!, { algorithm: "HS256", expiresIn: "1h" }),
).split(";")[0];

// Other test files replace @/lib/auth process-wide, one of them with a stub that
// rejects every token. Claiming it back here — after every module has loaded —
// keeps the session cookie verifiable whatever order the files run in.
beforeAll(() => {
  mock.module("@/lib/auth", () => ({
    authenticateUser: async () => null,
    createUser: async () => {},
    generateJWT: (user: typeof operator) =>
      jwt.sign(user, process.env.NEXTAUTH_SECRET!, { algorithm: "HS256", expiresIn: "1h" }),
    verifyJWT: (token: string) => {
      try {
        const claims = jwt.verify(token, process.env.NEXTAUTH_SECRET!, { algorithms: ["HS256"] });
        return typeof claims === "object" && claims ? { id: claims.id, email: claims.email } : null;
      } catch {
        return null;
      }
    },
  }));
});

afterAll(() => {
  server.stop(true);
});

function open(path: string, signedIn: boolean): Promise<Response> {
  return fetch(`${url}${path}`, {
    redirect: "manual",
    headers: signedIn ? { cookie: session } : {},
  });
}

test("docs send a signed-out visitor to the sign-in page", async () => {
  const index = await open("/ui/docs", false);
  expect(index.status).toBe(303);
  expect(index.headers.get("location")).toBe("/login");

  const topic = await open("/ui/docs/quickstart", false);
  expect(topic.status).toBe(303);
  expect(topic.headers.get("location")).toBe("/login");
});

test("docs render for a signed-in operator", async () => {
  const index = await open("/ui/docs", true);
  expect(index.status).toBe(200);
  const listing = await index.text();
  for (const topic of DOC_TOPICS) {
    expect(listing).toContain(`/ui/docs/${topic.slug}`);
  }

  const quickstart = await open("/ui/docs/quickstart", true);
  expect(quickstart.status).toBe(200);
  expect(await quickstart.text()).toContain("Quickstart");
});

test("an unknown docs topic is not found", async () => {
  const missing = await open("/ui/docs/nope", true);
  expect(missing.status).toBe(404);
});

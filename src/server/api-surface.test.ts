import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("no setup route is registered or stubbed", () => {
  expect(source("server.ts")).not.toContain("/api/setup");
  expect(source("src/server/handlers.ts")).not.toMatch(/export (async )?function setup\b/);
});

test("docs are dashboard-only and add nothing to the JSON API", () => {
  const app = source("src/server/app.ts");
  const registered = [...app.matchAll(/"(\/[^"]*docs[^"]*)"/g)].map((match) => match[1]);
  expect(registered).toEqual(["/ui/docs", "/ui/docs/:topic"]);
});

test("no documented environment variable goes unread", () => {
  const files = [
    ".env.example",
    "docker-compose.yml",
    "README.md",
    "SETUP.md",
    "DEPLOYMENT.md",
  ];
  const offenders = files.filter((file) =>
    /ADMIN_EMAIL|ADMIN_PASSWORD/.test(source(file)),
  );
  expect(offenders).toEqual([]);
});

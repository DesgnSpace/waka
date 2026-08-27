import { afterAll, beforeEach, expect, test } from "bun:test";
import { installFakeDatabase, onFakeQuery } from "@/lib/fake-database";
import { CACHE_TTL_MS } from "@/lib/health-check";

installFakeDatabase("@/lib/database");

const { health } = await import("./handlers");

let fakeNow = Date.now();
const realNow = Date.now;
beforeEach(() => {
  fakeNow += CACHE_TTL_MS + 1000;
  Date.now = () => fakeNow;
});
afterAll(() => {
  Date.now = realNow;
});

test("health returns 200 with database up and keeps expected fields", async () => {
  const nowAtCall = fakeNow;
  onFakeQuery(async (sql) => {
    if (sql.includes("set_config")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT 1")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const res = await health();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("healthy");
  expect(body.database).toBe("up");
  expect(body.service).toBe("Waka");
  expect(body.version).toBe("1.0.0");
  expect(body.timestamp).toBe(new Date(nowAtCall).toISOString());
});

test("health returns 503 with database down and does not leak error details", async () => {
  onFakeQuery(async (sql) => {
    if (sql.includes("SELECT 1")) throw new Error("ECONNREFUSED 10.0.0.1:5432");
    return { rows: [], rowCount: 0 };
  });
  const res = await health();
  expect(res.status).toBe(503);
  const body = await res.json();
  expect(body.status).toBe("unhealthy");
  expect(body.database).toBe("down");
  expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  expect(typeof body.timestamp).toBe("string");
  expect(body.service).toBe("Waka");
});

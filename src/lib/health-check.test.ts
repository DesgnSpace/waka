import { expect, test } from "bun:test";
import {
  CACHE_TTL_MS,
  CHECK_DEADLINE_MS,
  STATEMENT_TIMEOUT_MS,
  createHealthChecker,
  type DbRunner,
  type HealthReport,
} from "./health-check";

type QueryCall = { sql: string; params?: unknown[] };

function fakeRunner(behavior: {
  onQuery?: (call: QueryCall) => unknown;
  hang?: boolean;
}) {
  const calls: QueryCall[] = [];
  let runs = 0;
  const client = {
    query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (behavior.hang) return new Promise<never>(() => {});
      return Promise.resolve(behavior.onQuery?.({ sql, params }));
    },
  };
  const runner: DbRunner = async (callback) => {
    runs += 1;
    return callback(client);
  };
  return { runner, calls, runCount: () => runs };
}

test("a reachable database reports healthy and keeps the existing response fields", async () => {
  const { runner, calls } = fakeRunner({
    onQuery: ({ sql }) => (sql.includes("set_config") ? undefined : { rowCount: 1 }),
  });
  const checker = createHealthChecker(runner);

  const report = await checker.report();

  expect(report).toEqual({
    status: "healthy",
    timestamp: report.timestamp,
    service: "Waka",
    version: "1.0.0",
    database: "up",
  } satisfies HealthReport);
  expect(calls.map((c) => c.sql)).toEqual([
    "SELECT set_config('statement_timeout', $1, true)",
    "SELECT 1",
  ]);
  expect(calls[0].params).toEqual([String(STATEMENT_TIMEOUT_MS)]);
});

test("an unreachable database reports unhealthy without leaking error details", async () => {
  const { runner } = fakeRunner({
    onQuery: ({ sql }) => {
      if (sql.includes("SELECT 1")) throw new Error("ECONNREFUSED 10.0.0.1:5432");
      return undefined;
    },
  });
  const checker = createHealthChecker(runner);

  const report = await checker.report();

  expect(report.status).toBe("unhealthy");
  expect(report.database).toBe("down");
  expect(JSON.stringify(report)).not.toContain("ECONNREFUSED");
});

test("a hung database hits the deadline and still answers fast", async () => {
  const { runner } = fakeRunner({ hang: true });
  const checker = createHealthChecker(runner, { deadlineMs: 50 });

  const started = Date.now();
  const report = await checker.report();

  expect(report.database).toBe("down");
  expect(Date.now() - started).toBeLessThan(CHECK_DEADLINE_MS);
});

test("probes inside the cache window reuse one database check", async () => {
  const { runner, calls, runCount } = fakeRunner({ onQuery: () => ({ rowCount: 1 }) });
  const checker = createHealthChecker(runner);
  const first = await checker.report(1000);
  const second = await checker.report(1000 + CACHE_TTL_MS - 1);

  expect(runCount()).toBe(1);
  expect(second.timestamp).toBe(first.timestamp);
  expect(calls).toHaveLength(2);
});

test("an expired cache window triggers a fresh check", async () => {
  const { runner, runCount } = fakeRunner({ onQuery: () => ({ rowCount: 1 }) });
  const checker = createHealthChecker(runner);
  await checker.report(1000);

  const refreshed = await checker.report(1000 + CACHE_TTL_MS);

  expect(runCount()).toBe(2);
  expect(refreshed.timestamp).toBe(new Date(1000 + CACHE_TTL_MS).toISOString());
});

test("overlapping probes share a single in-flight check", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { runner, runCount } = fakeRunner({ onQuery: () => gate.then(() => ({ rowCount: 1 })) });
  const checker = createHealthChecker(runner);

  const pending = [checker.report(), checker.report()];
  release();
  const [first, second] = await Promise.all(pending);

  expect(first.status).toBe("healthy");
  expect(second.status).toBe("healthy");
  expect(runCount()).toBe(1);
});

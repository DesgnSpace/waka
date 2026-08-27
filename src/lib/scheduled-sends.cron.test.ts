import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test";
import { executedQueries, installFakeDatabase, onFakeQuery } from "./fake-database";

const messageId = "01000192a1b2c3d4-e1f2a3b4-0000-0000-0000-1234567890ab-000000";

const sendEmail = mock(async (options: { from?: string }) => {
  if (options?.from === "doomed@example.com") {
    throw Object.assign(new Error("Address blacklisted"), { name: "MessageRejected" });
  }
  return messageId;
});

installFakeDatabase("@/lib/database");
mock.module("@/lib/ses", () => ({ sendEmail }));

const { MAX_SEND_ATTEMPTS, startScheduledSendJob } = await import("./scheduled-sends");

const NOW = new Date("2026-08-26T12:00:30.500Z");
type ClaimRow = { id: string; send_attempts: number; payload: unknown };

const okRow: ClaimRow = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  send_attempts: 1,
  payload: { from: "sender@example.com", to: ["dest@example.com"], subject: "Hi", text: "body" },
};
const doomedRow: ClaimRow = {
  id: "bbbbbbbb-2222-4222-8222-222222222222",
  send_attempts: MAX_SEND_ATTEMPTS,
  payload: { from: "doomed@example.com", to: ["gone@example.com"], subject: "Hi", text: "body" },
};
const retryRow: ClaimRow = {
  id: "cccccccc-3333-4333-8333-333333333333",
  send_attempts: MAX_SEND_ATTEMPTS - 1,
  payload: { from: "doomed@example.com", to: ["gone@example.com"], subject: "Hi", text: "body" },
};

function claim(claimed: ClaimRow[]): void {
  onFakeQuery((sql) =>
    sql.includes("WITH due AS")
      ? { rows: claimed, rowCount: claimed.length }
      : { rows: [], rowCount: 1 },
  );
}

const claims = () => executedQueries.filter((q) => q.sql.includes("WITH due AS"));
const statusUpdates = (status: string) =>
  executedQueries.filter((q) => q.sql.includes(`SET status = '${status}'`));

async function drainMicrotasks(steps = 200): Promise<void> {
  for (let i = 0; i < steps; i++) await Promise.resolve();
}

beforeEach(() => {
  executedQueries.length = 0;
  sendEmail.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

test("the cron handle stops the worker from claiming further rows", () => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  const job = startScheduledSendJob();
  expect(job.cron).toBe("* * * * *");
  job.stop();

  jest.advanceTimersByTime(3 * 60_000);
  expect(claims().length).toBe(0);
});

test("a tick at the next minute boundary delivers due sends", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  const job = startScheduledSendJob();

  claim([okRow, doomedRow]);
  jest.advanceTimersByTime(15_000);
  await drainMicrotasks();
  expect(claims().length).toBe(0);

  jest.advanceTimersByTime(20_000);
  await drainMicrotasks();

  expect(claims().length).toBe(1);
  const sentUpdate = statusUpdates("sent")[0];
  expect(sentUpdate.params[0]).toBe(okRow.id);
  expect(sentUpdate.params[1]).toBe(messageId);
  const failedUpdate = statusUpdates("failed")[0];
  expect(failedUpdate.params[0]).toBe(doomedRow.id);
  expect(String(failedUpdate.params[1])).toContain("Address blacklisted");
  // A delivered row sheds its stored request body.
  expect(sentUpdate.sql).toContain("payload = NULL");

  job.stop();
});

test("a failed attempt below the cap reschedules instead of abandoning", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  const job = startScheduledSendJob();

  claim([retryRow]);
  jest.advanceTimersByTime(60_000);
  await drainMicrotasks();

  const retryUpdate = statusUpdates("scheduled")[0];
  expect(retryUpdate.params[0]).toBe(retryRow.id);
  // The tick fires on the first minute boundary after registration.
  const firedAt = NOW.getTime() - (NOW.getTime() % 60_000) + 60_000;
  expect((retryUpdate.params[1] as Date).getTime()).toBe(firedAt + 300_000);
  expect(statusUpdates("failed").length).toBe(0);

  job.stop();
});

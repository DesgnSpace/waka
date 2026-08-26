import { expect, test } from "bun:test";
import {
  MAX_SEND_ATTEMPTS,
  RETRY_DELAY_SECONDS,
  STALE_CLAIM_SECONDS,
  isDue,
  parseScheduledAt,
  planAfterFailure,
} from "./scheduled-sends";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const ms = (n: number) => NOW.getTime() + n;

test("absent scheduled_at means send immediately", () => {
  for (const raw of [undefined, null, "", "   "]) {
    expect(parseScheduledAt(raw, NOW)).toEqual({ ok: true, at: null });
  }
});

test("accepts an ISO-8601 timestamp with a zone", () => {
  const parsed = parseScheduledAt("2026-08-27T15:30:00Z", NOW);
  expect(parsed).toEqual({ ok: true, at: new Date("2026-08-27T15:30:00.000Z") });
  const offset = parseScheduledAt("2026-08-27T17:30:00+02:00", NOW);
  expect(offset).toEqual({ ok: true, at: new Date("2026-08-27T15:30:00.000Z") });
});

test("accepts a relative offset", () => {
  expect(parseScheduledAt("in 10 minutes", NOW)).toEqual({ ok: true, at: new Date(ms(10 * 60_000)) });
  expect(parseScheduledAt("in 1 hour", NOW)).toEqual({ ok: true, at: new Date(ms(3_600_000)) });
  expect(parseScheduledAt("in 2 days", NOW)).toEqual({ ok: true, at: new Date(ms(2 * 86_400_000)) });
  expect(parseScheduledAt("IN 5 SECONDS", NOW)).toEqual({ ok: true, at: new Date(ms(5_000)) });
});

test("a zero or past offset becomes due immediately", () => {
  expect(parseScheduledAt("in 0 minutes", NOW)).toEqual({ ok: true, at: NOW });
  const parsed = parseScheduledAt("2026-08-20T00:00:00Z", NOW);
  expect(parsed).toEqual({ ok: true, at: new Date("2026-08-20T00:00:00.000Z") });
});

test("rejects anything that is neither ISO-8601 nor a known offset", () => {
  for (const raw of ["tomorrow", "26/08/2026", "in ten minutes", "10 minutes", "in 5 fortnights", "next friday"]) {
    expect(parseScheduledAt(raw, NOW).ok).toBe(false);
  }
});

test("rejects timestamps that are not real calendar dates", () => {
  expect(parseScheduledAt("2026-02-30T00:00:00Z", NOW).ok).toBe(false);
  expect(parseScheduledAt("2026-13-01T00:00:00Z", NOW).ok).toBe(false);
});

test("rejects times beyond the 72 hour horizon, accepting the boundary", () => {
  expect(parseScheduledAt("2026-08-29T12:00:00Z", NOW).ok).toBe(true);
  expect(parseScheduledAt("2026-08-29T12:00:01Z", NOW).ok).toBe(false);
  expect(parseScheduledAt("in 3 days", NOW).ok).toBe(true);
  expect(parseScheduledAt("in 432001 seconds", NOW).ok).toBe(false);
  expect(parseScheduledAt(`in ${72 * 60 + 1} minutes`, NOW).ok).toBe(false);
});

function candidate(status: string, fields: { scheduledAt?: Date | string | null; updatedAt?: Date | string }) {
  return {
    status,
    scheduled_at: fields.scheduledAt === undefined ? NOW : fields.scheduledAt,
    updated_at: fields.updatedAt === undefined ? NOW : fields.updatedAt,
  };
}

test("a scheduled row is due once its time arrives", () => {
  expect(isDue(candidate("scheduled", { scheduledAt: new Date(ms(-1)) }), NOW)).toBe(true);
  expect(isDue(candidate("scheduled", { scheduledAt: NOW }), NOW)).toBe(true);
  expect(isDue(candidate("scheduled", { scheduledAt: new Date(ms(1)) }), NOW)).toBe(false);
  expect(isDue(candidate("scheduled", { scheduledAt: "2026-08-26T11:00:00Z" }), NOW)).toBe(true);
  expect(isDue(candidate("scheduled", { scheduledAt: null }), NOW)).toBe(false);
});

test("a claimed row stuck in sending is due again only after the stale timeout", () => {
  const fresh = new Date(ms(-STALE_CLAIM_SECONDS * 1000));
  expect(isDue(candidate("sending", { updatedAt: NOW }), NOW)).toBe(false);
  expect(isDue(candidate("sending", { updatedAt: fresh }), NOW)).toBe(false);
  const stale = new Date(ms(-STALE_CLAIM_SECONDS * 1000 - 1));
  expect(isDue(candidate("sending", { updatedAt: stale }), NOW)).toBe(true);
});

test("rows in other states are never due", () => {
  for (const status of ["pending", "sent", "failed", "delivered", "bounced", "complained"]) {
    expect(isDue(candidate(status, { scheduledAt: new Date(ms(-86_400_000)) }), NOW)).toBe(false);
  }
});

test("a failure below the attempt cap schedules one retry after the delay", () => {
  const plan = planAfterFailure(MAX_SEND_ATTEMPTS - 1, NOW);
  expect(plan).toEqual({ action: "retry", retryAt: new Date(ms(RETRY_DELAY_SECONDS * 1000)) });
});

test("reaching the attempt cap abandons the message permanently", () => {
  expect(planAfterFailure(MAX_SEND_ATTEMPTS, NOW)).toEqual({ action: "abandon" });
  expect(planAfterFailure(MAX_SEND_ATTEMPTS + 3, NOW)).toEqual({ action: "abandon" });
});

import { expect, test } from "bun:test";
import {
  DEFAULT_RETENTION_DAYS,
  isLastBatch,
  parseRetentionDays,
  retentionCutoff,
} from "./prune";

test("unset or blank retention falls back to the default", () => {
  expect(parseRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
  expect(parseRetentionDays("")).toBe(DEFAULT_RETENTION_DAYS);
  expect(parseRetentionDays("   ")).toBe(DEFAULT_RETENTION_DAYS);
});

test("parses a positive day count", () => {
  expect(parseRetentionDays("30")).toBe(30);
  expect(parseRetentionDays(" 7 ")).toBe(7);
});

test("zero and negative values keep everything", () => {
  expect(parseRetentionDays("0")).toBeNull();
  expect(parseRetentionDays("-4")).toBeNull();
});

test("non-integer values keep everything rather than prune on a misparse", () => {
  expect(parseRetentionDays("abc")).toBeNull();
  expect(parseRetentionDays("2.5")).toBeNull();
});

test("cutoff subtracts whole days from now", () => {
  const now = new Date("2026-08-26T12:00:00.000Z");
  expect(retentionCutoff(now, 90)).toEqual(
    new Date("2026-05-28T12:00:00.000Z"),
  );
  expect(retentionCutoff(now, 1)).toEqual(new Date("2026-08-25T12:00:00.000Z"));
});

test("a full batch continues pruning; a partial batch is the last one", () => {
  expect(isLastBatch(500)).toBe(false);
  expect(isLastBatch(499)).toBe(true);
  expect(isLastBatch(0)).toBe(true);
});

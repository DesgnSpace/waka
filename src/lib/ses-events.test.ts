import { expect, test } from "bun:test";
import {
  EMAIL_STATUS_RANK,
  ENGAGEMENT_EVENT_TYPES,
  eventStatus,
  resolveStatus,
  type EmailStatus,
} from "./ses-events";

const PRIOR_STATUSES: (string | null)[] = [
  "pending",
  "sent",
  "failed",
  "delivered",
  "bounced",
  "complained",
  "mystery-status",
];

const EVENT_TYPES = ["send", "reject", "delivery", "bounce", "complaint"];

// Expected status per (prior status, incoming lifecycle event); null means the
// current status must be kept.
const EXPECTED: Record<string, Record<string, EmailStatus | null>> = {
  "pending": { send: "sent", reject: "failed", delivery: "delivered", bounce: "bounced", complaint: "complained" },
  "sent": { send: null, reject: null, delivery: "delivered", bounce: "bounced", complaint: "complained" },
  "failed": { send: null, reject: null, delivery: "delivered", bounce: "bounced", complaint: "complained" },
  "delivered": { send: null, reject: null, delivery: null, bounce: "bounced", complaint: "complained" },
  "bounced": { send: null, reject: null, delivery: null, bounce: null, complaint: "complained" },
  "complained": { send: null, reject: null, delivery: null, bounce: null, complaint: null },
  "mystery-status": { send: "sent", reject: "failed", delivery: "delivered", bounce: "bounced", complaint: "complained" },
};

test("every lifecycle event against every prior status follows the rank order", () => {
  for (const prior of PRIOR_STATUSES) {
    for (const eventType of EVENT_TYPES) {
      const next = eventStatus(eventType)!;
      expect(resolveStatus(prior!, next)).toBe(EXPECTED[prior!][eventType]);
    }
  }
});

test("a repeated event never changes an already-applied status", () => {
  for (const eventType of EVENT_TYPES) {
    const applied = resolveStatus("pending", eventStatus(eventType)!);
    expect(applied).not.toBeNull();
    expect(resolveStatus(applied!, eventStatus(eventType)!)).toBeNull();
  }
});

test("a late delivery cannot regress a bounced or complained message", () => {
  expect(resolveStatus("bounced", "delivered")).toBeNull();
  expect(resolveStatus("complained", "delivered")).toBeNull();
  expect(resolveStatus("complained", "bounced")).toBeNull();
});

test("a complaint sticks over every other outcome once recorded", () => {
  for (const eventType of EVENT_TYPES) {
    if (eventType === "complaint") continue;
    expect(resolveStatus("complained", eventStatus(eventType)!)).toBeNull();
  }
});

test("engagement events map to no status", () => {
  expect(eventStatus("open")).toBeNull();
  expect(eventStatus("click")).toBeNull();
  expect(ENGAGEMENT_EVENT_TYPES.has("open")).toBe(true);
  expect(ENGAGEMENT_EVENT_TYPES.has("click")).toBe(true);
  for (const eventType of ["open", "click", "unknown-future-event"]) {
    expect(ENGAGEMENT_EVENT_TYPES.has(eventType) || eventStatus(eventType) !== null).toBe(
      eventType === "open" || eventType === "click"
    );
  }
});

test("unknown statuses rank below every known outcome", () => {
  for (const status of Object.keys(EMAIL_STATUS_RANK)) {
    const rank = EMAIL_STATUS_RANK[status as EmailStatus];
    expect(rank).toBeGreaterThan(-1);
  }
});

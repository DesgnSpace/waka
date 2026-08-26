export type EmailStatus =
  | "pending"
  | "sent"
  | "failed"
  | "delivered"
  | "bounced"
  | "complained";

// Outcome ranks order the lifecycle from submission to worst known result.
// A status is only ever replaced by one that ranks strictly higher: submission
// results (sent, failed) yield to downstream evidence, a bounce outranks a
// delivery because the mail came back, and a spam complaint outranks
// everything — no later notification may regress a complaint.
export const EMAIL_STATUS_RANK: Record<EmailStatus, number> = {
  pending: 0,
  sent: 1,
  failed: 1,
  delivered: 2,
  bounced: 3,
  complained: 4,
};

export const ENGAGEMENT_EVENT_TYPES = new Set(["open", "click"]);

// Delivery-lifecycle notifications map onto the email_logs status column;
// engagement events (open, click) are recorded per occurrence and leave
// status alone. Unknown event types map to null.
const EVENT_STATUS: Record<string, EmailStatus> = {
  send: "sent",
  reject: "failed",
  delivery: "delivered",
  bounce: "bounced",
  complaint: "complained",
};

export function eventStatus(eventType: string): EmailStatus | null {
  return EVENT_STATUS[eventType] ?? null;
}

// Returns the status to persist, or null when the current status already
// reflects an outcome the incoming event cannot supersede. An unknown current
// status ranks below everything so a known outcome can always be applied.
export function resolveStatus(current: string, next: EmailStatus): EmailStatus | null {
  const currentRank = EMAIL_STATUS_RANK[current as EmailStatus] ?? -1;
  return currentRank < EMAIL_STATUS_RANK[next] ? next : null;
}

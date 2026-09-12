import { query, type DbRow } from "./database";
import { parseJsonArray, parseJsonObject } from "./serialization";

export type EmailLogRow = DbRow<{
  id: string;
  api_key_id: string | null;
  domain_id: string;
  message_id: string | null;
  from_email: string;
  to_emails: unknown;
  cc_emails: unknown;
  bcc_emails: unknown;
  subject: string | null;
  html_content: string | null;
  text_content: string | null;
  attachments: unknown;
  reply_to?: unknown;
  status: string;
  ses_message_id: string | null;
  error_message: string | null;
  webhook_data: unknown;
  created_at: string;
  updated_at: string;
  payload: unknown;
  domain_name: string | null;
  api_key_name: string | null;
}>;

export type EmailLogsFilters = {
  domainId?: string | null;
  status?: string | null;
  recipient?: string | null;
  subject?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  messageId?: string | null;
};

export type EmailLog = Omit<EmailLogRow, "payload" | "to_emails" | "cc_emails" | "bcc_emails" | "attachments"> & {
  to_emails: unknown[];
  cc_emails: unknown[];
  bcc_emails: unknown[];
  attachments: unknown[];
  domains: { domain: string } | null;
  api_keys: { key_name: string } | null;
};

export type EmailDetailRow = EmailLogRow & { domain_user_id: string };

type EmailWebhookEventRow = DbRow<{
  id: string;
  event_type: string;
  event_data: unknown;
  created_at: string;
}>;

export type EmailWebhookEvent = {
  id: string;
  event_type: string;
  event_data: Record<string, unknown>;
  created_at: string;
};

type EmailEngagementEventRow = DbRow<{
  id: string;
  type: string;
  link: string | null;
  user_agent: string | null;
  created_at: string;
}>;

export type EmailEngagementEvent = {
  id: string;
  type: string;
  link: string | null;
  user_agent: string | null;
  created_at: string;
};

export type EmailLogsResult = {
  logs: EmailLog[];
  total: number;
};

export async function getEmailLogDetail(
  emailId: string,
  scopedUserId: string,
  scopedDomainId: string | null = null,
): Promise<EmailDetailRow | null> {
  const result = await query<EmailDetailRow>(
    `SELECT el.*, d.domain as domain_name, d.user_id as domain_user_id, ak.key_name as api_key_name
     FROM email_logs el
     JOIN domains d ON el.domain_id = d.id AND d.user_id = $2
     LEFT JOIN api_keys ak ON el.api_key_id = ak.id
       AND ak.user_id = d.user_id AND ak.domain_id = el.domain_id
     WHERE el.id = $1
        AND ($3::uuid IS NULL OR el.domain_id = $3)`,
    [emailId, scopedUserId, scopedDomainId],
  );
  return result.rows[0] ?? null;
}

export async function getEmailLogWebhookEvents(
  emailId: string,
  scopedUserId: string,
  scopedDomainId: string | null = null,
): Promise<EmailWebhookEvent[]> {
  const result = await query<EmailWebhookEventRow>(
    `SELECT id, event_type, event_data, created_at
      FROM webhook_events we
      JOIN email_logs el ON el.id = we.email_log_id
      JOIN domains d ON d.id = el.domain_id AND d.user_id = $2
      WHERE we.email_log_id = $1
        AND ($3::uuid IS NULL OR el.domain_id = $3)
      ORDER BY we.created_at DESC`,
    [emailId, scopedUserId, scopedDomainId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    event_type: row.event_type,
    event_data: parseJsonObject(row.event_data, "event_data"),
    created_at: row.created_at,
  }));
}

export async function getEmailLogEngagementEvents(
  emailId: string,
  scopedUserId: string,
  scopedDomainId: string | null = null,
): Promise<EmailEngagementEvent[]> {
  const result = await query<EmailEngagementEventRow>(
    `SELECT ee.id, ee.type, ee.link, ee.user_agent, ee.created_at
      FROM email_events ee
      JOIN email_logs el ON el.id = ee.email_log_id
      JOIN domains d ON d.id = el.domain_id AND d.user_id = $2
      WHERE ee.email_log_id = $1
        AND ($3::uuid IS NULL OR el.domain_id = $3)
      ORDER BY ee.created_at DESC`,
    [emailId, scopedUserId, scopedDomainId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    link: row.link,
    user_agent: row.user_agent,
    created_at: row.created_at,
  }));
}

// Kept byte-identical to the expression indexed by idx_email_logs_recipient_trgm
// so the planner can use that index.
const RECIPIENT_EXPRESSION =
  "lower(coalesce(el.to_emails::text, '') || ' ' || coalesce(el.cc_emails::text, '') || ' ' || coalesce(el.bcc_emails::text, ''))";

export function buildEmailLogsWhere(
  filters: EmailLogsFilters,
  startIndex: number,
): { clauses: string[]; params: unknown[]; nextIndex: number } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;

  if (filters.domainId) {
    clauses.push(`el.domain_id = $${idx}::uuid`);
    params.push(filters.domainId);
    idx++;
  }

  if (filters.status) {
    clauses.push(`el.status = $${idx}::text`);
    params.push(filters.status);
    idx++;
  }

  if (filters.recipient) {
    clauses.push(`${RECIPIENT_EXPRESSION} LIKE '%' || lower($${idx}::text) || '%'`);
    params.push(filters.recipient);
    idx++;
  }

  if (filters.subject) {
    clauses.push(`lower(el.subject) LIKE '%' || lower($${idx}::text) || '%'`);
    params.push(filters.subject);
    idx++;
  }

  if (filters.fromDate) {
    clauses.push(`el.created_at >= $${idx}::timestamptz`);
    params.push(filters.fromDate);
    idx++;
  }

  if (filters.toDate) {
    clauses.push(`el.created_at <= $${idx}::timestamptz`);
    params.push(filters.toDate);
    idx++;
  }

  if (filters.messageId) {
    clauses.push(`(el.id::text = $${idx}::text OR el.ses_message_id = $${idx}::text OR el.message_id = $${idx}::text)`);
    params.push(filters.messageId);
    idx++;
  }

  return { clauses, params, nextIndex: idx };
}

export async function searchEmailLogs(args: {
  domainIds: string[];
  scopedUserId: string;
  filters: EmailLogsFilters;
  limit: number;
  offset: number;
}): Promise<EmailLogsResult> {
  const { domainIds, scopedUserId, filters, limit, offset } = args;

  if (domainIds.length === 0) {
    return { logs: [], total: 0 };
  }

  // $1 = domainIds, $2 = scopedUserId, rest dynamic
  const where = buildEmailLogsWhere(filters, 3);
  const whereSql = where.clauses.length ? `AND ${where.clauses.join(" AND ")}` : "";

  const countParams: unknown[] = [domainIds, scopedUserId, ...where.params];
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM email_logs el
     WHERE el.domain_id = ANY($1)
       AND EXISTS (SELECT 1 FROM domains d WHERE d.id = el.domain_id AND d.user_id = $2)
       ${whereSql}`,
    countParams,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const dataParams: unknown[] = [...countParams, limit, offset];
  const limitIdx = dataParams.length - 1;
  const offsetIdx = dataParams.length;

  const rowsResult = await query<EmailLogRow>(
    `SELECT el.*, d.domain as domain_name, ak.key_name as api_key_name
     FROM email_logs el
     JOIN domains d ON el.domain_id = d.id AND d.user_id = $2
     LEFT JOIN api_keys ak ON el.api_key_id = ak.id
       AND ak.user_id = d.user_id AND ak.domain_id = el.domain_id
     WHERE el.domain_id = ANY($1)
       ${whereSql}
     ORDER BY el.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    dataParams,
  );

  // payload carries the raw scheduled request body (attachment bytes included)
  // and is for the sender, never for API readers.
  const logs = rowsResult.rows.map(({ payload: _payload, ...row }) => ({
    ...row,
    to_emails: parseJsonArray(row.to_emails, "to_emails"),
    cc_emails: parseJsonArray(row.cc_emails, "cc_emails"),
    bcc_emails: parseJsonArray(row.bcc_emails, "bcc_emails"),
    attachments: parseJsonArray(row.attachments, "attachments"),
    domains: row.domain_name ? { domain: row.domain_name } : null,
    api_keys: row.api_key_name ? { key_name: row.api_key_name } : null,
  }));

  return { logs, total };
}

// Query-string aliases accepted by both the API and the dashboard filter form.
export function normalizeLogsFilters(raw: Record<string, string | undefined>): EmailLogsFilters {
  const trim = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };
  return {
    domainId: trim(raw.domain_id ?? raw.domainId),
    status: trim(raw.status),
    recipient: trim(raw.recipient),
    subject: trim(raw.subject),
    fromDate: trim(raw.from ?? raw.from_date ?? raw.start_date ?? raw.startDate),
    toDate: trim(raw.to ?? raw.to_date ?? raw.end_date ?? raw.endDate),
    messageId: trim(raw.message_id ?? raw.messageId),
  };
}

// A date-only bound covers the whole day; a full timestamp is used as given.
export function toRangeStart(value: string): string {
  return new Date(value).toISOString();
}

export function toRangeEnd(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59.999Z`).toISOString() : new Date(value).toISOString();
}

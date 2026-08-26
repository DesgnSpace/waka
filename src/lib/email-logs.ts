import { query, type DbRow } from "./database";
import { parseJsonArray } from "./serialization";

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
  status: string;
  ses_message_id: string | null;
  error_message: string | null;
  webhook_data: unknown;
  created_at: string;
  updated_at: string;
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

export type EmailLogsResult = {
  logs: Array<EmailLogRow & { to_emails: string[]; cc_emails: string[]; bcc_emails: string[]; attachments: unknown[] }>;
  total: number;
};

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
  } else {
    clauses.push(`($${idx}::uuid IS NULL OR el.domain_id = $${idx}::uuid)`);
    params.push(null);
    idx++;
  }

  if (filters.status) {
    clauses.push(`el.status = $${idx}::text`);
    params.push(filters.status);
    idx++;
  } else {
    clauses.push(`($${idx}::text IS NULL OR el.status = $${idx}::text)`);
    params.push(null);
    idx++;
  }

  if (filters.recipient) {
    clauses.push(`el.recipient_search LIKE '%' || lower($${idx}::text) || '%'`);
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
       AND EXISTS (SELECT 1 FROM domains d2 WHERE d2.id = el.domain_id AND d2.user_id = $2)
       ${whereSql}
     ORDER BY el.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    dataParams,
  );

  const logs = rowsResult.rows.map((row) => ({
    ...row,
    to_emails: parseJsonArray(row.to_emails, "to_emails"),
    cc_emails: parseJsonArray(row.cc_emails, "cc_emails"),
    bcc_emails: parseJsonArray(row.bcc_emails, "bcc_emails"),
    attachments: parseJsonArray(row.attachments, "attachments"),
  }));

  // Attach joined display fields
  const enriched = logs.map((r) => ({
    ...r,
    domains: (r as unknown as { domain_name: string | null }).domain_name
      ? { domain: (r as unknown as { domain_name: string }).domain_name }
      : null,
    api_keys: (r as unknown as { api_key_name: string | null }).api_key_name
      ? { key_name: (r as unknown as { api_key_name: string }).api_key_name }
      : null,
  })) as EmailLogsResult["logs"];

  return { logs: enriched, total };
}

export function normalizeLogsFilters(raw: Record<string, string | undefined>): EmailLogsFilters {
  const trim = (v: string | undefined) => {
    const t = v?.trim();
    return t && t.length > 0 ? t : null;
  };
  const recipient = trim(raw.recipient);
  const subject = trim(raw.subject);
  const domainId = trim(raw.domain_id ?? raw.domainId);
  const status = trim(raw.status);
  const messageId = trim(raw.message_id ?? raw.messageId ?? raw.messageId);
  // date aliases: from/to, start_date, end_date, startDate, endDate
  const fromDate = trim(raw.from ?? raw.from_date ?? raw.fromDate ?? raw.start_date ?? raw.startDate);
  const toDate = trim(raw.to ?? raw.to_date ?? raw.toDate ?? raw.end_date ?? raw.endDate);
  return { domainId, status, recipient, subject, fromDate, toDate, messageId };
}

import { query, type DbRow } from "./database";

export type SuppressionReason = "bounce" | "complaint";

export interface Suppression {
  id: string;
  domain_id: string;
  email: string;
  reason: SuppressionReason;
  created_at: string;
}

type SuppressionRow = DbRow<Suppression>;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function addSuppression(
  domainId: string,
  email: string,
  reason: SuppressionReason,
): Promise<void> {
  const normalized = normalizeEmail(email);
  await query(
    `INSERT INTO suppressions (domain_id, email, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [domainId, normalized, reason],
  );
}

export async function addSuppressions(
  domainId: string,
  emails: string[],
  reason: SuppressionReason,
): Promise<void> {
  const unique = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  for (const email of unique) {
    await addSuppression(domainId, email, reason);
  }
}

export async function isSuppressed(domainId: string, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const result = await query(
    `SELECT 1 FROM suppressions WHERE domain_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
    [domainId, normalized],
  );
  return result.rows.length > 0;
}

export async function findSuppressed(
  domainId: string,
  emails: string[],
): Promise<string[]> {
  const normalized = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  if (normalized.length === 0) return [];
  const result = await query<{ email: string }>(
    `SELECT email FROM suppressions WHERE domain_id = $1 AND LOWER(email) = ANY($2)`,
    [domainId, normalized],
  );
  return result.rows.map((r) => r.email);
}

export async function listSuppressions(domainId: string): Promise<Suppression[]> {
  const result = await query<SuppressionRow>(
    `SELECT id, domain_id, email, reason, created_at FROM suppressions WHERE domain_id = $1 ORDER BY created_at DESC`,
    [domainId],
  );
  return result.rows as Suppression[];
}

export async function removeSuppression(domainId: string, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const result = await query(
    `DELETE FROM suppressions WHERE domain_id = $1 AND LOWER(email) = LOWER($2)`,
    [domainId, normalized],
  );
  return (result.rowCount ?? 0) > 0;
}

export function bareAddress(input: string): string {
  const m = input.match(/<([^>]+)>/);
  return (m ? m[1] : input).trim().toLowerCase();
}

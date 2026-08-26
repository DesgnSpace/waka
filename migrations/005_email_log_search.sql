-- Search filters for email_logs: recipient (to/cc/bcc JSON), subject substring,
-- date range, and message id. See item 15 — avoid seq scan on the growing table.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Generated column that concatenates recipient JSON arrays into a single lowercased
-- text value. STORED so it is computed once at write time and indexable.
-- Backfills automatically: existing rows compute the value on ALTER.
ALTER TABLE email_logs
  ADD COLUMN IF NOT EXISTS recipient_search text
  GENERATED ALWAYS AS (
    lower(coalesce(to_emails::text, '') || ' ' || coalesce(cc_emails::text, '') || ' ' || coalesce(bcc_emails::text, ''))
  ) STORED;

-- Trigram GIN indexes: support LIKE '%substring%' without seq scan.
CREATE INDEX IF NOT EXISTS idx_email_logs_recipient_search_trgm
  ON email_logs USING gin (recipient_search gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_email_logs_subject_trgm
  ON email_logs USING gin (lower(subject) gin_trgm_ops);

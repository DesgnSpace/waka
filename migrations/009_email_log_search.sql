-- Search filters for email_logs: recipient (to/cc/bcc JSON), subject substring,
-- date range and message id. Trigram GIN indexes keep substring matches off a
-- sequential scan. Expression indexes only: email_logs is not rewritten.
-- Requires CREATE on the database for the pg_trgm extension.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The indexed expressions must stay byte-identical to the ones in
-- buildEmailLogsWhere or the planner will not use these indexes.
CREATE INDEX IF NOT EXISTS idx_email_logs_recipient_trgm
  ON email_logs USING gin ((lower(coalesce(to_emails::text, '') || ' ' || coalesce(cc_emails::text, '') || ' ' || coalesce(bcc_emails::text, ''))) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_email_logs_subject_trgm
  ON email_logs USING gin (lower(subject) gin_trgm_ops);

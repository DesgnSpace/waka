-- Indexes for hot request paths: API key authentication, SES webhook event
-- lookup, and the log listing's per-domain newest-first pagination.

CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);

-- key_hash is only read after locating a row by key_prefix; no query filters on it.
DROP INDEX IF EXISTS idx_api_keys_key_hash;

CREATE INDEX IF NOT EXISTS idx_email_logs_ses_message_id ON email_logs(ses_message_id);

CREATE INDEX IF NOT EXISTS idx_email_logs_domain_id_created_at
  ON email_logs(domain_id, created_at DESC);

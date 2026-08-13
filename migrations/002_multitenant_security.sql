-- Constraints and counters required for hosted multi-tenant operation.

ALTER TABLE domains
  ALTER COLUMN user_id SET NOT NULL;

UPDATE domains
SET domain = LOWER(domain)
WHERE domain <> LOWER(domain);

CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_domain_lower
  ON domains (LOWER(domain));

ALTER TABLE api_keys
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN domain_id SET NOT NULL;

ALTER TABLE email_logs
  ALTER COLUMN domain_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domains_user_id_id_key'
  ) THEN
    ALTER TABLE domains ADD CONSTRAINT domains_user_id_id_key UNIQUE (user_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_user_domain_fkey'
  ) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_user_domain_fkey
      FOREIGN KEY (user_id, domain_id) REFERENCES domains (user_id, id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS account_send_usage (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_account_send_usage_window
  ON account_send_usage(window_started_at);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0)
);

-- Per-key limits: optional caps on a single API key so a leaked or
-- misbehaving key is contained without throttling the whole account.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute >= 1),
  ADD COLUMN IF NOT EXISTS daily_send_limit INTEGER CHECK (daily_send_limit IS NULL OR daily_send_limit >= 1);

CREATE TABLE IF NOT EXISTS api_key_send_usage (
  api_key_id UUID PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
  window_started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_api_key_send_usage_window
  ON api_key_send_usage(window_started_at);

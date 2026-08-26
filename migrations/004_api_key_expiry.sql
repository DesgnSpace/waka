-- Optional expiry for API keys. NULL means the key never expires so existing keys are unaffected.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at ON api_keys(expires_at);

-- Permission cleanup does not require a data rewrite. Keys that carry the
-- removed permissions (receive, webhooks) keep their stored value; the
-- application filters them to the allowed set and continues to deny send
-- for keys that never had it, preserving the prior behavior without widening.

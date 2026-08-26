-- Reserved idempotency keys for POST /api/emails. One row per (api key,
-- Idempotency-Key) pair stores the first response so retries replay it
-- instead of sending the same email twice.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending (first send still in flight) | completed
  response_status INTEGER, -- HTTP status of the first finished response
  response_body JSONB,     -- JSON body of the first finished response
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Scoped per API key: the same key string under two API keys never collides,
-- and the unique index arbitrates concurrent retries across containers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_scope
  ON idempotency_keys (api_key_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON idempotency_keys (expires_at);

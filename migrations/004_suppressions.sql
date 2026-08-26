-- Suppression list: recipients that permanently bounced or complained per domain.
-- A suppressed address is refused on later sends for that domain only.
-- Transient bounces are never suppressed; they share no row here.

CREATE TABLE IF NOT EXISTS suppressions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  email VARCHAR(320) NOT NULL,
  reason VARCHAR(20) NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Lowercase email for case-insensitive lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppressions_domain_email
  ON suppressions (domain_id, LOWER(email));

CREATE INDEX IF NOT EXISTS idx_suppressions_domain_id ON suppressions(domain_id);

-- Scheduled sending: messages accepted now and delivered later by the
-- background worker in src/lib/scheduled-sends.ts.
--
-- status gains two values alongside pending/sent/failed/delivered/bounced/
-- complained: 'scheduled' (waiting for its send time or retry) and 'sending'
-- (claimed by a worker, not yet confirmed). payload holds the validated
-- request body, including raw attachment content that the attachments column
-- keeps only as display metadata; it is cleared once the message sends.
-- send_attempts counts delivery attempts, including claims reclaimed after a
-- crash, and caps retries.

ALTER TABLE email_logs
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS send_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payload JSONB;

-- The worker scans for due rows by send time on every tick; scheduled rows are
-- a small fraction of email_logs, so index only those.
CREATE INDEX IF NOT EXISTS idx_email_logs_scheduled_due
  ON email_logs (scheduled_at)
  WHERE status = 'scheduled';

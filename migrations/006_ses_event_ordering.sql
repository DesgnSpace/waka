-- SES notifications arrive at-least-once and out of order: each SNS message is
-- stored exactly once, and email_logs.status only moves forward through the
-- outcome ranks mirrored in src/lib/ses-events.ts.

ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS sns_message_id VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_sns_message_id
  ON webhook_events (sns_message_id);

CREATE OR REPLACE FUNCTION email_status_rank(status TEXT) RETURNS INT AS $$
  SELECT CASE status
    WHEN 'pending' THEN 0
    WHEN 'sent' THEN 1
    WHEN 'failed' THEN 2
    WHEN 'delivered' THEN 3
    WHEN 'bounced' THEN 4
    WHEN 'complained' THEN 5
    ELSE -1
  END;
$$ LANGUAGE sql IMMUTABLE;

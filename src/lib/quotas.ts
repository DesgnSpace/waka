import { query } from "./database";

const DEFAULT_DAILY_SEND_LIMIT = 1_000;

function dailySendLimit(): number {
  const raw = process.env.ACCOUNT_DAILY_SEND_LIMIT;
  if (!raw) return DEFAULT_DAILY_SEND_LIMIT;

  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("ACCOUNT_DAILY_SEND_LIMIT must be a positive integer");
  }
  return limit;
}

export async function reserveDailySend(userId: string): Promise<boolean> {
  const limit = dailySendLimit();
  const result = await query(
    `INSERT INTO account_send_usage (user_id, window_started_at, send_count)
     VALUES ($1, date_trunc('day', NOW()), 1)
     ON CONFLICT (user_id) DO UPDATE SET
       window_started_at = CASE
         WHEN account_send_usage.window_started_at < date_trunc('day', NOW())
           THEN date_trunc('day', NOW())
         ELSE account_send_usage.window_started_at
       END,
       send_count = CASE
         WHEN account_send_usage.window_started_at < date_trunc('day', NOW())
           THEN 1
         ELSE account_send_usage.send_count + 1
       END
     WHERE account_send_usage.window_started_at < date_trunc('day', NOW())
        OR account_send_usage.send_count < $2
     RETURNING send_count`,
    [userId, limit],
  );
  return result.rowCount === 1;
}

export async function reserveApiKeyDailySend(apiKeyId: string, limit: number): Promise<boolean> {
  const result = await query(
    `INSERT INTO api_key_send_usage (api_key_id, window_started_at, send_count)
     VALUES ($1, date_trunc('day', NOW()), 1)
     ON CONFLICT (api_key_id) DO UPDATE SET
       window_started_at = CASE
         WHEN api_key_send_usage.window_started_at < date_trunc('day', NOW())
           THEN date_trunc('day', NOW())
         ELSE api_key_send_usage.window_started_at
       END,
       send_count = CASE
         WHEN api_key_send_usage.window_started_at < date_trunc('day', NOW())
           THEN 1
         ELSE api_key_send_usage.send_count + 1
       END
     WHERE api_key_send_usage.window_started_at < date_trunc('day', NOW())
        OR api_key_send_usage.send_count < $2
     RETURNING send_count`,
    [apiKeyId, limit],
  );
  return result.rowCount === 1;
}

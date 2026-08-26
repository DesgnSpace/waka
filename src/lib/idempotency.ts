import { query, type DbRow } from "./database";

// A key keeps serving its stored response for this long, then the purge job
// deletes the row and the key value becomes reusable.
const RETENTION_MS = 24 * 60 * 60 * 1000;
// A pending claim older than this belongs to a dead request (e.g. a crashed
// container), so a new request may take the key over.
const CLAIM_STALE_MS = 5 * 60 * 1000;

export type IdempotencyReservation =
  | { kind: "claimed"; id: string }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "conflict" };

type StoredKeyRow = DbRow<{
  id: string;
  status: string;
  response_status: number | null;
  response_body: unknown;
}>;

// Atomically claim a (api_key_id, key) pair or report what an earlier request
// with the same pair produced. The unique index decides who wins when two
// containers process a retry at the same moment.
export async function reserveIdempotencyKey(
  apiKeyId: string,
  key: string,
): Promise<IdempotencyReservation> {
  const expiresAt = new Date(Date.now() + RETENTION_MS);

  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await query<{ id: string }>(
      `INSERT INTO idempotency_keys (api_key_id, idempotency_key, status, expires_at)
       VALUES ($1, $2, 'pending', $3)
       ON CONFLICT (api_key_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [apiKeyId, key, expiresAt]
    );
    const claimed = inserted.rows[0]?.id;
    if (claimed) return { kind: "claimed", id: claimed };

    const existing = await query<StoredKeyRow>(
      `SELECT id, status, response_status, response_body
       FROM idempotency_keys
       WHERE api_key_id = $1 AND idempotency_key = $2`,
      [apiKeyId, key]
    );
    const row = existing.rows[0];
    if (!row) continue; // purged between insert and select; try to claim again

    if (row.status === "completed" && row.response_status !== null) {
      return { kind: "replay", status: row.response_status, body: row.response_body };
    }

    // Still pending: fresh means in flight, stale means the owner died and
    // this request takes over. The conditional UPDATE re-checks atomically.
    const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);
    const takeover = await query<{ id: string }>(
      `UPDATE idempotency_keys SET updated_at = NOW()
       WHERE id = $1 AND status = 'pending' AND updated_at < $2
       RETURNING id`,
      [row.id, staleBefore]
    );
    if (takeover.rows[0]) return { kind: "claimed", id: row.id };
  }

  return { kind: "conflict" };
}

export async function completeIdempotencyKey(
  id: string,
  httpStatus: number,
  body: unknown,
): Promise<void> {
  await query(
    `UPDATE idempotency_keys
     SET status = 'completed', response_status = $2, response_body = $3, updated_at = NOW()
     WHERE id = $1`,
    [id, httpStatus, JSON.stringify(body)]
  );
}

// Pending only: never deletes a completed result or a claim another request
// has already taken over.
export async function releaseIdempotencyKey(id: string): Promise<void> {
  await query(`DELETE FROM idempotency_keys WHERE id = $1 AND status = 'pending'`, [id]);
}

export async function purgeExpiredIdempotencyKeys(now = new Date()): Promise<void> {
  await query(`DELETE FROM idempotency_keys WHERE expires_at < $1`, [now]);
}

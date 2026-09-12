import { customAlphabet } from "nanoid";
import { query } from "./database";
import type { ApiKey, DbRow } from "./database";
import { errorMessage } from "./errors";
import { parseStringArray } from "./serialization";

export type PublicApiKey = Omit<ApiKey, "key_hash">;

const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;
const lastUsedAtCache = new Map<string, number>();

const randomKeyPart = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  8,
);

export interface ApiKeyWithKey extends Omit<ApiKey, "key_hash"> {
  key: string;
}

type ApiKeyPublicRow = DbRow<
  Omit<ApiKey, "key_hash" | "permissions"> & { permissions: unknown }
>;
type ApiKeyVerificationRow = ApiKeyPublicRow & { key_hash: string };
type ApiKeyWithDomainRow = ApiKeyPublicRow & { domain_name: string | null };

const ALLOWED_PERMISSIONS: readonly string[] = ["send"];

function sanitizePermissions(permissions: string[]): string[] {
  return permissions.filter((permission) => ALLOWED_PERMISSIONS.includes(permission));
}

function toExpiryIso(value: string): string {
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) throw new Error("Invalid expiry date.");
  return parsed.toISOString();
}

export class ExpiredApiKeyError extends Error {
  expiresAt: string;
  constructor(expiresAt: string) {
    super(`API key expired at ${expiresAt}`);
    this.name = "ExpiredApiKeyError";
    this.expiresAt = expiresAt;
  }
}

function parsePermissions(value: unknown): string[] {
  const raw = value == null ? ["send"] : parseStringArray(value, "permissions");
  return sanitizePermissions(raw);
}

function publicApiKey(row: ApiKeyPublicRow): PublicApiKey {
  return {
    id: row.id,
    user_id: row.user_id,
    domain_id: row.domain_id,
    key_name: row.key_name,
    key_prefix: row.key_prefix,
    permissions: parsePermissions(row.permissions),
    expires_at: row.expires_at ?? null,
    rate_limit_per_minute: row.rate_limit_per_minute ?? null,
    daily_send_limit: row.daily_send_limit ?? null,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function generateApiKey(
  userId: string,
  domainId: string,
  keyName: string,
  permissions: string[] = ["send"],
  options: { expiresAt?: string | null; rateLimitPerMinute?: number | null; dailySendLimit?: number | null } = {},
): Promise<ApiKeyWithKey> {
  const keyId = randomKeyPart();
  const keySecret = customAlphabet(
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-",
    32,
  )();
  const apiKey = `wka_${keyId}_${keySecret}`; // wka = Waka

  const keyHash = await Bun.password.hash(apiKey, { algorithm: "bcrypt", cost: 10 });

  const sanitized = sanitizePermissions(permissions);
  const finalPermissions = sanitized.length ? sanitized : ["send"];
  const expiresAtIso = options.expiresAt ? toExpiryIso(options.expiresAt) : null;

  try {
    const result = await query<ApiKeyPublicRow>(
      `INSERT INTO api_keys (user_id, domain_id, key_name, key_hash, key_prefix, permissions, expires_at, rate_limit_per_minute, daily_send_limit)
       SELECT $1, d.id, $3, $4, $5, $6, $7, $8, $9
       FROM domains d
       WHERE d.id = $2 AND d.user_id = $1
       RETURNING id, user_id, domain_id, key_name, key_prefix, permissions, expires_at, rate_limit_per_minute, daily_send_limit, last_used_at, created_at, updated_at`,
      [
        userId,
        domainId,
        keyName,
        keyHash,
        `wka_${keyId}`,
        JSON.stringify(finalPermissions),
        expiresAtIso,
        options.rateLimitPerMinute ?? null,
        options.dailySendLimit ?? null,
      ]
    );

    const data = result.rows[0];
    if (!data) {
      throw new Error("Domain not found or you don't have access.");
    }
    return {
      ...publicApiKey(data),
      key: apiKey,
    };
  } catch (error: unknown) {
    throw new Error(`Couldn't create API key: ${errorMessage(error)}`);
  }
}

export async function verifyApiKey(
  apiKey: string,
): Promise<PublicApiKey | null> {
  // Extract prefix for efficient lookup
  // Split only on the first two underscores to handle underscores in the secret part
  const firstUnderscore = apiKey.indexOf("_");
  const secondUnderscore = apiKey.indexOf("_", firstUnderscore + 1);

  if (firstUnderscore === -1 || secondUnderscore === -1) {
    return null;
  }

  const prefix_part = apiKey.substring(0, firstUnderscore);
  const keyId_part = apiKey.substring(firstUnderscore + 1, secondUnderscore);
  const secret_part = apiKey.substring(secondUnderscore + 1);

  if (prefix_part !== "wka" || !keyId_part || !secret_part) {
    return null;
  }

  const prefix = `${prefix_part}_${keyId_part}`;

  const result = await query<ApiKeyVerificationRow>(
    `SELECT ak.id, ak.user_id, ak.domain_id, ak.key_name, ak.key_hash,
            ak.key_prefix, ak.permissions, ak.expires_at, ak.rate_limit_per_minute, ak.daily_send_limit,
            ak.last_used_at, ak.created_at, ak.updated_at
     FROM api_keys ak
     JOIN domains d ON d.id = ak.domain_id AND d.user_id = ak.user_id
     WHERE ak.key_prefix = $1`,
    [prefix],
  );

  for (const key of result.rows) {
    const isValid = await Bun.password.verify(apiKey, key.key_hash);
    if (isValid) {
      const expiresAt = key.expires_at;
      if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
        throw new ExpiredApiKeyError(expiresAt);
      }
      const now = Date.now();
      const last = lastUsedAtCache.get(key.id);
      if (last === undefined || now - last >= LAST_USED_THROTTLE_MS) {
        lastUsedAtCache.set(key.id, now);
        await query(
          "UPDATE api_keys SET last_used_at = NOW() WHERE id = $1 AND user_id = $2 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes')",
          [key.id, key.user_id],
        );
      }
      return publicApiKey(key);
    }
  }

  return null;
}

export async function getUserApiKeys(
  userId: string,
): Promise<Array<PublicApiKey & { domains: { domain: string } | null }>> {
  try {
    const result = await query<ApiKeyWithDomainRow>(
      `SELECT
        ak.id, ak.user_id, ak.domain_id, ak.key_name, ak.key_prefix,
        ak.permissions, ak.expires_at, ak.rate_limit_per_minute, ak.daily_send_limit,
        ak.last_used_at, ak.created_at, ak.updated_at,
        d.domain as domain_name
      FROM api_keys ak
      JOIN domains d ON ak.domain_id = d.id AND d.user_id = ak.user_id
      WHERE ak.user_id = $1
      ORDER BY ak.created_at DESC`,
      [userId]
    );

    return result.rows.map((row) => ({
      ...publicApiKey(row),
      domains: row.domain_name ? { domain: row.domain_name } : null,
    }));
  } catch (error: unknown) {
    throw new Error(`Couldn't fetch API keys: ${errorMessage(error)}`);
  }
}

export async function getDomainApiKeys(
  domainId: string,
  userId: string,
): Promise<PublicApiKey[]> {
  try {
    const result = await query<ApiKeyPublicRow>(
      `SELECT ak.id, ak.user_id, ak.domain_id, ak.key_name, ak.key_prefix,
              ak.permissions, ak.expires_at, ak.rate_limit_per_minute, ak.daily_send_limit,
              ak.last_used_at, ak.created_at, ak.updated_at
       FROM api_keys ak
       JOIN domains d ON d.id = ak.domain_id AND d.user_id = ak.user_id
       WHERE ak.domain_id = $1 AND ak.user_id = $2
       ORDER BY ak.created_at DESC`,
      [domainId, userId]
    );

    return result.rows.map(publicApiKey);
  } catch (error: unknown) {
    throw new Error(`Couldn't fetch domain API keys: ${errorMessage(error)}`);
  }
}

export async function deleteApiKey(
  keyId: string,
  userId: string
): Promise<void> {
  try {
    const result = await query(
      "DELETE FROM api_keys WHERE id = $1 AND user_id = $2",
      [keyId, userId]
    );

    if (result.rowCount === 0) {
      throw new Error("API key not found or you don't have access.");
    }
  } catch (error: unknown) {
    throw new Error(`Couldn't delete API key: ${errorMessage(error)}`);
  }
}

export async function updateApiKey(
  keyId: string,
  userId: string,
  updates: { permissions?: string[]; expiresAt?: string | null; rateLimitPerMinute?: number | null; dailySendLimit?: number | null }
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.permissions !== undefined) {
    const sanitized = sanitizePermissions(updates.permissions);
    if (!sanitized.length) throw new Error("At least one valid permission is required.");
    sets.push(`permissions = $${idx++}`);
    params.push(JSON.stringify(sanitized));
  }

  if (updates.expiresAt !== undefined) {
    const expiresAt = updates.expiresAt ? toExpiryIso(updates.expiresAt) : null;
    sets.push(`expires_at = $${idx++}`);
    params.push(expiresAt);
  }

  if (updates.rateLimitPerMinute !== undefined) {
    sets.push(`rate_limit_per_minute = $${idx++}`);
    params.push(updates.rateLimitPerMinute);
  }
  if (updates.dailySendLimit !== undefined) {
    sets.push(`daily_send_limit = $${idx++}`);
    params.push(updates.dailySendLimit);
  }

  if (!sets.length) throw new Error("No fields to update.");

  params.push(keyId, userId);
  const result = await query(
    `UPDATE api_keys SET ${sets.join(", ")} WHERE id = $${idx++} AND user_id = $${idx}`,
    params
  );
  if (result.rowCount === 0) throw new Error("API key not found or you don't have access.");
}

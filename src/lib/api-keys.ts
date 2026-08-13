import { customAlphabet } from "nanoid";
import bcrypt from "bcryptjs";
import { query } from "./database";
import type { ApiKey } from "./database";

export type PublicApiKey = Omit<ApiKey, "key_hash">;

const randomKeyPart = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  8,
);

export interface ApiKeyWithKey extends Omit<ApiKey, "key_hash"> {
  key: string;
}

// Helper function to safely parse permissions (handles both string and array)
function safeParsePermissions(permissions: unknown): string[] {
  if (!permissions) return ["send"];
  if (typeof permissions === "string") {
    try {
      permissions = JSON.parse(permissions);
    } catch {
      return ["send"];
    }
  }
  if (Array.isArray(permissions)) {
    return permissions.filter(
      (permission): permission is string => typeof permission === "string",
    );
  }
  return ["send"];
}

export async function generateApiKey(
  userId: string,
  domainId: string,
  keyName: string,
  permissions: string[] = ["send"]
): Promise<ApiKeyWithKey> {
  // Generate a secure API key with prefix
  const keyId = randomKeyPart();
  const keySecret = customAlphabet(
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-",
    32,
  )();
  const apiKey = `wka_${keyId}_${keySecret}`; // wka = Waka

  // Hash the key for storage
  const keyHash = await bcrypt.hash(apiKey, 10);

  try {
    const result = await query(
      `INSERT INTO api_keys (user_id, domain_id, key_name, key_hash, key_prefix, permissions)
       SELECT $1, d.id, $3, $4, $5, $6
       FROM domains d
       WHERE d.id = $2 AND d.user_id = $1
       RETURNING id, user_id, domain_id, key_name, key_prefix, permissions, last_used_at, created_at, updated_at`,
      [
        userId,
        domainId,
        keyName,
        keyHash,
        `wka_${keyId}`,
        JSON.stringify(permissions),
      ]
    );

    const data = result.rows[0];
    if (!data) {
      throw new Error("Domain not found or you don't have access.");
    }
    return {
      ...data,
      permissions: safeParsePermissions(data.permissions),
      key: apiKey,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Couldn't create API key: ${errorMessage}`);
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

  try {
    const result = await query(
      `SELECT ak.id, ak.user_id, ak.domain_id, ak.key_name, ak.key_hash,
              ak.key_prefix, ak.permissions, ak.last_used_at, ak.created_at, ak.updated_at
       FROM api_keys ak
       JOIN domains d ON d.id = ak.domain_id AND d.user_id = ak.user_id
       WHERE ak.key_prefix = $1`,
      [prefix],
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Verify the full key against each possible match
    for (const key of result.rows) {
      const isValid = await bcrypt.compare(apiKey, key.key_hash);
      if (isValid) {
        // Update last used timestamp
        await query(
          "UPDATE api_keys SET last_used_at = NOW() WHERE id = $1 AND user_id = $2",
          [key.id, key.user_id],
        );

        // Parse JSON fields
        const { key_hash: _keyHash, ...safeKey } = key;
        return {
          ...safeKey,
          permissions: safeParsePermissions(key.permissions),
        };
      }
    }

    return null;
  } catch (error) {
    console.error("API key verification error:", error);
    return null;
  }
}

export async function getUserApiKeys(userId: string): Promise<PublicApiKey[]> {
  try {
    const result = await query(
      `SELECT 
        ak.id, ak.user_id, ak.domain_id, ak.key_name, ak.key_prefix,
        ak.permissions, ak.last_used_at, ak.created_at, ak.updated_at,
        d.domain as domain_name
      FROM api_keys ak
      JOIN domains d ON ak.domain_id = d.id AND d.user_id = ak.user_id
      WHERE ak.user_id = $1
      ORDER BY ak.created_at DESC`,
      [userId]
    );

    return result.rows.map((row) => ({
      ...row,
      permissions: safeParsePermissions(row.permissions),
      domains: row.domain_name ? { domain: row.domain_name } : null,
    }));
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Couldn't fetch API keys: ${errorMessage}`);
  }
}

export async function getDomainApiKeys(
  domainId: string,
  userId: string,
): Promise<PublicApiKey[]> {
  try {
    const result = await query(
      `SELECT ak.id, ak.user_id, ak.domain_id, ak.key_name, ak.key_prefix,
              ak.permissions, ak.last_used_at, ak.created_at, ak.updated_at
       FROM api_keys ak
       JOIN domains d ON d.id = ak.domain_id AND d.user_id = ak.user_id
       WHERE ak.domain_id = $1 AND ak.user_id = $2
       ORDER BY ak.created_at DESC`,
      [domainId, userId]
    );

    return result.rows.map((row) => ({
      ...row,
      permissions: safeParsePermissions(row.permissions),
    }));
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Couldn't fetch domain API keys: ${errorMessage}`);
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Couldn't delete API key: ${errorMessage}`);
  }
}

export async function updateApiKeyPermissions(
  keyId: string,
  userId: string,
  permissions: string[]
): Promise<void> {
  try {
    const result = await query(
      "UPDATE api_keys SET permissions = $1 WHERE id = $2 AND user_id = $3",
      [JSON.stringify(permissions), keyId, userId]
    );

    if (result.rowCount === 0) {
      throw new Error("API key not found or you don't have access.");
    }
  } catch (error: unknown) {
    const errorObj = error as { message?: string };
    throw new Error(`Couldn't update API key permissions: ${errorObj.message}`);
  }
}

export function maskApiKey(apiKey: string): string {
  const parts = apiKey.split("_");
  if (parts.length !== 3) return "wka_...";

  return `${parts[0]}_${parts[1]}_${"*".repeat(parts[2].length)}`;
}

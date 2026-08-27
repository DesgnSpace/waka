import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

export type DbRow<T extends object> = T & QueryResultRow;

// Postgres TLS mode, configurable via DATABASE_SSL:
//   unset | "false" | "disable"  -> no TLS (default; correct for a private
//                                   Docker network where the server has SSL off)
//   "true"  | "require"          -> TLS with full certificate verification
//   "no-verify" | "insecure"     -> TLS but accept self-signed certificates
function resolvePgSsl(): false | { rejectUnauthorized: boolean } {
  const mode = (process.env.DATABASE_SSL || "false").toLowerCase();
  if (["", "false", "disable", "off"].includes(mode)) return false;
  if (["no-verify", "insecure"].includes(mode)) return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolvePgSsl(),
  max: 5, // Maximum number of clients in the pool (reduced from 20)
  idleTimeoutMillis: 10000, // Close idle clients after 10 seconds (reduced from 30s)
  connectionTimeoutMillis: 5000, // Return an error after 5 seconds if connection could not be established
});

export { pool as db };

export function query(
  text: string,
  params?: unknown[],
): Promise<QueryResult>;
export function query<Row extends QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<Row>>;
export async function query(
  text: string,
  params?: unknown[],
): Promise<QueryResult> {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Domain {
  id: string;
  user_id: string;
  domain: string;
  status: "pending" | "verified" | "failed";
  ses_identity_arn?: string | null;
  verification_token?: string | null;
  ses_configuration_set?: string | null;
  do_domain_id?: string | null;
  mail_from_domain?: string | null;
  dns_records: unknown[];
  smtp_credentials?: {
    username: string;
    password: string;
    server: string;
    port: number;
  } | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  domain_id: string;
  key_name: string;
  key_hash: string;
  key_prefix: string;
  permissions: string[];
  expires_at: string | null;
  rate_limit_per_minute: number | null;
  daily_send_limit: number | null;
  last_used_at?: string | null;
  created_at: string;
  updated_at: string;
}

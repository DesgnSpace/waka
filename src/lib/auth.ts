import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { query } from "./database";
import type { User } from "./database";

const JWT_ALGORITHM = "HS256";
const JWT_EXPIRES_IN = "1h";
const authClaimsSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().optional(),
});

function jwtSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("NEXTAUTH_SECRET must be set to at least 32 characters");
  }
  return secret;
}

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("Password must be at most 72 UTF-8 bytes");
  }
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateJWT(user: AuthUser): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name ?? undefined,
    },
    jwtSecret(),
    { algorithm: JWT_ALGORITHM, expiresIn: JWT_EXPIRES_IN }
  );
}

export function verifyJWT(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, jwtSecret(), {
      algorithms: [JWT_ALGORITHM],
    });
    const claims = authClaimsSchema.safeParse(decoded);
    return claims.success ? claims.data : null;
  } catch {
    return null;
  }
}

export async function createUser(
  email: string,
  password: string,
  name?: string
): Promise<Omit<User, "password_hash">> {
  const passwordHash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();

  const result = await query<Omit<User, "password_hash">>(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     RETURNING id, email, name, created_at, updated_at`,
    [normalizedEmail, passwordHash, name?.trim() || null],
  );

  if (result.rows.length === 0) {
    throw new Error("Couldn't create user.");
  }

  return result.rows[0];
}

const DUMMY_PASSWORD_HASH =
  "$2b$12$LQv3c1yqBW1A3pY2J7b9Ue6cQ2iW8D8Q4jD5k9o8n3m2x1v0u9t8S";

export async function authenticateUser(
  email: string,
  password: string
): Promise<AuthUser | null> {
  const result = await query<{
    id: string;
    email: string;
    name: string | null;
    password_hash: string;
  }>(
    "SELECT id, email, name, password_hash FROM users WHERE email = $1 LIMIT 1",
    [email.trim().toLowerCase()],
  );
  const user = result.rows[0];
  const isValid = await verifyPassword(
    password,
    user?.password_hash ?? DUMMY_PASSWORD_HASH,
  );
  if (!isValid || !user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name ?? undefined,
  };
}

import { ZodError } from "zod";
import { verifyJWT, type AuthUser } from "@/lib/auth";
import { verifyApiKey } from "@/lib/api-keys";
import type { ApiKey } from "@/lib/database";

// Shared CORS headers (parity with the previous Next handlers).
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

function preflight(): Response {
  return new Response(null, { status: 200, headers: CORS });
}

// Thrown by guards to short-circuit a handler with a specific status + body.
export class HttpError extends Error {
  constructor(public status: number, public body: unknown) {
    super("HttpError");
  }
}

// A routed Bun request carries path params (e.g. /api/domains/:id).
export type Req = Request & { params: Record<string, string> };
type Handler = (req: Req) => Promise<Response> | Response;

// Wrap a handler with uniform error handling. ZodError -> 400, HttpError ->
// its status, anything else -> 500. Keeps every handler down to its logic.
function wrap(fn: Handler): Handler {
  return async (req) => {
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) return json(err.body, err.status);
      if (err instanceof ZodError) {
        return json({ error: "Invalid request data", details: err.issues }, 400);
      }
      console.error("API error:", err);
      return json({ error: "Internal server error" }, 500);
    }
  };
}

// Build a Bun.serve route value from per-method handlers, adding an OPTIONS
// preflight automatically so browsers can call the API.
export function methods(map: Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Handler>>) {
  const out: Record<string, Handler> = { OPTIONS: () => preflight() };
  for (const [method, fn] of Object.entries(map)) {
    if (fn) out[method] = wrap(fn);
  }
  return out;
}

// --- auth guards -------------------------------------------------------------

export function requireUser(req: Request): AuthUser {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    throw new HttpError(401, { error: "Sign in again to continue." });
  }
  const user = verifyJWT(auth.slice(7));
  if (!user)     throw new HttpError(401, { error: "Your session expired. Sign in again." });
  return user;
}

export async function requireApiKey(req: Request): Promise<ApiKey> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    throw new HttpError(401, { error: "Include an API key in the Authorization header." });
  }
  const key = await verifyApiKey(auth.slice(7));
  if (!key)     throw new HttpError(401, { error: "API key is invalid or revoked." });
  return key;
}

// --- session cookie (HTMX dashboard) ----------------------------------------
// The dashboard logs in once and stores the same JWT in an HttpOnly cookie, so
// the API contract (Bearer JWT) and the UI share one auth mechanism.

const SESSION_COOKIE = "waka_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7d, matches the JWT expiry
const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${secureFlag}; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax${secureFlag}; Max-Age=0`;
}

export function sessionUser(req: Request): AuthUser | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  return verifyJWT(decodeURIComponent(match[1]));
}

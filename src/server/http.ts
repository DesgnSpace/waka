import { ZodError } from "zod";
import { verifyJWT, type AuthUser } from "@/lib/auth";
import { verifyApiKey } from "@/lib/api-keys";
import type { ApiKey } from "@/lib/database";

// CORS is configured via CORS_ORIGIN or DOMAIN env. Default is same-origin
// only (no Access-Control-Allow-Origin header), which blocks cross-origin
// requests. Set CORS_ORIGIN to a comma-separated list of allowed origins, or
// set DOMAIN to the app's canonical hostname (e.g. mail.desgn.space) and it
// will be treated as https://<DOMAIN>. Credentials are allowed when an origin
// is permitted, which the cookie-based dashboard needs.
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization, HX-Request";

function normalizeOrigin(domain: string): string {
  if (/^https?:\/\//.test(domain)) return domain;
  return `https://${domain}`;
}

function allowedOrigin(origin: string | null): string | null {
  const configured = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const domainOrigin = process.env.DOMAIN ? normalizeOrigin(process.env.DOMAIN) : null;
  const allowed = configured.length > 0 ? configured : domainOrigin ? [domainOrigin] : [];
  if (allowed.includes("*")) return origin; // reflect origin; * is invalid with credentials
  if (allowed.length === 0) return null; // same-origin only
  if (!origin) return null;
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowOrigin = allowedOrigin(origin);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Vary": "Origin",
  };
  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

function mergeCors(res: Response, origin: string | null): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    if (value) headers.set(key, value);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
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

// Wrap a handler with uniform error handling and CORS. ZodError -> 400,
// HttpError -> its status, anything else -> 500.
function wrap(fn: Handler): Handler {
  return async (req) => {
    const origin = req.headers.get("origin");
    try {
      return mergeCors(await fn(req), origin);
    } catch (err) {
      if (err instanceof HttpError) return mergeCors(json(err.body, err.status), origin);
      if (err instanceof ZodError) {
        // Surface the concrete reason (path + message) so API clients — incl. the
        // Resend SDK, which reads `message` — see what actually failed, not a blanket.
        const issue = err.issues[0];
        const path = issue?.path.join(".");
        const reason = issue
          ? path
            ? `${path}: ${issue.message}`
            : issue.message
          : "Invalid request data";
        return mergeCors(json({ error: reason, message: reason, details: err.issues }, 400), origin);
      }
      console.error("API error:", err);
      return mergeCors(json({ error: "Internal server error" }, 500), origin);
    }
  };
}

// Build a Bun.serve route value from per-method handlers, adding an OPTIONS
// preflight automatically so browsers can call the API.
export function methods(map: Partial<Record<"GET" | "POST" | "PUT" | "DELETE", Handler>>) {
  const out: Record<string, Handler> = { OPTIONS: (req) => preflight(req) };
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

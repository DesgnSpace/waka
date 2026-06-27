import {
  sessionUser,
  sessionCookie,
  clearSessionCookie,
  type Req,
} from "./http";
import { authenticateUser, generateJWT, type AuthUser } from "@/lib/auth";
import {
  getUserDomains,
  addDomain,
  getDomainById,
  deleteDomain,
  checkDomainVerification,
} from "@/lib/domains";
import { getUserApiKeys, generateApiKey, deleteApiKey } from "@/lib/api-keys";
import { query } from "@/lib/database";

// --- helpers -----------------------------------------------------------------

const ESC: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { "Content-Type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });
}

function redirectToLogin(req: Request): Response {
  if (req.headers.get("HX-Request")) {
    return new Response("", { status: 401, headers: { "HX-Redirect": "/login" } });
  }
  return new Response("", { status: 302, headers: { Location: "/login" } });
}

// Returns the session user, or a redirect Response the caller must return.
function gate(req: Request): AuthUser | Response {
  return sessionUser(req) ?? redirectToLogin(req);
}

const STYLE = `
:root{--bg:#0b0c10;--panel:#15171e;--line:#262a35;--fg:#e7e9ee;--mut:#9aa3b2;--acc:#6ea8fe;--ok:#3fb950;--warn:#d29922;--err:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
a{color:var(--acc);text-decoration:none}
.topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 22px;border-bottom:1px solid var(--line)}
.brand{font-weight:700;font-size:18px}.who{color:var(--mut);font-size:14px}
main{max-width:920px;margin:28px auto;padding:0 18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px}
.narrow{max-width:380px;margin:8vh auto}
h1{font-size:22px;margin:0 0 18px}
label{display:block;margin:0 0 12px;color:var(--mut);font-size:13px}
input,select{width:100%;margin-top:5px;padding:9px 11px;background:#0e1016;border:1px solid var(--line);border-radius:8px;color:var(--fg);font:inherit}
button{padding:8px 14px;background:var(--acc);color:#06122c;border:0;border-radius:8px;font:inherit;font-weight:600;cursor:pointer}
button.danger{background:transparent;color:var(--err);border:1px solid var(--err)}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
.tabs{display:flex;gap:8px;margin-bottom:18px}.tabs button{background:transparent;border:1px solid var(--line);color:var(--fg)}
.row{display:flex;gap:10px;align-items:flex-end;margin-bottom:18px}.row input,.row select{margin-top:0}
table{width:100%;border-collapse:collapse;margin-top:6px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);font-size:14px}
th{color:var(--mut);font-weight:600}
.badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.badge.verified{color:var(--ok);border-color:var(--ok)}.badge.pending{color:var(--warn);border-color:var(--warn)}.badge.failed{color:var(--err);border-color:var(--err)}
.banner{background:#0e1016;border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:16px}
.banner code{word-break:break-all;color:var(--acc)}
.err{color:var(--err)}.ok{color:var(--ok)}.mut{color:var(--mut)}
pre{white-space:pre-wrap;font-size:12px;background:#0e1016;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto}
`;

function layout(title: string, body: string, user?: AuthUser | null): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · waka</title>
<script src="https://unpkg.com/htmx.org@2.0.3"></script>
<style>${STYLE}</style></head><body>
<header class="topbar"><div class="brand">🛵 waka</div>
${user ? `<div class="who">${esc(user.email)} · <a href="/logout">Log out</a></div>` : ""}</header>
<main>${body}</main></body></html>`;
}

// --- auth pages --------------------------------------------------------------

export function loginPage(req: Req): Response {
  if (sessionUser(req)) return new Response("", { status: 302, headers: { Location: "/dashboard" } });
  return html(
    layout(
      "Sign in",
      `<div class="card narrow"><h1>Sign in</h1>
      <form hx-post="/login" hx-target="#msg" hx-swap="innerHTML">
        <label>Email<input name="email" type="email" required autofocus></label>
        <label>Password<input name="password" type="password" required></label>
        <button type="submit">Sign in</button>
        <div id="msg" style="margin-top:12px"></div>
      </form></div>`
    )
  );
}

export async function doLogin(req: Req): Promise<Response> {
  const form = await req.formData();
  const user = await authenticateUser(
    String(form.get("email") ?? ""),
    String(form.get("password") ?? "")
  );
  if (!user) return html(`<p class="err">Invalid email or password.</p>`);
  return html(`<p class="ok">Signed in…</p>`, {
    headers: { "Set-Cookie": sessionCookie(generateJWT(user)), "HX-Redirect": "/dashboard" },
  });
}

export function logout(): Response {
  return new Response("", {
    status: 302,
    headers: { Location: "/login", "Set-Cookie": clearSessionCookie() },
  });
}

export function home(req: Req): Response {
  return new Response("", {
    status: 302,
    headers: { Location: sessionUser(req) ? "/dashboard" : "/login" },
  });
}

export function dashboard(req: Req): Response {
  const user = gate(req);
  if (user instanceof Response) return user;
  return html(
    layout(
      "Dashboard",
      `<nav class="tabs">
        <button hx-get="/ui/domains" hx-target="#panel">Domains</button>
        <button hx-get="/ui/keys" hx-target="#panel">API Keys</button>
        <button hx-get="/ui/logs" hx-target="#panel">Email Logs</button>
      </nav>
      <section id="panel" hx-get="/ui/domains" hx-trigger="load"></section>`,
      user
    )
  );
}

// --- domains -----------------------------------------------------------------

interface DnsRecord { type: string; name: string; value: string }

function domainsView(
  domains: Array<{ id: string; domain: string; status: string }>,
  banner = ""
): string {
  const rows = domains
    .map(
      (d) => `<tr><td>${esc(d.domain)}</td>
      <td><span class="badge ${esc(d.status)}">${esc(d.status)}</span></td>
      <td style="display:flex;gap:6px">
        ${d.status !== "verified" ? `<button class="ghost" hx-post="/ui/domains/${esc(d.id)}/verify" hx-target="#panel">Check DNS</button>` : ""}
        <button class="danger" hx-post="/ui/domains/${esc(d.id)}/delete" hx-target="#panel" hx-confirm="Delete ${esc(d.domain)}?">Delete</button>
      </td></tr>`
    )
    .join("");
  return `${banner}
  <form hx-post="/ui/domains" hx-target="#panel" class="row">
    <input name="domain" placeholder="mail.example.com" required>
    <button>Add domain</button>
  </form>
  <table><tr><th>Domain</th><th>Status</th><th></th></tr>
  ${rows || `<tr><td colspan="3" class="mut">No domains yet.</td></tr>`}</table>`;
}

function dnsBanner(records: DnsRecord[]): string {
  if (!records?.length) return "";
  const rows = records
    .map((r) => `<tr><td>${esc(r.type)}</td><td>${esc(r.name)}</td><td><code>${esc(r.value)}</code></td></tr>`)
    .join("");
  return `<div class="banner"><strong>Add these DNS records, then click “Check DNS”:</strong>
    <table><tr><th>Type</th><th>Name</th><th>Value</th></tr>${rows}</table></div>`;
}

export async function uiDomains(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  return html(domainsView(await getUserDomains(user.id)));
}

export async function uiAddDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = String((await req.formData()).get("domain") ?? "").trim();
  if (!domain) return html(domainsView(await getUserDomains(user.id), `<p class="err">Domain is required.</p>`));
  try {
    const result = (await addDomain(user.id, domain)) as { dnsRecords?: DnsRecord[] };
    return html(domainsView(await getUserDomains(user.id), dnsBanner(result.dnsRecords ?? [])));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to add domain.";
    return html(domainsView(await getUserDomains(user.id), `<p class="err">${esc(msg)}</p>`));
  }
}

export async function uiVerifyDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  let banner = "";
  if (!domain || domain.user_id !== user.id) {
    banner = `<p class="err">Domain not found.</p>`;
  } else {
    const status = await checkDomainVerification(req.params.id);
    banner =
      status === "verified"
        ? `<p class="ok">${esc(domain.domain)} verified.</p>`
        : `<p class="mut">${esc(domain.domain)} still pending — DNS may take time to propagate.</p>`;
  }
  return html(domainsView(await getUserDomains(user.id), banner));
}

export async function uiDeleteDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  try {
    await deleteDomain(req.params.id, user.id);
  } catch (err) {
    console.error("delete domain failed:", err);
  }
  return html(domainsView(await getUserDomains(user.id)));
}

// --- api keys ----------------------------------------------------------------

function keysView(
  keys: Array<{ id: string; key_name: string; key_prefix: string; permissions: string[]; domains?: { domain: string } | null }>,
  domains: Array<{ id: string; domain: string; status: string }>,
  banner = ""
): string {
  const verified = domains.filter((d) => d.status === "verified");
  const options = verified.map((d) => `<option value="${esc(d.id)}">${esc(d.domain)}</option>`).join("");
  const rows = keys
    .map(
      (k) => `<tr><td>${esc(k.key_name)}</td><td><code>${esc(k.key_prefix)}…</code></td>
      <td>${esc(k.domains?.domain ?? "")}</td><td>${esc((k.permissions ?? []).join(", "))}</td>
      <td><button class="danger" hx-post="/ui/keys/${esc(k.id)}/delete" hx-target="#panel" hx-confirm="Revoke ${esc(k.key_name)}?">Revoke</button></td></tr>`
    )
    .join("");
  const form = verified.length
    ? `<form hx-post="/ui/keys" hx-target="#panel" class="row">
        <input name="keyName" placeholder="Key name" required>
        <select name="domainId" required>${options}</select>
        <button>Create key</button></form>`
    : `<p class="mut">Verify a domain before creating an API key.</p>`;
  return `${banner}${form}
  <table><tr><th>Name</th><th>Prefix</th><th>Domain</th><th>Permissions</th><th></th></tr>
  ${rows || `<tr><td colspan="5" class="mut">No API keys yet.</td></tr>`}</table>`;
}

export async function uiKeys(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const [keys, domains] = await Promise.all([getUserApiKeys(user.id), getUserDomains(user.id)]);
  return html(keysView(keys as never, domains));
}

export async function uiCreateKey(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const form = await req.formData();
  const keyName = String(form.get("keyName") ?? "").trim();
  const domainId = String(form.get("domainId") ?? "");
  let banner = "";
  try {
    const domain = await getDomainById(domainId);
    if (!domain || domain.user_id !== user.id) banner = `<p class="err">Domain not found.</p>`;
    else if (domain.status !== "verified") banner = `<p class="err">Domain must be verified first.</p>`;
    else {
      const created = (await generateApiKey(user.id, domainId, keyName)) as { key: string };
      banner = `<div class="banner"><strong>Copy this key now — it won't be shown again:</strong><br><code>${esc(created.key)}</code></div>`;
    }
  } catch (err) {
    banner = `<p class="err">${esc(err instanceof Error ? err.message : "Failed to create key.")}</p>`;
  }
  const [keys, domains] = await Promise.all([getUserApiKeys(user.id), getUserDomains(user.id)]);
  return html(keysView(keys as never, domains, banner));
}

export async function uiDeleteKey(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  try {
    await deleteApiKey(req.params.id, user.id);
  } catch (err) {
    console.error("delete key failed:", err);
  }
  const [keys, domains] = await Promise.all([getUserApiKeys(user.id), getUserDomains(user.id)]);
  return html(keysView(keys as never, domains));
}

// --- email logs --------------------------------------------------------------

export async function uiLogs(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const result = await query(
    `SELECT el.id, el.from_email, el.to_emails, el.subject, el.status, el.created_at, d.domain
     FROM email_logs el JOIN domains d ON el.domain_id = d.id
     WHERE d.user_id = $1 ORDER BY el.created_at DESC LIMIT 50`,
    [user.id]
  );
  const rows = result.rows
    .map((r) => {
      let to: string[] = [];
      try {
        to = typeof r.to_emails === "string" ? JSON.parse(r.to_emails) : r.to_emails ?? [];
      } catch {
        to = [];
      }
      return `<tr><td>${esc(new Date(r.created_at).toISOString().replace("T", " ").slice(0, 16))}</td>
      <td>${esc(r.from_email)}</td><td>${esc(to.join(", "))}</td>
      <td>${esc(r.subject)}</td><td><span class="badge ${esc(r.status)}">${esc(r.status)}</span></td></tr>`;
    })
    .join("");
  return html(
    `<table><tr><th>When</th><th>From</th><th>To</th><th>Subject</th><th>Status</th></tr>
    ${rows || `<tr><td colspan="5" class="mut">No emails sent yet.</td></tr>`}</table>`
  );
}

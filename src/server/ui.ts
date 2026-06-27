import crypto from "crypto";
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
  updateMailFromDomain,
} from "@/lib/domains";
import { getDomainApiKeys, generateApiKey, deleteApiKey } from "@/lib/api-keys";
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
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CSP,
      ...(init.headers ?? {}),
    },
  });
}

function seeOther(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response("", { status: 303, headers: { Location: location, ...extraHeaders } });
}

function redirectToLogin(): Response {
  return seeOther("/login");
}

function gate(req: Request): AuthUser | Response {
  return sessionUser(req) ?? redirectToLogin();
}

// The single icon in the whole app: copy. Used only on copy buttons.
const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function copyBtn(text: string, label = "Copy"): string {
  return `<button type="button" class="cbtn" data-copy-text="${esc(text)}" aria-label="${esc(label)}">${COPY_ICON}</button>`;
}

function formatDate(value: unknown): string {
  if (!value) return "—";
  const d = new Date(value as string | number | Date);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Predefined flash messages, keyed so query strings can never inject markup.
const FLASH: Record<string, { kind: "ok" | "err" | "mut"; text: string }> = {
  deleted: { kind: "ok", text: "Domain deleted." },
  verified: { kind: "ok", text: "Domain verified." },
  pending: { kind: "mut", text: "Still pending — DNS may take time to propagate." },
  revoked: { kind: "ok", text: "API key revoked." },
  "domain-required": { kind: "err", text: "Domain is required." },
  "domain-failed": { kind: "err", text: "Could not add that domain." },
  "mailfrom-saved": { kind: "ok", text: "Return-path domain saved — add the new DNS records." },
  "mailfrom-failed": { kind: "err", text: "Return-path must be a subdomain of this domain." },
};

function flashFrom(req: Req): string {
  const code = new URL(req.url).searchParams.get("m");
  const f = code ? FLASH[code] : undefined;
  return f ? alert(f.kind, f.text) : "";
}

// --- styles ------------------------------------------------------------------

const STYLE = `
:root{
  --bg:#f7f6f2;
  --fg:#171614;
  --muted:#75736c;
  --faint:#ecebe4;
  --faint-2:#e2e1d8;
  --accent:#27499c;
  --danger:#9a2820;
  --danger-bg:rgba(154,40,32,.1);
  --ok:#1f6b43;
  --warn:#8a5a00;
}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{
  background:var(--bg);
  color:var(--fg);
  font:14px/1.6 ui-monospace,SFMono-Regular,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.wrap{max-width:820px;margin:0 auto;padding:48px 24px 96px}

/* top bar */
.top{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:40px}
.brand{font-size:16px;font-weight:700;letter-spacing:.02em;color:var(--fg)}
.brand:hover{text-decoration:none}
.top-right{display:flex;align-items:baseline;gap:14px;color:var(--muted);font-size:13px}
.signout{background:none;border:0;padding:0;font:inherit;color:var(--muted);cursor:pointer}
.signout:hover{color:var(--danger);text-decoration:underline}

/* crumbs + headings */
.crumbs{color:var(--muted);font-size:13px;margin-bottom:18px}
.crumbs a{color:var(--muted)}
.crumbs .sep{padding:0 8px;color:var(--faint-2)}
h1{font-size:20px;font-weight:700;letter-spacing:-.01em;margin:0 0 6px}
.lede{color:var(--muted);margin-bottom:28px}

/* tabs */
.tabs{display:flex;gap:20px;margin:22px 0 28px}
.tab{color:var(--muted);font-size:13px}
.tab.active{color:var(--fg);font-weight:700;text-decoration:underline;text-underline-offset:4px}

/* forms */
label{display:block;color:var(--muted);font-size:13px;margin-bottom:16px}
label span{display:block;margin-bottom:6px}
input{
  width:100%;font:inherit;color:var(--fg);background:var(--faint);
  border:0;border-radius:6px;padding:10px 12px;
}
input::placeholder{color:var(--muted)}
input:focus{outline:2px solid var(--accent);outline-offset:0;background:var(--faint-2)}

/* buttons */
button,.btn{font:inherit;cursor:pointer}
.btn{
  display:inline-block;background:var(--accent);color:#fff;border:0;
  border-radius:6px;padding:9px 16px;min-height:38px;
}
.btn:hover{text-decoration:none;filter:brightness(1.08)}
.btn-quiet{background:var(--faint);color:var(--fg)}
.btn-quiet:hover{background:var(--faint-2);filter:none}
.btn-sm{padding:6px 12px;min-height:32px;font-size:13px}
/* destructive: red carried in the button, deepening to solid red on hover */
.btn-danger{background:var(--danger-bg);color:var(--danger)}
.btn-danger:hover{background:var(--danger);color:#fff;filter:none}
.btn:disabled{opacity:.5;cursor:not-allowed}
.act{background:none;border:0;color:var(--accent);padding:5px 8px;font:inherit;font-size:12px;border-radius:4px}
.act:hover{text-decoration:underline}
.act.danger{color:var(--danger);font-weight:600}
.act.danger:hover{background:var(--danger-bg);text-decoration:none}
.inline-form{display:inline}

/* toolbar */
.toolbar{display:flex;gap:10px;align-items:flex-start;margin-bottom:28px}
.toolbar input{flex:1}
.toolbar .btn{white-space:nowrap}

/* tables — no borders, spacing + hover only */
table{width:100%;border-collapse:collapse}
th{
  text-align:left;color:var(--muted);font-size:12px;font-weight:600;
  letter-spacing:.04em;padding:0 12px 10px;
}
td{padding:11px 12px;vertical-align:top}
tr:hover td{background:var(--faint)}
th.right,td.right{text-align:right;white-space:nowrap}
.t-name{font-weight:600;color:var(--fg)}
.t-name:hover{color:var(--accent)}
.t-sub{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.t-mut{color:var(--muted)}
.logs td{font-size:12.5px}

/* status — color + word (never color alone) */
.st-verified{color:var(--ok)}
.st-pending{color:var(--warn)}
.st-failed,.st-bounced,.st-delivered{color:var(--fg)}
.st-failed,.st-bounced{color:var(--danger)}
.st-delivered{color:var(--ok)}

/* alerts */
.alert{padding:10px 14px;border-radius:6px;margin-bottom:20px;font-size:13px}
.alert.ok{color:var(--ok);background:var(--faint)}
.alert.err{color:var(--danger);background:var(--faint)}
.alert.mut{color:var(--muted);background:var(--faint)}

/* dns + key blocks */
.block{background:var(--faint);border-radius:8px;padding:18px;margin-bottom:24px}
.block-title{font-weight:700;font-size:13px;margin-bottom:14px}
.block table td,.block table th{padding:7px 10px}
.block code{word-break:break-all;color:var(--fg)}
.dl-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px}
.dl-row .note{color:var(--muted);font-size:12px}
.keyout{display:flex;gap:12px;align-items:center;margin-top:12px}
.keyout code{flex:1;background:var(--bg);border-radius:6px;padding:10px 12px;word-break:break-all}

/* empty */
.empty{color:var(--muted);padding:40px 4px;text-align:center}
.empty .empty-t{color:var(--fg);font-weight:700;margin-bottom:4px}

/* login */
.login{min-height:64vh;display:flex;flex-direction:column;justify-content:center;max-width:340px;margin:0 auto}
.login h1{margin-bottom:4px}
.login .lede{margin-bottom:26px}

/* status dot (domain verification) */
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--muted);vertical-align:baseline;cursor:help}
.dot-ok{background:var(--ok)}
.dot-pending{background:var(--warn)}
.dot-failed{background:var(--danger)}
h1 .dot{margin-left:8px}

/* copy button (the one icon in the app) */
.cbtn{display:inline-grid;place-items:center;width:26px;height:26px;padding:0;margin-right:8px;vertical-align:middle;background:none;border:0;border-radius:4px;color:var(--muted);cursor:pointer}
.cbtn svg{width:14px;height:14px}
.cbtn:hover{color:var(--fg);background:var(--faint-2)}
.cbtn.copied{color:var(--ok);animation:copied-pop .9s ease}
@keyframes copied-pop{0%{transform:scale(1)}30%{transform:scale(1.3)}100%{transform:scale(1)}}
@media(prefers-reduced-motion:reduce){.cbtn.copied{animation:none}}

/* confirm popover (anchored beside the clicked element) */
.cpop{position:fixed;inset:auto;margin:0;z-index:50;max-width:260px;padding:14px;
  background:var(--bg);color:var(--fg);border:0;border-radius:8px;font:inherit;
  box-shadow:0 8px 30px rgba(20,19,16,.2);
  transition:opacity .12s ease,transform .12s ease;transition-behavior:allow-discrete}
@starting-style{.cpop:popover-open{opacity:0;transform:translateY(-4px)}}
@media(prefers-reduced-motion:reduce){.cpop{transition:none}}
.cpop-q{margin-bottom:12px;line-height:1.5;font-size:13px}
.cpop-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center}
.btn-xs{padding:5px 12px;min-height:30px}
.btn-text{background:none;border:0;color:var(--muted);font:inherit;cursor:pointer;padding:5px 8px}
.btn-text:hover{color:var(--fg)}

.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (max-width:560px){.wrap{padding:32px 16px 64px}.btn,.signout{min-height:44px}}
`;

// One inline script, two jobs:
//  1. hx-confirm -> a small popover anchored beside the clicked element (not a
//     centered modal). Uses the Popover API (top layer, light-dismiss = cancel),
//     falling back to window.confirm where unsupported.
//  2. [data-copy-text] -> copy the literal value with a quick pulse animation.
// Event-delegated on document so it survives hx-boost body swaps; the popover is
// looked up fresh each time. CSP allows exactly this block by its sha256 hash.
const APP_SCRIPT = `(function(){
  var pending=null;
  function pop(){return document.getElementById('cpop');}
  document.addEventListener('htmx:confirm',function(e){
    if(!e.detail.question)return;
    e.preventDefault();
    var p=pop();
    if(!p||!p.showPopover){if(window.confirm(e.detail.question))e.detail.issueRequest(true);return;}
    pending=e.detail;
    var q=document.getElementById('cpop-q');if(q)q.textContent=e.detail.question;
    var r=e.detail.elt.getBoundingClientRect();
    p.style.top=(r.bottom+6)+'px';
    p.style.left=r.left+'px';
    p.showPopover();
    var pr=p.getBoundingClientRect();
    if(pr.right>window.innerWidth-8)p.style.left=Math.max(8,window.innerWidth-8-pr.width)+'px';
    if(pr.bottom>window.innerHeight-8)p.style.top=Math.max(8,r.top-pr.height-6)+'px';
  });
  document.addEventListener('toggle',function(e){
    if(e.target&&e.target.id==='cpop'&&e.newState==='closed')pending=null;
  },true);
  document.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('[data-cpop]');
    if(b){
      var yes=b.getAttribute('data-cpop')==='yes';
      var d=pending;pending=null;
      var p=pop();if(p&&p.hidePopover)p.hidePopover();
      if(yes&&d)d.issueRequest(true);
      return;
    }
    var c=e.target.closest&&e.target.closest('[data-copy-text]');
    if(!c)return;
    if(navigator.clipboard)navigator.clipboard.writeText(c.getAttribute('data-copy-text'));
    c.classList.remove('copied');void c.offsetWidth;c.classList.add('copied');
    setTimeout(function(){c.classList.remove('copied');},900);
  });
})();`;

const APP_SCRIPT_HASH =
  "sha256-" + crypto.createHash("sha256").update(APP_SCRIPT).digest("base64");

// htmx, pinned to a Subresource Integrity hash so the browser rejects any
// tampered CDN response.
const HTMX_SRC = "https://cdn.jsdelivr.net/npm/htmx.org@2.0.3/dist/htmx.min.js";
const HTMX_SRI = "sha384-0895/pl2MU10Hqc6jd4RvrthNlDiE9U1tWmX7WRESftEDRosgxNsQG/Ze9YMRzHq";

const CSP = [
  "default-src 'self'",
  `script-src 'self' '${APP_SCRIPT_HASH}' https://cdn.jsdelivr.net`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

// --- layout ------------------------------------------------------------------

function topBar(user?: AuthUser | null): string {
  if (!user) return "";
  return `<div class="top">
    <a class="brand" href="/dashboard">waka</a>
    <div class="top-right">
      <span>${esc(user.email)}</span>
      <form class="inline-form" method="post" action="/logout" hx-confirm="Sign out?">
        <button type="submit" class="signout">sign out</button>
      </form>
    </div>
  </div>`;
}

function layout(title: string, body: string, user?: AuthUser | null): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · waka</title>
<script src="${HTMX_SRC}" integrity="${HTMX_SRI}" crossorigin="anonymous"></script>
<style>${STYLE}</style>
<script>${APP_SCRIPT}</script>
</head><body hx-boost="true"><div class="wrap">${topBar(user)}${body}</div>
<div id="cpop" popover class="cpop" aria-labelledby="cpop-q">
  <p id="cpop-q" class="cpop-q"></p>
  <div class="cpop-actions">
    <button type="button" class="btn-text" data-cpop="no">cancel</button>
    <button type="button" class="btn btn-xs" data-cpop="yes" autofocus>confirm</button>
  </div>
</div></body></html>`;
}

function alert(kind: "ok" | "err" | "mut", message: string): string {
  return `<div class="alert ${kind}">${esc(message)}</div>`;
}

function emptyState(title: string, desc: string): string {
  return `<div class="empty"><div class="empty-t">${esc(title)}</div><div>${esc(desc)}</div></div>`;
}

function crumbs(parts: Array<{ label: string; href?: string }>): string {
  return `<div class="crumbs">${parts
    .map((p, i) =>
      `${i ? '<span class="sep">/</span>' : ""}${p.href ? `<a href="${p.href}">${esc(p.label)}</a>` : esc(p.label)}`
    )
    .join("")}</div>`;
}

// --- auth pages --------------------------------------------------------------

export function loginPage(req: Req): Response {
  if (sessionUser(req)) return seeOther("/dashboard");
  return html(layout("Sign in", loginView()));
}

function loginView(error = ""): string {
  return `<div class="login">
    <h1>waka</h1>
    <p class="lede">self-hosted transactional email</p>
    ${error ? alert("err", error) : ""}
    <form method="post" action="/login">
      <label><span>email</span><input name="email" type="email" required autofocus autocomplete="email" placeholder="you@example.com"></label>
      <label><span>password</span><input name="password" type="password" required autocomplete="current-password" placeholder="••••••••"></label>
      <button type="submit" class="btn" style="width:100%">sign in</button>
    </form>
  </div>`;
}

export async function doLogin(req: Req): Promise<Response> {
  const form = await req.formData();
  const user = await authenticateUser(
    String(form.get("email") ?? ""),
    String(form.get("password") ?? "")
  );
  if (!user) return html(layout("Sign in", loginView("Invalid email or password.")));
  return seeOther("/dashboard", { "Set-Cookie": sessionCookie(generateJWT(user)) });
}

export function logout(): Response {
  return seeOther("/login", { "Set-Cookie": clearSessionCookie() });
}

export function home(req: Req): Response {
  return seeOther(sessionUser(req) ? "/dashboard" : "/login");
}

// --- domains list ------------------------------------------------------------

interface DnsRecord { type: string; name: string; value: string; ttl?: number; description?: string }
interface DomainRow { id: string; domain: string; status: string; created_at?: string }

// Email-log status: keep the word (delivered / bounced / sent …), color-coded.
function statusTag(status: string): string {
  return `<span class="st-${esc(status)}">${esc(status)}</span>`;
}

// Domain verification: a dot. Hover/SR reads "verified" or "not verified".
function verifyDot(status: string): string {
  const ok = status === "verified";
  const label = ok ? "verified" : "not verified";
  const cls = ok ? "dot-ok" : status === "failed" ? "dot-failed" : "dot-pending";
  return `<span class="dot ${cls}" role="img" aria-label="${label}" title="${label}"></span>`;
}

function domainsView(domains: DomainRow[], flash = ""): string {
  const rows = domains
    .map(
      (d) => `<tr>
        <td>
          <a class="t-name" href="/ui/domains/${esc(d.id)}">${esc(d.domain)}</a>
          <span class="t-sub">added ${formatDate(d.created_at)}</span>
        </td>
        <td>${verifyDot(d.status)}</td>
        <td class="right">
          ${d.status !== "verified" ? actionForm(`/ui/domains/${esc(d.id)}/verify`, "verify", "act", `Check DNS for ${d.domain}?`) : ""}
          ${actionForm(`/ui/domains/${esc(d.id)}/delete`, "delete", "act danger", `Delete ${d.domain}? This removes its API keys too.`)}
        </td>
      </tr>`
    )
    .join("");
  return `<h1>domains</h1>
  <p class="lede">sending domains and their DNS records</p>
  ${flash}
  <form class="toolbar" method="post" action="/ui/domains" hx-confirm="Add this domain?">
    <input name="domain" placeholder="mail.example.com" required>
    <button type="submit" class="btn">add domain</button>
  </form>
  <table>
    <thead><tr><th>domain</th><th>status</th><th class="right">actions</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="3">${emptyState("No domains yet", "Add your first domain to start sending email.")}</td></tr>`}</tbody>
  </table>`;
}

function actionForm(action: string, label: string, cls: string, confirm: string): string {
  return `<form class="inline-form" method="post" action="${action}" hx-confirm="${esc(confirm)}"><button type="submit" class="${cls}">${esc(label)}</button></form>`;
}

export async function dashboard(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domains = await getUserDomains(user.id);
  return html(layout("domains", domainsView(domains as DomainRow[], flashFrom(req)), user));
}

// /ui/domains GET is an alias kept for old links; list lives at /dashboard.
export function uiDomains(): Response {
  return seeOther("/dashboard");
}

export async function uiAddDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = String((await req.formData()).get("domain") ?? "").trim();
  if (!domain) return seeOther("/dashboard?m=domain-required");
  try {
    const result = (await addDomain(user.id, domain)) as { domain: { id: string } };
    return seeOther(`/ui/domains/${result.domain.id}`);
  } catch (err) {
    console.error("add domain failed:", err);
    return seeOther("/dashboard?m=domain-failed");
  }
}

export async function uiDeleteDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  try {
    await deleteDomain(req.params.id, user.id);
  } catch (err) {
    console.error("delete domain failed:", err);
  }
  return seeOther("/dashboard?m=deleted");
}

export async function uiVerifyDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) return seeOther("/dashboard");
  const status = await checkDomainVerification(req.params.id);
  return seeOther(`/ui/domains/${domain.id}?m=${status === "verified" ? "verified" : "pending"}`);
}

// --- domain detail -----------------------------------------------------------

function detailTabs(domain: DomainRow, active: string): string {
  const tab = (id: string, label: string, href: string) =>
    `<a class="tab${id === active ? " active" : ""}" href="${href}">${label}</a>`;
  const base = `/ui/domains/${esc(domain.id)}`;
  return `<nav class="tabs">
    ${tab("overview", "overview", base)}
    ${tab("logs", "logs", `${base}/logs`)}
    ${tab("keys", "api keys", `${base}/keys`)}
  </nav>`;
}

function detailHead(domain: DomainRow, active: string): string {
  return `${crumbs([{ label: "domains", href: "/dashboard" }, { label: domain.domain }])}
    <h1>${esc(domain.domain)} ${verifyDot(domain.status)}</h1>
    ${detailTabs(domain, active)}`;
}

function dnsTable(records: DnsRecord[]): string {
  const rows = records
    .map(
      (r) => `<tr><td><code>${esc(r.type)}</code></td><td>${copyBtn(r.name, "Copy name")}<code>${esc(r.name)}</code></td><td>${copyBtn(r.value, "Copy value")}<code>${esc(r.value)}</code></td></tr>`
    )
    .join("");
  return `<table><thead><tr><th>type</th><th>name</th><th>value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function domainOverview(
  domain: DomainRow & { dns_records?: DnsRecord[]; mail_from_domain?: string | null },
  flash = ""
): string {
  const dns: DnsRecord[] = Array.isArray(domain.dns_records) ? domain.dns_records : [];
  const dnsBlock = dns.length
    ? `<div class="block">
        <div class="block-title">DNS records</div>
        ${dnsTable(dns)}
        <div class="dl-row">
          <span class="note">Add these at your DNS provider, then verify.</span>
          <a class="btn btn-quiet btn-sm" href="/ui/domains/${esc(domain.id)}/dns.zone" download="${esc(domain.domain)}.txt" hx-boost="false">export to cloudflare</a>
        </div>
      </div>`
    : "";
  const mailFrom = domain.mail_from_domain ?? "";
  const mailFromBlock = `<div class="block">
      <div class="block-title">return-path domain (optional)</div>
      <p class="note" style="margin-bottom:12px">Aligns SPF for DMARC. Use a subdomain like <code>bounce.${esc(domain.domain)}</code>, or leave blank for the SES default.</p>
      <form class="toolbar" method="post" action="/ui/domains/${esc(domain.id)}/mailfrom" hx-confirm="Update return-path domain?">
        <input name="mailFrom" placeholder="bounce.${esc(domain.domain)}" value="${esc(mailFrom)}">
        <button type="submit" class="btn btn-sm">save</button>
      </form>
    </div>`;
  return `${flash}${dnsBlock}${mailFromBlock}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
      ${domain.status !== "verified" ? actionForm(`/ui/domains/${esc(domain.id)}/verify`, "check DNS", "btn btn-quiet btn-sm", `Check DNS for ${domain.domain}?`) : ""}
      ${actionForm(`/ui/domains/${esc(domain.id)}/delete`, "delete domain", "btn btn-danger btn-sm", `Delete ${domain.domain}? This removes its API keys too.`)}
    </div>
    ${domain.status === "verified" ? alert("ok", "Domain is verified and ready to send.") : alert("mut", "Add the DNS records above, then click check DNS.")}`;
}

export async function uiDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return html(layout("Not found", `${crumbs([{ label: "domains", href: "/dashboard" }])}${alert("err", "Domain not found.")}`, user), { status: 404 });
  }
  const body = detailHead(domain as DomainRow, "overview") +
    domainOverview(domain as DomainRow & { dns_records?: DnsRecord[]; mail_from_domain?: string | null }, flashFrom(req));
  return html(layout(domain.domain, body, user));
}

export async function uiSetMailFrom(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const mailFrom = String((await req.formData()).get("mailFrom") ?? "");
  try {
    await updateMailFromDomain(req.params.id, user.id, mailFrom);
  } catch (err) {
    console.error("set return-path failed:", err);
    return seeOther(`/ui/domains/${req.params.id}?m=mailfrom-failed`);
  }
  return seeOther(`/ui/domains/${req.params.id}?m=mailfrom-saved`);
}

export async function uiDomainDns(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return new Response("Domain not found", { status: 404 });
  }
  const records: DnsRecord[] = Array.isArray(domain.dns_records) ? (domain.dns_records as DnsRecord[]) : [];
  return new Response(zoneFile(domain.domain, records), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${domain.domain}.txt"`,
    },
  });
}

// BIND zone file for Cloudflare's "Import DNS records" (DNS > Records > Import).
function zoneFile(domain: string, records: DnsRecord[]): string {
  const fqdn = (name: string) => (name.endsWith(".") ? name : `${name}.`);
  const txt = (value: string) =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const lines: string[] = [
    `; waka — DNS records for ${domain}`,
    `; Cloudflare import: dashboard > DNS > Records > Import (BIND zone file)`,
    `;`,
  ];
  for (const r of records) {
    if (r.description) lines.push(`; ${r.description}`);
    const name = fqdn(r.name);
    const ttl = r.ttl ?? 300;
    const type = r.type.toUpperCase();
    let rdata = r.value;
    if (type === "TXT") rdata = txt(r.value);
    else if (type === "CNAME") rdata = fqdn(r.value);
    // MX value already carries "<priority> <exchange.>"
    lines.push(`${name}\t${ttl}\tIN\t${type}\t${rdata}`);
  }
  return lines.join("\n") + "\n";
}

// --- logs --------------------------------------------------------------------

async function getDomainEmailLogs(userId: string, domainId: string) {
  const result = await query(
    `SELECT el.id, el.from_email, el.to_emails, el.subject, el.status, el.created_at
     FROM email_logs el JOIN domains d ON el.domain_id = d.id
     WHERE d.user_id = $1 AND el.domain_id = $2
     ORDER BY el.created_at DESC LIMIT 50`,
    [userId, domainId]
  );
  return result.rows.map((r) => {
    let to: string[] = [];
    try {
      to = typeof r.to_emails === "string" ? JSON.parse(r.to_emails) : r.to_emails ?? [];
    } catch {
      to = [];
    }
    return {
      ...r,
      to_emails: to,
      created_at: new Date(r.created_at).toISOString().replace("T", " ").slice(0, 16),
    };
  });
}

function domainLogsView(logs: Array<{ id: string; from_email: string; to_emails: string[]; subject: string; status: string; created_at: string }>): string {
  const rows = logs
    .map(
      (r) => `<tr>
        <td class="t-mut">${esc(r.created_at)}</td>
        <td>${esc(r.from_email)}</td>
        <td class="t-mut">${esc(r.to_emails.join(", "))}</td>
        <td>${esc(r.subject)}</td>
        <td>${statusTag(r.status)}</td>
      </tr>`
    )
    .join("");
  return `<table class="logs">
    <thead><tr><th>when</th><th>from</th><th>to</th><th>subject</th><th>status</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5">${emptyState("No emails yet", "Emails sent through this domain appear here.")}</td></tr>`}</tbody>
  </table>`;
}

export async function uiDomainLogs(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return html(layout("Not found", `${crumbs([{ label: "domains", href: "/dashboard" }])}${alert("err", "Domain not found.")}`, user), { status: 404 });
  }
  const logs = await getDomainEmailLogs(user.id, domain.id);
  const body = `${crumbs([{ label: "domains", href: "/dashboard" }, { label: domain.domain, href: `/ui/domains/${esc(domain.id)}` }, { label: "logs" }])}
    <h1>${esc(domain.domain)} ${verifyDot(domain.status)}</h1>
    ${detailTabs(domain as DomainRow, "logs")}
    ${domainLogsView(logs)}`;
  return html(layout(`${domain.domain} logs`, body, user));
}

// --- api keys ----------------------------------------------------------------

function domainKeysView(
  domain: DomainRow,
  keys: Array<{ id: string; key_name: string; key_prefix: string; permissions: string[]; created_at?: string }>,
  banner = ""
): string {
  const rows = keys
    .map(
      (k) => `<tr>
        <td class="t-name">${esc(k.key_name)}</td>
        <td><code>${esc(k.key_prefix)}…</code></td>
        <td class="t-mut">${esc((k.permissions ?? []).join(", "))}</td>
        <td class="t-mut">${formatDate(k.created_at)}</td>
        <td class="right">${actionForm(`/ui/domains/${esc(domain.id)}/keys/${esc(k.id)}/delete`, "revoke", "act danger", `Revoke ${k.key_name}? Apps using it stop working.`)}</td>
      </tr>`
    )
    .join("");
  const form =
    domain.status === "verified"
      ? `<form class="toolbar" method="post" action="/ui/domains/${esc(domain.id)}/keys" hx-confirm="Create a new API key?">
          <input name="keyName" placeholder="key name" required>
          <button type="submit" class="btn">create key</button>
        </form>`
      : alert("mut", "Verify the domain before creating API keys.");
  return `${banner}${form}
  <table>
    <thead><tr><th>name</th><th>prefix</th><th>permissions</th><th>created</th><th class="right">actions</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5">${emptyState("No API keys yet", "Create a key to send email from this domain.")}</td></tr>`}</tbody>
  </table>`;
}

function keysBody(domain: DomainRow, keys: unknown, banner = ""): string {
  return `${crumbs([{ label: "domains", href: "/dashboard" }, { label: domain.domain, href: `/ui/domains/${esc(domain.id)}` }, { label: "api keys" }])}
    <h1>${esc(domain.domain)} ${verifyDot(domain.status)}</h1>
    ${detailTabs(domain, "keys")}
    ${domainKeysView(domain, keys as never, banner)}`;
}

export async function uiDomainKeys(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return html(layout("Not found", `${crumbs([{ label: "domains", href: "/dashboard" }])}${alert("err", "Domain not found.")}`, user), { status: 404 });
  }
  const keys = await getDomainApiKeys(domain.id);
  return html(layout(`${domain.domain} keys`, keysBody(domain as DomainRow, keys, flashFrom(req)), user));
}

export async function uiCreateDomainKey(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return html(layout("Not found", `${crumbs([{ label: "domains", href: "/dashboard" }])}${alert("err", "Domain not found.")}`, user), { status: 404 });
  }
  const keyName = String((await req.formData()).get("keyName") ?? "").trim();
  let banner = "";
  try {
    if (domain.status !== "verified") banner = alert("err", "Domain must be verified first.");
    else if (!keyName) banner = alert("err", "Key name is required.");
    else {
      const created = (await generateApiKey(user.id, domain.id, keyName)) as { key: string };
      banner = `<div class="block">
        <div class="block-title">Copy this key now — it is not shown again</div>
        <div class="keyout">${copyBtn(created.key, "Copy API key")}<code>${esc(created.key)}</code></div>
      </div>`;
    }
  } catch (err) {
    banner = alert("err", err instanceof Error ? err.message : "Failed to create key.");
  }
  const keys = await getDomainApiKeys(domain.id);
  return html(layout(`${domain.domain} keys`, keysBody(domain as DomainRow, keys, banner), user));
}

export async function uiDeleteDomainKey(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) return seeOther("/dashboard");
  try {
    await deleteApiKey(req.params.keyId, user.id);
  } catch (err) {
    console.error("delete key failed:", err);
  }
  return seeOther(`/ui/domains/${domain.id}/keys?m=revoked`);
}

import crypto from "crypto";
import { z } from "zod";
import {
  sessionUser,
  sessionCookie,
  clearSessionCookie,
  createCsrfToken,
  csrfCookie,
  clearCsrfCookie,
  getCsrfToken,
  isValidCsrfToken,
  pathUuid,
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
import { getDomainApiKeys, generateApiKey, deleteApiKey, updateApiKey } from "@/lib/api-keys";
import { sendEmail } from "@/lib/ses";
import { query } from "@/lib/database";
import { buildEmailLogsWhere, normalizeLogsFilters, toRangeEnd, toRangeStart, type EmailLogsFilters } from "@/lib/email-logs";
import { checkRateLimit, requestAddress } from "@/lib/rate-limit";
import { reserveDailySend } from "@/lib/quotas";
import { isEmailAddress } from "@/lib/email";
import { DOC_TOPICS, findDocTopic } from "./docs";

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
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      ...(init.headers ?? {}),
    },
  });
}

function seeOther(location: string, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Location", location);
  return new Response("", { status: 303, headers });
}

function renderPage(
  req: Req,
  title: string,
  body: string,
  user?: AuthUser | null,
  init: ResponseInit = {},
): Response {
  const existingToken = getCsrfToken(req);
  const csrf = existingToken ?? createCsrfToken();
  const response = html(layout(title, body, user, csrf), init);
  if (!existingToken) response.headers.append("Set-Cookie", csrfCookie(csrf));
  return response;
}

async function csrfForm(req: Request): Promise<FormData | null> {
  const form = await req.formData();
  return isValidCsrfToken(req, form.get("csrf")) ? form : null;
}

function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
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
  const copiedLabel = label.replace(/^copy\s+/i, "").toLowerCase();
  return `<button type="button" class="cbtn" data-copy-text="${esc(text)}" data-copy-label="${esc(copiedLabel)}" aria-label="${esc(label)}">${COPY_ICON}<span>${esc(label.toLowerCase())}</span></button>`;
}

function formatDate(value: unknown): string {
  if (!value) return "—";
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Predefined flash messages, keyed so query strings can never inject markup.
const FLASH: Record<string, { kind: "ok" | "err" | "mut"; text: string }> = {
  deleted: { kind: "ok", text: "Domain deleted. Its API keys and email activity were deleted too." },
  "domain-delete-failed": { kind: "err", text: "We could not delete that domain. Nothing was changed; try again." },
  verified: { kind: "ok", text: "Domain verified. You can now create an API key or send a test email." },
  pending: { kind: "mut", text: "DNS records are not verified yet. Check each value and try again after DNS updates appear." },
  failed: { kind: "err", text: "DNS verification needs attention. Check each record and try again." },
  revoked: { kind: "ok", text: "API key revoked. Apps using it can no longer send email." },
  "revoke-failed": { kind: "err", text: "We could not revoke that API key. Nothing was changed; try again." },
  "expiry-saved": { kind: "ok", text: "Expiry date saved." },
  "expiry-failed": { kind: "err", text: "Could not save the expiry date. Try again." },
  "expiry-invalid": { kind: "err", text: "Enter a date as YYYY-MM-DD." },
  "test-recipient": { kind: "err", text: "Enter a valid recipient email address and try again." },
  "test-failed": { kind: "err", text: "The test email was not sent. Check the recipient address and try again." },
  "test-config": { kind: "err", text: "The email service cannot send this message yet. Ask the administrator to check the sending settings." },
  "test-pending": { kind: "mut", text: "Verify this domain before sending a test email." },
  "test-log-failed": { kind: "mut", text: "The test email was accepted, but its activity could not be recorded. Ask the administrator to check the database." },
  "test-sent": { kind: "ok", text: "Test email accepted. Delivery updates appear in email activity." },
  "test-rate-limited": { kind: "err", text: "Too many test emails. Wait a moment and try again." },
  "test-daily-limited": { kind: "err", text: "Daily sending limit reached. Try again tomorrow." },
  "verify-failed": { kind: "err", text: "We could not check DNS right now. Try again in a moment." },
  "domain-required": { kind: "err", text: "Enter a domain such as example.com." },
  "domain-invalid": { kind: "err", text: "That does not look like a domain. Enter a name such as example.com and try again." },
  "domain-owned": { kind: "err", text: "That domain is already connected to another account." },
  "domain-failed": { kind: "err", text: "We could not add that domain. Check the name and try again." },
  "mailfrom-saved": { kind: "ok", text: "Return address saved. Add the new DNS records shown below, then check DNS." },
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
.section-lede{color:var(--muted);font-size:13px;margin-bottom:16px}

/* tabs */
.tabs{display:flex;gap:20px;margin:22px 0 28px;border-bottom:1px solid var(--faint-2);padding-bottom:10px;overflow-x:auto}
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
.btn[aria-busy="true"],.act[aria-busy="true"]{cursor:wait}

/* toolbar */
.toolbar{display:flex;gap:10px;align-items:flex-end;margin-bottom:28px}
.toolbar input{flex:1}
.toolbar label{flex:1;margin:0}
.toolbar .btn{white-space:nowrap}

/* tables — no borders, spacing + hover only */
table{width:100%;border-collapse:collapse}
.table-wrap{overflow-x:auto}
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
.status-badge{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:700;white-space:nowrap}
.status-mark{display:inline-block;width:8px;height:8px;border-radius:50%;background:currentColor}
.status-verified,.status-delivered{color:var(--ok)}
.status-pending,.status-sent{color:var(--warn)}
.status-failed,.status-bounced,.status-complained{color:var(--danger)}
.status-unknown{color:var(--muted)}

/* alerts */
.alert{padding:11px 14px;border-radius:6px;margin-bottom:20px;font-size:13px}
.alert.ok{color:var(--ok);background:var(--faint)}
.alert.err{color:var(--danger);background:var(--faint)}
.alert.mut{color:var(--muted);background:var(--faint)}

/* setup, dns, and key blocks */
.block{background:var(--faint);border-radius:8px;padding:20px;margin-bottom:24px}
.block-title{font-weight:700;font-size:15px;margin-bottom:8px}
.block code{word-break:break-all;color:var(--fg)}
.dns-records{display:grid;gap:12px}
.dns-record{background:var(--bg);border-radius:7px;padding:14px}
.dns-record-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}
.dns-record-head strong{font-size:13px}
.dns-record-head span{color:var(--muted);font-size:12px}
.copy-field{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:10px;align-items:start;padding:7px 0;border-top:1px solid var(--faint-2)}
.copy-field:first-of-type{border-top:0}
.copy-label{color:var(--muted);font-size:12px;padding-top:5px}
.copy-value{min-width:0;overflow-wrap:anywhere;padding-top:5px}
.copy-field .cbtn{margin:0}
.block-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:18px}
.note{color:var(--muted);font-size:12px}
.keyout{display:flex;gap:12px;align-items:flex-start;margin-top:12px}
.keyout code{flex:1;background:var(--bg);border-radius:6px;padding:10px 12px;word-break:break-all}
.key-warning{color:var(--muted);font-size:13px;line-height:1.5}

/* docs */
.doc-item{display:block;padding:14px 2px;border-top:1px solid var(--faint-2)}
.doc-item:hover{text-decoration:none}
.doc-t{display:block;font-weight:700;color:var(--fg)}
.doc-item:hover .doc-t{color:var(--accent)}
.doc-d{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.doc h2{font-size:15px;font-weight:700;margin:34px 0 10px}
.doc h2:first-child{margin-top:0}
.doc p{margin-bottom:14px}
.doc ul{margin:0 0 18px 18px;padding:0}
.doc li{margin-bottom:6px}
.doc pre{background:var(--faint);border-radius:8px;padding:14px 16px;margin-bottom:18px;overflow-x:auto;font-size:12.5px}
.doc .table-wrap{margin-bottom:20px}
.doc td{font-size:12.5px}
.doc p code,.doc li code,.doc td code{background:var(--faint);border-radius:4px;padding:1px 5px;overflow-wrap:anywhere}
.doc pre code{background:none;padding:0}
.doc-next{display:flex;justify-content:space-between;gap:16px;margin-top:40px;padding-top:16px;border-top:1px solid var(--faint-2);font-size:13px}

/* empty */
.empty{color:var(--muted);padding:48px 12px;text-align:center}
.empty .empty-t{color:var(--fg);font-weight:700;margin-bottom:4px}
.empty .btn{margin-top:16px}

/* next step and verification state */
.state{border-radius:8px;padding:16px 18px;margin-bottom:24px;border-left:4px solid var(--muted);background:var(--faint)}
.state.pending{border-color:var(--warn)}
.state.verified{border-color:var(--ok)}
.state.failed{border-color:var(--danger)}
.state-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
.state-title{font-weight:700}
.state p{color:var(--muted);font-size:13px}
.state-next{margin-top:8px;color:var(--fg)!important}
.state-next strong{color:var(--muted)}
/* login */
.login{min-height:64vh;display:flex;flex-direction:column;justify-content:center;max-width:340px;margin:0 auto}
.login h1{margin-bottom:4px}
.login .lede{margin-bottom:26px}

/* copy feedback */
.copy-status{position:fixed;z-index:60;left:50%;bottom:18px;transform:translateX(-50%);padding:9px 13px;border-radius:6px;background:var(--fg);color:var(--bg);font-size:12px;opacity:0;pointer-events:none;transition:opacity .15s ease}
.copy-status:not(:empty){opacity:1}
.copy-status.error{background:var(--danger);color:#fff}
@media(prefers-reduced-motion:reduce){.copy-status{transition:none}}

/* copy button (the one icon in the app) */
.cbtn{display:inline-flex;align-items:center;gap:5px;height:30px;padding:4px 8px;vertical-align:middle;background:none;border:0;border-radius:4px;color:var(--muted);cursor:pointer;font-size:12px}
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
@media (max-width:700px){
  .wrap{padding:32px 16px 64px}
  .toolbar{display:block}
  .toolbar label{margin-bottom:12px}
  .toolbar .btn{width:100%}
  .block-actions{display:block}
  .block-actions .btn{margin-top:12px}
  .copy-field{grid-template-columns:64px minmax(0,1fr);gap:8px}
  .copy-field .cbtn{grid-column:2;justify-self:start}
  .keyout{display:block}
  .keyout .cbtn{margin-bottom:8px}
  .keyout code{display:block}
}
@media (max-width:560px){.btn,.signout{min-height:44px}.top{align-items:flex-start}.top-right{align-items:flex-end;flex-direction:column;gap:2px}.state-head{align-items:flex-start;flex-direction:column}}
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
  function copyStatus(message,error){
    var s=document.getElementById('copy-status');
    if(!s)return;
    s.textContent=message;
    s.className=error?'copy-status error':'copy-status';
    window.clearTimeout(s._timer);
    s._timer=window.setTimeout(function(){s.textContent='';s.className='copy-status';},2400);
  }
  function restoreButton(form){
    var b=form&&form.querySelector('button[type="submit"]');
    if(!b)return;
    if(b.dataset.originalText)b.textContent=b.dataset.originalText;
    b.disabled=false;b.removeAttribute('aria-busy');
  }
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
  document.addEventListener('htmx:beforeRequest',function(e){
    var f=e.detail&&e.detail.elt;
    if(!f||f.tagName!=='FORM')return;
    var b=f.querySelector('button[type="submit"]');
    if(!b)return;
    b.dataset.originalText=b.textContent;
    b.textContent=b.getAttribute('data-loading-label')||'working...';
    b.disabled=true;b.setAttribute('aria-busy','true');
  });
  document.addEventListener('htmx:afterRequest',function(e){
    if(e.detail&&!e.detail.successful)restoreButton(e.detail.elt);
  });
  document.addEventListener('htmx:sendError',function(e){
    restoreButton(e.detail&&e.detail.elt);
    copyStatus('The request could not reach the server. Check your connection and try again.',true);
  });
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
    var value=c.getAttribute('data-copy-text')||'';
    var label=c.getAttribute('data-copy-label')||'value';
    if(!navigator.clipboard||typeof navigator.clipboard.writeText!=='function'){
      copyStatus('Copy is not available. Select the value and copy it instead.',true);
      return;
    }
    navigator.clipboard.writeText(value).then(function(){
      c.classList.remove('copied');void c.offsetWidth;c.classList.add('copied');
      copyStatus('Copied '+label+'.',false);
      setTimeout(function(){c.classList.remove('copied');},900);
    },function(){copyStatus('Could not copy. Select the value and copy it instead.',true);});
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

function topBar(user: AuthUser | null | undefined): string {
  if (!user) return "";
  return `<div class="top">
    <a class="brand" href="/dashboard">Waka</a>
    <div class="top-right">
      <a href="/ui/docs">docs</a>
      <span>${esc(user.email)}</span>
      <form class="inline-form" method="post" action="/logout" hx-confirm="Sign out?">
        <button type="submit" class="signout">sign out</button>
      </form>
    </div>
  </div>`;
}

function layout(title: string, body: string, user?: AuthUser | null, csrf = ""): string {
  const pageBody = `${topBar(user)}${body}`;
  const protectedBody = csrf
    ? pageBody.replace(
        /<form\b(?=[^>]*\bmethod\s*=\s*["']post["'])[^>]*>/gi,
        (openingForm) => `${openingForm}<input type="hidden" name="csrf" value="${esc(csrf)}">`,
      )
    : pageBody;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Waka</title>
<script src="${HTMX_SRC}" integrity="${HTMX_SRI}" crossorigin="anonymous"></script>
<style>${STYLE}</style>
<script>${APP_SCRIPT}</script>
</head><body hx-boost="true"><div class="wrap">${protectedBody}</div>
<div id="cpop" popover class="cpop" aria-labelledby="cpop-q">
  <p id="cpop-q" class="cpop-q"></p>
  <div class="cpop-actions">
    <button type="button" class="btn-text" data-cpop="no">cancel</button>
    <button type="button" class="btn btn-xs" data-cpop="yes" autofocus>confirm</button>
  </div>
</div><div id="copy-status" class="copy-status" role="status" aria-live="polite"></div></body></html>`;
}

function alert(kind: "ok" | "err" | "mut", message: string): string {
  return `<div class="alert ${kind}" role="${kind === "err" ? "alert" : "status"}">${esc(message)}</div>`;
}

function userError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (/valid domain/i.test(message)) return message;
  if (/return-path must/i.test(message)) return message.replace(/^Return-path/i, "Return address");
  if (/already registered|already in use|duplicate|unique/i.test(message)) {
    return "That name is already in use. Choose a different name and try again.";
  }
  if (/accessdenied|permission|credentials|not authorized/i.test(message)) {
    return "The email service is not configured for this action. Ask the administrator to check its permissions.";
  }
  if (/not found|don't have access/i.test(message)) {
    return "We could not find that item. Refresh the page and try again.";
  }
  return fallback;
}

function domainAddFlash(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/valid domain/i.test(message)) return "domain-invalid";
  if (/already registered|another account/i.test(message)) return "domain-owned";
  return "domain-failed";
}

function testEmailFlash(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /sandbox|not verified|not authorized|accessdenied|credentials|permission/i.test(message)
    ? "test-config"
    : "test-failed";
}

function emptyState(title: string, desc: string): string {
  return `<div class="empty"><div class="empty-t">${esc(title)}</div><div>${esc(desc)}</div></div>`;
}

function problemPage(req: Req, title: string, message: string, user: AuthUser, status = 503): Response {
  const body = `${crumbs([{ label: "domains", href: "/dashboard" }])}<h1>${esc(title)}</h1>${alert("err", message)}`;
  return renderPage(req, title, body, user, { status });
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
  return renderPage(req, "Sign in", loginView());
}

function loginView(error = ""): string {
  return `<div class="login">
    <h1>Waka</h1>
    <p class="lede">Send email from your own domain.</p>
    ${error ? alert("err", error) : ""}
    <form method="post" action="/login">
      <label><span>Email address</span><input name="email" type="email" required autofocus autocomplete="email" placeholder="you@example.com"></label>
      <label><span>Password</span><input name="password" type="password" required autocomplete="current-password" placeholder="Your password"></label>
      <button type="submit" class="btn" style="width:100%" data-loading-label="signing in...">sign in</button>
    </form>
  </div>`;
}

export async function doLogin(req: Req): Promise<Response> {
  const form = await csrfForm(req);
  if (!form) return forbidden();
  const parsed = z.object({
    email: z.string().email().max(255),
    password: z.string().min(1).max(200).refine(
      (value) => Buffer.byteLength(value, "utf8") <= 72,
      "Password is too long",
    ),
  }).safeParse({
    email: String(form.get("email") ?? "").trim().toLowerCase(),
    password: String(form.get("password") ?? ""),
  });
  if (!parsed.success) {
    return renderPage(req, "Sign in", loginView("Invalid email or password."), null, { status: 400 });
  }
  const ipRate = await checkRateLimit(`auth:login:${requestAddress(req)}`, 10, 60_000);
  const emailRate = await checkRateLimit(`auth:login:${parsed.data.email}`, 10, 60_000);
  if (!ipRate.allowed || !emailRate.allowed) {
    return renderPage(req, "Sign in", loginView("Try again later."), null, { status: 429 });
  }
  const { email, password } = parsed.data;
  let user: AuthUser | null;
  try {
    user = await authenticateUser(email, password);
  } catch {
    return renderPage(req, "Sign in", loginView("Sign in is temporarily unavailable. Try again in a moment."), null, { status: 503 });
  }
  if (!user) return renderPage(req, "Sign in", loginView("Invalid email or password."));
  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie(generateJWT(user)));
  headers.append("Set-Cookie", csrfCookie(createCsrfToken()));
  return seeOther("/dashboard", headers);
}

export async function logout(req: Req): Promise<Response> {
  if (!(await csrfForm(req))) return forbidden();
  const response = seeOther("/login");
  response.headers.append("Set-Cookie", clearSessionCookie());
  response.headers.append("Set-Cookie", clearCsrfCookie());
  return response;
}

export function home(req: Req): Response {
  return seeOther(sessionUser(req) ? "/dashboard" : "/login");
}

// --- domains list ------------------------------------------------------------

interface DnsRecord { type: string; name: string; value: string; ttl?: number; description?: string }
interface DomainRow { id: string; domain: string; status: string; created_at?: string }
type DomainKeys = Awaited<ReturnType<typeof getDomainApiKeys>>;

// Email activity status uses words and color together.
function statusTag(status: string): string {
  const known = ["delivered", "sent", "failed", "bounced", "complained", "pending", "scheduled", "sending"];
  const tone = known.includes(status) ? status : "unknown";
  const labels: Record<string, string> = {
    delivered: "delivered",
    sent: "accepted",
    failed: "failed",
    bounced: "not delivered",
    complained: "spam complaint",
    pending: "processing",
    scheduled: "scheduled",
    sending: "processing",
  };
  const label = labels[status] ?? "unknown";
  return `<span class="status-badge status-${tone}"><span class="status-mark" aria-hidden="true"></span>${esc(label)}</span>`;
}

function verificationStatus(status: string): { label: string; tone: "verified" | "pending" | "failed" } {
  if (status === "verified") return { label: "verified", tone: "verified" };
  if (status === "failed") return { label: "needs attention", tone: "failed" };
  return { label: "waiting for DNS", tone: "pending" };
}

function verifyStatusTag(status: string): string {
  const state = verificationStatus(status);
  return `<span class="status-badge status-${state.tone}"><span class="status-mark" aria-hidden="true"></span>${state.label}</span>`;
}

function domainsView(domains: DomainRow[], flash = ""): string {
  const rows = domains
    .map(
      (d) => `<tr>
        <td>
          <a class="t-name" href="/ui/domains/${esc(d.id)}">${esc(d.domain)}</a>
          <span class="t-sub">added ${formatDate(d.created_at)}</span>
        </td>
        <td>${verifyStatusTag(d.status)}</td>
        <td class="right">
          ${d.status !== "verified" ? actionForm(`/ui/domains/${esc(d.id)}/verify`, "check DNS", "act", `Check whether DNS is ready for ${d.domain}.`) : `<a class="act" href="/ui/domains/${esc(d.id)}/keys">create key</a>`}
          ${actionForm(`/ui/domains/${esc(d.id)}/delete`, "delete", "act danger", `Delete ${d.domain}? This also deletes its API keys and email activity.`)}
        </td>
      </tr>`
    )
    .join("");
  return `<h1>domains</h1>
  <p class="lede">Add a domain, publish its DNS records, then send email.</p>
  ${flash}
  <form class="toolbar" method="post" action="/ui/domains" hx-confirm="Add this domain so you can publish its DNS records?">
    <label><span>Domain to send from</span><input name="domain" type="text" inputmode="url" autocomplete="url" placeholder="example.com" required></label>
    <button type="submit" class="btn" data-loading-label="adding...">add domain</button>
  </form>
  <div class="table-wrap"><table>
    <thead><tr><th>domain</th><th>status</th><th class="right">next step</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="3">${emptyState("No sending domains yet", "Add your first domain to get the DNS records needed to send email.")}</td></tr>`}</tbody>
  </table></div>`;
}

function actionForm(action: string, label: string, cls: string, confirm: string): string {
  const loadingLabel = label === "delete" || label === "delete domain" ? "deleting..." : label === "revoke" ? "revoking..." : "checking...";
  return `<form class="inline-form" method="post" action="${action}" hx-confirm="${esc(confirm)}"><button type="submit" class="${cls}" data-loading-label="${loadingLabel}">${esc(label)}</button></form>`;
}

export async function dashboard(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  let domains: Awaited<ReturnType<typeof getUserDomains>>;
  try {
    domains = await getUserDomains(user.id);
  } catch (err) {
    console.error("load domains failed:", err);
    return problemPage(req, "Domains", "We could not load your domains. Refresh the page and try again.", user);
  }
  return renderPage(req, "domains", domainsView(domains, flashFrom(req)), user);
}

// /ui/domains GET is an alias kept for old links; list lives at /dashboard.
export function uiDomains(): Response {
  return seeOther("/dashboard");
}

export async function uiAddDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const form = await csrfForm(req);
  if (!form) return forbidden();
  const domain = String(form.get("domain") ?? "").trim();
  if (!domain) return seeOther("/dashboard?m=domain-required");
  try {
    const result = await addDomain(user.id, domain);
    return seeOther(`/ui/domains/${result.domain.id}`);
  } catch (err) {
    console.error("add domain failed:", err);
    return seeOther(`/dashboard?m=${domainAddFlash(err)}`);
  }
}

export async function uiDeleteDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  if (!(await csrfForm(req))) return forbidden();
  const domainId = pathUuid(req);
  try {
    await deleteDomain(domainId, user.id);
  } catch (err) {
    console.error("delete domain failed:", err);
    return seeOther("/dashboard?m=domain-delete-failed");
  }
  return seeOther("/dashboard?m=deleted");
}

export async function uiVerifyDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  if (!(await csrfForm(req))) return forbidden();
  const domainId = pathUuid(req);
  const domain = await getDomainById(domainId, user.id);
  if (!domain) return seeOther("/dashboard");
  let status: string;
  try {
    status = await checkDomainVerification(domainId, user.id);
  } catch (err) {
    console.error("verify domain failed:", err);
    return seeOther(`/ui/domains/${domain.id}?m=verify-failed`);
  }
  return seeOther(`/ui/domains/${domain.id}?m=${status === "verified" ? "verified" : status === "failed" ? "failed" : "pending"}`);
}

// --- domain detail -----------------------------------------------------------

function detailTabs(domain: DomainRow, active: string): string {
  const tab = (id: string, label: string, href: string) =>
    `<a class="tab${id === active ? " active" : ""}" href="${href}"${id === active ? ' aria-current="page"' : ""}>${label}</a>`;
  const base = `/ui/domains/${esc(domain.id)}`;
  return `<nav class="tabs">
    ${tab("overview", "overview", base)}
    ${tab("logs", "email activity", `${base}/logs`)}
    ${tab("keys", "api keys", `${base}/keys`)}
  </nav>`;
}

function detailHead(domain: DomainRow, active: string): string {
  return `${crumbs([{ label: "domains", href: "/dashboard" }, { label: domain.domain }])}
    <h1>${esc(domain.domain)}</h1>
    ${detailTabs(domain, active)}`;
}

function dnsTable(records: DnsRecord[]): string {
  const rows = records
    .map(
      (r) => `<div class="dns-record">
        <div class="dns-record-head"><strong>${esc(r.type)} record</strong><span>${esc(dnsPurpose(r))}</span></div>
        <div class="copy-field"><span class="copy-label">type</span><code class="copy-value">${esc(r.type)}</code>${copyBtn(r.type, "Copy type")}</div>
        <div class="copy-field"><span class="copy-label">name</span><code class="copy-value">${esc(r.name)}</code>${copyBtn(r.name, "Copy name")}</div>
        <div class="copy-field"><span class="copy-label">value</span><code class="copy-value">${esc(r.value)}</code>${copyBtn(r.value, "Copy value")}</div>
        ${r.ttl ? `<div class="copy-field"><span class="copy-label">TTL</span><code class="copy-value">${r.ttl}</code>${copyBtn(String(r.ttl), "Copy TTL")}</div>` : ""}
      </div>`
    )
    .join("");
  return `<div class="dns-records">${rows}</div>`;
}

function dnsPurpose(record: DnsRecord): string {
  if (record.name.startsWith("_amazonses.")) return "Proves you own this domain";
  if (record.name.startsWith("_dmarc.")) return "Tells inboxes how to handle unauthenticated email";
  if (record.name.includes("._domainkey.")) return "Signs outgoing email";
  if (record.type === "MX" && record.value.includes("inbound-smtp")) return "Routes email";
  if (record.type === "MX") return "Handles delivery feedback";
  if (record.type === "TXT" && record.value.startsWith("v=spf1")) return "Lists approved email senders";
  return "Email setup";
}

function domainState(domain: DomainRow): string {
  if (domain.status === "verified") {
    return `<div class="state verified" role="status">
      <div class="state-head"><span class="state-title">Domain verified</span>${verifyStatusTag(domain.status)}</div>
      <p>This domain is ready to send email.</p>
      <p class="state-next"><strong>Next:</strong> <a class="next-link" href="/ui/domains/${esc(domain.id)}/keys">create an API key</a>, then use it to send email.</p>
    </div>`;
  }
  if (domain.status === "failed") {
    return `<div class="state failed" role="status">
      <div class="state-head"><span class="state-title">DNS verification needs attention</span>${verifyStatusTag(domain.status)}</div>
      <p>At least one DNS record does not match. Compare the records below with your DNS provider, correct any differences, and check again.</p>
      <p class="state-next"><strong>Next:</strong> update DNS, wait for it to publish, then click "check DNS".</p>
    </div>`;
  }
  return `<div class="state pending" role="status">
    <div class="state-head"><span class="state-title">Waiting for DNS records</span>${verifyStatusTag(domain.status)}</div>
    <p>Your domain is not ready yet. DNS changes can take a few minutes to appear.</p>
      <p class="state-next"><strong>Next:</strong> add every record below at the company that manages your domain, then click "check DNS".</p>
  </div>`;
}

function domainOverview(
  domain: DomainRow & { dns_records?: DnsRecord[]; mail_from_domain?: string | null },
  flash = ""
): string {
  const dns: DnsRecord[] = Array.isArray(domain.dns_records) ? domain.dns_records : [];
  const dnsBlock = dns.length
    ? `<div class="block">
        <div class="block-title">Add these DNS records</div>
        <p class="section-lede">Open your domain provider's DNS settings. Add each record exactly as shown. Use the copy buttons to avoid typing mistakes.</p>
        ${dnsTable(dns)}
        <div class="block-actions">
          <span class="note">If your provider adds the domain name automatically, enter only the name before it.</span>
          <a class="btn btn-quiet btn-sm" href="/ui/domains/${esc(domain.id)}/dns.zone" download="${esc(domain.domain)}.txt" hx-boost="false">download records</a>
        </div>
      </div>`
    : `<div class="alert err">DNS records are not available yet. <a href="/ui/domains/${esc(domain.id)}">Refresh this page</a> or return to the domains list and open the domain again.</div>`;
  const mailFrom = domain.mail_from_domain ?? "";
  const mailFromBlock = `<div class="block">
      <div class="block-title">Optional return address</div>
      <p class="note" style="display:block;margin-bottom:12px">Use a subdomain such as <code>bounce.${esc(domain.domain)}</code> if you want your email's return address to use this domain. Leave it blank to use the default.</p>
      <form class="toolbar" method="post" action="/ui/domains/${esc(domain.id)}/mailfrom" hx-confirm="Save this return address domain?">
        <label><span>Return address domain</span><input name="mailFrom" type="text" inputmode="url" placeholder="bounce.${esc(domain.domain)}" value="${esc(mailFrom)}"></label>
        <button type="submit" class="btn btn-sm" data-loading-label="saving...">save return address</button>
      </form>
    </div>`;
  return `${flash}${domainState(domain)}${dnsBlock}${mailFromBlock}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px">
      ${domain.status !== "verified" ? actionForm(`/ui/domains/${esc(domain.id)}/verify`, "check DNS", "btn btn-quiet btn-sm", `Check whether DNS is ready for ${domain.domain}.`) : ""}
      ${actionForm(`/ui/domains/${esc(domain.id)}/delete`, "delete domain", "btn btn-danger btn-sm", `Delete ${domain.domain}? This also deletes its API keys and email activity.`)}
    </div>
    <p class="note">Deleting a domain cannot be undone.</p>`;
}

export async function uiDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(pathUuid(req), user.id);
  if (!domain) {
    return renderPage(req, "Not found", `${crumbs([{ label: "domains", href: "/dashboard" }])}${alert("err", "Domain not found.")}`, user, { status: 404 });
  }
  const body = detailHead(domain, "overview") +
    domainOverview(domain, flashFrom(req));
  return renderPage(req, domain.domain, body, user);
}

export async function uiSetMailFrom(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domainId = pathUuid(req);
  const form = await csrfForm(req);
  if (!form) return forbidden();
  const mailFrom = String(form.get("mailFrom") ?? "");
  try {
    await updateMailFromDomain(domainId, user.id, mailFrom);
  } catch (err) {
    console.error("set return-path failed:", err);
    const domain = await getDomainById(domainId, user.id);
    if (!domain) return seeOther("/dashboard");
    const msg = userError(err, "Could not save the return address. Check the domain and try again.");
    const body = detailHead(domain, "overview") +
      domainOverview(domain, alert("err", msg));
    return renderPage(req, domain.domain, body, user, { status: 400 });
  }
  return seeOther(`/ui/domains/${domainId}?m=mailfrom-saved`);
}

export async function uiDomainDns(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(pathUuid(req), user.id);
  if (!domain) {
    return new Response("This domain was not found. Return to the domains list and try again.", { status: 404 });
  }
  const records: DnsRecord[] = domain.dns_records;
  const filename = domain.domain.replace(/[^A-Za-z0-9.-]/g, "_");
  return new Response(zoneFile(domain.domain, records), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.txt"`,
    },
  });
}

// BIND zone file for DNS providers that support record import.
function zoneFile(domain: string, records: DnsRecord[]): string {
  const fqdn = (name: string) => (name.endsWith(".") ? name : `${name}.`);
  const txt = (value: string) =>
    `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const lines: string[] = [
    `; Waka DNS records for ${domain}`,
    `; Import these records into your DNS provider's BIND zone file importer`,
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
    // MX value already carries its priority and exchange.
    lines.push(`${name}\t${ttl}\tIN\t${type}\t${rdata}`);
  }
  return lines.join("\n") + "\n";
}

// --- logs --------------------------------------------------------------------

async function getDomainEmailLogs(userId: string, domainId: string, filters: EmailLogsFilters) {
  const where = buildEmailLogsWhere(
    {
      ...filters,
      domainId: null,
      fromDate: filters.fromDate ? toRangeStart(filters.fromDate) : null,
      toDate: filters.toDate ? toRangeEnd(filters.toDate) : null,
    },
    3,
  );
  const whereSql = where.clauses.length ? `AND ${where.clauses.join(" AND ")}` : "";
  const result = await query(
    `SELECT el.id, el.from_email, el.to_emails, el.subject, el.status, el.created_at,
            COUNT(ev.*) FILTER (WHERE ev.type = 'open')  AS open_count,
            COUNT(ev.*) FILTER (WHERE ev.type = 'click') AS click_count
     FROM email_logs el
     JOIN domains d ON el.domain_id = d.id
     LEFT JOIN email_events ev ON ev.email_log_id = el.id
     WHERE d.user_id = $1 AND el.domain_id = $2
       ${whereSql}
     GROUP BY el.id
     ORDER BY el.created_at DESC LIMIT 50`,
    [userId, domainId, ...where.params]
  );
  return result.rows.map((r) => {
    let to: string[] = [];
    try {
      const value = typeof r.to_emails === "string" ? JSON.parse(r.to_emails) : r.to_emails;
      to = Array.isArray(value) ? value.map(String) : [];
    } catch {
      to = [];
    }
    return {
      ...r,
      to_emails: to,
      open_count: Number(r.open_count ?? 0),
      click_count: Number(r.click_count ?? 0),
      created_at: new Date(r.created_at).toISOString().replace("T", " ").slice(0, 16),
    };
  });
}

const LOG_STATUS_LABELS: Record<string, string> = {
  "": "Any status",
  sent: "Accepted",
  delivered: "Delivered",
  bounced: "Not delivered",
  complained: "Spam complaint",
  failed: "Failed",
  pending: "Processing",
};

function domainLogsFilterForm(domainId: string, filters: EmailLogsFilters): string {
  const statusOptions = Object.keys(LOG_STATUS_LABELS)
    .map((value) => `<option value="${esc(value)}"${(filters.status ?? "") === value ? " selected" : ""}>${esc(LOG_STATUS_LABELS[value])}</option>`)
    .join("");
  return `<form method="get" action="/ui/domains/${esc(domainId)}/logs" class="block" style="display:grid;gap:12px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <label><span>Who received it</span><input name="recipient" type="text" placeholder="recipient@example.com" value="${esc(filters.recipient ?? "")}"></label>
      <label><span>Subject contains</span><input name="subject" type="text" placeholder="Welcome" value="${esc(filters.subject ?? "")}"></label>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <label><span>Sent on or after</span><input name="from" type="date" value="${esc(filters.fromDate?.slice(0, 10) ?? "")}"></label>
      <label><span>Sent on or before</span><input name="to" type="date" value="${esc(filters.toDate?.slice(0, 10) ?? "")}"></label>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <label><span>Message ID</span><input name="message_id" type="text" placeholder="message or provider id" value="${esc(filters.messageId ?? "")}"></label>
      <label><span>Delivery status</span><select name="status" style="width:100%;font:inherit;color:var(--fg);background:var(--faint);border:0;border-radius:6px;padding:10px 12px">${statusOptions}</select></label>
    </div>
    <div style="display:flex;gap:8px">
      <button type="submit" class="btn btn-sm">Search messages</button>
      <a class="btn btn-quiet btn-sm" href="/ui/domains/${esc(domainId)}/logs">Clear</a>
    </div>
  </form>`;
}

function domainLogsView(logs: Array<{ id: string; from_email: string; to_emails: string[]; subject: string; status: string; created_at: string; open_count?: number; click_count?: number }>, filtered: boolean): string {
  const count = (n?: number) => (n && n > 0 ? `<span class="t-name">${n}</span>` : `<span class="t-mut">—</span>`);
  const rows = logs
    .map(
      (r) => `<tr>
        <td class="t-mut">${esc(r.created_at)}</td>
        <td>${esc(r.from_email)}</td>
        <td class="t-mut">${esc(r.to_emails.join(", "))}</td>
        <td>${esc(r.subject)}</td>
        <td>${statusTag(r.status)}</td>
        <td class="right">${count(r.open_count)}</td>
        <td class="right">${count(r.click_count)}</td>
      </tr>`
    )
    .join("");
  return `<table class="logs">
    <thead><tr><th>when</th><th>from</th><th>to</th><th>subject</th><th>status</th><th class="right">opens</th><th class="right">clicks</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7">${filtered
      ? emptyState("No messages match your search", "Change the filters or clear them to see all messages.")
      : emptyState("No email activity yet", "Create an API key, send a test email from API keys, and activity will appear here.")}</td></tr>`}</tbody>
  </table>`;
}

export async function uiDomainLogs(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(pathUuid(req), user.id);
  if (!domain) {
    return renderPage(req, "Not found", `${crumbs([{ label: "domains", href: "/dashboard" }])}${alert("err", "Domain not found.")}`, user, { status: 404 });
  }
  const filters = normalizeLogsFilters(Object.fromEntries(new URL(req.url).searchParams));
  const filtered = Object.values(filters).some((value) => value !== null);
  const header = `${crumbs([{ label: "domains", href: "/dashboard" }, { label: domain.domain, href: `/ui/domains/${esc(domain.id)}` }, { label: "email activity" }])}
    <h1>Email activity</h1>
    <p class="lede">Messages sent from ${esc(domain.domain)} and the delivery updates we receive.</p>
    <p class="section-lede">Domain status: ${verifyStatusTag(domain.status)}</p>`;
  const invalidDate =
    (filters.fromDate && isNaN(Date.parse(filters.fromDate)) && "Enter a start date as YYYY-MM-DD.") ||
    (filters.toDate && isNaN(Date.parse(filters.toDate)) && "Enter an end date as YYYY-MM-DD.");
  if (invalidDate) {
    const body = `${header}${alert("err", invalidDate)}${detailTabs(domain, "logs")}${domainLogsFilterForm(domain.id, filters)}`;
    return renderPage(req, `${domain.domain} logs`, body, user, { status: 400 });
  }
  let logs: Awaited<ReturnType<typeof getDomainEmailLogs>>;
  try {
    logs = await getDomainEmailLogs(user.id, domain.id, filters);
  } catch (err) {
    console.error("load email activity failed:", err);
    return problemPage(req, "Email activity", "We could not load email activity. Refresh the page and try again.", user);
  }
  const body = `${header}
    ${flashFrom(req)}
    ${detailTabs(domain, "logs")}
    ${domainLogsFilterForm(domain.id, filters)}
    <div class="table-wrap">${domainLogsView(logs, filtered)}</div>`;
  return renderPage(req, `${domain.domain} logs`, body, user);
}

// --- api keys ----------------------------------------------------------------

function expiryCell(value: string | null): string {
  if (!value) return `<span class="t-mut">never</span>`;
  const d = new Date(value);
  if (isNaN(d.getTime())) return `<span class="t-mut">never</span>`;
  const expired = d.getTime() <= Date.now();
  return expired
    ? `<span class="status-badge status-failed"><span class="status-mark" aria-hidden="true"></span>expired ${esc(formatDate(value))}</span>`
    : esc(formatDate(value));
}

function domainKeysView(
  domain: DomainRow,
  keys: DomainKeys,
  banner = ""
): string {
  const rows = keys
    .map((k) => {
      const limits: string[] = [];
      if (k.rate_limit_per_minute != null) limits.push(`${k.rate_limit_per_minute}/min`);
      if (k.daily_send_limit != null) limits.push(`${k.daily_send_limit}/day`);
      const limitLabel = limits.length ? limits.join(" · ") : "—";
      return `<tr>
        <td class="t-name">${esc(k.key_name)}</td>
        <td><code>${esc(k.key_prefix)}…</code></td>
        <td class="t-mut">${esc((k.permissions ?? []).map((permission) => permission === "send" ? "send email" : permission).join(", ") || "—")}</td>
        <td class="t-mut">${esc(limitLabel)}</td>
        <td class="t-mut">${expiryCell(k.expires_at)}</td>
        <td class="t-mut">${formatDate(k.created_at)}</td>
        <td class="right" style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
          <form class="inline-form" method="post" action="/ui/domains/${esc(domain.id)}/keys/${esc(k.id)}/expiry" style="display:flex;gap:4px;align-items:center">
            <input type="date" name="expiresAt" value="${k.expires_at ? new Date(k.expires_at).toISOString().slice(0, 10) : ""}" aria-label="Expiry date for ${esc(k.key_name)}" style="width:150px;padding:6px 8px;font-size:12px">
            <button type="submit" class="act" data-loading-label="saving...">save expiry</button>
          </form>
          ${actionForm(`/ui/domains/${esc(domain.id)}/keys/${esc(k.id)}/delete`, "revoke", "act danger", `Revoke ${k.key_name}? Apps using it stop working.`)}
        </td>
      </tr>`;
    })
    .join("");
  const form =
    domain.status === "verified"
       ? `<form class="toolbar" method="post" action="/ui/domains/${esc(domain.id)}/keys" hx-confirm="Create an API key for this domain?">
           <label><span>Key name</span><input name="keyName" placeholder="local development" required></label>
           <label><span>Per-minute limit</span><input name="rateLimitPerMinute" type="number" min="1" max="1000000" placeholder="60"></label>
           <label><span>Daily limit</span><input name="dailySendLimit" type="number" min="1" max="1000000" placeholder="1000"></label>
           <label><span>Expires (optional)</span><input type="date" name="expiresAt" aria-label="Expiry date"></label>
           <button type="submit" class="btn" data-loading-label="creating...">create API key</button>
         </form>`
       : alert("mut", "Verify this domain first. The API key form will appear here when it is ready.");
  const testEmail = domain.status === "verified" && keys.length > 0 ? `<div class="block test-email">
      <div class="block-title">Send a test email</div>
      <p class="note">Use your verified domain to send a simple message to your inbox. You can track it in email activity.</p>
      <form class="toolbar" method="post" action="/ui/domains/${esc(domain.id)}/keys">
        <label><span>Recipient email</span><input name="to" type="email" autocomplete="email" placeholder="you@example.com" required></label>
        <button type="submit" class="btn" data-loading-label="sending...">send test email</button>
      </form>
    </div>` : "";
  return `${banner}${form}
  ${testEmail}
  <div class="table-wrap"><table>
    <thead><tr><th>name</th><th>key starts with</th><th>access</th><th>limits</th><th>expires</th><th>created</th><th class="right">actions</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7">${emptyState("No API keys yet", domain.status === "verified" ? "Create your first key to send email from this domain." : "Verify this domain before creating an API key.")}</td></tr>`}</tbody>
  </table></div>`;
}

async function sendTestEmail(req: Req, domain: DomainRow, recipient: string, user: AuthUser): Promise<Response> {
  if (!isEmailAddress(recipient)) {
    return seeOther(`/ui/domains/${domain.id}?m=test-recipient`);
  }
  if (domain.status !== "verified") return seeOther(`/ui/domains/${domain.id}?m=test-pending`);

  const ipRate = await checkRateLimit(`send-ip:${requestAddress(req)}`, 20, 60_000);
  const userRate = await checkRateLimit(`send:${user.id}`, 60, 60_000);
  if (!ipRate.allowed || !userRate.allowed) {
    return seeOther(`/ui/domains/${domain.id}?m=test-rate-limited`);
  }
  if (!(await reserveDailySend(user.id))) {
    return seeOther(`/ui/domains/${domain.id}?m=test-daily-limited`);
  }

  const from = `test@${domain.domain}`;
  const subject = `Test email from ${domain.domain}`;
  const text = `This test confirms that ${domain.domain} can send email.`;
  let messageId: string;
  try {
    messageId = await sendEmail({ from, to: [recipient], subject, text });
  } catch (err) {
    console.error("test email failed:", err);
    return seeOther(`/ui/domains/${domain.id}?m=${testEmailFlash(err)}`);
  }

  try {
    await query(
      `INSERT INTO email_logs (
        domain_id, from_email, to_emails, cc_emails, bcc_emails,
        subject, text_content, attachments, status, ses_message_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        domain.id,
        from,
        JSON.stringify([recipient]),
        JSON.stringify([]),
        JSON.stringify([]),
        subject,
        text,
        JSON.stringify([]),
        "sent",
        messageId,
      ]
    );
  } catch (err) {
    console.error("test email log failed:", err);
    return seeOther(`/ui/domains/${domain.id}/logs?m=test-log-failed`);
  }

  return seeOther(`/ui/domains/${domain.id}/logs?m=test-sent`);
}

function keysBody(domain: DomainRow, keys: DomainKeys, banner = ""): string {
  return `${crumbs([{ label: "domains", href: "/dashboard" }, { label: domain.domain, href: `/ui/domains/${esc(domain.id)}` }, { label: "api keys" }])}
    <h1>API keys</h1>
    <p class="lede">Keys let your app send email from ${esc(domain.domain)}. Keep them private.</p>
    <p class="section-lede">Domain status: ${verifyStatusTag(domain.status)}</p>
    ${detailTabs(domain, "keys")}
    ${domainKeysView(domain, keys, banner)}`;
}

export async function uiDomainKeys(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(pathUuid(req), user.id);
  if (!domain) {
    return renderPage(req, "Not found", `${crumbs([{ label: "domains", href: "/dashboard" }])}${alert("err", "Domain not found.")}`, user, { status: 404 });
  }
  let keys: DomainKeys;
  try {
    keys = await getDomainApiKeys(domain.id, user.id);
  } catch (err) {
    console.error("load API keys failed:", err);
    return problemPage(req, "API keys", "We could not load your API keys. Refresh the page and try again.", user);
  }
  return renderPage(req, `${domain.domain} keys`, keysBody(domain, keys, flashFrom(req)), user);
}

export async function uiCreateDomainKey(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(pathUuid(req), user.id);
  if (!domain) {
    return renderPage(req, "Not found", `${crumbs([{ label: "domains", href: "/dashboard" }])}${alert("err", "Domain not found.")}`, user, { status: 404 });
  }
  const form = await csrfForm(req);
  if (!form) return forbidden();
  if (form.has("to")) {
    return sendTestEmail(req as Req, domain, String(form.get("to") ?? "").trim(), user);
  }
  const keyName = String(form.get("keyName") ?? "").trim().slice(0, 255);
  const expiresAtRaw = String(form.get("expiresAt") ?? "").trim();
  const expiresAtDate = expiresAtRaw ? new Date(expiresAtRaw) : null;
  if (expiresAtDate && isNaN(expiresAtDate.getTime())) {
    let keys: DomainKeys;
    try { keys = await getDomainApiKeys(domain.id, user.id); } catch { keys = []; }
    return renderPage(req, `${domain.domain} keys`, keysBody(domain, keys, alert("err", "Enter a date as YYYY-MM-DD.")), user, { status: 400 });
  }
  const expiresAt = expiresAtDate ? expiresAtDate.toISOString() : null;
  const parseLimit = (v: FormDataEntryValue | null): number | null => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new Error("invalid limit");
    return n;
  };
  let rateLimitPerMinute: number | null = null;
  let dailySendLimit: number | null = null;
  try {
    rateLimitPerMinute = parseLimit(form.get("rateLimitPerMinute"));
    dailySendLimit = parseLimit(form.get("dailySendLimit"));
  } catch {
    let keys: DomainKeys;
    try {
      keys = await getDomainApiKeys(domain.id, user.id);
    } catch {
      keys = [] as unknown as DomainKeys;
    }
    return renderPage(req as Req, `${domain.domain} keys`, keysBody(domain, keys, alert("err", "Limits must be positive whole numbers." )), user, { status: 400 });
  }
  let banner = "";
  try {
    if (domain.status !== "verified") banner = alert("err", "Domain must be verified first.");
    else if (!keyName) banner = alert("err", "Key name is required.");
    else {
      const created = await generateApiKey(user.id, domain.id, keyName, ["send"], { expiresAt, rateLimitPerMinute, dailySendLimit });
      banner = `<div class="block" role="status">
        <div class="block-title">Your API key is ready</div>
        <p class="key-warning">Copy it now. For your security, this full key will not be shown again.</p>
        <div class="keyout">${copyBtn(created.key, "Copy API key")}<code>${esc(created.key)}</code></div>
      </div>`;
    }
  } catch (err) {
    banner = alert("err", userError(err, "We could not create the API key. Check the name and try again."));
  }
  let keys: DomainKeys;
  try {
    keys = await getDomainApiKeys(domain.id, user.id);
  } catch (err) {
    console.error("load API keys failed:", err);
    const message = "We could not reload the key list. Save the key above, then refresh the page.";
    return renderPage(req, `${domain.domain} keys`, keysBody(domain, [], `${banner}${alert("err", message)}`), user, { status: 503 });
  }
  return renderPage(req, `${domain.domain} keys`, keysBody(domain, keys, banner), user);
}

export async function uiUpdateDomainKeyExpiry(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const form = await csrfForm(req);
  if (!form) return forbidden();
  const domain = await getDomainById(pathUuid(req), user.id);
  if (!domain) return seeOther("/dashboard");
  const raw = String(form.get("expiresAt") ?? "").trim();
  let expiresAt: string | null = null;
  if (raw) {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return seeOther(`/ui/domains/${domain.id}/keys?m=expiry-invalid`);
    expiresAt = d.toISOString();
  }
  try {
    await updateApiKey(pathUuid(req, "keyId"), user.id, { expiresAt });
  } catch (err) {
    console.error("update key expiry failed:", err);
    return seeOther(`/ui/domains/${domain.id}/keys?m=expiry-failed`);
  }
  return seeOther(`/ui/domains/${domain.id}/keys?m=expiry-saved`);
}

export async function uiDeleteDomainKey(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  if (!(await csrfForm(req))) return forbidden();
  const domain = await getDomainById(pathUuid(req), user.id);
  if (!domain) return seeOther("/dashboard");
  try {
    await deleteApiKey(pathUuid(req, "keyId"), user.id);
  } catch (err) {
    console.error("delete key failed:", err);
    return seeOther(`/ui/domains/${domain.id}/keys?m=revoke-failed`);
  }
  return seeOther(`/ui/domains/${domain.id}/keys?m=revoked`);
}

// --- docs --------------------------------------------------------------------

function docsCrumbs(page?: string): string {
  const home = { label: "domains", href: "/dashboard" };
  return crumbs(
    page
      ? [home, { label: "docs", href: "/ui/docs" }, { label: page }]
      : [home, { label: "docs" }],
  );
}

function docsIndexView(): string {
  const items = DOC_TOPICS.map(
    (topic) => `<a class="doc-item" href="/ui/docs/${topic.slug}">
      <span class="doc-t">${esc(topic.title)}</span>
      <span class="doc-d">${esc(topic.summary)}</span>
    </a>`
  ).join("");
  return `${docsCrumbs()}
    <h1>Docs</h1>
    <p class="lede">How to send email from your domains, and what every answer from the API means.</p>
    ${items}`;
}

export function uiDocs(req: Req): Response {
  const user = gate(req);
  if (user instanceof Response) return user;
  return renderPage(req, "docs", docsIndexView(), user);
}

export function uiDocsTopic(req: Req): Response {
  const user = gate(req);
  if (user instanceof Response) return user;
  const topic = findDocTopic(req.params.topic ?? "");
  if (!topic) {
    const body = `${docsCrumbs("not found")}${alert("err", "That page does not exist. Open the docs index and pick a topic.")}`;
    return renderPage(req, "Not found", body, user, { status: 404 });
  }
  const position = DOC_TOPICS.indexOf(topic);
  const previous = DOC_TOPICS[position - 1];
  const next = DOC_TOPICS[position + 1];
  const body = `${docsCrumbs(topic.title.toLowerCase())}
    <h1>${esc(topic.title)}</h1>
    <p class="lede">${esc(topic.summary)}</p>
    <div class="doc">${topic.body}</div>
    <div class="doc-next">
      ${previous ? `<a href="/ui/docs/${previous.slug}">back: ${esc(previous.title.toLowerCase())}</a>` : `<a href="/ui/docs">all topics</a>`}
      ${next ? `<a href="/ui/docs/${next.slug}">next: ${esc(next.title.toLowerCase())}</a>` : ""}
    </div>`;
  return renderPage(req, topic.title.toLowerCase(), body, user);
}

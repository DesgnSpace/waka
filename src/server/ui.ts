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

function redirectToLogin(req: Request): Response {
  if (req.headers.get("HX-Request")) {
    return new Response("", { status: 401, headers: { "HX-Redirect": "/login" } });
  }
  return new Response("", { status: 302, headers: { Location: "/login" } });
}

function gate(req: Request): AuthUser | Response {
  return sessionUser(req) ?? redirectToLogin(req);
}

function formatDate(value: unknown): string {
  if (!value) return "—";
  const d = new Date(value as string | number | Date);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// --- icons -------------------------------------------------------------------

const ICONS = {
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon"><polyline points="20 6 9 17 4 12"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15L19 4"/><path d="M18 5l2 2"/><path d="M15 8l2 2"/></svg>',
  document: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon-lg"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
};

// --- design tokens ----------------------------------------------------------

const STYLE = `
:root {
  color-scheme: light;
  --bg: #ffffff;
  --sidebar: #f8f9fb;
  --surface: #ffffff;
  --surface-2: #f4f5f7;
  --surface-3: #ebedf0;
  --surface-hover: #eef0f4;
  --fg: #111827;
  --fg-muted: #4b5563;
  --fg-subtle: #9ca3af;
  --border: rgba(0,0,0,0.06);
  --border-strong: rgba(0,0,0,0.12);
  --acc: #2563eb;
  --acc-bg: rgba(37,99,235,0.08);
  --acc-hover: rgba(37,99,235,0.12);
  --ok: #16a34a;
  --ok-bg: rgba(22,163,74,0.08);
  --warn: #d97706;
  --warn-bg: rgba(217,119,6,0.08);
  --err: #dc2626;
  --err-bg: rgba(220,38,38,0.08);
  --shadow: 0 1px 3px rgba(0,0,0,0.04);
  --ring: rgba(37,99,235,0.25);
}
.dark {
  color-scheme: dark;
  --bg: #050507;
  --sidebar: #0a0a0f;
  --surface: #101018;
  --surface-2: #161622;
  --surface-3: #1e1e2e;
  --surface-hover: #1e1e2e;
  --fg: #f0f1f5;
  --fg-muted: #9ca3af;
  --fg-subtle: #6b7280;
  --border: rgba(255,255,255,0.06);
  --border-strong: rgba(255,255,255,0.12);
  --acc: #6ea8fe;
  --acc-bg: rgba(110,168,254,0.1);
  --acc-hover: rgba(110,168,254,0.15);
  --ok: #3fb950;
  --ok-bg: rgba(63,185,80,0.1);
  --warn: #d29922;
  --warn-bg: rgba(210,153,34,0.1);
  --err: #f85149;
  --err-bg: rgba(248,81,73,0.1);
  --shadow: 0 1px 3px rgba(0,0,0,0.2);
  --ring: rgba(110,168,254,0.25);
}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline}
button{font-family:inherit}
.icon{width:16px;height:16px;flex-shrink:0}
.icon-lg{width:40px;height:40px;flex-shrink:0}

/* ---- layout ---- */
.app{display:grid;grid-template-columns:240px 1fr;min-height:100vh;background:var(--bg)}

/* ---- sidebar ---- */
.sidebar{background:var(--sidebar);display:flex;flex-direction:column;padding:0 12px;border-right:1px solid var(--border)}
.sidebar-header{padding:24px 8px 28px}
.brand{font-weight:700;font-size:17px;letter-spacing:-.02em;display:flex;align-items:center;gap:9px;color:var(--fg)}
.brand .icon{width:20px;height:20px;color:var(--acc)}
.brand-tag{display:block;color:var(--fg-subtle);font-size:11px;margin-top:3px;font-weight:400}
.sidebar-nav{flex:1;display:flex;flex-direction:column;gap:2px}
.nav-item{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:8px;color:var(--fg-muted);text-decoration:none;font-size:13px;font-weight:500;transition:background .15s,color .15s;cursor:pointer;border:1px solid transparent}
.nav-item .icon{width:18px;height:18px;color:var(--fg-muted);transition:color .15s}
.nav-item:hover{background:var(--surface-hover);color:var(--fg)}
.nav-item:hover .icon{color:var(--fg)}
.nav-item.active{background:var(--acc-bg);color:var(--acc);border-color:rgba(110,168,254,0.12)}
.nav-item.active .icon{color:var(--acc)}
.sidebar-footer{padding:14px 8px;margin-top:auto;border-top:1px solid var(--border)}
.user-email{display:block;font-size:12px;color:var(--fg-muted);margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.theme-toggle{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border-radius:6px;background:transparent;border:1px solid var(--border);color:var(--fg-muted);font-size:12px;font-weight:500;cursor:pointer;transition:background .15s,color .15s}
.theme-toggle:hover{background:var(--surface-hover);color:var(--fg)}
.theme-toggle .icon{width:14px;height:14px}
.logout-link{font-size:12px;color:var(--fg-subtle);margin-top:8px;display:inline-block}
.logout-link:hover{color:var(--err)}

/* ---- content ---- */
.content{background:var(--surface);display:flex;flex-direction:column;min-height:100vh}
.content-header{padding:32px 32px 0}
.content-header h1{font-size:24px;font-weight:600;margin:0;letter-spacing:-.03em}
.content-header p{color:var(--fg-muted);font-size:14px;margin-top:6px}
.content-body{padding:24px 32px 40px;flex:1;max-width:1100px}

/* ---- auth ---- */
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--sidebar);padding:20px}
.login-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;width:100%;max-width:380px;box-shadow:var(--shadow)}
.login-card h1{font-size:20px;margin:0 0 6px}
.login-card .subtitle{color:var(--fg-muted);font-size:14px;margin-bottom:24px}

/* ---- forms ---- */
label{display:block;margin:0 0 16px;color:var(--fg-muted);font-size:13px;font-weight:500}
input,select{width:100%;padding:9px 12px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;color:var(--fg);font:inherit;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s,background .15s}
input:focus,select:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--ring);background:var(--surface)}
input::placeholder{color:var(--fg-subtle)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 14px;background:var(--acc);color:#fff;border:0;border-radius:8px;font:inherit;font-weight:600;font-size:13px;cursor:pointer;transition:opacity .15s,transform .05s,background .15s;box-shadow:var(--shadow)}
.btn:active{transform:translateY(1px)}
.btn:hover{opacity:.9}
.btn .icon{width:14px;height:14px}
.btn-danger{background:var(--err-bg);color:var(--err)}
.btn-danger:hover{background:var(--err-bg);opacity:1;filter:brightness(.95)}
.btn-ghost{background:transparent;color:var(--fg-muted);border:1px solid var(--border);box-shadow:none}
.btn-ghost:hover{color:var(--fg);background:var(--surface-hover)}
.btn-secondary{background:var(--surface-2);color:var(--fg);border:1px solid var(--border);box-shadow:none}
.btn-secondary:hover{background:var(--surface-hover)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-sm{padding:6px 10px;font-size:12px}

/* ---- toolbar ---- */
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:24px}
.toolbar input,.toolbar select{flex:1;min-width:220px;max-width:320px;margin-top:0}
.toolbar .btn{white-space:nowrap}

/* ---- table ---- */
.table-wrap{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:14px 18px;font-size:13px}
th{color:var(--fg-muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;background:transparent;border-bottom:1px solid var(--border)}
td{border-top:1px solid var(--border);color:var(--fg)}
tr:hover td{background:var(--surface-hover)}
td:last-child{white-space:nowrap;text-align:right}
.cell-muted{color:var(--fg-muted)}
.cell-subtle{color:var(--fg-subtle);font-size:12px}

/* ---- badge ---- */
.badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:3px 9px;border-radius:999px;background:var(--surface-3);font-weight:600;border:1px solid var(--border)}
.badge .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.verified{color:var(--ok);background:var(--ok-bg);border-color:transparent}
.badge.pending{color:var(--warn);background:var(--warn-bg);border-color:transparent}
.badge.failed,.badge.bounced{color:var(--err);background:var(--err-bg);border-color:transparent}
.badge.info{color:var(--acc);background:var(--acc-bg);border-color:transparent}

/* ---- domain list ---- */
.domain-row td:first-child{padding-left:20px}
.domain-row td:last-child{padding-right:20px}
.domain-link{color:var(--fg);font-weight:600;font-size:14px;display:block}
.domain-link:hover{color:var(--acc);text-decoration:none}
.domain-meta{display:block;color:var(--fg-subtle);font-size:12px;margin-top:2px}

/* ---- domain detail ---- */
.domain-header{display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap}
.domain-header h1{font-size:24px}
.domain-actions{display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap}

/* ---- sub tabs ---- */
.sub-tabs{display:flex;gap:4px;margin-bottom:24px;border-bottom:1px solid var(--border)}
.sub-tab{display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:8px 8px 0 0;color:var(--fg-muted);font-size:13px;font-weight:500;text-decoration:none;background:transparent;transition:color .15s,background .15s;cursor:pointer;border:0;border-bottom:2px solid transparent;margin-bottom:-1px}
.sub-tab .icon{width:14px;height:14px}
.sub-tab:hover{color:var(--fg);background:var(--surface-hover)}
.sub-tab.active{color:var(--acc);border-bottom-color:var(--acc);background:var(--acc-bg)}
.domain-panel{flex:1}

/* ---- banner / alert ---- */
.banner{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:20px}
.banner-title{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-weight:600;font-size:13px;color:var(--fg)}
.banner-title .icon{width:16px;height:16px;color:var(--warn)}
.banner .table-wrap{margin-top:12px;background:var(--surface);border-color:var(--border-strong)}
.banner code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;word-break:break-all;color:var(--acc)}
.alert{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:10px;margin-bottom:16px;font-size:13px;border:1px solid var(--border)}
.alert .icon{width:16px;height:16px;flex-shrink:0;margin-top:1px}
.alert.ok{color:var(--ok);background:var(--ok-bg);border-color:transparent}
.alert.err{color:var(--err);background:var(--err-bg);border-color:transparent}
.alert.mut{color:var(--fg-muted);background:var(--surface-2)}

/* ---- empty state ---- */
.empty{text-align:center;padding:56px 24px;color:var(--fg-muted)}
.empty .icon-lg{color:var(--fg-subtle);margin-bottom:14px}
.empty-title{font-size:15px;font-weight:600;color:var(--fg);margin-bottom:4px}
.empty-desc{font-size:13px}

/* ---- code / key ---- */
.code-block{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;background:var(--bg);padding:12px;border-radius:8px;border:1px solid var(--border);word-break:break-all;color:var(--acc);display:flex;gap:10px;justify-content:space-between;align-items:flex-start}
.code-block button{flex-shrink:0;background:transparent;color:var(--fg-muted);padding:4px;border:0;border-radius:4px;cursor:pointer}
.code-block button:hover{color:var(--fg);background:var(--surface-hover)}
pre{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;white-space:pre-wrap;font-size:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;overflow:auto}

/* ---- misc ---- */
.err{color:var(--err)}.ok{color:var(--ok)}.mut{color:var(--fg-muted)}
.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.section-title h2{font-size:14px;font-weight:600;margin:0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* ---- htmx loading states ---- */
.htmx-request{opacity:.6;pointer-events:none}
`;

// All dashboard JS lives in this one inline block (theme toggle + copy button),
// wired via event delegation so there are no inline on* handlers. CSP allows it
// by its sha256 hash (APP_SCRIPT_HASH) — no 'unsafe-inline', no vendored files.
const APP_SCRIPT = `(function(){
  const root=document.documentElement;
  const saved=localStorage.getItem('waka-theme');
  const prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;
  if(saved==='dark'||(!saved&&prefersDark))root.classList.add('dark');
  function updateBtn(){
    const btn=document.getElementById('theme-toggle');
    if(!btn)return;
    const isDark=root.classList.contains('dark');
    btn.innerHTML=isDark?${JSON.stringify(`${ICONS.moon} Light`)}:${JSON.stringify(`${ICONS.sun} Dark`)};
    btn.setAttribute('aria-label',isDark?'Switch to light mode':'Switch to dark mode');
  }
  document.addEventListener('click',function(e){
    if(e.target.closest('#theme-toggle')){
      root.classList.toggle('dark');
      localStorage.setItem('waka-theme',root.classList.contains('dark')?'dark':'light');
      updateBtn();
      return;
    }
    const c=e.target.closest('[data-copy]');
    if(c){
      const code=c.parentElement&&c.parentElement.querySelector('code');
      if(!code)return;
      navigator.clipboard.writeText(code.innerText).then(function(){
        const o=c.innerHTML; c.textContent='Copied'; setTimeout(function(){c.innerHTML=o;},1500);
      });
    }
  });
  document.addEventListener('DOMContentLoaded',updateBtn);
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

// --- sidebar nav -------------------------------------------------------------

const NAV_ITEMS = [
  { id: "domains", label: "Domains", path: "/ui/domains" },
] as const;

function navItems(active: string): string {
  return NAV_ITEMS.map(
    (item) =>
      `<a class="nav-item${item.id === active ? " active" : ""}" href="${item.path}" hx-get="${item.path}" hx-target="#content-area">${ICONS.globe}<span>${item.label}</span></a>`
  ).join("");
}

// --- layout ------------------------------------------------------------------

function layout(title: string, body: string, user?: AuthUser | null): string {
  const inner = user
    ? `<div class="app">
        <aside class="sidebar">
          <div class="sidebar-header">
            <div class="brand">${ICONS.zap}waka</div>
            <div class="brand-tag">self-hosted email API</div>
          </div>
          <nav id="sidebar-nav" class="sidebar-nav">${navItems("domains")}</nav>
          <div class="sidebar-footer">
            <span class="user-email">${esc(user.email)}</span>
            <button id="theme-toggle" type="button" class="theme-toggle">${ICONS.sun} Theme</button>
            <a href="/logout" class="logout-link">Sign out</a>
          </div>
        </aside>
        <main id="content-area" class="content">${body}</main>
      </div>`
    : `<div class="login-wrap">${body}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · waka</title>
<script src="${HTMX_SRC}" integrity="${HTMX_SRI}" crossorigin="anonymous"></script>
<style>${STYLE}</style>
<script>${APP_SCRIPT}</script>
</head><body>${inner}</body></html>`;
}

function contentFragment(section: string, title: string, body: string, subtitle?: string): string {
  return `<div id="content-area" class="content">
    <header class="content-header"><h1>${title}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</header>
    <div class="content-body">${body}</div>
  </div>
  <nav id="sidebar-nav" class="sidebar-nav" hx-swap-oob="true">${navItems(section)}</nav>`;
}

// --- auth pages --------------------------------------------------------------

export function loginPage(req: Req): Response {
  if (sessionUser(req)) return new Response("", { status: 302, headers: { Location: "/dashboard" } });
  return html(
    layout("Sign in",
      `<div class="login-card"><h1>Sign in to waka</h1><p class="subtitle">Self-hosted transactional email API</p>
      <form hx-post="/login" hx-target="#msg" hx-swap="innerHTML">
        <label>Email<input name="email" type="email" required autofocus placeholder="you@example.com"></label>
        <label>Password<input name="password" type="password" required placeholder="••••••••"></label>
        <button type="submit" class="btn" style="width:100%">${ICONS.zap}Sign in</button>
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

// --- dashboard ---------------------------------------------------------------

export async function dashboard(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domains = await getUserDomains(user.id);
  return html(layout("Domains", contentFragment("domains", "Domains", domainsView(domains), "Manage sending domains and their DNS records."), user));
}

// --- domains -----------------------------------------------------------------

interface DnsRecord { type: string; name: string; value: string }
interface DomainRow { id: string; domain: string; status: string; created_at?: string }

function emptyState(icon: string, title: string, desc: string): string {
  return `<div class="empty">${icon}<div class="empty-title">${title}</div><div class="empty-desc">${desc}</div></div>`;
}

function domainsView(domains: DomainRow[], banner = ""): string {
  const rows = domains
    .map(
      (d) => `<tr class="domain-row"><td>
        <a class="domain-link" href="/ui/domains/${esc(d.id)}" hx-get="/ui/domains/${esc(d.id)}" hx-target="#content-area">${esc(d.domain)}</a>
        <span class="domain-meta">Added ${formatDate(d.created_at)}</span>
      </td>
      <td><span class="badge ${esc(d.status)}">${statusDot(d.status)}${esc(d.status)}</span></td>
      <td>
        <div style="display:flex;gap:6px;justify-content:flex-end">
          ${d.status !== "verified" ? `<button class="btn btn-ghost btn-sm" hx-post="/ui/domains/${esc(d.id)}/verify" hx-target="#content-area">${ICONS.check}Verify</button>` : ""}
          <button class="btn btn-ghost btn-sm" hx-post="/ui/domains/${esc(d.id)}/delete" hx-target="#content-area" hx-confirm="Delete ${esc(d.domain)}?">${ICONS.trash}Delete</button>
        </div>
      </td></tr>`
    )
    .join("");
  return `${banner}
  <div class="toolbar">
    <input name="domain" form="add-domain" placeholder="mail.example.com" required>
    <form id="add-domain" hx-post="/ui/domains" hx-target="#content-area" class="row" style="display:none"></form>
    <button form="add-domain" type="submit" class="btn">${ICONS.globe}Add domain</button>
  </div>
  <div class="table-wrap">
    <table><thead><tr><th>Domain</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>
    ${rows || `<tr><td colspan="3">${emptyState(ICONS.empty, "No domains yet", "Add your first domain to start sending email.")}</td></tr>`}</tbody></table>
  </div>`;
}

function statusDot(status: string): string {
  const color = status === "verified" ? "var(--ok)" : status === "pending" ? "var(--warn)" : "var(--err)";
  return `<span class="dot" style="background:${color}"></span>`;
}

function dnsBanner(records: DnsRecord[]): string {
  if (!records?.length) return "";
  const rows = records
    .map((r) => `<tr><td><code>${esc(r.type)}</code></td><td><code>${esc(r.name)}</code></td><td><code>${esc(r.value)}</code></td></tr>`)
    .join("");
  return `<div class="banner">
    <div class="banner-title">${ICONS.alert}DNS records required</div>
    <div class="table-wrap"><table><thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}

export async function uiDomains(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domains = await getUserDomains(user.id);
  return html(contentFragment("domains", "Domains", domainsView(domains), "Manage sending domains and their DNS records."));
}

export async function uiAddDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = String((await req.formData()).get("domain") ?? "").trim();
  if (!domain) return html(contentFragment("domains", "Domains", domainsView(await getUserDomains(user.id), alert("err", "Domain is required."))));
  try {
    const result = (await addDomain(user.id, domain)) as { dnsRecords?: DnsRecord[] };
    return html(contentFragment("domains", "Domains", domainsView(await getUserDomains(user.id), dnsBanner(result.dnsRecords ?? []))));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to add domain.";
    return html(contentFragment("domains", "Domains", domainsView(await getUserDomains(user.id), alert("err", msg))));
  }
}

function alert(kind: "ok" | "err" | "mut", message: string): string {
  const icon = kind === "ok" ? ICONS.check : ICONS.alert;
  return `<div class="alert ${kind}">${icon}<span>${esc(message)}</span></div>`;
}

export async function uiDeleteDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  try {
    await deleteDomain(req.params.id, user.id);
  } catch (err) {
    console.error("delete domain failed:", err);
  }
  return new Response("", { status: 204, headers: { "HX-Redirect": "/dashboard" } });
}

// --- domain detail -----------------------------------------------------------

function domainDetailShell(domain: DomainRow, activeTab: string, body: string): string {
  return `
    <div class="domain-header">
      <h1>${esc(domain.domain)}</h1>
      <span class="badge ${esc(domain.status)}">${statusDot(domain.status)}${esc(domain.status)}</span>
    </div>
    <nav class="sub-tabs">
      <a class="sub-tab${activeTab === "overview" ? " active" : ""}" href="/ui/domains/${esc(domain.id)}" hx-get="/ui/domains/${esc(domain.id)}" hx-target="#content-area">${ICONS.globe}Overview</a>
      <a class="sub-tab${activeTab === "logs" ? " active" : ""}" href="/ui/domains/${esc(domain.id)}/logs" hx-get="/ui/domains/${esc(domain.id)}/logs" hx-target="#content-area">${ICONS.document}Logs</a>
      <a class="sub-tab${activeTab === "keys" ? " active" : ""}" href="/ui/domains/${esc(domain.id)}/keys" hx-get="/ui/domains/${esc(domain.id)}/keys" hx-target="#content-area">${ICONS.key}API Keys</a>
    </nav>
    <section id="domain-panel" class="domain-panel">${body}</section>
  `;
}

function domainOverview(domain: DomainRow & Partial<{ dns_records?: DnsRecord[] }>, banner = ""): string {
  const dns: DnsRecord[] = Array.isArray(domain.dns_records) ? domain.dns_records : [];
  return `${banner}${dnsBanner(dns)}
    <div class="domain-actions">
      ${domain.status !== "verified" ? `<button class="btn btn-secondary" hx-post="/ui/domains/${esc(domain.id)}/verify" hx-target="#content-area">${ICONS.check}Check DNS</button>` : ""}
      <button class="btn btn-danger" hx-post="/ui/domains/${esc(domain.id)}/delete" hx-target="#content-area" hx-confirm="Delete ${esc(domain.domain)}?">${ICONS.trash}Delete domain</button>
    </div>
    ${domain.status === "verified" ? alert("ok", "Domain is verified and ready to send.") : alert("mut", "Add the DNS records above, then click Check DNS to verify.")}`;
}

function domainKeysView(domain: DomainRow, keys: Array<{ id: string; key_name: string; key_prefix: string; permissions: string[]; created_at?: string }>, banner = ""): string {
  const rows = keys
    .map(
      (k) => `<tr><td><span style="font-weight:600;color:var(--fg)">${esc(k.key_name)}</span></td>
      <td><code>${esc(k.key_prefix)}…</code></td>
      <td><span class="cell-muted">${esc((k.permissions ?? []).join(", "))}</span></td>
      <td><span class="cell-subtle">${formatDate(k.created_at)}</span></td>
      <td><button class="btn btn-ghost btn-sm" hx-post="/ui/domains/${esc(domain.id)}/keys/${esc(k.id)}/delete" hx-target="#content-area" hx-confirm="Revoke ${esc(k.key_name)}?">${ICONS.trash}Revoke</button></td></tr>`
    )
    .join("");
  const form = domain.status === "verified"
    ? `<form hx-post="/ui/domains/${esc(domain.id)}/keys" hx-target="#content-area" class="toolbar">
        <input name="keyName" placeholder="Key name" required>
        <button type="submit" class="btn">${ICONS.key}Create key</button>
      </form>`
    : alert("mut", "Verify the domain before creating API keys.");
  return `${banner}${form}
  <div class="table-wrap">
    <table><thead><tr><th>Name</th><th>Prefix</th><th>Permissions</th><th>Created</th><th style="text-align:right">Actions</th></tr></thead><tbody>
    ${rows || `<tr><td colspan="5">${emptyState(ICONS.key, "No API keys yet", "Create a key to send email from this domain.")}</td></tr>`}</tbody></table>
  </div>`;
}

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
    .map((r) => `<tr><td><span class="cell-muted">${esc(r.created_at)}</span></td>
      <td>${esc(r.from_email)}</td><td><span class="cell-muted">${esc(r.to_emails.join(", "))}</span></td>
      <td>${esc(r.subject)}</td><td><span class="badge ${esc(r.status)}">${statusDot(r.status)}${esc(r.status)}</span></td></tr>`)
    .join("");
  return `<div class="table-wrap">
    <table><thead><tr><th>When</th><th>From</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>
    ${rows || `<tr><td colspan="5">${emptyState(ICONS.mail, "No emails sent yet", "Emails sent through this domain will appear here.")}</td></tr>`}</tbody></table>
  </div>`;
}

export async function uiDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return html(contentFragment("domains", "Domains", alert("err", "Domain not found.")));
  }
  const body = domainDetailShell(domain as DomainRow, "overview", domainOverview(domain as DomainRow & Partial<{ dns_records: DnsRecord[] }>));
  return html(contentFragment("domains", domain.domain, body));
}

export async function uiDomainLogs(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return html(contentFragment("domains", "Domains", alert("err", "Domain not found.")));
  }
  const logs = await getDomainEmailLogs(user.id, domain.id);
  const body = domainDetailShell(domain as DomainRow, "logs", domainLogsView(logs));
  return html(contentFragment("domains", domain.domain, body));
}

export async function uiDomainKeys(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return html(contentFragment("domains", "Domains", alert("err", "Domain not found.")));
  }
  const keys = await getDomainApiKeys(domain.id);
  const body = domainDetailShell(domain as DomainRow, "keys", domainKeysView(domain as DomainRow, keys as never));
  return html(contentFragment("domains", domain.domain, body));
}

export async function uiCreateDomainKey(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return html(contentFragment("domains", "Domains", alert("err", "Domain not found.")));
  }
  const form = await req.formData();
  const keyName = String(form.get("keyName") ?? "").trim();
  let banner = "";
  try {
    if (domain.status !== "verified") banner = alert("err", "Domain must be verified first.");
    else if (!keyName) banner = alert("err", "Key name is required.");
    else {
      const created = (await generateApiKey(user.id, domain.id, keyName)) as { key: string };
      banner = `<div class="banner"><div class="banner-title">${ICONS.key}Copy this key now — it will not be shown again</div><div class="code-block"><code>${esc(created.key)}</code><button data-copy type="button" aria-label="Copy API key">${ICONS.copy}</button></div></div>`;
    }
  } catch (err) {
    banner = alert("err", err instanceof Error ? err.message : "Failed to create key.");
  }
  const keys = await getDomainApiKeys(domain.id);
  const body = domainDetailShell(domain as DomainRow, "keys", domainKeysView(domain as DomainRow, keys as never, banner));
  return html(contentFragment("domains", domain.domain, body));
}

export async function uiDeleteDomainKey(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return html(contentFragment("domains", "Domains", alert("err", "Domain not found.")));
  }
  try {
    await deleteApiKey(req.params.keyId, user.id);
  } catch (err) {
    console.error("delete key failed:", err);
  }
  const keys = await getDomainApiKeys(domain.id);
  const body = domainDetailShell(domain as DomainRow, "keys", domainKeysView(domain as DomainRow, keys as never));
  return html(contentFragment("domains", domain.domain, body));
}

export async function uiVerifyDomain(req: Req): Promise<Response> {
  const user = gate(req);
  if (user instanceof Response) return user;
  const domain = await getDomainById(req.params.id);
  if (!domain || domain.user_id !== user.id) {
    return html(contentFragment("domains", "Domains", alert("err", "Domain not found.")));
  }
  const status = await checkDomainVerification(req.params.id);
  const banner =
    status === "verified"
      ? alert("ok", `${domain.domain} verified.`)
      : alert("mut", `${domain.domain} still pending — DNS may take time to propagate.`);
  const body = domainDetailShell(domain as DomainRow, "overview", domainOverview(domain as DomainRow & Partial<{ dns_records: DnsRecord[] }>, banner));
  return html(contentFragment("domains", domain.domain, body));
}

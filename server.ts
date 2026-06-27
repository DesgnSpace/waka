import { methods } from "@/server/http";
import * as h from "@/server/handlers";
import { snsWebhook } from "@/server/webhooks";
import * as ui from "@/server/ui";

const port = Number(process.env.PORT ?? 3000);

// Drop-in replacement for the previous Next.js app: identical /api/* paths,
// JSON shapes, auth, and env, plus an HTMX dashboard. Business logic is reused
// unchanged from src/lib.
const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  routes: {
    // --- JSON API (Resend-compatible + dashboard backend) ---
    "/api/health": methods({ GET: h.health }),
    "/api/setup": methods({ POST: h.setup }),
    "/api/auth/login": methods({ POST: h.login }),
    "/api/auth/me": methods({ GET: h.me }),
    "/api/domains": methods({ GET: h.listDomains, POST: h.createDomain }),
    "/api/domains/:id": methods({ GET: h.getDomain, DELETE: h.removeDomain }),
    "/api/domains/:id/verify": methods({ POST: h.verifyDomain }),
    "/api/api-keys": methods({ GET: h.listApiKeys, POST: h.createApiKey }),
    "/api/api-keys/:id": methods({ PUT: h.updateApiKey, DELETE: h.removeApiKey }),
    "/api/emails": methods({ POST: h.sendEmailHandler }),
    "/api/emails/logs": methods({ GET: h.emailLogs }),
    "/api/emails/:id": methods({ GET: h.getEmail }),
    "/api/webhooks/ses": methods({ POST: snsWebhook }),
    "/api/tools/email-dns-checker": methods({ POST: h.emailDnsChecker }),

    // --- HTMX dashboard (cookie session, same JWT) ---
    "/": methods({ GET: ui.home }),
    "/login": methods({ GET: ui.loginPage, POST: ui.doLogin }),
    "/logout": methods({ GET: ui.logout, POST: ui.logout }),
    "/dashboard": methods({ GET: ui.dashboard }),
    "/ui/domains": methods({ GET: ui.uiDomains, POST: ui.uiAddDomain }),
    "/ui/domains/:id": methods({ GET: ui.uiDomain }),
    "/ui/domains/:id/dns.zone": methods({ GET: ui.uiDomainDns }),
    "/ui/domains/:id/mailfrom": methods({ POST: ui.uiSetMailFrom }),
    "/ui/domains/:id/verify": methods({ POST: ui.uiVerifyDomain }),
    "/ui/domains/:id/delete": methods({ POST: ui.uiDeleteDomain }),
    "/ui/domains/:id/logs": methods({ GET: ui.uiDomainLogs }),
    "/ui/domains/:id/keys": methods({ GET: ui.uiDomainKeys, POST: ui.uiCreateDomainKey }),
    "/ui/domains/:id/keys/:keyId/delete": methods({ POST: ui.uiDeleteDomainKey }),
  },
  fetch() {
    return Response.json({ error: "Not found" }, { status: 404 });
  },
  error(err: unknown) {
    console.error("Unhandled server error:", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  },
});

console.log(`waka listening on http://${server.hostname}:${server.port}`);

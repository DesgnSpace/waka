import * as Sentry from "@sentry/bun";

import { methods, MAX_JSON_BODY_BYTES } from "@/server/http";
import * as h from "@/server/handlers";
import { snsWebhook } from "@/server/webhooks";
import * as wh from "@/server/webhook-endpoint-handlers";
import * as ui from "@/server/ui";

// One MiB above the largest body the JSON API accepts, so oversized sends are
// answered by the API's own JSON 413 instead of the transport-level rejection.
export const MAX_REQUEST_BODY_BYTES = MAX_JSON_BODY_BYTES + 1024 * 1024;

export function serveOptions() {
  return {
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    routes: {
      // --- JSON API (Resend-compatible + dashboard backend) ---
      "/api/health": methods({ GET: h.health }),
      "/api/auth/login": methods({ POST: h.login }),
      "/api/auth/signup": methods({ POST: h.signup }),
      "/api/auth/me": methods({ GET: h.me }),
      "/api/domains": methods({ GET: h.listDomains, POST: h.createDomain }),
      "/api/domains/:id": methods({ GET: h.getDomain, DELETE: h.removeDomain }),
      "/api/domains/:id/verify": methods({ POST: h.verifyDomain }),
      "/api/domains/:id/suppressions": methods({ GET: h.listSuppressionsHandler }),
      "/api/domains/:id/suppressions/:email": methods({ DELETE: h.removeSuppressionHandler }),
      "/api/api-keys": methods({ GET: h.listApiKeys, POST: h.createApiKey }),
      "/api/api-keys/:id": methods({ PUT: h.updateApiKey, DELETE: h.removeApiKey }),
      "/api/emails": methods({ POST: h.sendEmailHandler }),
      "/api/emails/batch": methods({ POST: h.sendBatchHandler }),
      "/api/emails/logs": methods({ GET: h.emailLogs }),
      "/api/emails/:id": methods({ GET: h.getEmail }),
      "/api/webhooks/ses": methods({ POST: snsWebhook }),
      "/api/webhooks": methods({ GET: wh.listWebhookEndpointsHandler, POST: wh.createWebhookEndpointHandler }),
      "/api/webhooks/:id": methods({ DELETE: wh.deleteWebhookEndpointHandler }),
      "/api/webhooks/:id/secret": methods({ GET: wh.getWebhookSecretHandler }),
      "/api/webhooks/:id/rotate": methods({ POST: wh.rotateWebhookSecretHandler }),
      "/api/tools/email-dns-checker": methods({ POST: h.emailDnsChecker }),

      // --- HTMX dashboard (cookie session, same JWT) ---
      "/": methods({ GET: ui.home }),
      "/login": methods({ GET: ui.loginPage, POST: ui.doLogin }),
      "/logout": methods({ POST: ui.logout }),
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
      Sentry.captureException(err);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    },
  };
}

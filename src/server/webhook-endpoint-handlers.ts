import { z } from "zod";
import { json, requireUser, pathUuid, jsonBody, HttpError, type Req } from "./http";
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  deleteWebhookEndpoint,
  getWebhookEndpointSecret,
  rotateWebhookEndpointSecret,
  isValidWebhookUrl,
} from "@/lib/outbound-webhooks";
import { errorCode } from "@/lib/errors";

const createSchema = z.object({
  url: z.string().min(1, "URL is required").max(2048).refine(isValidWebhookUrl, "URL must be a valid public HTTPS URL — private and internal addresses are not allowed."),
});

export async function listWebhookEndpointsHandler(req: Req): Promise<Response> {
  const user = requireUser(req);
  const endpoints = await listWebhookEndpoints(user.id);
  return json({ success: true, data: { webhooks: endpoints } });
}

export async function createWebhookEndpointHandler(req: Req): Promise<Response> {
  const user = requireUser(req);
  const { url } = createSchema.parse(await jsonBody(req));
  try {
    const result = await createWebhookEndpoint(user.id, url);
    return json(
      {
        success: true,
        data: {
          webhook: {
            id: result.id,
            url: result.url,
            enabled: result.enabled,
            created_at: result.created_at,
            updated_at: result.updated_at,
          },
          secret: result.secret,
        },
        message: "Webhook endpoint created. Store the secret securely — you can retrieve it again via GET /api/webhooks/:id/secret.",
      },
      201,
    );
  } catch (err) {
    if (errorCode(err) === "23505") throw new HttpError(409, { error: "An endpoint with this URL already exists." });
    throw err;
  }
}

export async function deleteWebhookEndpointHandler(req: Req): Promise<Response> {
  const user = requireUser(req);
  try {
    await deleteWebhookEndpoint(pathUuid(req), user.id);
  } catch {
    throw new HttpError(404, { error: "Webhook endpoint not found." });
  }
  return json({ success: true, message: "Webhook endpoint deleted." });
}

export async function getWebhookSecretHandler(req: Req): Promise<Response> {
  const user = requireUser(req);
  let secret: string;
  try {
    secret = await getWebhookEndpointSecret(pathUuid(req), user.id);
  } catch {
    throw new HttpError(404, { error: "Webhook endpoint not found." });
  }
  return json({ success: true, data: { secret } });
}

export async function rotateWebhookSecretHandler(req: Req): Promise<Response> {
  const user = requireUser(req);
  let secret: string;
  try {
    secret = await rotateWebhookEndpointSecret(pathUuid(req), user.id);
  } catch {
    throw new HttpError(404, { error: "Webhook endpoint not found." });
  }
  return json({ success: true, data: { secret }, message: "Webhook secret rotated." });
}

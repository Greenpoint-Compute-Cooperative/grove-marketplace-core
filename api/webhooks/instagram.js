import { ConfigurationError, deploymentEnvironment, requireInstagramBotConfig } from "../../lib/server/config.js";
import { json, problem } from "../../lib/server/http.js";
import {
  normalizeInstagramWebhook,
  secureTokenEqual,
  verifyInstagramWebhookSignature
} from "../../lib/server/instagram-webhook.js";
import { createSupabaseServiceClient } from "../../lib/server/supabase.js";

const MAX_BODY_BYTES = 1_000_000;
const environmentName = () => {
  const environment = deploymentEnvironment();
  return environment === "local" ? "development" : environment;
};

export const GET = async (request) => {
  try {
    const config = requireInstagramBotConfig();
    const params = new URL(request.url).searchParams;
    if (params.get("hub.mode") !== "subscribe"
      || !secureTokenEqual(params.get("hub.verify_token"), config.instagramBot.webhookVerifyToken)) {
      return problem(403, "instagram_verification_rejected", "Webhook verification was rejected.");
    }
    const challenge = params.get("hub.challenge") || "";
    if (!/^[-_A-Za-z0-9]{1,500}$/.test(challenge)) {
      return problem(422, "instagram_challenge_invalid", "Webhook verification was rejected.");
    }
    return new Response(challenge, {
      status: 200,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }
    });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return problem(503, "instagram_bot_not_configured", "Instagram bot ingestion is not configured.");
    }
    return problem(500, "unexpected_error", "Webhook verification is unavailable.");
  }
};

export const POST = async (request) => {
  try {
    const config = requireInstagramBotConfig();
    const announcedLength = Number(request.headers.get("content-length") || 0);
    if (announcedLength > MAX_BODY_BYTES) return problem(413, "payload_too_large", "The webhook payload is too large.");
    const rawBody = Buffer.from(await request.arrayBuffer());
    if (rawBody.byteLength > MAX_BODY_BYTES) return problem(413, "payload_too_large", "The webhook payload is too large.");
    if (!verifyInstagramWebhookSignature({
      rawBody,
      signature: request.headers.get("x-hub-signature-256"),
      appSecret: config.instagramBot.appSecret
    })) return problem(401, "instagram_signature_invalid", "The webhook signature is invalid.");

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return problem(400, "invalid_json", "Send a JSON object.");
    }
    const events = normalizeInstagramWebhook(payload).map((event) => ({
      provider: "instagram",
      environment: environmentName(),
      ...event
    }));
    if (events.length) {
      const service = createSupabaseServiceClient();
      const { error } = await service.from("social_event_inbox").upsert(events, {
        onConflict: "provider,environment,provider_event_id",
        ignoreDuplicates: true
      });
      if (error) return problem(503, "instagram_inbox_unavailable", "The webhook could not be accepted.");
    }
    return json({ accepted: true, events: events.length }, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return problem(503, "instagram_bot_not_configured", "Instagram bot ingestion is not configured.");
    }
    if (/^INSTAGRAM_WEBHOOK_/.test(error?.message || "")) {
      return problem(422, "instagram_payload_invalid", "The webhook payload is invalid.");
    }
    return problem(500, "unexpected_error", "The webhook could not be accepted.");
  }
};

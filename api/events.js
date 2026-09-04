import { ConfigurationError, getRuntimeConfig } from "../lib/server/config.js";
import { json, problem, readJson, requestFailure, text } from "../lib/server/http.js";
import { createSupabaseAdminClient, createSupabaseRequestClient, getAuthenticatedCurator } from "../lib/server/supabase.js";

const eventNames = new Set([
  "page_view",
  "discovery_saved",
  "discovery_unsaved",
  "discovery_sponsored",
  "discovery_filter_changed",
  "work_filter_changed",
  "work_viewed",
  "curator_viewed",
  "exhibition_viewed",
  "bazaar_viewed",
  "calendar_saved",
  "join_started",
  "join_unavailable",
  "join_completed",
  "join_cancelled",
  "draft_started",
  "draft_reviewed",
  "acquisition_preview_opened",
  "acquisition_method_changed",
  "client_error"
]);
const entityTypes = new Set(["work", "curator", "discovery", "exhibition", "bazaar", "provider"]);
const propertyNames = new Set(["filter", "format", "method", "provider", "source", "state", "kind"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const routePattern = /^[a-z0-9][a-z0-9/_-]{0,119}$/;

const sameOrigin = (request, configuredSiteUrl) => {
  const requestOrigin = new URL(request.url).origin;
  const allowed = new Set([requestOrigin, configuredSiteUrl].filter(Boolean));
  const origin = request.headers.get("origin");
  if (origin) return allowed.has(origin);

  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return allowed.has(new URL(referer).origin);
  } catch {
    return false;
  }
};

const safeProperties = (input) => {
  if (input === undefined) return {};
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("INVALID_INPUT");

  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!propertyNames.has(key)) throw new Error("INVALID_INPUT");
    if (typeof value === "string" && value.length <= 80) output[key] = value;
    else if (typeof value === "boolean") output[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else throw new Error("INVALID_INPUT");
  }
  return output;
};

const clientTimestamp = (input) => {
  if (!input) return null;
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed) || Math.abs(Date.now() - parsed) > 86_400_000) throw new Error("INVALID_INPUT");
  return new Date(parsed).toISOString();
};

export const POST = async (request) => {
  try {
    const config = getRuntimeConfig();
    if (!config.metricsConfigured) return problem(503, "metrics_not_configured", "Product metrics are unavailable.");
    if (!sameOrigin(request, config.siteUrl)) return problem(403, "origin_not_allowed", "This event source is not allowed.");

    const body = await readJson(request, 4_096);
    const eventName = text(body.event_name, { required: true, maximum: 80 });
    const sessionId = text(body.session_id, { required: true, maximum: 40 });
    const route = text(body.route, { required: true, maximum: 120 });
    const entityType = text(body.entity_type, { maximum: 32 });
    const entityId = text(body.entity_id, { maximum: 160 });

    if (!eventNames.has(eventName) || !uuid.test(sessionId) || !routePattern.test(route)) throw new Error("INVALID_INPUT");
    if (entityType && !entityTypes.has(entityType)) throw new Error("INVALID_INPUT");
    if (Boolean(entityType) !== Boolean(entityId)) throw new Error("INVALID_INPUT");

    const requestClient = createSupabaseRequestClient(request);
    const { curator } = await getAuthenticatedCurator(requestClient.supabase);
    const admin = createSupabaseAdminClient();
    const { error } = await admin.rpc("record_product_event", {
      event_name_input: eventName,
      session_uuid: sessionId,
      route_input: route,
      curator_uuid: curator?.id || null,
      entity_type_input: entityType,
      entity_id_input: entityId,
      properties_input: safeProperties(body.properties),
      client_timestamp_input: clientTimestamp(body.client_timestamp)
    });

    if (error?.message?.includes("rate_limit")) return problem(429, "rate_limited", "Too many product events.");
    if (error) {
      console.error(JSON.stringify({ level: "error", operation: "record_product_event", code: error.code || "database_error" }));
      return problem(503, "metrics_unavailable", "Product metrics are unavailable.");
    }
    return json({ accepted: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "metrics_not_configured", "Product metrics are unavailable.");
    return requestFailure(error) || problem(500, "unexpected_error", "The product event was not accepted.");
  }
};

import { timingSafeEqual } from "node:crypto";
import { ConfigurationError, getRuntimeConfig } from "../../lib/server/config.js";
import { json, problem } from "../../lib/server/http.js";
import { createSupabaseAdminClient } from "../../lib/server/supabase.js";

const authorized = (request, expected) => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};

export const GET = async (request) => {
  try {
    const config = getRuntimeConfig();
    if (!config.cronSecret || !authorized(request, config.cronSecret)) return problem(401, "not_authorized", "Cron authorization is required.");

    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc("prune_product_events", { retention_days: 180 });
    if (error) {
      console.error(JSON.stringify({ level: "error", operation: "prune_product_events", code: error.code || "database_error" }));
      return problem(503, "retention_failed", "Metrics retention did not complete.");
    }
    console.log(JSON.stringify({ level: "info", operation: "prune_product_events", deleted: data }));
    return json({ ok: true, deleted: data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "metrics_not_configured", "Metrics retention is unavailable.");
    return problem(500, "unexpected_error", "Metrics retention did not complete.");
  }
};

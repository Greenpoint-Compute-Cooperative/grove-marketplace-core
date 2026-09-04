import { timingSafeEqual } from "node:crypto";
import { ConfigurationError, getRuntimeConfig } from "../lib/server/config.js";
import { json, problem } from "../lib/server/http.js";
import { createSupabaseAdminClient } from "../lib/server/supabase.js";

const authorized = (request, expected) => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};

export const GET = async (request) => {
  try {
    const config = getRuntimeConfig();
    if (!config.metricsConfigured || !config.metricsReadToken) return problem(503, "metrics_not_configured", "Product metrics are unavailable.");
    if (!authorized(request, config.metricsReadToken)) return problem(401, "not_authorized", "Metrics access is required.");

    const requestedDays = Number(new URL(request.url).searchParams.get("days") || 30);
    if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 90) {
      return problem(422, "invalid_range", "Choose 1 to 90 days.");
    }

    const admin = createSupabaseAdminClient();
    const { data, error } = await admin.rpc("product_metrics_summary", { range_days: requestedDays });
    if (error) {
      console.error(JSON.stringify({ level: "error", operation: "product_metrics_summary", code: error.code || "database_error" }));
      return problem(503, "metrics_unavailable", "Product metrics are unavailable.");
    }
    return json({ generated_at: new Date().toISOString(), ...data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "metrics_not_configured", "Product metrics are unavailable.");
    return problem(500, "unexpected_error", "Product metrics are unavailable.");
  }
};

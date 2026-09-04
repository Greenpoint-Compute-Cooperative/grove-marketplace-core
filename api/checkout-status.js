import { ConfigurationError } from "../lib/server/config.js";
import { json, problem } from "../lib/server/http.js";
import { createSupabaseRequestClient, getAuthenticatedCurator } from "../lib/server/supabase.js";

export const GET = async (request) => {
  try {
    const sessionId = new URL(request.url).searchParams.get("session_id") || "";
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId) || sessionId.length > 240) {
      return problem(422, "invalid_session", "Checkout session is invalid.");
    }
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in to check this order.", headers);
    const { data: acquisition, error } = await supabase
      .from("acquisitions")
      .select("id,state,updated_at")
      .eq("provider_ref", sessionId)
      .eq("buyer_user_id", user.id)
      .maybeSingle();
    if (error) return problem(502, "checkout_status_unavailable", "Checkout status is temporarily unavailable.", headers);
    if (!acquisition) return problem(404, "checkout_not_found", "No matching order was found.", headers);
    return json({ acquisition_id: acquisition.id, state: acquisition.state, updated_at: acquisition.updated_at }, { headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "acquisition_not_configured", "Checkout is not configured.");
    return problem(502, "checkout_status_unavailable", "Checkout status is temporarily unavailable.");
  }
};

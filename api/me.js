import { ConfigurationError } from "../lib/server/config.js";
import { json, problem } from "../lib/server/http.js";
import { createSupabaseRequestClient, getAuthenticatedCurator } from "../lib/server/supabase.js";

export const GET = async (request) => {
  try {
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user, curator, error } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "No curator session is active.", headers);
    if (error || !curator) return problem(409, "profile_unavailable", "The curator profile is not ready.", headers);
    return json({ curator }, { headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "backend_not_configured", "Profiles are not configured.");
    return problem(500, "unexpected_error", "The profile could not be loaded.");
  }
};

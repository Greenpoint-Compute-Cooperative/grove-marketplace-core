import { ConfigurationError } from "../../lib/server/config.js";
import { problem, json } from "../../lib/server/http.js";
import { createSupabaseRequestClient } from "../../lib/server/supabase.js";

export const POST = async (request) => {
  try {
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { error } = await supabase.auth.signOut();
    if (error) return problem(502, "signout_failed", "Sign-out could not finish.", headers);
    return json({ signedOut: true }, { headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "backend_not_configured", "Sign-out is not configured.");
    return problem(500, "unexpected_error", "Sign-out could not finish.");
  }
};

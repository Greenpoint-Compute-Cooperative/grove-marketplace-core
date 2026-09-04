import { ConfigurationError } from "../../lib/server/config.js";
import { redirect } from "../../lib/server/http.js";
import { createSupabaseRequestClient, getAuthenticatedCurator } from "../../lib/server/supabase.js";

const joinTarget = (request, state, siteUrl) => {
  const target = new URL("/", siteUrl || request.url);
  target.searchParams.set("auth", state);
  target.hash = "join";
  return target.toString();
};

export const GET = async (request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.has("error")) return redirect(joinTarget(request, "cancelled"));

  try {
    const { config, supabase, headers } = createSupabaseRequestClient(request);
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return redirect(joinTarget(request, "error", config.siteUrl), { headers });

    const { user, curator, error: profileError } = await getAuthenticatedCurator(supabase);
    const state = user && curator && !profileError ? "connected" : "profile-error";
    return redirect(joinTarget(request, state, config.siteUrl), { headers });
  } catch (error) {
    const state = error instanceof ConfigurationError ? "not-configured" : "error";
    return redirect(joinTarget(request, state));
  }
};

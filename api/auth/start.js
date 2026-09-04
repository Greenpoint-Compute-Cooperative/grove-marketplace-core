import { ConfigurationError, getProvider } from "../../lib/server/config.js";
import { problem, redirect } from "../../lib/server/http.js";
import { createSupabaseRequestClient } from "../../lib/server/supabase.js";

export const GET = async (request) => {
  const requestedProvider = new URL(request.url).searchParams.get("provider");
  if (!["instagram", "x", "twitter"].includes(requestedProvider)) {
    return problem(400, "invalid_provider", "Choose Instagram or X.");
  }

  try {
    const provider = getProvider(requestedProvider);
    if (!provider?.configured) {
      return problem(503, "provider_not_configured", `${provider?.key === "x" ? "X" : "Instagram"} sign-in is not configured.`);
    }

    const { config, supabase, headers } = createSupabaseRequestClient(request);
    const callback = new URL("/api/auth/callback", config.siteUrl || request.url);
    callback.searchParams.set("provider", provider.key);

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: provider.id,
      options: {
        redirectTo: callback.toString(),
        scopes: provider.scopes,
        skipBrowserRedirect: true
      }
    });

    if (error || !data.url) return problem(502, "oauth_start_failed", "The provider could not be opened.", headers);
    return redirect(data.url, { status: 302, headers });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return problem(503, "backend_not_configured", "Sign-in is not configured.");
    }
    return problem(500, "unexpected_error", "Sign-in could not start.");
  }
};

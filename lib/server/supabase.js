import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { parseCookie, stringifySetCookie } from "cookie";
import { ConfigurationError, getRuntimeConfig, requireBackendConfig } from "./config.js";

export const createSupabaseRequestClient = (request) => {
  const config = requireBackendConfig();
  const requestUrl = new URL(request.url);
  const cookieJar = new Map(Object.entries(parseCookie(request.headers.get("cookie") || "")).filter(([, value]) => value !== undefined));
  const responseHeaders = new Headers({
    "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
    Expires: "0",
    Pragma: "no-cache"
  });

  const supabase = createServerClient(config.supabaseUrl, config.supabaseKey, {
    auth: { flowType: "pkce" },
    cookieOptions: {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: requestUrl.protocol === "https:"
    },
    cookies: {
      getAll() {
        return [...cookieJar].map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet, authHeaders = {}) {
        for (const [name, headerValue] of Object.entries(authHeaders)) responseHeaders.set(name, headerValue);
        for (const { name, value, options } of cookiesToSet) {
          cookieJar.set(name, value);
          responseHeaders.append("Set-Cookie", stringifySetCookie({
            name,
            value,
            ...options,
            path: options.path || "/",
            sameSite: options.sameSite || "lax",
            httpOnly: true,
            secure: requestUrl.protocol === "https:"
          }));
        }
      }
    }
  });

  return { config, supabase, headers: responseHeaders };
};

export const getAuthenticatedCurator = async (client) => {
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) return { user: null, curator: null, error: userError };

  const { data: curator, error } = await client
    .from("curators")
    .select("id,display_name,handle,avatar_url,provider,status,created_at")
    .eq("id", userData.user.id)
    .maybeSingle();

  return { user: userData.user, curator, error };
};

export const createSupabaseAdminClient = () => {
  const config = getRuntimeConfig();
  if (!config.metricsConfigured) {
    throw new ConfigurationError("Marketplace metrics are not configured.", ["SUPABASE_SECRET_KEY", "GROVE_METRICS_ENABLED=true"]);
  }

  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
  });
};

export const createSupabaseServiceClient = () => {
  const config = getRuntimeConfig();
  if (!config.backendConfigured || !config.supabaseSecretKey) {
    throw new ConfigurationError("Marketplace commerce storage is not configured.", ["SUPABASE_SECRET_KEY"]);
  }

  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
  });
};

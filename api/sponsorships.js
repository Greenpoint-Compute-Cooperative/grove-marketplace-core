import { ConfigurationError } from "../lib/server/config.js";
import { json, problem, readJson, requestFailure, text } from "../lib/server/http.js";
import { createSupabaseRequestClient, getAuthenticatedCurator } from "../lib/server/supabase.js";

const uuid = (input) => {
  const value = text(input, { required: true, maximum: 36 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("INVALID_INPUT");
  return value;
};

const authorize = async (request) => {
  const context = createSupabaseRequestClient(request);
  const identity = await getAuthenticatedCurator(context.supabase);
  return { ...context, ...identity };
};

export const GET = async (request) => {
  try {
    const { supabase, headers, user, curator } = await authorize(request);
    if (!user) return problem(401, "not_authenticated", "Join through Instagram or X first.", headers);
    if (!curator || curator.status !== "active") return problem(403, "curator_inactive", "This curator profile is not active.", headers);

    const { data, error } = await supabase
      .from("sponsorships")
      .select("id,discovery_id,recommendation,status,rights_status,created_at,updated_at")
      .eq("curator_id", user.id)
      .order("created_at", { ascending: false });
    if (error) return problem(502, "sponsorships_unavailable", "Sponsorships could not be loaded.", headers);
    return json({ sponsorships: data }, { headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "backend_not_configured", "Sponsorships are not configured.");
    return problem(500, "unexpected_error", "Sponsorships could not be loaded.");
  }
};

export const POST = async (request) => {
  let context;
  try {
    context = await authorize(request);
    const { supabase, headers, user, curator } = context;
    if (!user) return problem(401, "not_authenticated", "Join through Instagram or X first.", headers);
    if (!curator || curator.status !== "active") return problem(403, "curator_inactive", "This curator profile is not active.", headers);

    const body = await readJson(request);
    const discoveryId = uuid(body.discovery_id);
    const recommendation = text(body.recommendation, { maximum: 1_200 });
    const { data, error } = await supabase.rpc("sponsor_discovery", {
      discovery_uuid: discoveryId,
      recommendation_text: recommendation
    });

    if (error) return problem(422, "sponsorship_not_saved", "Only your own discovery can be sponsored.", headers);
    return json({ sponsorship: data }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "backend_not_configured", "Sponsorships are not configured.");
    return requestFailure(error, context?.headers) || problem(500, "unexpected_error", "The sponsorship could not be saved.", context?.headers);
  }
};

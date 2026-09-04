import { ConfigurationError } from "../lib/server/config.js";
import { json, problem, publicUrl, readJson, requestFailure, text } from "../lib/server/http.js";
import { createSupabaseRequestClient, getAuthenticatedCurator } from "../lib/server/supabase.js";

const sourceProviders = new Set(["instagram", "x", "web", "direct"]);

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
      .from("discoveries")
      .select("id,source_url,source_provider,artist_name,work_title,thumbnail_url,note,status,rights_status,created_at,updated_at")
      .eq("curator_id", user.id)
      .order("created_at", { ascending: false });
    if (error) return problem(502, "discoveries_unavailable", "Discoveries could not be loaded.", headers);
    return json({ discoveries: data }, { headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "backend_not_configured", "Discoveries are not configured.");
    return problem(500, "unexpected_error", "Discoveries could not be loaded.");
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
    const sourceProvider = text(body.source_provider, { maximum: 24 }) || "web";
    if (!sourceProviders.has(sourceProvider)) throw new Error("INVALID_INPUT");

    const draft = {
      curator_id: user.id,
      source_url: publicUrl(body.source_url),
      source_provider: sourceProvider,
      artist_name: text(body.artist_name, { maximum: 160 }),
      work_title: text(body.work_title, { maximum: 240 }),
      thumbnail_url: body.thumbnail_url ? publicUrl(body.thumbnail_url) : null,
      note: text(body.note, { maximum: 1_200 }),
      status: "new",
      rights_status: "unverified"
    };

    const { data, error } = await supabase.from("discoveries").insert(draft).select().single();
    if (error) return problem(502, "discovery_not_saved", "The discovery could not be saved.", headers);
    return json({ discovery: data }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "backend_not_configured", "Discoveries are not configured.");
    return requestFailure(error, context?.headers) || problem(500, "unexpected_error", "The discovery could not be saved.", context?.headers);
  }
};

import { ConfigurationError, getRuntimeConfig } from "../lib/server/config.js";
import { json, problem } from "../lib/server/http.js";
import { marketStatsEtag, publicMarketStats } from "../lib/server/market-stats.js";
import { createSupabaseServiceClient } from "../lib/server/supabase.js";

const cacheHeaders = (etag) => ({
  "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300",
  ETag: etag
});

export const GET = async (request) => {
  try {
    const config = getRuntimeConfig();
    const chainId = config.wallet.chainId;
    if (![1, 11155111].includes(chainId)) {
      return json({
        status: "disabled",
        environment: config.targetEnvironment,
        network: "disabled",
        reason: "chain-not-configured",
        as_of: null,
        stats: null
      }, { headers: cacheHeaders('"market-stats-disabled"') });
    }
    const service = createSupabaseServiceClient();
    const { data, error } = await service.from("market_stats_current")
      .select("chain_id,state,indexed_through_block,indexed_through_hash,stats,schema_version,computed_at")
      .eq("chain_id", chainId).maybeSingle();
    if (error) return problem(503, "market_stats_unavailable", "Marketplace statistics are unavailable.");
    const result = publicMarketStats({ row: data, chainId, environment: config.targetEnvironment });
    const etag = marketStatsEtag(result);
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: cacheHeaders(etag) });
    }
    return json(result, { headers: cacheHeaders(etag) });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return problem(503, "market_stats_not_configured", "Marketplace statistics are not configured.");
    }
    return problem(500, "unexpected_error", "Marketplace statistics are unavailable.");
  }
};

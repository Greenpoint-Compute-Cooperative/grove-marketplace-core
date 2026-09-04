import { timingSafeEqual } from "node:crypto";
import { ConfigurationError, deploymentEnvironment, getRuntimeConfig, requireSecondaryIndexerConfig } from "../../lib/server/config.js";
import { json, problem } from "../../lib/server/http.js";
import { indexFinalizedOwnership } from "../../lib/server/resale-indexer.js";
import { createSupabaseServiceClient } from "../../lib/server/supabase.js";

const authorized = (request, expected) => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};

export const GET = async (request) => {
  const runtime = getRuntimeConfig();
  if (!runtime.cronSecret || !authorized(request, runtime.cronSecret)) {
    return problem(401, "not_authorized", "Cron authorization is required.");
  }
  let service;
  let runId;
  let runCompleted = false;
  try {
    const config = requireSecondaryIndexerConfig();
    service = createSupabaseServiceClient();
    const environment = deploymentEnvironment() === "local" ? "development" : deploymentEnvironment();
    const deploymentSha = /^[0-9a-f]{7,64}$/.test(process.env.VERCEL_GIT_COMMIT_SHA || "")
      ? process.env.VERCEL_GIT_COMMIT_SHA : null;
    const started = await service.from("indexer_worker_runs").insert({
      worker_name: "resale-finalized-v2",
      chain_id: config.wallet.chainId,
      deployment_sha: deploymentSha,
      state: "running",
      counters: { environment }
    }).select("id").single();
    if (started.error || !started.data) throw Object.assign(new Error("INDEXER_RUN_START_FAILED"), { code: "INDEXER_RUN_START_FAILED" });
    runId = started.data.id;

    const result = await indexFinalizedOwnership({ service, config });
    const terminalState = result.status === "locked" ? "locked" : "succeeded";
    const counters = Object.fromEntries(Object.entries(result).filter(([key, value]) =>
      ["pages", "events_inserted", "fills_finalized", "ownership_updates", "orders_cancelled", "orders_invalidated", "orders_expired"]
        .includes(key) && Number.isSafeInteger(value)));
    const indexedThrough = result.next_block_number ? (BigInt(result.next_block_number) - 1n).toString() : null;
    const finished = await service.from("indexer_worker_runs").update({
      state: terminalState,
      caught_up: result.caught_up === true,
      indexed_through_block: indexedThrough,
      observed_finalized_block: result.finalized_block_number || null,
      observed_finalized_hash: result.finalized_block_hash || null,
      counters,
      finished_at: new Date().toISOString()
    }).eq("id", runId);
    if (finished.error) throw Object.assign(new Error("INDEXER_RUN_FINISH_FAILED"), { code: "INDEXER_RUN_FINISH_FAILED" });
    runCompleted = true;

    let marketStats = result.caught_up === true ? "refreshing" : "syncing";
    if (result.caught_up === true && terminalState === "succeeded") {
      const refreshed = await service.rpc("refresh_market_stats_current", {
        p_chain_id: config.wallet.chainId,
        p_source_worker_run_id: runId
      });
      if (refreshed.error) throw Object.assign(new Error("MARKET_STATS_REFRESH_FAILED"), { code: "MARKET_STATS_REFRESH_FAILED" });
      marketStats = refreshed.data?.state || "syncing";
    }
    return json({ ...result, market_stats: marketStats }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (service && runId && !runCompleted) {
      const rawCode = String(error?.code || error?.message || "INDEXER_FAILED").toUpperCase();
      const errorCode = /^[A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : "INDEXER_FAILED";
      await service.from("indexer_worker_runs").update({
        state: "failed",
        error_code: errorCode,
        finished_at: new Date().toISOString()
      }).eq("id", runId);
    }
    console.error(JSON.stringify({ level: "error", operation: "resale_index", code: error?.code || error?.message || "index_error" }));
    if (error instanceof ConfigurationError) return problem(503, "secondary_index_not_configured", "Secondary ownership indexing is not configured.");
    return problem(503, "secondary_index_failed", "Secondary ownership indexing did not complete.");
  }
};

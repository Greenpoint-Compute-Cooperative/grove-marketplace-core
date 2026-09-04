import { timingSafeEqual } from "node:crypto";
import { ConfigurationError, getRuntimeConfig } from "../../lib/server/config.js";
import { json, problem } from "../../lib/server/http.js";
import {
  reconcileSponsoredSecondaryOperation,
  requireSponsorshipReconciliationConfig,
  sponsorshipReplayAllowed
} from "../../lib/server/secondary-sponsorship.js";
import { createStandardUserOperationProvider } from "../../lib/server/userop-provider.js";
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
  try {
    const config = requireSponsorshipReconciliationConfig(runtime);
    const service = createSupabaseServiceClient();
    const { data: decisions, error } = await service.from("sponsorship_decisions")
      .select("id,user_id,smart_account_id,request_key,action,decision,policy_version,target,selector,userop_hash,transaction_hash,provider,quoted_cost_wei,actual_cost_wei,rejection_code,policy_input,created_at,updated_at")
      .eq("decision", "submitted")
      .in("action", [
        "marketplace-transfer",
        "resale-approve-token", "resale-revoke-token", "resale-cancel-order",
        "resale-approve-usdc", "resale-revoke-usdc", "resale-fulfill"
      ])
      .order("updated_at", { ascending: true }).limit(25);
    if (error) return problem(503, "sponsorship_ledger_unavailable", "Sponsored actions could not be loaded.");
    const provider = createStandardUserOperationProvider({ config });
    const summary = { pending: 0, "included-unfinalized": 0, "reorg-pending": 0, finalized: 0, failed: 0, errors: 0 };
    for (const decision of decisions) {
      try {
        requireSponsorshipReconciliationConfig(config, decision.action);
        const result = await reconcileSponsoredSecondaryOperation({
          service,
          config,
          decision,
          provider,
          allowReplay: sponsorshipReplayAllowed(config, decision.action)
        });
        if (result.state in summary) summary[result.state] += 1;
        else summary.errors += 1;
      } catch (reconcileError) {
        summary.errors += 1;
        console.error(JSON.stringify({
          level: "error",
          operation: "sponsorship_reconcile",
          decision_id: decision.id,
          code: reconcileError?.code || reconcileError?.message || "sponsorship_reconcile_error"
        }));
      }
    }
    return json(summary, { status: summary.errors ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "sponsorship_not_configured", "Sponsored action reconciliation is not configured.");
    return problem(503, "sponsorship_reconcile_failed", "Sponsored action reconciliation did not complete.");
  }
};

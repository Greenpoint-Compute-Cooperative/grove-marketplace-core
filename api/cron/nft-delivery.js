import { timingSafeEqual } from "node:crypto";
import { requireAuctionConfig } from "../../lib/server/auction.js";
import { prepareSafeDelivery, reconcileSafeDelivery } from "../../lib/server/delivery.js";
import { ConfigurationError, getRuntimeConfig } from "../../lib/server/config.js";
import { json, problem } from "../../lib/server/http.js";
import { createSupabaseServiceClient } from "../../lib/server/supabase.js";

const authorized = (request, expected) => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};
const loadPreparationContext = async (service, settlement) => {
  const [{ data: auction, error: auctionError }, { data: account, error: accountError }] = await Promise.all([
    service.from("auctions").select("id,work_id,winner_bid_id,quantity").eq("id", settlement.auction_id).single(),
    service.from("smart_accounts")
      .select("id,user_id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,signer_count,threshold,state,recovery_ready,deployment_block,finalized_at")
      .eq("id", settlement.smart_account_id).single()
  ]);
  if (auctionError || accountError || !auction || !account) throw new Error("DELIVERY_CONTEXT_MISSING");
  const [{ data: work, error: workError }, { data: credentials, error: credentialError }] = await Promise.all([
    service.from("works")
      .select("id,nft_collection_id,nft_work_id,nft_token_id,nft_quantity,nft_custody_state,nft_mint_block,nft_mint_tx_hash,nft_finalized_at,contract_status,inventory_available")
      .eq("id", auction.work_id).single(),
    service.from("wallet_credentials").select("credential_commitment,owner_address,purpose")
      .eq("smart_account_id", account.id).eq("state", "active")
  ]);
  if (workError || credentialError || !work) throw new Error("DELIVERY_CONTEXT_MISSING");
  const { data: collection, error: collectionError } = await service.from("nft_collections")
    .select("id,standard,chain_id,contract_address,deployed_code_hash,inventory_safe,deployment_block,state")
    .eq("id", work.nft_collection_id).single();
  if (collectionError || !collection) throw new Error("DELIVERY_CONTEXT_MISSING");
  return { auction, work, collection, account, credentials };
};

const prepareOne = async ({ service, config, settlement }) => {
  const context = await loadPreparationContext(service, settlement);
  const prepared = await prepareSafeDelivery({ config, settlement, ...context });
  const { data, error } = await service.rpc("claim_auction_delivery", prepared.claim);
  if (error || !data) throw error || new Error("DELIVERY_CLAIM_FAILED");
  return data;
};

const reconcileOne = async ({ service, config, delivery }) => {
  const result = await reconcileSafeDelivery({ config, delivery });
  if (result.state === "pending") return "pending";
  const included = await service.rpc("record_auction_delivery_inclusion", result.inclusion);
  if (included.error || !included.data) throw included.error || new Error("DELIVERY_INCLUSION_FAILED");
  if (result.state !== "finalized") return "included";
  const finalized = await service.rpc("finalize_auction_delivery", result.finalization);
  if (finalized.error || !finalized.data) throw finalized.error || new Error("DELIVERY_FINALIZATION_FAILED");
  return "finalized";
};

export const GET = async (request) => {
  const runtime = getRuntimeConfig();
  if (!runtime.cronSecret || !authorized(request, runtime.cronSecret)) {
    return problem(401, "not_authorized", "Cron authorization is required.");
  }
  try {
    const config = requireAuctionConfig();
    const service = createSupabaseServiceClient();
    const [{ data: settlements, error: settlementError }, { data: deliveries, error: deliveryError }] = await Promise.all([
      service.from("auction_settlements")
        .select("id,auction_id,winning_bid_id,bidder_user_id,smart_account_id,state,risk_hold_until,release_authorization_key,release_evidence_hash,release_authorized_at")
        .eq("state", "release-ready").order("created_at", { ascending: true }).limit(10),
      service.from("chain_deliveries")
        .select("id,settlement_id,chain_id,standard,collection_address,token_id,quantity,from_address,to_address,safe_nonce,safe_transaction_hash,call_data_hash,prepared_block_number,prepared_block_hash,transaction_hash,block_number,block_hash,included_log_index,state")
        .in("state", ["queued", "submitted", "included"]).order("created_at", { ascending: true }).limit(25)
    ]);
    if (settlementError || deliveryError) return problem(503, "delivery_unavailable", "NFT deliveries could not be loaded.");

    const claimedSettlementIds = new Set(deliveries.map((delivery) => delivery.settlement_id));
    const summary = { prepared: 0, pending: 0, included: 0, finalized: 0, errors: 0 };
    for (const settlement of settlements) {
      if (claimedSettlementIds.has(settlement.id)) continue;
      try {
        await prepareOne({ service, config, settlement });
        summary.prepared += 1;
      } catch (error) {
        summary.errors += 1;
        console.error(JSON.stringify({
          level: "error",
          operation: "delivery_prepare",
          settlement_id: settlement.id,
          code: error?.code || error?.message || "delivery_prepare_error"
        }));
      }
    }
    for (const delivery of deliveries) {
      try {
        const state = await reconcileOne({ service, config, delivery });
        summary[state] += 1;
      } catch (error) {
        summary.errors += 1;
        console.error(JSON.stringify({
          level: "error",
          operation: "delivery_reconcile",
          delivery_id: delivery.id,
          settlement_id: delivery.settlement_id,
          code: error?.code || error?.message || "delivery_reconcile_error"
        }));
      }
    }
    return json(summary, { status: summary.errors ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "auction_not_configured", "NFT delivery is unavailable.");
    return problem(500, "unexpected_error", "NFT delivery did not complete.");
  }
};

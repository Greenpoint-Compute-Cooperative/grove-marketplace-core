import { timingSafeEqual } from "node:crypto";
import { getAddress } from "viem";
import { auctionCollectionStateAllowed, requireAuctionConfig, verifyBidIntent } from "../../lib/server/auction.js";
import { verifyFinalizedInventoryCustody } from "../../lib/server/chain.js";
import { ConfigurationError, getRuntimeConfig } from "../../lib/server/config.js";
import { json, problem } from "../../lib/server/http.js";
import { createSupabaseServiceClient } from "../../lib/server/supabase.js";
import { attestSmartAccountProfile, primaryWalletReady } from "../../lib/server/wallet.js";

const authorized = (request, expected) => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};

const signatureHex = (value) => {
  const input = String(value || "");
  if (/^\\x[0-9a-f]+$/i.test(input)) return `0x${input.slice(2)}`;
  if (/^0x[0-9a-f]+$/i.test(input)) return input;
  throw new Error("INVALID_STORED_SIGNATURE");
};

export const GET = async (request) => {
  const runtime = getRuntimeConfig();
  if (!runtime.cronSecret || !authorized(request, runtime.cronSecret)) {
    return problem(401, "not_authorized", "Cron authorization is required.");
  }
  try {
    const config = requireAuctionConfig();
    const service = createSupabaseServiceClient();
    const { data: auctions, error } = await service.from("auctions")
      .select("id,work_id,settlement_rail,bid_currency,terms_hash,high_bid_id,closes_at,quantity")
      .eq("state", "open").lte("closes_at", new Date().toISOString())
      .order("closes_at", { ascending: true }).limit(25);
    if (error) return problem(503, "auction_close_unavailable", "Auctions could not be loaded for close.");

    const summary = { checked: auctions.length, closed: 0, no_sale: 0, exceptions: 0 };
    for (const auction of auctions) {
      try {
        const { data: work, error: workError } = await service.from("works")
          .select("id,nft_collection_id,nft_work_id,nft_token_id,nft_quantity,nft_custody_state,nft_mint_block,contract_status")
          .eq("id", auction.work_id).single();
        if (workError || !work || work.nft_custody_state !== "inventory-safe" || work.contract_status !== "minted") {
          throw new Error("CLOSE_PROOF_MISSING");
        }
        const { data: collection, error: collectionError } = await service.from("nft_collections")
          .select("id,standard,chain_id,contract_address,deployed_code_hash,inventory_safe,deployment_block,state")
          .eq("id", work.nft_collection_id).single();
        if (collectionError || !collection || !auctionCollectionStateAllowed({ state: collection.state, config })) {
          throw new Error("COLLECTION_NOT_ACTIVE");
        }
        const inventoryProof = await verifyFinalizedInventoryCustody({ config, work, collection, quantity: auction.quantity });
        let expectedHighBidId = null;
        let expectedIntentHash = null;
        let signatureVerifiedBlock = null;
        if (auction.high_bid_id) {
          const { data: bid, error: bidError } = await service.from("auction_bids")
            .select("id,bidder_user_id,smart_account_id,amount,currency,intent_nonce,intent_hash,intent_origin_hash,signature,valid_after,valid_until")
            .eq("id", auction.high_bid_id).single();
          if (bidError || !bid) throw new Error("CLOSE_PROOF_MISSING");
          const { data: account, error: accountError } = await service.from("smart_accounts")
            .select("id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,signer_count,threshold,state,recovery_ready,finalized_at")
            .eq("id", bid.smart_account_id).eq("user_id", bid.bidder_user_id).single();
          if (accountError || !primaryWalletReady(account)) {
            throw new Error("WINNER_WALLET_NOT_READY");
          }
          const { data: credentials, error: credentialError } = await service.from("wallet_credentials")
            .select("credential_commitment,owner_address,purpose").eq("smart_account_id", account.id).eq("state", "active");
          if (credentialError) throw new Error("WINNER_WALLET_CREDENTIALS_UNAVAILABLE");
          await attestSmartAccountProfile({ config, account, credentials });
          const verification = await verifyBidIntent({
            config,
            signature: signatureHex(bid.signature),
            intent: {
              auctionId: auction.id,
              workId: work.nft_work_id,
              bidderSafe: getAddress(account.account_address),
              amount: bid.amount,
              currency: bid.currency,
              nonce: bid.intent_nonce,
              validAfter: Math.floor(new Date(bid.valid_after).getTime() / 1000),
              validUntil: Math.floor(new Date(bid.valid_until).getTime() / 1000),
              termsHash: auction.terms_hash,
              settlementRail: auction.settlement_rail,
              originHash: bid.intent_origin_hash,
              chainId: account.chain_id
            }
          });
          if (!verification.valid || verification.intentHash !== bid.intent_hash) throw new Error("WINNER_SIGNATURE_INVALID");
          expectedHighBidId = bid.id;
          expectedIntentHash = verification.intentHash;
          signatureVerifiedBlock = verification.blockNumber.toString();
        }

        const { data: settlement, error: closeError } = await service.rpc("close_auction_for_settlement", {
          auction_uuid: auction.id,
          expected_high_bid_uuid: expectedHighBidId,
          expected_intent_hash: expectedIntentHash,
          signature_verified_block: signatureVerifiedBlock,
          inventory_verified_block: inventoryProof.blockNumber.toString(),
          inventory_verified_block_hash: inventoryProof.blockHash,
          settlement_deadline_at: new Date(Date.now() + config.auctions.settlementHours * 60 * 60_000).toISOString(),
          risk_hold_seconds_value: config.auctions.riskHoldHours * 60 * 60
        });
        if (closeError) throw closeError;
        if (settlement) summary.closed += 1;
        else summary.no_sale += 1;
      } catch (itemError) {
        summary.exceptions += 1;
        await service.from("auctions").update({ state: "exception" }).eq("id", auction.id).eq("state", "open");
        await service.from("auction_events").insert({
          auction_id: auction.id,
          event_type: "auction.close-exception",
          actor_kind: "system",
          event_data: { code: itemError?.code || itemError?.message || "close_error" }
        });
        console.error(JSON.stringify({
          level: "error",
          operation: "auction_close",
          auction_id: auction.id,
          code: itemError?.code || itemError?.message || "close_error"
        }));
      }
    }
    return json(summary, { status: summary.exceptions ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "auction_not_configured", "Auction close is not available.");
    return problem(500, "unexpected_error", "Auction close did not complete.");
  }
};

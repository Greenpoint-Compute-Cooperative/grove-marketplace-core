import { getAddress, isHex } from "viem";
import { verifyBidIntent, requireAuctionConfig } from "../../../lib/server/auction.js";
import { ConfigurationError } from "../../../lib/server/config.js";
import { json, problem, readJson, requestFailure, text } from "../../../lib/server/http.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../../lib/server/supabase.js";
import { attestSmartAccountProfile, primaryWalletReady } from "../../../lib/server/wallet.js";

const uuid = (input) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase()
  : null;
const auctionIdFrom = (request) => uuid(new URL(request.url).pathname.split("/").at(-2) || "");
const integerString = (input) => typeof input === "string" && /^(0|[1-9][0-9]{0,77})$/.test(input) ? input : null;
const timestamp = (input) => {
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const GET = async (request) => {
  try {
    requireAuctionConfig();
    const auctionId = auctionIdFrom(request);
    if (!auctionId) return problem(404, "auction_not_found", "The auction was not found.");
    const { headers } = createSupabaseRequestClient(request);
    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("public_auction_bids")
      .select("id,auction_id,amount,currency,state,accepted_at,bidder_alias")
      .eq("auction_id", auctionId)
      .order("accepted_at", { ascending: false })
      .limit(100);
    if (error) return problem(502, "bids_unavailable", "The bid feed is temporarily unavailable.", headers);
    return json({ bids: data }, { headers: { ...Object.fromEntries(headers), "Cache-Control": "public, max-age=2" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "backend_not_configured", "The auction feed is unavailable.");
    return problem(500, "unexpected_error", "The auction feed could not be loaded.");
  }
};

export const POST = async (request) => {
  try {
    const config = requireAuctionConfig();
    if (request.headers.get("origin") !== config.siteUrl) {
      return problem(403, "origin_not_allowed", "Bids must start from the marketplace.");
    }
    const auctionId = auctionIdFrom(request);
    if (!auctionId) return problem(404, "auction_not_found", "The auction was not found.");
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user, curator } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in before bidding.", headers);
    if (curator?.status !== "active") return problem(403, "bidder_not_invited", "Bidding is limited to active members.", headers);
    const body = await readJson(request, 20_000);
    const amount = integerString(body.amount);
    const nonce = integerString(body.nonce);
    const signature = text(body.signature, { required: true, maximum: 8_194 });
    const requestKey = text(request.headers.get("idempotency-key"), { required: true, maximum: 200 });
    const validAfter = timestamp(body.valid_after);
    const validUntil = timestamp(body.valid_until);
    if (!amount || !nonce || !signature || !isHex(signature) || signature.length % 2 !== 0
      || !requestKey || !/^[A-Za-z0-9._:-]{16,200}$/.test(requestKey) || !validAfter || !validUntil) {
      return problem(422, "invalid_bid", "The signed bid fields are invalid.", headers);
    }

    const service = createSupabaseServiceClient();
    const { data: auction, error: auctionError } = await service
      .from("auctions")
      .select("id,work_id,settlement_rail,bid_currency,state,terms_hash,opens_at,closes_at")
      .eq("id", auctionId)
      .maybeSingle();
    if (auctionError) return problem(502, "auction_unavailable", "The auction could not be checked.", headers);
    if (!auction || auction.state !== "open") return problem(409, "auction_not_open", "The auction is not open.", headers);
    const [{ data: work }, { data: account }] = await Promise.all([
      service.from("works").select("id,nft_work_id,nft_custody_state,contract_status").eq("id", auction.work_id).maybeSingle(),
      service.from("smart_accounts").select("id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,signer_count,threshold,state,recovery_ready,finalized_at").eq("user_id", user.id).maybeSingle()
    ]);
    if (!work || work.nft_custody_state !== "inventory-safe" || work.contract_status !== "minted") {
      return problem(409, "nft_not_in_inventory", "Bidding opens only after the NFT is finalized in inventory.", headers);
    }
    if (!primaryWalletReady(account)) {
      return problem(409, "wallet_not_ready", "Finish deploying your passkey wallet before bidding.", headers);
    }
    const { data: credentials, error: credentialError } = await service.from("wallet_credentials")
      .select("credential_commitment,owner_address,purpose").eq("smart_account_id", account.id).eq("state", "active");
    if (credentialError) return problem(502, "wallet_unavailable", "The Safe configuration could not be checked.", headers);
    await attestSmartAccountProfile({ config, account, credentials });
    let mandateId = null;
    if (auction.settlement_rail === "card") {
      const { data: mandate, error: mandateError } = await service.from("bidder_payment_mandates")
        .select("id,state,expires_at,maximum_hammer_minor,generation")
        .eq("auction_id", auctionId).eq("bidder_user_id", user.id).eq("state", "ready")
        .order("generation", { ascending: false }).limit(1).maybeSingle();
      if (mandateError) return problem(502, "payment_setup_unavailable", "Payment eligibility could not be checked.", headers);
      if (!mandate || mandate.state !== "ready" || new Date(mandate.expires_at) <= new Date() || BigInt(amount) > BigInt(mandate.maximum_hammer_minor)) {
        return problem(409, "payment_setup_required", "Set up Apple Pay or a card for this auction before bidding.", headers);
      }
      mandateId = mandate.id;
    }

    const intent = {
      auctionId,
      workId: work.nft_work_id,
      bidderSafe: getAddress(account.account_address),
      amount,
      currency: auction.bid_currency,
      nonce,
      validAfter: Math.floor(validAfter.getTime() / 1000),
      validUntil: Math.floor(validUntil.getTime() / 1000),
      termsHash: auction.terms_hash,
      settlementRail: auction.settlement_rail,
      origin: config.siteUrl,
      chainId: config.wallet.chainId
    };
    const verification = await verifyBidIntent({ config, intent, signature });
    if (!verification.valid) return problem(422, "signature_invalid", "The Safe did not authorize this bid.", headers);

    const { data: bid, error: bidError } = await service.rpc("place_verified_auction_bid", {
      auction_uuid: auctionId,
      bidder_uuid: user.id,
      account_uuid: account.id,
      mandate_uuid: mandateId,
      bid_amount: amount,
      bid_currency_required: auction.bid_currency,
      bid_nonce: nonce,
      bid_intent_hash: verification.intentHash,
      bid_signature: `\\x${signature.slice(2)}`,
      verified_block: verification.blockNumber.toString(),
      valid_after_at: validAfter.toISOString(),
      valid_until_at: validUntil.toISOString(),
      bid_origin_hash: verification.typedData.message.origin,
      request_key: requestKey
    });
    if (bidError) {
      const conflict = /bid_too_low|auction_not_open|payment_mandate_not_ready|wallet_not_ready|nft_not_in_inventory|idempotency_conflict/.test(bidError.message);
      return problem(conflict ? 409 : 502, conflict ? "bid_rejected" : "bid_unavailable", conflict
        ? "The auction changed before this bid was accepted. Refresh and sign a new bid."
        : "The bid could not be recorded.", headers);
    }
    return json({ bid: { id: bid.id, auction_id: bid.auction_id, amount: bid.amount, currency: bid.currency, state: bid.state, accepted_at: bid.accepted_at } }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "auction_not_configured", "Bidding is not available.");
    return requestFailure(error) || problem(502, "bid_unavailable", "The bid could not be recorded.");
  }
};

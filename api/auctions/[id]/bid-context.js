import { randomBytes } from "node:crypto";
import { getAddress } from "viem";
import { requireAuctionConfig } from "../../../lib/server/auction.js";
import { ConfigurationError } from "../../../lib/server/config.js";
import { json, problem, requestFailure } from "../../../lib/server/http.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../../lib/server/supabase.js";
import { attestSmartAccountProfile, primaryWalletReady } from "../../../lib/server/wallet.js";

const uuid = (input) => typeof input === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase()
  : null;

const auctionIdFrom = (request) => uuid(new URL(request.url).pathname.split("/").at(-2) || "");

const bidNonce = () => BigInt(`0x${randomBytes(16).toString("hex")}`).toString();

export const GET = async (request) => {
  try {
    const config = requireAuctionConfig();
    const auctionId = auctionIdFrom(request);
    if (!auctionId) return problem(404, "auction_not_found", "The auction was not found.");

    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user, curator } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in before bidding.", headers);
    if (curator?.status !== "active") return problem(403, "bidder_not_invited", "Bidding is limited to active members.", headers);

    const service = createSupabaseServiceClient();
    const [{ data: auction, error: auctionError }, { data: account, error: accountError }] = await Promise.all([
      service.from("auctions")
        .select("id,work_id,settlement_rail,bid_currency,state,terms_version,terms_hash,opens_at,closes_at,original_closes_at,quantity,reserve_amount,minimum_increment,maximum_extensions,anti_snipe_extension_seconds,maximum_card_bid_minor,high_bid_id")
        .eq("id", auctionId).maybeSingle(),
      service.from("smart_accounts")
        .select("id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,signer_count,threshold,state,recovery_ready,finalized_at")
        .eq("user_id", user.id).maybeSingle()
    ]);
    if (auctionError || accountError) return problem(502, "bid_context_unavailable", "The bid context could not be loaded.", headers);
    const now = new Date();
    if (!auction || auction.state !== "open" || now < new Date(auction.opens_at) || now >= new Date(auction.closes_at)) {
      return problem(409, "auction_not_open", "The auction is not open.", headers);
    }
    if (!primaryWalletReady(account)) {
      return problem(409, "wallet_not_ready", "Finish deploying your passkey wallet before bidding.", headers);
    }

    const [{ data: work, error: workError }, { data: credentials, error: credentialError }, highBidResult, mandateResult] = await Promise.all([
      service.from("works").select("id,nft_work_id,nft_custody_state,contract_status,nft_quantity").eq("id", auction.work_id).maybeSingle(),
      service.from("wallet_credentials").select("credential_commitment,owner_address,purpose")
        .eq("smart_account_id", account.id).eq("state", "active"),
      auction.high_bid_id
        ? service.from("auction_bids").select("amount").eq("id", auction.high_bid_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      auction.settlement_rail === "card"
        ? service.from("bidder_payment_mandates").select("state,expires_at,maximum_hammer_minor,generation,mandate_terms_version,mandate_terms_hash,ready_at")
          .eq("auction_id", auction.id).eq("bidder_user_id", user.id).eq("state", "ready")
          .order("generation", { ascending: false }).limit(1).maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ]);
    if (workError || credentialError || highBidResult.error || mandateResult.error) {
      return problem(502, "bid_context_unavailable", "The bid context could not be loaded.", headers);
    }
    if (!work || work.nft_custody_state !== "inventory-safe" || work.contract_status !== "minted"
      || BigInt(work.nft_quantity) < BigInt(auction.quantity)) {
      return problem(409, "nft_not_in_inventory", "Bidding opens only after the NFT is finalized in inventory.", headers);
    }

    const attestation = await attestSmartAccountProfile({ config, account, credentials });
    const mandate = mandateResult.data;
    const paymentReady = auction.settlement_rail !== "card" || Boolean(
      mandate?.state === "ready" && mandate.ready_at && new Date(mandate.expires_at) > now
      && mandate.mandate_terms_version === auction.terms_version && mandate.mandate_terms_hash === auction.terms_hash
    );
    const currentAmount = highBidResult.data?.amount ? BigInt(highBidResult.data.amount) : null;
    const minimumIncrement = BigInt(auction.minimum_increment);
    const minimumAmount = currentAmount === null
      ? (BigInt(auction.reserve_amount) > minimumIncrement ? BigInt(auction.reserve_amount) : minimumIncrement)
      : currentAmount + minimumIncrement;
    const validityEnd = new Date(
      new Date(auction.original_closes_at).getTime()
      + (Number(auction.maximum_extensions) * Number(auction.anti_snipe_extension_seconds) + 15 * 60) * 1000
    );

    return json({
      auction: {
        id: auction.id,
        currency: auction.bid_currency,
        settlement_rail: auction.settlement_rail,
        closes_at: auction.closes_at,
        minimum_amount: minimumAmount.toString(),
        maximum_amount: auction.settlement_rail === "card"
          ? String(Math.min(Number(auction.maximum_card_bid_minor), Number(mandate?.maximum_hammer_minor || 0)))
          : null
      },
      payment: { required: auction.settlement_rail === "card", ready: paymentReady },
      intent: {
        auction_id: auction.id,
        work_id: work.nft_work_id,
        bidder_safe: getAddress(account.account_address),
        currency: auction.bid_currency,
        nonce: bidNonce(),
        valid_after: new Date(now.getTime() - 30_000).toISOString(),
        valid_until: validityEnd.toISOString(),
        terms_hash: auction.terms_hash,
        settlement_rail: auction.settlement_rail,
        origin: config.siteUrl,
        chain_id: config.wallet.chainId
      },
      wallet: {
        account_address: getAddress(account.account_address),
        account_runtime_code: attestation.accountRuntimeCode,
        account_code_hash: config.wallet.safeProxyCodeHash,
        passkey_public_key: attestation.passkeyPublicKey,
        threshold: attestation.threshold,
        safe_version: config.wallet.safeVersion,
        entry_point_address: config.wallet.entryPointAddress,
        entry_point_version: config.wallet.entryPointVersion,
        factory_address: config.wallet.safeFactoryAddress,
        singleton_address: config.wallet.safeSingletonAddress,
        safe_4337_module_address: config.wallet.safe4337ModuleAddress,
        shared_signer_address: config.wallet.safeWebAuthnSharedSignerAddress,
        p256_verifier_address: config.wallet.safePasskeyVerifierAddress
      }
    }, { headers: { ...Object.fromEntries(headers), "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "auction_not_configured", "Bidding is not available.");
    return requestFailure(error) || problem(502, "bid_context_unavailable", "The bid context could not be loaded.");
  }
};

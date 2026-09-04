import { getAddress, keccak256, stringToHex } from "viem";
import { ConfigurationError, getRuntimeConfig, requireSecondaryConfig } from "../lib/server/config.js";
import { json, problem, readJson, requestFailure } from "../lib/server/http.js";
import { openSeaAssetUrl, verifyPublishableResaleOrder } from "../lib/server/resale.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../lib/server/supabase.js";
import { attestSmartAccountProfile } from "../lib/server/wallet.js";
import { ZERO_ADDRESS } from "../lib/shared/resale-order.js";

const uuid = (input) => typeof input === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase()
  : null;

const publicOrder = (order) => ({
  ...order,
  gross_amount: String(order.gross_amount),
  seller_proceeds_amount: String(order.seller_proceeds_amount),
  royalty_amount: String(order.royalty_amount),
  marketplace_fee_amount: String(order.marketplace_fee_amount),
  token_id: String(order.token_id),
  open_sea_url: openSeaAssetUrl({ chainId: order.chain_id, contractAddress: order.collection_address, tokenId: order.token_id })
});

export const GET = async (request) => {
  const runtime = getRuntimeConfig();
  const configured = runtime.secondary.rehearsalReady || runtime.secondary.liveReady;
  if (!configured) {
    return json({
      configured: false,
      orders: [],
      protocol: "seaport-1.6",
      open_sea: runtime.wallet.chainId === 11155111 ? "unsupported-on-testnets" : "disabled"
    }, { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=300" } });
  }
  try {
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { data, error } = await supabase.from("public_resale_orders")
      .select("id,work_id,slug,artist_name,title,media_url,chain_id,collection_address,token_id,quantity,seller_address,seaport_address,seaport_version,seaport_order_type,zone_address,conduit_key,currency,currency_address,currency_decimals,gross_amount,seller_proceeds_recipient,seller_proceeds_amount,royalty_recipient,royalty_amount,marketplace_fee_recipient,marketplace_fee_amount,start_time_epoch,end_time_epoch,salt,counter,order_hash,signature,order_components,partial_fills_allowed,state,published_at,terms_version,terms_hash")
      .order("published_at", { ascending: false }).limit(100);
    if (error) return problem(502, "resales_unavailable", "Secondary listings could not be loaded.", headers);
    const managedIds = new Set();
    let managedOrders = [];
    // Base-table RLS returns only rows owned by the current authenticated user.
    // Anonymous grant errors are intentionally treated as an empty ownership set.
    const managed = await supabase.from("resale_orders").select("id,work_id,state")
      .in("state", ["open", "cancel-requested", "cancelled", "expired", "invalidated", "reorged", "exception"])
      .order("created_at", { ascending: false }).limit(100);
    if (!managed.error) {
      managedOrders = managed.data || [];
      for (const order of managedOrders) managedIds.add(order.id);
    }
    return json({
      configured: true,
      orders: data.map((order) => ({ ...publicOrder(order), seller_managed: managedIds.has(order.id) })),
      managed_orders: managedOrders,
      protocol: "seaport-1.6",
      open_sea: runtime.openSea.liveReady ? "mainnet" : runtime.wallet.chainId === 11155111 ? "unsupported-on-testnets" : "disabled"
    }, { headers: { ...Object.fromEntries(headers), "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "secondary_not_configured", "Secondary listings are not available.");
    return problem(500, "unexpected_error", "Secondary listings could not be loaded.");
  }
};

export const POST = async (request) => {
  try {
    const config = requireSecondaryConfig();
    if (request.headers.get("origin") !== config.siteUrl) {
      return problem(403, "origin_not_allowed", "A resale must start from the marketplace.");
    }
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user, curator } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in before listing an NFT.", headers);
    if (curator?.status !== "active") return problem(403, "seller_not_active", "Resale is limited to active members.", headers);
    const body = await readJson(request, 40_000);
    const workId = uuid(body.work_id);
    if (!workId || !body.order || typeof body.signature !== "string") {
      return problem(422, "invalid_listing", "The signed listing is invalid.", headers);
    }

    const service = createSupabaseServiceClient();
    const [{ data: work, error: workError }, { data: account, error: accountError }] = await Promise.all([
      service.from("works").select("id,format,nft_collection_id,nft_token_id,nft_quantity,contract_status").eq("id", workId).maybeSingle(),
      service.from("smart_accounts")
        .select("id,user_id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,signer_count,threshold,state,recovery_ready,finalized_at")
        .eq("user_id", user.id).maybeSingle()
    ]);
    if (workError || accountError) return problem(502, "listing_unavailable", "The listing prerequisites could not be loaded.", headers);
    if (!work || work.format !== "digital" || !work.nft_collection_id || work.contract_status !== "minted" || String(work.nft_quantity) !== "1") {
      return problem(409, "token_not_resellable", "Only a finalized digital ERC-721 can be resold in this release.", headers);
    }
    if (!account || account.state !== "recovery-ready" || !account.recovery_ready || !account.finalized_at) {
      return problem(409, "wallet_not_ready", "Finish passkey recovery setup before listing an NFT.", headers);
    }
    const [{ data: collection, error: collectionError }, { data: credentials, error: credentialError }] = await Promise.all([
      service.from("nft_collections").select("id,standard,chain_id,contract_address,deployed_code_hash,state").eq("id", work.nft_collection_id).maybeSingle(),
      service.from("wallet_credentials").select("credential_commitment,owner_address,purpose")
        .eq("smart_account_id", account.id).eq("state", "active")
    ]);
    if (collectionError || credentialError || !collection) return problem(502, "listing_unavailable", "The token or wallet could not be verified.", headers);
    await attestSmartAccountProfile({ config, account, credentials });
    const verification = await verifyPublishableResaleOrder({ config, account, collection, work, order: body.order, signature: body.signature });
    const { data: ownerProjection, error: ownerError } = await service.from("token_ownership_projection")
      .select("work_id,collection_id,owner_address,ownership_state,finality,observed_block_number,observed_block_hash")
      .eq("chain_id", config.wallet.chainId).eq("collection_address", collection.contract_address)
      .eq("token_id", String(work.nft_token_id)).maybeSingle();
    if (ownerError) return problem(502, "ownership_index_unavailable", "Token ownership could not be checked.", headers);
    if (!ownerProjection || ownerProjection.work_id !== work.id || ownerProjection.collection_id !== collection.id
      || ownerProjection.owner_address !== account.account_address || ownerProjection.ownership_state !== "owned"
      || ownerProjection.finality !== "finalized" || BigInt(ownerProjection.observed_block_number) > BigInt(verification.blockNumber)) {
      return problem(409, "ownership_index_pending", "Wait for finalized ownership indexing before listing this token.", headers);
    }

    const validatedAt = new Date().toISOString();
    const validationEvidenceHash = keccak256(stringToHex(JSON.stringify({
      policy: "seaport-erc721-usdc-v1",
      orderHash: verification.orderHash,
      digest: verification.digest,
      blockNumber: verification.blockNumber,
      blockHash: verification.blockHash,
      ownershipBlock: String(ownerProjection.observed_block_number),
      ownershipBlockHash: ownerProjection.observed_block_hash
    })));
    const approvalEvidenceHash = keccak256(stringToHex(JSON.stringify({
      kind: "ERC721-exact-token",
      token: collection.contract_address,
      tokenId: String(work.nft_token_id),
      operator: config.secondary.protocolAddress,
      blockNumber: verification.blockNumber,
      blockHash: verification.blockHash
    })));
    const zero = getAddress(ZERO_ADDRESS).toLowerCase();
    const record = {
      work_id: work.id,
      collection_id: collection.id,
      seller_user_id: user.id,
      seller_smart_account_id: account.id,
      chain_id: config.wallet.chainId,
      collection_address: collection.contract_address,
      token_id: String(work.nft_token_id),
      quantity: "1",
      seller_address: account.account_address,
      seaport_address: config.secondary.protocolAddress,
      seaport_version: "1.6",
      seaport_order_type: 0,
      zone_address: zero,
      conduit_key: config.secondary.conduitKey,
      partial_fills_allowed: false,
      currency: "USDC",
      currency_address: config.secondary.usdcAddress,
      currency_decimals: 6,
      gross_amount: verification.grossAmount,
      seller_proceeds_recipient: account.account_address,
      seller_proceeds_amount: verification.sellerProceeds,
      royalty_recipient: verification.royaltyAmount === "0" ? zero : verification.royaltyRecipient,
      royalty_amount: verification.royaltyAmount,
      marketplace_fee_recipient: verification.marketplaceAmount === "0" ? zero : config.secondary.feeRecipient,
      marketplace_fee_amount: verification.marketplaceAmount,
      start_time_epoch: verification.order.startTime,
      end_time_epoch: verification.order.endTime,
      salt: verification.order.salt,
      counter: verification.order.counter,
      order_hash: verification.orderHash,
      signature: `\\x${body.signature.slice(2)}`,
      order_components: verification.order,
      validation_policy_version: "seaport-erc721-usdc-v1",
      validation_evidence_hash: validationEvidenceHash,
      validated_block_number: verification.blockNumber,
      validated_block_hash: verification.blockHash,
      validated_at: validatedAt,
      approval_kind: "ERC721-exact-token",
      approval_operator_address: config.secondary.protocolAddress,
      approval_evidence_hash: approvalEvidenceHash,
      approval_verified_block_number: verification.blockNumber,
      approval_verified_block_hash: verification.blockHash,
      approval_verified_at: validatedAt,
      terms_version: config.secondary.termsVersion,
      terms_hash: config.secondary.termsHash,
      state: "open"
    };
    const { data: inserted, error: insertError } = await service.from("resale_orders").insert(record).select("id,order_hash,state,published_at").single();
    if (insertError) {
      if (insertError.code === "23505") {
        const existing = await service.from("resale_orders").select("id,order_hash,state,published_at,seller_user_id")
          .eq("order_hash", verification.orderHash).maybeSingle();
        if (!existing.error && existing.data?.seller_user_id === user.id) {
          return json({ listing: { id: existing.data.id, order_hash: existing.data.order_hash, state: existing.data.state, published_at: existing.data.published_at }, publication: "already-recorded" }, { headers });
        }
      }
      return problem(409, "listing_conflict", "The token already has an unresolved listing or its indexed state changed.", headers);
    }
    let publication = config.wallet.chainId === 11155111 ? "unsupported-on-opensea-testnets" : "disabled";
    if (config.openSea.liveReady) {
      const queued = await service.from("resale_order_publications").insert({ resale_order_id: inserted.id, provider: "opensea", state: "pending" });
      if (queued.error) {
        await service.from("resale_orders").update({ state: "exception" }).eq("id", inserted.id);
        return problem(503, "publication_queue_failed", "The listing was verified but OpenSea publication needs operator reconciliation.", headers);
      }
      publication = "queued";
    }
    return json({ listing: inserted, publication }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "secondary_not_configured", "Secondary sales are not available.");
    return requestFailure(error) || problem(422, "listing_rejected", "The listing did not pass wallet, ownership, approval, or order validation.");
  }
};

import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { ConfigurationError, requireSecondaryConfig } from "../../../lib/server/config.js";
import { json, problem, requestFailure } from "../../../lib/server/http.js";
import { buildResaleFulfillment, verifyBuyerFunds, verifyPublishableResaleOrder } from "../../../lib/server/resale.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../../lib/server/supabase.js";
import { attestSmartAccountProfile } from "../../../lib/server/wallet.js";
import { usdcApprovalCall } from "../../../lib/shared/secondary-actions.js";

const uuid = (input) => typeof input === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase()
  : null;
const orderIdFrom = (request) => uuid(new URL(request.url).pathname.split("/").at(-2) || "");

export const GET = async (request) => {
  try {
    const config = requireSecondaryConfig();
    const orderId = orderIdFrom(request);
    if (!orderId) return problem(404, "listing_not_found", "The listing was not found.");
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user, curator } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in before buying an NFT.", headers);
    if (curator?.status !== "active") return problem(403, "buyer_not_active", "Secondary purchases are limited to active members.", headers);
    const service = createSupabaseServiceClient();
    const [{ data: order, error: orderError }, { data: buyer, error: buyerError }] = await Promise.all([
      service.from("resale_orders")
        .select("id,work_id,collection_id,seller_smart_account_id,chain_id,gross_amount,end_time_epoch,order_hash,signature,order_components,state")
        .eq("id", orderId).maybeSingle(),
      service.from("smart_accounts")
        .select("id,user_id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,signer_count,threshold,state,recovery_ready,finalized_at")
        .eq("user_id", user.id).maybeSingle()
    ]);
    if (orderError || buyerError) return problem(502, "fulfillment_unavailable", "The purchase context could not be loaded.", headers);
    if (!order || order.state !== "open" || BigInt(order.end_time_epoch) <= BigInt(Math.floor(Date.now() / 1_000))) {
      return problem(409, "listing_not_open", "This listing is no longer open.", headers);
    }
    if (!buyer || buyer.state !== "recovery-ready" || !buyer.recovery_ready || !buyer.finalized_at) {
      return problem(409, "wallet_not_ready", "Finish passkey recovery setup before buying an NFT.", headers);
    }
    if (order.seller_smart_account_id === buyer.id) {
      return problem(409, "self_purchase_rejected", "A seller cannot buy their own listing.", headers);
    }
    const [workResult, collectionResult, sellerResult, credentialResult] = await Promise.all([
      service.from("works").select("id,format,nft_collection_id,nft_token_id,nft_quantity,contract_status").eq("id", order.work_id).single(),
      service.from("nft_collections").select("id,standard,chain_id,contract_address,deployed_code_hash,state").eq("id", order.collection_id).single(),
      service.from("smart_accounts").select("id,chain_id,account_address,state,recovery_ready,finalized_at").eq("id", order.seller_smart_account_id).single(),
      service.from("wallet_credentials").select("credential_commitment,owner_address,purpose")
        .eq("smart_account_id", buyer.id).eq("state", "active")
    ]);
    if (workResult.error || collectionResult.error || sellerResult.error || credentialResult.error) {
      return problem(502, "fulfillment_unavailable", "The listing or buyer wallet could not be verified.", headers);
    }
    await attestSmartAccountProfile({ config, account: buyer, credentials: credentialResult.data });
    const signature = `0x${Buffer.from(order.signature.slice(2), "hex").toString("hex")}`;
    const listingVerification = await verifyPublishableResaleOrder({
      config,
      account: sellerResult.data,
      collection: collectionResult.data,
      work: workResult.data,
      order: order.order_components,
      signature
    });
    if (listingVerification.orderHash !== order.order_hash || listingVerification.grossAmount !== String(order.gross_amount)) {
      return problem(409, "listing_changed", "This listing changed before purchase.", headers);
    }
    const funds = await verifyBuyerFunds({ config, buyerAddress: buyer.account_address, grossAmount: listingVerification.grossAmount });
    if (!funds.sufficient) return problem(409, "usdc_balance_low", "The member Safe does not hold enough USDC for this listing.", headers);
    const fulfillment = buildResaleFulfillment({
      config,
      order: listingVerification.order,
      signature,
      buyerAddress: buyer.account_address
    });
    const allowance = BigInt(funds.allowance);
    const gross = BigInt(listingVerification.grossAmount);
    let nextAction;
    if (allowance !== 0n && allowance !== gross) {
      const call = usdcApprovalCall({
        usdcAddress: config.secondary.usdcAddress,
        protocolAddress: config.secondary.protocolAddress,
        amount: gross,
        revoke: true
      });
      nextAction = { action: "resale-revoke-usdc", expected_call: { ...call, value: "0" } };
    } else if (allowance === 0n) {
      nextAction = { action: "resale-approve-usdc", expected_call: fulfillment.approvals[0] };
    } else {
      nextAction = { action: "resale-fulfill", expected_call: fulfillment.fulfillment };
    }
    nextAction.request_key = randomUUID();
    nextAction.sponsor_request = {
      stage: "prepare",
      request_key: nextAction.request_key,
      action: nextAction.action,
      listing_id: order.id
    };
    return json({
      listing: { id: order.id, order_hash: order.order_hash, gross_amount: listingVerification.grossAmount, currency: "USDC" },
      buyer: { account_address: getAddress(buyer.account_address), balance: funds.balance, allowance: funds.allowance },
      actions: fulfillment,
      next_action: nextAction,
      sponsorship: { required: true, policy_actions: ["resale-revoke-usdc", "resale-approve-usdc", "resale-fulfill"] }
    }, { headers: { ...Object.fromEntries(headers), "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "secondary_not_configured", "Secondary sales are not available.");
    return requestFailure(error) || problem(502, "fulfillment_unavailable", "The purchase context could not be prepared.");
  }
};

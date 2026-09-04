import { requireSecondaryConfig } from "./config.js";
import { problem } from "./http.js";
import { prepareResaleSellerActions } from "./resale.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "./supabase.js";
import { attestSmartAccountProfile } from "./wallet.js";

const uuid = (input) => typeof input === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase()
  : null;

const orderIdFrom = (request) => uuid(new URL(request.url).pathname.split("/").at(-2) || "");

export const loadAuthenticatedResaleSellerAction = async (request) => {
  const config = requireSecondaryConfig();
  if (request.headers.get("origin") !== config.siteUrl) {
    return { response: problem(403, "origin_not_allowed", "A seller action must start from the marketplace.") };
  }
  const orderId = orderIdFrom(request);
  if (!orderId) return { response: problem(404, "listing_not_found", "The listing was not found.") };

  const { supabase, headers } = createSupabaseRequestClient(request);
  const { user } = await getAuthenticatedCurator(supabase);
  if (!user) return { response: problem(401, "not_authenticated", "Sign in before changing a listing.", headers) };

  const service = createSupabaseServiceClient();
  const { data: order, error: orderError } = await service.from("resale_orders")
    .select("id,work_id,collection_id,seller_user_id,seller_smart_account_id,chain_id,collection_address,token_id,order_hash,order_components,state,end_time_epoch")
    .eq("id", orderId).eq("seller_user_id", user.id).maybeSingle();
  if (orderError) {
    return { response: problem(502, "seller_action_unavailable", "The listing could not be checked.", headers) };
  }
  // Do not reveal whether an order exists when it is owned by another member.
  if (!order) return { response: problem(404, "listing_not_found", "The listing was not found.", headers) };

  const [workResult, collectionResult, accountResult, credentialResult] = await Promise.all([
    service.from("works")
      .select("id,format,nft_collection_id,nft_token_id,nft_quantity,contract_status")
      .eq("id", order.work_id).single(),
    service.from("nft_collections")
      .select("id,standard,chain_id,contract_address,deployed_code_hash,state")
      .eq("id", order.collection_id).single(),
    service.from("smart_accounts")
      .select("id,user_id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,signer_count,threshold,state,recovery_ready,finalized_at")
      .eq("id", order.seller_smart_account_id).eq("user_id", user.id).single(),
    service.from("wallet_credentials").select("credential_commitment,owner_address,purpose")
      .eq("smart_account_id", order.seller_smart_account_id).eq("state", "active")
  ]);
  if (workResult.error || collectionResult.error || accountResult.error || credentialResult.error) {
    return { response: problem(502, "seller_action_unavailable", "The token or seller Safe could not be checked.", headers) };
  }
  if (Number(order.chain_id) !== config.wallet.chainId
    || workResult.data.nft_collection_id !== order.collection_id
    || String(workResult.data.nft_token_id) !== String(order.token_id)
    || collectionResult.data.contract_address !== order.collection_address) {
    return { response: problem(409, "listing_identity_mismatch", "The stored listing identity no longer matches the token.", headers) };
  }

  await attestSmartAccountProfile({
    config,
    account: accountResult.data,
    credentials: credentialResult.data
  });
  const inspection = await prepareResaleSellerActions({
    config,
    account: accountResult.data,
    collection: collectionResult.data,
    work: workResult.data,
    order: order.order_components,
    expectedOrderHash: order.order_hash
  });
  return { config, headers, order, inspection };
};

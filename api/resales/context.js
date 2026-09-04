import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { ConfigurationError, requireSecondaryConfig } from "../../lib/server/config.js";
import { json, problem, readJson, requestFailure } from "../../lib/server/http.js";
import { prepareResaleOrderContext } from "../../lib/server/resale.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../lib/server/supabase.js";
import { attestSmartAccountProfile } from "../../lib/server/wallet.js";

const uuid = (input) => typeof input === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase()
  : null;
const integer = (input) => typeof input === "string" && /^[1-9][0-9]{0,77}$/.test(input) ? input : null;

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
    const body = await readJson(request);
    const workId = uuid(body.work_id);
    const grossAmount = integer(body.gross_amount);
    const durationSeconds = Number(body.duration_seconds);
    if (!workId || !grossAmount || !Number.isSafeInteger(durationSeconds)) {
      return problem(422, "invalid_listing", "The listing price or duration is invalid.", headers);
    }

    const service = createSupabaseServiceClient();
    const [{ data: work, error: workError }, { data: account, error: accountError }] = await Promise.all([
      service.from("works")
        .select("id,format,nft_collection_id,nft_token_id,nft_quantity,nft_custody_state,contract_status")
        .eq("id", workId).maybeSingle(),
      service.from("smart_accounts")
        .select("id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,signer_count,threshold,state,recovery_ready,finalized_at")
        .eq("user_id", user.id).maybeSingle()
    ]);
    if (workError || accountError) return problem(502, "listing_context_unavailable", "The listing context could not be loaded.", headers);
    if (!work || work.format !== "digital" || !work.nft_collection_id || work.contract_status !== "minted"
      || String(work.nft_quantity) !== "1") {
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
    if (collectionError || credentialError || !collection) {
      return problem(502, "listing_context_unavailable", "The token or wallet could not be verified.", headers);
    }
    const attestation = await attestSmartAccountProfile({ config, account, credentials });
    const context = await prepareResaleOrderContext({ config, account, collection, work, grossAmount, durationSeconds });
    const approvalRequestKey = context.approval.required ? randomUUID() : null;
    const approval = {
      ...context.approval,
      action: context.approval.required ? {
        action: "resale-approve-token",
        request_key: approvalRequestKey,
        expected_call: context.approval.transaction,
        sponsor_request: {
          stage: "prepare",
          request_key: approvalRequestKey,
          action: "resale-approve-token",
          work_id: work.id
        }
      } : null
    };
    return json({
      listing: {
        work_id: work.id,
        collection_address: getAddress(collection.contract_address),
        token_id: String(work.nft_token_id),
        currency: "USDC",
        gross_amount: grossAmount,
        protocol: "seaport-1.6",
        protocol_address: getAddress(config.secondary.protocolAddress),
        origin: config.siteUrl,
        order_hash: context.orderHash,
        order: context.order,
        typed_data: context.typedData,
        evidence: context.evidence,
        approval
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
    if (error instanceof ConfigurationError) return problem(503, "secondary_not_configured", "Secondary sales are not available.");
    return requestFailure(error) || problem(502, "listing_context_unavailable", "The listing context could not be loaded.");
  }
};

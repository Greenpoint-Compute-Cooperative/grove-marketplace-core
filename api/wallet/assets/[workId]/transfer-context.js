import { randomUUID } from "node:crypto";
import { ConfigurationError, requireOwnerExitConfig } from "../../../../lib/server/config.js";
import { json, problem, readJson, requestFailure } from "../../../../lib/server/http.js";
import { resolveSecondaryActionContext } from "../../../../lib/server/secondary-sponsorship.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../../../lib/server/supabase.js";

const uuid = (input) => typeof input === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase() : null;
const workIdFrom = (request) => uuid(new URL(request.url).pathname.split("/").at(-2) || "");

export const POST = async (request) => {
  try {
    const config = requireOwnerExitConfig();
    if (request.headers.get("origin") !== config.siteUrl) {
      return problem(403, "origin_not_allowed", "An NFT transfer must start from the marketplace.");
    }
    const workId = workIdFrom(request);
    if (!workId) return problem(404, "wallet_asset_not_found", "The NFT was not found.");
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in before moving an NFT.", headers);
    const body = await readJson(request);
    const service = createSupabaseServiceClient();
    const { data: account, error: accountError } = await service.from("smart_accounts")
      .select("id,user_id,chain_id,account_address,state,recovery_ready,finalized_at")
      .eq("user_id", user.id).eq("chain_id", config.wallet.chainId).maybeSingle();
    if (accountError) return problem(502, "wallet_asset_unavailable", "The owner wallet could not be checked.", headers);
    if (!account || !["deployed", "recovery-ready"].includes(account.state) || !account.finalized_at) {
      return problem(409, "wallet_not_ready", "Activate the passkey Safe before moving an NFT.", headers);
    }

    const requestKey = randomUUID();
    const sponsorRequest = {
      stage: "prepare",
      request_key: requestKey,
      action: "marketplace-transfer",
      work_id: workId,
      recipient_address: body.recipient_address
    };
    const action = await resolveSecondaryActionContext({
      service, config, userId: user.id, account, body: sponsorRequest
    });
    return json({
      action: "marketplace-transfer",
      request_key: requestKey,
      expected_call: action.expected,
      sponsor_request: sponsorRequest,
      confirmation: {
        network: config.wallet.chainId === 11155111 ? "Ethereum Sepolia" : "Ethereum mainnet",
        standard: "ERC721",
        collection_address: action.reference.collection_id ? action.call.to : null,
        token_id: action.reference.token_id,
        from_address: account.account_address,
        recipient_address: action.reference.recipient_address,
        irreversible: true,
        gas: "sponsored"
      }
    }, { status: 201, headers: { ...Object.fromEntries(headers), "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return problem(503, "owner_exit_not_configured", "NFT transfer-out is not yet enabled in this environment.");
    }
    if (/INVALID_SPONSORSHIP_REQUEST|RECIPIENT_REJECTED|CALL_REJECTED/.test(error.message)) {
      return problem(422, "owner_exit_recipient_invalid", "Enter a different Ethereum address you control.");
    }
    if (/NOT_OWNED/.test(error.message)) {
      return problem(409, "owner_exit_not_owned", "Finalized chain ownership no longer shows this NFT in your Safe.");
    }
    if (/MUST_FINALIZE|REVOKE_REQUIRED/.test(error.message)) {
      return problem(409, "owner_exit_rejected", "Cancel listings and revoke approvals before moving this NFT.");
    }
    return requestFailure(error) || problem(502, "owner_exit_unavailable", "The NFT transfer could not be prepared.");
  }
};

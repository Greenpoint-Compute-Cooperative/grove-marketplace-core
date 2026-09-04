import { randomBytes } from "node:crypto";
import { getAddress, isAddress, keccak256 } from "viem";
import { ConfigurationError } from "../../lib/server/config.js";
import { json, problem, readJson, requestFailure } from "../../lib/server/http.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../lib/server/supabase.js";
import { requireWalletConfig } from "../../lib/server/wallet.js";
import { originIdentifier } from "../../lib/shared/wallet-link.js";

export const POST = async (request) => {
  try {
    const config = requireWalletConfig();
    if (request.headers.get("origin") !== config.siteUrl) return problem(403, "origin_not_allowed", "Wallet linking must start from the marketplace.");
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user, curator } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in before linking a wallet.", headers);
    if (curator?.status !== "active") return problem(403, "member_not_active", "Wallet linking is limited to active members.", headers);
    const body = await readJson(request);
    if (!isAddress(body.account_address, { strict: true })) return problem(422, "invalid_wallet", "The Safe address is invalid.", headers);
    const accountAddress = getAddress(body.account_address).toLowerCase();
    const service = createSupabaseServiceClient();
    const { data: account, error } = await service.from("smart_accounts")
      .select("id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,state,finalized_at").eq("user_id", user.id).eq("account_address", accountAddress).maybeSingle();
    if (error) return problem(502, "wallet_unavailable", "The Safe could not be checked.", headers);
    if (!account || !["deployed", "recovery-ready"].includes(account.state) || !account.finalized_at) {
      return problem(409, "wallet_not_deployed", "The verified Safe must be deployed before linking.", headers);
    }
    const challenge = `0x${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const { data: stored, error: storeError } = await service.from("wallet_link_challenges").insert({
      user_id: user.id,
      smart_account_id: account.id,
      challenge_hash: keccak256(challenge),
      origin_hash: originIdentifier(config.siteUrl),
      expires_at: expiresAt.toISOString()
    }).select("id").single();
    if (storeError) return problem(502, "wallet_challenge_unavailable", "A wallet challenge could not be created.", headers);
    return json({
      challenge_id: stored.id,
      challenge,
      account_address: accountAddress,
      origin: config.siteUrl,
      chain_id: config.wallet.chainId,
      expires_at: expiresAt.toISOString()
    }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "wallet_not_configured", "Wallet linking is not available.");
    return requestFailure(error) || problem(502, "wallet_challenge_unavailable", "A wallet challenge could not be created.");
  }
};

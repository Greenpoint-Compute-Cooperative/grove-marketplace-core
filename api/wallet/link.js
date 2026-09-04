import { getAddress, hashTypedData, isAddress, isHex, keccak256 } from "viem";
import { ConfigurationError } from "../../lib/server/config.js";
import { json, problem, readJson, requestFailure, text } from "../../lib/server/http.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../lib/server/supabase.js";
import { attestSmartAccountProfile, requireWalletConfig, verifyErc1271Hash } from "../../lib/server/wallet.js";
import { buildWalletLinkTypedData, originIdentifier } from "../../lib/shared/wallet-link.js";

const uuid = (input) => typeof input === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase()
  : null;

export const POST = async (request) => {
  try {
    const config = requireWalletConfig();
    if (request.headers.get("origin") !== config.siteUrl) return problem(403, "origin_not_allowed", "Wallet linking must start from the marketplace.");
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user, curator } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in before linking a wallet.", headers);
    if (curator?.status !== "active") return problem(403, "member_not_active", "Wallet linking is limited to active members.", headers);
    const body = await readJson(request, 20_000);
    const challengeId = uuid(body.challenge_id);
    const challenge = text(body.challenge, { required: true, maximum: 66 });
    const signature = text(body.signature, { required: true, maximum: 8_194 });
    if (!challengeId || !isHex(challenge, { size: 32 }) || !isHex(signature) || signature.length % 2 !== 0
      || !isAddress(body.account_address, { strict: true })) {
      return problem(422, "wallet_proof_invalid", "The wallet-link proof is invalid.", headers);
    }
    const accountAddress = getAddress(body.account_address).toLowerCase();
    const service = createSupabaseServiceClient();
    const [{ data: account }, { data: storedChallenge }] = await Promise.all([
      service.from("smart_accounts").select("id,chain_id,account_address,safe_version,module_version,entry_point_address,factory_address,code_hash,signer_count,threshold,state,recovery_ready,finalized_at").eq("user_id", user.id)
        .eq("account_address", accountAddress).maybeSingle(),
      service.from("wallet_link_challenges").select("id,user_id,smart_account_id,challenge_hash,origin_hash,expires_at,consumed_at")
        .eq("id", challengeId).eq("user_id", user.id).maybeSingle()
    ]);
    if (!account || !storedChallenge || storedChallenge.smart_account_id !== account.id
      || storedChallenge.consumed_at || new Date(storedChallenge.expires_at) <= new Date()
      || storedChallenge.challenge_hash !== keccak256(challenge)
      || storedChallenge.origin_hash !== originIdentifier(config.siteUrl)) {
      return problem(409, "wallet_challenge_invalid", "The wallet challenge is invalid or expired.", headers);
    }
    const typedData = buildWalletLinkTypedData({
      challenge,
      safe: getAddress(accountAddress),
      origin: config.siteUrl,
      expiresAt: Math.floor(new Date(storedChallenge.expires_at).getTime() / 1000),
      chainId: config.wallet.chainId
    });
    const { data: credentials, error: credentialError } = await service.from("wallet_credentials")
      .select("credential_commitment,owner_address,purpose").eq("smart_account_id", account.id).eq("state", "active");
    if (credentialError) return problem(502, "wallet_unavailable", "The Safe configuration could not be checked.", headers);
    await attestSmartAccountProfile({ config, account, credentials });
    const typedDataHash = hashTypedData(typedData);
    const verification = await verifyErc1271Hash({ config, address: getAddress(accountAddress), hash: typedDataHash, signature });
    if (!verification.valid) return problem(422, "wallet_signature_invalid", "The Safe did not authorize this link.", headers);
    const { data: linked, error } = await service.rpc("finalize_wallet_link", {
      challenge_uuid: challengeId,
      member_uuid: user.id,
      account_uuid: account.id,
      expected_challenge_hash: storedChallenge.challenge_hash,
      signed_typed_data_hash: typedDataHash,
      verified_block: verification.blockNumber.toString()
    });
    if (error) return problem(409, "wallet_link_conflict", "The wallet challenge changed before it was accepted.", headers);
    return json({ wallet: { account_address: accountAddress, verified_at: linked.verified_at, chain_id: config.wallet.chainId } }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "wallet_not_configured", "Wallet linking is not available.");
    return requestFailure(error) || problem(502, "wallet_link_unavailable", "The wallet could not be linked.");
  }
};

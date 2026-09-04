import { getAddress, isAddress, isHex } from "viem";
import { ConfigurationError } from "../../lib/server/config.js";
import { json, problem, readJson, requestFailure } from "../../lib/server/http.js";
import {
  createRecoveryChallenge,
  buildSafeProvisioningPlan,
  findFinalizedSafeFactoryDeployment,
  passkeyCredentialCommitment,
  verifyFinalizedSafeDeployment,
  verifyRecoveryAuthorization
} from "../../lib/server/wallet-provisioning.js";
import { requireWalletIdentityConfig } from "../../lib/server/wallet.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../lib/server/supabase.js";

const accountColumns = [
  "id", "user_id", "chain_id", "account_address", "safe_version", "module_version",
  "entry_point_address", "factory_address", "code_hash", "signer_count", "threshold",
  "recovery_ready", "state", "deployment_userop_hash", "deployment_tx_hash", "deployment_block",
  "deployment_block_hash", "finalized_at", "provisioning_commitment", "factory_data_hash",
  "salt_nonce_text", "prepared_finalized_block", "prepared_finalized_block_hash", "provisioned_at"
].join(",");

const authenticatedContext = async (request) => {
  const config = requireWalletIdentityConfig();
  if (request.headers.get("origin") !== config.siteUrl) {
    return { response: problem(403, "origin_not_allowed", "Wallet provisioning must start from the marketplace.") };
  }
  const context = createSupabaseRequestClient(request);
  const identity = await getAuthenticatedCurator(context.supabase);
  if (!identity.user) {
    return { response: problem(401, "not_authenticated", "Sign in before creating a passkey wallet.", context.headers) };
  }
  if (identity.curator?.status !== "active") {
    return { response: problem(403, "member_not_active", "Wallet creation is limited to active members.", context.headers) };
  }
  return { config, ...context, ...identity };
};

const publicKey = (input) => isHex(input, { size: 64 }) ? input.toLowerCase() : null;
const recoveryAddress = (input) => isAddress(input, { strict: true }) ? getAddress(input) : null;
const hash = (input) => isHex(input, { size: 32 }) ? input.toLowerCase() : null;
const walletActivationResponse = (account) => ({
  account_address: account.account_address,
  chain_id: Number(account.chain_id),
  state: account.state,
  recovery_ready: account.recovery_ready,
  deployment_userop_hash: account.deployment_userop_hash,
  deployment_transaction_hash: account.deployment_tx_hash,
  deployment_block: String(account.deployment_block),
  deployment_block_hash: account.deployment_block_hash,
  finalized_at: account.finalized_at
});

export const POST = async (request) => {
  let context;
  try {
    context = await authenticatedContext(request);
    if (context.response) return context.response;
    const body = await readJson(request, 24_000);
    const passkeyPublicKey = publicKey(body.passkey_public_key);
    const recovery = recoveryAddress(body.recovery_address);
    if (!["challenge", "prepare", "activate", "status"].includes(body.stage)) {
      return problem(422, "invalid_provisioning_stage", "Choose challenge, prepare, status, or activate.", context.headers);
    }
    const service = createSupabaseServiceClient();

    if (body.stage === "challenge") {
      if (!passkeyPublicKey || !recovery) {
        return problem(422, "invalid_wallet_configuration", "Provide a valid passkey public key and recovery address.", context.headers);
      }
      const challenge = createRecoveryChallenge({
        config: context.config,
        userId: context.user.id,
        passkeyPublicKey,
        recoveryAddress: recovery
      });
      const { data: issued, error: challengeError } = await service.rpc("issue_wallet_recovery_challenge", {
        member_uuid: context.user.id,
        expected_challenge_hash: challenge.challengeHash,
        expected_passkey_commitment: passkeyCredentialCommitment(passkeyPublicKey),
        expected_recovery_address: recovery.toLowerCase(),
        expected_origin_hash: challenge.originHash,
        expected_expires_at: new Date(challenge.expires_at * 1_000).toISOString()
      });
      if (challengeError || issued !== true) throw challengeError || new Error("WALLET_RECOVERY_CHALLENGE_UNAVAILABLE");
      return json({
        stage: "challenge",
        recovery_address: recovery,
        passkey_public_key: passkeyPublicKey,
        nonce: challenge.nonce,
        expires_at: challenge.expires_at,
        message: challenge.message
      }, { status: 201, headers: context.headers });
    }

    if (body.stage === "prepare") {
      if (!passkeyPublicKey || (body.recovery_address && !recovery)) {
        return problem(422, "invalid_wallet_configuration", "Provide a valid passkey public key and optional recovery address.", context.headers);
      }
      const authorization = recovery
        ? await verifyRecoveryAuthorization({
          config: context.config,
          userId: context.user.id,
          passkeyPublicKey,
          recoveryAddress: recovery,
          proof: body.recovery_proof
        })
        : null;
      const plan = await buildSafeProvisioningPlan({
        config: context.config,
        passkeyPublicKey,
        recoveryAddress: recovery
      });
      if (!plan.verifiedBlockHash) throw new Error("FINALIZED_INFRASTRUCTURE_BLOCK_MISSING");
      const { data: account, error } = await service.rpc("prepare_smart_account_provisioning", {
        member_uuid: context.user.id,
        expected_chain_id: context.config.wallet.chainId,
        expected_account_address: plan.accountAddress.toLowerCase(),
        expected_safe_version: context.config.wallet.safeVersion,
        expected_module_version: context.config.wallet.moduleVersion,
        expected_entry_point_address: context.config.wallet.entryPointAddress,
        expected_factory_address: plan.factoryAddress.toLowerCase(),
        expected_code_hash: context.config.wallet.safeProxyCodeHash,
        expected_shared_signer_address: context.config.wallet.safeWebAuthnSharedSignerAddress,
        owner_credential_commitment: plan.passkeyCommitment,
        recovery_owner_address: plan.recoveryAddress?.toLowerCase() || null,
        recovery_credential_commitment: plan.recoveryCommitment,
        expected_provisioning_commitment: plan.provisioningCommitment,
        expected_factory_data_hash: plan.factoryDataHash,
        expected_salt_nonce: plan.saltNonce,
        verified_finalized_block: plan.verifiedBlockNumber.toString(),
        verified_finalized_block_hash: plan.verifiedBlockHash,
        verified_recovery_proof_hash: authorization?.proofHash || null,
        expected_recovery_challenge_hash: authorization?.challengeHash || null,
        expected_origin_hash: authorization?.originHash || null
      });
      if (error || !account) throw error || new Error("SMART_ACCOUNT_PREPARE_FAILED");
      return json({
        stage: ["deployed", "recovery-ready"].includes(account.state) ? "active" : "prepared",
        account_id: account.id,
        account_address: plan.accountAddress,
        chain_id: context.config.wallet.chainId,
        entry_point_address: context.config.wallet.entryPointAddress,
        factory_address: plan.factoryAddress,
        factory_data: plan.factoryData,
        factory_data_hash: plan.factoryDataHash,
        provisioning_commitment: plan.provisioningCommitment,
        passkey_credential_commitment: plan.passkeyCommitment,
        salt_nonce: plan.saltNonce,
        threshold: 1,
        owners: {
          passkey_shared_signer: context.config.wallet.safeWebAuthnSharedSignerAddress,
          recovery_address: plan.recoveryAddress
        },
        verified_finalized_block: plan.verifiedBlockNumber.toString()
      }, { status: ["deployed", "recovery-ready"].includes(account.state) ? 200 : 201, headers: context.headers });
    }

    const { data: account, error: accountError } = await service.from("smart_accounts")
      .select(accountColumns).eq("user_id", context.user.id).maybeSingle();
    if (accountError) throw accountError;
    if (!account) {
      if (body.stage === "status") return json({ stage: "unprepared" }, { status: 200, headers: context.headers });
      return problem(409, "wallet_not_prepared", "Prepare the passkey wallet before activation.", context.headers);
    }
    if (body.stage === "status" && ["deployed", "recovery-ready"].includes(account.state) && account.finalized_at) {
      return json({ stage: "active", wallet: walletActivationResponse(account) }, { status: 200, headers: context.headers });
    }
    if (body.stage === "status" && (!account.provisioning_commitment || account.prepared_finalized_block === null)) {
      return problem(409, "wallet_not_prepared", "Prepare the passkey wallet before checking deployment status.", context.headers);
    }
    const { data: credentials, error: credentialError } = await service.from("wallet_credentials")
      .select("credential_commitment,owner_address,purpose,state")
      .eq("smart_account_id", account.id).eq("state", "active");
    if (credentialError) throw credentialError;
    let deploymentUserOpHash;
    let deploymentTransactionHash;
    let discovery;
    if (body.stage === "status") {
      discovery = await findFinalizedSafeFactoryDeployment({
        config: context.config,
        accountAddress: account.account_address,
        fromBlock: account.prepared_finalized_block
      });
      if (!discovery.transactionHash) {
        return json({
          stage: "prepared",
          account_address: account.account_address,
          chain_id: Number(account.chain_id),
          provisioning_commitment: account.provisioning_commitment,
          verified_finalized_block: String(account.prepared_finalized_block),
          deployment: {
            status: "pending",
            checked_through_block: discovery.finalizedBlockNumber.toString()
          }
        }, { status: 200, headers: context.headers });
      }
      deploymentUserOpHash = null;
      deploymentTransactionHash = discovery.transactionHash;
    } else {
      deploymentUserOpHash = hash(body.deployment_userop_hash);
      deploymentTransactionHash = hash(body.deployment_transaction_hash);
      if ((body.deployment_userop_hash && !deploymentUserOpHash) || !deploymentTransactionHash) {
        return problem(422, "invalid_deployment_evidence", "Provide a valid deployment transaction and optional UserOperation hash.", context.headers);
      }
    }
    const evidence = await verifyFinalizedSafeDeployment({
      config: context.config,
      account,
      credentials,
      deploymentUserOpHash,
      deploymentTransactionHash
    });
    const { data: activated, error: activationError } = await service.rpc("activate_smart_account_provisioning", {
      member_uuid: context.user.id,
      account_uuid: account.id,
      expected_provisioning_commitment: evidence.provisioningCommitment,
      finalized_userop_hash: evidence.userOperationHash,
      finalized_transaction_hash: evidence.transactionHash,
      finalized_block_number: evidence.blockNumber.toString(),
      finalized_block_hash: evidence.blockHash
    });
    if (activationError || !activated) throw activationError || new Error("SMART_ACCOUNT_ACTIVATION_FAILED");
    return json({ stage: "active", wallet: walletActivationResponse(activated) }, { status: 200, headers: context.headers });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return problem(503, "wallet_identity_not_configured", "Passkey wallet creation is not available.", context?.headers);
    }
    if (/NOT_FINALIZED|REORGED|EVENT|COMMITMENT|CODE_HASH|CHAIN_MISMATCH|SCAN_RANGE/.test(error.message)) {
      return problem(409, "wallet_deployment_unverified", "The Safe deployment is not finalized or does not match the prepared wallet.", context?.headers);
    }
    if (/CONFLICT|ALREADY/.test(error.message)) {
      return problem(409, "wallet_provisioning_conflict", "A different wallet is already associated with this member.", context?.headers);
    }
    if (/wallet_recovery_challenge_rate_limit/i.test(error.message)) {
      return problem(429, "wallet_recovery_rate_limited", "Wait before requesting another recovery challenge.", context?.headers);
    }
    if (/INVALID_|PROOF|P256|RECOVERY/.test(error.message)) {
      return problem(422, "wallet_provisioning_invalid", "The passkey or recovery authorization is invalid.", context?.headers);
    }
    return requestFailure(error, context?.headers)
      || problem(502, "wallet_provisioning_unavailable", "The passkey wallet could not be prepared or verified.", context?.headers);
  }
};

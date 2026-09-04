import { createPublicClient, custom, getAddress, isAddress, isHex, keccak256, numberToHex } from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { mainnet, sepolia } from "viem/chains";
import { SafeSmartAccount } from "permissionless/accounts/safe";
import { decodeSecondaryActionCall } from "../shared/secondary-actions.js";
import {
  assertUserOperationSignatureWindow,
  normalizeUserOperation,
  userOperationCommitment,
  userOperationToJson
} from "../shared/sponsored-userop.js";

const passkeysSupported = () => Boolean(
  globalThis.PublicKeyCredential && globalThis.navigator?.credentials && globalThis.isSecureContext
);

const preparedContext = (context) => {
  const { wallet, policy } = context || {};
  if (!wallet || !policy || !context.request_key || !context.operation_commitment
    || ![1, 11155111].includes(Number(policy.chain_id))
    || !isAddress(wallet.account_address, { strict: true })
    || !isAddress(wallet.entry_point_address, { strict: true })
    || !isAddress(wallet.factory_address, { strict: true })
    || !isAddress(wallet.singleton_address, { strict: true })
    || !isAddress(wallet.safe_4337_module_address, { strict: true })
    || !isAddress(wallet.shared_signer_address, { strict: true })
    || !isAddress(wallet.p256_verifier_address, { strict: true })
    || !isHex(wallet.account_runtime_code) || wallet.account_runtime_code === "0x"
    || !isHex(wallet.account_code_hash, { size: 32 })
    || keccak256(wallet.account_runtime_code) !== wallet.account_code_hash
    || !isHex(wallet.passkey_public_key, { size: 64 })
    || Number(wallet.threshold) !== 1) throw new Error("The sponsored wallet context is incomplete.");
  const operation = normalizeUserOperation(context.user_operation);
  if (getAddress(operation.sender) !== getAddress(wallet.account_address)
    || userOperationCommitment(operation) !== context.operation_commitment
    || !Number.isSafeInteger(Number(context.valid_after)) || !Number.isSafeInteger(Number(context.valid_until))
    || Number(context.valid_after) < 0 || Number(context.valid_until) <= Math.floor(Date.now() / 1_000)) {
    throw new Error("The sponsored operation changed or expired.");
  }
  decodeSecondaryActionCall({
    action: context.action,
    callData: operation.callData,
    accountAddress: wallet.account_address,
    config: { secondary: { protocolAddress: policy.protocol_address, usdcAddress: policy.usdc_address } },
    expectedCall: policy.expected_call
  });
  return { wallet, policy, operation };
};

const passkeySafe = async ({ wallet, chainId, validAfter, validUntil }) => {
  const owner = toWebAuthnAccount({ credential: { id: "", publicKey: wallet.passkey_public_key } });
  const chain = Number(chainId) === 1 ? mainnet : sepolia;
  const client = createPublicClient({
    chain,
    transport: custom({
      request: async ({ method, params = [] }) => {
        if (method === "eth_getCode" && typeof params[0] === "string"
          && getAddress(params[0]) === getAddress(wallet.account_address)) return wallet.account_runtime_code;
        if (method === "eth_chainId") return numberToHex(chain.id);
        throw new Error("Unexpected browser RPC request.");
      }
    })
  });
  return SafeSmartAccount.toSafeSmartAccount({
    client,
    owners: [owner],
    threshold: BigInt(wallet.threshold),
    address: getAddress(wallet.account_address),
    version: wallet.safe_version,
    entryPoint: { address: getAddress(wallet.entry_point_address), version: wallet.entry_point_version },
    safeProxyFactoryAddress: getAddress(wallet.factory_address),
    safeSingletonAddress: getAddress(wallet.singleton_address),
    safe4337ModuleAddress: getAddress(wallet.safe_4337_module_address),
    safeWebAuthnSharedSignerAddress: getAddress(wallet.shared_signer_address),
    safeP256VerifierAddress: getAddress(wallet.p256_verifier_address),
    validAfter,
    validUntil
  });
};

export const signSponsoredSecondaryUserOperation = async ({ context }) => {
  if (!passkeysSupported()) throw new Error("A passkey-capable secure browser is required.");
  const { wallet, policy, operation } = preparedContext(context);
  const safe = await passkeySafe({
    wallet,
    chainId: policy.chain_id,
    validAfter: Number(context.valid_after),
    validUntil: Number(context.valid_until)
  });
  const signature = await safe.signUserOperation(operation);
  assertUserOperationSignatureWindow({
    signature,
    validAfter: context.valid_after,
    validUntil: context.valid_until
  });
  return {
    signature,
    body: {
      stage: "submit",
      request_key: context.request_key,
      user_operation: userOperationToJson({ ...operation, signature }, { signature: true })
    }
  };
};

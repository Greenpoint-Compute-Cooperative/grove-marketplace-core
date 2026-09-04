import { createPublicClient, custom, getAddress, hashTypedData, isAddress, isHex, keccak256, numberToHex, stringToHex } from "viem";
import { createWebAuthnCredential, toWebAuthnAccount } from "viem/account-abstraction";
import { mainnet, sepolia } from "viem/chains";
import { SafeSmartAccount } from "permissionless/accounts/safe";
import { buildBidTypedData } from "../shared/bid-intent.js";
import { resaleOrderHash, resaleOrderTypedData } from "../shared/resale-order.js";
import { buildWalletLinkTypedData } from "../shared/wallet-link.js";

export { signSponsoredSecondaryUserOperation } from "./sponsored-userop.js";

// Private WebAuthn key material remains inside the authenticator. This browser-only
// module prepares deterministic typed data; the configured Safe adapter performs signing.
export const prepareBidIntent = (input) => {
  const typedData = buildBidTypedData(input);
  return { typedData, intentHash: hashTypedData(typedData) };
};

export const prepareWalletLink = (input) => {
  const typedData = buildWalletLinkTypedData(input);
  return { typedData, intentHash: hashTypedData(typedData) };
};

export const passkeysSupported = () => Boolean(
  globalThis.PublicKeyCredential && globalThis.navigator?.credentials && globalThis.isSecureContext
);

export const createProvisioningPasskey = async ({ name, createCredential = createWebAuthnCredential } = {}) => {
  if (!passkeysSupported()) throw new Error("A passkey-capable secure browser is required.");
  const credentialName = String(name || "Marketplace member").trim().slice(0, 120);
  const credential = await createCredential({
    name: credentialName || "Marketplace member",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required"
    }
  });
  if (!/^0x[0-9a-fA-F]{128}$/.test(credential?.publicKey || "")) {
    throw new Error("The authenticator did not return a supported P-256 public key.");
  }
  // The raw WebAuthn credential and credential ID stay in the authenticator/browser.
  return { publicKey: credential.publicKey.toLowerCase() };
};

export const connectRecoveryWallet = async ({ provider = globalThis.ethereum } = {}) => {
  if (!provider?.request) {
    throw new Error("Connect an existing Ethereum wallet to set a recovery owner.");
  }
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const account = Array.isArray(accounts) ? accounts[0] : null;
  if (!isAddress(account, { strict: true })) {
    throw new Error("The connected wallet did not return a valid recovery address.");
  }
  let chainId = null;
  try {
    const providerChainId = await provider.request({ method: "eth_chainId" });
    if (isHex(providerChainId)) chainId = Number(BigInt(providerChainId));
  } catch {
    // Recovery ownership is proven by signature; reading the selected network is informational.
  }
  return { address: getAddress(account), chainId };
};

export const signRecoveryAuthorizationWithWallet = async ({
  message,
  recoveryAddress,
  provider = globalThis.ethereum
} = {}) => {
  if (!provider?.request || !isAddress(recoveryAddress, { strict: true }) || typeof message !== "string" || !message) {
    throw new Error("The recovery authorization request is incomplete.");
  }
  const signature = await provider.request({
    method: "personal_sign",
    params: [stringToHex(message), getAddress(recoveryAddress)]
  });
  if (!isHex(signature) || signature.length < 132) {
    throw new Error("The recovery wallet did not return a valid signature.");
  }
  return signature;
};

const safeContext = (context) => {
  const wallet = context?.wallet;
  const intent = context?.intent;
  if (!wallet || !intent || ![1, 11155111].includes(Number(intent.chain_id))
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
    || !Number.isInteger(Number(wallet.threshold)) || Number(wallet.threshold) !== 1
    || !isAddress(intent.bidder_safe, { strict: true })
    || getAddress(intent.bidder_safe) !== getAddress(wallet.account_address)
    || !isHex(intent.work_id, { size: 32 }) || !isHex(intent.terms_hash, { size: 32 })) {
    throw new Error("The verified passkey wallet context is incomplete.");
  }
  if (globalThis.location?.origin && intent.origin !== globalThis.location.origin) {
    throw new Error("The bid origin does not match this marketplace.");
  }
  return { wallet, intent };
};

export const bidIntentFromContext = (context, amount) => {
  const { intent } = safeContext(context);
  if (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(amount)) {
    throw new Error("The bid amount is invalid.");
  }
  return {
    auctionId: intent.auction_id,
    workId: intent.work_id,
    bidderSafe: getAddress(intent.bidder_safe),
    amount,
    currency: intent.currency,
    nonce: intent.nonce,
    validAfter: Math.floor(new Date(intent.valid_after).getTime() / 1000),
    validUntil: Math.floor(new Date(intent.valid_until).getTime() / 1000),
    termsHash: intent.terms_hash,
    settlementRail: intent.settlement_rail,
    origin: intent.origin,
    chainId: Number(intent.chain_id)
  };
};

const passkeySafe = async ({ wallet, chainId }) => {
  const owner = toWebAuthnAccount({
    // The credential is discoverable, so the authenticator chooses the passkey
    // scoped to this origin. Raw credential IDs never enter application storage.
    credential: { id: "", publicKey: wallet.passkey_public_key }
  });
  const chain = Number(chainId) === 1 ? mainnet : sepolia;
  const client = createPublicClient({
    chain,
    // Permissionless checks deployment before deciding whether to wrap an
    // ERC-6492 signature. Answer only with the runtime code that this context's
    // server-side Safe attestation just read and hash-verified.
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
    safeP256VerifierAddress: getAddress(wallet.p256_verifier_address)
  });
};

export const signBidIntentWithPasskey = async ({ context, amount }) => {
  if (!passkeysSupported()) throw new Error("A passkey-capable secure browser is required.");
  const { wallet, intent } = safeContext(context);
  const bidIntent = bidIntentFromContext(context, amount);
  const safe = await passkeySafe({ wallet, chainId: intent.chain_id });
  const { typedData, intentHash } = prepareBidIntent(bidIntent);
  const signature = await safe.signTypedData(typedData);
  return {
    signature,
    intentHash,
    body: {
      amount,
      nonce: intent.nonce,
      valid_after: intent.valid_after,
      valid_until: intent.valid_until,
      signature
    }
  };
};

export const signResaleOrderWithPasskey = async ({ context }) => {
  if (!passkeysSupported()) throw new Error("A passkey-capable secure browser is required.");
  const { wallet, listing } = context || {};
  if (!wallet || !listing || ![1, 11155111].includes(Number(listing.typed_data?.domain?.chainId))
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
    || Number(wallet.threshold) !== 1
    || getAddress(listing.order?.offerer) !== getAddress(wallet.account_address)
    || (globalThis.location?.origin && listing.origin !== globalThis.location.origin)) {
    throw new Error("The verified resale wallet context is incomplete.");
  }
  if (listing.approval?.required) {
    throw new Error("The sponsored exact-token approval must finalize before signing the listing.");
  }
  const typedData = resaleOrderTypedData({
    chainId: Number(listing.typed_data.domain.chainId),
    protocolAddress: listing.protocol_address,
    order: listing.order
  });
  if (resaleOrderHash(listing.order) !== listing.order_hash) throw new Error("The resale order hash changed.");
  const safe = await passkeySafe({ wallet, chainId: typedData.domain.chainId });
  const signature = await safe.signTypedData(typedData);
  return {
    signature,
    body: { work_id: listing.work_id, order: listing.order, signature }
  };
};

import { createPublicClient, encodeAbiParameters, http, keccak256 } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { ConfigurationError, getRuntimeConfig } from "./config.js";

const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const FALLBACK_HANDLER_STORAGE_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";
const ERC1271_ABI = [{
  type: "function",
  name: "isValidSignature",
  stateMutability: "view",
  inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }],
  outputs: [{ name: "magicValue", type: "bytes4" }]
}];
const SAFE_PROFILE_ABI = [
  { type: "function", name: "masterCopy", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "isModuleEnabled", stateMutability: "view", inputs: [{ name: "module", type: "address" }], outputs: [{ name: "", type: "bool" }] }
];
const SHARED_SIGNER_ABI = [{
  type: "function",
  name: "getConfiguration",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{
    name: "signer",
    type: "tuple",
    components: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
      { name: "verifiers", type: "uint176" }
    ]
  }]
}];

export const requireWalletIdentityConfig = () => {
  const config = getRuntimeConfig();
  if (!config.wallet.identityStagingConfigured || (config.productionDeployment && !config.wallet.liveReady)) {
    throw new ConfigurationError("The member wallet is not configured.", [
      "GROVE_WALLET_ENABLED=true",
      "chain RPC and the pinned Safe, passkey, module-setup, and MultiSend compatibility tuple"
    ]);
  }
  return config;
};

// Backward-compatible name used by the existing wallet-link endpoints.
export const requireWalletConfig = requireWalletIdentityConfig;

export const verifyErc1271Hash = async ({ config, address, hash, signature }) => {
  const client = createPublicClient({ chain: config.wallet.chainId === 1 ? mainnet : sepolia, transport: http(config.wallet.rpcUrl) });
  const blockNumber = await client.getBlockNumber();
  const magicValue = await client.readContract({
    address,
    abi: ERC1271_ABI,
    functionName: "isValidSignature",
    args: [hash, signature],
    blockNumber
  });
  return { valid: magicValue.toLowerCase() === ERC1271_MAGIC_VALUE, blockNumber };
};

export const p256PublicKeyHex = (x, y) => `0x${BigInt(x).toString(16).padStart(64, "0")}${BigInt(y).toString(16).padStart(64, "0")}`;

export const primaryWalletReady = (account) => Boolean(account?.finalized_at && (
  (account.state === "deployed" && !account.recovery_ready)
  || (account.state === "recovery-ready" && account.recovery_ready)
));

export const attestSmartAccountProfile = async ({ config, account, credentials, client: suppliedClient, blockNumber }) => {
  if (config.wallet.safeFallbackHandlerAddress !== config.wallet.safe4337ModuleAddress
    || config.wallet.safeFallbackHandlerCodeHash !== config.wallet.safe4337ModuleCodeHash) {
    throw new Error("SAFE_4337_TUPLE_MISMATCH");
  }
  if (Number(account.chain_id) !== config.wallet.chainId
    || account.safe_version !== config.wallet.safeVersion
    || account.module_version !== config.wallet.moduleVersion
    || account.entry_point_address !== config.wallet.entryPointAddress
    || account.factory_address !== config.wallet.safeFactoryAddress
    || !Number.isInteger(Number(account.signer_count)) || !Number.isInteger(Number(account.threshold))
    || account.code_hash !== config.wallet.safeProxyCodeHash) throw new Error("SMART_ACCOUNT_PROFILE_MISMATCH");
  if (!Array.isArray(credentials) || credentials.length !== Number(account.signer_count)
    || new Set(credentials.map((credential) => credential.owner_address)).size !== credentials.length) {
    throw new Error("SMART_ACCOUNT_CREDENTIALS_MISMATCH");
  }

  const client = suppliedClient || createPublicClient({
    chain: config.wallet.chainId === 1 ? mainnet : sepolia,
    transport: http(config.wallet.rpcUrl)
  });
  const block = blockNumber === undefined ? {} : { blockNumber: BigInt(blockNumber) };
  const targets = [
    [config.wallet.entryPointAddress, config.wallet.entryPointCodeHash],
    [config.wallet.safeFactoryAddress, config.wallet.safeFactoryCodeHash],
    [config.wallet.safeSingletonAddress, config.wallet.safeSingletonCodeHash],
    [config.wallet.safeFallbackHandlerAddress, config.wallet.safeFallbackHandlerCodeHash],
    [config.wallet.safeWebAuthnSharedSignerAddress, config.wallet.safeWebAuthnSharedSignerCodeHash],
    [config.wallet.safe4337ModuleAddress, config.wallet.safe4337ModuleCodeHash],
    [config.wallet.safePasskeyVerifierAddress, config.wallet.safePasskeyVerifierCodeHash],
    [account.account_address, config.wallet.safeProxyCodeHash]
  ];
  const bytecodes = await Promise.all(targets.map(([address]) => client.getBytecode({ address, ...block })));
  for (let index = 0; index < targets.length; index += 1) {
    if (!bytecodes[index] || keccak256(bytecodes[index]) !== targets[index][1]) throw new Error("ETHEREUM_CODE_HASH_MISMATCH");
  }
  const [singleton, fallbackWord, owners, threshold, moduleEnabled, signerConfiguration] = await Promise.all([
    client.readContract({ address: account.account_address, abi: SAFE_PROFILE_ABI, functionName: "masterCopy", ...block }),
    client.getStorageAt({ address: account.account_address, slot: FALLBACK_HANDLER_STORAGE_SLOT, ...block }),
    client.readContract({ address: account.account_address, abi: SAFE_PROFILE_ABI, functionName: "getOwners", ...block }),
    client.readContract({ address: account.account_address, abi: SAFE_PROFILE_ABI, functionName: "getThreshold", ...block }),
    client.readContract({ address: account.account_address, abi: SAFE_PROFILE_ABI, functionName: "isModuleEnabled", args: [config.wallet.safe4337ModuleAddress], ...block }),
    client.readContract({
      address: config.wallet.safeWebAuthnSharedSignerAddress,
      abi: SHARED_SIGNER_ABI,
      functionName: "getConfiguration",
      args: [account.account_address],
      ...block
    })
  ]);
  if (!fallbackWord) throw new Error("SAFE_FALLBACK_HANDLER_MISSING");
  const fallbackHandler = `0x${fallbackWord.slice(-40)}`;
  const normalizedOwners = owners.map((owner) => owner.toLowerCase()).sort();
  const expectedOwners = credentials.map((credential) => credential.owner_address).sort();
  const signerX = signerConfiguration.x ?? signerConfiguration[0];
  const signerY = signerConfiguration.y ?? signerConfiguration[1];
  const signerVerifiers = signerConfiguration.verifiers ?? signerConfiguration[2];
  const signerCommitment = keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [signerX, signerY]
  ));
  const primaryCredential = credentials.find((credential) => credential.purpose === "owner"
    && credential.owner_address === config.wallet.safeWebAuthnSharedSignerAddress);
  const expectedVerifier = BigInt(config.wallet.safePasskeyVerifierAddress);
  if (singleton.toLowerCase() !== config.wallet.safeSingletonAddress
    || fallbackHandler !== config.wallet.safe4337ModuleAddress || !moduleEnabled
    || Number(threshold) !== Number(account.threshold)
    || normalizedOwners.length !== expectedOwners.length
    || normalizedOwners.some((owner, index) => owner !== expectedOwners[index])
    || !primaryCredential || primaryCredential.credential_commitment !== signerCommitment
    || signerX === 0n || signerY === 0n || BigInt(signerVerifiers) === 0n
    || BigInt(signerVerifiers) !== expectedVerifier
    || (account.recovery_ready && (owners.length < 2 || !credentials.some((credential) => credential.purpose === "recovery")))) {
    throw new Error("SAFE_CONFIGURATION_MISMATCH");
  }
  return {
    accountRuntimeCode: bytecodes.at(-1),
    passkeyPublicKey: p256PublicKeyHex(signerX, signerY),
    verifiedOwners: normalizedOwners,
    threshold: Number(threshold)
  };
};

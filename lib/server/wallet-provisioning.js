import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  stringToHex,
  verifyMessage,
  zeroAddress
} from "viem";
import { toAccount } from "viem/accounts";
import { toWebAuthnAccount } from "viem/account-abstraction";
import { mainnet, sepolia } from "viem/chains";
import { SafeSmartAccount } from "permissionless/accounts/safe";
import { attestSmartAccountProfile } from "./wallet.js";

const PROOF_TTL_SECONDS = 5 * 60;
const MAX_PROOF_TTL_SECONDS = 10 * 60;
const FACTORY_SCAN_CHUNK_BLOCKS = 5_000n;
const FACTORY_SCAN_MAX_BLOCKS = 50_000n;
const P256_FIELD = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const P256_B = BigInt("0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b");
const USER_OPERATION_EVENT = [{
  type: "event",
  name: "UserOperationEvent",
  inputs: [
    { name: "userOpHash", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "paymaster", type: "address", indexed: true },
    { name: "nonce", type: "uint256", indexed: false },
    { name: "success", type: "bool", indexed: false },
    { name: "actualGasCost", type: "uint256", indexed: false },
    { name: "actualGasUsed", type: "uint256", indexed: false }
  ]
}];
const SAFE_PROXY_CREATION_EVENT = {
  type: "event",
  name: "ProxyCreation",
  inputs: [
    { name: "proxy", type: "address", indexed: true },
    { name: "singleton", type: "address", indexed: false }
  ]
};
const ACCOUNT_DEPLOYED_EVENT = [{
  type: "event",
  name: "AccountDeployed",
  inputs: [
    { name: "userOpHash", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "factory", type: "address", indexed: false },
    { name: "paymaster", type: "address", indexed: false }
  ]
}];

const chainFor = (chainId) => chainId === 1 ? mainnet : sepolia;
const address = (input, code = "INVALID_ADDRESS") => {
  if (!isAddress(input, { strict: true })) throw new Error(code);
  return getAddress(input);
};
const hash = (input, code = "INVALID_HASH") => {
  if (!isHex(input, { size: 32 })) throw new Error(code);
  return input.toLowerCase();
};
const uuid = (input) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;

export const walletProvisioningClient = (config) => createPublicClient({
  chain: chainFor(config.wallet.chainId),
  transport: http(config.wallet.rpcUrl)
});

export const assertP256PublicKey = (input) => {
  if (!isHex(input, { size: 64 })) throw new Error("INVALID_PASSKEY_PUBLIC_KEY");
  const x = BigInt(`0x${input.slice(2, 66)}`);
  const y = BigInt(`0x${input.slice(66)}`);
  if (x <= 0n || x >= P256_FIELD || y <= 0n || y >= P256_FIELD
    || mod(y * y - (x * x * x - 3n * x + P256_B), P256_FIELD) !== 0n) {
    throw new Error("INVALID_PASSKEY_PUBLIC_KEY");
  }
  return input.toLowerCase();
};

export const passkeyCredentialCommitment = (publicKey) => {
  const normalized = assertP256PublicKey(publicKey);
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [BigInt(`0x${normalized.slice(2, 66)}`), BigInt(`0x${normalized.slice(66)}`)]
  ));
};

export const recoveryCredentialCommitment = (recoveryAddress) => keccak256(encodeAbiParameters(
  [{ type: "string" }, { type: "address" }],
  ["grove-safe-recovery-v1", address(recoveryAddress, "INVALID_RECOVERY_ADDRESS")]
));

export const provisioningMemberSubject = (userId) => {
  if (!uuid(userId)) throw new Error("INVALID_MEMBER");
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], ["grove-member-v1", userId]));
};

export const recoveryAuthorizationMessage = ({
  config,
  userId,
  passkeyPublicKey,
  recoveryAddress,
  nonce,
  expiresAt
}) => {
  const commitment = passkeyCredentialCommitment(passkeyPublicKey);
  const recovery = address(recoveryAddress, "INVALID_RECOVERY_ADDRESS");
  if (recovery === getAddress(zeroAddress) || recovery === getAddress(config.wallet.safeWebAuthnSharedSignerAddress)) {
    throw new Error("INVALID_RECOVERY_ADDRESS");
  }
  const challengeNonce = hash(nonce, "INVALID_RECOVERY_NONCE");
  const expiry = Number(expiresAt);
  if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new Error("INVALID_RECOVERY_EXPIRY");
  return [
    "Grove Safe recovery authorization",
    `Origin: ${config.siteUrl}`,
    `Chain ID: ${config.wallet.chainId}`,
    `Member: ${provisioningMemberSubject(userId)}`,
    `Passkey commitment: ${commitment}`,
    `Recovery address: ${recovery}`,
    `Nonce: ${challengeNonce}`,
    `Expires at: ${expiry}`
  ].join("\n");
};

export const createRecoveryChallenge = ({ config, userId, passkeyPublicKey, recoveryAddress, now = Date.now() }) => {
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  const expiresAt = Math.floor(now / 1_000) + PROOF_TTL_SECONDS;
  const message = recoveryAuthorizationMessage({ config, userId, passkeyPublicKey, recoveryAddress, nonce, expiresAt });
  return {
    nonce,
    expires_at: expiresAt,
    message,
    challengeHash: keccak256(stringToHex(message)),
    originHash: keccak256(stringToHex(`grove:origin:${config.siteUrl}`))
  };
};

export const verifyRecoveryAuthorization = async ({
  config,
  userId,
  passkeyPublicKey,
  recoveryAddress,
  proof,
  now = Date.now(),
  verify = verifyMessage
}) => {
  const expiresAt = Number(proof?.expires_at);
  const nowSeconds = Math.floor(now / 1_000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds || expiresAt > nowSeconds + MAX_PROOF_TTL_SECONDS
    || !isHex(proof?.nonce, { size: 32 }) || !isHex(proof?.signature)) {
    throw new Error("RECOVERY_PROOF_INVALID");
  }
  const recovery = address(recoveryAddress, "INVALID_RECOVERY_ADDRESS");
  const message = recoveryAuthorizationMessage({
    config, userId, passkeyPublicKey, recoveryAddress: recovery, nonce: proof.nonce, expiresAt
  });
  let valid = false;
  try {
    valid = await verify({ address: recovery, message, signature: proof.signature });
  } catch {}
  if (!valid) throw new Error("RECOVERY_PROOF_INVALID");
  return {
    message,
    proofHash: keccak256(proof.signature),
    challengeHash: keccak256(stringToHex(message)),
    originHash: keccak256(stringToHex(`grove:origin:${config.siteUrl}`)),
    expiresAt
  };
};

export const assertProvisioningInfrastructure = async ({ config, client, blockNumber }) => {
  if (![1, 11155111].includes(Number(config.wallet.chainId))
    || config.wallet.safeFallbackHandlerAddress !== config.wallet.safe4337ModuleAddress
    || config.wallet.safeFallbackHandlerCodeHash !== config.wallet.safe4337ModuleCodeHash) {
    throw new Error("SAFE_4337_TUPLE_MISMATCH");
  }
  const rpc = client || walletProvisioningClient(config);
  const finalized = blockNumber === undefined ? await rpc.getBlock({ blockTag: "finalized" }) : null;
  const verifiedBlock = BigInt(blockNumber ?? finalized.number);
  const chainId = await rpc.getChainId();
  if (Number(chainId) !== Number(config.wallet.chainId)) throw new Error("ETHEREUM_CHAIN_MISMATCH");
  const targets = [
    [config.wallet.entryPointAddress, config.wallet.entryPointCodeHash],
    [config.wallet.safeFactoryAddress, config.wallet.safeFactoryCodeHash],
    [config.wallet.safeSingletonAddress, config.wallet.safeSingletonCodeHash],
    [config.wallet.safe4337ModuleAddress, config.wallet.safe4337ModuleCodeHash],
    [config.wallet.safeWebAuthnSharedSignerAddress, config.wallet.safeWebAuthnSharedSignerCodeHash],
    [config.wallet.safePasskeyVerifierAddress, config.wallet.safePasskeyVerifierCodeHash],
    [config.wallet.safeModuleSetupAddress, config.wallet.safeModuleSetupCodeHash],
    [config.wallet.safeMultiSendAddress, config.wallet.safeMultiSendCodeHash]
  ];
  for (const [target, expected] of targets) {
    if (!isAddress(target, { strict: true }) || !isHex(expected, { size: 32 })) {
      throw new Error("WALLET_IDENTITY_CONFIG_INCOMPLETE");
    }
  }
  const bytecodes = await Promise.all(targets.map(([target]) => rpc.getBytecode({ address: target, blockNumber: verifiedBlock })));
  bytecodes.forEach((bytecode, index) => {
    if (!bytecode || bytecode === "0x" || keccak256(bytecode) !== targets[index][1]) {
      throw new Error("ETHEREUM_CODE_HASH_MISMATCH");
    }
  });
  return { client: rpc, blockNumber: verifiedBlock, blockHash: finalized?.hash || null };
};

const saltNonceFor = ({ config, passkeyCommitment, recoveryAddress }) => BigInt(keccak256(encodeAbiParameters(
  [{ type: "string" }, { type: "uint256" }, { type: "bytes32" }, { type: "address" }],
  [config.siteUrl, BigInt(config.wallet.chainId), passkeyCommitment,
    recoveryAddress ? address(recoveryAddress) : getAddress(zeroAddress)]
)));

export const buildSafeProvisioningPlan = async ({
  config,
  passkeyPublicKey,
  recoveryAddress,
  client,
  blockNumber,
  safeAccountFactory = SafeSmartAccount.toSafeSmartAccount
}) => {
  const publicKey = assertP256PublicKey(passkeyPublicKey);
  const recovery = recoveryAddress ? address(recoveryAddress, "INVALID_RECOVERY_ADDRESS") : null;
  if (recovery && (recovery === getAddress(zeroAddress)
    || recovery === getAddress(config.wallet.safeWebAuthnSharedSignerAddress))) {
    throw new Error("INVALID_RECOVERY_ADDRESS");
  }
  const infrastructure = await assertProvisioningInfrastructure({ config, client, blockNumber });
  const passkeyCommitment = passkeyCredentialCommitment(publicKey);
  const recoveryCommitment = recovery ? recoveryCredentialCommitment(recovery) : null;
  const saltNonce = saltNonceFor({ config, passkeyCommitment, recoveryAddress: recovery });
  const owners = [toWebAuthnAccount({ credential: { id: "", publicKey } })];
  if (recovery) owners.push(toAccount(recovery));
  // viem's SmartAccount wrapper suppresses factory args when getCode sees an
  // already-deployed account. A caller-supplied block means this is a trusted
  // deterministic reconstruction: infrastructure is pinned to that finalized
  // block while deployment itself is proven from canonical creation events.
  // Force only the wrapper's deployment-presence probe to the counterfactual
  // result so it returns the deterministic factory calldata without requiring
  // archive-node state for an address that did not exist yet.
  const safeClient = blockNumber === undefined ? infrastructure.client : Object.assign(
    Object.create(infrastructure.client),
    {
      async getCode() { return undefined; }
    }
  );
  const safe = await safeAccountFactory({
    client: safeClient,
    owners,
    threshold: 1n,
    saltNonce,
    version: config.wallet.safeVersion,
    entryPoint: { address: getAddress(config.wallet.entryPointAddress), version: config.wallet.entryPointVersion },
    safeProxyFactoryAddress: getAddress(config.wallet.safeFactoryAddress),
    safeSingletonAddress: getAddress(config.wallet.safeSingletonAddress),
    safe4337ModuleAddress: getAddress(config.wallet.safe4337ModuleAddress),
    safeWebAuthnSharedSignerAddress: getAddress(config.wallet.safeWebAuthnSharedSignerAddress),
    safeP256VerifierAddress: getAddress(config.wallet.safePasskeyVerifierAddress),
    safeModuleSetupAddress: getAddress(config.wallet.safeModuleSetupAddress),
    multiSendAddress: getAddress(config.wallet.safeMultiSendAddress)
  });
  const [accountAddress, factory] = await Promise.all([safe.getAddress(), safe.getFactoryArgs()]);
  if (!factory || getAddress(factory.factory) !== getAddress(config.wallet.safeFactoryAddress) || !isHex(factory.factoryData)) {
    throw new Error("SAFE_FACTORY_DATA_INVALID");
  }
  const factoryDataHash = keccak256(factory.factoryData);
  const provisioningCommitment = keccak256(encodeAbiParameters([
    { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
    { type: "address" }, { type: "address" }, { type: "address" }, { type: "bytes32" },
    { type: "bytes32" }, { type: "uint256" }
  ], [
    "grove-safe-provisioning-v1", BigInt(config.wallet.chainId), getAddress(accountAddress),
    recovery || getAddress(zeroAddress),
    getAddress(config.wallet.safeSingletonAddress), getAddress(config.wallet.safe4337ModuleAddress),
    getAddress(config.wallet.safeWebAuthnSharedSignerAddress), passkeyCommitment, factoryDataHash, saltNonce
  ]));
  return {
    accountAddress: getAddress(accountAddress),
    factoryAddress: getAddress(factory.factory),
    factoryData: factory.factoryData,
    factoryDataHash,
    saltNonce: saltNonce.toString(),
    passkeyCommitment,
    recoveryCommitment,
    recoveryAddress: recovery,
    provisioningCommitment,
    verifiedBlockNumber: infrastructure.blockNumber,
    verifiedBlockHash: infrastructure.blockHash
  };
};

const userOperationEvent = ({ receipt, entryPointAddress, accountAddress, userOperationHash }) => {
  for (const log of receipt.logs || []) {
    if (getAddress(log.address) !== getAddress(entryPointAddress)) continue;
    try {
      const decoded = decodeEventLog({ abi: USER_OPERATION_EVENT, data: log.data, topics: log.topics });
      if (decoded.eventName === "UserOperationEvent"
        && decoded.args.userOpHash.toLowerCase() === userOperationHash
        && getAddress(decoded.args.sender) === getAddress(accountAddress)) return decoded.args;
    } catch {}
  }
  return null;
};

const accountDeployedEvent = ({ receipt, entryPointAddress, accountAddress, userOperationHash, factoryAddress }) => {
  for (const log of receipt.logs || []) {
    if (getAddress(log.address) !== getAddress(entryPointAddress)) continue;
    try {
      const decoded = decodeEventLog({ abi: ACCOUNT_DEPLOYED_EVENT, data: log.data, topics: log.topics });
      if (decoded.eventName === "AccountDeployed"
        && decoded.args.userOpHash.toLowerCase() === userOperationHash
        && getAddress(decoded.args.sender) === getAddress(accountAddress)
        && getAddress(decoded.args.factory) === getAddress(factoryAddress)) return decoded.args;
    } catch {}
  }
  return null;
};

const proxyCreationEvent = ({ receipt, factoryAddress, accountAddress, singletonAddress }) => {
  for (const log of receipt.logs || []) {
    if (getAddress(log.address) !== getAddress(factoryAddress)) continue;
    try {
      const decoded = decodeEventLog({ abi: [SAFE_PROXY_CREATION_EVENT], data: log.data, topics: log.topics });
      if (decoded.eventName === "ProxyCreation"
        && getAddress(decoded.args.proxy) === getAddress(accountAddress)
        && getAddress(decoded.args.singleton) === getAddress(singletonAddress)) return decoded.args;
    } catch {}
  }
  return null;
};

export const findFinalizedSafeFactoryDeployment = async ({
  config,
  accountAddress,
  fromBlock,
  client,
  chunkBlocks = FACTORY_SCAN_CHUNK_BLOCKS,
  maxBlocks = FACTORY_SCAN_MAX_BLOCKS
}) => {
  const safeAddress = address(accountAddress, "INVALID_ACCOUNT_ADDRESS");
  const start = BigInt(fromBlock);
  const chunk = BigInt(chunkBlocks);
  const maximum = BigInt(maxBlocks);
  if (start < 0n || chunk < 1n || maximum < 1n) throw new Error("SAFE_DEPLOYMENT_SCAN_INVALID");
  const rpc = client || walletProvisioningClient(config);
  const finalized = await rpc.getBlock({ blockTag: "finalized" });
  if (start > finalized.number) {
    return { transactionHash: null, finalizedBlockNumber: finalized.number, finalizedBlockHash: finalized.hash };
  }
  if (finalized.number - start > maximum) throw new Error("SAFE_DEPLOYMENT_SCAN_RANGE_EXCEEDED");

  const deployedCode = await rpc.getBytecode({ address: safeAddress, blockNumber: finalized.number });
  if (!deployedCode || deployedCode === "0x") {
    return { transactionHash: null, finalizedBlockNumber: finalized.number, finalizedBlockHash: finalized.hash };
  }

  let transactionHash = null;
  for (let lower = start; lower <= finalized.number; lower += chunk) {
    const upper = lower + chunk - 1n > finalized.number ? finalized.number : lower + chunk - 1n;
    const logs = await rpc.getLogs({
      address: getAddress(config.wallet.safeFactoryAddress),
      event: SAFE_PROXY_CREATION_EVENT,
      args: { proxy: safeAddress },
      fromBlock: lower,
      toBlock: upper
    });
    for (const log of logs) {
      if (!log.transactionHash || !log.args?.proxy || !log.args?.singleton
        || getAddress(log.args.proxy) !== safeAddress
        || getAddress(log.args.singleton) !== getAddress(config.wallet.safeSingletonAddress)) {
        throw new Error("SAFE_FACTORY_DEPLOYMENT_INVALID");
      }
      const candidate = hash(log.transactionHash, "SAFE_FACTORY_DEPLOYMENT_INVALID");
      if (transactionHash && transactionHash !== candidate) throw new Error("SAFE_FACTORY_DEPLOYMENT_INVALID");
      transactionHash = candidate;
    }
  }
  if (!transactionHash) throw new Error("SAFE_FACTORY_DEPLOYMENT_EVENT_MISSING");
  return {
    transactionHash,
    finalizedBlockNumber: finalized.number,
    finalizedBlockHash: finalized.hash
  };
};

export const verifyFinalizedSafeDeployment = async ({
  config,
  account,
  credentials,
  deploymentUserOpHash,
  deploymentTransactionHash,
  client,
  attest = attestSmartAccountProfile,
  buildPlan = buildSafeProvisioningPlan
}) => {
  const userOpHash = deploymentUserOpHash
    ? hash(deploymentUserOpHash, "INVALID_DEPLOYMENT_USEROP_HASH")
    : null;
  const transactionHash = hash(deploymentTransactionHash, "INVALID_DEPLOYMENT_TX_HASH");
  if (!account || account.state === "suspended" || !account.provisioning_commitment) {
    throw new Error("SMART_ACCOUNT_NOT_PREPARED");
  }
  const rpc = client || walletProvisioningClient(config);
  const [receipt, transaction, finalized] = await Promise.all([
    rpc.getTransactionReceipt({ hash: transactionHash }),
    rpc.getTransaction({ hash: transactionHash }),
    rpc.getBlock({ blockTag: "finalized" })
  ]);
  if (receipt.status !== "success" || receipt.blockNumber > finalized.number
    || !receipt.to || !transaction.to || getAddress(receipt.to) !== getAddress(transaction.to)) {
    throw new Error("SAFE_DEPLOYMENT_NOT_FINALIZED");
  }
  const canonical = await rpc.getBlock({ blockNumber: receipt.blockNumber });
  if (!canonical.hash || canonical.hash !== receipt.blockHash) throw new Error("SAFE_DEPLOYMENT_REORGED");
  if (userOpHash) {
    if (getAddress(transaction.to) !== getAddress(config.wallet.entryPointAddress)) {
      throw new Error("SAFE_DEPLOYMENT_EVENT_INVALID");
    }
    const event = userOperationEvent({
      receipt,
      entryPointAddress: config.wallet.entryPointAddress,
      accountAddress: account.account_address,
      userOperationHash: userOpHash
    });
    const deploymentEvent = accountDeployedEvent({
      receipt,
      entryPointAddress: config.wallet.entryPointAddress,
      accountAddress: account.account_address,
      userOperationHash: userOpHash,
      factoryAddress: config.wallet.safeFactoryAddress
    });
    if (!event || event.success !== true || !deploymentEvent) {
      throw new Error("SAFE_DEPLOYMENT_EVENT_INVALID");
    }
  } else {
    const creationEvent = proxyCreationEvent({
      receipt,
      factoryAddress: config.wallet.safeFactoryAddress,
      accountAddress: account.account_address,
      singletonAddress: config.wallet.safeSingletonAddress
    });
    if (getAddress(transaction.to) !== getAddress(config.wallet.safeFactoryAddress) || !creationEvent) {
      throw new Error("SAFE_FACTORY_DEPLOYMENT_INVALID");
    }
  }
  const attestation = await attest({
    config, account, credentials, client: rpc, blockNumber: finalized.number
  });
  const recovery = credentials.find((credential) => credential.purpose === "recovery" && credential.state === "active");
  const plan = await buildPlan({
    config,
    passkeyPublicKey: attestation.passkeyPublicKey,
    recoveryAddress: recovery?.owner_address || null,
    client: rpc,
    blockNumber: finalized.number
  });
  if (getAddress(plan.accountAddress) !== getAddress(account.account_address)
    || plan.factoryDataHash !== account.factory_data_hash
    || plan.provisioningCommitment !== account.provisioning_commitment
    || !/^(0|[1-9][0-9]{0,77})$/.test(account.salt_nonce_text || "")
    || plan.saltNonce !== account.salt_nonce_text) {
    throw new Error("SAFE_DEPLOYMENT_COMMITMENT_MISMATCH");
  }
  if (!userOpHash && transaction.input !== plan.factoryData) {
    throw new Error("SAFE_FACTORY_DEPLOYMENT_INVALID");
  }
  return {
    accountId: account.id,
    accountAddress: getAddress(account.account_address),
    userOperationHash: userOpHash,
    transactionHash,
    blockNumber: receipt.blockNumber,
    blockHash: canonical.hash,
    finalizedHeadNumber: finalized.number,
    finalizedHeadHash: finalized.hash,
    provisioningCommitment: plan.provisioningCommitment
  };
};

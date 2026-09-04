import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  keccak256,
  zeroAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { P256, PublicKey } from "ox";
import {
  assertP256PublicKey,
  buildSafeProvisioningPlan,
  createRecoveryChallenge,
  findFinalizedSafeFactoryDeployment,
  passkeyCredentialCommitment,
  verifyFinalizedSafeDeployment,
  verifyRecoveryAuthorization
} from "../lib/server/wallet-provisioning.js";

const code = "0x6001600055";
const codeHash = keccak256(code);
const addresses = {
  entryPointAddress: "0x1111111111111111111111111111111111111111",
  safeFactoryAddress: "0x2222222222222222222222222222222222222222",
  safeSingletonAddress: "0x3333333333333333333333333333333333333333",
  safeFallbackHandlerAddress: "0x4444444444444444444444444444444444444444",
  safeWebAuthnSharedSignerAddress: "0x5555555555555555555555555555555555555555",
  safe4337ModuleAddress: "0x4444444444444444444444444444444444444444",
  safePasskeyVerifierAddress: "0x6666666666666666666666666666666666666666",
  safeModuleSetupAddress: "0x7777777777777777777777777777777777777777",
  safeMultiSendAddress: "0x8888888888888888888888888888888888888888"
};
const config = {
  siteUrl: "https://staging.example",
  wallet: {
    chainId: 11155111,
    ...addresses,
    entryPointCodeHash: codeHash,
    safeFactoryCodeHash: codeHash,
    safeSingletonCodeHash: codeHash,
    safeFallbackHandlerCodeHash: codeHash,
    safeWebAuthnSharedSignerCodeHash: codeHash,
    safe4337ModuleCodeHash: codeHash,
    safePasskeyVerifierCodeHash: codeHash,
    safeModuleSetupCodeHash: codeHash,
    safeMultiSendCodeHash: codeHash,
    safeProxyCodeHash: codeHash,
    safeVersion: "1.4.1",
    moduleVersion: "0.3.0",
    entryPointVersion: "0.7"
  }
};
const finalizedHash = `0x${"99".repeat(32)}`;
const deploymentHash = `0x${"aa".repeat(32)}`;
const userOpHash = `0x${"bb".repeat(32)}`;
const accountAddress = getAddress("0x9999999999999999999999999999999999999999");
const client = {
  async getChainId() { return 11155111; },
  async getBytecode() { return code; },
  async getBlock(input) {
    if (input.blockTag === "finalized") return { number: 120n, hash: finalizedHash };
    return { number: BigInt(input.blockNumber), hash: deploymentHash };
  }
};

const { publicKey } = P256.createKeyPair();
const publicKeyHex = PublicKey.toHex(publicKey, { includePrefix: false });
assert.equal(publicKeyHex.length, 130);
assert.equal(assertP256PublicKey(publicKeyHex), publicKeyHex.toLowerCase());
assert.throws(() => assertP256PublicKey(`0x${"00".repeat(64)}`), /INVALID_PASSKEY_PUBLIC_KEY/);
assert.match(passkeyCredentialCommitment(publicKeyHex), /^0x[0-9a-f]{64}$/);

const userId = "10000000-0000-4000-8000-000000000001";
const recovery = privateKeyToAccount(`0x${"12".repeat(32)}`);
const challenge = createRecoveryChallenge({
  config,
  userId,
  passkeyPublicKey: publicKeyHex,
  recoveryAddress: recovery.address,
  now: 1_788_000_000_000
});
const signature = await recovery.signMessage({ message: challenge.message });
const proof = await verifyRecoveryAuthorization({
  config,
  userId,
  passkeyPublicKey: publicKeyHex,
  recoveryAddress: recovery.address,
  proof: { nonce: challenge.nonce, expires_at: challenge.expires_at, signature },
  now: 1_788_000_001_000
});
assert.match(proof.proofHash, /^0x[0-9a-f]{64}$/);
await assert.rejects(() => verifyRecoveryAuthorization({
  config,
  userId,
  passkeyPublicKey: publicKeyHex,
  recoveryAddress: recovery.address,
  proof: { nonce: challenge.nonce, expires_at: challenge.expires_at, signature },
  now: 1_788_000_301_000
}), /RECOVERY_PROOF_INVALID/);

let accountFactoryParameters;
const plan = await buildSafeProvisioningPlan({
  config,
  passkeyPublicKey: publicKeyHex,
  recoveryAddress: recovery.address,
  client,
  safeAccountFactory: async (parameters) => {
    accountFactoryParameters = parameters;
    return {
      async getAddress() { return accountAddress; },
      async getFactoryArgs() {
        return { factory: getAddress(config.wallet.safeFactoryAddress), factoryData: "0x12345678" };
      }
    };
  }
});
assert.equal(plan.accountAddress, accountAddress);
assert.equal(plan.recoveryAddress, recovery.address);
assert.equal(plan.verifiedBlockNumber, 120n);
assert.equal(accountFactoryParameters.threshold, 1n);
assert.equal(accountFactoryParameters.owners.length, 2);
assert.equal(accountFactoryParameters.safeModuleSetupAddress, getAddress(config.wallet.safeModuleSetupAddress));
assert.equal(accountFactoryParameters.multiSendAddress, getAddress(config.wallet.safeMultiSendAddress));
assert.equal(accountFactoryParameters.owners[1].address, recovery.address);
assert.match(plan.provisioningCommitment, /^0x[0-9a-f]{64}$/);
let passkeyOnlyFactoryParameters;
const passkeyOnlyPlan = await buildSafeProvisioningPlan({
  config,
  passkeyPublicKey: publicKeyHex,
  recoveryAddress: null,
  client,
  safeAccountFactory: async (parameters) => {
    passkeyOnlyFactoryParameters = parameters;
    return {
      async getAddress() { return accountAddress; },
      async getFactoryArgs() { return { factory: getAddress(config.wallet.safeFactoryAddress), factoryData: "0x87654321" }; }
    };
  }
});
assert.equal(passkeyOnlyFactoryParameters.owners.length, 1, "Apple Pay onboarding needs no pre-existing wallet");
assert.equal(passkeyOnlyPlan.recoveryAddress, null);
assert.equal(passkeyOnlyPlan.recoveryCommitment, null);
assert.notEqual(passkeyOnlyPlan.provisioningCommitment, plan.provisioningCommitment,
  "optional recovery is committed into a different deterministic Safe plan");
let historicalFactoryCodeCheck;
await buildSafeProvisioningPlan({
  config,
  passkeyPublicKey: publicKeyHex,
  recoveryAddress: null,
  blockNumber: 99n,
  client,
  safeAccountFactory: async (parameters) => {
    historicalFactoryCodeCheck = await parameters.client.getCode({ address: accountAddress });
    return {
      async getAddress() { return accountAddress; },
      async getFactoryArgs() {
        return historicalFactoryCodeCheck
          ? { factory: undefined, factoryData: undefined }
          : { factory: getAddress(config.wallet.safeFactoryAddress), factoryData: "0x87654321" };
      }
    };
  }
});
assert.equal(historicalFactoryCodeCheck, undefined,
  "counterfactual reconstruction does not require archive-node state for a previously absent account");

const factoryTransactionHash = `0x${"ab".repeat(32)}`;
const scannedRanges = [];
const discovered = await findFinalizedSafeFactoryDeployment({
  config,
  accountAddress,
  fromBlock: 100n,
  chunkBlocks: 10n,
  maxBlocks: 30n,
  client: {
    ...client,
    async getBytecode() { return code; },
    async getLogs(input) {
      scannedRanges.push([input.fromBlock, input.toBlock, input.args.proxy]);
      return input.fromBlock === 110n ? [{
        transactionHash: factoryTransactionHash,
        args: { proxy: accountAddress, singleton: getAddress(config.wallet.safeSingletonAddress) }
      }] : [];
    }
  }
});
assert.equal(discovered.transactionHash, factoryTransactionHash);
assert.deepEqual(scannedRanges.map(([from, to]) => [from, to]), [[100n, 109n], [110n, 119n], [120n, 120n]],
  "factory discovery uses bounded provider-friendly chunks through finalized head");
assert.ok(scannedRanges.every(([, , proxy]) => proxy === accountAddress),
  "factory discovery filters the indexed ProxyCreation account");
let pendingLogQueries = 0;
const pendingDiscovery = await findFinalizedSafeFactoryDeployment({
  config,
  accountAddress,
  fromBlock: 100n,
  client: {
    ...client,
    async getBytecode() { return "0x"; },
    async getLogs() { pendingLogQueries += 1; return []; }
  }
});
assert.equal(pendingDiscovery.transactionHash, null);
assert.equal(pendingLogQueries, 0, "an undeployed account does not trigger a historical log scan");
await assert.rejects(() => findFinalizedSafeFactoryDeployment({
  config,
  accountAddress,
  fromBlock: 1n,
  maxBlocks: 10n,
  client
}), /SAFE_DEPLOYMENT_SCAN_RANGE_EXCEEDED/);

const eventAbi = [{
  type: "event", name: "UserOperationEvent", inputs: [
    { name: "userOpHash", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "paymaster", type: "address", indexed: true },
    { name: "nonce", type: "uint256", indexed: false },
    { name: "success", type: "bool", indexed: false },
    { name: "actualGasCost", type: "uint256", indexed: false },
    { name: "actualGasUsed", type: "uint256", indexed: false }
  ]
}];
const eventLog = (success = true) => ({
  address: getAddress(config.wallet.entryPointAddress),
  topics: encodeEventTopics({
    abi: eventAbi,
    eventName: "UserOperationEvent",
    args: { userOpHash, sender: accountAddress, paymaster: zeroAddress }
  }),
  data: encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    [0n, success, 1n, 1n]
  )
});
const accountDeployedLog = () => ({
  address: getAddress(config.wallet.entryPointAddress),
  topics: encodeEventTopics({
    abi: [{
      type: "event", name: "AccountDeployed", inputs: [
        { name: "userOpHash", type: "bytes32", indexed: true },
        { name: "sender", type: "address", indexed: true },
        { name: "factory", type: "address", indexed: false },
        { name: "paymaster", type: "address", indexed: false }
      ]
    }],
    eventName: "AccountDeployed",
    args: { userOpHash, sender: accountAddress }
  }),
  data: encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    [getAddress(config.wallet.safeFactoryAddress), zeroAddress]
  )
});
const proxyCreationLog = () => ({
  address: getAddress(config.wallet.safeFactoryAddress),
  topics: encodeEventTopics({
    abi: [{
      type: "event", name: "ProxyCreation", inputs: [
        { name: "proxy", type: "address", indexed: true },
        { name: "singleton", type: "address", indexed: false }
      ]
    }],
    eventName: "ProxyCreation",
    args: { proxy: accountAddress }
  }),
  data: encodeAbiParameters([{ type: "address" }], [getAddress(config.wallet.safeSingletonAddress)])
});
const deploymentClient = {
  ...client,
  async getBytecode(input) {
    if (getAddress(input.address) === accountAddress && input.blockNumber === 99n) return "0x";
    return code;
  },
  async getTransaction() {
    return { to: getAddress(config.wallet.entryPointAddress), input: "0xabcdef" };
  },
  async getTransactionReceipt() {
    return {
      status: "success",
      blockNumber: 100n,
      blockHash: deploymentHash,
      to: getAddress(config.wallet.entryPointAddress),
      logs: [accountDeployedLog(), eventLog()]
    };
  }
};
const account = {
  id: "20000000-0000-4000-8000-000000000001",
  account_address: accountAddress.toLowerCase(),
  state: "counterfactual",
  provisioning_commitment: plan.provisioningCommitment,
  factory_data_hash: plan.factoryDataHash,
  salt_nonce_text: plan.saltNonce
};
const credentials = [
  {
    purpose: "owner", state: "active",
    owner_address: config.wallet.safeWebAuthnSharedSignerAddress,
    credential_commitment: plan.passkeyCommitment
  },
  {
    purpose: "recovery", state: "active",
    owner_address: recovery.address.toLowerCase(),
    credential_commitment: plan.recoveryCommitment
  }
];
const evidence = await verifyFinalizedSafeDeployment({
  config,
  account,
  credentials,
  deploymentUserOpHash: userOpHash,
  deploymentTransactionHash: `0x${"cc".repeat(32)}`,
  client: deploymentClient,
  attest: async ({ blockNumber }) => {
    assert.equal(blockNumber, 120n, "activation attests the current finalized Safe state without requiring an archive node");
    return { passkeyPublicKey: publicKeyHex };
  },
  buildPlan: async ({ blockNumber }) => {
    assert.equal(blockNumber, 120n, "factory data is rebuilt against current finalized infrastructure");
    return plan;
  }
});
assert.equal(evidence.blockNumber, 100n);
assert.equal(evidence.blockHash, deploymentHash);
assert.equal(evidence.provisioningCommitment, plan.provisioningCommitment);
const directEvidence = await verifyFinalizedSafeDeployment({
  config,
  account,
  credentials,
  deploymentUserOpHash: null,
  deploymentTransactionHash: `0x${"dd".repeat(32)}`,
  client: {
    ...deploymentClient,
    async getTransaction() {
      return { to: getAddress(config.wallet.safeFactoryAddress), input: plan.factoryData };
    },
    async getTransactionReceipt() {
      return {
        status: "success", blockNumber: 100n, blockHash: deploymentHash,
        to: getAddress(config.wallet.safeFactoryAddress), logs: [proxyCreationLog()]
      };
    }
  },
  attest: async () => ({ passkeyPublicKey: publicKeyHex }),
  buildPlan: async ({ blockNumber }) => {
    assert.equal(blockNumber, 120n, "direct deployments use current finalized infrastructure for reconstruction");
    return plan;
  }
});
assert.equal(directEvidence.userOperationHash, null, "a direct factory deployment has no invented UserOperation hash");
const passkeyOnlyEvidence = await verifyFinalizedSafeDeployment({
  config,
  account: {
    ...account,
    signer_count: 1,
    provisioning_commitment: passkeyOnlyPlan.provisioningCommitment,
    factory_data_hash: passkeyOnlyPlan.factoryDataHash,
    salt_nonce_text: passkeyOnlyPlan.saltNonce
  },
  credentials: [credentials[0]],
  deploymentUserOpHash: null,
  deploymentTransactionHash: `0x${"de".repeat(32)}`,
  client: {
    ...deploymentClient,
    async getTransaction() {
      return { to: getAddress(config.wallet.safeFactoryAddress), input: passkeyOnlyPlan.factoryData };
    },
    async getTransactionReceipt() {
      return {
        status: "success", blockNumber: 100n, blockHash: deploymentHash,
        to: getAddress(config.wallet.safeFactoryAddress), logs: [proxyCreationLog()]
      };
    }
  },
  attest: async () => ({ passkeyPublicKey: publicKeyHex }),
  buildPlan: async ({ blockNumber }) => {
    assert.equal(blockNumber, 120n);
    return passkeyOnlyPlan;
  }
});
assert.equal(passkeyOnlyEvidence.provisioningCommitment, passkeyOnlyPlan.provisioningCommitment);
await assert.rejects(() => verifyFinalizedSafeDeployment({
  config,
  account,
  credentials,
  deploymentUserOpHash: null,
  deploymentTransactionHash: `0x${"dd".repeat(32)}`,
  client: {
    ...deploymentClient,
    async getTransaction() {
      return { to: getAddress(config.wallet.safeFactoryAddress), input: "0xdeadbeef" };
    },
    async getTransactionReceipt() {
      return {
        status: "success", blockNumber: 100n, blockHash: deploymentHash,
        to: getAddress(config.wallet.safeFactoryAddress), logs: [proxyCreationLog()]
      };
    }
  },
  attest: async () => ({ passkeyPublicKey: publicKeyHex }),
  buildPlan: async () => plan
}), /SAFE_FACTORY_DEPLOYMENT_INVALID/, "a direct operator transaction must use the prepared calldata byte-for-byte");
await assert.rejects(() => verifyFinalizedSafeDeployment({
  config,
  account,
  credentials,
  deploymentUserOpHash: null,
  deploymentTransactionHash: `0x${"dd".repeat(32)}`,
  client: {
    ...deploymentClient,
    async getTransaction() {
      return { to: getAddress(config.wallet.safeFactoryAddress), input: plan.factoryData };
    },
    async getTransactionReceipt() {
      return {
        status: "success", blockNumber: 100n, blockHash: deploymentHash,
        to: getAddress(config.wallet.safeFactoryAddress), logs: []
      };
    }
  },
  attest: async () => ({ passkeyPublicKey: publicKeyHex }),
  buildPlan: async () => plan
}), /SAFE_FACTORY_DEPLOYMENT_INVALID/, "a direct transaction requires the canonical factory ProxyCreation event");
await assert.rejects(() => verifyFinalizedSafeDeployment({
  config,
  account,
  credentials,
  deploymentUserOpHash: userOpHash,
  deploymentTransactionHash: `0x${"cc".repeat(32)}`,
  client: {
    ...deploymentClient,
    async getTransactionReceipt() {
      return {
        status: "success", blockNumber: 100n, blockHash: deploymentHash,
        to: getAddress(config.wallet.entryPointAddress), logs: [accountDeployedLog(), eventLog(false)]
      };
    }
  },
  attest: async () => ({ passkeyPublicKey: publicKeyHex }),
  buildPlan: async () => plan
}), /SAFE_DEPLOYMENT_EVENT_INVALID/);
await assert.rejects(() => verifyFinalizedSafeDeployment({
  config,
  account,
  credentials,
  deploymentUserOpHash: userOpHash,
  deploymentTransactionHash: `0x${"cc".repeat(32)}`,
  client: {
    ...deploymentClient,
    async getTransactionReceipt() {
      return {
        status: "success", blockNumber: 100n, blockHash: deploymentHash,
        to: getAddress(config.wallet.entryPointAddress), logs: [eventLog()]
      };
    }
  },
  attest: async () => ({ passkeyPublicKey: publicKeyHex }),
  buildPlan: async () => plan
}), /SAFE_DEPLOYMENT_EVENT_INVALID/, "UserOperation success without AccountDeployed is not deployment evidence");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migration = await readFile(join(root, "supabase/migrations/20260912010000_passkey_safe_provisioning.sql"), "utf8");
assert.match(migration, /pg_advisory_xact_lock/, "parallel preparation is serialized per member");
assert.match(migration, /smart_account_provisioning_identity_immutable/, "prepared identity is immutable");
assert.match(migration, /smart_account_deployment_evidence_immutable/, "finalized evidence is immutable");
assert.match(migration, /activation_state := case when recovery_configured then 'recovery-ready' else 'deployed' end/,
  "activation distinguishes optional recovery from passkey-only onboarding");
assert.match(migration, /smart_account_recovery_challenge_invalid/, "recovery proof challenges are atomically consumed");
assert.match(migration, /issue_wallet_recovery_challenge[\s\S]*pg_advisory_xact_lock[\s\S]*wallet_recovery_challenge_rate_limit/,
  "recovery challenge issuance is serialized and rate limited per member");
assert.match(migration, /set invalidated_at = now\(\)[\s\S]*expires_at < now\(\) - interval '1 day'/,
  "challenge issuance retains at most one outstanding proof and cleans expired evidence");
assert.doesNotMatch(migration, /selected_account\.[a-z_]+\s*<>\s*expected_/,
  "existing provisioning rows use null-safe comparisons");
assert.match(migration, /revoke all on function public\.prepare_smart_account_provisioning[\s\S]*from public, anon, authenticated/);
assert.match(migration, /grant execute on function public\.activate_smart_account_provisioning[\s\S]*to service_role/);
const sqlTest = await readFile(join(root, "supabase/tests/passkey_safe_provisioning.sql"), "utf8");
assert.match(sqlTest, /passkey-only finalized deployment did not activate correctly/, "SQL covers direct deployment activation");
assert.match(sqlTest, /provisioning RPC escaped service-role boundary/, "SQL checks that clients cannot call provisioning RPCs");

const route = await readFile(join(root, "api/wallet/provision.js"), "utf8");
assert.match(route, /requireWalletIdentityConfig/, "provisioning uses identity-only readiness");
assert.match(route, /getAuthenticatedCurator/, "provisioning requires a server-validated session");
assert.match(route, /request\.headers\.get\("origin"\) !== config\.siteUrl/, "provisioning is same-origin only");
assert.match(route, /prepare_smart_account_provisioning/, "counterfactual identity is persisted through the service RPC");
assert.match(route, /activate_smart_account_provisioning/, "activation is a separate finalized-evidence transition");
assert.match(route, /body\.stage === "status"/, "authenticated status can resume a prepared wallet without browser-held evidence");
assert.match(route, /findFinalizedSafeFactoryDeployment/, "status discovers a finalized direct factory deployment");
assert.match(route, /issue_wallet_recovery_challenge/, "recovery challenge creation uses the atomic rate-limited RPC");
assert.match(route, /wallet_recovery_rate_limited/, "challenge exhaustion returns an explicit retry response");
assert.match(route, /passkey_credential_commitment: plan\.passkeyCommitment/,
  "the prepared response includes the non-secret commitment required by the guarded operator");
assert.doesNotMatch(route, /private[_-]?key|mnemonic|seed phrase/i, "the server must never collect signing secrets");
const auctionBidRoute = await readFile(join(root, "api/auctions/[id]/bids.js"), "utf8");
assert.match(auctionBidRoute, /smart_accounts"\)\.select\("[^"]*recovery_ready,finalized_at"\)/,
  "bid submission loads finalized wallet evidence before applying primary readiness");
assert.match(auctionBidRoute, /primaryWalletReady\(account\)/,
  "bid submission admits only a finalized passkey-only or recovery-ready Safe");

const operatorScript = await readFile(join(root, "scripts/deploy-prepared-safe.mjs"), "utf8");
assert.match(operatorScript, /GROVE_PROVISIONING_TARGET.*staging/, "the operator deployer is staging-only");
assert.match(operatorScript, /keccak256\(factoryData\) === factoryDataHash/, "the operator deployer verifies prepared calldata");
assert.match(operatorScript, /decodeFunctionData/, "the operator deployer decodes the exact factory call");
assert.match(operatorScript, /client\.call/, "the exact Safe factory call is simulated before spending gas");
assert.match(operatorScript, /"send", factory, factoryData/, "cast receives the reviewed calldata as its positional raw transaction input");
assert.match(operatorScript, /--keystore/, "the operator deployer accepts an encrypted local keystore");
assert.match(operatorScript, /--password-file/, "the keystore secret is passed through a mode-0600 temporary file");
assert.match(operatorScript, /rmSync\(passwordDirectory/, "the temporary password file is removed after the signer exits");
assert.match(operatorScript, /calls\.length, 2/, "operator requires exactly the reviewed Safe setup calls");
assert.match(operatorScript, /GROVE_PREPARED_PASSKEY_COMMITMENT/, "operator binds calldata to the prepared passkey");
assert.doesNotMatch(operatorScript, /"--rpc-url"/, "RPC credentials stay out of the child process argument list");
assert.doesNotMatch(operatorScript, /--private-key|privateKeyToAccount|mnemonic/i,
  "the operator deployer never accepts raw signing keys");

const maliciousFactoryData = encodeFunctionData({
  abi: [{
    type: "function", name: "createProxyWithNonce", stateMutability: "nonpayable",
    inputs: [{ name: "singleton", type: "address" }, { name: "initializer", type: "bytes" }, { name: "salt", type: "uint256" }],
    outputs: [{ name: "proxy", type: "address" }]
  }],
  functionName: "createProxyWithNonce",
  args: [getAddress(config.wallet.safeSingletonAddress), "0x1234", 1n]
});
const stopped = spawnSync(process.execPath, [join(root, "scripts/deploy-prepared-safe.mjs")], {
  encoding: "utf8",
  env: {
    ...process.env,
    GROVE_PROVISIONING_TARGET: "staging",
    GROVE_ETHEREUM_CHAIN_ID: "11155111",
    GROVE_SITE_URL: "https://staging.marketplace.invalid",
    GROVE_ETHEREUM_RPC_URL: "https://rpc.invalid",
    GROVE_SAFE_FACTORY_ADDRESS: config.wallet.safeFactoryAddress,
    GROVE_SAFE_SINGLETON_ADDRESS: config.wallet.safeSingletonAddress,
    GROVE_PREPARED_ACCOUNT_ADDRESS: accountAddress,
    GROVE_SAFE_MODULE_SETUP_ADDRESS: config.wallet.safeModuleSetupAddress,
    GROVE_SAFE_MULTISEND_ADDRESS: config.wallet.safeMultiSendAddress,
    GROVE_SAFE_4337_MODULE_ADDRESS: config.wallet.safe4337ModuleAddress,
    GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS: config.wallet.safeWebAuthnSharedSignerAddress,
    GROVE_SAFE_PASSKEY_VERIFIER_ADDRESS: config.wallet.safePasskeyVerifierAddress,
    GROVE_PREPARED_FACTORY_DATA: maliciousFactoryData,
    GROVE_PREPARED_FACTORY_DATA_HASH: keccak256(maliciousFactoryData),
    GROVE_PREPARED_SALT_NONCE: "1",
    GROVE_PREPARED_PASSKEY_COMMITMENT: plan.passkeyCommitment
  }
});
assert.notEqual(stopped.status, 0, "operator must reject arbitrary self-consistent factory calldata");
assert.match(stopped.stderr, /initializer|SAFE_DEPLOYMENT_FAILED/i);

console.log("Wallet provisioning tests passed: P-256 validation, recovery proof, pinned deterministic Safe, and finalized activation.");

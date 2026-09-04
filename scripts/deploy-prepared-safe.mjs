import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  encodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256
} from "viem";
import { sepolia } from "viem/chains";

const env = (name) => String(process.env[name] || "").trim();
const SAFE_FACTORY_ABI = [{
  type: "function",
  name: "createProxyWithNonce",
  stateMutability: "nonpayable",
  inputs: [
    { name: "singleton", type: "address" },
    { name: "initializer", type: "bytes" },
    { name: "saltNonce", type: "uint256" }
  ],
  outputs: [{ name: "proxy", type: "address" }]
}];
const SAFE_SETUP_ABI = [{
  type: "function",
  name: "setup",
  stateMutability: "nonpayable",
  inputs: [
    { name: "_owners", type: "address[]" },
    { name: "_threshold", type: "uint256" },
    { name: "to", type: "address" },
    { name: "data", type: "bytes" },
    { name: "fallbackHandler", type: "address" },
    { name: "paymentToken", type: "address" },
    { name: "payment", type: "uint256" },
    { name: "paymentReceiver", type: "address" }
  ],
  outputs: []
}];
const MULTISEND_ABI = [{
  type: "function", name: "multiSend", stateMutability: "payable",
  inputs: [{ name: "transactions", type: "bytes" }], outputs: []
}];
const ENABLE_MODULES_ABI = [{
  type: "function", name: "enableModules", stateMutability: "nonpayable",
  inputs: [{ name: "modules", type: "address[]" }], outputs: []
}];
const CONFIGURE_PASSKEY_ABI = [{
  type: "function", name: "configure", stateMutability: "nonpayable",
  inputs: [{
    name: "signer", type: "tuple", components: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
      { name: "verifiers", type: "uint176" }
    ]
  }], outputs: []
}];

const requiredAddress = (name) => {
  const input = env(name);
  assert.ok(isAddress(input, { strict: true }), `${name} must be a valid address.`);
  return getAddress(input);
};
const requiredHash = (name) => {
  const input = env(name).toLowerCase();
  assert.ok(isHex(input, { size: 32 }), `${name} must be a 32-byte hash.`);
  return input;
};
const decodeMultiSendTransactions = (input) => {
  assert.ok(isHex(input), "MultiSend transactions are invalid.");
  const value = input.slice(2);
  const transactions = [];
  let cursor = 0;
  while (cursor < value.length) {
    assert.ok(value.length - cursor >= 170, "MultiSend transaction header is truncated.");
    const operation = Number.parseInt(value.slice(cursor, cursor + 2), 16);
    const to = getAddress(`0x${value.slice(cursor + 2, cursor + 42)}`);
    const amount = BigInt(`0x${value.slice(cursor + 42, cursor + 106)}`);
    const dataBytes = BigInt(`0x${value.slice(cursor + 106, cursor + 170)}`);
    assert.ok(dataBytes <= 65_536n, "MultiSend transaction data is too large.");
    const dataCharacters = Number(dataBytes) * 2;
    const end = cursor + 170 + dataCharacters;
    assert.ok(end <= value.length, "MultiSend transaction data is truncated.");
    transactions.push({ operation, to, value: amount, data: `0x${value.slice(cursor + 170, end)}` });
    cursor = end;
  }
  return transactions;
};

const main = async () => {
  assert.equal(env("GROVE_PROVISIONING_TARGET"), "staging", "GROVE_PROVISIONING_TARGET must be staging.");
  assert.equal(env("GROVE_ETHEREUM_CHAIN_ID"), "11155111", "Only Ethereum Sepolia is accepted.");
  assert.equal(env("GROVE_SITE_URL"), "https://staging.marketplace.invalid", "The stable staging origin is required.");

  const rpcUrl = new URL(env("GROVE_ETHEREUM_RPC_URL"));
  assert.equal(rpcUrl.protocol, "https:", "A HTTPS Sepolia RPC is required.");
  const factory = requiredAddress("GROVE_SAFE_FACTORY_ADDRESS");
  const singleton = requiredAddress("GROVE_SAFE_SINGLETON_ADDRESS");
  const account = requiredAddress("GROVE_PREPARED_ACCOUNT_ADDRESS");
  const moduleSetup = requiredAddress("GROVE_SAFE_MODULE_SETUP_ADDRESS");
  const multiSend = requiredAddress("GROVE_SAFE_MULTISEND_ADDRESS");
  const safe4337Module = requiredAddress("GROVE_SAFE_4337_MODULE_ADDRESS");
  const sharedSigner = requiredAddress("GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS");
  const passkeyVerifier = requiredAddress("GROVE_SAFE_PASSKEY_VERIFIER_ADDRESS");
  const factoryData = env("GROVE_PREPARED_FACTORY_DATA");
  const factoryDataHash = env("GROVE_PREPARED_FACTORY_DATA_HASH").toLowerCase();
  const saltNonce = env("GROVE_PREPARED_SALT_NONCE");
  assert.ok(isHex(factoryData) && factoryData.length <= 131_074, "Prepared factory calldata is invalid.");
  assert.ok(isHex(factoryDataHash, { size: 32 }) && keccak256(factoryData) === factoryDataHash,
    "Prepared factory calldata does not match its commitment.");
  assert.match(saltNonce, /^(0|[1-9][0-9]{0,77})$/, "Prepared salt nonce is invalid.");
  const decoded = decodeFunctionData({ abi: SAFE_FACTORY_ABI, data: factoryData });
  assert.equal(decoded.functionName, "createProxyWithNonce", "Only direct Safe proxy creation is allowed.");
  assert.equal(getAddress(decoded.args[0]), singleton, "Prepared calldata targets a different Safe singleton.");
  assert.equal(decoded.args[2], BigInt(saltNonce), "Prepared calldata has a different Safe salt.");

  const setup = decodeFunctionData({ abi: SAFE_SETUP_ABI, data: decoded.args[1] });
  assert.equal(setup.functionName, "setup", "Prepared initializer is not Safe setup.");
  const [owners, threshold, setupTarget, setupData, fallbackHandler, paymentToken, payment, paymentReceiver] = setup.args;
  const recoveryInput = env("GROVE_PREPARED_RECOVERY_ADDRESS");
  const expectedOwners = recoveryInput
    ? [sharedSigner, requiredAddress("GROVE_PREPARED_RECOVERY_ADDRESS")]
    : [sharedSigner];
  assert.equal(new Set(expectedOwners).size, expectedOwners.length, "Recovery owner must differ from the passkey signer.");
  assert.deepEqual(owners.map((owner) => getAddress(owner)), expectedOwners,
    "Prepared initializer owners are not the reviewed passkey/recovery tuple.");
  assert.equal(threshold, 1n, "Prepared Safe threshold must be one.");
  assert.equal(getAddress(setupTarget), multiSend, "Prepared initializer must use the pinned MultiSend.");
  assert.equal(getAddress(fallbackHandler), safe4337Module, "Prepared initializer has a different 4337 fallback handler.");
  assert.equal(getAddress(paymentToken), getAddress("0x0000000000000000000000000000000000000000"));
  assert.equal(payment, 0n, "Prepared initializer cannot pay during setup.");
  assert.equal(getAddress(paymentReceiver), getAddress("0x0000000000000000000000000000000000000000"));
  const multiSendCall = decodeFunctionData({ abi: MULTISEND_ABI, data: setupData });
  assert.equal(multiSendCall.functionName, "multiSend", "Prepared initializer has invalid MultiSend data.");
  const calls = decodeMultiSendTransactions(multiSendCall.args[0]);
  assert.equal(calls.length, 2, "Prepared initializer must contain only module enablement and passkey configuration.");
  assert.deepEqual(calls.map((call) => [call.operation, call.to, call.value]), [
    [1, moduleSetup, 0n], [1, sharedSigner, 0n]
  ], "Prepared initializer contains an unreviewed setup call.");
  const enabled = decodeFunctionData({ abi: ENABLE_MODULES_ABI, data: calls[0].data });
  assert.equal(enabled.functionName, "enableModules", "Prepared initializer has invalid module setup data.");
  assert.deepEqual(enabled.args[0].map((module) => getAddress(module)), [safe4337Module],
    "Prepared initializer enables an unreviewed module.");
  const configured = decodeFunctionData({ abi: CONFIGURE_PASSKEY_ABI, data: calls[1].data });
  assert.equal(configured.functionName, "configure", "Prepared initializer has invalid passkey configuration data.");
  const signer = configured.args[0];
  assert.equal(BigInt(signer.verifiers ?? signer[2]), BigInt(passkeyVerifier), "Prepared initializer has a different passkey verifier.");
  const passkeyCommitment = keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [BigInt(signer.x ?? signer[0]), BigInt(signer.y ?? signer[1])]
  ));
  assert.equal(passkeyCommitment, requiredHash("GROVE_PREPARED_PASSKEY_COMMITMENT"),
    "Prepared initializer has a different passkey commitment.");

  const infrastructure = [
    [factory, requiredHash("GROVE_SAFE_FACTORY_CODE_HASH")],
    [singleton, requiredHash("GROVE_SAFE_SINGLETON_CODE_HASH")],
    [moduleSetup, requiredHash("GROVE_SAFE_MODULE_SETUP_CODE_HASH")],
    [multiSend, requiredHash("GROVE_SAFE_MULTISEND_CODE_HASH")],
    [safe4337Module, requiredHash("GROVE_SAFE_4337_MODULE_CODE_HASH")],
    [sharedSigner, requiredHash("GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_CODE_HASH")],
    [passkeyVerifier, requiredHash("GROVE_SAFE_PASSKEY_VERIFIER_CODE_HASH")]
  ];
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl.href) });
  assert.equal(await client.getChainId(), 11155111, "RPC returned the wrong chain.");
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const [infrastructureCodes, existingAccountCode] = await Promise.all([
    Promise.all(infrastructure.map(([address]) => client.getBytecode({ address, blockNumber: finalized.number }))),
    client.getBytecode({ address: account })
  ]);
  infrastructureCodes.forEach((code, index) => {
    assert.ok(code && keccak256(code) === infrastructure[index][1], "Pinned Safe infrastructure code hash mismatch.");
  });
  assert.ok(!existingAccountCode || existingAccountCode === "0x", "The prepared Safe is already deployed.");
  const simulation = await client.call({ to: factory, data: factoryData });
  assert.ok(simulation.data, "Safe factory simulation returned no account.");
  const simulatedAccount = decodeFunctionResult({
    abi: SAFE_FACTORY_ABI,
    functionName: "createProxyWithNonce",
    data: simulation.data
  });
  assert.equal(getAddress(simulatedAccount), account, "Factory simulation derived a different Safe address.");

  const keystorePath = env("GROVE_PROVISIONING_KEYSTORE_PATH");
  const keystorePassword = env("GROVE_PROVISIONING_KEYSTORE_PASSWORD");
  assert.ok(keystorePath && existsSync(keystorePath), "An existing encrypted keystore path is required.");
  assert.ok(keystorePassword, "The keystore password must be supplied only in the operator environment.");
  const passwordDirectory = mkdtempSync(join(tmpdir(), "grove-keystore-password-"));
  const passwordPath = join(passwordDirectory, "password");
  writeFileSync(passwordPath, keystorePassword, { encoding: "utf8", mode: 0o600, flag: "wx" });
  let result;
  try {
    result = spawnSync("cast", [
      "send", factory, factoryData, "--keystore", keystorePath,
      "--password-file", passwordPath, "--json"
    ], {
      encoding: "utf8",
      env: { ...process.env, ETH_RPC_URL: rpcUrl.href },
      stdio: ["ignore", "pipe", "pipe"]
    });
  } finally {
    rmSync(passwordDirectory, { recursive: true, force: true });
  }
  if (result.status !== 0) throw new Error("SAFE_FACTORY_SEND_FAILED");
  let sent;
  try { sent = JSON.parse(result.stdout); } catch { throw new Error("SAFE_FACTORY_RECEIPT_INVALID"); }
  const transactionHash = sent.transactionHash || sent.transaction_hash;
  assert.ok(isHex(transactionHash, { size: 32 }), "Safe deployment transaction hash is missing.");
  const receipt = await client.getTransactionReceipt({ hash: transactionHash });
  const finalizedAfter = await client.getBlock({ blockTag: "finalized" });
  console.log(JSON.stringify({
    account_address: account,
    factory_address: factory,
    deployment_transaction_hash: transactionHash,
    deployment_block: receipt.blockNumber.toString(),
    deployment_block_hash: receipt.blockHash,
    status: receipt.status,
    finalized: receipt.blockNumber <= finalizedAfter.number
  }, null, 2));
};

main().catch((error) => {
  const code = String(error?.message || "SAFE_DEPLOYMENT_FAILED");
  const safeMessage = error instanceof assert.AssertionError || /^[A-Z0-9_]+$/.test(code)
    ? code
    : "SAFE_DEPLOYMENT_FAILED";
  console.error(`Prepared Safe deployment stopped: ${safeMessage}`);
  process.exitCode = 1;
});

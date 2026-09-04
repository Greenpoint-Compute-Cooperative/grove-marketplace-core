import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionResult, getAddress, keccak256 } from "viem";
import {
  cancellationCall,
  decodeSecondaryActionCall,
  ERC20_APPROVE_ABI,
  SEAPORT_CANCEL_ABI,
  encodeSafeSecondaryCall,
  fulfillmentCall,
  tokenApprovalCall,
  usdcApprovalCall
} from "../lib/shared/secondary-actions.js";
import {
  assertUserOperationSignatureWindow,
  maximumSponsoredCost,
  userOperationCommitment,
  userOperationToJson
} from "../lib/shared/sponsored-userop.js";
import { ZERO_ADDRESS, ZERO_HASH } from "../lib/shared/resale-order.js";
import { prepareProviderSponsoredOperation } from "../lib/server/userop-provider.js";
import {
  assertPreparedSubmission,
  reconcileSponsoredSecondaryOperation,
  requireSecondarySponsorshipConfig,
  simulateSecondaryAction
} from "../lib/server/secondary-sponsorship.js";

const account = getAddress("0x1111111111111111111111111111111111111111");
const collection = getAddress("0x2222222222222222222222222222222222222222");
const protocol = getAddress("0x0000000000000068F116a894984e2DB1123eB395");
const usdc = getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
const paymaster = getAddress("0x3333333333333333333333333333333333333333");
const entryPoint = getAddress("0x4444444444444444444444444444444444444444");
const config = {
  wallet: { chainId: 11155111, entryPointAddress: entryPoint, sponsorPolicyVersion: "secondary-v1" },
  secondary: { protocolAddress: protocol, usdcAddress: usdc }
};
const order = {
  offerer: account,
  zone: ZERO_ADDRESS,
  offer: [{ itemType: 2, token: collection, identifierOrCriteria: "7", startAmount: "1", endAmount: "1" }],
  consideration: [{
    itemType: 1, token: usdc, identifierOrCriteria: "0", startAmount: "1000000", endAmount: "1000000", recipient: account
  }],
  orderType: 0,
  startTime: "1788000000",
  endTime: "1888000000",
  zoneHash: ZERO_HASH,
  salt: "42",
  conduitKey: ZERO_HASH,
  counter: "3"
};

const tokenApprove = tokenApprovalCall({ collectionAddress: collection, protocolAddress: protocol, tokenId: 7n });
const tokenDecoded = decodeSecondaryActionCall({
  action: "resale-approve-token",
  callData: encodeSafeSecondaryCall(tokenApprove),
  config,
  accountAddress: account,
  expectedCall: tokenApprove
});
assert.equal(tokenDecoded.to, collection);
assert.equal(tokenDecoded.approved, protocol);
assert.equal(tokenDecoded.tokenId, 7n);
assert.equal(tokenDecoded.value, 0n);

const tokenRevoke = tokenApprovalCall({ collectionAddress: collection, protocolAddress: protocol, tokenId: 7n, revoke: true });
assert.equal(decodeSecondaryActionCall({
  action: "resale-revoke-token", callData: encodeSafeSecondaryCall(tokenRevoke), config, accountAddress: account, expectedCall: tokenRevoke
}).approved, getAddress(ZERO_ADDRESS));
assert.throws(() => decodeSecondaryActionCall({
  action: "resale-approve-token", callData: encodeSafeSecondaryCall(tokenRevoke), config, accountAddress: account
}), /SECONDARY_CALL_REJECTED/, "a revoke cannot be relabeled as an approval");
assert.throws(() => decodeSecondaryActionCall({
  action: "resale-approve-token", callData: encodeSafeSecondaryCall({ ...tokenApprove, value: 1n }), config, accountAddress: account
}), /SECONDARY_CALL_REJECTED/, "sponsorship never permits ETH value");

const usdcApprove = usdcApprovalCall({ usdcAddress: usdc, protocolAddress: protocol, amount: 1_000_000n });
const usdcDecoded = decodeSecondaryActionCall({
  action: "resale-approve-usdc", callData: encodeSafeSecondaryCall(usdcApprove), config, accountAddress: account, expectedCall: usdcApprove
});
assert.equal(usdcDecoded.amount, 1_000_000n);
assert.equal(usdcDecoded.spender, protocol);
assert.throws(() => decodeSecondaryActionCall({
  action: "resale-approve-usdc",
  callData: encodeSafeSecondaryCall(usdcApprovalCall({ usdcAddress: usdc, protocolAddress: collection, amount: 1_000_000n })),
  config,
  accountAddress: account
}), /SECONDARY_CALL_REJECTED/, "ERC-20 approvals cannot choose an arbitrary spender");

const signature = `0x${"11".repeat(65)}`;
const fulfill = fulfillmentCall({ protocolAddress: protocol, order, signature });
fulfill.order = order;
const fulfillDecoded = decodeSecondaryActionCall({
  action: "resale-fulfill", callData: encodeSafeSecondaryCall(fulfill), config, accountAddress: paymaster, expectedCall: fulfill
});
assert.equal(fulfillDecoded.orderHash.length, 66);
assert.equal(fulfillDecoded.order.counter, "3");

const cancel = cancellationCall({ protocolAddress: protocol, order });
cancel.order = order;
assert.equal(decodeSecondaryActionCall({
  action: "resale-cancel-order", callData: encodeSafeSecondaryCall(cancel), config, accountAddress: account, expectedCall: cancel
}).orderHash, fulfillDecoded.orderHash);
assert.throws(() => decodeSecondaryActionCall({
  action: "resale-cancel-order", callData: encodeSafeSecondaryCall(cancel), config, accountAddress: paymaster, expectedCall: cancel
}), /SECONDARY_CALL_REJECTED/, "only the offerer Safe may cancel the exact order");

const baseOperation = {
  sender: account,
  nonce: 4n,
  callData: encodeSafeSecondaryCall(tokenApprove),
  callGasLimit: 50_000n,
  verificationGasLimit: 80_000n,
  preVerificationGas: 21_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  paymaster,
  paymasterVerificationGasLimit: 40_000n,
  paymasterPostOpGasLimit: 20_000n,
  paymasterData: "0x1234"
};
assert.equal(maximumSponsoredCost(baseOperation), 422_000_000_000_000n);
assert.equal(userOperationCommitment(baseOperation), userOperationCommitment(userOperationToJson(baseOperation)));

const calls = [];
const prepared = await prepareProviderSponsoredOperation({
  config,
  safeAccount: {
    async getNonce() { return 4n; },
    async getStubSignature() { return `0x${"ff".repeat(96)}`; },
    async getAddress() { return account; }
  },
  callData: baseOperation.callData,
  fees: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  paymasterContext: { action: "resale-approve-token" },
  provider: {
    name: "test-standard-provider",
    async getPaymasterStubData() {
      calls.push("stub");
      return { paymaster, paymasterData: "0x12", paymasterVerificationGasLimit: "0x9c40", paymasterPostOpGasLimit: "0x4e20" };
    },
    async estimateUserOperationGas() {
      calls.push("estimate");
      return { callGasLimit: "0xc350", verificationGasLimit: "0x13880", preVerificationGas: "0x5208" };
    },
    async getPaymasterData() {
      calls.push("final");
      return { paymaster, paymasterData: "0x1234", paymasterVerificationGasLimit: "0x9c40", paymasterPostOpGasLimit: "0x4e20" };
    }
  }
});
assert.deepEqual(calls, ["stub", "estimate", "final", "estimate"], "final paymaster data is re-simulated");
assert.equal(prepared.quotedCostWei, maximumSponsoredCost(baseOperation));
assert.equal(prepared.operation.paymasterData, "0x1234");

const validAfter = 1_788_000_000;
const validUntil = validAfter + 300;
const packedWindow = `${BigInt(validAfter).toString(16).padStart(12, "0")}${BigInt(validUntil).toString(16).padStart(12, "0")}`;
const signedOperation = { ...baseOperation, signature: `0x${packedWindow}${"aa".repeat(32)}` };
assert.doesNotThrow(() => assertUserOperationSignatureWindow({ signature: signedOperation.signature, validAfter, validUntil }));
const decision = {
  id: 1,
  request_key: "test-request-key-0001",
  smart_account_id: "60000000-0000-4000-8000-000000000001",
  action: "resale-approve-token",
  decision: "approved",
  policy_version: "secondary-v1",
  policy_input: {
    schema: "secondary-userop-v1",
    operation_commitment: userOperationCommitment(baseOperation),
    expected_call: { to: tokenApprove.to, value: "0", data: tokenApprove.data },
    valid_after: validAfter,
    valid_until: validUntil
  }
};
assert.equal(assertPreparedSubmission({ decision, input: userOperationToJson(signedOperation, { signature: true }), config, now: validAfter + 1 }).decoded.tokenId, 7n);
assert.throws(() => assertPreparedSubmission({
  decision,
  input: userOperationToJson({ ...signedOperation, maxFeePerGas: signedOperation.maxFeePerGas + 1n }, { signature: true }),
  config,
  now: validAfter + 1
}), /USER_OPERATION_CHANGED/, "the browser cannot change gas, paymaster, nonce, or calldata after approval");

const safeCode = "0x6001";
const entryCode = "0x6002";
const collectionCode = "0x6003";
const simulatedConfig = {
  wallet: { ...config.wallet, safeProxyCodeHash: keccak256(safeCode), entryPointCodeHash: keccak256(entryCode) },
  secondary: { ...config.secondary, protocolCodeHash: keccak256("0x6004"), usdcCodeHash: keccak256("0x6005") }
};
let directCall;
const simulation = await simulateSecondaryAction({
  config: simulatedConfig,
  decoded: tokenDecoded,
  expected: { collection_code_hash: keccak256(collectionCode) },
  client: {
    async getBlock() { return { number: 99n, hash: `0x${"99".repeat(32)}`, timestamp: 1_788_000_001n }; },
    async getBytecode({ address }) {
      if (getAddress(address) === account) return safeCode;
      if (getAddress(address) === entryPoint) return entryCode;
      if (getAddress(address) === collection) return collectionCode;
      return null;
    },
    async readContract({ functionName }) {
      if (functionName === "ownerOf") return account;
      if (functionName === "getApproved") return ZERO_ADDRESS;
      throw new Error("unexpected read");
    },
    async call(input) { directCall = input; return { data: "0x" }; }
  }
});
assert.equal(simulation.blockNumber, "99");
assert.equal(directCall.account, account);
assert.equal(directCall.to, collection);
assert.equal(directCall.value, 0n);

await assert.rejects(() => simulateSecondaryAction({
  config: simulatedConfig,
  decoded: usdcDecoded,
  expected: {},
  client: {
    async getBlock() { return { number: 99n, hash: `0x${"99".repeat(32)}`, timestamp: 1_788_000_001n }; },
    async getBytecode({ address }) {
      if (getAddress(address) === account) return safeCode;
      if (getAddress(address) === entryPoint) return entryCode;
      if (getAddress(address) === usdc) return "0x6005";
      return null;
    },
    async readContract({ functionName }) {
      if (functionName === "balanceOf") return 2_000_000n;
      if (functionName === "allowance") return 0n;
      throw new Error("unexpected read");
    },
    async call() {
      return { data: encodeFunctionResult({ abi: ERC20_APPROVE_ABI, functionName: "approve", result: false }) };
    }
  }
}), /SECONDARY_SIMULATION_RETURNED_FALSE/, "a token that returns false is never treated as an approved action");

await assert.rejects(() => simulateSecondaryAction({
  config: simulatedConfig,
  decoded: decodeSecondaryActionCall({
    action: "resale-cancel-order", callData: encodeSafeSecondaryCall(cancel), config, accountAddress: account, expectedCall: cancel
  }),
  expected: {},
  client: {
    async getBlock() { return { number: 99n, hash: `0x${"99".repeat(32)}`, timestamp: 1_788_000_001n }; },
    async getBytecode({ address }) {
      if (getAddress(address) === account) return safeCode;
      if (getAddress(address) === entryPoint) return entryCode;
      if (getAddress(address) === protocol) return "0x6004";
      return null;
    },
    async readContract({ functionName }) {
      if (functionName === "getOrderStatus") return [false, false, 0n, 1n];
      if (functionName === "getCounter") return 3n;
      throw new Error("unexpected read");
    },
    async call() {
      return { data: encodeFunctionResult({ abi: SEAPORT_CANCEL_ABI, functionName: "cancel", result: false }) };
    }
  }
}), /SECONDARY_SIMULATION_RETURNED_FALSE/, "Seaport false returns are rejected even when eth_call succeeds");

const readyBoundary = {
  productionDeployment: false,
  wallet: {
    chainId: 11155111,
    stagingConfigured: true,
    sponsorExecutionEnabled: true,
    sponsorExecutionReady: false,
    sponsorBudgets: { perOperationWei: "1", perUserDailyWei: "2", globalDailyWei: "3" }
  },
  secondary: { infrastructureConfigured: true }
};
assert.throws(() => requireSecondarySponsorshipConfig(readyBoundary), /not configured/,
  "code presence cannot enable execution before the independent readiness attestation");
assert.equal(requireSecondarySponsorshipConfig({
  ...readyBoundary,
  wallet: { ...readyBoundary.wallet, sponsorExecutionReady: true }
}).wallet.chainId, 11155111);

const reconciliationUpdates = [];
const updateBuilder = (table, values) => {
  const builder = {
    error: null,
    eq() { return builder; },
    in() { return builder; }
  };
  reconciliationUpdates.push({ table, values });
  return builder;
};
const expiredCancellation = {
  ...decision,
  decision: "submitted",
  action: "resale-cancel-order",
  userop_hash: `0x${"12".repeat(32)}`,
  policy_input: {
    ...decision.policy_input,
    valid_until: validUntil,
    simulation: { blockNumber: "99", blockHash: `0x${"99".repeat(32)}` },
    reference: { listing_id: "60000000-0000-4000-8000-000000000002" }
  }
};
const expiredResult = await reconcileSponsoredSecondaryOperation({
  config,
  decision: expiredCancellation,
  provider: { async getUserOperationReceipt() { return null; } },
  client: {
    async getBlock() {
      return { number: 120n, hash: `0x${"98".repeat(32)}`, timestamp: BigInt(validUntil + 901) };
    },
    async getLogs() { return []; }
  },
  service: { from(table) { return { update(values) { return updateBuilder(table, values); } }; } }
});
assert.equal(expiredResult.state, "failed");
assert.equal(expiredResult.failureCode, "userop_expired_unincluded");
assert.deepEqual(reconciliationUpdates.map(({ table, values }) => [table, values.state, values.rejection_code]), [
  ["resale_orders", "open", undefined],
  ["sponsorship_decisions", undefined, "userop_expired_unincluded"]
], "finalized absence after bounded grace restores cancellation state and terminalizes the outbox");

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migration = await readFile(join(root, "supabase/migrations/20260909000000_secondary_sponsorship.sql"), "utf8");
assert.match(migration, /pg_advisory_xact_lock/, "budget reservations are serialized");
assert.match(migration, /sponsorship_request_key_conflict/, "request keys cannot be replayed with changed policy input");
assert.match(migration, /created_at >= pg_catalog.now\(\) - interval '24 hours'/, "user and global budgets use the private ledger");
assert.match(migration, /signed_user_operation_input jsonb/, "a signed deterministic outbox is persisted before provider submission");
assert.match(migration, /sponsorship_secondary_client_request_active_idx/,
  "concurrent prepares share one active user-scoped request generation");
assert.match(migration, /then actual_cost_wei else coalesce\(quoted_cost_wei, 0\) end/,
  "terminal operations release unused quoted gas while retaining actual spend");
assert.match(migration, /coalesce\(policy_input->>'valid_until', ''\) !~ '\^\[0-9\]\+\$'/,
  "expired unsigned secondary prepares stop reserving the gas budget");

console.log("Sponsored UserOperation tests passed: exact decoding, value/target isolation, simulation, immutable prepare/submit, and atomic budgets.");

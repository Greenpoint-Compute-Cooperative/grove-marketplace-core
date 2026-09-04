import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encodeEventTopics, getAddress, keccak256 } from "viem";
import { requireOwnerExitConfig } from "../lib/server/config.js";
import {
  decodeSecondaryActionCall,
  encodeSafeSecondaryCall,
  tokenApprovalCall,
  tokenTransferCall
} from "../lib/shared/secondary-actions.js";
import {
  canonicalEventRecordMatches,
  requireSponsorshipReconciliationConfig,
  simulateSecondaryAction,
  sponsorshipReplayAllowed,
  verifyActionReceiptLog
} from "../lib/server/secondary-sponsorship.js";
import { ZERO_ADDRESS } from "../lib/shared/resale-order.js";

const account = getAddress("0x1111111111111111111111111111111111111111");
const collection = getAddress("0x2222222222222222222222222222222222222222");
const recipient = getAddress("0x3333333333333333333333333333333333333333");
const protocol = getAddress("0x0000000000000068F116a894984e2DB1123eB395");
const entryPoint = getAddress("0x4444444444444444444444444444444444444444");
const call = tokenTransferCall({ collectionAddress: collection, fromAddress: account, recipientAddress: recipient, tokenId: 7n });
const config = {
  wallet: { chainId: 11155111, entryPointAddress: entryPoint },
  secondary: { protocolAddress: protocol, usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" }
};
const decoded = decodeSecondaryActionCall({
  action: "marketplace-transfer",
  callData: encodeSafeSecondaryCall(call),
  config,
  accountAddress: account,
  expectedCall: call
});
assert.equal(decoded.selector, "0x42842e0e", "owner exit uses only the three-argument safeTransferFrom selector");
assert.equal(decoded.collectionAddress, collection);
assert.equal(decoded.from, account);
assert.equal(decoded.recipient, recipient);
assert.equal(decoded.tokenId, 7n);
assert.equal(decoded.value, 0n);
assert.throws(() => tokenTransferCall({
  collectionAddress: collection, fromAddress: account, recipientAddress: account, tokenId: 7n
}), /SECONDARY_CALL_REJECTED/, "a token cannot exit to the source Safe");
assert.throws(() => tokenTransferCall({
  collectionAddress: collection, fromAddress: account, recipientAddress: ZERO_ADDRESS, tokenId: 7n
}), /SECONDARY_CALL_REJECTED/, "a token cannot exit to the zero address");
assert.throws(() => decodeSecondaryActionCall({
  action: "marketplace-transfer",
  callData: encodeSafeSecondaryCall(tokenApprovalCall({ collectionAddress: collection, protocolAddress: protocol, tokenId: 7n })),
  config,
  accountAddress: account
}), /SECONDARY_CALL_REJECTED/, "an approval cannot be relabeled as an owner exit");

const safeCode = "0x6001";
const entryCode = "0x6002";
const collectionCode = "0x6003";
const simulatedConfig = {
  ...config,
  wallet: { ...config.wallet, safeProxyCodeHash: keccak256(safeCode), entryPointCodeHash: keccak256(entryCode) },
  secondary: { ...config.secondary, protocolCodeHash: keccak256("0x6004"), usdcCodeHash: keccak256("0x6005") }
};
let directCall;
const simulation = await simulateSecondaryAction({
  config: simulatedConfig,
  decoded,
  expected: { collection_code_hash: keccak256(collectionCode), pending_orders: [] },
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
      if (functionName === "isApprovedForAll") return false;
      throw new Error("unexpected read");
    },
    async call(input) { directCall = input; return { data: "0x" }; }
  }
});
assert.equal(simulation.blockNumber, "99");
assert.equal(directCall.account, account, "eth_call simulates from the authenticated Safe");
assert.equal(directCall.to, collection);
assert.equal(directCall.data, call.data);
assert.equal(directCall.value, 0n);

const transferEvent = [{
  type: "event", name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: true, name: "tokenId", type: "uint256" }
  ]
}];
const transferLog = {
  address: collection,
  data: "0x",
  topics: encodeEventTopics({ abi: transferEvent, eventName: "Transfer", args: { from: account, to: recipient, tokenId: 7n } })
};
assert.equal(verifyActionReceiptLog({
  config,
  decision: {
    action: "marketplace-transfer",
    policy_input: {
      expected_call: { to: collection, token_id: "7", recipient_address: recipient },
      user_operation: { sender: account }
    }
  },
  result: { logs: [transferLog] }
}).eventName, "Transfer", "finalization requires the exact transfer event");
assert.throws(() => verifyActionReceiptLog({
  config,
  decision: {
    action: "marketplace-transfer",
    policy_input: {
      expected_call: { to: collection, token_id: "8", recipient_address: recipient },
      user_operation: { sender: account }
    }
  },
  result: { logs: [transferLog] }
}), /SECONDARY_TRANSFER_EVENT_MISSING/, "a different token event cannot finalize the exit");

await assert.rejects(() => simulateSecondaryAction({
  config: simulatedConfig,
  decoded,
  expected: { collection_code_hash: keccak256(collectionCode), pending_orders: [] },
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
      if (functionName === "isApprovedForAll") return true;
      throw new Error("unexpected read");
    },
    async call() { throw new Error("must not simulate an approved operator exit"); }
  }
}), /SECONDARY_REVOKE_REQUIRED/, "Seaport operator approval must be revoked before exit");

const disabledOwnerExit = {
  productionDeployment: false,
  wallet: { chainId: 11155111, ownerExitExecutableConfigured: false }
};
assert.throws(() => requireOwnerExitConfig(disabledOwnerExit), /not configured/);
assert.equal(requireOwnerExitConfig({
  ...disabledOwnerExit,
  wallet: { ...disabledOwnerExit.wallet, ownerExitExecutableConfigured: true }
}).wallet.chainId, 11155111);
assert.throws(() => requireSponsorshipReconciliationConfig({ wallet: { sponsorshipReconciliationConfigured: false }, secondary: {} }), /not configured/);
assert.ok(requireSponsorshipReconciliationConfig({ wallet: { sponsorshipReconciliationConfigured: true }, secondary: {} }, "marketplace-transfer"));
assert.throws(() => requireSponsorshipReconciliationConfig({
  wallet: { sponsorshipReconciliationConfigured: true }, secondary: { reconciliationConfigured: false }
}, "resale-fulfill"), /not configured/, "secondary receipts retain their exact protocol-address tuple");
assert.equal(sponsorshipReplayAllowed({ wallet: { ownerExitExecutableConfigured: false, bundlerUrl: "https://bundler.test" }, secondary: {} }, "marketplace-transfer"), false,
  "the exit kill switch prevents rebroadcast while leaving reconciliation readable");
assert.equal(sponsorshipReplayAllowed({ wallet: { ownerExitExecutableConfigured: true, bundlerUrl: "https://bundler.test" }, secondary: {} }, "marketplace-transfer"), true);
assert.equal(sponsorshipReplayAllowed({ wallet: { ownerExitExecutableConfigured: true, bundlerUrl: "" }, secondary: {} }, "marketplace-transfer"), false,
  "canonical RPC reconciliation never attempts a replay without a configured bundler");

const canonicalEvent = {
  payload_hash: `0x${"ab".repeat(32)}`,
  event_name: "Transfer",
  emitter_address: collection.toLowerCase(),
  topic0: `0x${"cd".repeat(32)}`,
  transaction_hash: `0x${"ef".repeat(32)}`,
  transaction_index: 2,
  log_index: 3,
  block_number: "99",
  block_hash: `0x${"12".repeat(32)}`,
  removed: false,
  order_hash: null,
  token_id: "7",
  from_address: account.toLowerCase(),
  to_address: recipient.toLowerCase(),
  counter: null
};
assert.equal(canonicalEventRecordMatches({ ...canonicalEvent }, canonicalEvent), true);
assert.equal(canonicalEventRecordMatches({ ...canonicalEvent, payload_hash: `0x${"00".repeat(32)}` }, canonicalEvent), false,
  "a conflicting inbox payload cannot finalize an owner exit");

const [migration, sponsor, assetsRoute, transferRoute, app, index, runtimeConfig] = await Promise.all([
  readFile(new URL("../supabase/migrations/20260910000000_owner_exit_sponsorship.sql", import.meta.url), "utf8"),
  readFile(new URL("../api/wallet/sponsor.js", import.meta.url), "utf8"),
  readFile(new URL("../api/wallet/assets.js", import.meta.url), "utf8"),
  readFile(new URL("../api/wallet/assets/[workId]/transfer-context.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../lib/server/config.js", import.meta.url), "utf8")
]);
assert.match(migration, /sponsorship_erc721_active_token_action_idx/, "one live token-changing action may reserve a token");
assert.match(migration, /action_input not in \([\s\S]*'marketplace-transfer'/, "the atomic sponsorship RPC admits exact exits");
assert.match(migration, /sponsorship_preparation_expired/, "expired unsigned exits release their token and gas reservation");
assert.match(migration, /reject_resale_listing_during_owner_exit[\s\S]*pg_advisory_xact_lock/, "listing publication serializes with owner exits");
assert.match(migration, /sponsorship_transfer_listing_conflict/, "prepare and submit both reject unresolved resale state");
assert.match(sponsor, /const exitAction = \(action\) => \["marketplace-transfer"/, "inactive members retain the owner exit");
assert.match(sponsor, /passkeyOnlyOwnerExit = action === "marketplace-transfer"[\s\S]*account\?\.state === "deployed"[\s\S]*account\?\.recovery_ready === false/, "a finalized passkey-only Safe can request only the exact owner-exit action");
assert.match(sponsor, /action: body\.stage === "prepare" \? body\.action : decision\.action/, "submit authorization derives the action from the stored decision, not caller input");
assert.match(sponsor, /sameRecipient/, "request-key idempotency binds the destination");
assert.match(sponsor, /requireSponsorshipReconciliationConfig/, "receipt polling remains available after new exits are disabled");
assert.match(assetsRoute, /owner_smart_account_id/, "private holdings are scoped to the authenticated Safe");
assert.match(assetsRoute, /Cache-Control": "private, no-store"/, "social-to-wallet ownership never enters shared cache");
assert.match(transferRoute, /request\.headers\.get\("origin"\) !== config\.siteUrl/, "transfer context is same-origin");
assert.match(transferRoute, /\["deployed", "recovery-ready"\]\.includes\(account\.state\)/, "finalized passkey-only Safes can prepare an exact owner exit");
assert.match(transferRoute, /resolveSecondaryActionContext/, "the browser cannot choose unchecked transfer calldata");
assert.match(app, /data-transfer-nft/, "owned NFTs expose an exit control");
assert.match(app, /ownerExitConfigured && work\.ownedByCurrentUser/, "flag-off hides the transfer control");
assert.match(index, /id="transfer-dialog"/, "exit requires a dedicated irreversible-transfer confirmation dialog");
assert.match(runtimeConfig, /const ownerExitReady = false/, "code deployment alone cannot activate rehearsal owner exit");
assert.match(runtimeConfig, /const ownerExitLiveReady = false/, "Sepolia readiness cannot activate mainnet owner exit");
assert.match(runtimeConfig, /ownerExitInfrastructureConfigured[\s\S]*sponsorBudgetsConfigured/, "owner exit readiness includes executable gas budgets");

console.log("Owner-exit tests passed: exact ERC721 transfer, approval isolation, private holdings, durable locking, and fail-closed release gates.");

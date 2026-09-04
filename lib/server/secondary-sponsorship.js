import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionResult,
  getAddress,
  http,
  isHex,
  keccak256,
  stringToHex
} from "viem";
import { getUserOperationHash, toWebAuthnAccount } from "viem/account-abstraction";
import { mainnet, sepolia } from "viem/chains";
import { SafeSmartAccount } from "permissionless/accounts/safe";
import { ConfigurationError, getRuntimeConfig, requireOwnerExitConfig } from "./config.js";
import {
  ERC20_APPROVE_ABI,
  SEAPORT_CANCEL_ABI,
  SEAPORT_FULFILL_ABI,
  SECONDARY_SPONSOR_ACTIONS,
  cancellationCall,
  decodeSecondaryActionCall,
  encodeSafeSecondaryCall,
  fulfillmentCall,
  tokenApprovalCall,
  tokenTransferCall,
  usdcApprovalCall
} from "../shared/secondary-actions.js";
import { ZERO_ADDRESS, normalizeResaleOrderComponents, resaleOrderHash } from "../shared/resale-order.js";
import {
  assertUserOperationSignatureWindow,
  normalizeUserOperation,
  userOperationCommitment,
  userOperationToJson
} from "../shared/sponsored-userop.js";
import { createStandardUserOperationProvider, prepareProviderSponsoredOperation } from "./userop-provider.js";
import { normalizeFinalizedResaleLog } from "./resale-indexer.js";

const ERC721_STATE_ABI = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getApproved", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "isApprovedForAll", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }], outputs: [{ name: "", type: "bool" }] }
];
const ERC20_STATE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] }
];
const SEAPORT_STATE_ABI = [
  { type: "function", name: "getCounter", stateMutability: "view", inputs: [{ name: "offerer", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getOrderStatus", stateMutability: "view", inputs: [{ name: "orderHash", type: "bytes32" }], outputs: [{ name: "validated", type: "bool" }, { name: "cancelled", type: "bool" }, { name: "filled", type: "uint256" }, { name: "size", type: "uint256" }] }
];
const ENTRY_POINT_EVENT_ABI = [{
  type: "event", name: "UserOperationEvent",
  inputs: [
    { indexed: true, name: "userOpHash", type: "bytes32" },
    { indexed: true, name: "sender", type: "address" },
    { indexed: true, name: "paymaster", type: "address" },
    { indexed: false, name: "nonce", type: "uint256" },
    { indexed: false, name: "success", type: "bool" },
    { indexed: false, name: "actualGasCost", type: "uint256" },
    { indexed: false, name: "actualGasUsed", type: "uint256" }
  ]
}];
const APPROVAL_EVENT_ABI = [{
  type: "event", name: "Approval",
  inputs: [
    { indexed: true, name: "owner", type: "address" },
    { indexed: true, name: "approved", type: "address" },
    { indexed: true, name: "tokenId", type: "uint256" }
  ]
}];
const TRANSFER_EVENT_ABI = [{
  type: "event", name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: true, name: "tokenId", type: "uint256" }
  ]
}];
const ERC20_APPROVAL_EVENT_ABI = [{
  type: "event", name: "Approval",
  inputs: [
    { indexed: true, name: "owner", type: "address" },
    { indexed: true, name: "spender", type: "address" },
    { indexed: false, name: "value", type: "uint256" }
  ]
}];
const ORDER_EVENT_ABI = [
  {
    type: "event", name: "OrderFulfilled",
    inputs: [
      { indexed: false, name: "orderHash", type: "bytes32" },
      { indexed: true, name: "offerer", type: "address" },
      { indexed: true, name: "zone", type: "address" },
      { indexed: false, name: "recipient", type: "address" },
      { indexed: false, name: "offer", type: "tuple[]", components: [
        { name: "itemType", type: "uint8" }, { name: "token", type: "address" },
        { name: "identifier", type: "uint256" }, { name: "amount", type: "uint256" }
      ] },
      { indexed: false, name: "consideration", type: "tuple[]", components: [
        { name: "itemType", type: "uint8" }, { name: "token", type: "address" },
        { name: "identifier", type: "uint256" }, { name: "amount", type: "uint256" },
        { name: "recipient", type: "address" }
      ] }
    ]
  },
  {
    type: "event", name: "OrderCancelled",
    inputs: [
      { indexed: false, name: "orderHash", type: "bytes32" },
      { indexed: true, name: "offerer", type: "address" },
      { indexed: true, name: "zone", type: "address" }
    ]
  }
];

const requestKey = (input) => typeof input === "string" && /^[A-Za-z0-9._:-]{16,200}$/.test(input) ? input : null;
const SUBMISSION_EXPIRY_GRACE_SECONDS = 900n;
const uuid = (input) => typeof input === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase() : null;
const newSponsorshipLedgerKey = () => `secondary:${randomBytes(32).toString("hex")}`;
const byteaHex = (input) => {
  if (typeof input !== "string") throw new Error("INVALID_RESALE_SIGNATURE");
  const value = input.startsWith("\\x") ? `0x${input.slice(2)}` : input;
  if (!isHex(value) || value.length < 4) throw new Error("INVALID_RESALE_SIGNATURE");
  return value;
};
const publicClientFor = (config) => createPublicClient({
  chain: config.wallet.chainId === 1 ? mainnet : sepolia,
  transport: http(config.wallet.rpcUrl)
});

export const requireSecondarySponsorshipConfig = (config = getRuntimeConfig(), action = null) => {
  if (action === "marketplace-transfer") return requireOwnerExitConfig(config);
  const budgets = config.wallet.sponsorBudgets || {};
  const budgetConfigured = budgets.perOperationWei && budgets.perUserDailyWei && budgets.globalDailyWei
    && BigInt(budgets.perOperationWei) > 0n
    && BigInt(budgets.perUserDailyWei) >= BigInt(budgets.perOperationWei)
    && BigInt(budgets.globalDailyWei) >= BigInt(budgets.perUserDailyWei);
  if (config.productionDeployment || config.wallet.chainId !== 11155111
    || !config.wallet.stagingConfigured || !config.secondary.infrastructureConfigured
    || !config.wallet.sponsorExecutionEnabled
    || !config.wallet.sponsorExecutionReady
    || !budgetConfigured) {
    throw new ConfigurationError("Sponsored secondary actions are not configured for this Sepolia rehearsal.", [
      "GROVE_SPONSOR_EXECUTION_ENABLED=true",
      "nonzero sponsorship budget limits",
      "reviewed Sepolia bundler and ERC-7677 paymaster configuration"
    ]);
  }
  return config;
};

export const requireSponsorshipReconciliationConfig = (config = getRuntimeConfig(), action = null) => {
  const actionConfigured = !action || action === "marketplace-transfer"
    || config.secondary.reconciliationConfigured === true;
  if (config.wallet.sponsorshipReconciliationConfigured && actionConfigured) return config;
  throw new ConfigurationError("Sponsored action reconciliation is not configured.", [
    "private backend configuration",
    "the exact chain RPC and EntryPoint tuple",
    "the exact Seaport and USDC addresses for resale actions"
  ]);
};

export const sponsorshipReplayAllowed = (config, action) => Boolean(config.wallet.bundlerUrl) && (
  action === "marketplace-transfer"
    ? config.wallet.ownerExitExecutableConfigured === true
    : config.secondary.rehearsalReady === true || config.secondary.liveReady === true
);

const expectedCallJson = (call) => ({
  to: getAddress(call.to), value: String(call.value || 0n), data: call.data,
  ...(call.order ? { order: call.order } : {})
});

export const resolveSecondaryActionContext = async ({ service, config, userId, account, body }) => {
  const action = SECONDARY_SPONSOR_ACTIONS.includes(body?.action) ? body.action : null;
  const key = requestKey(body?.request_key);
  if (!action || !key) throw new Error("INVALID_SPONSORSHIP_REQUEST");
  const protocolAddress = getAddress(config.secondary.protocolAddress);

  if (["marketplace-transfer", "resale-approve-token", "resale-revoke-token"].includes(action)) {
    const workId = uuid(body.work_id);
    if (!workId) throw new Error("INVALID_SPONSORSHIP_REQUEST");
    const { data: work, error: workError } = await service.from("works")
      .select("id,nft_collection_id,nft_token_id,format,contract_status").eq("id", workId).maybeSingle();
    if (workError || !work || work.format !== "digital" || work.contract_status !== "minted"
      || !work.nft_collection_id || work.nft_token_id === null) throw new Error("SECONDARY_TOKEN_NOT_ELIGIBLE");
    const [{ data: collection, error: collectionError }, { data: owner, error: ownerError }, unresolved] = await Promise.all([
      service.from("nft_collections").select("id,standard,chain_id,contract_address,deployed_code_hash,inventory_safe,state")
        .eq("id", work.nft_collection_id).maybeSingle(),
      service.from("token_ownership_projection")
        .select("work_id,owner_address,owner_smart_account_id,ownership_state,finality,observed_block_number,observed_block_hash")
        .eq("chain_id", config.wallet.chainId).eq("token_id", String(work.nft_token_id)).eq("work_id", work.id).maybeSingle(),
      service.from("resale_orders").select("id,state,order_hash,order_components,end_time_epoch").eq("work_id", work.id)
        .eq("seller_smart_account_id", account.id)
        .in("state", ["open", "cancel-requested", "fill-submitted", "included", "reorged", "exception"]).limit(1)
    ]);
    if (collectionError || ownerError || !collection || collection.standard !== "ERC721"
      || Number(collection.chain_id) !== config.wallet.chainId || !["rehearsal", "active"].includes(collection.state)
      || !owner || owner.owner_address !== account.account_address || owner.owner_smart_account_id !== account.id
      || owner.ownership_state !== "owned" || owner.finality !== "finalized") throw new Error("SECONDARY_TOKEN_NOT_OWNED");
    if (unresolved.error) throw unresolved.error;
    let call;
    let recipientAddress;
    if (action === "marketplace-transfer") {
      try {
        recipientAddress = getAddress(body.recipient_address);
      } catch {
        throw new Error("INVALID_SPONSORSHIP_REQUEST");
      }
      const blockedRecipients = [
        account.account_address,
        collection.contract_address,
        collection.inventory_safe,
        config.wallet.entryPointAddress,
        config.wallet.safeFactoryAddress,
        config.wallet.safeSingletonAddress,
        config.wallet.safeFallbackHandlerAddress,
        config.wallet.safeWebAuthnSharedSignerAddress,
        config.wallet.safe4337ModuleAddress,
        config.wallet.safePasskeyVerifierAddress,
        config.secondary.protocolAddress,
        config.secondary.usdcAddress,
        ZERO_ADDRESS
      ].filter(Boolean).map((address) => getAddress(address));
      if (blockedRecipients.includes(recipientAddress)) throw new Error("SECONDARY_RECIPIENT_REJECTED");
      call = tokenTransferCall({
        collectionAddress: collection.contract_address,
        fromAddress: account.account_address,
        recipientAddress,
        tokenId: work.nft_token_id
      });
    } else {
      call = tokenApprovalCall({
        collectionAddress: collection.contract_address,
        protocolAddress,
        tokenId: work.nft_token_id,
        revoke: action === "resale-revoke-token"
      });
    }
    return {
      action, requestKey: key, ledgerRequestKey: newSponsorshipLedgerKey(), call,
      expected: {
        ...expectedCallJson(call),
        collection_code_hash: collection.deployed_code_hash,
        token_id: String(work.nft_token_id),
        ...(recipientAddress ? { from_address: getAddress(account.account_address), recipient_address: recipientAddress } : {}),
        pending_orders: (unresolved.data || []).map((entry) => ({
          order_hash: entry.order_hash,
          order: normalizeResaleOrderComponents(entry.order_components),
          end_time_epoch: String(entry.end_time_epoch)
        }))
      },
      reference: {
        work_id: work.id,
        collection_id: collection.id,
        collection_address: getAddress(collection.contract_address).toLowerCase(),
        token_id: String(work.nft_token_id),
        ...(recipientAddress ? {
          from_address: getAddress(account.account_address).toLowerCase(),
          recipient_address: recipientAddress.toLowerCase()
        } : {})
      }
    };
  }

  const listingId = uuid(body.listing_id);
  if (!listingId) throw new Error("INVALID_SPONSORSHIP_REQUEST");
  const { data: listing, error } = await service.from("resale_orders")
    .select("id,work_id,collection_id,seller_user_id,seller_smart_account_id,chain_id,collection_address,token_id,seller_address,gross_amount,currency_address,end_time_epoch,order_hash,signature,order_components,state")
    .eq("id", listingId).maybeSingle();
  if (error || !listing
    || Number(listing.chain_id) !== config.wallet.chainId
    || getAddress(listing.currency_address) !== getAddress(config.secondary.usdcAddress)) {
    throw new Error("SECONDARY_LISTING_NOT_OPEN");
  }
  const order = normalizeResaleOrderComponents(listing.order_components);
  if (resaleOrderHash(order) !== listing.order_hash) {
    throw new Error("SECONDARY_LISTING_NOT_OPEN");
  }
  const sellerAction = action === "resale-cancel-order";
  if (sellerAction) {
    if (listing.seller_user_id !== userId || listing.seller_smart_account_id !== account.id
      || !["open", "cancel-requested", "fill-submitted"].includes(listing.state)) throw new Error("SECONDARY_SELLER_MISMATCH");
  } else if (listing.seller_user_id === userId || listing.seller_smart_account_id === account.id
    || getAddress(listing.seller_address) === getAddress(account.account_address)) {
    throw new Error("SECONDARY_SELF_PURCHASE_REJECTED");
  } else if (action !== "resale-revoke-usdc" && (listing.state !== "open"
    || BigInt(listing.end_time_epoch) <= BigInt(Math.floor(Date.now() / 1_000)))) {
    throw new Error("SECONDARY_LISTING_NOT_OPEN");
  }

  let call;
  if (action === "resale-approve-usdc" || action === "resale-revoke-usdc") {
    call = usdcApprovalCall({
      usdcAddress: config.secondary.usdcAddress,
      protocolAddress,
      amount: listing.gross_amount,
      revoke: action === "resale-revoke-usdc"
    });
  } else if (action === "resale-fulfill") {
    call = fulfillmentCall({ protocolAddress, order, signature: byteaHex(listing.signature) });
    call.order = order;
  } else if (sellerAction) {
    call = cancellationCall({ protocolAddress, order });
    call.order = order;
  } else {
    throw new Error("INVALID_SPONSORSHIP_REQUEST");
  }
  return {
    action, requestKey: key, ledgerRequestKey: newSponsorshipLedgerKey(), call,
    expected: {
      ...expectedCallJson(call),
      order_hash: listing.order_hash,
      gross_amount: String(listing.gross_amount),
      currency_address: listing.currency_address,
      collection_address: listing.collection_address,
      token_id: String(listing.token_id),
      seller_address: listing.seller_address
    },
    reference: { listing_id: listing.id, work_id: listing.work_id, collection_id: listing.collection_id }
  };
};

const assertRuntimeHash = async ({ client, address, expectedHash, blockNumber, code }) => {
  const runtime = await client.getBytecode({ address, blockNumber });
  if (!runtime || !expectedHash || keccak256(runtime).toLowerCase() !== expectedHash.toLowerCase()) throw new Error(code);
};

export const simulateSecondaryAction = async ({ config, decoded, expected, client = publicClientFor(config) }) => {
  const finalized = await client.getBlock({ blockTag: "finalized" });
  await Promise.all([
    assertRuntimeHash({ client, address: decoded.account, expectedHash: config.wallet.safeProxyCodeHash, blockNumber: finalized.number, code: "SAFE_CODE_HASH_MISMATCH" }),
    assertRuntimeHash({ client, address: config.wallet.entryPointAddress, expectedHash: config.wallet.entryPointCodeHash, blockNumber: finalized.number, code: "ENTRY_POINT_CODE_HASH_MISMATCH" }),
    assertRuntimeHash({
      client,
      address: decoded.to,
      expectedHash: decoded.to === getAddress(config.secondary.protocolAddress)
        ? config.secondary.protocolCodeHash
        : decoded.to === getAddress(config.secondary.usdcAddress) ? config.secondary.usdcCodeHash : expected.collection_code_hash,
      blockNumber: finalized.number,
      code: "SECONDARY_TARGET_CODE_HASH_MISMATCH"
    })
  ]);

  if (["marketplace-transfer", "resale-approve-token", "resale-revoke-token"].includes(decoded.action)) {
    const [owner, approved, operatorApproved] = await Promise.all([
      client.readContract({ address: decoded.collectionAddress, abi: ERC721_STATE_ABI, functionName: "ownerOf", args: [decoded.tokenId], blockNumber: finalized.number }),
      client.readContract({ address: decoded.collectionAddress, abi: ERC721_STATE_ABI, functionName: "getApproved", args: [decoded.tokenId], blockNumber: finalized.number }),
      decoded.action === "marketplace-transfer"
        ? client.readContract({
          address: decoded.collectionAddress, abi: ERC721_STATE_ABI, functionName: "isApprovedForAll",
          args: [decoded.account, config.secondary.protocolAddress], blockNumber: finalized.number
        })
        : Promise.resolve(false)
    ]);
    if (getAddress(owner) !== decoded.account) throw new Error("SECONDARY_TOKEN_NOT_OWNED");
    for (const pending of expected.pending_orders || []) {
      if (BigInt(pending.end_time_epoch) <= BigInt(finalized.timestamp)) continue;
      const [status, counter] = await Promise.all([
        client.readContract({
          address: config.secondary.protocolAddress, abi: SEAPORT_STATE_ABI,
          functionName: "getOrderStatus", args: [pending.order_hash], blockNumber: finalized.number
        }),
        client.readContract({
          address: config.secondary.protocolAddress, abi: SEAPORT_STATE_ABI,
          functionName: "getCounter", args: [pending.order.offerer], blockNumber: finalized.number
        })
      ]);
      if (!status[1] && BigInt(status[2]) === 0n && BigInt(counter) === BigInt(pending.order.counter)) {
        throw new Error("SECONDARY_ORDER_MUST_FINALIZE_CANCELLATION");
      }
    }
    if (decoded.action === "marketplace-transfer" && getAddress(approved) !== getAddress(ZERO_ADDRESS)) {
      throw new Error("SECONDARY_REVOKE_REQUIRED");
    }
    if (decoded.action === "marketplace-transfer" && operatorApproved) throw new Error("SECONDARY_REVOKE_REQUIRED");
    if (decoded.action === "resale-approve-token" && getAddress(approved) !== getAddress(ZERO_ADDRESS)) {
      throw new Error(getAddress(approved) === getAddress(config.secondary.protocolAddress) ? "SECONDARY_ACTION_ALREADY_SATISFIED" : "SECONDARY_REVOKE_REQUIRED");
    }
    if (decoded.action === "resale-revoke-token" && getAddress(approved) !== getAddress(config.secondary.protocolAddress)) {
      throw new Error("SECONDARY_ACTION_NOT_APPLICABLE");
    }
  } else if (["resale-approve-usdc", "resale-revoke-usdc"].includes(decoded.action)) {
    const [balance, allowance] = await Promise.all([
      client.readContract({ address: config.secondary.usdcAddress, abi: ERC20_STATE_ABI, functionName: "balanceOf", args: [decoded.account], blockNumber: finalized.number }),
      client.readContract({ address: config.secondary.usdcAddress, abi: ERC20_STATE_ABI, functionName: "allowance", args: [decoded.account, config.secondary.protocolAddress], blockNumber: finalized.number })
    ]);
    if (decoded.action === "resale-approve-usdc" && (balance < decoded.amount || allowance !== 0n)) {
      throw new Error(allowance !== 0n ? "SECONDARY_REVOKE_REQUIRED" : "SECONDARY_USDC_BALANCE_LOW");
    }
    if (decoded.action === "resale-revoke-usdc" && allowance === 0n) throw new Error("SECONDARY_ACTION_NOT_APPLICABLE");
  } else {
    const status = await client.readContract({
      address: config.secondary.protocolAddress,
      abi: SEAPORT_STATE_ABI,
      functionName: "getOrderStatus",
      args: [decoded.orderHash],
      blockNumber: finalized.number
    });
    if (status[1] || BigInt(status[2]) !== 0n) throw new Error("SECONDARY_ORDER_NOT_OPEN");
    if (BigInt(decoded.order.counter) !== await client.readContract({
      address: config.secondary.protocolAddress,
      abi: SEAPORT_STATE_ABI,
      functionName: "getCounter",
      args: [decoded.order.offerer],
      blockNumber: finalized.number
    })) throw new Error("SECONDARY_ORDER_COUNTER_CHANGED");
    if (decoded.action === "resale-fulfill") {
      const gross = decoded.order.consideration.reduce((sum, item) => sum + BigInt(item.startAmount), 0n);
      const [owner, approved, balance, allowance] = await Promise.all([
        client.readContract({ address: decoded.order.offer[0].token, abi: ERC721_STATE_ABI, functionName: "ownerOf", args: [BigInt(decoded.order.offer[0].identifierOrCriteria)], blockNumber: finalized.number }),
        client.readContract({ address: decoded.order.offer[0].token, abi: ERC721_STATE_ABI, functionName: "getApproved", args: [BigInt(decoded.order.offer[0].identifierOrCriteria)], blockNumber: finalized.number }),
        client.readContract({ address: config.secondary.usdcAddress, abi: ERC20_STATE_ABI, functionName: "balanceOf", args: [decoded.account], blockNumber: finalized.number }),
        client.readContract({ address: config.secondary.usdcAddress, abi: ERC20_STATE_ABI, functionName: "allowance", args: [decoded.account, config.secondary.protocolAddress], blockNumber: finalized.number })
      ]);
      if (getAddress(owner) !== getAddress(decoded.order.offerer) || getAddress(approved) !== getAddress(config.secondary.protocolAddress)
        || balance < gross || allowance !== gross || BigInt(finalized.timestamp) < BigInt(decoded.order.startTime)
        || BigInt(finalized.timestamp) >= BigInt(decoded.order.endTime)) throw new Error("SECONDARY_FULFILLMENT_PREFLIGHT_FAILED");
    }
  }
  const execution = await client.call({ account: decoded.account, to: decoded.to, data: decoded.data, value: 0n, blockNumber: finalized.number });
  if (["resale-approve-usdc", "resale-revoke-usdc"].includes(decoded.action)) {
    const approved = decodeFunctionResult({ abi: ERC20_APPROVE_ABI, functionName: "approve", data: execution.data || "0x" });
    if (!approved) throw new Error("SECONDARY_SIMULATION_RETURNED_FALSE");
  } else if (decoded.action === "resale-fulfill") {
    const fulfilled = decodeFunctionResult({ abi: SEAPORT_FULFILL_ABI, functionName: "fulfillOrder", data: execution.data || "0x" });
    if (!fulfilled) throw new Error("SECONDARY_SIMULATION_RETURNED_FALSE");
  } else if (decoded.action === "resale-cancel-order") {
    const cancelled = decodeFunctionResult({ abi: SEAPORT_CANCEL_ABI, functionName: "cancel", data: execution.data || "0x" });
    if (!cancelled) throw new Error("SECONDARY_SIMULATION_RETURNED_FALSE");
  }
  return { blockNumber: finalized.number.toString(), blockHash: finalized.hash };
};

const safeAccountFor = async ({ config, account, attestation, client }) => {
  const owner = toWebAuthnAccount({ credential: { id: "", publicKey: attestation.passkeyPublicKey } });
  return SafeSmartAccount.toSafeSmartAccount({
    client,
    owners: [owner],
    threshold: BigInt(attestation.threshold),
    address: getAddress(account.account_address),
    version: config.wallet.safeVersion,
    entryPoint: { address: getAddress(config.wallet.entryPointAddress), version: config.wallet.entryPointVersion },
    safeProxyFactoryAddress: getAddress(config.wallet.safeFactoryAddress),
    safeSingletonAddress: getAddress(config.wallet.safeSingletonAddress),
    safe4337ModuleAddress: getAddress(config.wallet.safe4337ModuleAddress),
    safeWebAuthnSharedSignerAddress: getAddress(config.wallet.safeWebAuthnSharedSignerAddress),
    safeP256VerifierAddress: getAddress(config.wallet.safePasskeyVerifierAddress)
  });
};

export const reserveSponsorshipDecision = async ({ service, config, userId, accountId, context, operation, quote, evidence, provider, validAfter, validUntil }) => {
  const policyInput = {
    schema: "secondary-userop-v1",
    chain_id: config.wallet.chainId,
    entry_point_address: config.wallet.entryPointAddress,
    operation_commitment: userOperationCommitment(operation),
    user_operation: userOperationToJson(operation),
    valid_after: validAfter,
    valid_until: validUntil,
    expected_call: context.expected,
    reference: context.reference,
    client_request_key: context.requestKey,
    simulation: evidence
  };
  const { data, error } = await service.rpc("reserve_secondary_sponsorship", {
    request_key_input: context.ledgerRequestKey,
    client_request_key_input: context.requestKey,
    user_id_input: userId,
    smart_account_id_input: accountId,
    action_input: context.action,
    policy_version_input: config.wallet.sponsorPolicyVersion,
    target_input: getAddress(context.call.to).toLowerCase(),
    selector_input: context.call.data.slice(0, 10).toLowerCase(),
    quoted_cost_wei_input: quote.toString(),
    policy_input_input: policyInput,
    per_operation_limit_input: config.wallet.sponsorBudgets.perOperationWei,
    per_user_daily_limit_input: config.wallet.sponsorBudgets.perUserDailyWei,
    global_daily_limit_input: config.wallet.sponsorBudgets.globalDailyWei,
    provider_input: provider
  });
  if (error || !data) throw new Error(error?.message?.includes("sponsorship_") ? error.message : "SPONSORSHIP_RESERVATION_FAILED");
  const decision = Array.isArray(data) ? data[0] : data;
  if (decision.decision !== "approved") throw new Error(decision.rejection_code || "SPONSORSHIP_BUDGET_REJECTED");
  if (decision.policy_input?.schema !== "secondary-userop-v1"
    || decision.policy_input?.client_request_key !== context.requestKey) {
    throw new Error("SPONSORSHIP_DECISION_CORRUPT");
  }
  return { decision, policyInput: decision.policy_input };
};

export const prepareSponsoredSecondaryOperation = async ({ service, config, userId, account, attestation, body, provider }) => {
  const context = await resolveSecondaryActionContext({ service, config, userId, account, body });
  const callData = encodeSafeSecondaryCall(context.call);
  const decoded = decodeSecondaryActionCall({
    action: context.action,
    callData,
    config,
    accountAddress: account.account_address,
    expectedCall: { ...context.call, order: context.call.order }
  });
  const client = publicClientFor(config);
  const evidence = await simulateSecondaryAction({ config, decoded, expected: context.expected, client });
  const safeAccount = await safeAccountFor({ config, account, attestation, client });
  const validAfter = Math.max(0, Math.floor(Date.now() / 1_000) - 30);
  const validUntil = validAfter + 330;
  const adapter = provider || createStandardUserOperationProvider({ config });
  const prepared = await prepareProviderSponsoredOperation({
    config,
    provider: adapter,
    safeAccount,
    callData,
    fees: await client.estimateFeesPerGas(),
    paymasterContext: {
      policyVersion: config.wallet.sponsorPolicyVersion,
      action: context.action,
      requestKeyHash: keccak256(stringToHex(context.requestKey))
    }
  });
  const reserved = await reserveSponsorshipDecision({
    service, config, userId, accountId: account.id, context,
    operation: prepared.operation, quote: prepared.quotedCostWei, evidence,
    provider: prepared.provider, validAfter, validUntil
  });
  const reservedOperation = normalizeUserOperation(reserved.policyInput.user_operation);
  if (userOperationCommitment(reservedOperation) !== reserved.policyInput.operation_commitment) {
    throw new Error("SPONSORSHIP_DECISION_CORRUPT");
  }
  return {
    context: { ...context, expected: reserved.policyInput.expected_call },
    operation: reservedOperation,
    operationCommitment: reserved.policyInput.operation_commitment,
    quotedCostWei: String(reserved.decision.quoted_cost_wei),
    validAfter: Number(reserved.policyInput.valid_after),
    validUntil: Number(reserved.policyInput.valid_until)
  };
};

export const assertPreparedSubmission = ({ decision, input, config, now = Math.floor(Date.now() / 1_000) }) => {
  if (!decision || !["approved", "submitted", "included"].includes(decision.decision)
    || decision.policy_version !== config.wallet.sponsorPolicyVersion
    || decision.policy_input?.schema !== "secondary-userop-v1") throw new Error("SPONSORSHIP_DECISION_NOT_SUBMITTABLE");
  const validAfter = Number(decision.policy_input.valid_after);
  const validUntil = Number(decision.policy_input.valid_until);
  if (decision.decision === "approved" && (now < validAfter || now >= validUntil)) {
    throw new Error("SPONSORSHIP_PREPARATION_EXPIRED");
  }
  const operation = normalizeUserOperation(input, { signature: true });
  if (userOperationCommitment(operation) !== decision.policy_input.operation_commitment) throw new Error("USER_OPERATION_CHANGED");
  assertUserOperationSignatureWindow({ signature: operation.signature, validAfter, validUntil });
  const decoded = decodeSecondaryActionCall({
    action: decision.action,
    callData: operation.callData,
    config,
    accountAddress: operation.sender,
    expectedCall: decision.policy_input.expected_call
  });
  return { operation, decoded };
};

export const submitSponsoredSecondaryOperation = async ({ service, config, userId, decision, input, provider }) => {
  const { operation, decoded } = assertPreparedSubmission({ decision, input, config });
  const expectedHash = getUserOperationHash({
    chainId: config.wallet.chainId,
    entryPointAddress: config.wallet.entryPointAddress,
    entryPointVersion: "0.7",
    userOperation: operation
  }).toLowerCase();
  if (decision.userop_hash && expectedHash !== decision.userop_hash.toLowerCase()) throw new Error("USER_OPERATION_HASH_CHANGED");
  if (decision.decision === "included") {
    return { userOperationHash: expectedHash, alreadySubmitted: true, providerAccepted: true, finalized: true };
  }
  const alreadySubmitted = decision.decision === "submitted";
  if (!alreadySubmitted) {
    await simulateSecondaryAction({ config, decoded, expected: decision.policy_input.expected_call });
  }
  if (!alreadySubmitted || !decision.policy_input.signed_user_operation) {
    decision = await recordSubmittedSecondaryAction({
      service, userId, decision, decoded, operation, userOperationHash: expectedHash
    });
  }
  const adapter = provider || createStandardUserOperationProvider({ config });
  try {
    const providerHash = await adapter.sendUserOperation(operation);
    if (!isHex(providerHash, { size: 32 }) || providerHash.toLowerCase() !== expectedHash) {
      throw new Error("USER_OPERATION_HASH_MISMATCH");
    }
    return { userOperationHash: expectedHash, alreadySubmitted, providerAccepted: true, finalized: false };
  } catch (error) {
    if (!["USER_OPERATION_PROVIDER_UNAVAILABLE", "USER_OPERATION_PROVIDER_REJECTED"].includes(error.message)) throw error;
    return { userOperationHash: expectedHash, alreadySubmitted, providerAccepted: false, finalized: false };
  }
};

const recordSubmittedSecondaryAction = async ({ service, userId, decision, decoded, operation, userOperationHash }) => {
  const { data, error } = await service.rpc("record_secondary_userop_submission", {
    decision_id_input: decision.id,
    user_id_input: userId,
    userop_hash_input: userOperationHash.toLowerCase(),
    call_data_hash_input: decoded.callDataHash,
    signed_user_operation_input: userOperationToJson(operation, { signature: true })
  });
  if (error || !data) throw error || new Error("SPONSORSHIP_SUBMISSION_RECORD_FAILED");
  const recorded = Array.isArray(data) ? data[0] : data;
  if (recorded.userop_hash !== userOperationHash.toLowerCase() || recorded.decision !== "submitted") {
    throw new Error("SPONSORSHIP_SUBMISSION_CONFLICT");
  }
  return recorded;
};

const touchSubmittedDecision = async ({ service, decision }) => {
  const update = await service.from("sponsorship_decisions").update({
    policy_input: {
      ...decision.policy_input,
      last_reconciled_at: new Date().toISOString()
    }
  }).eq("id", decision.id).eq("decision", "submitted");
  if (update.error) throw update.error;
};

const replaySubmittedOperation = async ({ config, decision, adapter }) => {
  const stored = decision.policy_input?.signed_user_operation;
  if (!stored) throw new Error("SPONSORSHIP_SIGNED_OPERATION_MISSING");
  const operation = normalizeUserOperation(stored, { signature: true });
  if (userOperationCommitment(operation) !== decision.policy_input.operation_commitment) {
    throw new Error("SPONSORSHIP_DECISION_CORRUPT");
  }
  const expectedHash = getUserOperationHash({
    chainId: config.wallet.chainId,
    entryPointAddress: config.wallet.entryPointAddress,
    entryPointVersion: "0.7",
    userOperation: operation
  }).toLowerCase();
  if (expectedHash !== decision.userop_hash.toLowerCase()) throw new Error("USER_OPERATION_HASH_CHANGED");
  try {
    const providerHash = await adapter.sendUserOperation(operation);
    if (!isHex(providerHash, { size: 32 }) || providerHash.toLowerCase() !== expectedHash) {
      throw new Error("USER_OPERATION_HASH_MISMATCH");
    }
  } catch (error) {
    if (!["USER_OPERATION_PROVIDER_UNAVAILABLE", "USER_OPERATION_PROVIDER_REJECTED"].includes(error.message)) throw error;
  }
};

const findDecodedLog = ({ logs, address, abi, eventName, predicate = () => true }) => {
  for (const log of logs || []) {
    if (!log?.address || getAddress(log.address) !== getAddress(address)) continue;
    try {
      const decoded = decodeEventLog({ abi, eventName, data: log.data, topics: log.topics, strict: true });
      if (predicate(decoded.args)) return { log, args: decoded.args };
    } catch {}
  }
  return null;
};

export const verifySponsoredUserOperationReceipt = async ({ config, decision, receipt, client = publicClientFor(config) }) => {
  if (!receipt) return { state: "pending" };
  const expectedHash = decision.userop_hash;
  const operation = normalizeUserOperation(decision.policy_input.user_operation);
  const transactionHash = receipt.receipt?.transactionHash || receipt.transactionHash;
  if (!isHex(receipt.userOpHash, { size: 32 }) || receipt.userOpHash.toLowerCase() !== expectedHash
    || getAddress(receipt.sender) !== getAddress(operation.sender) || BigInt(receipt.nonce) !== operation.nonce
    || !isHex(transactionHash, { size: 32 })) throw new Error("USER_OPERATION_RECEIPT_MISMATCH");
  const chainReceipt = await client.getTransactionReceipt({ hash: transactionHash });
  const receiptBlockHash = receipt.receipt?.blockHash || receipt.blockHash;
  const receiptBlockNumber = BigInt(receipt.receipt?.blockNumber || receipt.blockNumber);
  if (chainReceipt.blockHash.toLowerCase() !== receiptBlockHash.toLowerCase()
    || chainReceipt.blockNumber !== receiptBlockNumber) return { state: "reorg-pending" };
  const entryPointLog = findDecodedLog({
    logs: chainReceipt.logs,
    address: config.wallet.entryPointAddress,
    abi: ENTRY_POINT_EVENT_ABI,
    eventName: "UserOperationEvent",
    predicate: (args) => args.userOpHash.toLowerCase() === expectedHash
      && getAddress(args.sender) === getAddress(operation.sender)
      && getAddress(args.paymaster) === getAddress(operation.paymaster)
      && BigInt(args.nonce) === operation.nonce
  });
  if (!entryPointLog) throw new Error("USER_OPERATION_EVENT_MISSING");
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (finalized.number < chainReceipt.blockNumber) {
    return { state: "included-unfinalized", transactionHash, blockNumber: chainReceipt.blockNumber.toString(), blockHash: chainReceipt.blockHash };
  }
  const canonicalBlock = await client.getBlock({ blockNumber: chainReceipt.blockNumber });
  if (canonicalBlock.hash.toLowerCase() !== chainReceipt.blockHash.toLowerCase()) return { state: "reorg-pending" };
  const success = Boolean(entryPointLog.args.success) && chainReceipt.status === "success";
  return {
    state: success ? "finalized" : "failed",
    success,
    transactionHash: transactionHash.toLowerCase(),
    blockNumber: chainReceipt.blockNumber.toString(),
    blockHash: chainReceipt.blockHash.toLowerCase(),
    finalizedBlockNumber: finalized.number.toString(),
    finalizedBlockHash: finalized.hash,
    actualCostWei: BigInt(entryPointLog.args.actualGasCost).toString(),
    logs: chainReceipt.logs
  };
};

export const findCanonicalUserOperationReceipt = async ({ config, decision, client = publicClientFor(config) }) => {
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const preparedAt = BigInt(decision.policy_input?.simulation?.blockNumber || 0);
  if (preparedAt > finalized.number) throw new Error("SPONSORSHIP_PREPARED_BLOCK_INVALID");
  const logs = await client.getLogs({
    address: config.wallet.entryPointAddress,
    event: ENTRY_POINT_EVENT_ABI[0],
    args: { userOpHash: decision.userop_hash },
    fromBlock: preparedAt,
    toBlock: finalized.number,
    strict: true
  });
  if (logs.length > 1) throw new Error("USER_OPERATION_EVENT_CONFLICT");
  if (!logs.length) return { receipt: null, finalized };
  const [log] = logs;
  return {
    finalized,
    receipt: {
      userOpHash: decision.userop_hash,
      sender: log.args.sender,
      nonce: log.args.nonce,
      receipt: {
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash
      }
    }
  };
};

export const verifyActionReceiptLog = ({ config, decision, result }) => {
  const expected = decision.policy_input.expected_call;
  const account = decision.policy_input.user_operation.sender;
  if (decision.action === "marketplace-transfer") {
    const match = findDecodedLog({
      logs: result.logs, address: expected.to, abi: TRANSFER_EVENT_ABI, eventName: "Transfer",
      predicate: (args) => getAddress(args.from) === getAddress(account)
        && getAddress(args.to) === getAddress(expected.recipient_address)
        && BigInt(args.tokenId) === BigInt(expected.token_id)
    });
    if (!match) throw new Error("SECONDARY_TRANSFER_EVENT_MISSING");
    return { eventName: "Transfer", log: match.log, args: match.args };
  }
  if (["resale-approve-token", "resale-revoke-token"].includes(decision.action)) {
    const match = findDecodedLog({
      logs: result.logs, address: expected.to, abi: APPROVAL_EVENT_ABI, eventName: "Approval",
      predicate: (args) => getAddress(args.owner) === getAddress(account)
        && getAddress(args.approved) === getAddress(decision.action === "resale-approve-token" ? config.secondary.protocolAddress : ZERO_ADDRESS)
        && BigInt(args.tokenId) === BigInt(expected.token_id || decision.policy_input.reference.token_id)
    });
    if (!match) throw new Error("SECONDARY_APPROVAL_EVENT_MISSING");
    return null;
  }
  if (["resale-approve-usdc", "resale-revoke-usdc"].includes(decision.action)) {
    const match = findDecodedLog({
      logs: result.logs, address: config.secondary.usdcAddress, abi: ERC20_APPROVAL_EVENT_ABI, eventName: "Approval",
      predicate: (args) => getAddress(args.owner) === getAddress(account)
        && getAddress(args.spender) === getAddress(config.secondary.protocolAddress)
        && BigInt(args.value) === BigInt(decision.action === "resale-approve-usdc" ? expected.gross_amount : 0)
    });
    if (!match) throw new Error("SECONDARY_APPROVAL_EVENT_MISSING");
    return null;
  }
  const eventName = decision.action === "resale-fulfill" ? "OrderFulfilled" : "OrderCancelled";
  const match = findDecodedLog({
    logs: result.logs, address: config.secondary.protocolAddress, abi: ORDER_EVENT_ABI, eventName,
    predicate: (args) => args.orderHash.toLowerCase() === expected.order_hash
      && getAddress(args.offerer) === getAddress(expected.seller_address)
      && (eventName !== "OrderFulfilled" || getAddress(args.recipient) === getAddress(account))
  });
  if (!match) throw new Error("SECONDARY_ORDER_EVENT_MISSING");
  return { eventName, log: match.log, args: match.args };
};

export const canonicalEventRecordMatches = (existing, expected) => {
  const normalized = (value) => value === null || value === undefined ? "" : String(value).toLowerCase();
  return [
    "resale_order_id", "chain_id", "payload_hash", "event_name", "emitter_address", "topic0", "transaction_hash",
    "transaction_index", "log_index", "block_number", "block_hash", "removed",
    "order_hash", "token_id", "from_address", "to_address", "counter"
  ].every((field) => normalized(existing?.[field]) === normalized(expected?.[field]));
};

export const reconcileSponsoredSecondaryOperation = async ({
  service,
  config,
  decision,
  provider,
  client = publicClientFor(config),
  allowReplay = false
}) => {
  if (!decision.userop_hash) throw new Error("SPONSORSHIP_NOT_SUBMITTED");
  const adapter = provider || createStandardUserOperationProvider({ config });
  let receipt;
  try {
    receipt = await adapter.getUserOperationReceipt(decision.userop_hash);
  } catch (error) {
    if (!["USER_OPERATION_PROVIDER_UNAVAILABLE", "USER_OPERATION_PROVIDER_REJECTED"].includes(error.message)) throw error;
    receipt = null;
  }
  let canonical;
  if (!receipt) {
    canonical = await findCanonicalUserOperationReceipt({ config, decision, client });
    receipt = canonical.receipt;
  }
  let result = await verifySponsoredUserOperationReceipt({ config, decision, receipt, client });
  if (!["finalized", "failed"].includes(result.state)) {
    const validUntil = BigInt(decision.policy_input.valid_until);
    if (result.state === "pending" && canonical
      && canonical.finalized.timestamp >= validUntil + SUBMISSION_EXPIRY_GRACE_SECONDS) {
      result = {
        state: "failed",
        success: false,
        transactionHash: null,
        blockNumber: null,
        blockHash: null,
        finalizedBlockNumber: canonical.finalized.number.toString(),
        finalizedBlockHash: canonical.finalized.hash.toLowerCase(),
        actualCostWei: "0",
        failureCode: "userop_expired_unincluded"
      };
    } else {
      if (result.state === "pending" && allowReplay) await replaySubmittedOperation({ config, decision, adapter });
      await touchSubmittedDecision({ service, decision });
      return result;
    }
  }
  if (result.state === "failed") {
    const failureCode = result.failureCode || "userop_execution_failed";
    if (decision.action === "resale-fulfill") {
      const fillUpdate = await service.from("resale_fills").update({ state: "failed", failure_code: failureCode })
        .eq("request_key", decision.request_key).eq("state", "submitted");
      if (fillUpdate.error) throw fillUpdate.error;
      const orderUpdate = await service.from("resale_orders").update({ state: "open" })
        .eq("id", decision.policy_input.reference.listing_id).eq("state", "fill-submitted");
      if (orderUpdate.error) throw orderUpdate.error;
    } else if (decision.action === "resale-cancel-order") {
      const orderUpdate = await service.from("resale_orders").update({ state: "open" })
        .eq("id", decision.policy_input.reference.listing_id).eq("state", "cancel-requested");
      if (orderUpdate.error) throw orderUpdate.error;
    }
    const decisionUpdate = await service.from("sponsorship_decisions").update({
      decision: "failed", transaction_hash: result.transactionHash,
      actual_cost_wei: result.actualCostWei, rejection_code: failureCode
    }).eq("id", decision.id).eq("decision", "submitted");
    if (decisionUpdate.error) throw decisionUpdate.error;
    return result;
  }
  const orderEvent = verifyActionReceiptLog({ config, decision, result });
  if (orderEvent) {
    const canonicalEvent = normalizeFinalizedResaleLog(orderEvent.eventName, {
      ...orderEvent.log,
      args: orderEvent.args
    });
    const eventRecord = {
      ...canonicalEvent,
      resale_order_id: decision.policy_input.reference.listing_id || null,
      chain_id: config.wallet.chainId,
      provider: "configured-rpc"
    };
    let inserted = await service.from("chain_event_inbox").insert(eventRecord).select("id").maybeSingle();
    if (inserted.error?.code === "23505") {
      inserted = await service.from("chain_event_inbox")
      .select("id,resale_order_id,chain_id,payload_hash,event_name,emitter_address,topic0,transaction_hash,transaction_index,log_index,block_number,block_hash,removed,order_hash,token_id,from_address,to_address,counter")
      .eq("chain_id", config.wallet.chainId).eq("block_hash", result.blockHash)
      .eq("transaction_hash", result.transactionHash).eq("log_index", Number(orderEvent.log.logIndex)).eq("removed", false).single();
      if (!inserted.error && inserted.data && !canonicalEventRecordMatches(inserted.data, eventRecord)) {
        throw new Error("SECONDARY_EVENT_CONFLICT");
      }
    }
    if (inserted.error || !inserted.data) throw inserted.error || new Error("SECONDARY_EVENT_RECORD_FAILED");
    if (decision.action === "resale-fulfill") {
      const inclusion = {
        transaction_hash: result.transactionHash,
        block_number: result.blockNumber,
        block_hash: result.blockHash,
        log_index: Number(orderEvent.log.logIndex),
        source_event_id: inserted.data.id,
        state: "included"
      };
      const included = await service.from("resale_fills").update(inclusion)
        .eq("request_key", decision.request_key).eq("state", "submitted");
      if (included.error) throw included.error;
      const finalized = await service.from("resale_fills").update({
        state: "finalized", finalized_at: new Date().toISOString(),
        finalized_block_number: result.finalizedBlockNumber, finalized_block_hash: result.finalizedBlockHash
      }).eq("request_key", decision.request_key).eq("state", "included");
      if (finalized.error) throw finalized.error;
      const orderIncluded = await service.from("resale_orders").update({ state: "included" })
        .eq("id", decision.policy_input.reference.listing_id).eq("state", "fill-submitted");
      if (orderIncluded.error) throw orderIncluded.error;
      const orderFinalized = await service.from("resale_orders").update({ state: "finalized", closed_at: new Date().toISOString() })
        .eq("id", decision.policy_input.reference.listing_id).eq("state", "included");
      if (orderFinalized.error) throw orderFinalized.error;
    } else if (decision.action === "resale-cancel-order") {
      const orderCancelled = await service.from("resale_orders").update({ state: "cancelled", closed_at: new Date().toISOString() })
        .eq("id", decision.policy_input.reference.listing_id).in("state", ["open", "cancel-requested", "fill-submitted"]);
      if (orderCancelled.error) throw orderCancelled.error;
    }
  }
  const decisionUpdate = await service.from("sponsorship_decisions").update({
    decision: "included", transaction_hash: result.transactionHash, actual_cost_wei: result.actualCostWei
  }).eq("id", decision.id).eq("decision", "submitted");
  if (decisionUpdate.error) throw decisionUpdate.error;
  return { ...result, logs: undefined };
};

export const sponsorshipWalletContext = ({ config, account, attestation }) => ({
  account_address: getAddress(account.account_address),
  account_runtime_code: attestation.accountRuntimeCode,
  account_code_hash: config.wallet.safeProxyCodeHash,
  passkey_public_key: attestation.passkeyPublicKey,
  threshold: attestation.threshold,
  safe_version: config.wallet.safeVersion,
  entry_point_address: config.wallet.entryPointAddress,
  entry_point_version: config.wallet.entryPointVersion,
  factory_address: config.wallet.safeFactoryAddress,
  singleton_address: config.wallet.safeSingletonAddress,
  safe_4337_module_address: config.wallet.safe4337ModuleAddress,
  shared_signer_address: config.wallet.safeWebAuthnSharedSignerAddress,
  p256_verifier_address: config.wallet.safePasskeyVerifierAddress
});

export const recordRejectedSecondarySponsorship = async ({ service, config, userId, accountId, body, error }) => {
  const key = requestKey(body?.request_key);
  const action = SECONDARY_SPONSOR_ACTIONS.includes(body?.action) ? body.action : null;
  if (!service || !key || !action || !userId || !accountId) return;
  const rawCode = String(error?.message || "secondary_sponsorship_rejected");
  if (!/^(INVALID_|SECONDARY_(CALL|SELF|TOKEN|ORDER|LISTING|SELLER|BUYER|RECIPIENT|TRANSFER|REVOKE|ACTION|USDC|FULFILLMENT))/.test(rawCode)) return;
  const existing = await service.from("sponsorship_decisions").select("id")
    .eq("user_id", userId).contains("policy_input", { client_request_key: key }).limit(1).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return;
  const rejectionCode = /^[A-Za-z0-9_:-]{1,120}$/.test(rawCode) ? rawCode.toLowerCase() : "secondary_sponsorship_rejected";
  const inserted = await service.from("sponsorship_decisions").insert({
    user_id: userId,
    smart_account_id: accountId,
    request_key: newSponsorshipLedgerKey(),
    action,
    decision: "rejected",
    policy_version: config.wallet.sponsorPolicyVersion,
    rejection_code: rejectionCode,
    policy_input: {
      schema: "secondary-userop-v1",
      client_request_key: key,
      rejection_stage: body.stage === "submit" ? "submit" : "prepare"
    }
  });
  if (inserted.error && inserted.error.code !== "23505") throw inserted.error;
};

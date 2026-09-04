import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  keccak256
} from "viem";
import {
  ZERO_ADDRESS,
  ZERO_HASH,
  normalizeResaleOrderComponents,
  resaleOrderHash,
  resaleProtocolData
} from "./resale-order.js";

export const SECONDARY_SPONSOR_ACTIONS = [
  "marketplace-transfer",
  "resale-approve-token",
  "resale-revoke-token",
  "resale-approve-usdc",
  "resale-revoke-usdc",
  "resale-fulfill",
  "resale-cancel-order"
];

const OFFER_ITEM = [
  { name: "itemType", type: "uint8" },
  { name: "token", type: "address" },
  { name: "identifierOrCriteria", type: "uint256" },
  { name: "startAmount", type: "uint256" },
  { name: "endAmount", type: "uint256" }
];
const CONSIDERATION_ITEM = [
  ...OFFER_ITEM,
  { name: "recipient", type: "address" }
];
const ORDER_PARAMETERS = [
  { name: "offerer", type: "address" },
  { name: "zone", type: "address" },
  { name: "offer", type: "tuple[]", components: OFFER_ITEM },
  { name: "consideration", type: "tuple[]", components: CONSIDERATION_ITEM },
  { name: "orderType", type: "uint8" },
  { name: "startTime", type: "uint256" },
  { name: "endTime", type: "uint256" },
  { name: "zoneHash", type: "bytes32" },
  { name: "salt", type: "uint256" },
  { name: "conduitKey", type: "bytes32" },
  { name: "totalOriginalConsiderationItems", type: "uint256" }
];
const ORDER_COMPONENTS = [
  { name: "offerer", type: "address" },
  { name: "zone", type: "address" },
  { name: "offer", type: "tuple[]", components: OFFER_ITEM },
  { name: "consideration", type: "tuple[]", components: CONSIDERATION_ITEM },
  { name: "orderType", type: "uint8" },
  { name: "startTime", type: "uint256" },
  { name: "endTime", type: "uint256" },
  { name: "zoneHash", type: "bytes32" },
  { name: "salt", type: "uint256" },
  { name: "conduitKey", type: "bytes32" },
  { name: "counter", type: "uint256" }
];

export const SAFE_EXECUTE_USEROP_ABI = [{
  type: "function",
  name: "executeUserOpWithErrorString",
  stateMutability: "nonpayable",
  inputs: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" }
  ],
  outputs: []
}];
export const ERC721_APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: []
}];
export const ERC721_SAFE_TRANSFER_ABI = [{
  type: "function", name: "safeTransferFrom", stateMutability: "nonpayable",
  inputs: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "tokenId", type: "uint256" }
  ],
  outputs: []
}];
export const ERC20_APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }]
}];
export const SEAPORT_FULFILL_ABI = [{
  type: "function", name: "fulfillOrder", stateMutability: "payable",
  inputs: [
    {
      name: "order", type: "tuple", components: [
        { name: "parameters", type: "tuple", components: ORDER_PARAMETERS },
        { name: "signature", type: "bytes" }
      ]
    },
    { name: "fulfillerConduitKey", type: "bytes32" }
  ],
  outputs: [{ name: "fulfilled", type: "bool" }]
}];
export const SEAPORT_CANCEL_ABI = [{
  type: "function", name: "cancel", stateMutability: "nonpayable",
  inputs: [{ name: "orders", type: "tuple[]", components: ORDER_COMPONENTS }],
  outputs: [{ name: "cancelled", type: "bool" }]
}];

const strictAddress = (input) => {
  if (!isAddress(input, { strict: true })) throw new Error("SECONDARY_CALL_REJECTED");
  return getAddress(input);
};
const strictUint = (input, { positive = false } = {}) => {
  const value = typeof input === "bigint" ? input : BigInt(String(input ?? ""));
  if (value < 0n || (positive && value === 0n)) throw new Error("SECONDARY_CALL_REJECTED");
  return value;
};
const canonicalData = (actual, encoded) => {
  if (!isHex(actual) || actual.toLowerCase() !== encoded.toLowerCase()) throw new Error("SECONDARY_CALL_REJECTED");
};

export const tokenApprovalCall = ({ collectionAddress, protocolAddress, tokenId, revoke = false }) => ({
  to: strictAddress(collectionAddress),
  value: 0n,
  data: encodeFunctionData({
    abi: ERC721_APPROVE_ABI,
    functionName: "approve",
    args: [revoke ? ZERO_ADDRESS : strictAddress(protocolAddress), strictUint(tokenId)]
  })
});

export const tokenTransferCall = ({ collectionAddress, fromAddress, recipientAddress, tokenId }) => {
  const from = strictAddress(fromAddress);
  const recipient = strictAddress(recipientAddress);
  if (recipient === strictAddress(ZERO_ADDRESS) || recipient === from) throw new Error("SECONDARY_CALL_REJECTED");
  return {
    to: strictAddress(collectionAddress),
    value: 0n,
    data: encodeFunctionData({
      abi: ERC721_SAFE_TRANSFER_ABI,
      functionName: "safeTransferFrom",
      args: [from, recipient, strictUint(tokenId)]
    })
  };
};

export const usdcApprovalCall = ({ usdcAddress, protocolAddress, amount, revoke = false }) => ({
  to: strictAddress(usdcAddress),
  value: 0n,
  data: encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [strictAddress(protocolAddress), revoke ? 0n : strictUint(amount, { positive: true })]
  })
});

export const fulfillmentCall = ({ protocolAddress, order, signature }) => ({
  to: strictAddress(protocolAddress),
  value: 0n,
  data: encodeFunctionData({
    abi: SEAPORT_FULFILL_ABI,
    functionName: "fulfillOrder",
    args: [resaleProtocolData({ order, signature }), ZERO_HASH]
  })
});

export const cancellationCall = ({ protocolAddress, order }) => ({
  to: strictAddress(protocolAddress),
  value: 0n,
  data: encodeFunctionData({
    abi: SEAPORT_CANCEL_ABI,
    functionName: "cancel",
    args: [[normalizeResaleOrderComponents(order)]]
  })
});

export const encodeSafeSecondaryCall = (call) => encodeFunctionData({
  abi: SAFE_EXECUTE_USEROP_ABI,
  functionName: "executeUserOpWithErrorString",
  args: [strictAddress(call.to), strictUint(call.value ?? 0n), call.data, 0]
});

const decodeOuterCall = (callData) => {
  const decoded = decodeFunctionData({ abi: SAFE_EXECUTE_USEROP_ABI, data: callData });
  if (decoded.functionName !== "executeUserOpWithErrorString" || Number(decoded.args[3]) !== 0) {
    throw new Error("SECONDARY_CALL_REJECTED");
  }
  const call = { to: strictAddress(decoded.args[0]), value: strictUint(decoded.args[1]), data: decoded.args[2] };
  canonicalData(callData, encodeSafeSecondaryCall(call));
  if (call.value !== 0n) throw new Error("SECONDARY_CALL_REJECTED");
  return call;
};

export const decodeSecondaryActionCall = ({ action, callData, config, accountAddress, expectedCall }) => {
  if (!SECONDARY_SPONSOR_ACTIONS.includes(action) || !isHex(callData)) throw new Error("SECONDARY_CALL_REJECTED");
  const account = strictAddress(accountAddress);
  const call = decodeOuterCall(callData);
  if (expectedCall && (
    call.to !== strictAddress(expectedCall.to)
    || call.value !== strictUint(expectedCall.value ?? 0n)
    || call.data.toLowerCase() !== expectedCall.data.toLowerCase()
  )) throw new Error("SECONDARY_CALL_CHANGED");

  if (action === "marketplace-transfer") {
    let inner;
    try {
      inner = decodeFunctionData({ abi: ERC721_SAFE_TRANSFER_ABI, data: call.data });
    } catch {
      throw new Error("SECONDARY_CALL_REJECTED");
    }
    const from = strictAddress(inner.args[0]);
    const recipient = strictAddress(inner.args[1]);
    const tokenId = strictUint(inner.args[2]);
    canonicalData(call.data, encodeFunctionData({
      abi: ERC721_SAFE_TRANSFER_ABI,
      functionName: "safeTransferFrom",
      args: [from, recipient, tokenId]
    }));
    if (from !== account || recipient === strictAddress(ZERO_ADDRESS) || recipient === account) {
      throw new Error("SECONDARY_CALL_REJECTED");
    }
    return {
      action, account, ...call, selector: call.data.slice(0, 10), collectionAddress: call.to,
      from, recipient, tokenId, callDataHash: keccak256(callData)
    };
  }

  if (action === "resale-approve-token" || action === "resale-revoke-token") {
    const inner = decodeFunctionData({ abi: ERC721_APPROVE_ABI, data: call.data });
    const approved = strictAddress(inner.args[0]);
    const tokenId = strictUint(inner.args[1]);
    canonicalData(call.data, encodeFunctionData({ abi: ERC721_APPROVE_ABI, functionName: "approve", args: [approved, tokenId] }));
    const expectedApproved = action === "resale-approve-token" ? strictAddress(config.secondary.protocolAddress) : strictAddress(ZERO_ADDRESS);
    if (approved !== expectedApproved) throw new Error("SECONDARY_CALL_REJECTED");
    return { action, account, ...call, selector: call.data.slice(0, 10), collectionAddress: call.to, approved, tokenId, callDataHash: keccak256(callData) };
  }

  if (action === "resale-approve-usdc" || action === "resale-revoke-usdc") {
    if (call.to !== strictAddress(config.secondary.usdcAddress)) throw new Error("SECONDARY_CALL_REJECTED");
    const inner = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: call.data });
    const spender = strictAddress(inner.args[0]);
    const amount = strictUint(inner.args[1]);
    canonicalData(call.data, encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [spender, amount] }));
    if (spender !== strictAddress(config.secondary.protocolAddress)
      || (action === "resale-approve-usdc" ? amount === 0n : amount !== 0n)) throw new Error("SECONDARY_CALL_REJECTED");
    return { action, account, ...call, selector: call.data.slice(0, 10), spender, amount, callDataHash: keccak256(callData) };
  }

  if (call.to !== strictAddress(config.secondary.protocolAddress)) throw new Error("SECONDARY_CALL_REJECTED");
  if (action === "resale-fulfill") {
    const inner = decodeFunctionData({ abi: SEAPORT_FULFILL_ABI, data: call.data });
    const protocolData = inner.args[0];
    if (inner.args[1].toLowerCase() !== ZERO_HASH) throw new Error("SECONDARY_CALL_REJECTED");
    const order = normalizeResaleOrderComponents({ ...protocolData.parameters, counter: expectedCall?.order?.counter });
    const signature = protocolData.signature;
    canonicalData(call.data, fulfillmentCall({ protocolAddress: call.to, order, signature }).data);
    return {
      action, account, ...call, selector: call.data.slice(0, 10), order, signature,
      orderHash: resaleOrderHash(order), callDataHash: keccak256(callData)
    };
  }

  const inner = decodeFunctionData({ abi: SEAPORT_CANCEL_ABI, data: call.data });
  if (inner.args[0].length !== 1) throw new Error("SECONDARY_CALL_REJECTED");
  const order = normalizeResaleOrderComponents(inner.args[0][0]);
  canonicalData(call.data, cancellationCall({ protocolAddress: call.to, order }).data);
  if (strictAddress(order.offerer) !== account) throw new Error("SECONDARY_CALL_REJECTED");
  return { action, account, ...call, selector: call.data.slice(0, 10), order, orderHash: resaleOrderHash(order), callDataHash: keccak256(callData) };
};

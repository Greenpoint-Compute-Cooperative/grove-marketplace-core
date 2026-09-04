import { getAddress, hashStruct, hashTypedData, isAddress, isHex } from "viem";

export const SEAPORT_1_6_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_HASH = `0x${"0".repeat(64)}`;

export const SEAPORT_ORDER_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" }
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" }
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" }
  ]
};

const uint = (input, { positive = false } = {}) => {
  const output = typeof input === "bigint" ? input.toString() : String(input ?? "");
  if (!/^(0|[1-9][0-9]{0,77})$/.test(output) || (positive && BigInt(output) === 0n)) {
    throw new Error("INVALID_RESALE_ORDER");
  }
  return output;
};

const address = (input) => {
  if (!isAddress(input, { strict: true })) throw new Error("INVALID_RESALE_ORDER");
  return getAddress(input);
};

const item = (input, consideration) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_RESALE_ORDER");
  const output = {
    itemType: Number(input.itemType),
    token: address(input.token),
    identifierOrCriteria: uint(input.identifierOrCriteria),
    startAmount: uint(input.startAmount, { positive: true }),
    endAmount: uint(input.endAmount, { positive: true })
  };
  if (!Number.isInteger(output.itemType) || output.itemType < 0 || output.itemType > 5) throw new Error("INVALID_RESALE_ORDER");
  if (consideration) output.recipient = address(input.recipient);
  return output;
};

export const normalizeResaleOrderComponents = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_RESALE_ORDER");
  const offer = Array.isArray(input.offer) ? input.offer.map((entry) => item(entry, false)) : [];
  const consideration = Array.isArray(input.consideration) ? input.consideration.map((entry) => item(entry, true)) : [];
  const output = {
    offerer: address(input.offerer),
    zone: address(input.zone),
    offer,
    consideration,
    orderType: Number(input.orderType),
    startTime: uint(input.startTime),
    endTime: uint(input.endTime),
    zoneHash: input.zoneHash,
    salt: uint(input.salt, { positive: true }),
    conduitKey: input.conduitKey,
    counter: uint(input.counter)
  };
  if (offer.length !== 1 || consideration.length < 1 || consideration.length > 3
    || output.orderType !== 0 || output.zone !== getAddress(ZERO_ADDRESS)
    || !isHex(output.zoneHash, { size: 32 }) || output.zoneHash.toLowerCase() !== ZERO_HASH
    || !isHex(output.conduitKey, { size: 32 }) || output.conduitKey.toLowerCase() !== ZERO_HASH
    || BigInt(output.endTime) <= BigInt(output.startTime)) throw new Error("INVALID_RESALE_ORDER");
  return output;
};

export const resaleOrderTypedData = ({ chainId, protocolAddress, order }) => {
  if (![1, 11155111].includes(Number(chainId)) || !isAddress(protocolAddress, { strict: true })) {
    throw new Error("INVALID_RESALE_DOMAIN");
  }
  return {
    domain: {
      name: "Seaport",
      version: "1.6",
      chainId: Number(chainId),
      verifyingContract: getAddress(protocolAddress)
    },
    types: SEAPORT_ORDER_TYPES,
    primaryType: "OrderComponents",
    message: normalizeResaleOrderComponents(order)
  };
};

export const resaleOrderDigest = (input) => hashTypedData(resaleOrderTypedData(input));

export const resaleOrderHash = (order) => hashStruct({
  data: normalizeResaleOrderComponents(order),
  primaryType: "OrderComponents",
  types: SEAPORT_ORDER_TYPES
});

export const resaleProtocolData = ({ order, signature }) => {
  if (!isHex(signature) || signature.length < 4 || signature.length > 8_194) throw new Error("INVALID_RESALE_SIGNATURE");
  const components = normalizeResaleOrderComponents(order);
  const { counter: _counter, ...parameters } = components;
  return {
    parameters: {
      ...parameters,
      totalOriginalConsiderationItems: String(parameters.consideration.length)
    },
    signature
  };
};

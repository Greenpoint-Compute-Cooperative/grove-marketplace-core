import { keccak256, stringToHex } from "viem";

export const BID_INTENT_TYPES = {
  BidIntent: [
    { name: "auctionId", type: "bytes32" },
    { name: "workId", type: "bytes32" },
    { name: "bidderSafe", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "currency", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "validAfter", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "termsHash", type: "bytes32" },
    { name: "settlementRail", type: "uint8" },
    { name: "origin", type: "bytes32" }
  ]
};

export const scopedIdentifier = (namespace, value) => keccak256(stringToHex(`grove:${namespace}:${value}`));
export const currencyIdentifier = (currency) => keccak256(stringToHex(String(currency).toUpperCase()));

export const buildBidTypedData = ({
  auctionId,
  workId,
  bidderSafe,
  amount,
  currency,
  nonce,
  validAfter,
  validUntil,
  termsHash,
  settlementRail,
  origin,
  originHash,
  chainId
}) => ({
  domain: { name: "Grove Marketplace", version: "1", chainId },
  types: BID_INTENT_TYPES,
  primaryType: "BidIntent",
  message: {
    auctionId: scopedIdentifier("auction", auctionId),
    workId,
    bidderSafe,
    amount: BigInt(amount),
    currency: currencyIdentifier(currency),
    nonce: BigInt(nonce),
    validAfter: BigInt(validAfter),
    validUntil: BigInt(validUntil),
    termsHash,
    settlementRail: settlementRail === "card" ? 0 : 1,
    origin: originHash || scopedIdentifier("origin", origin)
  }
});

import { keccak256, stringToHex } from "viem";
import { scopedIdentifier } from "./bid-intent.js";

export const WALLET_LINK_TYPES = {
  WalletLink: [
    { name: "challenge", type: "bytes32" },
    { name: "safe", type: "address" },
    { name: "origin", type: "bytes32" },
    { name: "expiresAt", type: "uint64" }
  ]
};

export const challengeIdentifier = (challenge) => keccak256(challenge);

export const buildWalletLinkTypedData = ({ challenge, safe, origin, expiresAt, chainId }) => ({
  domain: { name: "Grove Wallet Link", version: "1", chainId },
  types: WALLET_LINK_TYPES,
  primaryType: "WalletLink",
  message: {
    challenge: challengeIdentifier(challenge),
    safe,
    origin: scopedIdentifier("origin", origin),
    expiresAt: BigInt(expiresAt)
  }
});

export const originIdentifier = (origin) => keccak256(stringToHex(`grove:origin:${origin}`));

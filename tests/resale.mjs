import assert from "node:assert/strict";
import { getAddress } from "viem";
import {
  buildFixedPriceResaleOrder,
  buildResaleFulfillment,
  openSeaAssetUrl,
  publishOpenSeaListing
} from "../lib/server/resale.js";
import {
  SEAPORT_1_6_ADDRESS,
  ZERO_HASH,
  normalizeResaleOrderComponents,
  resaleOrderDigest,
  resaleOrderHash,
  resaleProtocolData
} from "../lib/shared/resale-order.js";

const config = {
  wallet: { chainId: 11155111 },
  secondary: {
    protocolAddress: SEAPORT_1_6_ADDRESS,
    conduitKey: ZERO_HASH,
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    feeRecipient: "0x4444444444444444444444444444444444444444",
    feeBps: 250,
    minimumPrice: "1000000",
    maximumPrice: "1000000000000",
    maximumDurationSeconds: 2_592_000
  }
};

const order = buildFixedPriceResaleOrder({
  config,
  offerer: "0x1111111111111111111111111111111111111111",
  collectionAddress: "0x2222222222222222222222222222222222222222",
  tokenId: "7",
  grossAmount: "100000000",
  durationSeconds: 86_400,
  counter: "9",
  royaltyReceiver: "0x3333333333333333333333333333333333333333",
  royaltyAmount: "5000000",
  nowSeconds: 1_788_000_000,
  salt: "42"
});
assert.equal(order.orderType, 0, "listings are FULL_OPEN, never partial");
assert.equal(order.conduitKey, ZERO_HASH, "exact approval targets Seaport directly");
assert.deepEqual(order.offer, [{
  itemType: 2,
  token: getAddress("0x2222222222222222222222222222222222222222"),
  identifierOrCriteria: "7",
  startAmount: "1",
  endAmount: "1"
}]);
assert.deepEqual(order.consideration.map(({ recipient, startAmount }) => [recipient, startAmount]), [
  [getAddress("0x1111111111111111111111111111111111111111"), "92500000"],
  [getAddress("0x3333333333333333333333333333333333333333"), "5000000"],
  [getAddress("0x4444444444444444444444444444444444444444"), "2500000"]
]);
assert.match(resaleOrderHash(order), /^0x[0-9a-f]{64}$/);
assert.match(resaleOrderDigest({ chainId: 11155111, protocolAddress: SEAPORT_1_6_ADDRESS, order }), /^0x[0-9a-f]{64}$/);

const signature = `0x${"11".repeat(65)}`;
const protocolData = resaleProtocolData({ order, signature });
assert.equal(protocolData.parameters.totalOriginalConsiderationItems, "3");
assert.equal(protocolData.signature, signature);

const fulfillment = buildResaleFulfillment({
  config,
  order,
  signature,
  buyerAddress: "0x5555555555555555555555555555555555555555"
});
assert.equal(fulfillment.grossAmount, "100000000");
assert.equal(fulfillment.approvals.length, 1, "buyer approves only exact USDC spend");
assert.equal(fulfillment.fulfillment.to, getAddress(SEAPORT_1_6_ADDRESS));
assert.match(fulfillment.fulfillment.data, /^0x[0-9a-f]+$/);

assert.equal(
  openSeaAssetUrl({ chainId: 1, contractAddress: "0x2222222222222222222222222222222222222222", tokenId: "7" }),
  "https://opensea.io/assets/ethereum/0x2222222222222222222222222222222222222222/7"
);
assert.equal(openSeaAssetUrl({ chainId: 11155111, contractAddress: "0x2222222222222222222222222222222222222222", tokenId: "7" }), null,
  "Sepolia must never generate a misleading OpenSea asset link");
assert.throws(() => normalizeResaleOrderComponents({ ...order, orderType: 1 }), /INVALID_RESALE_ORDER/,
  "partial fills are rejected");
assert.throws(() => normalizeResaleOrderComponents({ ...order, conduitKey: `0x${"01".repeat(32)}` }), /INVALID_RESALE_ORDER/,
  "operator-wide conduit approvals are rejected");
assert.throws(() => buildFixedPriceResaleOrder({
  config, offerer: order.offerer, collectionAddress: order.offer[0].token, tokenId: "7", grossAmount: "999999",
  durationSeconds: 86_400, counter: "9", royaltyReceiver: order.consideration[1].recipient, royaltyAmount: "0", salt: "43"
}), /RESALE_POLICY_REJECTED/);

const originalFetch = globalThis.fetch;
const publishedRequests = [];
globalThis.fetch = async (url, options = {}) => {
  publishedRequests.push({ url: String(url), options });
  return new Response(JSON.stringify({ order_hash: resaleOrderHash(order) }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
try {
  const result = await publishOpenSeaListing({
    config: {
      ...config,
      wallet: { chainId: 1 },
      openSea: { liveReady: true, apiKey: "server-only-test-key" }
    },
    order,
    signature
  });
  assert.equal(result.order_hash, resaleOrderHash(order));
  assert.equal(publishedRequests.length, 1);
  assert.equal(publishedRequests[0].url, "https://api.opensea.io/api/v2/orders/ethereum/seaport/listings");
  assert.equal(publishedRequests[0].options.headers["X-API-KEY"], "server-only-test-key");
  const body = JSON.parse(publishedRequests[0].options.body);
  assert.equal(body.protocol_address, SEAPORT_1_6_ADDRESS);
  assert.equal(body.parameters.offerer, order.offerer);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Secondary market tests passed: fixed-price ERC-721/USDC policy, hashes, fees, fulfillment, and OpenSea boundary.");

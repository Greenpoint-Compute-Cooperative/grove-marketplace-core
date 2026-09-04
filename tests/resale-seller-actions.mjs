import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getAddress } from "viem";
import {
  buildExactResaleCancellation,
  buildExactTokenApprovalRevocation,
  buildFixedPriceResaleOrder
} from "../lib/server/resale.js";
import { SEAPORT_1_6_ADDRESS, ZERO_HASH, resaleOrderHash } from "../lib/shared/resale-order.js";

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
const orderHash = resaleOrderHash(order);

const cancellation = buildExactResaleCancellation({
  config,
  order,
  expectedOrderHash: orderHash,
  sellerAddress: order.offerer
});
assert.equal(cancellation.action, "resale-cancel-order");
assert.equal(cancellation.account_address, order.offerer);
assert.equal(cancellation.expected_call.to, getAddress(SEAPORT_1_6_ADDRESS));
assert.equal(cancellation.expected_call.value, "0");
assert.deepEqual(cancellation.expected_call.order, order, "cancellation carries the canonical order for sponsor revalidation");
assert.equal(cancellation.policy_input.order_hash, orderHash);
assert.equal(cancellation.policy_input.selector, cancellation.expected_call.data.slice(0, 10));
assert.match(cancellation.policy_input.call_data_hash, /^0x[0-9a-f]{64}$/);
assert.ok(!Object.hasOwn(cancellation, "userop_hash"), "preparation must not claim UserOperation submission");
assert.throws(() => buildExactResaleCancellation({
  config,
  order,
  expectedOrderHash: `0x${"99".repeat(32)}`,
  sellerAddress: order.offerer
}), /RESALE_CANCELLATION_MISMATCH/, "cancellation is bound to the stored order hash");

const revocation = buildExactTokenApprovalRevocation({
  config,
  sellerAddress: order.offerer,
  collectionAddress: order.offer[0].token,
  tokenId: order.offer[0].identifierOrCriteria,
  orderHash
});
assert.equal(revocation.action, "resale-revoke-token");
assert.equal(revocation.expected_call.to, order.offer[0].token);
assert.equal(revocation.expected_call.data.slice(0, 10), "0x095ea7b3", "revocation is approve(address,uint256)");
assert.equal(revocation.expected_call.data.slice(10, 74), "0".repeat(64), "revocation approves the zero address");
assert.equal(revocation.expected_call.value, "0");
assert.equal(revocation.policy_input.token_id, "7");
assert.equal(revocation.policy_input.approved_operator, "0x0000000000000000000000000000000000000000");
assert.ok(!Object.hasOwn(revocation, "userop_hash"), "revocation preparation must not claim submission");

const [sellerLoader, cancellationRoute, revocationRoute, resaleRoute, resaleServer, app] = await Promise.all([
  readFile(new URL("../lib/server/resale-seller-actions.js", import.meta.url), "utf8"),
  readFile(new URL("../api/resales/[id]/cancellation-context.js", import.meta.url), "utf8"),
  readFile(new URL("../api/resales/[id]/approval-revocation-context.js", import.meta.url), "utf8"),
  readFile(new URL("../api/resales.js", import.meta.url), "utf8"),
  readFile(new URL("../lib/server/resale.js", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);
assert.match(sellerLoader, /request\.headers\.get\("origin"\) !== config\.siteUrl/, "seller actions enforce same-origin POSTs");
assert.match(sellerLoader, /\.eq\("seller_user_id", user\.id\)/, "order lookup is bound to the authenticated seller");
assert.match(sellerLoader, /attestSmartAccountProfile/, "seller Safe configuration is re-attested");
assert.match(cancellationRoute, /submission: "not-submitted"/, "cancellation context does not fake submission");
assert.match(revocationRoute, /cancel_order_first/, "revocation cannot replace an active order cancellation");
assert.match(revocationRoute, /submission: "not-submitted"/, "revocation context does not fake submission");
assert.doesNotMatch(cancellationRoute + revocationRoute, /\.from\("resale_orders"\)\.update/, "context routes do not mutate listing state");
assert.match(cancellationRoute, /listing_id: order\.id/, "cancellation intent targets the sponsor route by listing id");
assert.match(revocationRoute, /work_id: order\.work_id/, "revocation intent targets the sponsor route by work id");
assert.match(resaleRoute, /seller_managed: managedIds\.has\(order\.id\)/, "the feed marks only RLS-visible seller listings");
assert.match(resaleRoute, /managed_orders: managedOrders/, "private order references preserve approval cleanup after cancellation");
assert.match(resaleRoute, /select\("id,work_id,state"\)/, "managed listing metadata omits seller identity and order payloads");
assert.match(resaleRoute, /"Cache-Control": "private, no-store"/, "seller annotations cannot enter a shared cache");
const listingContextSource = resaleServer.match(/export const prepareResaleOrderContext[\s\S]+?export const verifyPublishableResaleOrder/)?.[0] || "";
for (const code of ["SEAPORT_CODE_HASH_MISMATCH", "USDC_CODE_HASH_MISMATCH", "COLLECTION_CODE_HASH_MISMATCH"]) {
  assert.match(listingContextSource, new RegExp(code), `listing preparation checks ${code}`);
}
assert.match(app, /data-cancel-resale/, "owned listings expose a cancellation control");
assert.match(app, /work\.resaleManagedId/, "approval cleanup survives removal from the public order view");
assert.match(app, /signSponsoredSecondaryUserOperation/, "seller controls use the real shared signing pipeline");
assert.match(app, /submitted\.stage !== "submitted"[\s\S]+submitted\.userop_hash/, "UI requires provider submission evidence before reporting success");

console.log("Resale seller action tests passed: exact cancellation/revocation and no fake submission evidence.");

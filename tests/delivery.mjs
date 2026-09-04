import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTokenDeliveryCall, safeTransactionFields } from "../lib/server/delivery.js";

const inventorySafe = "0x2222222222222222222222222222222222222222";
const winnerSafe = "0x3333333333333333333333333333333333333333";
const collectionAddress = "0x1111111111111111111111111111111111111111";

const erc721 = buildTokenDeliveryCall({
  standard: "ERC721", collectionAddress, inventorySafe, winnerSafe, tokenId: 7, quantity: 1
});
assert.equal(erc721.to, collectionAddress);
assert.equal(erc721.data.slice(0, 10), "0x42842e0e", "ERC721 delivery uses safeTransferFrom(address,address,uint256)");
assert.throws(() => buildTokenDeliveryCall({
  standard: "ERC721", collectionAddress, inventorySafe, winnerSafe, tokenId: 7, quantity: 2
}), /ERC721_QUANTITY_INVALID/);

const erc1155 = buildTokenDeliveryCall({
  standard: "ERC1155", collectionAddress, inventorySafe, winnerSafe, tokenId: 8, quantity: 3
});
assert.equal(erc1155.data.slice(0, 10), "0xf242432a", "ERC1155 delivery uses safeTransferFrom");
const safe = safeTransactionFields({ call: erc721, nonce: 9 });
assert.deepEqual({
  value: safe.value,
  operation: safe.operation,
  safeTxGas: safe.safeTxGas,
  baseGas: safe.baseGas,
  gasPrice: safe.gasPrice,
  gasToken: safe.gasToken,
  refundReceiver: safe.refundReceiver,
  nonce: safe.nonce
}, {
  value: 0n,
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: "0x0000000000000000000000000000000000000000",
  refundReceiver: "0x0000000000000000000000000000000000000000",
  nonce: 9n
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [worker, helper, migration, hardeningMigration] = await Promise.all([
  readFile(join(root, "api/cron/nft-delivery.js"), "utf8"),
  readFile(join(root, "lib/server/delivery.js"), "utf8"),
  readFile(join(root, "supabase/migrations/20260906000000_auction_nft_delivery.sql"), "utf8"),
  readFile(join(root, "supabase/migrations/20260907000000_inventory_safe_and_efw_hardening.sql"), "utf8")
]);
assert.doesNotMatch(`${worker}\n${helper}`,
  /privateKey|keystore|privateKeyToAccount|createWalletClient|signTransaction|sendTransaction|sendRawTransaction|writeContract/i,
  "delivery worker contains no owner-key, signature, or broadcast path");
for (const rpc of ["authorize_auction_delivery", "claim_auction_delivery", "record_auction_delivery_inclusion", "finalize_auction_delivery"]) {
  assert.match(migration, new RegExp(`revoke all on function public\\.${rpc}`), `${rpc} is revoked from public roles`);
  assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}[\\s\\S]*?to service_role`), `${rpc} is service-only`);
}
assert.match(migration, /chain_deliveries_safe_nonce_idx/, "Safe nonce use is unique per inventory Safe");
assert.match(migration, /delivery_evidence_immutable/, "prepared delivery evidence is immutable");
assert.match(migration, /selected_attempt\.state <> 'succeeded'/, "claim rechecks payment success");
assert.match(migration, /tax_transaction_ref is null or selected_settlement\.paid_at is null/,
  "release requires committed tax and authoritative paid time");
assert.match(migration, /auction_payment_risk_signals[\s\S]*?and actionable/,
  "release fails closed on actionable provider risk");
assert.match(helper, /config\.auctions\.inventorySafeSingletonAddress/,
  "inventory attestation uses its independent Safe singleton trust root");
assert.match(helper, /config\.auctions\.inventorySafeSingletonCodeHash/,
  "inventory attestation verifies its independently pinned singleton code hash");
assert.match(hardeningMigration, /new\.signal_kind = 'early-fraud-warning'[\s\S]*?new\.actionable := new\.resolved_at is null/,
  "every unresolved Early Fraud Warning remains blocking regardless of Stripe actionable state");
assert.match(hardeningMigration, /resolve_auction_early_fraud_warning/,
  "Early Fraud Warnings require a separate evidenced resolution RPC");
assert.match(hardeningMigration, /revoke all on function public\.resolve_auction_early_fraud_warning[\s\S]*?from public, anon, authenticated/,
  "risk resolution is not browser executable");

console.log("NFT delivery evidence checks passed.");

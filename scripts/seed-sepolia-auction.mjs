import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { createPublicClient, getAddress, http, isAddress, isHex, keccak256 } from "viem";
import { sepolia } from "viem/chains";
import { requireAuctionConfig } from "../lib/server/auction.js";
import { verifyFinalizedInventoryCustody } from "../lib/server/chain.js";

const env = (name) => String(process.env[name] || "").trim();
const uuid = (input) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
const whole = (input, { positive = false } = {}) => {
  assert.match(input, /^(0|[1-9][0-9]{0,77})$/, "Expected an unsigned integer.");
  const parsed = BigInt(input);
  if (positive) assert.ok(parsed > 0n, "Expected a positive integer.");
  return parsed;
};

const url = env("SUPABASE_URL");
const secret = env("SUPABASE_SECRET_KEY");
const previewRef = env("GROVE_PREVIEW_PROJECT_REF");
const deploymentTarget = env("VERCEL_TARGET_ENV") || env("VERCEL_ENV") || "local";
assert.equal(env("GROVE_SEED_TARGET"), "preview", "Set GROVE_SEED_TARGET=preview explicitly.");
assert.ok(url && secret && previewRef, "Preview URL, project ref, and server secret are required.");
assert.equal(new URL(url).hostname, `${previewRef}.supabase.co`, "The URL must match the named preview project.");
assert.notEqual(deploymentTarget, "production", "Sepolia seed refuses a production target.");
assert.notEqual(process.env.VERCEL_ENV, "production", "Sepolia seed refuses a production runtime.");

const config = requireAuctionConfig();
assert.equal(config.wallet.chainId, 11155111, "The rehearsal must use Sepolia.");
const stripeTaxCode = env("GROVE_PREVIEW_STRIPE_TAX_CODE");
assert.match(stripeTaxCode, /^txcd_[0-9]+$/,
  "GROVE_PREVIEW_STRIPE_TAX_CODE must be an explicitly reviewed Stripe tax classification.");

const standard = env("GROVE_PREVIEW_NFT_STANDARD");
const contractAddressInput = env("GROVE_PREVIEW_NFT_CONTRACT_ADDRESS");
const inventorySafeInput = env("GROVE_PREVIEW_NFT_INVENTORY_SAFE");
const codeHash = env("GROVE_PREVIEW_NFT_CODE_HASH").toLowerCase();
const deploymentTxHash = env("GROVE_PREVIEW_NFT_DEPLOYMENT_TX_HASH").toLowerCase();
const mintTxHash = env("GROVE_PREVIEW_NFT_MINT_TX_HASH").toLowerCase();
const nftWorkId = env("GROVE_PREVIEW_NFT_WORK_ID").toLowerCase();
assert.ok(["ERC721", "ERC1155"].includes(standard), "GROVE_PREVIEW_NFT_STANDARD must be ERC721 or ERC1155.");
assert.ok(isAddress(contractAddressInput, { strict: true }), "A checksummed or lowercase NFT contract address is required.");
assert.ok(isAddress(inventorySafeInput, { strict: true }), "A checksummed or lowercase inventory Safe is required.");
assert.ok(isHex(codeHash, { size: 32 }), "The NFT runtime code hash is required.");
assert.ok(isHex(deploymentTxHash, { size: 32 }), "The NFT deployment transaction hash is required.");
assert.ok(isHex(mintTxHash, { size: 32 }), "The NFT mint transaction hash is required.");
assert.ok(isHex(nftWorkId, { size: 32 }) && nftWorkId !== `0x${"0".repeat(64)}`, "The on-chain work ID is required.");
const contractAddress = getAddress(contractAddressInput);
const inventorySafe = getAddress(inventorySafeInput);
const deploymentBlock = whole(env("GROVE_PREVIEW_NFT_DEPLOYMENT_BLOCK"));
const mintBlock = whole(env("GROVE_PREVIEW_NFT_MINT_BLOCK"));
const tokenId = whole(env("GROVE_PREVIEW_NFT_TOKEN_ID"));
const quantity = whole(env("GROVE_PREVIEW_NFT_QUANTITY"), { positive: true });
assert.ok(quantity <= 2_147_483_647n, "The rehearsal quantity exceeds the catalog inventory limit.");
if (standard === "ERC721") assert.equal(quantity, 1n, "An ERC721 auction quantity must be one.");

const auctionId = env("GROVE_PREVIEW_AUCTION_ID");
assert.ok(uuid(auctionId), "GROVE_PREVIEW_AUCTION_ID must be a UUID.");
const opensAt = new Date(env("GROVE_PREVIEW_AUCTION_OPENS_AT"));
const closesAt = new Date(env("GROVE_PREVIEW_AUCTION_CLOSES_AT"));
assert.ok(Number.isFinite(opensAt.getTime()) && Number.isFinite(closesAt.getTime()), "Auction open and close timestamps are required.");
assert.ok(opensAt < new Date() && new Date() < closesAt, "The seeded rehearsal auction must currently be open.");
assert.ok(closesAt.getTime() - opensAt.getTime() <= 30 * 24 * 60 * 60_000, "The rehearsal auction may run for at most 30 days.");
const reserveAmount = whole(env("GROVE_PREVIEW_AUCTION_RESERVE_MINOR"), { positive: true });
const minimumIncrement = whole(env("GROVE_PREVIEW_AUCTION_INCREMENT_MINOR"), { positive: true });
const maximumAmount = BigInt(config.auctions.maximumFiatHammerMinor);
assert.ok(reserveAmount <= maximumAmount, "The reserve exceeds the configured card maximum.");

const rpc = createPublicClient({ chain: sepolia, transport: http(config.wallet.rpcUrl) });
const [finalizedBlock, deployedReceipt, mintReceipt] = await Promise.all([
  rpc.getBlock({ blockTag: "finalized" }),
  rpc.getTransactionReceipt({ hash: deploymentTxHash }),
  rpc.getTransactionReceipt({ hash: mintTxHash })
]);
assert.equal(deployedReceipt.status, "success", "The deployment transaction did not succeed.");
assert.equal(mintReceipt.status, "success", "The mint transaction did not succeed.");
assert.equal(deployedReceipt.blockNumber, deploymentBlock, "The recorded deployment block does not match its receipt.");
assert.equal(mintReceipt.blockNumber, mintBlock, "The recorded mint block does not match its receipt.");
assert.ok(deployedReceipt.contractAddress && getAddress(deployedReceipt.contractAddress) === contractAddress,
  "The deployment receipt does not create the configured collection.");
assert.ok(finalizedBlock.number >= deploymentBlock && finalizedBlock.number >= mintBlock, "The collection and mint must be finalized.");
const bytecode = await rpc.getBytecode({ address: contractAddress, blockNumber: finalizedBlock.number });
assert.ok(bytecode && keccak256(bytecode).toLowerCase() === codeHash, "The finalized NFT runtime code hash does not match.");

const workIdAbi = [{
  type: "function",
  name: standard === "ERC721" ? "workIdOf" : "workIdByToken",
  stateMutability: "view",
  inputs: [{ name: "tokenId", type: "uint256" }],
  outputs: [{ name: "workId", type: "bytes32" }]
}];
const onchainWorkId = await rpc.readContract({
  address: contractAddress,
  abi: workIdAbi,
  functionName: standard === "ERC721" ? "workIdOf" : "workIdByToken",
  args: [tokenId],
  blockNumber: finalizedBlock.number
});
assert.equal(onchainWorkId.toLowerCase(), nftWorkId, "The token is not registered to the configured work ID.");

const collectionEvidence = {
  standard,
  chain_id: 11155111,
  contract_address: contractAddress.toLowerCase(),
  deployed_code_hash: codeHash,
  inventory_safe: inventorySafe.toLowerCase(),
  deployment_tx_hash: deploymentTxHash,
  deployment_block: deploymentBlock.toString(),
  contract_version: env("GROVE_PREVIEW_NFT_CONTRACT_VERSION") || "sepolia-rehearsal",
  state: "rehearsal"
};
const workEvidence = {
  nft_work_id: nftWorkId,
  nft_token_id: tokenId.toString(),
  nft_quantity: quantity.toString(),
  nft_mint_tx_hash: mintTxHash,
  nft_mint_block: mintBlock.toString(),
  nft_finalized_at: new Date(Number(finalizedBlock.timestamp) * 1000).toISOString(),
  nft_custody_state: "inventory-safe",
  contract_status: "minted"
};
await verifyFinalizedInventoryCustody({ config, work: workEvidence, collection: collectionEvidence, quantity });

const database = createClient(url, secret, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
});
let { data: collection, error: collectionError } = await database.from("nft_collections").select("*")
  .eq("chain_id", 11155111).eq("contract_address", contractAddress.toLowerCase()).maybeSingle();
if (collectionError) throw collectionError;
if (!collection) {
  const inserted = await database.from("nft_collections").insert(collectionEvidence).select("*").single();
  collection = inserted.data;
  collectionError = inserted.error;
}
if (collectionError || !collection) throw collectionError || new Error("Collection insert failed.");
for (const [field, expected] of Object.entries(collectionEvidence)) {
  assert.equal(String(collection[field]), String(expected), `Existing collection ${field} differs from verified evidence.`);
}

const workId = "66666666-6666-4666-8666-666666666666";
const slug = "sepolia-passkey-auction-rehearsal";
const workRecord = {
  id: workId,
  slug,
  artist_name: "Preview Artist",
  title: "Passkey Auction — Sepolia Rehearsal",
  description: "Synthetic preview auction backed by a finalized Sepolia NFT. No production asset or payment is represented.",
  format: "digital",
  media_url: `${config.siteUrl}/public/assets/digital-works.svg`,
  chain: "ethereum-sepolia",
  contract_address: contractAddress.toLowerCase(),
  token_id: tokenId.toString(),
  contract_status: "minted",
  status: "listed",
  listed_at: opensAt.toISOString(),
  sale_enabled: false,
  sale_kind: "auction",
  stripe_tax_code: stripeTaxCode,
  inventory_total: Number(quantity),
  inventory_available: Number(quantity),
  nft_collection_id: collection.id,
  ...workEvidence
};
let { data: work, error: workError } = await database.from("works").select("*").eq("slug", slug).maybeSingle();
if (workError) throw workError;
if (!work) {
  const inserted = await database.from("works").insert(workRecord).select("*").single();
  work = inserted.data;
  workError = inserted.error;
}
if (workError || !work) throw workError || new Error("Work insert failed.");
for (const field of ["nft_collection_id", "nft_work_id", "nft_token_id", "nft_quantity", "nft_mint_tx_hash", "nft_mint_block", "nft_custody_state", "contract_status"]) {
  assert.equal(String(work[field]), String(workRecord[field]), `Existing work ${field} differs from verified evidence.`);
}
assert.equal(work.stripe_tax_code, stripeTaxCode,
  "Existing rehearsal work tax code differs. Review and correct the classification separately; seed never overwrites it.");
assert.equal(work.status, "listed", "The verified rehearsal work exists but is not publicly listed.");
assert.equal(work.sale_kind, "auction", "The verified rehearsal work is not classified as an auction lot.");

const auctionRecord = {
  id: auctionId.toLowerCase(),
  work_id: work.id,
  settlement_rail: "card",
  bid_currency: "USD",
  state: "open",
  opens_at: opensAt.toISOString(),
  closes_at: closesAt.toISOString(),
  original_closes_at: closesAt.toISOString(),
  quantity: quantity.toString(),
  reserve_amount: reserveAmount.toString(),
  minimum_increment: minimumIncrement.toString(),
  anti_snipe_window_seconds: 120,
  anti_snipe_extension_seconds: 120,
  maximum_extensions: 10,
  maximum_card_bid_minor: Number(maximumAmount),
  terms_url: config.auctions.termsUrl,
  terms_version: config.auctions.termsVersion,
  terms_hash: config.auctions.termsHash
};
let { data: auction, error: auctionError } = await database.from("auctions").select("*").eq("id", auctionRecord.id).maybeSingle();
if (auctionError) throw auctionError;
if (!auction) {
  const inserted = await database.from("auctions").insert(auctionRecord).select("*").single();
  auction = inserted.data;
  auctionError = inserted.error;
}
if (auctionError || !auction) throw auctionError || new Error("Auction insert failed.");
for (const field of ["work_id", "settlement_rail", "bid_currency", "state", "reserve_amount", "minimum_increment", "terms_hash"]) {
  assert.equal(String(auction[field]), String(auctionRecord[field]), `Existing auction ${field} differs from the requested rehearsal.`);
}
assert.equal(new Date(auction.opens_at).getTime(), opensAt.getTime(), "Existing auction opening differs from the requested rehearsal.");
assert.equal(new Date(auction.original_closes_at).getTime(), closesAt.getTime(), "Existing auction close differs from the requested rehearsal.");
assert.equal(auction.terms_version, auctionRecord.terms_version, "Existing auction terms version differs from the configured rehearsal.");
assert.equal(Number(auction.maximum_card_bid_minor), auctionRecord.maximum_card_bid_minor,
  "Existing auction card maximum differs from the configured rehearsal.");

console.log(`Verified and seeded one open Sepolia auction: ${auction.id} (${slug}).`);

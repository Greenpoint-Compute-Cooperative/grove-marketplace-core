# NFT auction and card settlement runbook

The auction lane is disabled by default. It uses Stripe-hosted Checkout to establish an Apple Pay/card mandate, signed offchain bids, winner-only settlement, a risk hold, then transfer of an already-minted NFT from the inventory Safe.

## Required production configuration

All existing Supabase, Stripe webhook, automatic-tax, canonical-site, cron, and social-provider values remain required. The auction lane additionally requires:

```text
GROVE_WALLET_ENABLED=true
GROVE_AUCTIONS_ENABLED=true
GROVE_ETHEREUM_CHAIN_ID=1
GROVE_ETHEREUM_RPC_URL=https://...
GROVE_ENTRY_POINT_ADDRESS=0x...
GROVE_SAFE_FACTORY_ADDRESS=0x...
# SafeL2 singleton used by member 4337 accounts.
GROVE_SAFE_SINGLETON_ADDRESS=0x...
# Safe singleton used by the 2-of-3 inventory Safe.
GROVE_INVENTORY_SAFE_SINGLETON_ADDRESS=0x...
GROVE_SAFE_FALLBACK_HANDLER_ADDRESS=0x...
GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS=0x...
GROVE_SAFE_4337_MODULE_ADDRESS=0x...
GROVE_SAFE_PASSKEY_VERIFIER_ADDRESS=0x...
GROVE_ENTRY_POINT_CODE_HASH=0x...
GROVE_SAFE_FACTORY_CODE_HASH=0x...
GROVE_SAFE_PROXY_CODE_HASH=0x...
GROVE_SAFE_SINGLETON_CODE_HASH=0x...
GROVE_INVENTORY_SAFE_SINGLETON_CODE_HASH=0x...
GROVE_SAFE_FALLBACK_HANDLER_CODE_HASH=0x...
GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_CODE_HASH=0x...
GROVE_SAFE_4337_MODULE_CODE_HASH=0x...
GROVE_SAFE_PASSKEY_VERIFIER_CODE_HASH=0x...
GROVE_BUNDLER_URL=https://...
GROVE_PAYMASTER_URL=https://...
GROVE_PAYMASTER_API_TOKEN=...
GROVE_SPONSOR_POLICY_VERSION=...
GROVE_STRIPE_NFT_APPROVAL_REF=...
GROVE_AUCTION_TERMS_URL=https://...
GROVE_AUCTION_TERMS_VERSION=...
GROVE_AUCTION_TERMS_HASH=0x...
GROVE_MAX_FIAT_HAMMER_MINOR=...
GROVE_AUCTION_MANDATE_HOURS=168
GROVE_AUCTION_SETTLEMENT_HOURS=48
GROVE_AUCTION_RISK_HOLD_HOURS=168
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
GROVE_STRIPE_AUTOMATIC_TAX=true
CRON_SECRET=...
```

Addresses must be lower-case and code-hash verified. The member SafeL2 singleton and inventory Safe singleton are independent trust roots and must never be substituted for one another. Secrets are server-only. The Stripe approval reference must point to written approval for this exact primary-NFT, auction, Apple Pay, off-session, value, refund/chargeback, and merchant model.

## Enablement sequence

1. Close legal/provider/product Gate 0 in the master plan. Do not infer approval from a working Stripe test request.
2. Pin and verify Safe 1.4.1, Safe 4337 module 0.3.0, Safe Passkey 0.2.1-1, EntryPoint 0.7, proxy/singleton/factory/shared-signer/verifier addresses, and runtime code hashes. Require the Safe 4337 module address and code hash to exactly equal the fallback handler address and code hash.
3. Apply all migrations in preview, then production only after the SQL suite passes on a fresh Postgres 16 database.
4. Deploy the exact audited collection release to Sepolia. Verify separate 2-of-3 admin and inventory Safes and distinct registrar/minter/pause roles.
5. Rehearse social login → primary passkey → sponsored Safe deployment → second recovery signer → wallet link → recovery rotation.
6. For every real work, clear rights and freeze the work ID, token identity, immutable metadata/license, royalty, edition cap, and physical pairing terms.
7. Mint the one-of-one or full edition to inventory. Record and reconcile transaction/block hashes, collection code hash, owner/balance, URI, supply, and finality before setting `inventory-safe`.
8. Register `POST /api/stripe/webhook` for checkout, setup-intent, payment-intent, refund, and dispute events documented in the master plan. Replay duplicates and out-of-order events.
9. Rehearse Apple Pay on real eligible devices, SetupIntent failure/cancel/success, bid replay and races, off-session winner success/decline/action, interactive cure, tax/shipping, provider review, refund, dispute, and post-mint dispute.
10. Rehearse paymaster rejection, malicious targets/selectors/value, budget exhaustion, bundler/RPC outage, inclusion timeout, Safe owner rotation, mainnet reorg, and inventory mismatch.
11. Start with invited members, low maximum bids, manual close/release, a conservative risk hold, and daily reconciliation. Expand only from evidence.

## Opening an auction

An operator must prove:

- auction rail and currency are immutable and match (`card/USD` or later `crypto/USDC|WETH`);
- work and all rights are approved;
- collection address/code hash and work/token binding match the audited release;
- NFT owner/balance is the inventory Safe at a finalized block;
- terms URL/version/hash, reserve, increment, close time, anti-sniping rules, maximum hammer, tax code, shipping, and cure/risk windows are frozen;
- kill switches, provider health, paymaster budgets, alerting, and on-call ownership are active.

Do not open based on an indexer alone.

## Closing a card auction

1. Close worker locks the auction after the server close time and rereads the winning bid.
2. Revalidate the winner's Safe, ownership/recovery state, EIP-712 payload, ERC-1271 signature, nonce, terms, and card mandate.
3. Select the winner exactly once. If reserve is not met or proof is stale, record no-sale/exception rather than guessing.
4. Calculate tax/shipping using current provider data; freeze the exact total and settlement deadline. Set `paid_at` and the risk-hold deadline only from the authoritative payment-success timestamp, never from tax calculation time.
5. Create one unconfirmed winner PaymentIntent with a stable generation idempotency key, atomically bind it as the settlement's current intent, then confirm it off-session. Never create or confirm a replacement until Stripe is retrieved-current and reports the named prior generation `canceled`; complete or cancel a failed/action-required intent before replacement.
6. On `requires_action`/decline, issue a short-lived hosted cure flow. If the cure expires, follow the published default/no-sale policy.
7. A signed webhook must retrieve the current PaymentIntent and match settlement, total, currency, and status.
8. Keep `paid-risk-hold` until the deadline, fraud/provider review is clear, no refund/dispute is open, and a human or reviewed policy releases it.
9. Call the service-only `authorize_auction_delivery` RPC with a fresh retrieved-provider evidence hash. Authorization fails closed unless the current payment is succeeded, tax transaction and paid timestamp are recorded, the risk hold passed, and no refund, open review, unresolved early-fraud warning, or winner-wallet mismatch exists. Stripe's `actionable=false` is not clearance: an Early Fraud Warning remains blocking until `resolve_auction_early_fraud_warning` records a separate fresh provider/operator reference and evidence hash.
10. `/api/cron/nft-delivery` prepares one exact Safe transaction from finalized custody evidence. It records the ERC standard, inventory Safe nonce, Safe transaction hash, calldata hash, and evidence block; it never holds owner keys, creates signatures, or broadcasts a transaction.
11. Inventory Safe owners independently review that immutable packet, obtain the 2-of-3 quorum, and execute it just in time. An unsigned Safe transaction has no automatic expiry, so re-run the release checks instead of executing a stale proposal after any payment, fraud, wallet, or inventory state changes.
12. The delivery worker marks `nft-submitted` only after it observes the matching Safe `ExecutionSuccess`, exact ERC-721/1155 transfer event, decoded zero-value direct call, and Safe transaction hash onchain. It marks fulfillment only after the receipt block is canonical under Ethereum's finalized head.

The worker states are deliberately conservative: `queued` means an unsigned human-review packet exists; `included` means the exact transfer executed but is not finalized; `finalized` is the only successful fulfillment state. A refund or dispute after inclusion is `disputed-post-mint`; the contracts provide no clawback.

## Incident actions

- **Any false catalog/payment/NFT state:** set `GROVE_AUCTIONS_ENABLED=false`. Keep signed webhook and reconciliation ingestion on. Stop new setup/bids/close/charge/release, preserve evidence, enumerate every nonterminal mandate/auction/settlement/delivery, and reconcile from authoritative providers.
- **NFT not actually in inventory:** cancel or suspend the auction before close. Never substitute another token. If already paid, stop release and use the disclosed refund/exception process.
- **Signature or Safe ownership changed:** reject the bid or close to exception/no-sale. Require a newly signed intent; never reuse an earlier successful ERC-1271 result.
- **Setup session exists but database attachment is uncertain:** do not create an unbounded series of sessions. Retry the same mandate/idempotency key, retrieve current Stripe state, then attach or expire it.
- **Payment succeeded but state differs:** do not retry the charge. Retrieve current PaymentIntent, tax, refund/dispute, and provider review; replay the signed event after fixing the transition.
- **Payment requires action:** start only the explicit cure path. Do not transfer the NFT while action is outstanding.
- **Dispute/refund before NFT release:** freeze delivery and follow settlement policy. **After release:** record `disputed-post-mint`; the contracts have no clawback.
- **Bundler/paymaster failure:** stop sponsorship, not receipt reconciliation. Users should not be told an action completed until a canonical receipt is verified.
- **Reorg/RPC disagreement:** mark delivery `reorged`, stop dependent shipment/release, cross-check a second RPC, and reconcile the canonical block before resubmission.
- **Inventory/admin Safe compromise:** pause new collection issuance, disable auctions and sponsorship, preserve collector transfers, convene the Safe incident quorum, and do not improvise a contract upgrade or clawback.

## Daily reconciliation

- Stripe mandates, PaymentIntents, refunds, disputes, reviews, balances, and ledger totals versus Postgres.
- Every auction high bid/winner/settlement uniqueness and all close/cure deadlines.
- Ethereum collection code hashes, inventory Safe owner/balance, mint/delivery receipts, block hashes, confirmation/finality, and reorg markers.
- Paymaster quotes/actual spend, rejected policy actions, per-member/day/global budgets, bundler inclusion latency, and funded executor health.
- Outbox age, webhook retry age, exception rows, manual overrides, and unfulfilled paid settlements.

Browser redirects, support screenshots, or indexer pages never authorize money movement, NFT delivery, or shipment.

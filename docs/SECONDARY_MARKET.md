# Secondary-market release policy

Status: implementation boundary, 2026-09-03.

This document governs collector-to-collector NFT sales. It does not change Grove's primary auction ledger, card
checkout, inventory custody, or winner-delivery rules.

## Hard boundary

- OpenSea ended all testnet support on July 23, 2025. The former `testnets.opensea.io` experience is retired, and
  OpenSea's current NFT/metadata API chain enum does not include Sepolia. [OpenSea: Farewell,
  Testnets](https://support.opensea.io/en/articles/11833955-farewell-testnets) · [OpenSea supported-chain
  API](https://docs.opensea.io/reference/get_chains)
- Staging is **Seaport-native Sepolia only**. Grove submits and reconciles Seaport transactions against Sepolia
  directly; it does not claim OpenSea indexing, use an OpenSea testnet UI, or treat an OpenSea API response as the
  staging authority.
- The first secondary-sales release is **fixed-price ERC-721 settled in USDC**. ERC-1155 sales, native-ETH/WETH
  settlement, offers, collection offers, auctions, bundles, criteria orders, private sales, and cross-chain execution
  remain disabled.
- Stripe and Apple Pay must not be used to buy, settle, fund, guarantee, or cure a secondary NFT transaction. Stripe's
  current prohibited/restricted-business rules distinguish first-party NFT sales from secondary-market activity;
  Grove's Stripe integration remains primary-market only. [Stripe prohibited and restricted
  businesses](https://stripe.com/legal/restricted-businesses)
- ERC-2981 is advisory royalty information. It does not make royalties enforceable, escrow funds, or prove that a
  marketplace paid the receiver. [ERC-2981](https://eips.ethereum.org/EIPS/eip-2981)

## Release shape

| Environment | Order path | Asset and consideration | Indexing boundary |
|---|---|---|---|
| Sepolia staging | pinned Seaport deployment, direct RPC and receipt reconciliation | allowlisted Grove ERC-721 for allowlisted Sepolia USDC | Grove-owned read model only; no OpenSea claim |
| Ethereum production | pinned audited Seaport release; optional OpenSea order/API adapter | allowlisted mainnet Grove ERC-721 for canonical Ethereum USDC | OpenSea only after its independent launch gates pass |

The seller remains the NFT owner until fulfillment. The buyer supplies USDC principal. Grove may sponsor only an
explicitly allowlisted approval or fulfillment action under the normal paymaster budgets; sponsorship never supplies
USDC, grants an arbitrary approval, or makes a failed order successful.

The production asset tuple is immutable per order: chain ID, collection, token ID, seller, payment-token address,
price in base units, fee/royalty recipients, start/end time, Seaport counter, order type, zone, conduit, and salt.
The immutable Seaport order hash is the listing's idempotency identity. A listing becomes visible only after signature
verification, current ownership/approval/balance checks, simulation, and durable order-hash storage.

## Fixed-price ERC-721 flow

1. The authenticated seller selects an owned, finalized, allowlisted Grove ERC-721.
2. The server returns canonical order components from a pinned Seaport and USDC configuration. The browser may not
   substitute contract addresses, fees, recipients, or order type.
3. If needed, the seller passkey signs a sponsored Safe UserOperation granting only the exact-token approval. After
   finalized approval evidence, the seller signs the exact Seaport order. Contract-wallet signatures are verified
   against the current Safe before publication.
4. Before fulfillment, Grove rereads order status, counter, time window, owner, token approval, buyer USDC balance and
   allowance, fee recipients, and expected consideration; it then simulates the exact transaction.
5. The buyer passkey signs one sponsored Safe action at a time: normalize or grant the exact Seaport USDC allowance,
   then fulfill the fixed-price order. The buyer supplies the USDC principal; Grove supplies only allowlisted gas.
   Grove records the signed operation durably before provider submission and does not mark the sale complete from an
   optimistic provider response.
6. The reconciler verifies the canonical receipt, Seaport event, NFT transfer, USDC transfers, block hash, and
   finality. A reorg returns the order to reconciliation.

No application database write can itself transfer the NFT or USDC. No order is valid merely because it appears in an
offchain API.

## Seller cancellation and approval cleanup

`POST /api/resales/:id/cancellation-context` is seller-authenticated and returns an exact
`Seaport.cancel(OrderComponents[])` action bound to the stored order hash, current Safe, canonical Seaport address,
and a finalized chain observation. It does not change the database state, submit a UserOperation, or claim that the
listing is cancelled. The shared sponsorship pipeline must revalidate the action, submit it, and let canonical event
reconciliation move the order to `cancelled`. Hiding a listing or receiving this context is not cancellation.

After cancellation, expiry, or counter invalidation is established onchain,
`POST /api/resales/:id/approval-revocation-context` may return an exact
`ERC721.approve(address(0), tokenId)` action. It refuses approval-only cleanup while the signed order remains active,
because a later reapproval could make that order fillable again. Revocation is unnecessary if the exact Seaport
approval is already absent, and impossible from the seller Safe after it no longer owns the token.

Both endpoints return policy-bound action intents with an exact `expected_call`, zero call value, target and selector,
calldata hash, chain, Safe, token/order identity, a fresh server-issued client request key, and the server-derived
prepare request for the shared `/api/wallet/sponsor` pipeline. The browser submits that exact intent to the sponsor,
checks that the returned call is byte-for-byte identical, and signs the prepared UserOperation with the Safe passkey.
The public
feed annotates only the current authenticated seller's rows as `seller_managed` via base-table RLS; a separate
`managed_orders` list contains only that seller's order ID, work ID, and state so approval cleanup remains available
after a cancelled or expired order leaves the public view. Neither response returns seller user IDs. The work page
renders seller controls only from those private annotations.

## OpenSea production gates

OpenSea production support is a separate mainnet integration, not a promotion of the Sepolia rehearsal. Before any
"View on OpenSea", listing, or indexed-collection claim is enabled, all of these must be evidenced:

1. The exact audited collection version is deployed and source-verified on Ethereum mainnet, and at least one real,
   rights-cleared ERC-721 is minted with canonical transfer evidence.
2. Token JSON and every required media/license object are durably pinned to IPFS or another approved content-addressed
   store. A CID that exists only in a local file or mutable web copy is not deployed metadata. OpenSea accepts
   `ipfs://` token metadata. [OpenSea metadata storage](https://docs.opensea.io/docs/metadata-storage)
3. `tokenURI` returns valid JSON with supported media and traits. `contractURI` provides collection-level metadata;
   the relevant metadata events are emitted if any future release permits changes. [OpenSea metadata
   standards](https://docs.opensea.io/docs/metadata-standards) · [contract-level
   metadata](https://docs.opensea.io/docs/contract-level-metadata) · [updating
   metadata](https://docs.opensea.io/docs/updating-metadata)
4. An OpenSea API key is provisioned as a server-only secret. It is never shipped in browser JavaScript, logs,
   analytics, screenshots, or repository files. OpenSea also directs API/SDK integrations to keep the API key on the
   backend. [OpenSea search and discovery](https://docs.opensea.io/docs/search-and-discovery)
5. The production collection and token can be retrieved and refreshed through current OpenSea endpoints, and their
   canonical OpenSea URLs are recorded only after OpenSea returns the actual collection slug and item identity.
6. The exact `@opensea/seaport-js`, server-only OpenSea API adapter, Seaport address/code hash, conduit, zone, USDC
   address/code hash, API behavior, and order schema pass mainnet-fork and low-value mainnet rehearsals.

Do not manufacture a collection slug from the contract name. Do not publish legacy `testnets.opensea.io` links.

## Metadata and creator earnings

The NFT contracts advertise ERC-2981 per-token royalty data. The secondary worker must record the royalty query and
actual Seaport consideration transfers independently; the two may differ. Product copy must say "creator earnings"
only when a completed transaction proves the payment.

OpenSea describes creator earnings as either enforced or optional. Its current enforcement path uses Creator Token
transfer validation and Seaport hooks; ordinary ERC-2981 support alone is not that enforcement mechanism. Grove's
collection contracts deliberately preserve unrestricted standard collector transfers and do not claim enforced
secondary royalties. [OpenSea creator fee enforcement](https://docs.opensea.io/docs/creator-fee-enforcement) ·
[OpenSea fees and creator earnings](https://support.opensea.io/en/articles/8867091-what-fees-do-i-pay-on-opensea)

## Kill switches and blockers

Disable new secondary listings and fulfillment construction while continuing receipt reconciliation if any pinned
Seaport/USDC code hash changes, an RPC disagrees on canonical state, simulation diverges, the API key is revoked,
metadata becomes unavailable, or reconciliation falls behind. Existing signed orders require onchain cancellation or
counter invalidation; disabling Grove's UI is not cancellation.

Current release blockers are the independent contract/application security review, durable metadata pinning,
server-side OpenSea API credentials for production, exact mainnet collection and token evidence, pinned Seaport and
USDC infrastructure, a real bundler/paymaster provider attestation, signed Safe UserOperation and Seaport E2E,
mainnet-fork rehearsal, and sanctions/tax/legal review for secondary trading. The cancellation/fill/reorg and
sponsorship reconcilers are implemented and remain fail-closed until those rehearsals pass. Stripe approval for
primary sales cannot clear any of these secondary-market gates.

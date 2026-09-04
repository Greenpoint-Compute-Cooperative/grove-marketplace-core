# NFT ownership and wallet exit

The School must not custody a member's signing key. Apple Pay and Stripe are a
primary payment rail only; they do not create, fund, recover, or control a crypto
wallet. A member NFT is delivered to a Safe controlled by the member's passkey,
and the server stores public attestation material rather than the private key.

The buyer-facing mental model is:

1. Sign in with the linked social identity.
2. Create and recoverably configure the embedded passkey Safe before bidding.
3. Pay a winning primary-auction settlement through Stripe Checkout, where Apple
   Pay may be offered on an eligible device and account.
4. Wait for payment, risk, tax, inventory, and finalized-chain checks. Grove's
   inventory Safe transfers the exact ERC-721 to the member Safe.
5. Keep the NFT in that Safe, list it through the supported Seaport flow, or use
   **Move to another wallet**. The last action is signed by the member's passkey;
   Grove sponsors gas but cannot authorize the transfer.

This release does not describe an unpaid or unclaimed inventory token as buyer
property. A future delayed-claim product needs a dedicated, nonassignable
entitlement and allocation state machine before a buyer may pay without a
recovery-ready Safe. In particular, paid-unclaimed inventory must be removed from
commercial availability before the onchain delivery occurs. The current auction
schema deliberately requires the Safe before bidding and therefore is not a
claim-later implementation.

## Exit policy

`marketplace-transfer` is the only owner-exit action. It decodes to the
three-argument ERC-721 `safeTransferFrom(sourceSafe, recipient, tokenId)` selector
inside Safe's `executeUserOpWithErrorString`, with operation `CALL` and zero ETH.
The policy rejects `transferFrom`, the four-argument overload, delegatecall,
arbitrary targets, arbitrary token IDs, the zero address, the source Safe, and
known protocol/infrastructure addresses.

Preparation and submission recheck finalized ownership and collection bytecode,
`ownerOf`, exact-token approval, Seaport operator approval, and every unresolved
marketplace order. A seller must finalize cancellation and approval revocation
first. `eth_call` simulates the exact transfer, including ERC-721 receiver checks
when the destination is a contract.

The sponsorship decision is the durable pre-send outbox. Its immutable policy
binds the authenticated Safe, collection, token, recipient, chain, exact calldata,
gas ceiling, validity window, and UserOperation commitment. The database permits
only one approved/submitted token-changing action per token and serializes new
listing publication against owner-exit reservation. Provider acceptance is not ownership:
completion requires a canonical finalized EntryPoint `UserOperationEvent` with
success and the exact ERC-721 `Transfer(sourceSafe, recipient, tokenId)`. The
ownership projection changes only from finalized chain evidence.

Inactive or suspended members retain the owner-exit action. If sponsorship is
unavailable, the member-controlled Safe remains usable through a compatible
self-funded client; Grove cannot freeze the asset by withholding gas.

## Release gates

`GROVE_OWNER_EXIT_ENABLED` is separate from secondary-market entry. The code also
keeps `ownerExitReady` and the shared `sponsorExecutionReady` attestations false.
Turning the submission switch off disables new broadcasts and rebroadcasts but
does not disable canonical receipt reads or finalization of already-submitted
operations; the reconciliation provider tuple must remain configured until all
submitted exits are terminal.
Do not change either readiness constant until all of the following are recorded:

- a dedicated Sepolia transfer from a delivered member Safe to a controlled test
  address, including passkey signing, bundler/paymaster handling, durable replay,
  exact receipt validation, finalized indexing, and reorg/error drills;
- complete Safe owner/module/guard enumeration and an independently controlled
  recovery credential plus a recovery/rotation drill;
- destination screening and control-proof policy for mainnet;
- reviewed per-operation, per-user, and global paymaster budgets and alerts;
- written Stripe approval for the exact primary NFT auction and delayed delivery
  model, and applicable Apple/PSP acceptance;
- counsel's written analysis of custody, virtual-currency, sanctions, tax,
  abandoned-property, chargeback, and buyer-remedy obligations.

Stripe treats NFT use cases as restricted or prohibited depending on the exact
flow, so no environment flag substitutes for written approval. Apple Pay is
supported by hosted Checkout in eligible configurations, but it remains a card
payment, never a wallet balance or token-transfer mechanism.

Authoritative references:

- [ERC-721 safe transfer semantics](https://eips.ethereum.org/EIPS/eip-721)
- [ERC-4337 account abstraction and paymasters](https://eips.ethereum.org/EIPS/eip-4337)
- [Safe passkey overview](https://docs.safe.global/advanced/passkeys/overview)
- [Safe smart-account architecture](https://docs.safe.global/advanced/smart-account-overview)
- [Stripe Apple Pay](https://docs.stripe.com/apple-pay)
- [Stripe prohibited and restricted businesses](https://stripe.com/legal/restricted-businesses)
- [Apple Pay acceptable-use guidelines](https://developer.apple.com/apple-pay/acceptable-use-guidelines-for-websites/)
- [NYDFS virtual-currency business licensing](https://www.dfs.ny.gov/apps_and_licensing/virtual_currency_businesses)

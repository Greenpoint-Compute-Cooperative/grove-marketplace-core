# Grove collection contracts

These are **Sepolia candidates**, not audited production deployments.

- `Grove721`: immutable work identity and one-of-one issuance to a dedicated inventory Safe.
- `Grove1155`: immutable work identity, hard edition cap, and full-cap issuance to the inventory Safe.

Both use OpenZeppelin 5.6.1 and deliberately exclude checkout, auctions, buyer-fund escrow, upgradeable proxies, forced
transfers, transfer pausing, and royalty-enforcement claims. Each complete `ipfs://` token URI is stored exactly as
configured. `workId` is a PII-free canonical binding and `issuanceId` is domain-bound and replay protected. Auctions open
only after the mint is finalized and the inventory owner/balance is reconciled.

ERC-2981 is advisory royalty information. It neither restricts operators nor proves or enforces a secondary royalty.
Standard collector transfers remain live even when new issuance is paused.

## Secondary-market compatibility

The only authorized secondary staging lane is direct Seaport execution on Sepolia. OpenSea ended all testnet support
on July 23, 2025, so a Sepolia deployment must not advertise an OpenSea collection/item URL or rely on OpenSea indexing
or metadata refresh. [OpenSea: Farewell,
Testnets](https://support.opensea.io/en/articles/11833955-farewell-testnets)

The first secondary-sales release is fixed-price `Grove721` for allowlisted USDC. `Grove1155`, ETH/WETH settlement,
offers, auctions, bundles, criteria orders, cross-chain fills, Stripe, and Apple Pay remain outside that release. The
ERC-721 approval and transfer surface is intentionally standard so a pinned Seaport deployment can settle a valid
order. Grove contracts do not contain marketplace custody, card settlement, an operator filter, or creator-fee
enforcement.

Production OpenSea integration requires a new exact audited Ethereum-mainnet deployment and minted token, durable IPFS
availability for collection/token metadata and media, and a server-side OpenSea API key. Contract-level metadata uses
`contractURI` as described by ERC-7572; token metadata uses `tokenURI` or `uri`. [OpenSea contract-level
metadata](https://docs.opensea.io/docs/contract-level-metadata) · [OpenSea metadata
standards](https://docs.opensea.io/docs/metadata-standards)

See [`docs/SECONDARY_MARKET.md`](../docs/SECONDARY_MARKET.md) for the order and release invariants.

## Verify locally

```sh
git submodule update --init --recursive
npm ci
npm run contracts:test
```

## Testnet deployment candidate

Use a fresh low-balance deployer. `GROVE_ADMIN_SAFE` and `GROVE_INVENTORY_SAFE` must be separate reviewed 2-of-3 Safes.
The script pins their Safe proxy and singleton by manifest address, runtime code hash, and version. Registrar, minter, and
pause guardian must be distinct from both Safes and each other; the deployer receives no role.

```sh
export ETHEREUM_SEPOLIA_RPC_URL='...'
export DEPLOYER_PRIVATE_KEY='...'
export GROVE_ADMIN_SAFE='0x...'
export GROVE_REGISTRAR='0x...'
export GROVE_MINTER='0x...'
export GROVE_PAUSE_GUARDIAN='0x...'
export GROVE_INVENTORY_SAFE='0x...'
export GROVE_EXPECTED_CHAIN_ID='11155111'
export GROVE_SAFE_SINGLETON='0x...'
export GROVE_SAFE_PROXY_CODE_HASH='0x...'
export GROVE_SAFE_SINGLETON_CODE_HASH='0x...'
export GROVE_SAFE_VERSION='1.4.1'
export GROVE_SAFE_FALLBACK_HANDLER='0x...'
export GROVE_SAFE_FALLBACK_HANDLER_CODE_HASH='0x...'
export GROVE_COLLECTION_METADATA_URI='ipfs://...'

forge script contracts/script/Deploy.s.sol:Deploy \
  --root contracts \
  --rpc-url "$ETHEREUM_SEPOLIA_RPC_URL" \
  --broadcast \
  --verify
```

Never put the private key, Safe addresses, transaction artifacts, or RPC credentials in Git. Mainnet deployment requires
the exact release commit to pass fuzz/invariant/static analysis, Sepolia rehearsal, independent audit, reproducible
bytecode verification, and documented role handoff.

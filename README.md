# Grove marketplace core

MIT-licensed source from Greenpoint Compute Cooperative for the Marketplace & Auction House of Brooklyn. This is a reference implementation and testnet candidate, **not an audited or enabled mainnet marketplace**.

Includes the storefront, server APIs, Postgres migrations/RLS, OpenZeppelin NFT contracts, passkey/Safe intent code, card-auction ledger, Seaport resale/indexing, responsive media, aggregate statistics, and consent-based Instagram intake.

## Run locally

Use Node 24 and Foundry. Clone with submodules (or run `git submodule update --init --recursive`), then:

```sh
npm ci
npm run ci
npm run dev
```

`npm run dev` serves a static preview; it is not a mock claim of successful payment, login, mint, or transfer. Server routes require separately provisioned providers and a Vercel-compatible runtime. See `.env.example` and [Stripe rehearsal](docs/STRIPE_LAUNCH.md). Keep secrets in ignored files or a secret manager.

Run the database security suite against a **fresh disposable database** with `DATABASE_URL=postgresql://... ./scripts/test-commerce-sql.sh`. Never use production or a database with valuable data.

## Public/private boundary

This repository intentionally starts with new history. It has example-only hostnames, original SVG demo placeholders, no deployment inventory, no personal account files, no signing keys, no database rows, no operator reports, and no production workflows. The sample catalog is fictional; it is not sellable inventory. Product naming does not grant artwork or trademark rights.

Do not attach production GitHub/Vercel integrations or secrets to this repository. Deployment configuration, approved release manifests, credentials, schedules, backups and incident evidence belong in a separate **private** operations repository. The reference `vercel.json` includes security/image rules but no active cron schedule; substitute your reviewed hosts consistently before deployment. The synthetic auth fixtures are isolated examples, never a production login mechanism.

## Release limitations

Adding a Stripe key does not complete launch. Provider approval, tax configuration, social OAuth, recovery, gas sponsorship, independently reviewed contracts, and a completed payment-to-finalized-NFT rehearsal remain required. Inventory release requires the authorized Safe quorum. Mainnet, sponsored exits and other unverified paths stay fail-closed. [Security](SECURITY.md) · [Architecture](docs/ARCHITECTURE.md) · [Commerce invariants](docs/COMMERCE_RUNBOOK.md).

## Licensing and provenance

Code and newly authored SVG placeholders are MIT licensed unless a file or third-party notice states otherwise. No source artwork, screenshots, GLB model, private Git history or operator export is included. Dependency licenses are preserved in `third_party_licenses/`; builds generate complete bundled notices. `PUBLIC_FILES.sha256.json` records the release snapshot and `PUBLIC_SUBMODULES.json` pins the public Foundry test dependency. These are checksums, not a security certification.

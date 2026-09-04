# Media, indexing, statistics, and Instagram integration

Status: staging implementation candidate, 2026-09-04.

This is the merged delivery plan for fast artwork media, Ethereum indexing,
public marketplace statistics, and the Instagram bot. These systems share read
models, but none of them becomes payment, auction, token, or ownership authority.

## Shipped boundary

### Responsive artwork media

- The static storefront uses Vercel's native Image Optimization API through one
  `responsiveImage()` renderer. Cards request bounded 256–750px variants; detail
  and hero views request bounded 640–1536px variants.
- Markup includes `srcset`, `sizes`, intrinsic dimensions when known,
  `decoding="async"`, lazy card loading, and eager/high-priority treatment only
  for the active hero or work detail.
- Vercel may return AVIF or WebP. Widths and qualities are finite, SVG processing
  is disabled, and transformed objects have a 31-day minimum cache lifetime.
- Local repository assets are allowed. Remote transformation is limited to the
  exact staging and Production Supabase Storage hosts and a content-addressed
  `marketplace-media/sha256/<digest>/...` path. Arbitrary catalog/social HTTPS
  URLs never enter the optimizer.
- The new `media_assets` registry records SHA-256, dimensions, MIME, byte size,
  storage path, optional canonical IPFS URI, rights, moderation, and publication
  state. Publication requires cleared rights and approved moderation. The bucket
  rejects SVG/HTML and files over 25 MB; the record rejects images over 50 MP.
- OAuth avatars and Instagram media are not hotlinked. Until they pass the same
  managed-media pipeline, the storefront uses the local mark or editorial crop.

Mainnet NFT metadata remains a separate release gate: token metadata and original
media must use immutable, content-addressed `ipfs://` URIs. The HTTP display URL
is only a cached presentation derivative; it is never the token's canonical URI.

### Ethereum ownership index and public statistics

The existing `resale-finalized-v2` worker remains the read-model indexer. It:

- reads only a finalized Ethereum head;
- checks collection, Seaport 1.6, and USDC runtime hashes;
- stores append-only block/hash checkpoints and event evidence;
- reconciles ERC-721 ownership, Grove Seaport fills, cancellations, expiry, and
  seller counter invalidation;
- stops on finalized-hash or parent discontinuity.

The secondary action switch and the reconciliation switch are now independent.
`GROVE_SECONDARY_ENABLED=false` stops new listing/fill contexts but does not stop
canonical reconciliation for already-signed orders or owner exits.

Every run writes a private `indexer_worker_runs` record. A caught-up successful
run atomically refreshes `market_stats_current`. `GET /api/market-stats` publishes
only a fresh, complete snapshot and otherwise returns `status: "syncing"` with
`stats: null`. A ready v1 snapshot contains:

- published works and registered minted ERC-721 works;
- finalized indexed tokens and holder-address count excluding inventory Safes;
- open auctions, finalized-delivery primary sale count, and hammer amount grouped
  by native currency;
- ownership-confirmed, unexpired open resale listings and lowest USDC ask;
- finalized resale count and USDC amount.

Amounts stay as integer strings in their native base units. USD, USDC, and WETH
are never blended; transfers are never called sales; wallet addresses are never
called people; and no social-to-wallet association enters this public surface.
The browser shows the aggregate strip only for a fresh `ready` response.

The first activation must either start indexing at or before every tracked mint
or add a finalized `ownerOf` bootstrap snapshot. Until registered and projected
ERC-721 counts agree, the public feed remains `syncing`. The current worker is
deliberately limited to the Grove ERC-721 catalog and Grove-known Seaport orders;
it does not claim collection-wide OpenSea volume or ERC-1155 holder coverage.

### Instagram bot seam

Social login remains basic identity/session consent. Bot/inbox permissions use a
separate Meta consent, separate staging/Production apps and credentials, and the
independent `GROVE_INSTAGRAM_BOT_ENABLED` gate.

`GET/POST /api/webhooks/instagram` now provides the disabled-by-default inbound
boundary:

1. Meta verifies the endpoint with a constant-time comparison of a server-only
   verification token.
2. POST verifies `X-Hub-Signature-256` over the exact raw request body.
3. A batch is bounded to 1 MB, 1,000 events, and 32 KB per provider unit.
4. Events are normalized, hashed, and idempotently stored in the private
   `social_event_inbox` by provider/environment/event ID before acknowledgment.
5. Only an explicit `save https://…` message retains its normalized URL.
   Non-command private message text is discarded before persistence.
6. A future leased worker resolves the explicitly paired sender from
   `social_sender_links`, creates a private discovery, and records immutable
   provenance in `discovery_sources`.
7. Every bot discovery begins with `rights_status = unverified`; no media may be
   copied, published, listed, or minted before human rights review.

The bot may acknowledge a discovery and return an authenticated marketplace deep
link. It may later read the same public finality-gated stats snapshot for commands
such as current bid or lowest ask. It may never bid, sign, create or recover a
Safe, initiate payment, mint, list, transfer, or associate a mutable handle with
a wallet. There is no scraping, hashtag crawling, cold DM, or headless Instagram
session.

## Next implementation gates

1. Build the controlled upload/Graph-media worker: MIME magic validation, pixel
   and byte caps, EXIF stripping, content hash, duplicate detection, quarantine,
   managed storage upload, and derivative/placeholder generation.
2. Replace mutable Sepolia metadata media with immutable IPFS fixtures and test
   CID-verified retrieval; mainnet stays blocked until the permanence rehearsal.
3. Persist the indexer's observed finalized-head lag and implement explicit
   finalized ownership bootstrap if the configured start block is after a mint.
4. Move the staging scheduler workflow onto the default branch and install its
   matching cron secret. Custom Vercel staging targets do not run Vercel Cron.
5. Connect live discoveries and persisted save/sponsor state to the UI before
   enabling the Meta endpoint.
6. Complete Meta App Review, Business Verification, webhook subscription, token
   refresh/revocation, retry/dead-letter processing, and human escalation.
7. Add real `/work/:slug` server-rendered share pages with 1200×630 social cards;
   hash routes cannot produce work-specific Instagram/Open Graph previews.
8. Add daily immutable stats rollups and data-quality findings only after the
   current snapshot proves complete in staging.

Ponder remains an optional open-source replacement read model when the catalog
or external-market coverage outgrows bounded RPC scans. It is unnecessary for
the initial Grove collection and must never become commerce authority.

## Release verification

- Unit/static checks reject broad optimizer sources, invalid Meta signatures,
  oversized social events, stale stats, and reconciliation/kill-switch coupling.
- Staging checks fetch a 640px AVIF/WebP artwork under the mobile transfer budget,
  require the stats endpoint to report `ready` or honest `syncing`, and require
  the unconfigured Instagram endpoint to fail closed.
- Production uses independent Supabase, Meta, Stripe, RPC, and signing resources.
  No staging social event, media object, chain block, or aggregate crosses the
  environment boundary.

References: [Vercel Image Optimization](https://vercel.com/docs/image-optimization),
[Vercel image configuration](https://vercel.com/docs/project-configuration/vercel-json#images),
[IPFS NFT data guidance](https://docs.ipfs.tech/how-to/best-practices-for-nft-data/),
[Meta Instagram webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks),
[Instagram API with Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login),
and [Meta Platform Terms](https://developers.facebook.com/terms/).

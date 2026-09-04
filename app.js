import {
  bazaar,
  curators,
  discoveries,
  exhibitions,
  getCurator,
  getExhibition,
  getWork,
  works,
  worksForCurator
} from "./catalog.js";
import { track, trackClientErrors } from "./analytics.js";

const BRAND_NAME = "Marketplace & Auction House of Brooklyn";
const app = document.querySelector("#app");
const collectDialog = document.querySelector("#collect-dialog");
const collectContent = document.querySelector("#collect-content");
const transferDialog = document.querySelector("#transfer-dialog");
const transferForm = document.querySelector("#transfer-form");
const transferSummary = document.querySelector("#transfer-summary");
const toast = document.querySelector("#toast");

const discoveryState = new Map(discoveries.map((item) => [item.id, item.status]));
let discoveryFilter = "new";
let marketFilter = "all";
let selectedDiscovery = null;
let draftLink = "";
let toastTimer;
let authConfiguration;
let authConfigurationRequest;
let marketplaceStats;
let checkoutReturnHandled = false;
let recoveryWalletAddress = "";

const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const route = () => {
  const clean = (location.hash || "#home").slice(1).replace(/^\/+|\/+$/g, "");
  return clean ? clean.split("/") : ["home"];
};

const routeName = () => {
  const name = route().join("/").toLowerCase();
  return /^[a-z0-9][a-z0-9/_-]{0,119}$/.test(name) ? name : "not-found";
};

const showToast = (message) => {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
};

const safeMediaUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, location.origin);
    const sameOriginHttp = url.origin === location.origin && ["http:", "https:"].includes(url.protocol);
    return url.protocol === "https:" || sameOriginHttp ? url.href : "";
  } catch {
    return "";
  }
};

const IMAGE_WIDTHS = Object.freeze([64, 128, 256, 384, 640, 750, 828, 1080, 1200, 1536]);
const OPTIMIZED_MEDIA_HOSTS = new Set([
  "examplepreviewrefxxxx.supabase.co",
  "exampleprodrefxxxxxxx.supabase.co"
]);
const LEGACY_ASSET_HOSTS = new Set([
  "marketplace.invalid",
  "staging.marketplace.invalid"
]);
const LOCAL_ASSET_PATTERN = /^\/public\/assets\/[a-z0-9][a-z0-9._/-]*\.(?:avif|jpe?g|png|webp)$/i;
const STORAGE_ASSET_PATTERN = /^\/storage\/v1\/object\/public\/marketplace-media\/sha256\/[0-9a-f]{64}\/[a-z0-9][a-z0-9._/-]*\.(?:avif|jpe?g|png|webp)$/i;
const LOCAL_MEDIA_DIMENSIONS = Object.freeze({
  "/public/assets/celestial-school.svg": [1717, 916],
  "/public/assets/digital-works.svg": [1536, 1024],
  "/public/assets/physical-works.svg": [1536, 1024],
  "/public/assets/school-mark.svg": [620, 620],
  "/public/assets/school-seed.svg": [1254, 1254]
});

const managedMediaSource = (value) => {
  const safe = safeMediaUrl(value);
  if (!safe) return "";
  try {
    const url = new URL(safe);
    if (!url.search && !url.hash && LOCAL_ASSET_PATTERN.test(url.pathname)
      && (url.origin === location.origin || LEGACY_ASSET_HOSTS.has(url.hostname))) return url.pathname;
    if (!url.search && !url.hash && url.protocol === "https:"
      && OPTIMIZED_MEDIA_HOSTS.has(url.hostname) && STORAGE_ASSET_PATTERN.test(url.pathname)) return url.href;
  } catch {
    return "";
  }
  return "";
};

const imageOptimizerAvailable = () => location.protocol === "https:"
  && !["localhost", "127.0.0.1"].includes(location.hostname);

const optimizedImageUrl = (source, width, quality) => source.endsWith(".svg") ? source : `/_vercel/image?url=${encodeURIComponent(source)}&w=${width}&q=${quality}`;

const responsiveImage = ({
  src,
  alt,
  className = "",
  widths = IMAGE_WIDTHS,
  sizes = "100vw",
  quality = 75,
  priority = false,
  width,
  height
}) => {
  const safe = safeMediaUrl(src);
  if (!safe) return "";
  const managed = managedMediaSource(safe);
  const canOptimize = Boolean(managed && imageOptimizerAvailable());
  const intrinsic = managed?.startsWith("/") ? LOCAL_MEDIA_DIMENSIONS[managed] : null;
  const intrinsicWidth = Number(width) > 0 ? Number(width) : intrinsic?.[0];
  const intrinsicHeight = Number(height) > 0 ? Number(height) : intrinsic?.[1];
  const maximumWidth = intrinsicWidth || IMAGE_WIDTHS.at(-1);
  const candidates = widths.filter((candidate) => IMAGE_WIDTHS.includes(candidate) && candidate <= maximumWidth);
  const selectedWidths = candidates.length ? candidates : [Math.min(maximumWidth, IMAGE_WIDTHS.at(-1))];
  const fallbackWidth = selectedWidths.at(-1);
  const source = managed || safe;
  const imageSrc = canOptimize ? optimizedImageUrl(source, fallbackWidth, quality) : source;
  const srcset = canOptimize
    ? ` srcset="${selectedWidths.map((candidate) => `${escapeHtml(optimizedImageUrl(source, candidate, quality))} ${candidate}w`).join(", ")}" sizes="${escapeHtml(sizes)}"`
    : "";
  const dimensions = intrinsicWidth && intrinsicHeight
    ? ` width="${Math.round(intrinsicWidth)}" height="${Math.round(intrinsicHeight)}"`
    : "";
  return `<img class="${escapeHtml(className)}" src="${escapeHtml(imageSrc)}"${srcset}${dimensions} alt="${escapeHtml(alt)}" loading="${priority ? "eager" : "lazy"}" decoding="async" fetchpriority="${priority ? "high" : "auto"}" referrerpolicy="no-referrer">`;
};

const safeDocumentUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, location.origin);
    return ["https:", "ipfs:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
};

const visualStyle = (work, { detail = false } = {}) => {
  const sheet = work.sheet === "digital" ? "digital" : "physical";
  const source = `/public/assets/${sheet}-works.svg`;
  const rendered = imageOptimizerAvailable()
    ? optimizedImageUrl(source, detail ? 1536 : 750, detail ? 85 : 75)
    : source;
  return `--art:url('${rendered}');--x:${work.x};--y:${work.y}`;
};

const art = (work, className = "", { priority = false, detail = false } = {}) => {
  const mediaUrl = managedMediaSource(work.mediaUrl);
  if (mediaUrl) return responsiveImage({
    src: mediaUrl,
    alt: work.alt,
    className: `art art--live ${className}`.trim(),
    widths: detail ? [640, 750, 828, 1080, 1200, 1536] : [256, 384, 640, 750],
    sizes: detail ? "(max-width: 760px) 100vw, 66vw" : "(max-width: 760px) 100vw, (max-width: 1080px) 50vw, 33vw",
    quality: detail ? 85 : 75,
    priority,
    width: work.mediaWidth,
    height: work.mediaHeight
  });
  return `<div class="art ${className}" style="${visualStyle(work, { detail })}" role="img" aria-label="${escapeHtml(work.alt)}"></div>`;
};

const typeLabel = (type) => ({ physical: "Physical", digital: "Digital", paired: "Physical + NFT" }[type]);

const money = (amountMinor, currency) => {
  if (!Number.isSafeInteger(amountMinor) || !currency) return "Price on request";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
  } catch {
    return `${amountMinor} ${currency}`;
  }
};

const auctionMoney = (auction) => {
  const amount = auction.current_bid_amount || auction.reserve_amount;
  if (auction.bid_currency === "USD") return money(Number(amount), "USD");
  return `${amount} ${auction.bid_currency} base units`;
};

const usdcMoney = (amount) => {
  try {
    const units = BigInt(String(amount));
    const whole = units / 1_000_000n;
    const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} USDC`;
  } catch {
    return "USDC price unavailable";
  }
};

const tokenLinks = (chainId, contractAddress, tokenId, minted, openSeaEnabled = false) => {
  if (!minted || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress || "")
    || !/^(0|[1-9][0-9]{0,77})$/.test(String(tokenId ?? ""))) return {};
  const chain = Number(chainId);
  return {
    explorerUrl: chain === 1
      ? `https://etherscan.io/nft/${contractAddress}/${tokenId}`
      : chain === 11155111 ? `https://sepolia.etherscan.io/nft/${contractAddress}/${tokenId}` : "",
    openSeaUrl: chain === 1 && openSeaEnabled
      ? `https://opensea.io/assets/ethereum/${contractAddress}/${tokenId}`
      : ""
  };
};

const apiWork = (work, index, auction, resale, managedResale, ownedAsset) => ({
  slug: work.slug,
  title: work.title,
  artist: work.artist_name,
  year: work.listed_at?.slice(0, 4) || "",
  type: work.format,
  typeLabel: typeLabel(work.format),
  medium: work.format === "digital" ? "Born-digital artwork" : work.format === "paired" ? "Physical work with digital edition" : "Physical artwork",
  dimensions: "See work details",
  location: work.location || "Fulfillment details at checkout",
  id: work.id,
  price: resale ? usdcMoney(resale.gross_amount) : auction
    ? auctionMoney(auction)
    : money(work.price_minor, work.currency),
  cryptoPrice: work.crypto_amount && work.crypto_asset ? `${work.crypto_amount} ${work.crypto_asset}` : "",
  availability: resale ? "Secondary listing open" : auction ? ({ open: "Bidding open", scheduled: "Scheduled", "winner-selected": "Ended", settled: "Settled", "no-sale": "No sale" }[auction.state] || "Auction closed")
    : work.status === "sold" ? "Sold" : work.status === "reserved" ? "Reserved" : work.inventory_available > 0 ? "Available" : "Unavailable",
  status: work.status,
  edition: work.format === "physical" ? "Physical work" : "Edition details in work record",
  chain: Number(resale?.chain_id || auction?.chain_id) === 1 ? "Ethereum mainnet"
    : Number(resale?.chain_id || auction?.chain_id) === 11155111 ? "Ethereum Sepolia" : work.chain,
  chainId: Number(resale?.chain_id || auction?.chain_id || (work.chain === "ethereum-sepolia" ? 11155111 : work.chain === "ethereum" ? 1 : 0)),
  tokenStandard: auction?.nft_standard || null,
  contractStatus: work.contract_status,
  contractAddress: resale?.collection_address || work.contract_address,
  tokenId: resale?.token_id || work.token_id,
  curatorId: work.curator_id || "grove-marketplace",
  collection: "Live catalog",
  sheet: work.format === "physical" ? "physical" : "digital",
  x: index % 3,
  y: index % 2,
  alt: `${work.title} by ${work.artist_name}`,
  description: work.description || "Full details are available from the marketplace team.",
  artistBio: "",
  curatorNote: "",
  rights: "Review the linked buyer terms and license before purchase.",
  fulfillment: work.requires_shipping ? "Shipping address and tax are collected in secure checkout." : "Delivery details are confirmed after payment.",
  featured: false,
  mediaUrl: work.media_url,
  mediaWidth: work.media_width,
  mediaHeight: work.media_height,
  termsUrl: auction?.terms_url || work.buyer_terms_url,
  licenseUrl: work.license_uri,
  saleEnabled: work.checkout_ready === true,
  auctionId: auction?.id || null,
  auctionState: auction?.state || null,
  auctionRail: auction?.settlement_rail || null,
  auctionCurrency: auction?.bid_currency || null,
  auctionClosesAt: auction?.closes_at || null,
  auctionMinimumIncrement: auction ? Number(auction.minimum_increment) : null,
  auctionEnabled: auction?.state === "open",
  resaleId: resale?.id || null,
  resaleEnabled: resale?.state === "open",
  resaleSellerManaged: Boolean(managedResale) || resale?.seller_managed === true,
  resaleManagedId: managedResale?.id || (resale?.seller_managed === true ? resale.id : null),
  resaleProtocol: resale ? "Seaport 1.6" : null,
  resaleCurrency: resale?.currency || null,
  ownedByCurrentUser: Boolean(ownedAsset),
  ownerAddress: ownedAsset?.owner_address || null,
  ...tokenLinks(
    Number(resale?.chain_id || auction?.chain_id || (work.chain === "ethereum-sepolia" ? 11155111 : work.chain === "ethereum" ? 1 : 0)),
    resale?.collection_address || work.contract_address,
    resale?.token_id || work.token_id,
    work.contract_status === "minted",
    authConfiguration?.openSea?.configured === true
  )
});

const hydrateLiveCatalog = async () => {
  try {
    const [response, resalesResponse, configurationResponse, walletAssetsResponse, marketStatsResponse] = await Promise.all([
      fetch("/api/catalog", { headers: { Accept: "application/json" } }),
      fetch("/api/resales", { headers: { Accept: "application/json" } }),
      fetch("/api/config", { headers: { Accept: "application/json" } }),
      fetch("/api/wallet/assets", { headers: { Accept: "application/json" } }),
      fetch("/api/market-stats", { headers: { Accept: "application/json" } })
    ]);
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return;
    const catalog = await response.json();
    if (!Array.isArray(catalog.works)) return;
    const resales = resalesResponse.ok && resalesResponse.headers.get("content-type")?.includes("application/json")
      ? await resalesResponse.json() : { orders: [] };
    const walletAssets = walletAssetsResponse.ok && walletAssetsResponse.headers.get("content-type")?.includes("application/json")
      ? await walletAssetsResponse.json() : { assets: [] };
    if (configurationResponse.ok && configurationResponse.headers.get("content-type")?.includes("application/json")) {
      authConfiguration = await configurationResponse.json();
      authConfigurationRequest = Promise.resolve(authConfiguration);
    }
    if (marketStatsResponse.ok && marketStatsResponse.headers.get("content-type")?.includes("application/json")) {
      const nextStats = await marketStatsResponse.json();
      marketplaceStats = nextStats.status === "ready" ? nextStats : null;
    }

    const liveCurators = (Array.isArray(catalog.curators) ? catalog.curators : []).map((curator) => {
      const initials = curator.display_name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      return { id: curator.id, name: curator.display_name, initials: initials || "C", role: curator.focus || "Curator", city: "", bio: curator.bio || "", thesis: "", accent: "cobalt", rooms: [], joined: curator.created_at?.slice(0, 4) || "" };
    });
    liveCurators.push({ id: "grove-marketplace", name: "The School", initials: "TS", role: "Marketplace", city: "Brooklyn, NY", bio: "", thesis: "", accent: "cobalt", rooms: [], joined: "" });
    curators.splice(0, curators.length, ...liveCurators);

    const auctionsByWork = new Map((Array.isArray(catalog.auctions) ? catalog.auctions : []).map((auction) => [auction.work_id, auction]));
    const resalesByWork = new Map((Array.isArray(resales.orders) ? resales.orders : []).filter((order) => order.state === "open")
      .map((order) => [order.work_id, order]));
    const managedResalesByWork = new Map();
    for (const order of Array.isArray(resales.managed_orders) ? resales.managed_orders : []) {
      if (!managedResalesByWork.has(order.work_id)) managedResalesByWork.set(order.work_id, order);
    }
    const ownedAssetsByWork = new Map((Array.isArray(walletAssets.assets) ? walletAssets.assets : [])
      .map((asset) => [asset.work_id, asset]));
    const liveWorks = catalog.works.map((work, index) => apiWork(
      work, index, auctionsByWork.get(work.id), resalesByWork.get(work.id), managedResalesByWork.get(work.id),
      ownedAssetsByWork.get(work.id)
    ));
    const liveSlugs = new Set(liveWorks.map((work) => work.slug));
    works.splice(0, works.length, ...liveWorks);
    discoveries.splice(0, discoveries.length, ...discoveries.filter((item) => liveSlugs.has(item.workSlug)));
    const nextBazaar = Array.isArray(catalog.bazaars) ? catalog.bazaars[0] : null;
    if (nextBazaar) {
      const startsAt = new Date(nextBazaar.starts_at);
      const endsAt = new Date(nextBazaar.ends_at);
      Object.assign(bazaar, {
        available: true,
        slug: nextBazaar.slug,
        title: nextBazaar.title,
        startsAt: nextBazaar.starts_at,
        endsAt: nextBazaar.ends_at,
        dateLabel: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }).format(startsAt),
        timeLabel: `${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(startsAt)}–${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(endsAt)}`,
        venue: nextBazaar.venue,
        address: `${nextBazaar.address}, ${nextBazaar.city}`,
        description: nextBazaar.summary || "",
        schedule: []
      });
    } else {
      Object.assign(bazaar, {
        available: false,
        title: "Bazaar schedule",
        startsAt: null,
        endsAt: null,
        dateLabel: "To be announced",
        timeLabel: "",
        description: "The next published bazaar will appear here.",
        schedule: []
      });
    }
    render();
  } catch {
    // The bundled editorial catalog is an intentional read-only fallback.
  }
};

const curatorPill = (curator) => `
  <a class="curator-pill" href="${curator ? `#curator/${curator.id}` : "#market"}">
    <span>${escapeHtml(curator?.initials || "TS")}</span>${escapeHtml(curator?.name || "The School")}
  </a>
`;

const workTile = (work) => {
  const curator = getCurator(work.curatorId);
  return `
    <article class="work-tile">
      <a href="#work/${work.slug}" class="work-tile__main">
        <div class="work-tile__media">
          ${art(work)}
          <span class="tag">${typeLabel(work.type)}</span>
        </div>
        <div class="work-tile__line">
          <span><strong>${escapeHtml(work.title)}</strong><small>${escapeHtml(work.artist)}</small></span>
          <span class="tile-price">${escapeHtml(work.auctionId ? work.price : work.cryptoPrice || work.price)}</span>
        </div>
      </a>
      ${curatorPill(curator)}
    </article>
  `;
};

const discoveryItem = (item) => {
  const work = getWork(item.workSlug);
  const state = discoveryState.get(item.id);
  return `
    <article class="discovery-card" data-discovery-id="${item.id}">
      <a href="#work/${work.slug}" class="discovery-card__image">
        ${art(work)}
        <span class="source-chip">${escapeHtml(item.source)}</span>
      </a>
      <div class="discovery-card__meta">
        <span><strong>${escapeHtml(work.title)}</strong><small>${escapeHtml(work.artist)}</small></span>
        <span class="sent-by">${escapeHtml(item.from)} · ${escapeHtml(item.when)}</span>
      </div>
      <div class="discovery-card__actions">
        <button type="button" data-save-discovery="${item.id}" aria-pressed="${state === "saved"}">${state === "saved" ? "Saved" : "Save"}</button>
        <button class="sponsor-action" type="button" data-sponsor-discovery="${item.id}">${state === "sponsored" ? "Sponsored" : "Sponsor"}</button>
      </div>
    </article>
  `;
};

const visibleDiscoveries = () => discoveries.filter((item) => discoveryState.get(item.id) === discoveryFilter);

const discoveryFilters = () => ["new", "saved", "sponsored"].map((state) => {
  const count = discoveries.filter((item) => discoveryState.get(item.id) === state).length;
  return `<button type="button" data-discovery-filter="${state}" aria-pressed="${discoveryFilter === state}">${state[0].toUpperCase() + state.slice(1)} <span>${count}</span></button>`;
}).join("");

const marketplaceStatsStrip = () => {
  const stats = marketplaceStats?.stats;
  if (!stats) return "";
  const values = [
    [stats.catalog?.published_works, "Published works"],
    [stats.catalog?.minted_erc721_works, "Minted ERC-721 works"],
    [stats.auctions?.open, "Auctions open"],
    [(stats.auctions?.finalized_sales || 0) + (stats.secondary?.finalized_sales || 0), "Finalized sales"]
  ].filter(([value]) => Number.isSafeInteger(value) && value >= 0);
  if (!values.length) return "";
  return `
    <section class="market-stats" aria-label="Finalized marketplace statistics">
      <span class="market-stats__network">${marketplaceStats.network === "ethereum-sepolia" ? "Sepolia rehearsal" : "Ethereum mainnet"} · finalized data</span>
      <div>${values.map(([value, label]) => `<span><strong>${value.toLocaleString("en-US")}</strong><small>${label}</small></span>`).join("")}</div>
    </section>
  `;
};

const home = () => {
  const featuredDiscoveries = discoveries.slice(0, 3);
  const saleReadyWorks = works.filter((work) => work.saleEnabled || work.auctionEnabled).slice(0, 3);
  const featuredWorks = saleReadyWorks.length
    ? saleReadyWorks
    : works.slice(0, 3);
  const bazaarDate = new Date(bazaar.startsAt || bazaar.date);
  const bazaarDay = Number.isNaN(bazaarDate.getTime()) ? "—" : new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "America/New_York" }).format(bazaarDate);
  const bazaarMonth = Number.isNaN(bazaarDate.getTime()) ? "TBD" : new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "America/New_York" }).format(bazaarDate).toUpperCase();
  return `
    <div class="page home-page">
      <section class="hero" aria-label="${BRAND_NAME}">
        ${responsiveImage({
          src: "public/assets/school-seed.svg",
          alt: "A glowing ornate school floating in pale-blue clouds",
          className: "hero__seed",
          widths: [640, 750, 828, 1080, 1200],
          sizes: "(max-width: 760px) calc(100vw - 24px), min(100vw - 36px, 1480px)",
          quality: 85,
          priority: true
        })}
        <div class="hero__copy">
          <a class="button button--light" href="#discover">Open discoveries</a>
        </div>
      </section>

      ${marketplaceStatsStrip()}

      <section class="section" aria-labelledby="home-discoveries-title">
        <div class="section-head">
          <h2 id="home-discoveries-title">Discoveries</h2>
          <a href="#discover">View inbox →</a>
        </div>
        <div class="discovery-grid discovery-grid--home" id="home-discovery-grid">
          ${featuredDiscoveries.map(discoveryItem).join("")}
        </div>
      </section>

      <section class="section" aria-labelledby="home-market-title">
        <div class="section-head">
          <h2 id="home-market-title">At 29 Nassau</h2>
          <a href="#market">View marketplace →</a>
        </div>
        <div class="work-grid">${featuredWorks.map(workTile).join("")}</div>
      </section>

      ${bazaar.available === false ? "" : `<section class="bazaar-card" aria-labelledby="home-bazaar-title">
        <div class="bazaar-card__date"><strong>${escapeHtml(bazaarDay)}</strong><span>${escapeHtml(bazaarMonth)}</span></div>
        <div><h2 id="home-bazaar-title">${escapeHtml(bazaar.title)}</h2></div>
        <a class="round-arrow" href="#bazaar" aria-label="Open bazaar">→</a>
      </section>`}
    </div>
  `;
};

const discoverPage = () => {
  const items = visibleDiscoveries();
  return `
    <div class="page">
      <header class="page-title">
        <h1>Discoveries</h1>
        <a class="button button--dark" href="#join">Join as curator</a>
      </header>

      <form class="link-capture" id="link-capture">
        <img src="public/assets/school-mark.svg" alt="" width="64" height="64">
        <label for="discovery-link">Add a public link</label>
        <input id="discovery-link" name="link" type="url" placeholder="https://" value="${escapeHtml(draftLink)}" required>
        <button type="submit">Start draft →</button>
        <small>No fetch in preview</small>
      </form>

      <div class="filter-bar" aria-label="Discovery status">${discoveryFilters()}</div>
      <section class="discovery-grid" id="discovery-grid" aria-live="polite">
        ${items.length ? items.map(discoveryItem).join("") : `<div class="empty"><strong>Nothing here yet.</strong><span>Save a discovery to move it here.</span></div>`}
      </section>
    </div>
  `;
};

const marketPage = (initial = "all") => {
  if (["all", "physical", "digital", "paired"].includes(initial)) marketFilter = initial;
  const filtered = marketFilter === "all" ? works : works.filter((work) => work.type === marketFilter);
  return `
    <div class="page">
      <header class="page-title page-title--simple">
        <h1>Works</h1>
      </header>
      <div class="filter-bar" aria-label="Work format">
        ${[["all", "All"], ["physical", "Physical"], ["digital", "Digital"], ["paired", "Paired"]].map(([value, label]) => `<button type="button" data-market-filter="${value}" aria-pressed="${marketFilter === value}">${label}</button>`).join("")}
      </div>
      <section class="work-grid" id="market-grid">${filtered.map(workTile).join("")}</section>
    </div>
  `;
};

const exhibitionPage = (exhibition) => {
  const curator = getCurator(exhibition.curatorId);
  const selected = exhibition.workSlugs.map(getWork).filter(Boolean);
  return `
    <div class="page">
      <a class="back-link" href="#market">← Marketplace</a>
      <header class="page-title">
        <h1>${escapeHtml(exhibition.title)}</h1>
        ${curatorPill(curator)}
      </header>
      <section class="work-grid">${selected.map(workTile).join("")}</section>
    </div>
  `;
};

const workPage = (work) => {
  const curator = getCurator(work.curatorId);
  const related = works.filter((item) => item.slug !== work.slug && (item.curatorId === work.curatorId || item.type === work.type)).slice(0, 3);
  const verb = work.resaleId ? "Buy with USDC" : work.auctionId ? "Place bid" : work.type === "digital" ? "Collect" : work.type === "paired" ? "Acquire pair" : "Buy work";
  const unavailable = work.resaleId ? !work.resaleEnabled : work.auctionId ? work.auctionState !== "open" : ["reserved", "sold"].includes(work.status);
  const closes = work.auctionClosesAt ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(work.auctionClosesAt)) : "";
  const secondaryConfigured = authConfiguration?.secondary?.configured === true;
  const ownerExitConfigured = authConfiguration?.wallet?.ownerExit?.configured === true;
  const resellableToken = secondaryConfigured && work.id && work.type === "digital" && work.contractStatus === "minted" && work.contractAddress && work.tokenId !== undefined;
  return `
    <div class="work-page">
      <a class="back-link work-page__back" href="#market">← Marketplace</a>
      <div class="work-view">
        <div class="work-view__art">${art(work, "", { priority: true, detail: true })}</div>
        <aside class="work-panel">
          <span class="tag tag--static">${typeLabel(work.type)}</span>
          <h1>${escapeHtml(work.title)}</h1>
          <span class="artist-name">${escapeHtml(work.artist)}, ${work.year}</span>
          ${curatorPill(curator)}
          <div class="work-price"><strong>${escapeHtml(work.price)}</strong><span>${escapeHtml(work.resaleId ? "USDC · gas-sponsored Safe · Seaport 1.6" : work.auctionId ? `${work.auctionRail === "card" ? "Apple Pay / card" : work.auctionRail} auction${closes ? ` · closes ${closes}` : ""}` : work.cryptoPrice ? `${work.price} card` : "Card / Apple Pay")}</span></div>
          ${unavailable
            ? `<p class="pending-note" role="status">${escapeHtml(work.availability)} · checkout is unavailable</p>`
            : work.resaleId
              ? `<button class="button button--blue" type="button" data-collect="${work.slug}" data-method="resale">${verb}</button>`
              : work.auctionId
              ? `<button class="button button--blue" type="button" data-collect="${work.slug}" data-method="${work.auctionRail}">${verb}</button>`
              : `<button class="button button--blue" type="button" data-collect="${work.slug}" data-method="crypto">${verb}</button>
          <button class="text-button" type="button" data-collect="${work.slug}" data-method="card">Use card</button>`}
          ${resellableToken && work.ownedByCurrentUser && !work.resaleId ? `<button class="text-button" type="button" data-start-resale="${work.slug}">Sell this NFT</button>` : ""}
          ${work.resaleId && work.resaleSellerManaged ? `<button class="text-button" type="button" data-cancel-resale="${work.slug}">Cancel my listing</button>` : ""}
          ${work.resaleManagedId && work.resaleSellerManaged ? `<button class="text-button" type="button" data-revoke-resale-approval="${work.slug}">Revoke Seaport approval</button>` : ""}
          ${ownerExitConfigured && work.ownedByCurrentUser && !work.resaleManagedId ? `<button class="text-button" type="button" data-transfer-nft="${work.slug}">Move to another wallet</button>` : ""}
          ${work.ownedByCurrentUser ? `<p class="pending-note">Held in your passkey Safe. The School cannot sign or transfer it without you.</p>` : ""}
          ${safeDocumentUrl(work.openSeaUrl) ? `<a class="text-button" href="${escapeHtml(safeDocumentUrl(work.openSeaUrl))}" target="_blank" rel="noopener">View on OpenSea ↗</a>` : ""}
          ${work.chainId === 11155111 && work.contractStatus === "minted" ? `<p class="pending-note">Sepolia rehearsal · OpenSea retired all testnet support.</p>` : ""}
          <details class="work-details">
            <summary>Details</summary>
            <dl>
              <div><dt>Medium</dt><dd>${escapeHtml(work.medium)}</dd></div>
              <div><dt>Edition</dt><dd>${escapeHtml(work.edition)}</dd></div>
              <div><dt>Location</dt><dd>${escapeHtml(work.location)}</dd></div>
              ${work.chain ? `<div><dt>Network</dt><dd>${escapeHtml(work.chain)}</dd></div>` : ""}
              ${safeDocumentUrl(work.explorerUrl) ? `<div><dt>NFT</dt><dd><a href="${escapeHtml(safeDocumentUrl(work.explorerUrl))}" target="_blank" rel="noopener">${escapeHtml(`${work.contractAddress.slice(0, 8)}… · #${work.tokenId}`)}</a></dd></div>` : ""}
              ${safeDocumentUrl(work.termsUrl) ? `<div><dt>Buyer terms</dt><dd><a href="${escapeHtml(safeDocumentUrl(work.termsUrl))}" target="_blank" rel="noopener">Review terms</a></dd></div>` : ""}
              ${safeDocumentUrl(work.licenseUrl) ? `<div><dt>License</dt><dd><a href="${escapeHtml(safeDocumentUrl(work.licenseUrl))}" target="_blank" rel="noopener">Review license</a></dd></div>` : ""}
            </dl>
          </details>
        </aside>
      </div>
      <section class="page section related" aria-labelledby="related-title">
        <div class="section-head"><h2 id="related-title">More works</h2></div>
        <div class="work-grid">${related.map(workTile).join("")}</div>
      </section>
    </div>
  `;
};

const curatorsPage = () => `
  <div class="page">
    <header class="page-title">
      <h1>Curators</h1>
      <a class="button button--dark" href="#join">Join as curator</a>
    </header>
    <section class="curator-grid">
      ${curators.map((curator) => {
        const count = worksForCurator(curator.id).length;
        return `<a class="curator-card" href="#curator/${curator.id}"><img src="public/assets/school-mark.svg" alt=""><span class="curator-card__initials">${escapeHtml(curator.initials)}</span><h2>${escapeHtml(curator.name)}</h2><small>${escapeHtml(curator.role.split(" · ")[0])}</small><strong>${count} works →</strong></a>`;
      }).join("")}
    </section>
  </div>
`;

const curatorPage = (curator) => {
  const selected = worksForCurator(curator.id);
  return `
    <div class="page">
      <a class="back-link" href="#curators">← Curators</a>
      <header class="curator-profile">
        <div class="curator-profile__mark"><img src="public/assets/school-mark.svg" alt=""><span>${escapeHtml(curator.initials)}</span></div>
        <div><span class="curator-role">${escapeHtml(curator.role.split(" · ")[0])}</span><h1>${escapeHtml(curator.name)}</h1><div class="action-row"><a class="button button--dark" href="#sponsor">Add a piece</a><a class="button button--soft" href="#discover">Discover</a></div></div>
      </header>
      <section class="section"><div class="section-head"><h2>Sponsored</h2><span>${selected.length}</span></div><div class="work-grid">${selected.map(workTile).join("")}</div></section>
    </div>
  `;
};

const sponsorPage = () => {
  const discovery = selectedDiscovery ? discoveries.find((item) => item.id === selectedDiscovery) : null;
  const work = discovery ? getWork(discovery.workSlug) : null;
  return `
    <div class="page form-page">
      <header class="page-title page-title--form">
        <h1>Add a piece</h1>
      </header>
      ${work ? `<div class="selected-discovery"><div>${art(work)}</div><span><small>From discoveries</small><strong>${escapeHtml(work.title)}</strong><i>${escapeHtml(work.artist)}</i></span></div>` : ""}
      <form class="minimal-form" id="piece-form">
        <label>Public link<input name="link" type="url" placeholder="https://" value="${escapeHtml(draftLink)}" required></label>
        <div class="form-pair">
          <label>Artist<input name="artist" value="${escapeHtml(work?.artist || "")}" required></label>
          <label>Work<input name="title" value="${escapeHtml(work?.title || "")}" required></label>
        </div>
        <div class="form-pair">
          <label>Format<select name="format" required><option value="">Choose</option><option ${work?.type === "physical" ? "selected" : ""}>Physical</option><option ${work?.type === "digital" ? "selected" : ""}>Digital / NFT</option><option ${work?.type === "paired" ? "selected" : ""}>Physical + NFT</option></select></label>
          <label>Sponsor<select name="curator" required><option value="">Choose</option>${curators.map((curator) => `<option>${escapeHtml(curator.name)}</option>`).join("")}</select></label>
        </div>
        <label>Why this work?<textarea name="note" rows="3"></textarea></label>
        <button class="button button--dark" type="submit">Review draft</button>
        <small class="form-note">Preview only · nothing is submitted</small>
        <div class="draft-result" id="piece-result" aria-live="polite"></div>
      </form>
    </div>
  `;
};

const providerState = (provider) => authConfiguration?.providers?.[provider]?.configured ? "Available" : authConfiguration ? "Not configured" : "Checking";

const joinPage = () => `
  <div class="page join-page">
    <div class="join-image">${responsiveImage({
      src: "public/assets/school-seed.svg",
      alt: "A glowing school floating in clouds",
      widths: [384, 640, 750, 828, 1080, 1200],
      sizes: "(max-width: 760px) 100vw, 50vw",
      quality: 85,
      priority: true
    })}</div>
    <div class="join-panel">
      <h1>Join.</h1>
      <div class="social-join" aria-label="Join as curator">
        <button type="button" data-auth-provider="instagram">
          <span class="social-mark" aria-hidden="true">◎</span>
          <span><strong>Instagram</strong><small>Name · photo · handle</small></span>
          <i data-provider-state="instagram">${providerState("instagram")}</i>
        </button>
        <button type="button" data-auth-provider="x">
          <span class="social-mark social-mark--x" aria-hidden="true">X</span>
          <span><strong>X</strong><small>Name · photo · handle</small></span>
          <i data-provider-state="x">${providerState("x")}</i>
        </button>
      </div>
      <p class="join-note">Provider consent only. We never ask for your password.</p>
      <div class="join-result" id="join-result" aria-live="polite"></div>
      <section class="wallet-provisioning" data-wallet-provisioning aria-labelledby="wallet-provisioning-title" hidden>
        <div class="wallet-provisioning__heading">
          <span>Sepolia rehearsal</span>
          <h2 id="wallet-provisioning-title">Set up your auction wallet</h2>
        </div>
        <p>Your passkey controls the Safe. You can add a wallet you already control as recovery now, or continue without one; The School never receives either private key.</p>
        <div class="wallet-provisioning__actions">
          <button class="button button--soft" type="button" data-connect-recovery-wallet>Add recovery wallet (optional)</button>
          <button class="button button--dark" type="button" data-create-passkey-safe>Create passkey Safe</button>
          <button class="button button--soft" type="button" data-check-safe-activation hidden>Check deployment status</button>
        </div>
        <div class="wallet-provisioning__status" data-wallet-provisioning-status role="status" aria-live="polite">
          <strong>Ready for a passkey</strong>
          <span>Without a recovery wallet, losing this device or passkey may permanently remove access until recovery is added.</span>
        </div>
        <p class="wallet-provisioning__disclosure">This browser prepares the Safe only. It does not submit gas or claim that the Safe is active.</p>
      </section>
    </div>
  </div>
`;

const bazaarPage = () => {
  const featured = [getWork("aperture-vessel"), getWork("grid-chorus"), getWork("orbit-32")].filter(Boolean);
  const bazaarWorks = featured.length ? featured : works.slice(0, 3);
  const heroWork = getWork("portal-study") || bazaarWorks[0];
  return `
    <div class="page bazaar-page">
      <section class="bazaar-hero">
        <div class="bazaar-hero__image">${heroWork ? art(heroWork, "", { priority: true, detail: true }) : responsiveImage({ src: "public/assets/school-seed.svg", alt: "The School", className: "art art--live", widths: [640, 750, 828, 1080, 1200], sizes: "100vw", quality: 85, priority: true })}</div>
        <div class="bazaar-hero__copy"><span class="bazaar-meta">${escapeHtml(bazaar.dateLabel)} · ${escapeHtml(bazaar.timeLabel)}</span><h1>${escapeHtml(bazaar.title)}</h1>${bazaar.available !== false && (bazaar.startsAt || bazaar.date) ? `<button class="button button--light" type="button" data-calendar>Save the date</button>` : ""}</div>
      </section>
      <section class="schedule" aria-label="Bazaar schedule">
        ${bazaar.schedule.slice(0, 3).map((item) => `<div><time>${escapeHtml(item.time)}</time><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.note)}</span></div>`).join("") || `<p>${escapeHtml(bazaar.description || "Program details are coming soon.")}</p>`}
      </section>
      <section class="section"><div class="section-head"><h2>At the bazaar</h2></div><div class="work-grid">${bazaarWorks.map(workTile).join("")}</div></section>
    </div>
  `;
};

const notFound = () => `<div class="page"><header class="page-title"><h1>Not found.</h1><a class="button button--dark" href="#home">Go home</a></header></div>`;

const collectTemplate = (work, method) => work.resaleId ? `
  <div class="collect-work"><div>${art(work)}</div><span><small>Secondary listing</small><h2 id="collect-title">${escapeHtml(work.title)}</h2><i>${escapeHtml(work.artist)}</i></span></div>
  <div class="collect-price"><strong>${escapeHtml(work.price)}</strong><span>Fixed price · Seaport 1.6</span></div>
  <div class="method-panel"><span>USDC from your passkey Safe; Grove sponsors supported gas only.</span><button class="button button--dark" type="button" data-prepare-resale-purchase disabled>Checking resale…</button></div>
  <small class="pending-note" data-checkout-note>Apple Pay and Stripe are not used for secondary NFT sales.</small>
` : work.auctionId ? `
  <div class="collect-work"><div>${art(work)}</div><span><small>Ethereum auction</small><h2 id="collect-title">${escapeHtml(work.title)}</h2><i>${escapeHtml(work.artist)}</i></span></div>
  <div class="collect-price"><strong>${escapeHtml(work.price)}</strong><span>${escapeHtml(work.auctionRail === "card" ? "Apple Pay / card lot" : "Crypto lot")}</span></div>
  ${work.auctionRail === "card" ? `<label>Bid and payment authorization (USD)<input type="number" min="1" step="1" inputmode="numeric" data-auction-bid required></label>
  <div class="method-panel"><span>Save Apple Pay or a card for this auction</span><button class="button button--dark" type="button" data-start-auction-setup disabled>Checking auction…</button></div>`
    : `<label>Bid (${escapeHtml(work.auctionCurrency || "token")} base units)<input type="number" min="1" step="1" inputmode="numeric" data-auction-bid required></label>`}
  <div class="method-panel"><span>Your passkey Safe signs the off-chain bid</span><button class="button button--dark" type="button" data-place-auction-bid disabled>Checking passkey…</button></div>
  <div class="pending-note" data-auction-feed aria-live="polite">Loading verified bids…</div>
  <small class="pending-note" data-checkout-note>This records a binding signed bid; it does not claim payment or NFT delivery. Apple Pay does not fund a wallet.</small>
` : `
  <div class="collect-work"><div>${art(work)}</div><span><small>Preview</small><h2 id="collect-title">${escapeHtml(work.title)}</h2><i>${escapeHtml(work.artist)}</i></span></div>
  <div class="collect-price"><strong>${escapeHtml(work.cryptoPrice)}</strong><span>${escapeHtml(work.price)} card</span></div>
  <div class="method-tabs" role="tablist" aria-label="Payment method">
    <button type="button" role="tab" data-method="crypto" aria-selected="${method !== "card"}">Crypto</button>
    <button type="button" role="tab" data-method="card" aria-selected="${method === "card"}">Card</button>
  </div>
  <div class="method-panel" data-panel="crypto" ${method === "card" ? "hidden" : ""}><span>${work.chain ? `${escapeHtml(work.chain)} · ${escapeHtml(work.edition)}` : "USDC · inventory hold"}</span><button class="button button--dark" disabled>Wallet path under review</button></div>
  <div class="method-panel" data-panel="card" ${method !== "card" ? "hidden" : ""}><span>Secure hosted checkout</span><button class="button button--dark" type="button" data-start-card-checkout disabled>Checking checkout…</button></div>
  <small class="pending-note" data-checkout-note>Apple Pay appears on eligible Apple devices. Applicable tax is added in secure checkout.</small>
`;

const openCollect = (slug, method) => {
  const work = getWork(slug);
  if (!work) return;
  collectDialog.dataset.workSlug = slug;
  collectContent.innerHTML = collectTemplate(work, method);
  collectDialog.showModal();
  void loadAuthConfiguration().then((configuration) => {
    if (collectDialog.dataset.workSlug !== slug) return;
    const button = collectDialog.querySelector("[data-start-card-checkout]");
    const auctionButton = collectDialog.querySelector("[data-start-auction-setup]");
    const bidButton = collectDialog.querySelector("[data-place-auction-bid]");
    const resaleButton = collectDialog.querySelector("[data-prepare-resale-purchase]");
    const note = collectDialog.querySelector("[data-checkout-note]");
    const configured = Boolean(configuration.acquisition?.card?.configured) && work.saleEnabled === true;
    const auctionConfigured = Boolean(configuration.auctions?.configured)
      && configuration.auctions?.rails?.includes(work.auctionRail) && work.auctionEnabled === true;
    const resaleConfigured = Boolean(configuration.secondary?.configured) && work.resaleEnabled === true;
    if (button) {
      button.disabled = !configured;
      button.textContent = configured ? "Apple Pay or card" : "Checkout not available";
    }
    if (auctionButton) {
      auctionButton.disabled = !auctionConfigured;
      auctionButton.textContent = auctionConfigured ? "Set up Apple Pay or card" : "Auction setup not available";
    }
    if (bidButton) {
      bidButton.disabled = !auctionConfigured;
      bidButton.textContent = auctionConfigured ? "Sign and place bid" : "Bidding not available";
    }
    if (resaleButton) {
      resaleButton.disabled = !resaleConfigured;
      resaleButton.textContent = resaleConfigured ? "Prepare gasless Safe purchase" : "Secondary checkout not available";
    }
    if (note && !work.auctionId && !configured) note.textContent = work.saleEnabled
      ? "Checkout remains disabled until provider and tax review pass."
      : "This work has not passed seller, rights, price, and inventory review for sale.";
  });
  if (work.auctionId) void loadAuctionBids(work.auctionId);
};

const startAuctionPaymentSetup = async (button) => {
  const work = getWork(collectDialog.dataset.workSlug);
  const maximumInput = collectDialog.querySelector("[data-auction-bid]");
  const maximum = Number(maximumInput?.value);
  if (!work?.auctionId || !Number.isSafeInteger(maximum) || maximum < 1) {
    showToast("Enter a whole-dollar maximum bid");
    return;
  }
  button.disabled = true;
  button.textContent = "Opening secure setup…";
  sessionStorage.setItem(`grove-auction-setup:${work.auctionId}`, JSON.stringify({ slug: work.slug, maximum }));
  try {
    const response = await fetch(`/api/auctions/${encodeURIComponent(work.auctionId)}/payment-setup`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ maximum_hammer_minor: maximum * 100 })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || "Payment setup is unavailable.");
    if (body.state === "ready") {
      button.textContent = "Payment method ready";
      showToast("Payment method ready — sign your bid");
      return;
    }
    if (body.state === "processing") {
      showToast("Payment setup is still confirming");
      return;
    }
    const checkoutUrl = new URL(body.checkout_url);
    if (checkoutUrl.protocol !== "https:") throw new Error("Payment setup returned an invalid URL.");
    location.assign(checkoutUrl.href);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Set up Apple Pay or card";
    showToast(error.message || "Payment setup is unavailable");
  }
};

const loadAuctionBids = async (auctionId) => {
  const feed = collectDialog.querySelector("[data-auction-feed]");
  if (!feed) return;
  try {
    const response = await fetch(`/api/auctions/${encodeURIComponent(auctionId)}/bids`, {
      headers: { Accept: "application/json" }
    });
    const body = await response.json();
    if (!response.ok) throw new Error("BID_FEED_UNAVAILABLE");
    const bids = Array.isArray(body.bids) ? body.bids : [];
    feed.textContent = bids.length
      ? `${bids.length} verified bid${bids.length === 1 ? "" : "s"} · leading ${money(Number(bids[0].amount), bids[0].currency)}`
      : "No verified bids yet.";
  } catch {
    feed.textContent = "Verified bid feed is temporarily unavailable.";
  }
};

const auctionAmount = (work, input) => {
  const amount = Number(input?.value);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("Enter a whole-number bid.");
  return work.auctionRail === "card" ? String(amount * 100) : String(amount);
};

const placeAuctionBid = async (button) => {
  const work = getWork(collectDialog.dataset.workSlug);
  if (!work?.auctionId) return;
  let amount;
  try {
    amount = auctionAmount(work, collectDialog.querySelector("[data-auction-bid]"));
  } catch (error) {
    showToast(error.message);
    return;
  }
  button.disabled = true;
  button.textContent = "Checking wallet…";
  try {
    const contextResponse = await fetch(`/api/auctions/${encodeURIComponent(work.auctionId)}/bid-context`, {
      headers: { Accept: "application/json" }
    });
    const context = await contextResponse.json();
    if (!contextResponse.ok) throw new Error(context.error?.message || "The bid context is unavailable.");
    if (context.payment?.required && !context.payment.ready) {
      throw new Error("Set up Apple Pay or a card before signing this bid.");
    }
    if (BigInt(amount) < BigInt(context.auction.minimum_amount)) {
      const minimum = context.auction.currency === "USD"
        ? money(Number(context.auction.minimum_amount), "USD")
        : `${context.auction.minimum_amount} ${context.auction.currency} base units`;
      throw new Error(`The next bid must be at least ${minimum}.`);
    }
    if (context.auction.maximum_amount && BigInt(amount) > BigInt(context.auction.maximum_amount)) {
      throw new Error("This bid exceeds your saved payment authorization.");
    }

    button.textContent = "Touch your passkey…";
    const { signBidIntentWithPasskey } = await import("./wallet-intents.js");
    const signed = await signBidIntentWithPasskey({ context, amount });
    button.textContent = "Submitting bid…";
    const requestKey = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const response = await fetch(`/api/auctions/${encodeURIComponent(work.auctionId)}/bids`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": `browser:${requestKey}`
      },
      body: JSON.stringify(signed.body)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || "The bid was not accepted.");
    showToast(`Verified bid accepted at ${money(Number(body.bid.amount), body.bid.currency)}`);
    button.textContent = "Bid accepted";
    await loadAuctionBids(work.auctionId);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Sign and place bid";
    showToast(error.message || "The bid was not accepted");
  }
};

const handleAuctionSetupReturn = () => {
  const params = new URLSearchParams(location.search);
  const state = params.get("auction_setup");
  const auctionId = params.get("auction_id");
  if (!state || !auctionId) return;
  let stored = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(`grove-auction-setup:${auctionId}`) || "null");
  } catch {
    stored = null;
  }
  history.replaceState(null, "", location.pathname + (stored?.slug ? `#work/${stored.slug}` : location.hash));
  if (stored?.slug && getWork(stored.slug)) {
    render();
    openCollect(stored.slug);
    const input = collectDialog.querySelector("[data-auction-bid]");
    if (input && Number.isSafeInteger(stored.maximum)) input.value = String(stored.maximum);
  }
  showToast(state === "success"
    ? "Payment setup returned; webhook confirmation may take a moment"
    : "Payment setup cancelled");
};

const startCardCheckout = async (button) => {
  const slug = collectDialog.dataset.workSlug;
  if (!slug) return;
  button.disabled = true;
  button.textContent = "Opening secure checkout…";
  const storageKey = `grove-checkout:${slug}`;
  let idempotencyKey = sessionStorage.getItem(storageKey);
  if (!idempotencyKey) {
    idempotencyKey = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem(storageKey, idempotencyKey);
  }

  try {
    const response = await fetch("/api/acquisitions", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ work_slug: slug, method: "card" })
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status < 500) sessionStorage.removeItem(storageKey);
      throw new Error(body.error?.message || "Checkout is unavailable.");
    }
    if (!body.checkout_url) throw new Error("Checkout is unavailable.");
    const checkoutUrl = new URL(body.checkout_url);
    if (checkoutUrl.protocol !== "https:") throw new Error("Checkout returned an invalid URL.");
    location.assign(checkoutUrl.href);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Apple Pay or card";
    showToast(error.message || "Checkout is unavailable");
  }
};

const usdcBaseUnits = (input) => {
  const normalized = String(input || "").trim();
  if (!/^[1-9][0-9]*(?:\.[0-9]{1,6})?$/.test(normalized)) throw new Error("Enter a positive USDC price with at most six decimals.");
  const [whole, fraction = ""] = normalized.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0")).toString();
};

const submitSponsoredSecondaryAction = async (action) => {
  if (!action?.sponsor_request || !action?.expected_call) {
    throw new Error("The sponsored action context is incomplete.");
  }
  const preparedResponse = await fetch("/api/wallet/sponsor", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(action.sponsor_request)
  });
  const prepared = await preparedResponse.json();
  if (!preparedResponse.ok) throw new Error(prepared.error?.message || "Gas sponsorship is unavailable.");
  const preparedCall = prepared.policy?.expected_call;
  if (prepared.stage !== "prepared" || prepared.action !== action.action
    || prepared.request_key !== action.request_key || preparedCall?.to?.toLowerCase() !== action.expected_call.to.toLowerCase()
    || preparedCall?.data?.toLowerCase() !== action.expected_call.data.toLowerCase()
    || String(preparedCall?.value) !== String(action.expected_call.value)) {
    throw new Error("The sponsored action did not match the marketplace request.");
  }
  const { signSponsoredSecondaryUserOperation } = await import("./wallet-intents.js");
  const signed = await signSponsoredSecondaryUserOperation({ context: prepared });
  const submittedResponse = await fetch("/api/wallet/sponsor", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(signed.body)
  });
  const submitted = await submittedResponse.json();
  if (!submittedResponse.ok) throw new Error(submitted.error?.message || "The sponsored action was not submitted.");
  if (submitted.stage !== "submitted" || !["submission-pending", "submitted", "finalized"].includes(submitted.state)
    || submitted.action !== action.action || submitted.request_key !== action.request_key
    || !/^0x[0-9a-f]{64}$/i.test(submitted.userop_hash || "")) {
    throw new Error("The sponsor did not return matching submission evidence.");
  }
  return submitted;
};

const startResaleListing = async (slug) => {
  const work = getWork(slug);
  if (!work?.id) return;
  const entered = globalThis.prompt("Fixed resale price in USDC");
  if (entered === null) return;
  let grossAmount;
  try {
    grossAmount = usdcBaseUnits(entered);
  } catch (error) {
    showToast(error.message);
    return;
  }
  try {
    const contextResponse = await fetch("/api/resales/context", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ work_id: work.id, gross_amount: grossAmount, duration_seconds: 604800 })
    });
    const context = await contextResponse.json();
    if (!contextResponse.ok) throw new Error(context.error?.message || "The resale listing is unavailable.");
    if (context.listing?.approval?.required) {
      await submitSponsoredSecondaryAction(context.listing.approval.action);
      showToast("Exact-token approval submitted; after finality, choose Sell again to sign the listing");
      return;
    }
    const { signResaleOrderWithPasskey } = await import("./wallet-intents.js");
    const signed = await signResaleOrderWithPasskey({ context });
    const response = await fetch("/api/resales", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(signed.body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || "The resale listing was not accepted.");
    showToast("Signed Seaport listing published on the marketplace");
    await hydrateLiveCatalog();
  } catch (error) {
    showToast(error.message || "The resale listing was not accepted");
  }
};

const prepareResalePurchase = async (button) => {
  const work = getWork(collectDialog.dataset.workSlug);
  if (!work?.resaleId) return;
  button.disabled = true;
  button.textContent = "Checking Safe and USDC…";
  try {
    const response = await fetch(`/api/resales/${encodeURIComponent(work.resaleId)}/fulfillment-context`, {
      headers: { Accept: "application/json" }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || "The gasless purchase is unavailable.");
    const action = result.next_action;
    if (!action) throw new Error("The next purchase action is unavailable.");
    button.textContent = action.action === "resale-fulfill" ? "Confirm with passkey…" : "Confirm USDC permission…";
    await submitSponsoredSecondaryAction(action);
    if (action.action === "resale-fulfill") {
      button.textContent = "Purchase awaiting finality";
      showToast("Purchase submitted; ownership updates only after finalized chain evidence");
    } else {
      button.textContent = "Permission awaiting finality";
      showToast("USDC permission submitted; after finality, choose Buy again to continue");
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = "Prepare gasless Safe purchase";
    showToast(error.message || "The gasless purchase is unavailable");
  }
};

const runResaleSellerAction = async (button, kind) => {
  const work = getWork(button.dataset[kind === "cancel" ? "cancelResale" : "revokeResaleApproval"]);
  if (!work?.resaleManagedId || !work.resaleSellerManaged || (kind === "cancel" && !work.resaleId)) return;
  const routeName = kind === "cancel" ? "cancellation-context" : "approval-revocation-context";
  const pendingLabel = kind === "cancel" ? "Checking cancellation…" : "Checking approval…";
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = pendingLabel;
  try {
    const contextResponse = await fetch(`/api/resales/${encodeURIComponent(work.resaleManagedId)}/${routeName}`, {
      method: "POST",
      headers: { Accept: "application/json" }
    });
    const context = await contextResponse.json();
    if (!contextResponse.ok) throw new Error(context.error?.message || "The seller action is unavailable.");
    const action = context.actions?.[0];
    if (!action?.sponsor_request) {
      showToast(kind === "cancel" ? "The listing is already inactive onchain" : "The exact-token approval is already clear");
      await hydrateLiveCatalog();
      return;
    }
    await submitSponsoredSecondaryAction(action);
    showToast(kind === "cancel" ? "Cancellation submitted; awaiting finality" : "Approval revocation submitted; awaiting finality");
    await hydrateLiveCatalog();
  } catch (error) {
    button.disabled = false;
    button.textContent = originalLabel;
    showToast(error.message || "The seller action is unavailable");
  }
};

const openNftTransfer = (slug) => {
  const work = getWork(slug);
  if (!work?.ownedByCurrentUser || !work.contractAddress || work.tokenId === undefined) return;
  transferForm.reset();
  transferForm.dataset.workSlug = slug;
  transferSummary.textContent = `${work.title} · ${work.chain} · ${work.contractAddress} · token #${work.tokenId}`;
  transferForm.querySelector("[data-transfer-status]").textContent = "";
  transferForm.querySelector("[data-submit-nft-transfer]").disabled = false;
  transferDialog.showModal();
};

const waitForSponsoredTransfer = async (requestKey) => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const response = await fetch(`/api/wallet/sponsor?request_key=${encodeURIComponent(requestKey)}`, {
      headers: { Accept: "application/json" }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || "Transfer status is unavailable.");
    if (["finalized", "failed"].includes(result.state)) return result;
  }
  return { state: "submitted" };
};

const submitNftTransfer = async (form, data) => {
  const work = getWork(form.dataset.workSlug);
  if (!work?.ownedByCurrentUser) return;
  const recipient = String(data.get("recipient") || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || recipient.toLowerCase() === String(work.ownerAddress || "").toLowerCase()) {
    showToast("Enter a different 20-byte Ethereum address");
    return;
  }
  const button = form.querySelector("[data-submit-nft-transfer]");
  const status = form.querySelector("[data-transfer-status]");
  button.disabled = true;
  button.textContent = "Checking ownership and approvals…";
  status.textContent = "No transfer has been submitted yet.";
  try {
    const response = await fetch(`/api/wallet/assets/${encodeURIComponent(work.id)}/transfer-context`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_address: recipient })
    });
    const action = await response.json();
    if (!response.ok) throw new Error(action.error?.message || "The NFT transfer is unavailable.");
    if (action.action !== "marketplace-transfer"
      || action.confirmation?.recipient_address?.toLowerCase() !== recipient.toLowerCase()
      || action.confirmation?.from_address?.toLowerCase() !== String(work.ownerAddress || "").toLowerCase()
      || action.confirmation?.token_id !== String(work.tokenId)) {
      throw new Error("The transfer confirmation changed. Nothing was signed.");
    }
    transferSummary.textContent = `${work.title} · ${action.confirmation.network} · token #${action.confirmation.token_id} · to ${action.confirmation.recipient_address}`;
    button.textContent = "Confirm with passkey…";
    const submitted = await submitSponsoredSecondaryAction(action);
    status.textContent = submitted.state === "finalized"
      ? "Transfer finalized onchain. Ownership indexing is updating."
      : "Transfer submitted. Waiting for finalized chain evidence…";
    if (submitted.state !== "finalized") {
      const finalized = await waitForSponsoredTransfer(action.request_key);
      if (finalized.state === "failed") throw new Error("The onchain transfer failed. Your NFT remains in your Safe.");
      status.textContent = finalized.state === "finalized"
        ? "Transfer finalized onchain. Ownership indexing is updating."
        : "Transfer is still pending. You can close this window; reconciliation will continue.";
    }
    await hydrateLiveCatalog();
    button.textContent = "Transfer submitted";
  } catch (error) {
    button.disabled = false;
    button.textContent = "Review and sign with passkey";
    status.textContent = error.message || "The NFT transfer was not submitted.";
    showToast(error.message || "The NFT transfer was not submitted");
  }
};

const handleCheckoutReturn = async () => {
  if (checkoutReturnHandled) return;
  checkoutReturnHandled = true;
  const params = new URLSearchParams(location.search);
  const state = params.get("checkout");
  if (!state) return;

  if (state === "cancelled") showToast("Checkout cancelled — the work will be released shortly");
  if (state === "success") {
    const sessionId = params.get("session_id");
    try {
      const response = await fetch(`/api/checkout-status?session_id=${encodeURIComponent(sessionId || "")}`, {
        headers: { Accept: "application/json" }
      });
      const status = await response.json();
      if (response.ok && status.state === "paid") {
        const [, purchasedSlug] = route();
        if (purchasedSlug) sessionStorage.removeItem(`grove-checkout:${purchasedSlug}`);
        showToast("Payment received");
      } else {
        showToast("Payment confirmation is pending");
      }
    } catch {
      showToast("Payment confirmation is pending");
    }
  }
  history.replaceState(null, "", `${location.pathname}${location.hash}`);
};

const updateDiscoveryView = () => {
  const grid = document.querySelector("#discovery-grid");
  if (grid) {
    const items = visibleDiscoveries();
    grid.innerHTML = items.length ? items.map(discoveryItem).join("") : `<div class="empty"><strong>Nothing here yet.</strong><span>Save a discovery to move it here.</span></div>`;
  }
  document.querySelectorAll("[data-discovery-filter]").forEach((button) => {
    const state = button.dataset.discoveryFilter;
    const count = discoveries.filter((item) => discoveryState.get(item.id) === state).length;
    button.setAttribute("aria-pressed", String(state === discoveryFilter));
    button.querySelector("span").textContent = count;
  });
};

const setActiveNav = (root) => {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const active = link.dataset.nav === root || (["work", "exhibition"].includes(root) && link.dataset.nav === "market");
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
};

const loadAuthConfiguration = async () => {
  if (authConfiguration) return authConfiguration;
  if (!authConfigurationRequest) {
    authConfigurationRequest = fetch("/api/config", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("UNAVAILABLE");
        return response.json();
      })
      .catch(() => ({
        backend: { configured: false },
        providers: { instagram: { configured: false }, x: { configured: false } }
      }));
  }
  authConfiguration = await authConfigurationRequest;
  return authConfiguration;
};

const setJoinResult = (headline, detail, profile) => {
  const result = document.querySelector("#join-result");
  if (!result) return;
  const image = managedMediaSource(profile?.avatar_url) || "public/assets/school-mark.svg";
  result.innerHTML = profile ? `
    ${responsiveImage({ src: image, alt: "", className: "profile-avatar", widths: [64, 128, 256], sizes: "64px", quality: 75 })}
    <span><strong>${escapeHtml(profile.display_name)}</strong><small>${profile.handle ? `@${escapeHtml(profile.handle)} · ` : ""}${profile.provider === "x" ? "X" : "Instagram"}</small></span>
    <button type="button" data-signout>Sign out</button>
  ` : `<strong>${escapeHtml(headline)}</strong><span>${escapeHtml(detail)}</span>`;
  result.classList.add("is-visible");
};

const walletRehearsalConfigured = (configuration) => configuration?.wallet?.configured === true
  && configuration.wallet.environment === "sepolia-rehearsal"
  && Number(configuration.wallet.chainId) === 11155111;

const setWalletProvisioningStatus = (headline, detail, contents = "") => {
  const status = document.querySelector("[data-wallet-provisioning-status]");
  if (!status) return;
  status.innerHTML = `<strong>${escapeHtml(headline)}</strong><span>${escapeHtml(detail)}</span>${contents}`;
};

const walletStatusAddress = (status) => status?.account_address || status?.wallet?.account_address || "";

const resetWalletProvisioningControls = () => {
  const panel = document.querySelector("[data-wallet-provisioning]");
  if (!panel) return;
  const connectButton = panel.querySelector("[data-connect-recovery-wallet]");
  const createButton = panel.querySelector("[data-create-passkey-safe]");
  const checkButton = panel.querySelector("[data-check-safe-activation]");
  connectButton.hidden = false;
  connectButton.disabled = !globalThis.ethereum?.request;
  connectButton.textContent = "Add recovery wallet (optional)";
  createButton.hidden = false;
  createButton.disabled = !globalThis.PublicKeyCredential || !globalThis.isSecureContext;
  createButton.textContent = "Create passkey Safe";
  checkButton.hidden = true;
  checkButton.disabled = false;
  checkButton.textContent = "Check deployment status";
  delete panel.dataset.activationState;
  if (!globalThis.ethereum?.request) {
    setWalletProvisioningStatus(
      "Ready without recovery",
      "No injected wallet was found. You can continue, but losing this device or passkey may permanently remove access until recovery is added."
    );
  } else if (!globalThis.PublicKeyCredential || !globalThis.isSecureContext) {
    setWalletProvisioningStatus(
      "Passkeys unavailable",
      "Use a passkey-capable browser on this secure staging site."
    );
  } else {
    setWalletProvisioningStatus(
      "Ready for a passkey",
      "Add an existing recovery wallet for stronger account recovery, or continue without one."
    );
  }
};

const renderWalletProvisioningStage = (status) => {
  const panel = document.querySelector("[data-wallet-provisioning]");
  if (!panel) return;
  if (status?.stage === "unprepared") {
    resetWalletProvisioningControls();
    return;
  }
  if (!["prepared", "active"].includes(status?.stage)) {
    throw new Error("The server returned an unknown wallet activation state.");
  }
  const address = walletStatusAddress(status);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("The server did not return a valid Safe address.");
  }
  const connectButton = panel.querySelector("[data-connect-recovery-wallet]");
  const createButton = panel.querySelector("[data-create-passkey-safe]");
  const checkButton = panel.querySelector("[data-check-safe-activation]");
  connectButton.hidden = true;
  createButton.hidden = true;
  const active = status.stage === "active";
  checkButton.hidden = active;
  checkButton.disabled = false;
  checkButton.textContent = "Check deployment status";
  const checkedThrough = status.deployment?.checked_through_block;
  const preparedBlock = status.verified_finalized_block;
  const recoveryReady = status.recovery_ready === true || status.wallet?.recovery_ready === true
    || Boolean(status.owners?.recovery_address);
  const detail = active
    ? `Activation status: active from finalized Sepolia evidence.${recoveryReady ? " Recovery is configured." : " No recovery wallet is configured; losing the passkey may permanently remove access."}`
    : `Activation status: pending platform deployment. Factory calldata is ready${preparedBlock ? ` and was prepared at finalized block ${preparedBlock}` : ""}${checkedThrough ? `; deployment was checked through block ${checkedThrough}` : ""}.${recoveryReady ? " Recovery is configured." : " No recovery wallet is configured yet."}`;
  setWalletProvisioningStatus(
    active ? "Passkey Safe active" : "Counterfactual Safe ready",
    detail,
    `<code>${escapeHtml(address)}</code><a href="https://sepolia.etherscan.io/address/${escapeHtml(address)}" target="_blank" rel="noopener noreferrer">View address on Sepolia Etherscan</a>`
  );
  panel.dataset.activationState = active ? "active" : "pending";
};

const refreshWalletProvisioningStatus = async (button) => {
  const panel = document.querySelector("[data-wallet-provisioning]");
  if (!panel || panel.hidden) return;
  if (button) {
    button.disabled = true;
    button.textContent = "Checking finality…";
  }
  try {
    const status = await postWalletProvisioning({ stage: "status" });
    renderWalletProvisioningStage(status);
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = "Check deployment status";
    }
    setWalletProvisioningStatus("Deployment status unavailable", error.message || "Try checking again. No transaction was submitted.");
  }
};

const showWalletProvisioning = (curator, configuration) => {
  const panel = document.querySelector("[data-wallet-provisioning]");
  if (!panel || curator?.status !== "active" || !walletRehearsalConfigured(configuration)) return;
  panel.hidden = false;
  panel.dataset.credentialName = curator.handle
    ? `${BRAND_NAME} · @${curator.handle}`
    : `${BRAND_NAME} · ${curator.display_name}`;
  setWalletProvisioningStatus("Checking auction wallet", "Looking for an existing prepared or active Safe.");
  void refreshWalletProvisioningStatus();
};

const connectProvisioningRecoveryWallet = async (button) => {
  const panel = document.querySelector("[data-wallet-provisioning]");
  if (!panel || panel.hidden) return;
  const createButton = panel.querySelector("[data-create-passkey-safe]");
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    const { connectRecoveryWallet } = await import("./wallet-intents.js");
    const recovery = await connectRecoveryWallet();
    recoveryWalletAddress = recovery.address;
    button.textContent = "Recovery wallet connected";
    createButton.disabled = !globalThis.PublicKeyCredential || !globalThis.isSecureContext;
    const networkDetail = recovery.chainId && recovery.chainId !== 11155111
      ? "The proof is Sepolia-specific even though your wallet currently displays another network."
      : "It will sign a Sepolia-specific recovery proof; no transaction is requested.";
    setWalletProvisioningStatus(
      "Recovery owner connected",
      `${recovery.address.slice(0, 8)}…${recovery.address.slice(-6)}. ${networkDetail}`
    );
  } catch (error) {
    button.disabled = false;
    button.textContent = originalLabel;
    createButton.disabled = !globalThis.PublicKeyCredential || !globalThis.isSecureContext;
    setWalletProvisioningStatus("Recovery wallet not connected", error.message || "Connect an existing Ethereum wallet to continue.");
  }
};

const postWalletProvisioning = async (body) => {
  const response = await fetch("/api/wallet/provision", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) throw new Error(result?.error?.message || "Passkey wallet preparation is unavailable.");
  return result;
};

const preparePasskeySafe = async (button) => {
  const panel = document.querySelector("[data-wallet-provisioning]");
  const connectButton = panel?.querySelector("[data-connect-recovery-wallet]");
  if (!panel || panel.hidden) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  if (connectButton) connectButton.disabled = true;
  try {
    button.textContent = "Confirm passkey…";
    setWalletProvisioningStatus("Creating passkey", "Confirm the browser prompt. The private key stays in your authenticator.");
    const {
      connectRecoveryWallet,
      createProvisioningPasskey,
      signRecoveryAuthorizationWithWallet
    } = await import("./wallet-intents.js");
    const credential = await createProvisioningPasskey({ name: panel.dataset.credentialName });
    const prepareBody = {
      stage: "prepare",
      passkey_public_key: credential.publicKey
    };
    if (recoveryWalletAddress) {
      const currentRecovery = await connectRecoveryWallet();
      recoveryWalletAddress = currentRecovery.address;
      button.textContent = "Requesting recovery proof…";
      const challenge = await postWalletProvisioning({
        stage: "challenge",
        passkey_public_key: credential.publicKey,
        recovery_address: recoveryWalletAddress
      });
      if (challenge?.stage !== "challenge" || challenge.recovery_address?.toLowerCase() !== recoveryWalletAddress.toLowerCase()
        || challenge.passkey_public_key !== credential.publicKey || typeof challenge.message !== "string") {
        throw new Error("The recovery challenge did not match this wallet setup.");
      }
      button.textContent = "Confirm recovery wallet…";
      setWalletProvisioningStatus("Confirm recovery owner", "Sign the displayed authorization message. This is not a transaction and costs no gas.");
      const signature = await signRecoveryAuthorizationWithWallet({
        message: challenge.message,
        recoveryAddress: recoveryWalletAddress
      });
      Object.assign(prepareBody, {
        recovery_address: recoveryWalletAddress,
        recovery_proof: {
          nonce: challenge.nonce,
          expires_at: challenge.expires_at,
          signature
        }
      });
    } else {
      setWalletProvisioningStatus(
        "Preparing without recovery",
        "No recovery private key is generated or held. Keep this passkey available; loss may permanently remove access until recovery is added."
      );
    }
    button.textContent = "Preparing Safe…";
    const prepared = await postWalletProvisioning(prepareBody);
    if (!["prepared", "active"].includes(prepared?.stage)
      || !/^0x[0-9a-fA-F]{40}$/.test(prepared.account_address || prepared.wallet?.account_address || "")) {
      throw new Error("The server did not return a valid Safe preparation record.");
    }

    const address = walletStatusAddress(prepared);
    renderWalletProvisioningStage(prepared);
    void track("wallet_provisioning_prepared", {
      route: routeName(), entityType: "wallet", entityId: address, properties: { state: prepared.stage, chainId: 11155111 }
    });
  } catch (error) {
    button.disabled = false;
    if (connectButton) connectButton.disabled = !globalThis.ethereum?.request;
    button.textContent = originalLabel;
    setWalletProvisioningStatus("Safe not prepared", error.message || "No Safe deployment was submitted.");
  }
};

const hydrateJoin = async () => {
  const configuration = await loadAuthConfiguration();
  if (!document.querySelector(".join-page")) return;

  for (const provider of ["instagram", "x"]) {
    const configured = Boolean(configuration.providers?.[provider]?.configured);
    const state = document.querySelector(`[data-provider-state="${provider}"]`);
    const button = document.querySelector(`[data-auth-provider="${provider}"]`);
    if (state) state.textContent = configured ? "Available" : "Not configured";
    if (button) button.classList.toggle("is-unconfigured", !configured);
  }

  const authState = new URLSearchParams(location.search).get("auth");
  let curator = null;
  if (authState === "connected" || walletRehearsalConfigured(configuration)) {
    try {
      const response = await fetch("/api/me", { headers: { Accept: "application/json" } });
      const body = await response.json();
      if (response.ok && body.curator) {
        curator = body.curator;
        if (!authState || authState === "connected") setJoinResult("", "", curator);
        if (authState === "connected") {
          void track("join_completed", { route: routeName(), entityType: "provider", entityId: curator.provider, properties: { state: "connected" } });
        }
      } else if (authState === "connected") setJoinResult("Profile unavailable", "No profile data was imported.");
    } catch {
      if (authState === "connected") setJoinResult("Profile unavailable", "No profile data was imported.");
    }
  }

  if (curator) showWalletProvisioning(curator, configuration);
  if (authState === "cancelled") {
    setJoinResult("Join cancelled", "No account was opened or imported.");
    void track("join_cancelled", { route: routeName(), properties: { state: "cancelled" } });
  } else if (authState === "not-configured") {
    setJoinResult("OAuth not configured", "No account was opened or imported.");
    void track("join_unavailable", { route: routeName(), properties: { state: "not-configured" } });
  } else if (authState && authState !== "connected") {
    setJoinResult("Join incomplete", "No profile data was imported.");
    void track("join_cancelled", { route: routeName(), properties: { state: "incomplete" } });
  }

  if (authState) history.replaceState(null, "", `${location.pathname}${location.hash}`);
};

const startAuth = async (provider) => {
  const configuration = await loadAuthConfiguration();
  if (!configuration.providers?.[provider]?.configured) {
    setJoinResult(`${provider === "x" ? "X" : "Instagram"} is not configured`, "No account was opened or imported.");
    void track("join_unavailable", { route: routeName(), entityType: "provider", entityId: provider, properties: { provider } });
    return;
  }
  void track("join_started", { route: routeName(), entityType: "provider", entityId: provider, properties: { provider } });
  location.assign(`/api/auth/start?provider=${encodeURIComponent(provider)}`);
};

const signOut = async () => {
  try {
    const response = await fetch("/api/auth/signout", { method: "POST", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("SIGNOUT_FAILED");
    recoveryWalletAddress = "";
    const panel = document.querySelector("[data-wallet-provisioning]");
    if (panel) panel.hidden = true;
    setJoinResult("Signed out", "This browser session is closed.");
  } catch {
    setJoinResult("Sign-out incomplete", "Try again when the service is available.");
  }
};

const render = () => {
  const [root, detail] = route();
  let html;
  let title;
  if (root === "home") { html = home(); title = BRAND_NAME; }
  else if (root === "discover") { html = discoverPage(); title = `Discoveries · ${BRAND_NAME}`; }
  else if (root === "market") { html = marketPage(detail || "all"); title = `Works · ${BRAND_NAME}`; }
  else if (root === "work" && getWork(detail)) { const work = getWork(detail); html = workPage(work); title = `${work.title} · ${BRAND_NAME}`; }
  else if (root === "exhibition" && getExhibition(detail)) { const exhibition = getExhibition(detail); html = exhibitionPage(exhibition); title = `${exhibition.title} · ${BRAND_NAME}`; }
  else if (root === "curators") { html = curatorsPage(); title = `Curators · ${BRAND_NAME}`; }
  else if (root === "curator" && getCurator(detail)) { const curator = getCurator(detail); html = curatorPage(curator); title = `${curator.name} · ${BRAND_NAME}`; }
  else if (root === "sponsor") { html = sponsorPage(); title = `Add a piece · ${BRAND_NAME}`; }
  else if (root === "join") { html = joinPage(); title = `Join · ${BRAND_NAME}`; }
  else if (root === "bazaar") { html = bazaarPage(); title = `Bazaar · ${BRAND_NAME}`; }
  else { html = notFound(); title = `Not found · ${BRAND_NAME}`; }

  app.innerHTML = html;
  document.title = title;
  setActiveNav(root);
  scrollTo({ top: 0, behavior: "auto" });
  requestAnimationFrame(() => app.focus({ preventScroll: true }));
  if (root === "join") void hydrateJoin();

  const viewedRoute = [root, detail].filter(Boolean).join("/");
  void track("page_view", { route: routeName() });
  const viewedWork = root === "work" && detail ? getWork(detail) : null;
  if (viewedWork) {
    void track("work_viewed", {
      route: viewedRoute,
      entityType: "work",
      entityId: detail,
      properties: { format: viewedWork.type }
    });
  }
  if (root === "curator" && detail) void track("curator_viewed", { route: viewedRoute, entityType: "curator", entityId: detail });
  if (root === "exhibition" && detail) void track("exhibition_viewed", { route: viewedRoute, entityType: "exhibition", entityId: detail });
  if (root === "bazaar") void track("bazaar_viewed", { route: "bazaar", entityType: "bazaar", entityId: bazaar.slug || null });
};

document.addEventListener("click", (event) => {
  const authProvider = event.target.closest("[data-auth-provider]");
  if (authProvider) { void startAuth(authProvider.dataset.authProvider); return; }

  if (event.target.closest("[data-signout]")) { void signOut(); return; }

  const recoveryWallet = event.target.closest("[data-connect-recovery-wallet]");
  if (recoveryWallet) { void connectProvisioningRecoveryWallet(recoveryWallet); return; }

  const passkeySafe = event.target.closest("[data-create-passkey-safe]");
  if (passkeySafe) { void preparePasskeySafe(passkeySafe); return; }

  const safeActivation = event.target.closest("[data-check-safe-activation]");
  if (safeActivation) { void refreshWalletProvisioningStatus(safeActivation); return; }

  const save = event.target.closest("[data-save-discovery]");
  if (save) {
    const id = save.dataset.saveDiscovery;
    discoveryState.set(id, discoveryState.get(id) === "saved" ? "new" : "saved");
    void track(discoveryState.get(id) === "saved" ? "discovery_saved" : "discovery_unsaved", { route: routeName(), entityType: "discovery", entityId: id, properties: { state: discoveryState.get(id) } });
    updateDiscoveryView();
    const card = document.querySelector(`[data-discovery-id="${id}"]`);
    if (card && !document.querySelector("#discovery-grid")) card.outerHTML = discoveryItem(discoveries.find((item) => item.id === id));
    showToast(discoveryState.get(id) === "saved" ? "Saved" : "Moved to new");
    return;
  }

  const sponsor = event.target.closest("[data-sponsor-discovery]");
  if (sponsor) {
    selectedDiscovery = sponsor.dataset.sponsorDiscovery;
    discoveryState.set(selectedDiscovery, "sponsored");
    void track("discovery_sponsored", { route: routeName(), entityType: "discovery", entityId: selectedDiscovery, properties: { state: "sponsored" } });
    location.hash = "#sponsor";
    return;
  }

  const discoveryTab = event.target.closest("[data-discovery-filter]");
  if (discoveryTab) {
    discoveryFilter = discoveryTab.dataset.discoveryFilter;
    void track("discovery_filter_changed", { route: routeName(), properties: { filter: discoveryFilter } });
    updateDiscoveryView();
    return;
  }

  const marketTab = event.target.closest("[data-market-filter]");
  if (marketTab) {
    marketFilter = marketTab.dataset.marketFilter;
    void track("work_filter_changed", { route: routeName(), properties: { filter: marketFilter } });
    const filtered = marketFilter === "all" ? works : works.filter((work) => work.type === marketFilter);
    document.querySelector("#market-grid").innerHTML = filtered.map(workTile).join("");
    document.querySelectorAll("[data-market-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.marketFilter === marketFilter)));
    return;
  }

  const collect = event.target.closest("[data-collect]");
  if (collect) {
    openCollect(collect.dataset.collect, collect.dataset.method);
    void track("acquisition_preview_opened", { route: routeName(), entityType: "work", entityId: collect.dataset.collect, properties: { method: collect.dataset.method } });
    return;
  }

  const resale = event.target.closest("[data-start-resale]");
  if (resale) { void startResaleListing(resale.dataset.startResale); return; }

  const cancelResale = event.target.closest("[data-cancel-resale]");
  if (cancelResale) { void runResaleSellerAction(cancelResale, "cancel"); return; }

  const revokeResaleApproval = event.target.closest("[data-revoke-resale-approval]");
  if (revokeResaleApproval) { void runResaleSellerAction(revokeResaleApproval, "revoke"); return; }

  const transferNft = event.target.closest("[data-transfer-nft]");
  if (transferNft) { openNftTransfer(transferNft.dataset.transferNft); return; }

  const cardCheckout = event.target.closest("[data-start-card-checkout]");
  if (cardCheckout) { void startCardCheckout(cardCheckout); return; }

  const resalePurchase = event.target.closest("[data-prepare-resale-purchase]");
  if (resalePurchase) { void prepareResalePurchase(resalePurchase); return; }

  const auctionSetup = event.target.closest("[data-start-auction-setup]");
  if (auctionSetup) { void startAuctionPaymentSetup(auctionSetup); return; }

  const auctionBid = event.target.closest("[data-place-auction-bid]");
  if (auctionBid) { void placeAuctionBid(auctionBid); return; }

  const method = event.target.closest("[data-method]");
  if (method) {
    collectDialog.querySelectorAll("[data-method]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.method === method.dataset.method)));
    collectDialog.querySelectorAll("[data-panel]").forEach((panel) => panel.hidden = panel.dataset.panel !== method.dataset.method);
    void track("acquisition_method_changed", { route: routeName(), entityType: "work", entityId: collectDialog.dataset.workSlug, properties: { method: method.dataset.method } });
    return;
  }

  if (event.target.closest("[data-close-dialog]")) { collectDialog.close(); return; }
  if (event.target.closest("[data-close-transfer-dialog]")) { transferDialog.close(); return; }
  if (event.target.closest("[data-calendar]")) downloadCalendar();
});

document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) return;
  const data = new FormData(form);

  if (form.id === "transfer-form") {
    void submitNftTransfer(form, data);
    return;
  }

  if (form.id === "link-capture") {
    draftLink = data.get("link");
    selectedDiscovery = null;
    void track("draft_started", { route: routeName(), properties: { source: "public-link" } });
    location.hash = "#sponsor";
  }

  if (form.id === "piece-form") {
    const result = document.querySelector("#piece-result");
    result.innerHTML = `<span>Draft ready · not submitted</span><strong>${escapeHtml(data.get("title"))}</strong><small>${escapeHtml(data.get("artist"))} · ${escapeHtml(data.get("format"))}</small>`;
    result.classList.add("is-visible");
    void track("draft_reviewed", { route: routeName(), properties: { format: String(data.get("format") || "").toLowerCase().replaceAll(" / ", "-").replaceAll(" + ", "-") } });
    result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

});

const downloadCalendar = () => {
  const startsAt = bazaar.startsAt || bazaar.date;
  const endsAt = bazaar.endsAt || (startsAt ? new Date(new Date(startsAt).getTime() + 7 * 60 * 60_000).toISOString() : null);
  if (bazaar.available === false || !startsAt || !endsAt) {
    showToast("No bazaar date is published yet");
    return;
  }
  const calendarTime = (value, fallback) => value
    ? new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
    : fallback;
  const calendarText = (value) => String(value || "").replaceAll("\\", "\\\\").replaceAll(",", "\\,").replaceAll(";", "\\;").replaceAll("\n", "\\n");
  const file = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", `DTSTART:${calendarTime(startsAt, "20260912T160000Z")}`, `DTEND:${calendarTime(endsAt, "20260912T230000Z")}`, `SUMMARY:${calendarText(`${BRAND_NAME} · ${bazaar.title}`)}`, `LOCATION:${calendarText(bazaar.address || "29 Nassau Avenue, Brooklyn, New York")}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const url = URL.createObjectURL(new Blob([file], { type: "text/calendar" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: "marketplace-auction-house-of-brooklyn-bazaar.ics" });
  link.click();
  URL.revokeObjectURL(url);
  showToast("Calendar ready");
  void track("calendar_saved", { route: routeName(), entityType: "bazaar", entityId: bazaar.slug || null });
};

collectDialog.addEventListener("click", (event) => { if (event.target === collectDialog) collectDialog.close(); });
transferDialog.addEventListener("click", (event) => { if (event.target === transferDialog) transferDialog.close(); });
addEventListener("hashchange", render);
trackClientErrors(routeName);
render();
void handleCheckoutReturn();
void hydrateLiveCatalog().then(handleAuctionSetupReturn);

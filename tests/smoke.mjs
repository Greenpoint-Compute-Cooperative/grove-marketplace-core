import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bazaar, curators, discoveries, exhibitions, works } from "../catalog.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFile(join(root, path), "utf8");

const [html, css, app, analytics, launch, oauth, manifest, health, rehearsalMetadata, auctionTerms] = await Promise.all([
  read("index.html"),
  read("styles.css"),
  read("app.js"),
  read("analytics.js"),
  read("LAUNCH.md"),
  read("docs/OAUTH_SETUP.md"),
  read("manifest.webmanifest"),
  read("api/health.js"),
  read("public/metadata/sepolia-passkey-auction-rehearsal.json"),
  read("auction-terms.html")
]);

assert.match(html, /id="app"/, "application mount exists");
assert.match(html, /id="collect-dialog"/, "collection dialog exists");
assert.match(html, /href="styles\.css"/, "stylesheet is linked");
assert.match(html, /src="app\.js"/, "application module is linked");
assert.match(html, /rel="manifest"/, "install metadata is linked");
assert.match(html, /rel="canonical"/, "canonical production URL is declared");
assert.match(html, /aria-label="Marketplace &amp; Auction House of Brooklyn, home"/, "exact public identity is visible in source");
assert.doesNotMatch(html, /Grove Marketplace/, "retired Grove identity is absent from source");
assert.doesNotMatch(html, /Marketplace &amp; Auction House of Brooklyn New York/, "trailing New York is absent from the identity");
assert.match(html, /public\/assets\/school-mark\.svg/, "supplied school mark is the primary logo");
assert.doesNotMatch(html, /The School Art/, "retired product name is absent");
assert.doesNotMatch(html, /href="#"/, "no placeholder-only links remain");
assert.doesNotMatch(app, new RegExp(["Curate", "what enters"].join(" ")), "rejected opening slogan is absent");
assert.doesNotMatch(app, /desk-popout/, "decorative hero popout is absent");
assert.doesNotMatch(app, /join-form/, "manual signup form is absent");
assert.doesNotMatch(app, /type="email"/, "email signup is absent");
assert.match(app, /const BRAND_NAME = "Marketplace & Auction House of Brooklyn"/, "route titles use the exact public identity");
assert.doesNotMatch(app, /Grove Marketplace/, "retired Grove identity is absent from the application");
assert.match(app, /className: "hero__seed"/, "home restores the supplied school as the full main card");
assert.match(app, /class="hero__copy"/, "home restores the historical action position");
assert.doesNotMatch(app, /hero__identity|hero__mark|hero__action/, "the rejected compact editorial hero is absent");
assert.match(app, /track\("work_viewed"/, "work engagement is measured");
assert.match(app, /track\("discovery_sponsored"/, "curator intent is measured");
assert.match(analytics, /sessionStorage/, "metrics use a browser-session identifier");
assert.match(analytics, /globalPrivacyControl/, "metrics honor Global Privacy Control");
assert.doesNotMatch(analytics, /localStorage|document\.cookie|fingerprint/, "metrics avoid persistent tracking");
assert.match(manifest, /Marketplace & Auction House of Brooklyn/, "manifest carries the exact public identity");
assert.doesNotMatch(manifest, /Grove Marketplace|Brooklyn New York/, "manifest omits retired identity variants");
assert.match(health, /service: "Marketplace & Auction House of Brooklyn"/, "health output uses the exact public-facing service identity");

for (const route of ["home", "discoverPage", "marketPage", "exhibitionPage", "workPage", "curatorsPage", "curatorPage", "bazaarPage", "sponsorPage", "joinPage"]) {
  assert.match(app, new RegExp(`const ${route}`), `${route} is implemented`);
}

assert.match(app, /No fetch in preview/, "link intake does not imply scraping");
assert.match(app, /Apple Pay appears on eligible Apple devices/, "hosted checkout explains Apple Pay availability");
assert.match(app, /Sell this NFT/, "owned eligible NFTs expose the secondary-listing action when configured");
assert.match(app, /Apple Pay and Stripe are not used for secondary NFT sales/, "secondary checkout does not misrepresent the fiat rail");
assert.match(app, /OpenSea retired all testnet support/, "Sepolia UI explains the OpenSea testnet boundary");
assert.doesNotMatch(app, /opensea\.io\/assets\/sepolia/, "the UI never generates a dead OpenSea Sepolia link");
assert.equal(app.split('if (typeof value !== "string" || !value.trim()) return "";').length - 1, 2,
  "missing media and document URLs stay absent instead of resolving to the site origin");
assert.match(app, /Preview only · nothing is submitted/, "draft forms do not fake delivery");
assert.match(app, /data-auth-provider="instagram"/, "Instagram is a join path");
assert.match(app, /data-auth-provider="x"/, "X is a join path");
assert.match(app, /No account was opened or imported/, "unconfigured OAuth is explicit");
assert.match(app, /Wallet path under review/, "crypto path stays fail closed");
assert.match(app, /Apple Pay or card/, "hosted Apple Pay and card path is present");
assert.match(app, /signBidIntentWithPasskey/, "the auction dialog invokes the Safe passkey signer");
assert.match(app, /\/bid-context/, "the auction dialog requests a server-canonical signing context");
assert.match(app, /Idempotency-Key/, "browser bid submission has an idempotency key");
assert.match(rehearsalMetadata, /synthetic Grove marketplace rehearsal asset/, "Sepolia metadata is explicitly synthetic");
assert.match(auctionTerms, /version sepolia-rehearsal-v1/, "Sepolia terms carry a stable version");
assert.match(auctionTerms, /not an offer to sell artwork/, "Sepolia terms disclaim a production sale");
assert.match(css, /prefers-reduced-motion/, "reduced-motion behavior exists");
assert.match(css, /:focus-visible/, "keyboard focus treatment exists");
assert.match(css, /@media \(max-width: 760px\)/, "phone layout exists");
assert.doesNotMatch(css, /--tile:|catalogue-sheet|background-attachment: fixed/, "the rejected checker and catalogue-sheet system is absent");
assert.doesNotMatch(app, /catalogue-sheet/, "routes no longer carry catalogue-sheet wrappers");
assert.match(css, /linear-gradient\(180deg, var\(--sky\) 0%, var\(--ice\) 42%, #d9eaf3 100%\)/, "continuous celestial page background is restored");
assert.match(css, /\.topbar \{[\s\S]*?top: 10px;[\s\S]*?width: min\(calc\(100% - 24px\), 1480px\);[\s\S]*?margin: 10px auto 0;[\s\S]*?border-radius: 12px;/, "desktop header floats inside a restrained celestial inset");
assert.match(css, /@media \(max-width: 1080px\)[\s\S]*?\.topbar \{[\s\S]*?top: 8px;[\s\S]*?width: calc\(100% - 20px\);[\s\S]*?margin-top: 8px;/, "tablet header preserves a responsive inset");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.topbar \{[\s\S]*?top: 6px;[\s\S]*?width: calc\(100% - 12px\);[\s\S]*?margin-top: 6px;[\s\S]*?border-radius: 10px;/, "phone header preserves rounded gutters");
assert.match(css, /\.hero \{[\s\S]*?height: min\(65vw, 720px\);[\s\S]*?min-height: 620px;/, "desktop hero restores the v1.0.1 height");
assert.match(css, /border-radius: 34px;[\s\S]*?background: #c8e3f1;/, "desktop hero restores the v1.0.1 frame");
assert.match(css, /\.hero \.button--light \{[\s\S]*?min-height: 34px;[\s\S]*?padding: 7px 13px;[\s\S]*?font-size: 10px;/, "hero action has a materially smaller visible face");
assert.match(css, /\.hero \.button--light::before \{[\s\S]*?width: max\(100%, 44px\);[\s\S]*?height: 44px;/, "hero action retains a 44px invisible hit area");
assert.match(css, /@media \(max-width: 390px\) and \(max-height: 760px\)[\s\S]*?\.hero__copy \{[\s\S]*?bottom: 82px;/, "short phones keep the hero action clear of fixed navigation");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.hero \{[\s\S]*?height: 660px;[\s\S]*?border-radius: 26px;/, "phone hero restores the v1.0.1 portrait card");
assert.match(css, /@media \(max-width: 390px\)[\s\S]*?\.hero \{[\s\S]*?height: 620px;/, "narrow phone hero restores the v1.0.1 height");
assert.match(css, /border-radius: 1[0-6]px/, "restrained gallery surfaces are part of the visual system");

assert.equal(new Set(works.map((work) => work.slug)).size, works.length, "work slugs are unique");
assert.equal(new Set(curators.map((curator) => curator.id)).size, curators.length, "curator IDs are unique");
assert.equal(new Set(discoveries.map((item) => item.id)).size, discoveries.length, "discovery IDs are unique");
assert.deepEqual(new Set(works.map((work) => work.type)), new Set(["physical", "digital", "paired"]), "all three launch formats exist");

for (const discovery of discoveries) {
  assert.ok(works.some((work) => work.slug === discovery.workSlug), `${discovery.id} references a real work`);
  assert.ok(["new", "saved", "sponsored"].includes(discovery.status), `${discovery.id} has a valid state`);
}

for (const work of works) {
  assert.ok(work.title && work.artist && work.medium, `${work.slug} has core catalog fields`);
  assert.ok(work.price && work.cryptoPrice, `${work.slug} has card and crypto display prices`);
  assert.ok(work.rights && work.fulfillment, `${work.slug} states rights and fulfillment`);
  assert.ok(curators.some((curator) => curator.id === work.curatorId), `${work.slug} has a valid curator sponsor`);
  assert.ok(["physical", "digital"].includes(work.sheet), `${work.slug} has a valid image sheet`);
  assert.ok([0, 1, 2].includes(work.x) && [0, 1].includes(work.y), `${work.slug} has a valid image crop`);
  if (work.type === "physical") {
    assert.equal(work.chain, null, `${work.slug} does not invent token metadata`);
  } else {
    assert.ok(work.chain && work.tokenStandard && work.contractStatus, `${work.slug} has launch NFT metadata and honest contract status`);
    assert.match(work.contractStatus, /pending/i, `${work.slug} contract is labeled pending`);
  }
}

for (const exhibition of exhibitions) {
  assert.ok(curators.some((curator) => curator.id === exhibition.curatorId), `${exhibition.id} has a curator`);
  for (const slug of exhibition.workSlugs) {
    assert.ok(works.some((work) => work.slug === slug), `${exhibition.id} references a real work`);
  }
}

assert.ok(Date.parse(bazaar.date), "bazaar date is machine-readable");
assert.ok(bazaar.schedule.length >= 4, "bazaar has a useful program");
assert.match(launch, /launch target represents every approved marketplace work by an NFT on Ethereum mainnet/i, "roadmap makes approved works NFT-first");
assert.match(launch, /Curator-first go-to-market/, "roadmap includes curator-first GTM");
assert.match(launch, /Instagram chat intake/, "roadmap includes the constrained chat-intake concept");
assert.match(launch, /no scraping/i, "roadmap prohibits scraping");
assert.match(launch, /Marketplace & Auction House of Brooklyn/, "launch plan uses the current identity");
assert.match(launch, /29 Nassau Avenue/, "launch plan remains grounded in Brooklyn");
assert.match(oauth, /email\/password form/, "social-only access is documented");
assert.match(oauth, /instagram_business_basic/, "Instagram scope boundary is documented");
assert.match(oauth, /users\.read/, "X profile scope boundary is documented");

for (const asset of ["public/assets/school-seed.svg", "public/assets/school-mark.svg", "public/assets/physical-works.svg", "public/assets/digital-works.svg"]) {
  const info = await stat(join(root, asset));
  assert.ok(info.size > 100, `${asset} is present and non-empty`);
}

console.log(`Smoke checks passed: ${works.length} works, ${discoveries.length} discoveries, ${curators.length} curators, 3 launch formats.`);

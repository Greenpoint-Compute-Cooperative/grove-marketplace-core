import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { getRuntimeConfig } from "../lib/server/config.js";
import { inspectWebhook, stagingOrigin, testStripeClient, SetupError } from "./stripe-setup.mjs";

const check = (id, okay, needs) => ({ id, status: okay ? "ready" : "blocked", ...(okay ? {} : { needs }) });

// Report configuration names, never values. Disabled feature flags must not
// hide requirements for the requested primary auction rehearsal.
export function localLaunchChecks(config = getRuntimeConfig(), env = process.env) {
  let originOkay = false;
  try { stagingOrigin(env); originOkay = true; } catch {}
  const checks = [
    check("staging-origin", originOkay, "Canonical HTTPS GROVE_SITE_URL, VERCEL_TARGET_ENV=staging, GROVE_ETHEREUM_CHAIN_ID=11155111; no production runtime"),
    check("database", config.backendConfigured && config.supabaseSecretKey, "SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY), SUPABASE_SECRET_KEY"),
    check("database-isolation", config.syntheticSocialAuth.projectRefMatches, "GROVE_STAGING_SUPABASE_PROJECT_REF must match the staging SUPABASE_URL"),
    check("test-stripe-key", /^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(config.commerce.stripeSecretKey), "STRIPE_SECRET_KEY from the staging Stripe sandbox/test environment; no live keys"),
    check("webhook-secret", /^whsec_[A-Za-z0-9]+$/.test(config.commerce.stripeWebhookSecret), "STRIPE_WEBHOOK_SECRET for the deployed endpoint, not a stripe listen forwarding secret"),
    check("automatic-tax", config.commerce.automaticTax, "GROVE_STRIPE_AUTOMATIC_TAX=true and configured Stripe Tax settings"),
    check("stripe-nft-approval", config.auctions.stripeNftApprovalRef, "GROVE_STRIPE_NFT_APPROVAL_REF referencing actual provider approval for this business model"),
    check("auction-terms", config.auctions.termsUrl && config.auctions.termsVersion && config.auctions.termsHash,
      "GROVE_AUCTION_TERMS_URL, GROVE_AUCTION_TERMS_VERSION, GROVE_AUCTION_TERMS_HASH for reviewed published terms"),
    check("bid-limit", config.auctions.maximumFiatHammerMinor, "GROVE_MAX_FIAT_HAMMER_MINOR (50 to 100000000 minor units)"),
    check("worker-auth", config.cronSecret, "CRON_SECRET scoped to staging and matching the private scheduler secret"),
    check("member-login", config.syntheticSocialAuth.configured || config.providers.instagram.enabled || config.providers.x.enabled,
      "A configured social provider or isolated staging synthetic login; actual sign-in must still be rehearsed"),
    check("wallet-enabled", config.wallet.enabled, "GROVE_WALLET_ENABLED=true"),
    check("auctions-enabled", config.auctions.enabled, "GROVE_AUCTIONS_ENABLED=true after provider, terms, and inventory setup"),
    check("inventory-safe", config.auctions.inventorySafeSingletonAddress && config.auctions.inventorySafeSingletonCodeHash,
      "GROVE_INVENTORY_SAFE_SINGLETON_ADDRESS and GROVE_INVENTORY_SAFE_SINGLETON_CODE_HASH")
  ];
  for (const [field, variable] of Object.entries({
    rpcUrl: "GROVE_ETHEREUM_RPC_URL", entryPointAddress: "GROVE_ENTRY_POINT_ADDRESS",
    safeFactoryAddress: "GROVE_SAFE_FACTORY_ADDRESS", safeSingletonAddress: "GROVE_SAFE_SINGLETON_ADDRESS",
    safeFallbackHandlerAddress: "GROVE_SAFE_FALLBACK_HANDLER_ADDRESS", safeWebAuthnSharedSignerAddress: "GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS",
    safe4337ModuleAddress: "GROVE_SAFE_4337_MODULE_ADDRESS", safePasskeyVerifierAddress: "GROVE_SAFE_PASSKEY_VERIFIER_ADDRESS",
    safeModuleSetupAddress: "GROVE_SAFE_MODULE_SETUP_ADDRESS", safeMultiSendAddress: "GROVE_SAFE_MULTISEND_ADDRESS",
    entryPointCodeHash: "GROVE_ENTRY_POINT_CODE_HASH", safeFactoryCodeHash: "GROVE_SAFE_FACTORY_CODE_HASH",
    safeProxyCodeHash: "GROVE_SAFE_PROXY_CODE_HASH", safeSingletonCodeHash: "GROVE_SAFE_SINGLETON_CODE_HASH",
    safeFallbackHandlerCodeHash: "GROVE_SAFE_FALLBACK_HANDLER_CODE_HASH", safeWebAuthnSharedSignerCodeHash: "GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_CODE_HASH",
    safe4337ModuleCodeHash: "GROVE_SAFE_4337_MODULE_CODE_HASH", safePasskeyVerifierCodeHash: "GROVE_SAFE_PASSKEY_VERIFIER_CODE_HASH",
    safeModuleSetupCodeHash: "GROVE_SAFE_MODULE_SETUP_CODE_HASH", safeMultiSendCodeHash: "GROVE_SAFE_MULTISEND_CODE_HASH"
  })) checks.push(check(`wallet:${field}`, config.wallet[field], variable));
  checks.push(check("wallet-runtime-readiness", config.wallet.rehearsalReady,
    "Validated member Safe tuple; fallback handler must match the Safe 4337 module address and code hash"));
  checks.push(check("auction-runtime-readiness", config.auctions.rehearsalReady,
    "All primary-auction runtime requirements must pass together"));
  return checks;
}

const fetchJson = async (fetcher, url, options = {}) => {
  const response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status !== 200) throw new Error("DEPLOYMENT_UNAVAILABLE");
  return response.json();
};

export async function remoteLaunchChecks({ config = getRuntimeConfig(), env = process.env, fetcher = fetch, stripe, database }) {
  const origin = stagingOrigin(env);
  const provider = stripe || testStripeClient(env);
  const results = [];
  let health;
  try {
    health = await fetchJson(fetcher, `${origin}/api/health`);
    results.push(check("deployed-staging", health.status === "ok" && health.database === "reachable"
      && health.runtime?.environment === "staging" && health.runtime?.platformEnvironment !== "production",
    "The canonical staging alias must serve staging and reach its database"));
  } catch { results.push(check("deployed-staging", false, "Reachable staging health endpoint without redirects or deployment protection")); }
  // Do not send even a synthetic signature until the destination identifies as staging.
  const isolated = results[0].status === "ready";
  if (isolated) {
    try {
      const deployed = await fetchJson(fetcher, `${origin}/api/config`);
      results.push(check("deployed-auction", deployed.wallet?.chainId === 11155111
        && deployed.wallet?.configured === true && deployed.auctions?.configured === true
        && deployed.auctions?.environment === "sepolia-rehearsal", "Deploy the checked staging auction configuration"));
      const catalog = await fetchJson(fetcher, `${origin}/api/catalog`);
      const now = Date.now();
      const candidates = (catalog.auctions || []).filter((auction) => auction.state === "open"
        && auction.chain_id === 11155111 && auction.settlement_rail === "card" && auction.bid_currency === "USD"
        && Date.parse(auction.opens_at) <= now && Date.parse(auction.closes_at) > now
        && (!env.GROVE_PREVIEW_AUCTION_ID || auction.id === env.GROVE_PREVIEW_AUCTION_ID));
      results.push(check("open-rehearsal-lot", candidates.length === 1,
        "One open finalized-inventory Sepolia card/USD auction; select GROVE_PREVIEW_AUCTION_ID if several exist"));
      if (candidates.length === 1 && config.syntheticSocialAuth.projectRefMatches && config.supabaseSecretKey) {
        const service = database || createClient(config.supabaseUrl, config.supabaseSecretKey, {
          auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
        });
        const { data: work, error } = await service.from("works")
          .select("stripe_tax_code,requires_shipping,stripe_shipping_rate_id,nft_custody_state,nft_finalized_at,contract_status")
          .eq("id", candidates[0].work_id).maybeSingle();
        results.push(check("lot-settlement-data", !error && /^txcd_[0-9]+$/.test(work?.stripe_tax_code || "")
          && (!work.requires_shipping || Boolean(work.stripe_shipping_rate_id))
          && work.nft_custody_state === "inventory-safe" && Boolean(work.nft_finalized_at) && work.contract_status === "minted",
        "Rehearsal lot needs a reviewed Stripe tax code, shipping rate if applicable, and recorded finalized inventory custody"));
      } else results.push(check("lot-settlement-data", false,
        "Select a single rehearsal lot and provide the isolated staging database service configuration to verify settlement data"));
    } catch { results.push(check("deployed-auction-catalog", false, "Working deployed configuration and auction catalog")); }
    if (/^whsec_[A-Za-z0-9]+$/.test(config.commerce.stripeWebhookSecret)) {
      try {
        // Unknown events return before any database write in the webhook handler.
        const payload = JSON.stringify({ id: `evt_probe_${randomUUID()}`, object: "event", livemode: false,
          created: Math.floor(Date.now() / 1000), type: "grove.configuration_probe", data: { object: {} } });
        const signature = provider.webhooks.generateTestHeaderString({ payload, secret: config.commerce.stripeWebhookSecret });
        const observed = await fetchJson(fetcher, `${origin}/api/stripe/webhook`, {
          method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: payload
        });
        results.push(check("deployed-webhook-signature", observed.received === true && observed.ignored === true,
          "The local and deployed webhook signing secrets must match"));
      } catch { results.push(check("deployed-webhook-signature", false, "Deploy matching STRIPE_WEBHOOK_SECRET and backend/Stripe settings")); }
    } else results.push(check("deployed-webhook-signature", false, "A valid STRIPE_WEBHOOK_SECRET is required for the harmless signed probe"));
  }
  try {
    const webhook = await inspectWebhook(provider, origin);
    results.push(check("stripe-webhook-settings", webhook.ready,
      "Enabled Stripe test webhook at the canonical route with exact event set and the installed SDK API version; run stripe-setup"));
  } catch { results.push(check("stripe-webhook-settings", false, "Readable Stripe test webhook settings without duplicate endpoints")); }
  try {
    const tax = await provider.tax.settings.retrieve();
    results.push(check("stripe-tax-active", tax.livemode === false && tax.status === "active",
      "Active Stripe Tax settings in the same test account; configure head office/defaults through Stripe"));
  } catch { results.push(check("stripe-tax-active", false, "Read access to configured Stripe Tax settings in the test account")); }
  return results;
}

export function launchReport(checks, { remote = false } = {}) {
  return {
    scope: "primary-card-auction-sepolia",
    configurationReady: checks.filter((entry) => !entry.id.startsWith("remote:")).every((entry) => entry.status === "ready"),
    readyToStartRehearsal: remote && checks.every((entry) => entry.status === "ready"),
    oneShotAutomationReady: false,
    endToEndVerified: false,
    checks,
    remainingExecution: [
      "Verify the auction work tax code, seller/rights/license and finalized inventory evidence before bidding.",
      "Complete real member sign-in, passkey wallet activation, hosted payment setup, and signed bid in the browser.",
      "Run close and settlement via the private staging scheduler; verify current Stripe payment, tax transaction and database state.",
      "Wait the configured risk hold; authorize release from fresh provider evidence, review and execute the exact inventory Safe packet with its owner quorum, then reconcile finalized delivery.",
      "Test decline/action-required cure, refunds, disputes, duplicate webhooks and device-specific Apple Pay before production promotion."
    ],
    separateCapabilities: [
      "Gasless resale and NFT exit additionally need paymaster funding/policy and release attestations.",
      "Instagram bot automation requires Meta credentials; OpenSea/mainnet activation is a separate production release."
    ]
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log("Usage: node scripts/check-launch.mjs [--remote] [--json]\nChecks primary Sepolia auction readiness. Default is offline and never ready to start. --remote reads staging/Stripe and sends only an ignored signed webhook probe. No checkout, charge, seed, release, or chain transaction is created.");
    return;
  }
  if (args.some((arg) => !["--remote", "--json"].includes(arg))) throw new SetupError("Only --remote, --json or --help is accepted.");
  const remote = args.includes("--remote");
  const checks = localLaunchChecks();
  if (remote) {
    try { checks.push(...(await remoteLaunchChecks({})).map((entry) => ({ ...entry, id: `remote:${entry.id}` }))); }
    catch { checks.push(check("remote:connection-prerequisites", false, "Validated staging origin, Sepolia chain and Stripe test key are required before remote checks")); }
  }
  const report = launchReport(checks, { remote });
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.readyToStartRehearsal ? "Primary Sepolia auction preflight passed; the browser/operator rehearsal is still required." : "Primary Sepolia auction rehearsal is blocked:");
    for (const entry of checks.filter((item) => item.status !== "ready")) console.log(`- ${entry.needs}`);
    if (!remote) console.log("- Run --remote after local configuration is complete to verify the deployed stack and Stripe.");
    console.log("Unattended end-to-end auction execution is not implemented. See docs/STRIPE_LAUNCH.md for the payment and Safe-delivery rehearsal.");
  }
  if (!report.readyToStartRehearsal) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Launch check failed; no private configuration or provider data was printed."); process.exitCode = 1; });
}

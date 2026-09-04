import assert from "node:assert/strict";
import Stripe from "stripe";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod, lstat, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getRuntimeConfig } from "../lib/server/config.js";
import { inspectWebhook, localSecretStore, setupWebhook, stagingOrigin, testStripeClient, WEBHOOK_EVENTS, WEBHOOK_FILE } from "../scripts/stripe-setup.mjs";
import { launchReport, localLaunchChecks, remoteLaunchChecks } from "../scripts/check-launch.mjs";

const origin = "https://staging.example.com";
const env = { VERCEL_TARGET_ENV: "staging", VERCEL_ENV: "preview", GROVE_ETHEREUM_CHAIN_ID: "11155111", GROVE_SITE_URL: origin,
  STRIPE_SECRET_KEY: ["sk", "test", "fixture"].join("_") };
assert.equal(stagingOrigin(env), origin);
for (const patch of [{ VERCEL_ENV: "production" }, { VERCEL_TARGET_ENV: "production" }, { GROVE_ETHEREUM_CHAIN_ID: "1" },
  { GROVE_SITE_URL: "https://127.0.0.1" }, { GROVE_SITE_URL: "https://name:secret@staging.example.com" },
  { GROVE_SITE_URL: `${origin}/api` }, { GROVE_SITE_URL: `${origin}?token=private` }, { GROVE_SITE_URL: "http://staging.example.com" }]) {
  assert.throws(() => stagingOrigin({ ...env, ...patch }));
}
assert.throws(() => testStripeClient({ ...env, STRIPE_SECRET_KEY: ["sk", "live", "fixture"].join("_") }), /test\/sandbox/);
const realClient = testStripeClient(env); // Constructor only; all provider requests below are mocked.
const handler = await readFile(new URL("../api/stripe/webhook.js", import.meta.url), "utf8");
const accepted = handler.match(/const acceptedEvents = new Set\(\[([\s\S]*?)\]\);/)[1];
assert.deepEqual([...WEBHOOK_EVENTS].sort(), [...accepted.matchAll(/"([a-z_.]+)"/g)].map((entry) => entry[1]).sort());

const endpoint = (extra = {}) => ({ id: "we_fixture", url: `${origin}/api/stripe/webhook`, livemode: false,
  enabled_events: [...WEBHOOK_EVENTS], status: "enabled", api_version: Stripe.API_VERSION,
  metadata: { managed_by: "grove-stripe-setup-v1" }, ...extra });
function mockStripe(initial = []) {
  let entries = initial;
  const calls = [];
  const stripe = {
    calls, webhooks: realClient.webhooks,
    webhookEndpoints: {
      list: async (args) => { calls.push(["list", args]); return { data: entries, has_more: false }; },
      create: async (args, options) => {
        calls.push(["create", args, options]);
        entries = [endpoint({ ...args })];
        return { ...entries[0], secret: ["whsec", "fixtureSecret"].join("_") };
      },
      update: async (id, args) => { calls.push(["update", id, args]); entries = [endpoint()]; return entries[0]; }
    },
    tax: { settings: { retrieve: async () => ({ livemode: false, status: "active" }) } }
  };
  return stripe;
}
let stripe = mockStripe();
assert.equal((await setupWebhook({ stripe, origin })).action, "create-test-webhook");
assert.equal(stripe.calls.filter(([name]) => name !== "list").length, 0, "Default must be read-only");
await assert.rejects(() => setupWebhook({ stripe, origin, apply: true, store: { exists: true } }), /never overwritten/);
stripe = mockStripe([endpoint(), endpoint({ id: "we_duplicate" })]);
await assert.rejects(() => inspectWebhook(stripe, origin), /Multiple/);
stripe = mockStripe([endpoint({ livemode: true })]);
await assert.rejects(() => inspectWebhook(stripe, origin), /non-test/);
stripe = mockStripe([endpoint({ enabled_events: ["*"], metadata: {} })]);
await assert.rejects(() => setupWebhook({ stripe, origin, apply: true }), /not created by this tool/);
stripe = mockStripe([endpoint({ api_version: "2020-08-27" })]);
await assert.rejects(() => setupWebhook({ stripe, origin, apply: true }), /API version/);
stripe = mockStripe([endpoint({ enabled_events: ["*"], status: "disabled" })]);
assert.equal((await setupWebhook({ stripe, origin, apply: true })).action, "updated");
assert.deepEqual(stripe.calls.find(([name]) => name === "update")[2], { enabled_events: [...WEBHOOK_EVENTS], disabled: false });
stripe = mockStripe([endpoint()]);
assert.equal((await setupWebhook({ stripe, origin, apply: true })).action, "unchanged");
assert.equal(stripe.calls.some(([name]) => name === "create" || name === "update"), false);

// A matching endpoint on a later page prevents accidental duplicate creation.
const paginated = mockStripe();
paginated.webhookEndpoints.list = async (args) => args.starting_after
  ? { data: [endpoint()], has_more: false }
  : { data: [endpoint({ id: "we_other", url: "https://other.example.com/webhook" })], has_more: true };
assert.equal((await inspectWebhook(paginated, origin)).ready, true);

const temp = await mkdtemp(path.join(os.tmpdir(), "grove-stripe-test-"));
try {
  execFileSync("git", ["init", "-q", temp], { stdio: "ignore" });
  await writeFile(path.join(temp, ".gitignore"), ".env*.local\n");
  const store = await localSecretStore(temp);
  stripe = mockStripe();
  const created = await setupWebhook({ stripe, origin, apply: true, store });
  assert.equal(created.action, "created");
  assert.equal((await lstat(path.join(temp, WEBHOOK_FILE))).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(created), /whsec_|we_fixture/, "Result must not expose secrets or account metadata");
  const saved = await localSecretStore(temp);
  assert.equal(saved.hasSecret, true);
  assert.equal(saved.endpointId, "we_fixture");
  const repeat = await setupWebhook({ stripe, origin, apply: true, store: saved });
  assert.equal(repeat.action, "unchanged");
  assert.equal(stripe.calls.filter(([name]) => name === "create").length, 1);
  await chmod(path.join(temp, WEBHOOK_FILE), 0o644);
  await assert.rejects(() => localSecretStore(temp), /private file/);
  await rm(path.join(temp, WEBHOOK_FILE));
  await symlink(path.join(temp, ".gitignore"), path.join(temp, WEBHOOK_FILE));
  await assert.rejects(() => localSecretStore(temp), /private file/);
  await rm(path.join(temp, WEBHOOK_FILE));
  const failed = mockStripe();
  failed.webhookEndpoints.create = async () => { throw new Error("uncertain network response with secret-like data"); };
  await assert.rejects(async () => setupWebhook({ stripe: failed, origin, apply: true, store: await localSecretStore(temp) }));
  assert.equal((await localSecretStore(temp)).exists, false, "Only an empty reserved file is removed on failed create");
} finally { await rm(temp, { recursive: true, force: true }); }

const config = getRuntimeConfig();
const local = localLaunchChecks(config, {});
assert.equal(local.find((entry) => entry.id === "staging-origin").status, "blocked");
assert.equal(launchReport([{ id: "fixture", status: "ready" }]).readyToStartRehearsal, false);
assert.equal(launchReport([{ id: "fixture", status: "ready" }], { remote: true }).oneShotAutomationReady, false);
const blockedRemote = [];
const remoteConfig = { ...config,
  supabaseSecretKey: "fixture", syntheticSocialAuth: { ...config.syntheticSocialAuth, projectRefMatches: true },
  commerce: { ...config.commerce, stripeWebhookSecret: ["whsec", "fixtureSecret"].join("_") } };
const refused = await remoteLaunchChecks({ config: remoteConfig, env, stripe: mockStripe([endpoint()]), fetcher: async (url) => {
  blockedRemote.push(url); return Response.json({ status: "ok", database: "reachable", runtime: { environment: "production" } });
} });
assert.equal(refused[0].status, "blocked");
assert.equal(blockedRemote.length, 1, "Never send a signed probe to a production destination");
const fakeDatabase = (work) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: work, error: null }) }) }) }) });
const fetcher = async (url, options) => {
  assert.equal(options.redirect, "error");
  if (url.endsWith("/api/health")) return Response.json({ status: "ok", database: "reachable", runtime: { environment: "staging", platformEnvironment: "preview" } });
  if (url.endsWith("/api/config")) return Response.json({ wallet: { configured: true, chainId: 11155111 }, auctions: { configured: true, environment: "sepolia-rehearsal" } });
  if (url.endsWith("/api/catalog")) return Response.json({ auctions: [{ id: "fixture-auction", work_id: "fixture-work", state: "open",
    chain_id: 11155111, settlement_rail: "card", bid_currency: "USD", opens_at: new Date(Date.now() - 60_000).toISOString(), closes_at: new Date(Date.now() + 60_000).toISOString() }] });
  if (url.endsWith("/api/stripe/webhook")) {
    const event = realClient.webhooks.constructEvent(options.body, options.headers["stripe-signature"], remoteConfig.commerce.stripeWebhookSecret);
    assert.equal(event.type, "grove.configuration_probe");
    assert.equal(WEBHOOK_EVENTS.includes(event.type), false);
    return Response.json({ received: true, ignored: true });
  }
  throw new Error("Unexpected request");
};
const lot = { stripe_tax_code: "txcd_10000000", nft_custody_state: "inventory-safe", nft_finalized_at: new Date().toISOString(), contract_status: "minted" };
const readyRemote = await remoteLaunchChecks({ config: remoteConfig, env, stripe: mockStripe([endpoint()]), fetcher, database: fakeDatabase(lot) });
assert.ok(readyRemote.every((entry) => entry.status === "ready"));
const missingTax = await remoteLaunchChecks({ config: remoteConfig, env, stripe: mockStripe([endpoint()]), fetcher, database: fakeDatabase({ ...lot, stripe_tax_code: null }) });
assert.equal(missingTax.find((entry) => entry.id === "lot-settlement-data").status, "blocked");

// Run the real seeder with fixture configuration. Invalid/missing tax choices
// must fail before any chain read or database write; a valid format proceeds to
// the next missing evidence guard, not to an external request.
const seedEnv = {
  ...env, PATH: process.env.PATH, GROVE_SEED_TARGET: "preview", GROVE_PREVIEW_PROJECT_REF: "abcdefghijklmnopqrst",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", SUPABASE_PUBLISHABLE_KEY: "fixture", SUPABASE_SECRET_KEY: "fixture",
  STRIPE_WEBHOOK_SECRET: ["whsec", "fixture"].join("_"), GROVE_STRIPE_AUTOMATIC_TAX: "true", CRON_SECRET: "fixture",
  GROVE_WALLET_ENABLED: "true", GROVE_AUCTIONS_ENABLED: "true", GROVE_ETHEREUM_RPC_URL: "https://rpc.example.com",
  GROVE_STRIPE_NFT_APPROVAL_REF: "fixture-only", GROVE_AUCTION_TERMS_URL: "https://staging.example.com/terms",
  GROVE_AUCTION_TERMS_VERSION: "fixture", GROVE_AUCTION_TERMS_HASH: `0x${"1".repeat(64)}`, GROVE_MAX_FIAT_HAMMER_MINOR: "100"
};
for (const field of ["ENTRY_POINT", "SAFE_FACTORY", "SAFE_SINGLETON", "INVENTORY_SAFE_SINGLETON", "SAFE_FALLBACK_HANDLER",
  "SAFE_WEBAUTHN_SHARED_SIGNER", "SAFE_4337_MODULE", "SAFE_PASSKEY_VERIFIER", "SAFE_MODULE_SETUP", "SAFE_MULTISEND"]) {
  seedEnv[`GROVE_${field}_ADDRESS`] = `0x${"1".repeat(40)}`;
  seedEnv[`GROVE_${field}_CODE_HASH`] = `0x${"1".repeat(64)}`;
}
seedEnv.GROVE_SAFE_PROXY_CODE_HASH = `0x${"1".repeat(64)}`;
for (const taxCode of ["", "guess", "txcd_invalid", "txcd_123\nextra"]) {
  const child = spawnSync(process.execPath, ["scripts/seed-sepolia-auction.mjs"], { env: { ...seedEnv, GROVE_PREVIEW_STRIPE_TAX_CODE: taxCode }, encoding: "utf8" });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /GROVE_PREVIEW_STRIPE_TAX_CODE must be an explicitly reviewed/);
}
const nextGuard = spawnSync(process.execPath, ["scripts/seed-sepolia-auction.mjs"], { env: { ...seedEnv, GROVE_PREVIEW_STRIPE_TAX_CODE: "txcd_10000000" }, encoding: "utf8" });
assert.match(nextGuard.stderr, /GROVE_PREVIEW_NFT_STANDARD must be/);

console.log("Stripe setup, secret handling, launch readiness and Sepolia tax guards passed (no external calls).");

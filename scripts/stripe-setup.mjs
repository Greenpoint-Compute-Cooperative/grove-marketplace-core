import Stripe from "stripe";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep this in sync with api/stripe/webhook.js; tests check the complete set.
export const WEBHOOK_EVENTS = Object.freeze([
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed", "checkout.session.expired",
  "setup_intent.succeeded", "setup_intent.setup_failed", "setup_intent.canceled",
  "payment_intent.succeeded", "payment_intent.processing", "payment_intent.requires_action",
  "payment_intent.payment_failed", "payment_intent.canceled", "review.opened", "review.closed",
  "radar.early_fraud_warning.created", "radar.early_fraud_warning.updated",
  "refund.created", "refund.updated", "refund.failed", "charge.dispute.created", "charge.dispute.closed"
]);
export const WEBHOOK_FILE = ".env.stripe-webhook.local";
const OWNER = "grove-stripe-setup-v1";
const fail = (message) => { throw new SetupError(message); };
export class SetupError extends Error {}

export function stagingOrigin(env = process.env) {
  if (env.VERCEL_ENV === "production" || env.VERCEL_TARGET_ENV !== "staging"
    || env.GROVE_ETHEREUM_CHAIN_ID !== "11155111") {
    fail("Use VERCEL_TARGET_ENV=staging and GROVE_ETHEREUM_CHAIN_ID=11155111 outside Production.");
  }
  let url;
  try { url = new URL(env.GROVE_SITE_URL); } catch { fail("GROVE_SITE_URL must be the canonical HTTPS staging origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || url.search || url.hash || url.pathname !== "/"
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname)
    || /\.(?:localhost|local|internal|invalid|test|example)$/i.test(url.hostname)) {
    fail("GROVE_SITE_URL must be a public HTTPS staging origin without credentials, port, path, query, or fragment.");
  }
  return url.origin;
}

export function testStripeClient(env = process.env) {
  if (!/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || "")) {
    fail("STRIPE_SECRET_KEY must be a Stripe test/sandbox secret or restricted key; live keys are refused.");
  }
  return new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 });
}

export async function inspectWebhook(stripe, origin) {
  const endpoints = [];
  let starting_after;
  do {
    const page = await stripe.webhookEndpoints.list({ limit: 100, ...(starting_after ? { starting_after } : {}) });
    if (page.data.some((entry) => entry.livemode !== false)) fail("Stripe returned a non-test webhook. No change was made.");
    endpoints.push(...page.data.filter((entry) => entry.url === `${origin}/api/stripe/webhook`));
    if (!page.has_more) break;
    starting_after = page.data.at(-1)?.id;
    if (!starting_after) fail("Stripe webhook pagination could not be verified.");
  } while (true);
  if (endpoints.length > 1) fail("Multiple Stripe endpoints target staging. Resolve duplicate deliveries in Stripe before setup.");
  const endpoint = endpoints[0] || null;
  const eventsMatch = endpoint && endpoint.enabled_events.length === WEBHOOK_EVENTS.length
    && WEBHOOK_EVENTS.every((type) => endpoint.enabled_events.includes(type));
  return {
    endpoint,
    managed: endpoint?.metadata?.managed_by === OWNER,
    eventsMatch: Boolean(eventsMatch),
    versionMatch: endpoint?.api_version === Stripe.API_VERSION,
    ready: Boolean(endpoint && endpoint.status === "enabled" && eventsMatch && endpoint.api_version === Stripe.API_VERSION)
  };
}

// Never overwrite an operator file or follow a symlink. Require an ignored,
// untracked path before asking Stripe to return its one-time signing secret.
export async function localSecretStore(cwd = process.cwd()) {
  const filename = path.join(cwd, WEBHOOK_FILE);
  try {
    const tracked = execFileSync("git", ["ls-files", "--", WEBHOOK_FILE], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (tracked) fail("The webhook secret file is tracked. Remove it from version control before setup.");
    execFileSync("git", ["check-ignore", "-q", "--", WEBHOOK_FILE], { cwd, stdio: "ignore" });
  } catch (error) {
    if (error instanceof SetupError) throw error;
    fail("The webhook secret output must be gitignored in this Git checkout.");
  }
  let existing;
  try {
    if ((await lstat(filename)).isSymbolicLink()) fail("The existing webhook secret file must be a regular private file, not a symlink.");
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > 10_000
        || (process.getuid && stat.uid !== process.getuid())) {
        fail("The existing webhook secret file must be a regular private file (mode 0600, owned by this user, no hard links).");
      }
      existing = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const endpointId = existing?.match(/^GROVE_STRIPE_WEBHOOK_ENDPOINT_ID=(we_[A-Za-z0-9]+)$/m)?.[1];
  const hasSecret = /^STRIPE_WEBHOOK_SECRET=whsec_[A-Za-z0-9]+$/m.test(existing || "");
  return {
    exists: existing !== undefined,
    endpointId,
    hasSecret,
    async reserve() {
      const handle = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      return {
        async save(endpoint) {
          if (!/^whsec_[A-Za-z0-9]+$/.test(endpoint.secret || "") || !/^we_[A-Za-z0-9]+$/.test(endpoint.id || "")) {
            fail("Stripe did not return a valid webhook signing secret. Recover it in the Stripe Dashboard.");
          }
          await handle.writeFile(`STRIPE_WEBHOOK_SECRET=${endpoint.secret}\nGROVE_STRIPE_WEBHOOK_ENDPOINT_ID=${endpoint.id}\n`);
          await handle.sync();
        },
        async close() { await handle.close(); },
        async removeEmpty() {
          await handle.close();
          if ((await lstat(filename)).size === 0) await unlink(filename);
        }
      };
    }
  };
}

export async function setupWebhook({ stripe, origin, apply = false, store }) {
  const state = await inspectWebhook(stripe, origin);
  if (!apply) return {
    mode: "check", ready: state.ready,
    action: !state.endpoint ? "create-test-webhook" : state.ready ? "none"
      : !state.managed ? "review-existing-unmanaged-webhook" : !state.versionMatch ? "review-webhook-api-version" : "update-test-webhook",
    signingSecret: store?.endpointId === state.endpoint?.id && store?.hasSecret ? "saved-locally" : "not-verified"
  };
  if (state.endpoint) {
    if (!state.managed && !state.ready) fail("Existing webhook was not created by this tool. Review its settings in Stripe; it will not be changed.");
    if (!state.versionMatch) fail("Existing webhook API version differs from the installed SDK. Review the version in Stripe; automatic replacement is disabled.");
    if (!state.ready) await stripe.webhookEndpoints.update(state.endpoint.id, { enabled_events: [...WEBHOOK_EVENTS], disabled: false });
    const verified = await inspectWebhook(stripe, origin);
    if (!verified.ready) fail("Stripe webhook did not converge to the expected settings.");
    return { mode: "apply", ready: true, action: state.ready ? "unchanged" : "updated",
      signingSecret: store?.endpointId === state.endpoint.id && store?.hasSecret ? "saved-locally" : "recover-from-stripe-dashboard" };
  }
  if (!store || store.exists) fail("New webhook creation requires an absent ignored local secret file. Existing files are never overwritten.");
  const reservation = await store.reserve();
  let created = false;
  try {
    const endpoint = await stripe.webhookEndpoints.create({
      url: `${origin}/api/stripe/webhook`, enabled_events: [...WEBHOOK_EVENTS],
      api_version: Stripe.API_VERSION, connect: false,
      description: "Marketplace staging payment events",
      metadata: { managed_by: OWNER, environment: "staging" }
    }, { idempotencyKey: `grove-staging-webhook-${createHash("sha256").update(`${origin}:${Stripe.API_VERSION}`).digest("hex")}` });
    created = true;
    if (endpoint.livemode !== false) fail("Stripe returned a non-test webhook; inspect the endpoint in the Dashboard.");
    await reservation.save(endpoint);
    await reservation.close();
    if (endpoint.url !== `${origin}/api/stripe/webhook` || endpoint.status !== "enabled"
      || endpoint.api_version !== Stripe.API_VERSION || endpoint.enabled_events.length !== WEBHOOK_EVENTS.length
      || !WEBHOOK_EVENTS.every((type) => endpoint.enabled_events.includes(type))) {
      fail("Created webhook settings differ from the requested configuration. Its secret was retained locally; inspect Stripe before continuing.");
    }
    return { mode: "apply", ready: true, action: "created", signingSecret: "saved-locally" };
  } catch (error) {
    if (!created) await reservation.removeEmpty();
    else await reservation.close().catch(() => {});
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log("Usage: node scripts/stripe-setup.mjs [--apply]\nRead-only by default. --apply creates or updates only the staging test webhook.\nCredentials come from environment variables, never arguments. The signing secret is saved to an ignored mode-0600 local file. See docs/STRIPE_LAUNCH.md.");
    return;
  }
  if (args.some((arg) => arg !== "--apply") || args.length > 1) fail("Only --apply or --help is accepted. Supply secrets through the environment.");
  const origin = stagingOrigin();
  const stripe = testStripeClient();
  const store = await localSecretStore();
  const result = await setupWebhook({ stripe, origin, apply: args.includes("--apply"), store });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof SetupError ? error.message : "Stripe setup failed. No provider response or secret was printed. Inspect Stripe access/settings and retry the same command; do not create duplicate endpoints.");
    process.exitCode = 1;
  });
}

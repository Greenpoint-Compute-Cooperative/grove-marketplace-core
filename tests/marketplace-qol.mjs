import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicMarketStats, marketStatsEtag } from "../lib/server/market-stats.js";
import {
  normalizeInstagramWebhook,
  secureTokenEqual,
  verifyInstagramWebhookSignature
} from "../lib/server/instagram-webhook.js";
import { GET as verifyInstagramWebhook, POST as receiveInstagramWebhook } from "../api/webhooks/instagram.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFile(join(root, path), "utf8");
const [app, vercelConfigText, migration, runtimeConfig, indexRoute] = await Promise.all([
  read("app.js"),
  read("vercel.json"),
  read("supabase/migrations/20260911000000_marketplace_media_social_stats.sql"),
  read("lib/server/config.js"),
  read("api/cron/resale-index.js")
]);
const vercelConfig = JSON.parse(vercelConfigText);

assert.deepEqual(vercelConfig.images.formats, ["image/avif", "image/webp"]);
assert.deepEqual(vercelConfig.images.domains, []);
assert.ok(vercelConfig.images.minimumCacheTTL >= 2_678_400);
assert.equal(vercelConfig.images.dangerouslyAllowSVG, false);
assert.ok(vercelConfig.images.sizes.length <= 12, "image widths stay bounded");
assert.ok(vercelConfig.images.qualities.length <= 3, "image qualities stay bounded");
assert.ok(vercelConfig.images.remotePatterns.every((pattern) =>
  pattern.pathname.includes("marketplace-media/sha256/")), "remote optimization accepts only content-addressed managed media");
assert.match(app, /const responsiveImage/);
assert.match(app, /srcset=/);
assert.match(app, /loading="\$\{priority \? "eager" : "lazy"\}"/);
assert.match(app, /fetchpriority=/);
assert.match(app, /managedMediaSource\(work\.mediaUrl\)/, "work art never optimizes arbitrary remote URLs");
assert.match(app, /optimizedImageUrl\(source, detail \? 1536 : 750/, "editorial contact sheets are never downloaded full-size on Vercel");
assert.match(app, /mediaWidth: work\.media_width/);

for (const table of ["media_assets", "social_event_inbox", "social_sender_links", "discovery_sources", "indexer_worker_runs", "market_stats_current"]) {
  assert.match(migration, new RegExp(`create table public\\.${table}`), `${table} is migrated`);
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`), `${table} has RLS`);
}
assert.match(migration, /rights_state = 'cleared' and moderation_state = 'approved'/);
assert.match(migration, /refresh_market_stats_current/);
assert.match(runtimeConfig, /config\.secondary\.reconciliationConfigured/);
assert.doesNotMatch(runtimeConfig.match(/export const requireSecondaryIndexerConfig[\s\S]*?\n};/)?.[0] || "", /GROVE_SECONDARY_ENABLED/,
  "the new-action kill switch does not disable reconciliation");
assert.match(indexRoute, /indexer_worker_runs/);
assert.match(indexRoute, /refresh_market_stats_current/);

const secret = "test-instagram-app-secret";
const payload = JSON.stringify({
  object: "instagram",
  entry: [{
    id: "professional-account-1",
    time: 1_788_000_000,
    messaging: [
      { sender: { id: "sender-1" }, timestamp: 1_788_000_000_000, message: { mid: "message-1", text: "save https://instagram.com/p/example/" } },
      { sender: { id: "sender-2" }, timestamp: 1_788_000_000_001, message: { mid: "message-2", text: "private conversation text" } }
    ]
  }]
});
const rawBody = Buffer.from(payload);
const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
assert.equal(verifyInstagramWebhookSignature({ rawBody, signature, appSecret: secret }), true);
assert.equal(verifyInstagramWebhookSignature({ rawBody, signature: `sha256:${"0".repeat(64)}`, appSecret: secret }), false);
assert.equal(secureTokenEqual("one-time-token", "one-time-token"), true);
assert.equal(secureTokenEqual("one-time-token", "other-token"), false);
const events = normalizeInstagramWebhook(JSON.parse(payload));
assert.equal(events.length, 2);
assert.equal(events[0].event_type, "message.save");
assert.equal(events[0].payload.command.url, "https://instagram.com/p/example/");
assert.equal(events[1].event_type, "message.ignored");
assert.equal(JSON.stringify(events[1]).includes("private conversation text"), false,
  "non-command private message copy is not persisted");
assert.throws(() => normalizeInstagramWebhook({ object: "page", entry: [] }), /INSTAGRAM_WEBHOOK_INVALID/);

const readyRow = {
  state: "ready",
  indexed_through_block: "123",
  indexed_through_hash: `0x${"a".repeat(64)}`,
  stats: { catalog: { published_works: 4 } },
  schema_version: "market-stats-v1",
  computed_at: "2026-09-04T12:00:00.000Z"
};
const readyStats = publicMarketStats({
  row: readyRow,
  chainId: 11155111,
  environment: "staging",
  now: Date.parse("2026-09-04T12:05:00.000Z")
});
assert.equal(readyStats.status, "ready");
assert.equal(readyStats.network, "ethereum-sepolia");
assert.equal(readyStats.stats.catalog.published_works, 4);
assert.match(marketStatsEtag(readyStats), /market-stats-v1-11155111-123/);
const staleStats = publicMarketStats({
  row: readyRow,
  chainId: 11155111,
  environment: "staging",
  now: Date.parse("2026-09-04T12:16:00.000Z")
});
assert.equal(staleStats.status, "syncing");
assert.equal(staleStats.reason, "stale-snapshot");
assert.equal(staleStats.stats, null, "stale economics are not publicly presented as current");

const botEnvNames = [
  "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY",
  "GROVE_INSTAGRAM_BOT_ENABLED", "GROVE_INSTAGRAM_WEBHOOK_VERIFY_TOKEN", "GROVE_INSTAGRAM_APP_SECRET"
];
const previous = Object.fromEntries(botEnvNames.map((name) => [name, process.env[name]]));
for (const name of botEnvNames) delete process.env[name];
assert.equal((await verifyInstagramWebhook(new Request("https://marketplace.example/api/webhooks/instagram"))).status, 503);
assert.equal((await receiveInstagramWebhook(new Request("https://marketplace.example/api/webhooks/instagram", {
  method: "POST", body: payload, headers: { "x-hub-signature-256": signature }
}))).status, 503);
for (const [name, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

console.log("Marketplace quality checks passed: managed responsive media, finality-gated stats, and signed social ingestion seams.");

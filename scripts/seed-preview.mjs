import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = String(process.env.SUPABASE_URL || "").trim();
const secret = String(process.env.SUPABASE_SECRET_KEY || "").trim();
const previewRef = String(process.env.GROVE_PREVIEW_PROJECT_REF || "").trim();
const seedTarget = String(process.env.GROVE_SEED_TARGET || "").trim();
const deploymentTarget = String(process.env.VERCEL_TARGET_ENV || process.env.VERCEL_ENV || "local").trim();

assert.equal(seedTarget, "preview", "Set GROVE_SEED_TARGET=preview explicitly.");
assert.ok(url && secret && previewRef, "Preview URL, project ref, and server secret are required.");
assert.equal(new URL(url).hostname, `${previewRef}.supabase.co`, "The URL must match the named preview project.");
assert.notEqual(deploymentTarget, "production", "Preview seed refuses a production target.");
assert.notEqual(process.env.VERCEL_ENV, "production", "Preview seed refuses a production runtime.");

const client = createClient(url, secret, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
});

const works = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "preview-cloud-protocol",
    artist_name: "Preview Artist",
    title: "Cloud Protocol — Preview",
    description: "Synthetic preview record. Not for sale.",
    format: "digital",
    media_url: "https://marketplace.invalid/public/assets/digital-works.svg",
    crypto_amount: "1.000000000000",
    crypto_asset: "USDC",
    chain: "base-sepolia",
    contract_status: "not-configured",
    status: "listed",
    listed_at: "2026-08-24T00:00:00.000Z"
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "preview-nassau-study",
    artist_name: "Preview Artist",
    title: "Nassau Study — Preview",
    description: "Synthetic preview record. Not for sale.",
    format: "physical",
    media_url: "https://marketplace.invalid/public/assets/physical-works.svg",
    price_minor: 100,
    currency: "USD",
    contract_status: "not-configured",
    location: "29 Nassau Avenue · Preview",
    status: "listed",
    listed_at: "2026-08-24T00:00:00.000Z"
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "preview-paired-edition",
    artist_name: "Preview Artist",
    title: "Paired Edition — Preview",
    description: "Synthetic preview record. Not for sale.",
    format: "paired",
    media_url: "https://marketplace.invalid/public/assets/celestial-school.svg",
    price_minor: 100,
    currency: "USD",
    crypto_amount: "1.000000000000",
    crypto_asset: "USDC",
    chain: "base-sepolia",
    contract_status: "not-configured",
    location: "29 Nassau Avenue · Preview",
    status: "listed",
    listed_at: "2026-08-24T00:00:00.000Z"
  }
];

const bazaars = [{
  id: "44444444-4444-4444-8444-444444444444",
  slug: "preview-assembly-of-light",
  title: "Assembly of Light — Preview",
  starts_at: "2026-09-12T16:00:00.000Z",
  ends_at: "2026-09-12T23:00:00.000Z",
  venue: "The School Auditorium",
  address: "29 Nassau Avenue",
  city: "New York",
  summary: "Synthetic preview event. No RSVP is created.",
  status: "published"
}];

const { error: worksError } = await client.from("works").upsert(works, { onConflict: "slug" });
if (worksError) throw worksError;
const { error: bazaarError } = await client.from("bazaar_events").upsert(bazaars, { onConflict: "slug" });
if (bazaarError) throw bazaarError;

console.log(`Seeded ${works.length} synthetic works and ${bazaars.length} synthetic bazaar into the preview project.`);

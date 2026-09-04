import { ConfigurationError, getRuntimeConfig } from "../lib/server/config.js";
import { json, problem } from "../lib/server/http.js";
import { createSupabaseRequestClient, createSupabaseServiceClient } from "../lib/server/supabase.js";

const readyWorkIds = async (works) => {
  const config = getRuntimeConfig();
  if (!config.supabaseSecretKey || !config.commerce.sellerTermsVersion || !config.commerce.buyerTermsUrl
      || !config.commerce.buyerTermsVersion || !config.commerce.maximumItemPriceMinor || works.length === 0) {
    return new Set();
  }

  const service = createSupabaseServiceClient();
  const sellerIds = [...new Set(works.map((work) => work.seller_id).filter(Boolean))];
  const workIds = works.map((work) => work.id);
  const [sellerResult, rightsResult] = await Promise.all([
    sellerIds.length
      ? service.from("sellers").select("id,status,terms_version,terms_accepted_at").in("id", sellerIds)
      : Promise.resolve({ data: [], error: null }),
    service.from("rights_assertions").select("work_id,seller_id,assertion_type,status,expires_at").in("work_id", workIds)
  ]);
  if (sellerResult.error || rightsResult.error) return new Set();

  const sellers = new Map(sellerResult.data.map((seller) => [seller.id, seller]));
  const rights = new Map();
  const now = Date.now();
  for (const assertion of rightsResult.data) {
    if (assertion.status !== "cleared" || (assertion.expires_at && new Date(assertion.expires_at).getTime() <= now)) continue;
    const key = `${assertion.work_id}:${assertion.seller_id}`;
    if (!rights.has(key)) rights.set(key, new Set());
    rights.get(key).add(assertion.assertion_type);
  }

  return new Set(works.filter((work) => {
    const seller = sellers.get(work.seller_id);
    const assertions = rights.get(`${work.id}:${work.seller_id}`) || new Set();
    return work.status === "listed" && work.sale_enabled === true && work.sale_kind === "fixed"
      && work.format === "physical" && work.inventory_available > 0
      && Number.isSafeInteger(work.price_minor) && work.price_minor >= 50
      && work.price_minor <= config.commerce.maximumItemPriceMinor && work.currency === "USD"
      && Boolean(work.stripe_tax_code) && (!work.requires_shipping || Boolean(work.stripe_shipping_rate_id))
      && work.buyer_terms_url === config.commerce.buyerTermsUrl
      && work.buyer_terms_version === config.commerce.buyerTermsVersion && Boolean(work.license_uri)
      && seller?.status === "active" && Boolean(seller.terms_accepted_at)
      && seller.terms_version === config.commerce.sellerTermsVersion
      && ["sale", "media", "physical-fulfillment"].every((type) => assertions.has(type));
  }).map((work) => work.id));
};

export const GET = async (request) => {
  try {
    const config = getRuntimeConfig();
    const { supabase, headers } = createSupabaseRequestClient(request);
    const [worksResult, bazaarsResult, curatorsResult, auctionsResult] = await Promise.all([
      supabase
        .from("works")
        .select("id,slug,title,artist_name,description,format,media_url,media_width,media_height,price_minor,currency,crypto_amount,crypto_asset,chain,contract_address,token_id,contract_status,location,status,curator_id,seller_id,sale_enabled,sale_kind,inventory_available,requires_shipping,stripe_tax_code,stripe_shipping_rate_id,buyer_terms_url,buyer_terms_version,license_uri,listed_at")
        .in("status", ["listed", "reserved", "sold"])
        .order("listed_at", { ascending: false }),
      supabase
        .from("bazaar_events")
        .select("id,slug,title,starts_at,ends_at,venue,address,city,status,summary")
        .eq("status", "published")
        .order("starts_at", { ascending: true }),
      supabase
        .from("curators")
        .select("id,display_name,handle,avatar_url,bio,focus,status,created_at")
        .eq("status", "active"),
      (config.auctions.liveReady || config.auctions.rehearsalReady)
        ? createSupabaseServiceClient()
          .from("public_auctions")
          .select("id,work_id,slug,quantity,settlement_rail,bid_currency,state,opens_at,closes_at,reserve_amount,minimum_increment,current_bid_amount,terms_url,terms_version,nft_token_id,nft_standard,nft_contract_address,chain_id")
          .order("closes_at", { ascending: true })
        : Promise.resolve({ data: [], error: null })
    ]);

    if (worksResult.error || bazaarsResult.error || curatorsResult.error || auctionsResult.error) {
      return problem(502, "catalog_unavailable", "The live catalog could not be loaded.", headers);
    }
    const checkoutReady = await readyWorkIds(worksResult.data);
    const works = worksResult.data.map((work) => {
      const { seller_id, stripe_tax_code, stripe_shipping_rate_id, ...publicWork } = work;
      return { ...publicWork, checkout_ready: checkoutReady.has(work.id) };
    });
    return json({ works, auctions: auctionsResult.data, bazaars: bazaarsResult.data, curators: curatorsResult.data }, { headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "backend_not_configured", "The live catalog is not configured.");
    return problem(500, "unexpected_error", "The live catalog could not be loaded.");
  }
};

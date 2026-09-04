import { timingSafeEqual } from "node:crypto";
import { ConfigurationError, getRuntimeConfig } from "../../lib/server/config.js";
import { json, problem } from "../../lib/server/http.js";
import { publishOpenSeaListing, verifyPublishableResaleOrder } from "../../lib/server/resale.js";
import { createSupabaseServiceClient } from "../../lib/server/supabase.js";

const authorized = (request, expected) => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};

const providerError = (error) => ({
  code: String(error?.status || error?.code || error?.name || "opensea_error").slice(0, 120),
  detail: String(error?.message || "OpenSea publication failed.").slice(0, 1_000)
});

const signatureHex = (value) => {
  const encoded = String(value || "");
  if (encoded.startsWith("\\x")) return `0x${encoded.slice(2)}`;
  if (encoded.startsWith("0x")) return encoded;
  throw new Error("Stored listing signature is invalid.");
};

const completeClaim = async (service, publication, values) => {
  const { data, error } = await service.from("resale_order_publications")
    .update({ ...values, lease_token: null, lease_expires_at: null })
    .eq("id", publication.id).eq("state", "processing").eq("lease_token", publication.lease_token)
    .select("id").maybeSingle();
  if (error) throw error;
  return Boolean(data);
};

export const GET = async (request) => {
  const config = getRuntimeConfig();
  if (!config.cronSecret || !authorized(request, config.cronSecret)) {
    return problem(401, "not_authorized", "Cron authorization is required.");
  }
  if (!config.productionDeployment) return problem(409, "wrong_environment", "OpenSea publication runs only in Production.");
  try {
    if (!config.openSea.liveReady) throw new ConfigurationError("OpenSea publication is not ready.");
    const service = createSupabaseServiceClient();
    const now = new Date();
    const { data: publications, error } = await service.rpc("claim_opensea_publications", {
      p_limit: 10,
      p_lease_seconds: 90
    });
    if (error) return problem(503, "publication_queue_unavailable", "The OpenSea publication queue could not be loaded.");
    const summary = { published: 0, retry: 0, failed: 0, skipped: 0 };
    for (const publication of publications) {
      const { data: order, error: orderError } = await service.from("resale_orders")
        .select("id,work_id,collection_id,seller_smart_account_id,order_hash,order_components,signature,state,end_time_epoch")
        .eq("id", publication.resale_order_id).maybeSingle();
      if (orderError || !order || order.state !== "open" || BigInt(order.end_time_epoch) <= BigInt(Math.floor(Date.now() / 1_000))) {
        const completed = await completeClaim(service, publication, {
          state: "failed", next_attempt_at: null,
          last_error_code: "listing_not_open", last_error_detail: "Local listing is missing, closed, or expired."
        });
        summary[completed ? "failed" : "skipped"] += 1;
        continue;
      }
      try {
        const [workResult, collectionResult, sellerResult] = await Promise.all([
          service.from("works").select("id,format,nft_collection_id,nft_token_id,nft_quantity,contract_status").eq("id", order.work_id).single(),
          service.from("nft_collections").select("id,standard,chain_id,contract_address,deployed_code_hash,state").eq("id", order.collection_id).single(),
          service.from("smart_accounts").select("id,chain_id,account_address,state,recovery_ready,finalized_at").eq("id", order.seller_smart_account_id).single()
        ]);
        if (workResult.error || collectionResult.error || sellerResult.error) throw new Error("OpenSea chain revalidation prerequisites are unavailable.");
        const signature = signatureHex(order.signature);
        const verified = await verifyPublishableResaleOrder({
          config,
          account: sellerResult.data,
          collection: collectionResult.data,
          work: workResult.data,
          order: order.order_components,
          signature
        });
        if (verified.orderHash !== order.order_hash) throw new Error("Stored Seaport order hash changed before publication.");
        const result = await publishOpenSeaListing({ config, order: order.order_components, signature });
        const providerOrderHash = String(result?.orderHash || result?.order_hash || order.order_hash).toLowerCase();
        if (providerOrderHash !== order.order_hash) throw new Error("OpenSea returned a different order hash.");
        const completed = await completeClaim(service, publication, {
          state: "published", provider_order_hash: providerOrderHash, provider_order_ref: providerOrderHash,
          next_attempt_at: null,
          published_at: now.toISOString(), last_error_code: null, last_error_detail: null
        });
        summary[completed ? "published" : "skipped"] += 1;
      } catch (publishError) {
        const attempt = Number(publication.attempt_count);
        const terminal = attempt >= 8;
        const retryAt = terminal ? null : new Date(now.getTime() + Math.min(3_600, 2 ** attempt * 30) * 1_000).toISOString();
        const details = providerError(publishError);
        const completed = await completeClaim(service, publication, {
          state: terminal ? "failed" : "retry",
          next_attempt_at: retryAt, published_at: null, last_error_code: details.code, last_error_detail: details.detail
        });
        summary[completed ? (terminal ? "failed" : "retry") : "skipped"] += 1;
      }
    }
    return json(summary, { status: summary.failed ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "opensea_not_configured", "OpenSea publication is not configured.");
    return problem(500, "unexpected_error", "OpenSea publication did not complete.");
  }
};

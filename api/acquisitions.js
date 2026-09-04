import { ConfigurationError, getRuntimeConfig } from "../lib/server/config.js";
import { buildCheckoutSessionParameters, createStripeClient, requireCardCheckoutConfig } from "../lib/server/commerce.js";
import { json, problem, readJson, requestFailure, text } from "../lib/server/http.js";
import { createSupabaseRequestClient, createSupabaseServiceClient, getAuthenticatedCurator } from "../lib/server/supabase.js";

const checkoutKey = (request) => {
  const key = text(request.headers.get("idempotency-key"), { required: true, maximum: 200 });
  if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) throw new Error("INVALID_INPUT");
  return key;
};

const workSlug = (value) => {
  const slug = text(value, { required: true, maximum: 160 });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("INVALID_INPUT");
  return slug;
};

const definitelyRejectedByStripe = (error) => [
  "StripeInvalidRequestError",
  "StripeAuthenticationError",
  "StripePermissionError"
].includes(error?.type) && Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500;

export const GET = async (request) => {
  try {
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "No member session is active.", headers);

    const { data, error } = await supabase
      .from("acquisitions")
      .select("id,work_id,method,state,amount_minor,currency,crypto_amount,crypto_asset,chain,created_at,updated_at")
      .eq("buyer_user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) return problem(502, "acquisitions_unavailable", "Acquisition status could not be loaded.", headers);
    return json({ acquisitions: data }, { headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "backend_not_configured", "Acquisition state is not configured.");
    return problem(500, "unexpected_error", "Acquisition status could not be loaded.");
  }
};

export const POST = async (request) => {
  if (!getRuntimeConfig().commerce.cardCheckoutConfigured) {
    return problem(503, "acquisition_not_configured", "Checkout is not available. No order was created.");
  }

  let acquisitionId;
  let stripe;
  let service;
  let providerSessionMayExist = false;
  let providerCreationAttempted = false;
  try {
    const config = requireCardCheckoutConfig();
    if (request.headers.get("origin") !== config.siteUrl) {
      return problem(403, "origin_not_allowed", "Checkout must start from the marketplace.");
    }
    const { supabase, headers: authHeaders } = createSupabaseRequestClient(request);
    const { user, curator, error: curatorError } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in before starting checkout.", authHeaders);
    if (curatorError || curator?.status !== "active") {
      return problem(403, "buyer_not_invited", "Checkout is currently available to active invited members.", authHeaders);
    }
    const body = await readJson(request);
    if (body.method !== "card") return problem(422, "unsupported_method", "Choose the hosted card checkout.");
    const slug = workSlug(body.work_slug);
    const idempotencyKey = checkoutKey(request);
    service = createSupabaseServiceClient();
    stripe = createStripeClient(config);

    const { data: work, error: workError } = await service.from("works").select("id").eq("slug", slug).maybeSingle();
    if (workError) return problem(502, "catalog_unavailable", "The work could not be checked.");
    if (!work) return problem(404, "work_not_found", "This work is not available.");

    const deadline = new Date(Date.now() + config.commerce.reservationMinutes * 60_000).toISOString();
    const { data: reservation, error: reservationError } = await service.rpc("reserve_card_checkout", {
      work_uuid: work.id,
      buyer_uuid: user.id,
      request_key: idempotencyKey,
      terms_version_required: config.commerce.sellerTermsVersion,
      buyer_terms_url_required: config.commerce.buyerTermsUrl,
      buyer_terms_version_required: config.commerce.buyerTermsVersion,
      max_item_price_minor: config.commerce.maximumItemPriceMinor,
      reservation_deadline: deadline
    });
    if (reservationError) {
      const limited = /buyer_reservation_limit/.test(reservationError.message);
      const unavailable = /work_unavailable|seller_unavailable|rights_not_cleared|work_price_unavailable|work_shipping_unavailable|work_terms_unavailable|nft_sale_not_enabled|idempotency_conflict|idempotency_terminal/.test(reservationError.message);
      return problem(limited ? 429 : unavailable ? 409 : 502, limited ? "reservation_limit" : unavailable ? "work_unavailable" : "reservation_failed", limited
        ? "Too many works are already reserved on this account."
        : unavailable
        ? "This work cannot be reserved right now."
        : "Checkout could not reserve the work.");
    }
    acquisitionId = reservation.acquisition_id;

    if (reservation.provider_ref) {
      providerSessionMayExist = true;
      const existing = await stripe.checkout.sessions.retrieve(reservation.provider_ref);
      if (existing.status !== "open" || !existing.url) return problem(409, "checkout_unavailable", "This checkout is no longer open.");
      return json({ acquisition_id: acquisitionId, checkout_url: existing.url }, { status: 200, headers: authHeaders });
    }

    const checkoutParameters = buildCheckoutSessionParameters(reservation, config);
    providerSessionMayExist = true;
    providerCreationAttempted = true;
    const session = await stripe.checkout.sessions.create(
      checkoutParameters,
      { idempotencyKey: `checkout:${acquisitionId}` }
    );
    if (!session.url) throw new Error("CHECKOUT_URL_MISSING");

    const { error: attachError } = await service.rpc("attach_card_checkout", {
      acquisition_uuid: acquisitionId,
      checkout_session_id: session.id
    });
    if (attachError) {
      try {
        await stripe.checkout.sessions.expire(session.id);
        await service.rpc("release_card_reservation", {
          acquisition_uuid: acquisitionId,
          reason_code: "checkout_attach_failed"
        });
        return problem(502, "checkout_not_attached", "Checkout could not be finalized. No payment was taken.");
      } catch {
        return problem(503, "checkout_reconciliation_required", "Checkout is reconciling. Try again later.");
      }
    }

    return json({ acquisition_id: acquisitionId, checkout_url: session.url }, { status: 201, headers: authHeaders });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "acquisition_not_configured", "Checkout is not available.");
    if (acquisitionId && service && !providerSessionMayExist) {
      await service.rpc("release_card_reservation", {
        acquisition_uuid: acquisitionId,
        reason_code: "checkout_preflight_failed"
      }).catch(() => undefined);
      return problem(422, "checkout_preflight_failed", "Checkout could not be created. Start a new checkout attempt.");
    }
    if (acquisitionId && service && providerCreationAttempted && definitelyRejectedByStripe(error)) {
      await service.rpc("release_card_reservation", {
        acquisition_uuid: acquisitionId,
        reason_code: "checkout_provider_rejected"
      }).catch(() => undefined);
      return problem(422, "checkout_rejected", "Checkout could not be created. No payment was taken.");
    }
    if (acquisitionId && providerSessionMayExist) {
      return problem(503, "checkout_reconciliation_required", "Checkout is reconciling. Retry this same checkout shortly.");
    }
    return requestFailure(error) || problem(502, "checkout_unavailable", "Checkout could not be started. No payment was taken.");
  }
};

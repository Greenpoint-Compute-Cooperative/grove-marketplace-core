import { timingSafeEqual } from "node:crypto";
import { createStripeClient, requireStripeWebhookConfig } from "../../lib/server/commerce.js";
import { ConfigurationError, getRuntimeConfig } from "../../lib/server/config.js";
import { json, problem } from "../../lib/server/http.js";
import { createSupabaseServiceClient } from "../../lib/server/supabase.js";

const authorized = (request, expected) => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};

const reference = (value) => typeof value === "string" ? value : value?.id || null;

export const GET = async (request) => {
  try {
    const runtime = getRuntimeConfig();
    if (!runtime.cronSecret || !authorized(request, runtime.cronSecret)) {
      return problem(401, "not_authorized", "Cron authorization is required.");
    }
    const config = requireStripeWebhookConfig();
    const service = createSupabaseServiceClient();
    const stripe = createStripeClient(config);
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: acquisitions, error } = await service
      .from("acquisitions")
      .select("id,provider_ref,reservation_expires_at")
      .eq("state", "checkout-pending")
      .lt("reservation_expires_at", staleBefore)
      .order("reservation_expires_at", { ascending: true })
      .limit(25);
    if (error) return problem(503, "reconciliation_unavailable", "Commerce reconciliation could not load reservations.");

    const summary = { checked: acquisitions.length, paid: 0, released: 0, pending: 0, errors: 0 };
    for (const acquisition of acquisitions) {
      try {
        if (!acquisition.provider_ref) {
          const { data: released, error: releaseError } = await service.rpc("release_card_reservation", {
            acquisition_uuid: acquisition.id,
            reason_code: "expired_without_attached_session"
          });
          if (releaseError) throw releaseError;
          if (released) summary.released += 1;
          continue;
        }

        let session = await stripe.checkout.sessions.retrieve(acquisition.provider_ref);
        if (session.status === "open" && session.payment_status !== "paid") {
          session = await stripe.checkout.sessions.expire(session.id);
        }
        const effectiveType = session.payment_status === "paid"
          ? "checkout.session.async_payment_succeeded"
          : session.status === "expired"
            ? "checkout.session.expired"
            : null;
        if (!effectiveType) {
          throw new Error("stale_provider_session");
        }
        const { data: applyResult, error: applyError } = await service.rpc("apply_stripe_checkout_event", {
          stripe_event_id: `reconcile:${session.id}:${session.status}:${session.payment_status}`,
          stripe_event_type: effectiveType,
          acquisition_uuid: acquisition.id,
          checkout_session_id: session.id,
          payment_intent_id: reference(session.payment_intent),
          checkout_payment_status: session.payment_status,
          customer_email_address: session.customer_details?.email || null,
          checkout_amount_total: session.amount_total,
          checkout_amount_subtotal: session.amount_subtotal,
          checkout_amount_tax: session.total_details?.amount_tax || 0,
          checkout_amount_shipping: session.total_details?.amount_shipping || 0,
          checkout_currency: session.currency,
          checkout_mode: session.mode,
          automatic_tax_enabled: session.automatic_tax?.enabled === true,
          terms_acceptance_status: session.consent?.terms_of_service || null,
          event_payload: { source: "commerce-reconcile", session_id: session.id }
        });
        if (applyError) throw applyError;
        if (applyResult === "ignored" || applyResult === "retry") throw new Error(`transition_${applyResult}`);
        const { data: reconciled, error: stateError } = await service
          .from("acquisitions")
          .select("state")
          .eq("id", acquisition.id)
          .single();
        if (stateError) throw stateError;
        if (session.payment_status === "paid" && reconciled.state === "paid") summary.paid += 1;
        else if (session.status === "expired" && ["expired", "failed"].includes(reconciled.state)) summary.released += 1;
        else throw new Error("transition_state_mismatch");
      } catch (itemError) {
        summary.errors += 1;
        console.error(JSON.stringify({
          level: "error",
          operation: "commerce_reconcile_item",
          acquisition_id: acquisition.id,
          code: itemError?.code || itemError?.type || "reconciliation_error"
        }));
      }
    }

    return json(summary, { status: summary.errors ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "commerce_not_configured", "Commerce reconciliation is unavailable.");
    return problem(500, "unexpected_error", "Commerce reconciliation did not complete.");
  }
};

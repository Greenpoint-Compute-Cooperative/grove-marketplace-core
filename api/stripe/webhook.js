import { createStripeClient, requireStripeWebhookConfig } from "../../lib/server/commerce.js";
import {
  assertAuctionPaymentIntent,
  ensureAuctionTaxReversal,
  ensureAuctionTaxTransaction
} from "../../lib/server/auction.js";
import { ConfigurationError } from "../../lib/server/config.js";
import { json, problem } from "../../lib/server/http.js";
import { createSupabaseServiceClient } from "../../lib/server/supabase.js";

const acceptedEvents = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "setup_intent.succeeded",
  "setup_intent.setup_failed",
  "setup_intent.canceled",
  "payment_intent.succeeded",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "review.opened",
  "review.closed",
  "radar.early_fraud_warning.created",
  "radar.early_fraud_warning.updated",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.closed"
]);

const checkoutEvents = new Set([...acceptedEvents].filter((type) => type.startsWith("checkout.session.")));
const setupEvents = new Set([...acceptedEvents].filter((type) => type.startsWith("setup_intent.")));
const paymentIntentEvents = new Set([...acceptedEvents].filter((type) => type.startsWith("payment_intent.")));
const riskEvents = new Set([...acceptedEvents].filter((type) => type.startsWith("review.") || type.startsWith("radar.early_fraud_warning.")));

const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? value : null;
const reference = (value) => typeof value === "string" ? value : value?.id || null;
export const effectiveDisputeEventType = (status) => ({
  lost: "charge.dispute.lost",
  won: "charge.dispute.won",
  warning_closed: "charge.dispute.warning_closed",
  prevented: "charge.dispute.prevented"
}[status] || "charge.dispute.created");
export const effectivePaymentIntentEventType = (status) => ({
  succeeded: "payment_intent.succeeded",
  processing: "payment_intent.processing",
  requires_action: "payment_intent.requires_action",
  canceled: "payment_intent.canceled",
  requires_payment_method: "payment_intent.payment_failed"
}[status] || "payment_intent.payment_failed");

export const effectiveAuctionRiskSignal = ({ review, riskObject }) => {
  if (review) {
    const status = riskObject.open ? "open" : riskObject.closed_reason || riskObject.reason || "closed-unknown";
    return { status, actionable: riskObject.open === true || status !== "approved" };
  }
  const status = riskObject.actionable === true ? riskObject.fraud_type || "actionable" : "not-actionable";
  // An Early Fraud Warning never clears itself. Stripe can mark it non-actionable
  // because a refund or dispute already exists, which must still block delivery
  // until the service-only resolution path records fresh evidence.
  return { status, actionable: true };
};

export const POST = async (request) => {
  try {
    const announcedLength = Number(request.headers.get("content-length") || 0);
    if (announcedLength > 512_000) return problem(413, "payload_too_large", "Webhook payload is too large.");

    const config = requireStripeWebhookConfig();
    const signature = request.headers.get("stripe-signature");
    if (!signature) return problem(400, "signature_missing", "Webhook signature is required.");
    const payload = await request.text();
    if (new TextEncoder().encode(payload).byteLength > 512_000) return problem(413, "payload_too_large", "Webhook payload is too large.");

    const stripe = createStripeClient(config);
    let event;
    try {
      event = stripe.webhooks.constructEvent(payload, signature, config.commerce.stripeWebhookSecret);
    } catch {
      return problem(400, "signature_invalid", "Webhook signature is invalid.");
    }

    if (!acceptedEvents.has(event.type)) return json({ received: true, ignored: true });
    if (setupEvents.has(event.type)) {
      const setupIntent = await stripe.setupIntents.retrieve(event.data.object.id);
      const auctionId = uuid(setupIntent.metadata?.grove_auction_id);
      const mandateId = uuid(setupIntent.metadata?.grove_mandate_id);
      const customerId = reference(setupIntent.customer);
      if (!auctionId && !mandateId) return json({ received: true, ignored: true });
      if (!auctionId || !mandateId || !customerId) return problem(422, "mandate_missing", "Webhook mandate metadata is invalid.");
      const service = createSupabaseServiceClient();
      const { data: result, error } = await service.rpc("apply_stripe_auction_setup_event", {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        auction_uuid: auctionId,
        mandate_uuid: mandateId,
        checkout_session_id: null,
        setup_intent_id: setupIntent.id,
        customer_id: customerId,
        payment_method_id: reference(setupIntent.payment_method),
        setup_status: setupIntent.status,
        setup_usage_value: setupIntent.usage,
        terms_acceptance_status: null,
        event_payload: { id: event.id, type: event.type, created: event.created, livemode: event.livemode }
      });
      if (error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
      return json({ received: true, result });
    }
    if (paymentIntentEvents.has(event.type)) {
      const paymentIntent = await stripe.paymentIntents.retrieve(event.data.object.id);
      const settlementId = uuid(paymentIntent.metadata?.grove_settlement_id);
      if (!settlementId) return json({ received: true, ignored: true });
      const effectiveType = effectivePaymentIntentEventType(paymentIntent.status);
      const service = createSupabaseServiceClient();
      if (effectiveType === "payment_intent.succeeded") {
        const { data: settlement, error: settlementError } = await service.from("auction_settlements")
          .select("id,auction_id,winning_bid_id,total_amount,current_payment_intent_ref,tax_calculation_ref,tax_transaction_ref")
          .eq("id", settlementId).single();
        if (settlementError || !settlement) return problem(503, "webhook_dependency_pending", "Webhook processing will be retried.");
        if (settlement.current_payment_intent_ref === paymentIntent.id) {
          const taxTransaction = await ensureAuctionTaxTransaction({
            stripe, settlement, paymentIntent, providerCreatedAt: event.created
          });
          const recorded = await service.rpc("record_auction_tax_transaction", {
            settlement_uuid: settlementId,
            payment_intent_id: paymentIntent.id,
            tax_transaction_id: taxTransaction.id,
            provider_paid_at: new Date(event.created * 1000).toISOString()
          });
          if (recorded.error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
        }
      }
      const { data: result, error } = await service.rpc("apply_stripe_auction_payment_event", {
        stripe_event_id: event.id,
        stripe_event_type: effectiveType,
        settlement_uuid: settlementId,
        payment_intent_id: paymentIntent.id,
        stripe_object_id: paymentIntent.id,
        object_status: paymentIntent.last_payment_error?.code || paymentIntent.status,
        object_amount: paymentIntent.amount,
        object_currency: paymentIntent.currency,
        event_payload: { id: event.id, type: event.type, effective_type: effectiveType, created: event.created, livemode: event.livemode }
      });
      if (error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
      return json({ received: true, result });
    }
    if (riskEvents.has(event.type)) {
      const riskObject = event.type.startsWith("review.")
        ? await stripe.reviews.retrieve(event.data.object.id)
        : await stripe.radar.earlyFraudWarnings.retrieve(event.data.object.id);
      let paymentIntentId = reference(riskObject.payment_intent);
      if (!paymentIntentId && riskObject.charge) {
        const charge = await stripe.charges.retrieve(reference(riskObject.charge));
        paymentIntentId = reference(charge.payment_intent);
      }
      if (!paymentIntentId) return problem(422, "payment_missing", "Risk event payment metadata is invalid.");
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const settlementId = uuid(paymentIntent.metadata?.grove_settlement_id);
      if (!settlementId) return json({ received: true, ignored: true });
      const review = event.type.startsWith("review.");
      const signal = effectiveAuctionRiskSignal({ review, riskObject });
      const service = createSupabaseServiceClient();
      const { data: result, error } = await service.rpc("apply_stripe_auction_risk_event", {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        settlement_uuid: settlementId,
        payment_intent_id: paymentIntentId,
        provider_object_id: riskObject.id,
        signal_kind_value: review ? "review" : "early-fraud-warning",
        actionable_value: signal.actionable,
        object_status: signal.status,
        provider_observed_at: new Date(event.created * 1000).toISOString(),
        event_payload: { id: event.id, type: event.type, created: event.created, livemode: event.livemode }
      });
      if (error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
      return json({ received: true, result });
    }
    if (!checkoutEvents.has(event.type)) {
      const announcedObject = event.data.object;
      const currentObject = event.type.startsWith("refund.")
        ? await stripe.refunds.retrieve(announcedObject.id)
        : await stripe.disputes.retrieve(announcedObject.id);
      let paymentIntentId = reference(currentObject.payment_intent);
      if (!paymentIntentId && currentObject.charge) {
        const charge = await stripe.charges.retrieve(reference(currentObject.charge));
        paymentIntentId = reference(charge.payment_intent);
      }
      if (!paymentIntentId) return problem(422, "payment_missing", "Webhook payment metadata is invalid.");
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const settlementId = uuid(paymentIntent.metadata?.grove_settlement_id);
      if (settlementId) {
        const effectiveType = event.type.startsWith("charge.dispute.")
          ? effectiveDisputeEventType(currentObject.status)
          : event.type;
        const service = createSupabaseServiceClient();
        if (event.type.startsWith("refund.") && currentObject.status === "succeeded") {
          const { data: settlement, error: settlementError } = await service.from("auction_settlements")
            .select("id,total_amount,current_payment_intent_ref,tax_transaction_ref")
            .eq("id", settlementId).single();
          if (settlementError || !settlement) return problem(503, "webhook_dependency_pending", "Webhook processing will be retried.");
          if (settlement.current_payment_intent_ref === paymentIntentId) {
            const reversal = await ensureAuctionTaxReversal({ stripe, settlement, paymentIntent, refund: currentObject });
            const recorded = await service.rpc("record_auction_tax_reversal", {
              settlement_uuid: settlementId,
              payment_intent_id: paymentIntentId,
              refund_id: currentObject.id,
              tax_reversal_id: reversal.id,
              refund_amount: currentObject.amount,
              refund_status: currentObject.status
            });
            if (recorded.error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
          }
        }
        const { data: result, error } = await service.rpc("apply_stripe_auction_payment_event", {
          stripe_event_id: event.id,
          stripe_event_type: effectiveType,
          settlement_uuid: settlementId,
          payment_intent_id: paymentIntentId,
          stripe_object_id: currentObject.id,
          object_status: currentObject.status || null,
          object_amount: currentObject.amount || paymentIntent.amount,
          object_currency: currentObject.currency || paymentIntent.currency,
          event_payload: { id: event.id, type: event.type, effective_type: effectiveType, created: event.created, livemode: event.livemode }
        });
        if (error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
        return json({ received: true, result });
      }
      const acquisitionId = uuid(paymentIntent.metadata?.grove_acquisition_id);
      if (!acquisitionId) return problem(422, "acquisition_missing", "Webhook acquisition metadata is invalid.");
      const effectiveType = event.type.startsWith("charge.dispute.")
        ? effectiveDisputeEventType(currentObject.status)
        : event.type;
      const service = createSupabaseServiceClient();
      const { data: result, error } = await service.rpc("apply_stripe_financial_event", {
        stripe_event_id: event.id,
        stripe_event_type: effectiveType,
        acquisition_uuid: acquisitionId,
        payment_intent_id: paymentIntentId,
        stripe_object_id: currentObject.id,
        object_status: currentObject.status || null,
        object_amount: currentObject.amount || 0,
        object_currency: currentObject.currency || paymentIntent.currency,
        event_payload: {
          id: event.id,
          type: event.type,
          effective_type: effectiveType,
          created: event.created,
          livemode: event.livemode,
          api_version: event.api_version || null,
          request_id: event.request?.id || null
        }
      });
      if (error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
      if (result === "retry") return problem(503, "webhook_dependency_pending", "Webhook processing will be retried.");
      return json({ received: true, result });
    }

    const announcedSession = event.data.object;
    const session = await stripe.checkout.sessions.retrieve(announcedSession.id);
    if (session.metadata?.grove_flow === "auction-payment-cure") {
      const settlementId = uuid(session.metadata?.grove_settlement_id || session.client_reference_id);
      if (!settlementId) return problem(422, "settlement_missing", "Payment recovery metadata is invalid.");
      const service = createSupabaseServiceClient();
      const { data: settlement, error: settlementError } = await service.from("auction_settlements")
        .select("id,auction_id,winning_bid_id,total_amount,currency,cure_checkout_session_ref,tax_calculation_ref,tax_transaction_ref")
        .eq("id", settlementId).single();
      if (settlementError || !settlement || settlement.cure_checkout_session_ref !== session.id
          || session.mode !== "payment" || session.currency?.toLowerCase() !== "usd"
          || session.amount_total !== Number(settlement.total_amount)) {
        return problem(422, "settlement_mismatch", "Payment recovery does not match the frozen settlement.");
      }
      const eventPayload = { id: event.id, type: event.type, created: event.created, livemode: event.livemode };
      if (event.type === "checkout.session.expired" || session.status === "expired") {
        const { data: result, error } = await service.rpc("expire_auction_payment_cure", {
          stripe_event_id: event.id,
          settlement_uuid: settlementId,
          checkout_session_id: session.id,
          event_payload: eventPayload
        });
        if (error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
        return json({ received: true, result });
      }
      const paymentIntentId = reference(session.payment_intent);
      if (!paymentIntentId) return problem(503, "webhook_dependency_pending", "Webhook processing will be retried.");
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      try {
        assertAuctionPaymentIntent({ paymentIntent, settlement, flow: "auction-payment-cure" });
      } catch {
        return problem(422, "settlement_mismatch", "Payment recovery does not match the frozen settlement.");
      }
      const bound = await service.rpc("bind_auction_payment_cure", {
        settlement_uuid: settlementId,
        checkout_session_id: session.id,
        replacement_payment_intent_id: paymentIntent.id,
        expected_amount: paymentIntent.amount
      });
      if (bound.error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
      const effectiveType = effectivePaymentIntentEventType(paymentIntent.status);
      if (effectiveType === "payment_intent.succeeded") {
        const taxTransaction = await ensureAuctionTaxTransaction({
          stripe, settlement, paymentIntent, providerCreatedAt: event.created
        });
        const recorded = await service.rpc("record_auction_tax_transaction", {
          settlement_uuid: settlementId,
          payment_intent_id: paymentIntent.id,
          tax_transaction_id: taxTransaction.id,
          provider_paid_at: new Date(event.created * 1000).toISOString()
        });
        if (recorded.error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
      }
      const { data: result, error } = await service.rpc("apply_stripe_auction_payment_event", {
        stripe_event_id: event.id,
        stripe_event_type: effectiveType,
        settlement_uuid: settlementId,
        payment_intent_id: paymentIntent.id,
        stripe_object_id: paymentIntent.id,
        object_status: paymentIntent.last_payment_error?.code || paymentIntent.status,
        object_amount: paymentIntent.amount,
        object_currency: paymentIntent.currency,
        event_payload: { ...eventPayload, effective_type: effectiveType }
      });
      if (error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
      return json({ received: true, result });
    }
    if (session.metadata?.grove_flow === "auction-payment-setup") {
      const setupIntentId = reference(session.setup_intent);
      const setupIntent = setupIntentId ? await stripe.setupIntents.retrieve(setupIntentId) : null;
      const auctionId = uuid(session.metadata?.grove_auction_id || setupIntent?.metadata?.grove_auction_id);
      const mandateId = uuid(session.metadata?.grove_mandate_id || setupIntent?.metadata?.grove_mandate_id);
      const customerId = reference(session.customer || setupIntent?.customer);
      if (!auctionId || !mandateId || !customerId) return problem(422, "mandate_missing", "Webhook mandate metadata is invalid.");
      const service = createSupabaseServiceClient();
      const { data: result, error } = await service.rpc("apply_stripe_auction_setup_event", {
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        auction_uuid: auctionId,
        mandate_uuid: mandateId,
        checkout_session_id: session.id,
        setup_intent_id: setupIntent?.id || null,
        customer_id: customerId,
        payment_method_id: reference(setupIntent?.payment_method),
        setup_status: setupIntent?.status || session.status,
        setup_usage_value: setupIntent?.usage || null,
        terms_acceptance_status: session.consent?.terms_of_service || null,
        event_payload: { id: event.id, type: event.type, created: event.created, livemode: event.livemode }
      });
      if (error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
      return json({ received: true, result });
    }
    if (session.mode === "setup") return json({ received: true, ignored: true });
    const acquisitionId = uuid(session.metadata?.grove_acquisition_id || session.client_reference_id);
    if (!acquisitionId) return problem(422, "acquisition_missing", "Webhook acquisition metadata is invalid.");

    const effectiveType = session.payment_status === "paid"
      ? "checkout.session.async_payment_succeeded"
      : session.status === "expired"
        ? "checkout.session.expired"
        : event.type;
    const service = createSupabaseServiceClient();
    const { data: result, error } = await service.rpc("apply_stripe_checkout_event", {
      stripe_event_id: event.id,
      stripe_event_type: effectiveType,
      acquisition_uuid: acquisitionId,
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
      event_payload: {
        id: event.id,
        type: event.type,
        effective_type: effectiveType,
        created: event.created,
        livemode: event.livemode,
        api_version: event.api_version || null,
        request_id: event.request?.id || null
      }
    });
    if (error) return problem(503, "webhook_processing_failed", "Webhook processing will be retried.");
    return json({ received: true, result });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "acquisition_not_configured", "Checkout is not configured.");
    return problem(500, "unexpected_error", "Webhook processing failed.");
  }
};

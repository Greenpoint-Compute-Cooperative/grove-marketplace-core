import { timingSafeEqual } from "node:crypto";
import {
  assertAuctionPaymentIntent,
  auctionAmountsFromTaxCalculation,
  buildAuctionTaxCalculationParameters,
  buildWinnerPaymentIntentConfirmationParameters,
  buildWinnerPaymentIntentParameters,
  createAuctionStripeClient,
  requireAuctionConfig
} from "../../lib/server/auction.js";
import { ConfigurationError, getRuntimeConfig } from "../../lib/server/config.js";
import { json, problem } from "../../lib/server/http.js";
import { createSupabaseServiceClient } from "../../lib/server/supabase.js";

const authorized = (request, expected) => {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};

const amount = (value, code, { minimum = 0 } = {}) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code);
  return parsed;
};

const reference = (value) => typeof value === "string" ? value : value?.id;

const loadSettlementContext = async (service, settlement) => {
  const [{ data: bid, error: bidError }, { data: auction, error: auctionError }] = await Promise.all([
    service.from("auction_bids").select("id,payment_mandate_id").eq("id", settlement.winning_bid_id).single(),
    service.from("auctions").select("id,work_id").eq("id", settlement.auction_id).single()
  ]);
  if (bidError || !bid?.payment_mandate_id || auctionError || !auction) throw new Error("SETTLEMENT_CONTEXT_MISSING");
  const [{ data: mandate, error: mandateError }, { data: work, error: workError }] = await Promise.all([
    service.from("bidder_payment_mandates")
      .select("id,bidder_user_id,provider_customer_ref,payment_method_ref,state")
      .eq("id", bid.payment_mandate_id).single(),
    service.from("works").select("id,title,requires_shipping,stripe_tax_code,stripe_shipping_rate_id")
      .eq("id", auction.work_id).single()
  ]);
  if (mandateError || !mandate || mandate.bidder_user_id !== settlement.bidder_user_id
      || mandate.state !== "ready" || !mandate.provider_customer_ref || !mandate.payment_method_ref
      || workError || !work?.stripe_tax_code) {
    throw new Error("SETTLEMENT_CONTEXT_MISSING");
  }
  return { mandate, work };
};

const shippingAmountFor = async ({ stripe, work }) => {
  if (!work.requires_shipping) return 0;
  if (!work.stripe_shipping_rate_id) throw new Error("SHIPPING_RATE_MISSING");
  const rate = await stripe.shippingRates.retrieve(work.stripe_shipping_rate_id);
  if (!rate.active || rate.type !== "fixed_amount" || rate.fixed_amount?.currency?.toLowerCase() !== "usd") {
    throw new Error("SHIPPING_RATE_INVALID");
  }
  return amount(rate.fixed_amount.amount, "SHIPPING_RATE_INVALID");
};

const observePayment = async ({ service, settlement, paymentIntent }) => {
  const { data, error } = await service.rpc("record_auction_payment_observation", {
    settlement_uuid: settlement.id,
    payment_intent_id: paymentIntent.id,
    object_status: paymentIntent.status,
    object_error_code: paymentIntent.last_payment_error?.code || paymentIntent.status
  });
  if (error) throw error;
  return data;
};

export const settleAuctionCardPayment = async ({ service, stripe, config, initialSettlement }) => {
  let settlement = initialSettlement;
  if (!settlement.settlement_deadline || new Date(settlement.settlement_deadline) <= new Date()) {
    throw new Error("SETTLEMENT_DEADLINE_EXPIRED");
  }
  const { mandate, work } = await loadSettlementContext(service, settlement);

  if (!settlement.tax_calculation_ref) {
    const shippingAmount = await shippingAmountFor({ stripe, work });
    const calculation = await stripe.tax.calculations.create(
      buildAuctionTaxCalculationParameters({ settlement, mandate, work, shippingAmount }),
      { idempotencyKey: `auction-tax:${settlement.id}:v1` }
    );
    const amounts = auctionAmountsFromTaxCalculation({
      calculation,
      hammerAmount: settlement.hammer_amount,
      shippingAmount
    });
    const frozen = await service.rpc("freeze_auction_settlement_total", {
      settlement_uuid: settlement.id,
      tax_calculation_id: calculation.id,
      tax_amount_minor: amounts.taxAmount,
      shipping_amount_minor: amounts.shippingAmount
    });
    if (frozen.error || !frozen.data) throw frozen.error || new Error("TOTAL_FREEZE_FAILED");
    settlement = frozen.data;
  }

  let paymentIntent;
  if (!settlement.current_payment_intent_ref) {
    paymentIntent = await stripe.paymentIntents.create(
      buildWinnerPaymentIntentParameters({ settlement: { ...settlement, total_amount: amount(settlement.total_amount, "INVALID_SETTLEMENT_TOTAL", { minimum: 50 }) }, mandate }),
      { idempotencyKey: `auction-payment:${settlement.id}:1` }
    );
    assertAuctionPaymentIntent({ paymentIntent, settlement, mandate });
    const bound = await service.rpc("register_auction_payment_attempt", {
      settlement_uuid: settlement.id,
      payment_intent_id: paymentIntent.id,
      expected_amount: amount(settlement.total_amount, "INVALID_SETTLEMENT_TOTAL", { minimum: 50 }),
      attempt_kind_required: "off-session"
    });
    if (bound.error || !bound.data) throw bound.error || new Error("PAYMENT_BIND_FAILED");
    settlement = {
      ...settlement,
      current_payment_intent_ref: paymentIntent.id,
      payment_generation: bound.data.generation,
      state: "charge-pending"
    };
  } else {
    paymentIntent = await stripe.paymentIntents.retrieve(settlement.current_payment_intent_ref);
    assertAuctionPaymentIntent({ paymentIntent, settlement, mandate });
  }

  if (paymentIntent.status === "requires_confirmation") {
    try {
      paymentIntent = await stripe.paymentIntents.confirm(
        paymentIntent.id,
        buildWinnerPaymentIntentConfirmationParameters(),
        { idempotencyKey: `auction-confirm:${settlement.id}:${settlement.payment_generation}` }
      );
    } catch (error) {
      if (!error?.payment_intent) throw error;
      paymentIntent = error.payment_intent;
    }
    assertAuctionPaymentIntent({ paymentIntent, settlement, mandate });
  }
  return observePayment({ service, settlement, paymentIntent });
};

export const GET = async (request) => {
  const runtime = getRuntimeConfig();
  if (!runtime.cronSecret || !authorized(request, runtime.cronSecret)) {
    return problem(401, "not_authorized", "Cron authorization is required.");
  }
  try {
    const config = requireAuctionConfig();
    const service = createSupabaseServiceClient();
    const stripe = createAuctionStripeClient(config);
    const { data: settlements, error } = await service.from("auction_settlements")
      .select("id,auction_id,winning_bid_id,bidder_user_id,rail,hammer_amount,total_amount,currency,state,settlement_deadline,risk_hold_seconds,risk_hold_until,tax_calculation_ref,tax_transaction_ref,current_payment_intent_ref,payment_generation")
      .eq("rail", "card").in("state", ["winner-selected", "tax-pending", "charge-pending"])
      .order("created_at", { ascending: true }).limit(10);
    if (error) return problem(503, "auction_settlement_unavailable", "Auction settlements could not be loaded.");

    const summary = { checked: settlements.length, processing: 0, action_required: 0, failed: 0, errors: 0 };
    for (const settlement of settlements) {
      try {
        const state = await settleAuctionCardPayment({ service, stripe, config, initialSettlement: settlement });
        if (state === "requires-action") summary.action_required += 1;
        else if (state === "payment-failed") summary.failed += 1;
        else summary.processing += 1;
      } catch (error) {
        summary.errors += 1;
        console.error(JSON.stringify({
          level: "error",
          operation: "auction_settlement",
          settlement_id: settlement.id,
          code: error?.code || error?.message || "settlement_error"
        }));
      }
    }
    return json(summary, { status: summary.errors ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "auction_not_configured", "Auction settlement is not available.");
    return problem(500, "unexpected_error", "Auction settlement did not complete.");
  }
};

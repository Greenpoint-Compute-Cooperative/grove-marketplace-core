import {
  assertAuctionPaymentIntent,
  buildAuctionCureSessionParameters,
  createAuctionStripeClient,
  requireAuctionConfig
} from "../../../lib/server/auction.js";
import { ConfigurationError } from "../../../lib/server/config.js";
import { json, problem, requestFailure } from "../../../lib/server/http.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../../lib/server/supabase.js";

const uuid = (input) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase()
  : null;
const auctionIdFrom = (request) => uuid(new URL(request.url).pathname.split("/").at(-2) || "");
const reference = (value) => typeof value === "string" ? value : value?.id;

export const POST = async (request) => {
  try {
    const config = requireAuctionConfig();
    if (request.headers.get("origin") !== config.siteUrl) {
      return problem(403, "origin_not_allowed", "Payment recovery must start from the marketplace.");
    }
    const auctionId = auctionIdFrom(request);
    if (!auctionId) return problem(404, "auction_not_found", "The auction was not found.");
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user, curator } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in to complete payment.", headers);
    if (curator?.status !== "active") return problem(403, "bidder_not_invited", "Payment recovery is limited to active members.", headers);

    const service = createSupabaseServiceClient();
    const { data: settlement, error: settlementError } = await service.from("auction_settlements")
      .select("id,auction_id,winning_bid_id,bidder_user_id,total_amount,currency,state,settlement_deadline,current_payment_intent_ref,payment_generation,cure_checkout_session_ref,cure_state,cure_expires_at")
      .eq("auction_id", auctionId).eq("bidder_user_id", user.id).maybeSingle();
    if (settlementError) return problem(503, "payment_cure_unavailable", "Payment recovery could not be loaded.", headers);
    if (!settlement) return problem(404, "settlement_not_found", "No winning settlement was found.", headers);
    const settlementDeadline = new Date(settlement.settlement_deadline).getTime();
    if (!Number.isFinite(settlementDeadline) || settlementDeadline <= Date.now()) {
      return problem(409, "settlement_deadline_expired", "The winner payment deadline has expired.", headers);
    }
    if (!["requires-action", "payment-failed"].includes(settlement.state)) {
      return json({ settlement_id: settlement.id, state: settlement.state }, { status: 202, headers });
    }
    const [{ data: bid }, { data: auction }] = await Promise.all([
      service.from("auction_bids").select("payment_mandate_id").eq("id", settlement.winning_bid_id).single(),
      service.from("auctions").select("work_id").eq("id", auctionId).single()
    ]);
    if (!bid?.payment_mandate_id || !auction?.work_id) throw new Error("SETTLEMENT_CONTEXT_MISSING");
    const [{ data: mandate }, { data: work }] = await Promise.all([
      service.from("bidder_payment_mandates").select("provider_customer_ref,payment_method_ref")
        .eq("id", bid.payment_mandate_id).eq("bidder_user_id", user.id).single(),
      service.from("works").select("title").eq("id", auction.work_id).single()
    ]);
    if (!mandate?.provider_customer_ref || !mandate?.payment_method_ref || !work) throw new Error("SETTLEMENT_CONTEXT_MISSING");

    const stripe = createAuctionStripeClient(config);
    if (settlement.cure_checkout_session_ref) {
      const existing = await stripe.checkout.sessions.retrieve(settlement.cure_checkout_session_ref);
      if (settlement.cure_state === "open" && existing.status === "open" && existing.url) {
        return json({ settlement_id: settlement.id, state: "requires-action", checkout_url: existing.url }, { headers });
      }
      return json({ settlement_id: settlement.id, state: existing.status === "complete" ? "processing" : "payment-failed" }, { status: 202, headers });
    }

    let prior = await stripe.paymentIntents.retrieve(settlement.current_payment_intent_ref);
    assertAuctionPaymentIntent({ paymentIntent: prior, settlement, mandate });
    if (["processing", "succeeded"].includes(prior.status)) {
      return json({ settlement_id: settlement.id, state: "processing" }, { status: 202, headers });
    }
    if (prior.status !== "canceled") {
      if (!["requires_action", "requires_payment_method"].includes(prior.status)) {
        return problem(409, "payment_not_curable", "The current payment is not ready for recovery.", headers);
      }
      prior = await stripe.paymentIntents.cancel(
        prior.id,
        { cancellation_reason: "abandoned" },
        { idempotencyKey: `auction-cancel-for-cure:${settlement.id}:${settlement.payment_generation}` }
      );
      assertAuctionPaymentIntent({ paymentIntent: prior, settlement, mandate });
    }
    if (prior.status !== "canceled" || reference(prior.customer) !== mandate.provider_customer_ref) {
      return problem(409, "payment_not_curable", "The prior payment could not be retired safely.", headers);
    }
    const observed = await service.rpc("record_auction_payment_observation", {
      settlement_uuid: settlement.id,
      payment_intent_id: prior.id,
      object_status: "canceled",
      object_error_code: prior.cancellation_reason || "canceled_for_cure"
    });
    if (observed.error || observed.data !== "payment-failed") throw observed.error || new Error("CURE_STATE_FAILED");

    if (settlementDeadline - Date.now() < 31 * 60_000) {
      return problem(409, "settlement_deadline_expired", "There is not enough time to start a payment recovery session.", headers);
    }
    const expiresAt = new Date(Math.min(Date.now() + 35 * 60_000, settlementDeadline));
    const session = await stripe.checkout.sessions.create(
      buildAuctionCureSessionParameters({ settlement, customerId: mandate.provider_customer_ref, workTitle: work.title, config, expiresAt }),
      { idempotencyKey: `auction-cure:${settlement.id}:${settlement.payment_generation}` }
    );
    if (!session.url || session.status !== "open") throw new Error("CHECKOUT_URL_MISSING");
    const registered = await service.rpc("register_auction_payment_cure", {
      settlement_uuid: settlement.id,
      expected_payment_intent_id: prior.id,
      checkout_session_id: session.id,
      expires_at_value: new Date(session.expires_at * 1000).toISOString()
    });
    if (registered.error || !registered.data) throw registered.error || new Error("CURE_BIND_FAILED");
    return json({ settlement_id: settlement.id, state: "requires-action", checkout_url: session.url }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "auction_not_configured", "Auction payment recovery is not available.");
    return requestFailure(error) || problem(502, "payment_cure_unavailable", "Payment recovery could not be started.");
  }
};

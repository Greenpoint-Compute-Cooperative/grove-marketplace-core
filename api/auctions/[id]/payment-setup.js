import { buildAuctionSetupSessionParameters, createAuctionStripeClient, requireAuctionConfig } from "../../../lib/server/auction.js";
import { ConfigurationError } from "../../../lib/server/config.js";
import { json, problem, readJson, requestFailure } from "../../../lib/server/http.js";
import {
  createSupabaseRequestClient,
  createSupabaseServiceClient,
  getAuthenticatedCurator
} from "../../../lib/server/supabase.js";
import { primaryWalletReady } from "../../../lib/server/wallet.js";

const uuid = (input) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  ? input.toLowerCase()
  : null;
const auctionIdFrom = (request) => uuid(new URL(request.url).pathname.split("/").at(-2) || "");

export const POST = async (request) => {
  try {
    const config = requireAuctionConfig();
    if (request.headers.get("origin") !== config.siteUrl) {
      return problem(403, "origin_not_allowed", "Payment setup must start from the marketplace.");
    }
    const auctionId = auctionIdFrom(request);
    if (!auctionId) return problem(404, "auction_not_found", "The auction was not found.");
    const { supabase, headers } = createSupabaseRequestClient(request);
    const { user, curator } = await getAuthenticatedCurator(supabase);
    if (!user) return problem(401, "not_authenticated", "Sign in before setting up bidding.", headers);
    if (curator?.status !== "active") return problem(403, "bidder_not_invited", "Bidding is limited to active members.", headers);
    const body = await readJson(request);
    const maximumHammer = Number(body.maximum_hammer_minor);
    if (!Number.isSafeInteger(maximumHammer) || maximumHammer < 50 || maximumHammer > config.auctions.maximumFiatHammerMinor) {
      return problem(422, "invalid_bid_limit", "Choose a valid maximum bid.", headers);
    }
    const service = createSupabaseServiceClient();
    const [{ data: auction }, { data: account }] = await Promise.all([
      service.from("auctions").select("id,work_id,settlement_rail,state,maximum_card_bid_minor,terms_version,terms_hash,works(title)")
        .eq("id", auctionId).maybeSingle(),
      service.from("smart_accounts").select("id,state,recovery_ready,finalized_at").eq("user_id", user.id).maybeSingle()
    ]);
    if (!auction || auction.settlement_rail !== "card" || !["scheduled", "open"].includes(auction.state)) {
      return problem(409, "payment_setup_unavailable", "Payment setup is not open for this auction.", headers);
    }
    if (auction.terms_version !== config.auctions.termsVersion || auction.terms_hash !== config.auctions.termsHash) {
      return problem(409, "auction_terms_changed", "Payment setup is paused while the auction terms are reviewed.", headers);
    }
    if (maximumHammer > auction.maximum_card_bid_minor) return problem(422, "invalid_bid_limit", "The limit exceeds this auction's maximum.", headers);
    if (!primaryWalletReady(account)) {
      return problem(409, "wallet_not_ready", "Finish deploying your passkey wallet before adding a payment method.", headers);
    }
    const expiresAt = new Date(Date.now() + config.auctions.mandateHours * 60 * 60_000).toISOString();
    let { data: mandate, error: mandateError } = await service.from("bidder_payment_mandates")
      .select("*").eq("auction_id", auctionId).eq("bidder_user_id", user.id)
      .order("generation", { ascending: false }).limit(1).maybeSingle();
    if (mandateError) return problem(502, "payment_setup_unavailable", "Payment setup could not be prepared.", headers);
    if (mandate && new Date(mandate.expires_at) <= new Date() && ["setup-pending", "ready", "requires-action"].includes(mandate.state)) {
      const expired = await service.from("bidder_payment_mandates").update({ state: "expired" })
        .eq("id", mandate.id).eq("state", mandate.state).select("*").maybeSingle();
      if (expired.error || !expired.data) return problem(503, "payment_setup_reconciling", "Payment setup is reconciling. Retry shortly.", headers);
      mandate = expired.data;
    }
    if (!mandate || ["expired", "failed", "revoked"].includes(mandate.state)) {
      const created = await service.from("bidder_payment_mandates").insert({
        auction_id: auctionId,
        bidder_user_id: user.id,
        generation: (mandate?.generation || 0) + 1,
        maximum_hammer_minor: maximumHammer,
        mandate_terms_version: config.auctions.termsVersion,
        mandate_terms_hash: config.auctions.termsHash,
        expires_at: expiresAt
      }).select("*").single();
      mandate = created.data;
      mandateError = created.error;
    }
    if (mandateError || !mandate) return problem(502, "payment_setup_unavailable", "Payment setup could not be prepared.", headers);
    if (mandate.maximum_hammer_minor !== maximumHammer || mandate.mandate_terms_hash !== config.auctions.termsHash
      || mandate.mandate_terms_version !== config.auctions.termsVersion) {
      return problem(409, "payment_setup_conflict", "Start a new mandate after the existing one expires or is revoked.", headers);
    }
    if (mandate.state === "ready" && new Date(mandate.expires_at) > new Date()) {
      return json({ mandate_id: mandate.id, state: "ready" }, { headers });
    }
    const stripe = createAuctionStripeClient(config);
    if (mandate.setup_session_ref) {
      const existing = await stripe.checkout.sessions.retrieve(mandate.setup_session_ref);
      if (existing.status === "open" && existing.url) return json({ mandate_id: mandate.id, checkout_url: existing.url }, { headers });
      if (existing.status === "complete") {
        return json({ mandate_id: mandate.id, state: "processing" }, { status: 202, headers });
      }
      const { data: reset, error: resetError } = await service.from("bidder_payment_mandates").update({
        setup_session_ref: null,
        setup_intent_ref: null,
        payment_method_ref: null,
        state: "setup-pending",
        setup_attempt: mandate.setup_attempt + 1
      }).eq("id", mandate.id).eq("setup_session_ref", mandate.setup_session_ref).select("*").maybeSingle();
      if (resetError || !reset) return problem(503, "payment_setup_reconciling", "Payment setup is reconciling. Retry shortly.", headers);
      mandate = reset;
    }
    const customer = mandate.provider_customer_ref
      ? { id: mandate.provider_customer_ref }
      : await stripe.customers.create({ metadata: { grove_user_id: user.id } }, { idempotencyKey: `auction-customer:${mandate.id}` });
    const auctionForCheckout = { ...auction, title: auction.works?.title || "Grove work" };
    const session = await stripe.checkout.sessions.create(
      buildAuctionSetupSessionParameters({ auction: auctionForCheckout, mandate, customerId: customer.id, config }),
      { idempotencyKey: `auction-setup:${mandate.id}:${mandate.setup_attempt}` }
    );
    if (!session.url) throw new Error("CHECKOUT_URL_MISSING");
    const { data: attached, error: attachError } = await service.from("bidder_payment_mandates").update({
      provider_customer_ref: customer.id,
      setup_session_ref: session.id
    }).eq("id", mandate.id).is("setup_session_ref", null).select("id").maybeSingle();
    if (attachError || !attached) return problem(503, "payment_setup_reconciling", "Payment setup is reconciling. Retry shortly.", headers);
    return json({ mandate_id: mandate.id, checkout_url: session.url }, { status: 201, headers });
  } catch (error) {
    if (error instanceof ConfigurationError) return problem(503, "auction_not_configured", "Auction payment setup is not available.");
    return requestFailure(error) || problem(502, "payment_setup_unavailable", "Payment setup could not be started.");
  }
};

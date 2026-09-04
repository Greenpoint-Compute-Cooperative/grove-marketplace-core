import Stripe from "stripe";
import { hashTypedData } from "viem";
import { buildBidTypedData } from "../shared/bid-intent.js";
import { ConfigurationError, getRuntimeConfig } from "./config.js";
import { verifyErc1271Hash } from "./wallet.js";

export const requireAuctionConfig = () => {
  const config = getRuntimeConfig();
  if (!config.auctions.stagingConfigured || (config.productionDeployment && !config.auctions.liveReady)) {
    throw new ConfigurationError("Auctions are not configured.", [
      "GROVE_AUCTIONS_ENABLED=true",
      "GROVE_WALLET_ENABLED=true",
      "GROVE_ETHEREUM_CHAIN_ID=1",
      "GROVE_ETHEREUM_RPC_URL",
      "GROVE_STRIPE_NFT_APPROVAL_REF",
      "GROVE_AUCTION_TERMS_URL",
      "GROVE_AUCTION_TERMS_VERSION",
      "GROVE_AUCTION_TERMS_HASH",
      "GROVE_MAX_FIAT_HAMMER_MINOR",
      "Stripe, Supabase, ERC-4337 provider, and cron secrets"
    ]);
  }
  return config;
};

export const createAuctionStripeClient = (config = requireAuctionConfig()) => new Stripe(config.commerce.stripeSecretKey, {
  maxNetworkRetries: 2,
  timeout: 20_000,
  appInfo: { name: "Grove Marketplace Auctions", version: "1.2.0" }
});

export const auctionCollectionStateAllowed = ({ state, config }) => state === "active"
  || (state === "rehearsal" && config.auctions.rehearsalReady === true && config.wallet.chainId === 11155111);

export const buildAuctionSetupSessionParameters = ({ auction, mandate, customerId, config }) => ({
  mode: "setup",
  customer: customerId,
  payment_method_types: ["card"],
  billing_address_collection: "required",
  shipping_address_collection: { allowed_countries: ["US"] },
  phone_number_collection: { enabled: true },
  customer_update: { address: "auto", name: "auto", shipping: "auto" },
  consent_collection: { terms_of_service: "required" },
  custom_text: {
    submit: {
      message: `Save this payment method for the ${auction.title} auction. If you win, Grove may charge up to ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(mandate.maximum_hammer_minor / 100)} plus disclosed tax and shipping under ${mandate.mandate_terms_version}. A declined off-session charge requires you to return to complete payment.`
    }
  },
  metadata: {
    grove_flow: "auction-payment-setup",
    grove_auction_id: auction.id,
    grove_mandate_id: mandate.id,
    grove_terms_version: mandate.mandate_terms_version
  },
  setup_intent_data: {
    metadata: {
      grove_flow: "auction-payment-setup",
      grove_auction_id: auction.id,
      grove_mandate_id: mandate.id
    }
  },
  success_url: `${config.siteUrl}/?auction_setup=success&auction_id=${encodeURIComponent(auction.id)}`,
  cancel_url: `${config.siteUrl}/?auction_setup=cancelled&auction_id=${encodeURIComponent(auction.id)}`
});

export const buildWinnerPaymentIntentParameters = ({ settlement, mandate }) => {
  if (!Number.isSafeInteger(settlement.total_amount) || settlement.total_amount < 50) {
    throw new Error("INVALID_SETTLEMENT_TOTAL");
  }
  return {
    amount: settlement.total_amount,
    currency: "usd",
    customer: mandate.provider_customer_ref,
    payment_method: mandate.payment_method_ref,
    payment_method_types: ["card"],
    confirm: false,
    metadata: {
      grove_flow: "auction-settlement",
      grove_auction_id: settlement.auction_id,
      grove_settlement_id: settlement.id,
      grove_winning_bid_id: settlement.winning_bid_id
    }
  };
};

export const buildWinnerPaymentIntentConfirmationParameters = () => ({
  off_session: true,
  error_on_requires_action: false
});

const minorAmount = (value, code, { minimum = 0 } = {}) => {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < minimum) throw new Error(code);
  return amount;
};

export const buildAuctionTaxCalculationParameters = ({ settlement, mandate, work, shippingAmount = 0 }) => {
  const hammerAmount = minorAmount(settlement.hammer_amount, "INVALID_HAMMER_AMOUNT", { minimum: 50 });
  const shipping = minorAmount(shippingAmount, "INVALID_SHIPPING_AMOUNT");
  if (!/^cus_/.test(String(mandate.provider_customer_ref || ""))) throw new Error("INVALID_STRIPE_CUSTOMER");
  if (!/^txcd_[0-9]+$/.test(String(work.stripe_tax_code || ""))) throw new Error("INVALID_STRIPE_TAX_CODE");
  const parameters = {
    currency: "usd",
    customer: mandate.provider_customer_ref,
    line_items: [{
      amount: hammerAmount,
      reference: settlement.id,
      tax_behavior: "exclusive",
      tax_code: work.stripe_tax_code
    }]
  };
  if (shipping) parameters.shipping_cost = { amount: shipping, tax_behavior: "exclusive" };
  return parameters;
};

export const auctionAmountsFromTaxCalculation = ({ calculation, hammerAmount, shippingAmount = 0 }) => {
  const hammer = minorAmount(hammerAmount, "INVALID_HAMMER_AMOUNT", { minimum: 50 });
  const shipping = minorAmount(shippingAmount, "INVALID_SHIPPING_AMOUNT");
  const total = minorAmount(calculation?.amount_total, "INVALID_TAX_CALCULATION", { minimum: 50 });
  if (!/^taxcalc_/.test(String(calculation?.id || "")) || String(calculation?.currency || "").toLowerCase() !== "usd") {
    throw new Error("INVALID_TAX_CALCULATION");
  }
  const tax = total - hammer - shipping;
  if (!Number.isSafeInteger(tax) || tax < 0) throw new Error("INVALID_TAX_CALCULATION");
  return { taxAmount: tax, shippingAmount: shipping, totalAmount: total };
};

export const assertAuctionPaymentIntent = ({ paymentIntent, settlement, mandate, flow = "auction-settlement" }) => {
  const total = minorAmount(settlement.total_amount, "INVALID_SETTLEMENT_TOTAL", { minimum: 50 });
  const reference = (value) => typeof value === "string" ? value : value?.id;
  if (!/^pi_/.test(String(paymentIntent?.id || ""))
      || paymentIntent.amount !== total
      || String(paymentIntent.currency || "").toLowerCase() !== "usd"
      || paymentIntent.metadata?.grove_flow !== flow
      || paymentIntent.metadata?.grove_settlement_id !== settlement.id
      || paymentIntent.metadata?.grove_auction_id !== settlement.auction_id
      || paymentIntent.metadata?.grove_winning_bid_id !== settlement.winning_bid_id
      || (mandate && reference(paymentIntent.customer) !== mandate.provider_customer_ref)
      || (mandate && reference(paymentIntent.payment_method) !== mandate.payment_method_ref)) {
    throw new Error("PAYMENT_INTENT_MISMATCH");
  }
  return paymentIntent;
};

export const buildAuctionCureSessionParameters = ({ settlement, customerId, workTitle, config, expiresAt }) => {
  const total = minorAmount(settlement.total_amount, "INVALID_SETTLEMENT_TOTAL", { minimum: 50 });
  if (!/^cus_/.test(String(customerId || ""))) throw new Error("INVALID_STRIPE_CUSTOMER");
  const metadata = {
    grove_flow: "auction-payment-cure",
    grove_auction_id: settlement.auction_id,
    grove_settlement_id: settlement.id,
    grove_winning_bid_id: settlement.winning_bid_id
  };
  return {
    mode: "payment",
    customer: customerId,
    client_reference_id: settlement.id,
    payment_method_types: ["card"],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: total,
        product_data: { name: `${workTitle || "Grove work"} — auction settlement` }
      }
    }],
    automatic_tax: { enabled: false },
    metadata,
    payment_intent_data: { metadata },
    expires_at: Math.floor(new Date(expiresAt).getTime() / 1000),
    success_url: `${config.siteUrl}/?auction_payment=success&auction_id=${encodeURIComponent(settlement.auction_id)}`,
    cancel_url: `${config.siteUrl}/?auction_payment=cancelled&auction_id=${encodeURIComponent(settlement.auction_id)}`
  };
};

export const ensureAuctionTaxTransaction = async ({ stripe, settlement, paymentIntent, providerCreatedAt }) => {
  if (!settlement.tax_calculation_ref) throw new Error("TAX_CALCULATION_MISSING");
  const reference = `auction:${settlement.id}`;
  const transaction = settlement.tax_transaction_ref
    ? await stripe.tax.transactions.retrieve(settlement.tax_transaction_ref)
    : await stripe.tax.transactions.createFromCalculation({
      calculation: settlement.tax_calculation_ref,
      reference,
      posted_at: providerCreatedAt,
      metadata: {
        grove_settlement_id: settlement.id,
        grove_payment_intent_id: paymentIntent.id
      }
    }, { idempotencyKey: `auction-tax-transaction:${settlement.id}` });
  if (!/^tax_/.test(String(transaction?.id || "")) || transaction.type !== "transaction"
      || transaction.currency?.toLowerCase() !== "usd" || transaction.reference !== reference) {
    throw new Error("TAX_TRANSACTION_MISMATCH");
  }
  return transaction;
};

export const ensureAuctionTaxReversal = async ({ stripe, settlement, paymentIntent, refund }) => {
  if (!settlement.tax_transaction_ref || refund.status !== "succeeded") throw new Error("TAX_REVERSAL_NOT_READY");
  const full = refund.amount === paymentIntent.amount;
  const parameters = {
    mode: full ? "full" : "partial",
    original_transaction: settlement.tax_transaction_ref,
    reference: `auction-refund:${refund.id}`,
    metadata: { grove_settlement_id: settlement.id, grove_refund_id: refund.id }
  };
  if (!full) parameters.flat_amount = -refund.amount;
  const reversal = await stripe.tax.transactions.createReversal(parameters, {
    idempotencyKey: `auction-tax-reversal:${refund.id}`
  });
  if (!/^tax_/.test(String(reversal?.id || "")) || reversal.type !== "reversal"
      || reversal.reversal?.original_transaction !== settlement.tax_transaction_ref
      || reversal.reference !== parameters.reference) {
    throw new Error("TAX_REVERSAL_MISMATCH");
  }
  return reversal;
};

export const verifyBidIntent = async ({ config, intent, signature }) => {
  const typedData = buildBidTypedData(intent);
  const intentHash = hashTypedData(typedData);
  const verification = await verifyErc1271Hash({ config, address: intent.bidderSafe, hash: intentHash, signature });
  return { ...verification, intentHash, typedData };
};

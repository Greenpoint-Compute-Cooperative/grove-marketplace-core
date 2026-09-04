import Stripe from "stripe";
import { ConfigurationError, getRuntimeConfig } from "./config.js";

export const requireCardCheckoutConfig = () => {
  const config = getRuntimeConfig();
  if (!config.commerce.cardCheckoutConfigured) {
    throw new ConfigurationError("Card checkout is not configured.", [
      "GROVE_ACQUISITION_ENABLED=true",
      "SUPABASE_SECRET_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "GROVE_SELLER_TERMS_VERSION",
      "GROVE_BUYER_TERMS_URL",
      "GROVE_BUYER_TERMS_VERSION",
      "GROVE_MAX_ITEM_PRICE_MINOR",
      "CRON_SECRET",
      "GROVE_STRIPE_AUTOMATIC_TAX=true",
      "GROVE_SITE_URL"
    ]);
  }
  return config;
};

export const requireStripeWebhookConfig = () => {
  const config = getRuntimeConfig();
  if (!config.commerce.stripeWebhookConfigured) {
    throw new ConfigurationError("Stripe webhook ingestion is not configured.", [
      "SUPABASE_SECRET_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET"
    ]);
  }
  return config;
};

export const createStripeClient = (config = requireCardCheckoutConfig()) => new Stripe(config.commerce.stripeSecretKey, {
  maxNetworkRetries: 2,
  timeout: 20_000,
  appInfo: { name: "Grove Marketplace", version: "1.2.0" }
});

export const buildCheckoutSessionParameters = (reservation, config) => {
  const expiresAt = Math.floor(new Date(reservation.reservation_expires_at).getTime() / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 - Date.now() < 30 * 60_000) {
    throw new Error("CHECKOUT_EXPIRY_TOO_SOON");
  }
  const workRoute = `#work/${encodeURIComponent(reservation.slug)}`;
  const productData = {
    name: `${reservation.title} — ${reservation.artist_name}`,
    metadata: {
      grove_work_id: reservation.work_id,
      grove_work_format: reservation.format,
      grove_terms_version: reservation.buyer_terms_version
    }
  };
  if (reservation.stripe_tax_code) productData.tax_code = reservation.stripe_tax_code;

  const parameters = {
    mode: "payment",
    client_reference_id: reservation.acquisition_id,
    customer_creation: "always",
    payment_method_types: ["card"],
    consent_collection: { terms_of_service: "required" },
    billing_address_collection: "required",
    phone_number_collection: { enabled: Boolean(reservation.requires_shipping) },
    automatic_tax: { enabled: config.commerce.automaticTax },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: reservation.currency.toLowerCase(),
        unit_amount: reservation.amount_minor,
        tax_behavior: "exclusive",
        product_data: productData
      }
    }],
    metadata: {
      grove_acquisition_id: reservation.acquisition_id,
      grove_work_id: reservation.work_id
    },
    payment_intent_data: {
      metadata: {
        grove_acquisition_id: reservation.acquisition_id,
        grove_work_id: reservation.work_id
      }
    },
    expires_at: expiresAt,
    success_url: `${config.siteUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}${workRoute}`,
    cancel_url: `${config.siteUrl}/?checkout=cancelled${workRoute}`
  };

  if (reservation.requires_shipping) {
    parameters.shipping_address_collection = { allowed_countries: ["US"] };
    parameters.shipping_options = [{ shipping_rate: reservation.stripe_shipping_rate_id }];
  }
  return parameters;
};

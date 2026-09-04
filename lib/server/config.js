const enabled = (value) => /^(1|true|yes|on)$/i.test(String(value || ""));

const value = (name) => String(process.env[name] || "").trim();

export const deploymentEnvironment = () => value("VERCEL_TARGET_ENV") || value("VERCEL_ENV") || "local";

export const isProductionDeployment = () => value("VERCEL_ENV") === "production"
  || deploymentEnvironment() === "production";

const integer = (name, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(value(name), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

const siteOrigin = (input) => {
  if (!input) return "";
  try {
    const url = new URL(input);
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    return url.protocol === "https:" || localHttp ? url.origin : "";
  } catch {
    return "";
  }
};

const httpsUrl = (input) => {
  try {
    const url = new URL(input);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};

const ethereumAddress = (input) => /^0x[0-9a-f]{40}$/.test(input) ? input : "";
const ethereumHash = (input) => /^0x[0-9a-f]{64}$/.test(input) ? input : "";
const unsignedInteger = (input) => /^(0|[1-9][0-9]{0,77})$/.test(input) ? input : "";

export class ConfigurationError extends Error {
  constructor(message, missing = []) {
    super(message);
    this.name = "ConfigurationError";
    this.missing = missing;
  }
}

export const getRuntimeConfig = () => {
  const targetEnvironment = deploymentEnvironment();
  const productionDeployment = isProductionDeployment();
  const supabaseUrl = value("SUPABASE_URL");
  const supabaseKey = value("SUPABASE_PUBLISHABLE_KEY") || value("SUPABASE_ANON_KEY");
  const supabaseSecretKey = value("SUPABASE_SECRET_KEY");
  const stagingSupabaseProjectRef = /^[a-z0-9]{20}$/.test(value("GROVE_STAGING_SUPABASE_PROJECT_REF"))
    ? value("GROVE_STAGING_SUPABASE_PROJECT_REF") : "";
  let supabaseProjectRef = "";
  try {
    const match = new URL(supabaseUrl).hostname.match(/^([a-z0-9]{20})\.supabase\.co$/);
    supabaseProjectRef = match?.[1] || "";
  } catch {}
  const backendConfigured = Boolean(supabaseUrl && supabaseKey);
  const metricsEnabled = enabled(value("GROVE_METRICS_ENABLED"));
  const instagramBotEnabled = enabled(value("GROVE_INSTAGRAM_BOT_ENABLED"));
  const instagramWebhookVerifyToken = value("GROVE_INSTAGRAM_WEBHOOK_VERIFY_TOKEN");
  const instagramAppSecret = value("GROVE_INSTAGRAM_APP_SECRET");
  const syntheticSocialAuthEnabled = enabled(value("GROVE_SYNTHETIC_SOCIAL_AUTH_ENABLED"));
  const syntheticSocialAuthSigningSecret = value("GROVE_SYNTHETIC_SOCIAL_AUTH_SIGNING_SECRET");
  const syntheticSocialAuthOperatorToken = value("GROVE_SYNTHETIC_SOCIAL_AUTH_OPERATOR_TOKEN");
  const acquisitionEnabled = enabled(value("GROVE_ACQUISITION_ENABLED"));
  const stripeSecretKey = value("STRIPE_SECRET_KEY");
  const stripeWebhookSecret = value("STRIPE_WEBHOOK_SECRET");
  const sellerTermsVersion = value("GROVE_SELLER_TERMS_VERSION");
  const buyerTermsUrl = httpsUrl(value("GROVE_BUYER_TERMS_URL"));
  const buyerTermsVersion = value("GROVE_BUYER_TERMS_VERSION");
  const maximumItemPriceMinor = integer("GROVE_MAX_ITEM_PRICE_MINOR", 0, { minimum: 50, maximum: 100_000_000 });
  const cronSecret = value("CRON_SECRET");
  const configuredSiteUrl = siteOrigin(value("GROVE_SITE_URL"));
  const automaticTax = enabled(value("GROVE_STRIPE_AUTOMATIC_TAX"));
  const auctionsEnabled = enabled(value("GROVE_AUCTIONS_ENABLED"));
  const walletEnabled = enabled(value("GROVE_WALLET_ENABLED"));
  const ethereumChainId = integer("GROVE_ETHEREUM_CHAIN_ID", 0, { minimum: 1, maximum: 11155111 });
  const ethereumRpcUrl = httpsUrl(value("GROVE_ETHEREUM_RPC_URL"));
  const stripeNftApprovalRef = value("GROVE_STRIPE_NFT_APPROVAL_REF");
  const auctionTermsUrl = httpsUrl(value("GROVE_AUCTION_TERMS_URL"));
  const auctionTermsVersion = value("GROVE_AUCTION_TERMS_VERSION");
  const auctionTermsHash = /^0x[0-9a-f]{64}$/.test(value("GROVE_AUCTION_TERMS_HASH"))
    ? value("GROVE_AUCTION_TERMS_HASH")
    : "";
  const maximumFiatHammerMinor = integer("GROVE_MAX_FIAT_HAMMER_MINOR", 0, { minimum: 50, maximum: 100_000_000 });
  const entryPointAddress = ethereumAddress(value("GROVE_ENTRY_POINT_ADDRESS"));
  const safeFactoryAddress = ethereumAddress(value("GROVE_SAFE_FACTORY_ADDRESS"));
  const safeSingletonAddress = ethereumAddress(value("GROVE_SAFE_SINGLETON_ADDRESS"));
  const inventorySafeSingletonAddress = ethereumAddress(value("GROVE_INVENTORY_SAFE_SINGLETON_ADDRESS"));
  const safeFallbackHandlerAddress = ethereumAddress(value("GROVE_SAFE_FALLBACK_HANDLER_ADDRESS"));
  const safeWebAuthnSharedSignerAddress = ethereumAddress(value("GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS"));
  const safe4337ModuleAddress = ethereumAddress(value("GROVE_SAFE_4337_MODULE_ADDRESS"));
  const safePasskeyVerifierAddress = ethereumAddress(value("GROVE_SAFE_PASSKEY_VERIFIER_ADDRESS"));
  const safeModuleSetupAddress = ethereumAddress(value("GROVE_SAFE_MODULE_SETUP_ADDRESS"));
  const safeMultiSendAddress = ethereumAddress(value("GROVE_SAFE_MULTISEND_ADDRESS"));
  const entryPointCodeHash = ethereumHash(value("GROVE_ENTRY_POINT_CODE_HASH"));
  const safeFactoryCodeHash = ethereumHash(value("GROVE_SAFE_FACTORY_CODE_HASH"));
  const safeProxyCodeHash = ethereumHash(value("GROVE_SAFE_PROXY_CODE_HASH"));
  const safeSingletonCodeHash = ethereumHash(value("GROVE_SAFE_SINGLETON_CODE_HASH"));
  const inventorySafeSingletonCodeHash = ethereumHash(value("GROVE_INVENTORY_SAFE_SINGLETON_CODE_HASH"));
  const safeFallbackHandlerCodeHash = ethereumHash(value("GROVE_SAFE_FALLBACK_HANDLER_CODE_HASH"));
  const safeWebAuthnSharedSignerCodeHash = ethereumHash(value("GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_CODE_HASH"));
  const safe4337ModuleCodeHash = ethereumHash(value("GROVE_SAFE_4337_MODULE_CODE_HASH"));
  const safePasskeyVerifierCodeHash = ethereumHash(value("GROVE_SAFE_PASSKEY_VERIFIER_CODE_HASH"));
  const safeModuleSetupCodeHash = ethereumHash(value("GROVE_SAFE_MODULE_SETUP_CODE_HASH"));
  const safeMultiSendCodeHash = ethereumHash(value("GROVE_SAFE_MULTISEND_CODE_HASH"));
  const safe4337TupleCoherent = Boolean(
    safeFallbackHandlerAddress && safe4337ModuleAddress
      && safeFallbackHandlerAddress === safe4337ModuleAddress
      && safeFallbackHandlerCodeHash && safe4337ModuleCodeHash
      && safeFallbackHandlerCodeHash === safe4337ModuleCodeHash
  );
  const bundlerUrl = httpsUrl(value("GROVE_BUNDLER_URL"));
  const paymasterUrl = httpsUrl(value("GROVE_PAYMASTER_URL"));
  const paymasterApiToken = value("GROVE_PAYMASTER_API_TOKEN");
  const sponsorPolicyVersion = value("GROVE_SPONSOR_POLICY_VERSION");
  const sponsorExecutionEnabled = enabled(value("GROVE_SPONSOR_EXECUTION_ENABLED"));
  const ownerExitEnabled = enabled(value("GROVE_OWNER_EXIT_ENABLED"));
  const sponsorPerOperationWei = unsignedInteger(value("GROVE_SPONSOR_PER_OPERATION_MAX_WEI"));
  const sponsorPerUserDailyWei = unsignedInteger(value("GROVE_SPONSOR_PER_USER_DAILY_MAX_WEI"));
  const sponsorGlobalDailyWei = unsignedInteger(value("GROVE_SPONSOR_GLOBAL_DAILY_MAX_WEI"));
  const sponsorBudgetsConfigured = Boolean(
    sponsorPerOperationWei && sponsorPerUserDailyWei && sponsorGlobalDailyWei
      && BigInt(sponsorPerOperationWei) > 0n
      && BigInt(sponsorPerUserDailyWei) >= BigInt(sponsorPerOperationWei)
      && BigInt(sponsorGlobalDailyWei) >= BigInt(sponsorPerUserDailyWei)
  );
  // Code presence is not a release attestation. Keep public readiness false
  // until the provider-neutral pipeline passes the independent Sepolia E2E.
  const sponsorExecutionReady = false;
  // A separate release attestation keeps withdrawal availability independent
  // from new secondary-market activity. Flip only after the Sepolia owner-exit E2E.
  const ownerExitReady = false;
  const ownerExitLiveReady = false;
  const secondaryEnabled = enabled(value("GROVE_SECONDARY_ENABLED"));
  const seaportAddress = ethereumAddress(value("GROVE_SEAPORT_ADDRESS"));
  const seaportCodeHash = ethereumHash(value("GROVE_SEAPORT_CODE_HASH"));
  const seaportVersion = value("GROVE_SEAPORT_VERSION");
  const seaportConduitKey = ethereumHash(value("GROVE_SEAPORT_CONDUIT_KEY"));
  const usdcAddress = ethereumAddress(value("GROVE_USDC_ADDRESS"));
  const usdcCodeHash = ethereumHash(value("GROVE_USDC_CODE_HASH"));
  const secondaryFeeRecipient = ethereumAddress(value("GROVE_SECONDARY_FEE_RECIPIENT"));
  const secondaryFeeBps = integer("GROVE_SECONDARY_FEE_BPS", -1, { minimum: 0, maximum: 1_000 });
  const secondaryMinPrice = unsignedInteger(value("GROVE_SECONDARY_MIN_PRICE"));
  const secondaryMaxPrice = unsignedInteger(value("GROVE_SECONDARY_MAX_PRICE"));
  const secondaryMaxDurationSeconds = integer("GROVE_SECONDARY_MAX_DURATION_SECONDS", 0, { minimum: 3_600, maximum: 7_776_000 });
  const chainIndexerStartBlock = integer("GROVE_CHAIN_INDEXER_START_BLOCK", -1, { minimum: 0 });
  const secondaryTermsVersion = value("GROVE_SECONDARY_TERMS_VERSION");
  const secondaryTermsHash = ethereumHash(value("GROVE_SECONDARY_TERMS_HASH"));
  const openSeaEnabled = enabled(value("GROVE_OPENSEA_ENABLED"));
  const openSeaApiKey = value("OPENSEA_API_KEY");
  const openSeaCollectionSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value("GROVE_OPENSEA_COLLECTION_SLUG"))
    ? value("GROVE_OPENSEA_COLLECTION_SLUG") : "";
  const stripeWebhookConfigured = Boolean(backendConfigured && supabaseSecretKey && stripeSecretKey && stripeWebhookSecret);
  const cardCheckoutConfigured = Boolean(
    stripeWebhookConfigured && configuredSiteUrl && acquisitionEnabled && automaticTax && sellerTermsVersion
      && buyerTermsUrl && buyerTermsVersion && maximumItemPriceMinor && cronSecret
  );
  const nonProductionChainAllowed = !productionDeployment && ethereumChainId === 11155111;
  // Receipt reads and canonical finalization survive feature kill switches.
  // Only the private ledger plus immutable chain/EntryPoint tuple are
  // required; new-action flags, sponsor budgets, and paymaster access are not.
  const sponsorshipReconciliationConfigured = Boolean(
    backendConfigured && supabaseSecretKey
      && (productionDeployment ? ethereumChainId === 1 : nonProductionChainAllowed)
      && ethereumRpcUrl && entryPointAddress
  );
  // Primary auctions need a passkey-controlled Safe and chain attestation, but
  // placing an off-chain signed bid does not require a bundler or paymaster.
  // Keep identity readiness independent from sponsored secondary execution.
  const walletIdentityStagingConfigured = Boolean(
    sponsorshipReconciliationConfigured && walletEnabled
      && entryPointAddress && safeFactoryAddress && safeSingletonAddress && safeFallbackHandlerAddress && safeWebAuthnSharedSignerAddress
      && safe4337ModuleAddress && safePasskeyVerifierAddress
      && safeModuleSetupAddress && safeMultiSendAddress
      && entryPointCodeHash && safeFactoryCodeHash && safeProxyCodeHash && safeSingletonCodeHash
      && safeFallbackHandlerCodeHash && safeWebAuthnSharedSignerCodeHash && safe4337ModuleCodeHash && safePasskeyVerifierCodeHash
      && safeModuleSetupCodeHash && safeMultiSendCodeHash
      && safe4337TupleCoherent
  );
  const walletStagingConfigured = Boolean(
    walletIdentityStagingConfigured
      && bundlerUrl && paymasterUrl && paymasterApiToken && sponsorPolicyVersion
  );
  const auctionStagingConfigured = Boolean(
    stripeWebhookConfigured && auctionsEnabled && walletIdentityStagingConfigured && configuredSiteUrl && automaticTax
      && stripeNftApprovalRef && auctionTermsUrl && auctionTermsVersion && auctionTermsHash
      && maximumFiatHammerMinor && cronSecret && inventorySafeSingletonAddress && inventorySafeSingletonCodeHash
  );
  const zeroConduitKey = `0x${"0".repeat(64)}`;
  const secondaryInfrastructureConfigured = Boolean(
    backendConfigured && supabaseSecretKey && secondaryEnabled && ethereumRpcUrl
      && (productionDeployment ? ethereumChainId === 1 : nonProductionChainAllowed)
      && seaportAddress && seaportCodeHash && seaportVersion === "1.6"
      && seaportConduitKey === zeroConduitKey && usdcAddress && usdcCodeHash
      && secondaryFeeBps >= 0 && (secondaryFeeBps === 0 || secondaryFeeRecipient)
      && secondaryMinPrice && secondaryMaxPrice
      && BigInt(secondaryMaxPrice || 0) >= BigInt(secondaryMinPrice || 1)
      && secondaryMaxDurationSeconds && chainIndexerStartBlock >= 0
      && secondaryTermsVersion && secondaryTermsHash
  );
  // Reconciliation is a safety path, not a new-action path. It must remain
  // available after the secondary-market kill switch stops new orders/fills.
  const secondaryReconciliationConfigured = Boolean(
    backendConfigured && supabaseSecretKey && ethereumRpcUrl
      && (productionDeployment ? ethereumChainId === 1 : nonProductionChainAllowed)
      && seaportAddress && seaportCodeHash && seaportVersion === "1.6"
      && usdcAddress && usdcCodeHash && chainIndexerStartBlock >= 0
  );
  const ownerExitInfrastructureConfigured = Boolean(
    backendConfigured && supabaseSecretKey && walletStagingConfigured
      && seaportAddress && seaportCodeHash && seaportVersion === "1.6"
      && chainIndexerStartBlock >= 0 && sponsorBudgetsConfigured
  );
  const ownerExitStagingConfigured = Boolean(
    ["preview", "staging"].includes(targetEnvironment)
      && !productionDeployment && ethereumChainId === 11155111
      && ownerExitInfrastructureConfigured && ownerExitEnabled
      && sponsorExecutionEnabled && sponsorExecutionReady && ownerExitReady
  );
  const ownerExitLiveConfigured = Boolean(
    targetEnvironment === "production"
      && productionDeployment && ethereumChainId === 1
      && ownerExitInfrastructureConfigured && ownerExitEnabled
      && sponsorExecutionEnabled && sponsorExecutionReady && ownerExitLiveReady
  );
  const ownerExitExecutableConfigured = ownerExitStagingConfigured || ownerExitLiveConfigured;
  const secondaryStagingConfigured = Boolean(
    secondaryInfrastructureConfigured && walletStagingConfigured
      && sponsorExecutionEnabled && sponsorExecutionReady
  );
  // Preview and the dedicated staging target are the only environments where a
  // fully configured Sepolia stack may advertise the rehearsal UI. Production
  // remains gated by separately reviewed liveReady attestations below.
  const walletRehearsalReady = Boolean(
    ["preview", "staging"].includes(targetEnvironment)
      && !productionDeployment
      && ethereumChainId === 11155111
      && walletIdentityStagingConfigured
  );
  const auctionRehearsalReady = Boolean(walletRehearsalReady && auctionStagingConfigured);
  const secondaryRehearsalReady = Boolean(
    ["preview", "staging"].includes(targetEnvironment)
      && !productionDeployment && ethereumChainId === 11155111
      && secondaryStagingConfigured
  );
  // Mainnet activation is a reviewed release attestation, not an environment
  // variable. Keeping this false prevents credentials alone from launching.
  const secondaryLiveReady = false;
  const openSeaStagingConfigured = Boolean(
    openSeaEnabled && productionDeployment && ethereumChainId === 1
      && openSeaApiKey && openSeaCollectionSlug && secondaryStagingConfigured
  );
  const openSeaLiveReady = false;
  const syntheticSocialAuthConfigured = Boolean(
    targetEnvironment === "staging" && !productionDeployment
      && backendConfigured && supabaseSecretKey && configuredSiteUrl
      && stagingSupabaseProjectRef && supabaseProjectRef === stagingSupabaseProjectRef
      && syntheticSocialAuthEnabled
      && Buffer.byteLength(syntheticSocialAuthSigningSecret, "utf8") >= 32
      && Buffer.byteLength(syntheticSocialAuthOperatorToken, "utf8") >= 32
  );

  return {
    targetEnvironment,
    productionDeployment,
    supabaseUrl,
    supabaseKey,
    supabaseSecretKey,
    backendConfigured,
    siteUrl: configuredSiteUrl,
    providers: {
      instagram: {
        id: value("GROVE_INSTAGRAM_PROVIDER") || "custom:instagram",
        scopes: value("GROVE_INSTAGRAM_SCOPES") || "instagram_business_basic",
        enabled: enabled(value("GROVE_INSTAGRAM_OAUTH_ENABLED"))
      },
      x: {
        id: value("GROVE_X_PROVIDER") || "x",
        scopes: value("GROVE_X_SCOPES") || "users.read",
        enabled: enabled(value("GROVE_X_OAUTH_ENABLED"))
      }
    },
    instagramBot: {
      enabled: instagramBotEnabled,
      configured: Boolean(
        backendConfigured && supabaseSecretKey && instagramBotEnabled
          && instagramWebhookVerifyToken && instagramAppSecret
      ),
      webhookVerifyToken: instagramWebhookVerifyToken,
      appSecret: instagramAppSecret
    },
    syntheticSocialAuth: {
      enabled: syntheticSocialAuthEnabled,
      configured: syntheticSocialAuthConfigured,
      stagingSupabaseProjectRef,
      projectRefMatches: Boolean(stagingSupabaseProjectRef && supabaseProjectRef === stagingSupabaseProjectRef),
      signingSecret: syntheticSocialAuthSigningSecret,
      operatorToken: syntheticSocialAuthOperatorToken,
      ticketTtlSeconds: 120
    },
    acquisitionEnabled,
    commerce: {
      cardCheckoutConfigured,
      stripeWebhookConfigured,
      stripeSecretKey,
      stripeWebhookSecret,
      sellerTermsVersion,
      buyerTermsUrl,
      buyerTermsVersion,
      maximumItemPriceMinor,
      automaticTax,
      reservationMinutes: integer("GROVE_CHECKOUT_RESERVATION_MINUTES", 35, { minimum: 35, maximum: 60 })
    },
    wallet: {
      identityStagingConfigured: walletIdentityStagingConfigured,
      stagingConfigured: walletStagingConfigured,
      rehearsalReady: walletRehearsalReady,
      liveReady: false,
      enabled: walletEnabled,
      chainId: ethereumChainId,
      rpcUrl: ethereumRpcUrl,
      entryPointAddress,
      safeFactoryAddress,
      safeSingletonAddress,
      safeFallbackHandlerAddress,
      safeWebAuthnSharedSignerAddress,
      safe4337ModuleAddress,
      safePasskeyVerifierAddress,
      safeModuleSetupAddress,
      safeMultiSendAddress,
      entryPointCodeHash,
      safeFactoryCodeHash,
      safeProxyCodeHash,
      safeSingletonCodeHash,
      safeFallbackHandlerCodeHash,
      safeWebAuthnSharedSignerCodeHash,
      safe4337ModuleCodeHash,
      safePasskeyVerifierCodeHash,
      safeModuleSetupCodeHash,
      safeMultiSendCodeHash,
      bundlerUrl,
      paymasterUrl,
      paymasterApiToken,
      sponsorPolicyVersion,
      sponsorExecutionEnabled,
      sponsorExecutionReady,
      ownerExitEnabled,
      ownerExitReady,
      ownerExitLiveReady,
      ownerExitInfrastructureConfigured,
      ownerExitStagingConfigured,
      ownerExitLiveConfigured,
      ownerExitExecutableConfigured,
      sponsorshipReconciliationConfigured,
      sponsorBudgetsConfigured,
      sponsorBudgets: {
        perOperationWei: sponsorPerOperationWei,
        perUserDailyWei: sponsorPerUserDailyWei,
        globalDailyWei: sponsorGlobalDailyWei
      },
      safeVersion: "1.4.1",
      moduleVersion: "0.3.0",
      passkeyVersion: "0.2.1-1",
      entryPointVersion: "0.7"
    },
    auctions: {
      stagingConfigured: auctionStagingConfigured,
      rehearsalReady: auctionRehearsalReady,
      liveReady: false,
      enabled: auctionsEnabled,
      stripeNftApprovalRef,
      termsUrl: auctionTermsUrl,
      termsVersion: auctionTermsVersion,
      termsHash: auctionTermsHash,
      maximumFiatHammerMinor,
      mandateHours: integer("GROVE_AUCTION_MANDATE_HOURS", 168, { minimum: 1, maximum: 720 }),
      settlementHours: integer("GROVE_AUCTION_SETTLEMENT_HOURS", 48, { minimum: 1, maximum: 720 }),
      riskHoldHours: integer("GROVE_AUCTION_RISK_HOLD_HOURS", 168, { minimum: 0, maximum: 720 }),
      inventorySafeSingletonAddress,
      inventorySafeSingletonCodeHash
    },
    secondary: {
      infrastructureConfigured: secondaryInfrastructureConfigured,
      reconciliationConfigured: secondaryReconciliationConfigured,
      stagingConfigured: secondaryStagingConfigured,
      rehearsalReady: secondaryRehearsalReady,
      liveReady: secondaryLiveReady,
      enabled: secondaryEnabled,
      protocol: "seaport-1.6",
      protocolAddress: seaportAddress,
      protocolCodeHash: seaportCodeHash,
      protocolVersion: seaportVersion,
      conduitKey: seaportConduitKey,
      usdcAddress,
      usdcCodeHash,
      feeRecipient: secondaryFeeRecipient,
      feeBps: secondaryFeeBps,
      minimumPrice: secondaryMinPrice,
      maximumPrice: secondaryMaxPrice,
      maximumDurationSeconds: secondaryMaxDurationSeconds,
      indexerStartBlock: chainIndexerStartBlock,
      termsVersion: secondaryTermsVersion,
      termsHash: secondaryTermsHash
    },
    openSea: {
      stagingConfigured: openSeaStagingConfigured,
      liveReady: openSeaLiveReady,
      enabled: openSeaEnabled,
      apiKey: openSeaApiKey,
      collectionSlug: openSeaCollectionSlug,
      supported: productionDeployment && ethereumChainId === 1
    },
    metricsEnabled,
    metricsConfigured: backendConfigured && metricsEnabled && Boolean(supabaseSecretKey),
    metricsReadToken: value("GROVE_METRICS_READ_TOKEN"),
    cronSecret
  };
};

export const requireBackendConfig = () => {
  const config = getRuntimeConfig();
  if (config.backendConfigured) return config;

  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseKey) missing.push("SUPABASE_PUBLISHABLE_KEY");
  throw new ConfigurationError("The marketplace backend is not configured.", missing);
};

export const requireSyntheticSocialAuthConfig = () => {
  const config = getRuntimeConfig();
  if (config.syntheticSocialAuth.configured) return config;
  throw new ConfigurationError("Synthetic social authentication is available only in the isolated staging environment.", [
    "VERCEL_TARGET_ENV=staging",
    "GROVE_SYNTHETIC_SOCIAL_AUTH_ENABLED=true",
    "GROVE_STAGING_SUPABASE_PROJECT_REF matching the staging SUPABASE_URL",
    "32-byte synthetic-auth signing and operator secrets",
    "staging Supabase service configuration"
  ]);
};

export const requireSecondaryConfig = () => {
  const config = getRuntimeConfig();
  const ready = config.secondary.rehearsalReady || config.secondary.liveReady;
  if (ready) return config;

  throw new ConfigurationError("Secondary sales are not configured.", [
    "GROVE_SECONDARY_ENABLED=true",
    "finalized Seaport, USDC, indexer, smart-wallet, bundler, and paymaster configuration"
  ]);
};

export const requireOwnerExitConfig = (config = getRuntimeConfig()) => {
  if (config.wallet.ownerExitExecutableConfigured) return config;
  throw new ConfigurationError("NFT owner exit is not configured for this environment.", [
    "GROVE_OWNER_EXIT_ENABLED=true",
    "nonzero sponsorship budget limits",
    "reviewed environment-specific owner-exit and sponsored UserOperation attestations"
  ]);
};

export const requireSecondaryIndexerConfig = () => {
  const config = getRuntimeConfig();
  if (config.secondary.reconciliationConfigured) return config;
  throw new ConfigurationError("The secondary-market indexer is not configured.", [
    "finalized Seaport, USDC, RPC, indexer start block, and database configuration"
  ]);
};

export const requireInstagramBotConfig = () => {
  const config = getRuntimeConfig();
  if (config.instagramBot.configured) return config;
  throw new ConfigurationError("Instagram bot ingestion is not configured.", [
    "GROVE_INSTAGRAM_BOT_ENABLED=true",
    "GROVE_INSTAGRAM_WEBHOOK_VERIFY_TOKEN",
    "GROVE_INSTAGRAM_APP_SECRET",
    "Supabase server storage"
  ]);
};

export const getProvider = (requestedProvider) => {
  const key = requestedProvider === "twitter" ? "x" : requestedProvider;
  if (!["instagram", "x"].includes(key)) return null;
  const config = requireBackendConfig();
  const provider = config.providers[key];
  return { ...provider, key, configured: provider.enabled && config.backendConfigured };
};

export const publicConfiguration = () => {
  const config = getRuntimeConfig();
  const walletConfigured = config.wallet.liveReady || config.wallet.rehearsalReady;
  const auctionsConfigured = config.auctions.liveReady || config.auctions.rehearsalReady;
  const secondaryConfigured = config.secondary.liveReady || config.secondary.rehearsalReady;
  return {
    backend: { configured: config.backendConfigured },
    providers: {
      instagram: { configured: config.backendConfigured && config.providers.instagram.enabled },
      x: { configured: config.backendConfigured && config.providers.x.enabled }
    },
    profile: { imported: ["display name", "profile photo", "handle"] },
    acquisition: {
      configured: config.commerce.cardCheckoutConfigured,
      card: { configured: config.commerce.cardCheckoutConfigured, checkout: "hosted" },
      applePay: { configured: config.commerce.cardCheckoutConfigured, via: "stripe-checkout" },
      crypto: { configured: false }
    },
    wallet: {
      configured: walletConfigured,
      chainId: walletConfigured ? config.wallet.chainId : null,
      gas: config.wallet.liveReady ? "sponsored-supported-actions"
        : config.wallet.rehearsalReady ? "not-used-for-offchain-bids" : "disabled",
      environment: config.wallet.rehearsalReady ? "sepolia-rehearsal" : config.wallet.liveReady ? "mainnet" : "disabled",
      ownerExit: {
        configured: config.wallet.ownerExitExecutableConfigured,
        custody: "user-passkey-safe",
        transfer: "erc721-safe-transfer"
      }
    },
    auctions: {
      configured: auctionsConfigured,
      rails: auctionsConfigured ? ["card"] : [],
      environment: config.auctions.rehearsalReady ? "sepolia-rehearsal" : config.auctions.liveReady ? "mainnet" : "disabled"
    },
    secondary: {
      configured: secondaryConfigured,
      protocol: "seaport-1.6",
      settlement: "usdc",
      rails: secondaryConfigured ? ["usdc"] : [],
      applePay: { configured: false },
      gas: secondaryConfigured ? "sponsored-supported-actions" : "disabled",
      environment: config.secondary.rehearsalReady ? "sepolia-rehearsal" : config.secondary.liveReady ? "mainnet" : "disabled"
    },
    openSea: {
      configured: config.openSea.liveReady,
      supported: config.openSea.supported,
      availability: config.wallet.chainId === 11155111 ? "unsupported-on-testnets"
        : config.openSea.liveReady ? "mainnet" : "disabled"
    },
    metrics: { configured: config.metricsConfigured }
  };
};

export const configurationReport = () => {
  const config = getRuntimeConfig();
  const missing = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseKey) missing.push("SUPABASE_PUBLISHABLE_KEY");
  if (!config.siteUrl) missing.push("GROVE_SITE_URL");
  if (!config.providers.instagram.enabled) missing.push("GROVE_INSTAGRAM_OAUTH_ENABLED=true");
  if (!config.providers.x.enabled) missing.push("GROVE_X_OAUTH_ENABLED=true");
  if (config.instagramBot.enabled) {
    if (!config.supabaseSecretKey) missing.push("SUPABASE_SECRET_KEY");
    if (!config.instagramBot.webhookVerifyToken) missing.push("GROVE_INSTAGRAM_WEBHOOK_VERIFY_TOKEN");
    if (!config.instagramBot.appSecret) missing.push("GROVE_INSTAGRAM_APP_SECRET");
  }
  if (config.syntheticSocialAuth.enabled) {
    if (!config.syntheticSocialAuth.stagingSupabaseProjectRef) missing.push("GROVE_STAGING_SUPABASE_PROJECT_REF");
    else if (!config.syntheticSocialAuth.projectRefMatches) missing.push("GROVE_STAGING_SUPABASE_PROJECT_REF matching SUPABASE_URL");
  }
  if (config.acquisitionEnabled) {
    if (!config.supabaseSecretKey) missing.push("SUPABASE_SECRET_KEY");
    if (!config.commerce.stripeSecretKey) missing.push("STRIPE_SECRET_KEY");
    if (!config.commerce.stripeWebhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
    if (!config.commerce.sellerTermsVersion) missing.push("GROVE_SELLER_TERMS_VERSION");
    if (!config.commerce.buyerTermsUrl) missing.push("GROVE_BUYER_TERMS_URL");
    if (!config.commerce.buyerTermsVersion) missing.push("GROVE_BUYER_TERMS_VERSION");
    if (!config.commerce.maximumItemPriceMinor) missing.push("GROVE_MAX_ITEM_PRICE_MINOR");
    if (!config.commerce.automaticTax) missing.push("GROVE_STRIPE_AUTOMATIC_TAX=true");
    if (!config.cronSecret) missing.push("CRON_SECRET");
  }
  if (config.wallet.enabled || config.auctions.enabled) {
    const configuredChainAllowed = config.productionDeployment
      ? config.wallet.chainId === 1
      : config.wallet.chainId === 11155111;
    if (!configuredChainAllowed) missing.push(config.productionDeployment
      ? "GROVE_ETHEREUM_CHAIN_ID=1"
      : "GROVE_ETHEREUM_CHAIN_ID=11155111");
    if (!config.wallet.rpcUrl) missing.push("GROVE_ETHEREUM_RPC_URL");
    if (!config.wallet.entryPointAddress) missing.push("GROVE_ENTRY_POINT_ADDRESS");
    if (!config.wallet.safeFactoryAddress) missing.push("GROVE_SAFE_FACTORY_ADDRESS");
    if (!config.wallet.safeSingletonAddress) missing.push("GROVE_SAFE_SINGLETON_ADDRESS");
    if (!config.wallet.safeFallbackHandlerAddress) missing.push("GROVE_SAFE_FALLBACK_HANDLER_ADDRESS");
    if (!config.wallet.safeWebAuthnSharedSignerAddress) missing.push("GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_ADDRESS");
    if (!config.wallet.safe4337ModuleAddress) missing.push("GROVE_SAFE_4337_MODULE_ADDRESS");
    if (!config.wallet.safePasskeyVerifierAddress) missing.push("GROVE_SAFE_PASSKEY_VERIFIER_ADDRESS");
    if (!config.wallet.safeModuleSetupAddress) missing.push("GROVE_SAFE_MODULE_SETUP_ADDRESS");
    if (!config.wallet.safeMultiSendAddress) missing.push("GROVE_SAFE_MULTISEND_ADDRESS");
    if (!config.wallet.entryPointCodeHash) missing.push("GROVE_ENTRY_POINT_CODE_HASH");
    if (!config.wallet.safeFactoryCodeHash) missing.push("GROVE_SAFE_FACTORY_CODE_HASH");
    if (!config.wallet.safeProxyCodeHash) missing.push("GROVE_SAFE_PROXY_CODE_HASH");
    if (!config.wallet.safeSingletonCodeHash) missing.push("GROVE_SAFE_SINGLETON_CODE_HASH");
    if (!config.wallet.safeFallbackHandlerCodeHash) missing.push("GROVE_SAFE_FALLBACK_HANDLER_CODE_HASH");
    if (!config.wallet.safeWebAuthnSharedSignerCodeHash) missing.push("GROVE_SAFE_WEBAUTHN_SHARED_SIGNER_CODE_HASH");
    if (!config.wallet.safe4337ModuleCodeHash) missing.push("GROVE_SAFE_4337_MODULE_CODE_HASH");
    if (!config.wallet.safePasskeyVerifierCodeHash) missing.push("GROVE_SAFE_PASSKEY_VERIFIER_CODE_HASH");
    if (!config.wallet.safeModuleSetupCodeHash) missing.push("GROVE_SAFE_MODULE_SETUP_CODE_HASH");
    if (!config.wallet.safeMultiSendCodeHash) missing.push("GROVE_SAFE_MULTISEND_CODE_HASH");
    if (config.wallet.safeFallbackHandlerAddress && config.wallet.safe4337ModuleAddress
      && config.wallet.safeFallbackHandlerAddress !== config.wallet.safe4337ModuleAddress) {
      missing.push("GROVE_SAFE_FALLBACK_HANDLER_ADDRESS=GROVE_SAFE_4337_MODULE_ADDRESS");
    }
    if (config.wallet.safeFallbackHandlerCodeHash && config.wallet.safe4337ModuleCodeHash
      && config.wallet.safeFallbackHandlerCodeHash !== config.wallet.safe4337ModuleCodeHash) {
      missing.push("GROVE_SAFE_FALLBACK_HANDLER_CODE_HASH=GROVE_SAFE_4337_MODULE_CODE_HASH");
    }
  }
  if (config.secondary.enabled || config.wallet.ownerExitEnabled || config.wallet.sponsorExecutionEnabled) {
    if (!config.wallet.bundlerUrl) missing.push("GROVE_BUNDLER_URL");
    if (!config.wallet.paymasterUrl) missing.push("GROVE_PAYMASTER_URL");
    if (!config.wallet.paymasterApiToken) missing.push("GROVE_PAYMASTER_API_TOKEN");
    if (!config.wallet.sponsorPolicyVersion) missing.push("GROVE_SPONSOR_POLICY_VERSION");
  }
  if (config.auctions.enabled) {
    if (!config.auctions.inventorySafeSingletonAddress) missing.push("GROVE_INVENTORY_SAFE_SINGLETON_ADDRESS");
    if (!config.auctions.inventorySafeSingletonCodeHash) missing.push("GROVE_INVENTORY_SAFE_SINGLETON_CODE_HASH");
    if (!config.auctions.stripeNftApprovalRef) missing.push("GROVE_STRIPE_NFT_APPROVAL_REF");
    if (!config.auctions.termsUrl) missing.push("GROVE_AUCTION_TERMS_URL");
    if (!config.auctions.termsVersion) missing.push("GROVE_AUCTION_TERMS_VERSION");
    if (!config.auctions.termsHash) missing.push("GROVE_AUCTION_TERMS_HASH");
    if (!config.auctions.maximumFiatHammerMinor) missing.push("GROVE_MAX_FIAT_HAMMER_MINOR");
    if (!config.commerce.stripeSecretKey) missing.push("STRIPE_SECRET_KEY");
    if (!config.commerce.stripeWebhookSecret) missing.push("STRIPE_WEBHOOK_SECRET");
    if (!config.commerce.automaticTax) missing.push("GROVE_STRIPE_AUTOMATIC_TAX=true");
    if (!config.cronSecret) missing.push("CRON_SECRET");
  }
  if (config.secondary.enabled) {
    if (!config.wallet.sponsorExecutionEnabled) missing.push("GROVE_SPONSOR_EXECUTION_ENABLED=true");
    if (!config.wallet.sponsorExecutionReady) missing.push("reviewed sponsored UserOperation adapter attestation");
    if (!config.wallet.sponsorBudgets.perOperationWei || BigInt(config.wallet.sponsorBudgets.perOperationWei) === 0n) {
      missing.push("GROVE_SPONSOR_PER_OPERATION_MAX_WEI");
    }
    if (!config.wallet.sponsorBudgets.perUserDailyWei || BigInt(config.wallet.sponsorBudgets.perUserDailyWei) === 0n) {
      missing.push("GROVE_SPONSOR_PER_USER_DAILY_MAX_WEI");
    }
    if (!config.wallet.sponsorBudgets.globalDailyWei || BigInt(config.wallet.sponsorBudgets.globalDailyWei) === 0n) {
      missing.push("GROVE_SPONSOR_GLOBAL_DAILY_MAX_WEI");
    }
    if (!config.secondary.protocolAddress) missing.push("GROVE_SEAPORT_ADDRESS");
    if (!config.secondary.protocolCodeHash) missing.push("GROVE_SEAPORT_CODE_HASH");
    if (config.secondary.protocolVersion !== "1.6") missing.push("GROVE_SEAPORT_VERSION=1.6");
    if (!config.secondary.conduitKey) missing.push("GROVE_SEAPORT_CONDUIT_KEY");
    if (config.secondary.conduitKey && config.secondary.conduitKey !== `0x${"0".repeat(64)}`) {
      missing.push("GROVE_SEAPORT_CONDUIT_KEY=0x00…00");
    }
    if (!config.secondary.usdcAddress) missing.push("GROVE_USDC_ADDRESS");
    if (!config.secondary.usdcCodeHash) missing.push("GROVE_USDC_CODE_HASH");
    if (config.secondary.feeBps < 0) missing.push("GROVE_SECONDARY_FEE_BPS");
    if (config.secondary.feeBps > 0 && !config.secondary.feeRecipient) missing.push("GROVE_SECONDARY_FEE_RECIPIENT");
    if (!config.secondary.minimumPrice) missing.push("GROVE_SECONDARY_MIN_PRICE");
    if (!config.secondary.maximumPrice) missing.push("GROVE_SECONDARY_MAX_PRICE");
    if (!config.secondary.maximumDurationSeconds) missing.push("GROVE_SECONDARY_MAX_DURATION_SECONDS");
    if (config.secondary.indexerStartBlock < 0) missing.push("GROVE_CHAIN_INDEXER_START_BLOCK");
    if (!config.secondary.termsVersion) missing.push("GROVE_SECONDARY_TERMS_VERSION");
    if (!config.secondary.termsHash) missing.push("GROVE_SECONDARY_TERMS_HASH");
  }
  if (config.wallet.ownerExitEnabled) {
    if (!config.wallet.sponsorExecutionEnabled) missing.push("GROVE_SPONSOR_EXECUTION_ENABLED=true");
    if (!config.wallet.sponsorExecutionReady) missing.push("reviewed sponsored UserOperation adapter attestation");
    if (config.productionDeployment) {
      if (!config.wallet.ownerExitLiveReady) missing.push("reviewed mainnet owner-exit attestation");
    } else if (!config.wallet.ownerExitReady) missing.push("reviewed Sepolia owner-exit attestation");
    if (!config.wallet.sponsorBudgets.perOperationWei || BigInt(config.wallet.sponsorBudgets.perOperationWei) === 0n) {
      missing.push("GROVE_SPONSOR_PER_OPERATION_MAX_WEI");
    }
    if (!config.wallet.sponsorBudgets.perUserDailyWei || BigInt(config.wallet.sponsorBudgets.perUserDailyWei) === 0n) {
      missing.push("GROVE_SPONSOR_PER_USER_DAILY_MAX_WEI");
    }
    if (!config.wallet.sponsorBudgets.globalDailyWei || BigInt(config.wallet.sponsorBudgets.globalDailyWei) === 0n) {
      missing.push("GROVE_SPONSOR_GLOBAL_DAILY_MAX_WEI");
    }
    if (!config.wallet.sponsorBudgetsConfigured) missing.push("valid ordered sponsorship budget limits");
    if (!config.secondary.protocolAddress) missing.push("GROVE_SEAPORT_ADDRESS");
    if (!config.secondary.protocolCodeHash) missing.push("GROVE_SEAPORT_CODE_HASH");
    if (config.secondary.protocolVersion !== "1.6") missing.push("GROVE_SEAPORT_VERSION=1.6");
    if (config.secondary.indexerStartBlock < 0) missing.push("GROVE_CHAIN_INDEXER_START_BLOCK");
  }
  if (config.openSea.enabled) {
    if (!config.productionDeployment || config.wallet.chainId !== 1) missing.push("OpenSea requires the Production mainnet target");
    if (!config.openSea.apiKey) missing.push("OPENSEA_API_KEY");
    if (!config.openSea.collectionSlug) missing.push("GROVE_OPENSEA_COLLECTION_SLUG");
  }

  return { ready: missing.length === 0, missing };
};

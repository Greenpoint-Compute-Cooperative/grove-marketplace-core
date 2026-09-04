# Stripe and Apple Pay launch rehearsal

The implemented primary auction flow is: member sign-in → passkey Safe → save a card or eligible Apple Pay payment method in Stripe-hosted Checkout → signed offchain bid → winner-only off-session charge → risk review → inventory Safe delivery → finalized ownership. Saving a payment method does not charge the bid amount. NFT delivery is a separate chain transaction after payment is verified.

## What an operator supplies once

Use an isolated Stripe sandbox/test environment and the separate staging deployment/database. Supply test credentials through a password manager, CI secret store, or an ignored local environment file. Do not put keys in command arguments, commit them, paste them into issues, or enable shell tracing. The scripts accept environment variables, not credential arguments.

- `STRIPE_SECRET_KEY`: test/sandbox secret or appropriately scoped restricted key. Setup needs webhook endpoint read/write; the launch check also reads Stripe Tax settings. The running application needs the payment, Checkout, customer, Tax, refund/dispute and risk API permissions used by its handlers.
- `GROVE_SITE_URL`, `VERCEL_TARGET_ENV=staging`, `GROVE_ETHEREUM_CHAIN_ID=11155111`, plus the isolated staging Supabase configuration and project pin.
- Actual provider approval reference in `GROVE_STRIPE_NFT_APPROVAL_REF`. A successful API call is not approval. Stripe lists first-party NFT minting/sales, including marketplaces, among restricted businesses; disclose the exact auction, deferred-charge and merchant model. [Stripe restricted businesses](https://stripe.com/legal/restricted-businesses)
- Reviewed, published auction terms with URL, version and content hash; a small maximum hammer amount; configured automatic tax and staging cron authentication. Set Stripe's public business/terms details used by Checkout as well as the application's terms settings.
- The actual work's reviewed tax classification in `GROVE_PREVIEW_STRIPE_TAX_CODE`, plus the existing seeder's finalized collection/mint evidence and auction parameters. The seeder requires `txcd_` followed by digits and refuses to change an existing work's classification. Do not invent a tax category to get past validation.

The machine-readable check reports each missing configuration name even while auctions are disabled. `GROVE_ACQUISITION_ENABLED` controls the separate fixed-price physical checkout flow and is not required for the primary NFT auction. Credentials alone do not enable mainnet, gasless secondary trading or wallet exit.

## Prepare the webhook

With the private staging environment already loaded, run the read-only check:

```sh
node scripts/stripe-setup.mjs
```

To apply the displayed setup plan:

```sh
node scripts/stripe-setup.mjs --apply
```

Only test keys are accepted. The only remote writes are creating the account webhook at the canonical staging origin's `/api/stripe/webhook` route, or updating an existing tool-managed endpoint's event subscription/enabled state. The tool never creates a payment, registers a business, changes tax settings, or accepts terms. It follows all pages before deciding an endpoint does not exist, refuses duplicates, and never replaces a mismatched API version automatically.

A new endpoint's signing secret is saved to `.env.stripe-webhook.local` in the current Git checkout, using exclusive creation and mode `0600`. The path must be ignored and untracked. Existing files and unmanaged webhook settings are never overwritten. Copy `STRIPE_WEBHOOK_SECRET` from that private file to the staging secret manager and deployment environment through its secure input mechanism, then redeploy. Do not print the file. Keep the original secure copy for recovery.

The API returns a signing secret when creating the endpoint. If the local copy is lost or creation had an uncertain response, inspect the existing endpoint in Stripe; the script does not create a duplicate just to obtain another secret. A secret from `stripe listen` belongs to that forwarding session, not to the deployed endpoint. [Webhook endpoint API](https://docs.stripe.com/api/webhook_endpoints/create), [Webhook signatures](https://docs.stripe.com/webhooks/signature)

The subscribed event set exactly matches the application handler: Checkout completion/failure/expiry; SetupIntent success/failure/cancellation; PaymentIntent success/processing/action/failure/cancellation; reviews and early-fraud warnings; refund creation/update/failure; dispute creation/closure. API versions are pinned to the installed Stripe SDK. Upgrading the SDK therefore requires reviewing the deployed endpoint version too.

## Run preflight, then the rehearsal

```sh
node scripts/check-launch.mjs --json
node scripts/check-launch.mjs --remote --json
```

The first command is offline and returns nonzero until remote checks are performed. The second reads the staging deployment, catalog, selected lot's settlement data, Stripe webhook settings and Stripe Tax status. It also sends a locally signed unknown event that the webhook explicitly ignores before database writes; this proves the deployed signing secret matches without faking payment success. It does not exercise Stripe's delivery network, so a real test Checkout event must still arrive during the rehearsal. The Tax API exposes whether the account's test tax settings are active. [Retrieve Tax settings](https://docs.stripe.com/api/tax/settings/retrieve)

`readyToStartRehearsal` means these prerequisites passed. It does not mean the auction completed. `oneShotAutomationReady` and `endToEndVerified` remain false because this check cannot attest a browser payment or sign the inventory Safe.

1. After configuration passes, run the existing verified Sepolia auction seeder with its explicit evidence variables and reviewed tax code. If several auctions are open, set `GROVE_PREVIEW_AUCTION_ID` for the launch check. Keep the selected auction open long enough for passkey and payment setup.
2. Sign in as an invited staging member, activate the passkey Safe, and save the payment method through the actual auction screen. Confirm the signed Stripe webhook makes the mandate ready before bidding. Place a signed bid and verify its amount/terms in the persisted auction record.
3. After close time, invoke the staging close and settle workers from the private scheduler. Verify the winner, unique PaymentIntent, exact tax-inclusive total, tax transaction, payment state and risk-hold deadline. A redirect alone is not payment evidence.
4. After the configured hold, use fresh provider evidence for the existing service-only release authorization. The delivery worker prepares a specific unsigned Safe transaction. The inventory Safe's owner quorum must review and execute that packet. Then reconcile the canonical finalized receipt and NFT owner/balance. This operator handoff still needs an execution tool before an unattended one-command rehearsal can exist; do not shorten production risk policy for a demo.
5. Repeat with an action-required/declined winner and the cure path, then refund/dispute and webhook retry/out-of-order cases. Keep actual receipts and evidence in the private operations system. Return the staging worker execution gates to their normal settings afterward.

## Apple Pay test

Hosted Checkout uses the card rail for Apple Pay; there is no second Apple Pay server or Apple developer merchant setup in this integration. Stripe chooses whether to display the wallet for the customer's device and account settings. Verify Apple Pay is enabled in the test account's payment settings. The hosted setup flow is documented for saving cards for later payments. [Stripe future card payments](https://docs.stripe.com/payments/save-and-reuse-cards-only)

Test on an eligible Apple device with a real card in Apple Wallet while the application uses Stripe **test** keys. Stripe maps that wallet interaction into test payment data; Stripe test card numbers cannot be added to Apple Wallet. Stripe does not support testing through Apple's separate sandbox environment. Do not switch to a live key for testing. A card-only desktop test does not prove the Apple Pay button or deferred-charge flow works on the target device. [Stripe Apple Pay testing](https://support.stripe.com/questions/testing-apple-pay-with-stripe?locale=en-GB)

If the integration later moves to Elements or embedded Checkout, follow Stripe's domain registration requirements for those surfaces. The current hosted Checkout does not need an added domain-registration API call. [Hosted Checkout](https://docs.stripe.com/payments/accept-a-payment?locale=en-GB&platform=web&ui=stripe-hosted), [Embedded payment domain registration](https://docs.stripe.com/payments/payment-methods/pmd-registration)

## Production and public-source boundary

These tools intentionally operate only on Sepolia staging with Stripe test keys. Production release requires its own credentials, written provider acceptance, approved merchant/seller payout model, collection deployment, payment/chain evidence and reviewed feature activation. The current card code does not implement Stripe Connect seller onboarding or payouts; do not market third-party automatic payouts until that model is implemented and accepted.

Keep deployment targets, provider account settings, environment files, webhook signing secrets, database credentials, inventory keys, Terraform state, scheduler credentials and real launch evidence in private operations storage/repositories. The application source, blank templates, runbooks, contracts and tests may be published after the repository/history audit. A public-source release must not include generated local webhook files or payment/customer records.

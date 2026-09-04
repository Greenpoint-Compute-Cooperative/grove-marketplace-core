# Social access setup

Marketplace & Auction House of Brooklyn accepts curator access only through Instagram or X. The site never accepts an email/password form, social password, or scraped account data.

## Shared Supabase setup

1. Apply the marketplace migration and set the Supabase Site URL to the production origin.
2. Allow the exact app callback for production and each reviewed preview: `https://<marketplace-origin>/api/auth/callback`.
3. Each provider app sends its callback to Supabase: `https://<project-ref>.supabase.co/auth/v1/callback`.
4. Use PKCE, HTTPS, least-privilege scopes, and provider consent. The Vercel app needs only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`; provider secrets stay in Supabase.
5. Keep `GROVE_*_OAUTH_ENABLED=false` until staging proves consent, cancellation, callback, refresh, sign-out, revocation, and deletion.

## Instagram

- Create a Meta app using the current official **Instagram API with Instagram Login** flow.
- Confirm which account types are eligible during Meta review; the current professional-account API may not cover every personal account.
- Request only `instagram_business_basic` unless a reviewed product feature genuinely requires more.
- Configure a Supabase custom OAuth provider named `custom:instagram`, enable PKCE and optional email, and map the permitted provider ID, name, username, and profile-picture URL into user metadata.
- Add app website, privacy-policy, terms, and data-deletion URLs required by Meta. Do not request messages, contacts, publishing, or unrelated media permissions for joining.

## X

- Create an X OAuth 2.0 app with Authorization Code + PKCE and the Supabase callback above.
- Configure Supabase’s `twitter` social provider with the X client ID and secret.
- Request `users.read` for the authorized profile. If X or Supabase requires any additional scope, show it in consent and review it before enabling the flag.
- Add the production website, privacy-policy, terms, and callback URLs to the X app.

## Profile and privacy boundary

`auth.users` and provider identities remain inside Supabase Auth. The database trigger accepts only Instagram or X identities and copies only:

- display name;
- profile photo URL;
- handle;
- provider and provider subject ID.

It does not copy email, phone, credentials, social graph, messages, tokens, or media into the public curator record. No scraping or ambient chat monitoring is present.

Before either flag is enabled, publish a privacy policy and deletion route, choose a documented retention period for private discoveries, and implement an authenticated deletion process that removes the Supabase Auth user and cascaded marketplace records. Recommended launch default: purge archived discovery drafts after 90 days; retain published sale/provenance records only for the legally required period and describe that exception clearly. Verify Vercel/Supabase log retention separately.

## Verification

- Consent names only approved scopes.
- Cancel returns to `#join` without a profile.
- Success initializes the granted name/photo/handle and no unsupported field.
- Direct email/password and anonymous signup are disabled in Supabase.
- Sign-out clears the session; provider revocation is handled.
- Account deletion and retention behavior match the published policy.

## Isolated staging E2E identity

The dedicated `staging` Vercel target can use a synthetic social session before
external Meta credentials are approved. This is a test harness, not a fallback
login method. It is unavailable unless `VERCEL_TARGET_ENV=staging`, the runtime
is non-Production, the isolated staging Supabase service key is present, and all
three `GROVE_SYNTHETIC_SOCIAL_AUTH_*` values are deliberately configured.

An authorized test runner calls `POST /api/testing/social-bootstrap` with the
server-only operator bearer token and an allowlisted slug such as
`{"scenario":"auction-e2e"}`. The response contains a signed two-minute,
single-use ticket. From the same deployment origin, the runner submits that
ticket to `POST /api/testing/social-session`; the server exchanges an internal
admin-generated magic link and returns ordinary Supabase session cookies.
Neither secret nor magic-link hash reaches static code.

The resulting profile uses provider `synthetic`, an `@staging.invalid` address,
a visible name beginning `Synthetic Staging Bidder`, and a provider subject beginning
`synthetic:staging:`. Ticket issuance, consumption, and successful session
establishment are recorded in service-only audit tables; if that final audit
write fails, the newly created session is cleared. Replays, expired or
tampered tickets, cross-origin consumption, and all Production attempts fail
closed.

This session only satisfies the social/session prerequisite. It creates no
`smart_accounts`, wallet credential, wallet link, signing key, payment mandate,
bid, or sponsorship decision. The E2E must still deploy and prove control of a
passkey Safe through the normal ERC-1271 wallet-link flow before it can bid.

Official references: [Supabase custom OAuth providers](https://supabase.com/docs/guides/auth/custom-oauth-providers), [Supabase Twitter login](https://supabase.com/docs/guides/auth/social-login/auth-twitter), [Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/), [X OAuth 2.0 + PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code), and [X authenticated profile lookup](https://docs.x.com/x-api/users/lookup/quickstart/authenticated-lookup).

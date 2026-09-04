# Environment separation

Provision staging and production independently: separate databases, provider accounts or sandboxes, webhook signing secrets, OAuth clients, RPC policies, wallets, sponsor budgets and scheduler credentials. Staging uses Sepolia; production Ethereum mainnet remains gated until independently approved.

Example hosts in this source are intentionally non-operational. Replace the example deployment and Supabase hosts consistently in app image policies, CSP, Supabase auth configuration and staging-only test gates in your private deployment configuration. No wildcard trusted media origins. No production credentials in public CI.

Only one scheduler owns each environment/worker pair. Promotion is an exact-commit operation with configuration and migration review, verified immutable candidate URL, rollback record and explicit production approval. A public code contribution never authorizes deployment, spending or credential access.

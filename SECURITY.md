# Security

## Report privately

Use the repository’s private security-advisory form. Do not open a public issue for a vulnerability and do not include real credentials, personal data, private artist records, wallet recovery material, or access tokens in a report.

Include the affected route or component, impact, reproduction using non-sensitive test data, and any suggested mitigation. The maintainers will acknowledge a valid report as quickly as practicable, establish severity and scope, prepare a fix, and coordinate disclosure after affected systems are protected.

## High-risk surfaces

- Instagram and X OAuth callbacks, consent, token storage, revocation, and deletion;
- curator-only discoveries and sponsorship state;
- rights-cleared media and provenance records;
- wallet signatures, mint contracts, token identity, inventory, and webhooks;
- card checkout, payouts, refunds, and seller-of-record boundaries;
- Supabase RLS, service credentials, Vercel environment variables, and deployment logs;
- analytics ingestion, admin metrics access, and retention jobs.

The marketplace never asks for a social password, seed phrase, private key, or recovery phrase. Checkout and minting must remain disabled until real providers and authoritative reconciliation are configured.

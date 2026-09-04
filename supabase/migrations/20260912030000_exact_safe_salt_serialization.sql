-- Preserve the exact uint256 Safe salt across PostgREST's JSON boundary.
-- The numeric source remains authoritative for existing constraints and RPCs;
-- clients read only this generated decimal text projection for comparison.
alter table public.smart_accounts
  add column if not exists salt_nonce_text text
  generated always as (salt_nonce::text) stored;

comment on column public.smart_accounts.salt_nonce_text is
  'Lossless decimal projection of salt_nonce for JavaScript verification.';

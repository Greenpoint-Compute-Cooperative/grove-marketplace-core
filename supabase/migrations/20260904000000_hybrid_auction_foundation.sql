begin;

-- Social OAuth identifies the Grove member. It never owns, signs for, recovers, or
-- sponsors the member's Ethereum account. Raw WebAuthn credential IDs, OAuth subjects,
-- handles, emails, and authenticator metadata must never be written to these tables.
create table public.smart_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete restrict,
  chain_id bigint not null default 1 check (chain_id in (1, 11155111)),
  account_address text not null check (account_address ~ '^0x[0-9a-f]{40}$'),
  safe_version text not null check (char_length(safe_version) between 1 and 40),
  module_version text not null check (char_length(module_version) between 1 and 40),
  entry_point_address text not null check (entry_point_address ~ '^0x[0-9a-f]{40}$'),
  factory_address text not null check (factory_address ~ '^0x[0-9a-f]{40}$'),
  code_hash text check (code_hash is null or code_hash ~ '^0x[0-9a-f]{64}$'),
  signer_count smallint not null default 1 check (signer_count between 1 and 20),
  threshold smallint not null default 1 check (threshold between 1 and signer_count),
  recovery_ready boolean not null default false,
  state text not null default 'counterfactual'
    check (state in ('counterfactual', 'deploying', 'deployed', 'recovery-ready', 'suspended')),
  deployment_userop_hash text check (deployment_userop_hash is null or deployment_userop_hash ~ '^0x[0-9a-f]{64}$'),
  deployment_tx_hash text check (deployment_tx_hash is null or deployment_tx_hash ~ '^0x[0-9a-f]{64}$'),
  deployment_block bigint check (deployment_block is null or deployment_block >= 0),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id, account_address),
  check ((state <> 'recovery-ready') or (recovery_ready and signer_count >= 2 and finalized_at is not null))
);

create table public.wallet_credentials (
  id uuid primary key default extensions.gen_random_uuid(),
  smart_account_id uuid not null references public.smart_accounts(id) on delete cascade,
  credential_commitment text not null check (credential_commitment ~ '^0x[0-9a-f]{64}$'),
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  purpose text not null check (purpose in ('owner', 'recovery')),
  state text not null default 'active' check (state in ('active', 'rotated', 'revoked')),
  added_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (smart_account_id, credential_commitment),
  unique (smart_account_id, owner_address)
);

create table public.wallet_links (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete restrict,
  smart_account_id uuid not null unique references public.smart_accounts(id) on delete restrict,
  challenge_hash text not null check (challenge_hash ~ '^0x[0-9a-f]{64}$'),
  typed_data_hash text not null check (typed_data_hash ~ '^0x[0-9a-f]{64}$'),
  verification_block bigint not null check (verification_block >= 0),
  verified_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.wallet_link_challenges (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  smart_account_id uuid not null references public.smart_accounts(id) on delete cascade,
  challenge_hash text not null unique check (challenge_hash ~ '^0x[0-9a-f]{64}$'),
  origin_hash text not null check (origin_hash ~ '^0x[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create table public.sponsorship_decisions (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  smart_account_id uuid references public.smart_accounts(id) on delete set null,
  request_key text not null unique check (char_length(request_key) between 16 and 200),
  action text not null check (action in ('account-deploy', 'recovery-change', 'bid-cancel', 'marketplace-transfer')),
  decision text not null check (decision in ('approved', 'rejected', 'submitted', 'included', 'failed')),
  policy_version text not null check (char_length(policy_version) between 1 and 80),
  target text check (target is null or target ~ '^0x[0-9a-f]{40}$'),
  selector text check (selector is null or selector ~ '^0x[0-9a-f]{8}$'),
  userop_hash text check (userop_hash is null or userop_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_hash text check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'),
  provider text check (provider is null or char_length(provider) <= 80),
  quoted_cost_wei numeric(78, 0) check (quoted_cost_wei is null or quoted_cost_wei >= 0),
  actual_cost_wei numeric(78, 0) check (actual_cost_wei is null or actual_cost_wei >= 0),
  rejection_code text check (rejection_code is null or char_length(rejection_code) <= 120),
  policy_input jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.nft_collections (
  id uuid primary key default extensions.gen_random_uuid(),
  standard text not null check (standard in ('ERC721', 'ERC1155')),
  chain_id bigint not null default 1 check (chain_id in (1, 11155111)),
  contract_address text not null check (contract_address ~ '^0x[0-9a-f]{40}$'),
  deployed_code_hash text not null check (deployed_code_hash ~ '^0x[0-9a-f]{64}$'),
  inventory_safe text not null check (inventory_safe ~ '^0x[0-9a-f]{40}$'),
  deployment_tx_hash text not null check (deployment_tx_hash ~ '^0x[0-9a-f]{64}$'),
  deployment_block bigint not null check (deployment_block >= 0),
  contract_version text not null check (char_length(contract_version) between 1 and 80),
  state text not null default 'rehearsal' check (state in ('rehearsal', 'active', 'paused', 'retired')),
  created_at timestamptz not null default now(),
  unique (chain_id, contract_address)
);

alter table public.works
  add column nft_collection_id uuid references public.nft_collections(id) on delete restrict,
  add column nft_work_id text check (nft_work_id is null or nft_work_id ~ '^0x[0-9a-f]{64}$'),
  add column nft_token_id numeric(78, 0) check (nft_token_id is null or nft_token_id >= 0),
  add column nft_quantity numeric(78, 0) check (nft_quantity is null or nft_quantity > 0),
  add column nft_custody_state text not null default 'unconfigured'
    check (nft_custody_state in ('unconfigured', 'configured', 'mint-submitted', 'inventory-safe', 'transferred', 'exception')),
  add column nft_mint_tx_hash text check (nft_mint_tx_hash is null or nft_mint_tx_hash ~ '^0x[0-9a-f]{64}$'),
  add column nft_mint_block bigint check (nft_mint_block is null or nft_mint_block >= 0),
  add column nft_finalized_at timestamptz,
  add constraint works_nft_identity_complete check (
    (nft_collection_id is null and nft_work_id is null and nft_token_id is null and nft_quantity is null)
    or
    (nft_collection_id is not null and nft_work_id is not null and nft_token_id is not null and nft_quantity is not null)
  ),
  add constraint works_inventory_custody_complete check (
    nft_custody_state <> 'inventory-safe'
    or (nft_collection_id is not null and nft_mint_tx_hash is not null and nft_mint_block is not null and nft_finalized_at is not null)
  );

create unique index works_nft_token_idx on public.works(nft_collection_id, nft_token_id)
where nft_collection_id is not null;
create unique index works_nft_work_id_idx on public.works(nft_work_id) where nft_work_id is not null;

create table public.auctions (
  id uuid primary key default extensions.gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete restrict,
  settlement_rail text not null check (settlement_rail in ('card', 'crypto')),
  bid_currency text not null check (bid_currency in ('USD', 'USDC', 'WETH')),
  state text not null default 'draft'
    check (state in ('draft', 'scheduled', 'open', 'closing', 'winner-selected', 'payment-pending', 'paid-risk-hold', 'release-ready', 'settled', 'no-sale', 'cancelled', 'exception')),
  opens_at timestamptz not null,
  closes_at timestamptz not null check (closes_at > opens_at),
  original_closes_at timestamptz not null check (original_closes_at > opens_at),
  quantity numeric(78, 0) not null default 1 check (quantity > 0),
  reserve_amount numeric(78, 0) not null check (reserve_amount >= 0),
  minimum_increment numeric(78, 0) not null check (minimum_increment > 0),
  anti_snipe_window_seconds integer not null default 120 check (anti_snipe_window_seconds between 0 and 900),
  anti_snipe_extension_seconds integer not null default 120 check (anti_snipe_extension_seconds between 0 and 900),
  maximum_extensions integer not null default 10 check (maximum_extensions between 0 and 100),
  extension_count integer not null default 0 check (extension_count between 0 and maximum_extensions),
  maximum_card_bid_minor integer check (maximum_card_bid_minor is null or maximum_card_bid_minor >= 50),
  terms_url text not null check (char_length(terms_url) <= 2000 and terms_url ~ '^https://'),
  terms_version text not null check (char_length(terms_version) between 1 and 120),
  terms_hash text not null check (terms_hash ~ '^0x[0-9a-f]{64}$'),
  settlement_deadline timestamptz,
  risk_hold_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((settlement_rail = 'card' and bid_currency = 'USD' and maximum_card_bid_minor is not null)
    or (settlement_rail = 'crypto' and bid_currency in ('USDC', 'WETH') and maximum_card_bid_minor is null))
);

create table public.bidder_payment_mandates (
  id uuid primary key default extensions.gen_random_uuid(),
  auction_id uuid not null references public.auctions(id) on delete restrict,
  bidder_user_id uuid not null references auth.users(id) on delete restrict,
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_customer_ref text check (provider_customer_ref is null or provider_customer_ref ~ '^cus_[A-Za-z0-9_]+$'),
  setup_intent_ref text check (setup_intent_ref is null or setup_intent_ref ~ '^seti_[A-Za-z0-9_]+$'),
  setup_session_ref text check (setup_session_ref is null or setup_session_ref ~ '^cs_[A-Za-z0-9_]+$'),
  payment_method_ref text check (payment_method_ref is null or payment_method_ref ~ '^pm_[A-Za-z0-9_]+$'),
  generation integer not null default 1 check (generation between 1 and 100),
  setup_attempt integer not null default 0 check (setup_attempt between 0 and 20),
  maximum_hammer_minor integer not null check (maximum_hammer_minor >= 50),
  mandate_terms_version text not null check (char_length(mandate_terms_version) between 1 and 120),
  mandate_terms_hash text not null check (mandate_terms_hash ~ '^0x[0-9a-f]{64}$'),
  state text not null default 'setup-pending'
    check (state in ('setup-pending', 'ready', 'requires-action', 'revoked', 'expired', 'failed')),
  setup_usage text check (setup_usage is null or setup_usage = 'off_session'),
  consent_session_completed_at timestamptz,
  consent_terms_accepted_at timestamptz,
  consent_evidence jsonb not null default '{}'::jsonb,
  ready_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state <> 'ready' or (
    provider_customer_ref is not null and setup_intent_ref is not null and setup_session_ref is not null
    and payment_method_ref is not null and setup_usage = 'off_session'
    and consent_session_completed_at is not null and consent_terms_accepted_at is not null
    and ready_at is not null
  )),
  unique (auction_id, bidder_user_id, generation),
  unique (setup_intent_ref),
  unique (setup_session_ref)
);

create table public.auction_bids (
  id uuid primary key default extensions.gen_random_uuid(),
  auction_id uuid not null references public.auctions(id) on delete restrict,
  bidder_user_id uuid not null references auth.users(id) on delete restrict,
  smart_account_id uuid not null references public.smart_accounts(id) on delete restrict,
  payment_mandate_id uuid references public.bidder_payment_mandates(id) on delete restrict,
  amount numeric(78, 0) not null check (amount > 0),
  currency text not null check (currency in ('USD', 'USDC', 'WETH')),
  intent_nonce numeric(78, 0) not null check (intent_nonce >= 0),
  intent_hash text not null unique check (intent_hash ~ '^0x[0-9a-f]{64}$'),
  signature bytea not null check (octet_length(signature) between 1 and 4096),
  signature_scheme text not null default 'EIP712/ERC1271' check (signature_scheme = 'EIP712/ERC1271'),
  signature_verified_block bigint not null check (signature_verified_block >= 0),
  intent_origin_hash text not null check (intent_origin_hash ~ '^0x[0-9a-f]{64}$'),
  intent_schema_version text not null default '1' check (intent_schema_version = '1'),
  valid_after timestamptz not null,
  valid_until timestamptz not null check (valid_until > valid_after),
  idempotency_key text not null check (char_length(idempotency_key) between 16 and 200),
  state text not null default 'accepted' check (state in ('accepted', 'outbid', 'winning', 'cancelled', 'invalidated', 'won', 'lost')),
  accepted_at timestamptz not null default now(),
  unique (auction_id, bidder_user_id, intent_nonce),
  unique (bidder_user_id, idempotency_key)
);

alter table public.auctions
  add column high_bid_id uuid references public.auction_bids(id) on delete restrict,
  add column winner_bid_id uuid references public.auction_bids(id) on delete restrict;

create table public.auction_events (
  id bigint generated always as identity primary key,
  auction_id uuid not null references public.auctions(id) on delete restrict,
  event_type text not null check (char_length(event_type) between 1 and 120),
  actor_kind text not null check (actor_kind in ('bidder', 'operator', 'provider', 'chain', 'system')),
  actor_user_id uuid references auth.users(id) on delete set null,
  bid_id uuid references public.auction_bids(id) on delete set null,
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.auction_settlements (
  id uuid primary key default extensions.gen_random_uuid(),
  auction_id uuid not null unique references public.auctions(id) on delete restrict,
  winning_bid_id uuid not null unique references public.auction_bids(id) on delete restrict,
  bidder_user_id uuid not null references auth.users(id) on delete restrict,
  smart_account_id uuid not null references public.smart_accounts(id) on delete restrict,
  rail text not null check (rail in ('card', 'crypto')),
  hammer_amount numeric(78, 0) not null check (hammer_amount > 0),
  tax_amount numeric(78, 0) not null default 0 check (tax_amount >= 0),
  shipping_amount numeric(78, 0) not null default 0 check (shipping_amount >= 0),
  total_amount numeric(78, 0) check (total_amount is null or total_amount > 0),
  currency text not null check (currency in ('USD', 'USDC', 'WETH')),
  state text not null default 'winner-selected'
    check (state in ('winner-selected', 'tax-pending', 'charge-pending', 'requires-action', 'processing', 'paid-risk-hold', 'release-ready', 'nft-submitted', 'nft-finalized', 'fulfilled', 'payment-failed', 'partially-refunded', 'refunded', 'disputed-post-mint', 'exception')),
  risk_hold_until timestamptz,
  current_payment_intent_ref text unique check (current_payment_intent_ref is null or current_payment_intent_ref ~ '^pi_[A-Za-z0-9_]+$'),
  payment_generation integer not null default 0 check (payment_generation between 0 and 100),
  close_signature_verified_block bigint check (close_signature_verified_block is null or close_signature_verified_block >= 0),
  inventory_verified_block bigint not null check (inventory_verified_block >= 0),
  inventory_verified_block_hash text not null check (inventory_verified_block_hash ~ '^0x[0-9a-f]{64}$'),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (total_amount is null or total_amount = hammer_amount + tax_amount + shipping_amount)
);

create table public.auction_payment_ledger_entries (
  id bigint generated always as identity primary key,
  settlement_id uuid not null references public.auction_settlements(id) on delete restrict,
  provider text not null default 'stripe' check (provider = 'stripe'),
  provider_object_id text not null check (char_length(provider_object_id) between 1 and 240),
  kind text not null check (kind = 'refund'),
  amount_minor integer not null check (amount_minor >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  status text not null check (char_length(status) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_object_id)
);

create table public.payment_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  settlement_id uuid not null references public.auction_settlements(id) on delete restrict,
  provider text not null default 'stripe' check (provider = 'stripe'),
  payment_intent_ref text not null check (payment_intent_ref ~ '^pi_[A-Za-z0-9_]+$'),
  generation integer not null check (generation between 1 and 100),
  attempt_kind text not null check (attempt_kind in ('off-session', 'interactive-cure')),
  amount_minor integer not null check (amount_minor >= 50),
  currency text not null default 'USD' check (currency = 'USD'),
  state text not null check (state in ('created', 'requires-action', 'processing', 'succeeded', 'failed', 'canceled', 'refunded', 'disputed')),
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, payment_intent_ref),
  unique (settlement_id, generation)
);

create table public.chain_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  settlement_id uuid not null unique references public.auction_settlements(id) on delete restrict,
  chain_id bigint not null default 1 check (chain_id in (1, 11155111)),
  collection_address text not null check (collection_address ~ '^0x[0-9a-f]{40}$'),
  token_id numeric(78, 0) not null check (token_id >= 0),
  quantity numeric(78, 0) not null check (quantity > 0),
  from_address text not null check (from_address ~ '^0x[0-9a-f]{40}$'),
  to_address text not null check (to_address ~ '^0x[0-9a-f]{40}$'),
  transaction_hash text check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'),
  block_number bigint check (block_number is null or block_number >= 0),
  block_hash text check (block_hash is null or block_hash ~ '^0x[0-9a-f]{64}$'),
  state text not null default 'queued' check (state in ('queued', 'submitted', 'included', 'finalized', 'reorged', 'failed')),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.provider_events
  add column auction_id uuid references public.auctions(id) on delete set null,
  add column mandate_id uuid references public.bidder_payment_mandates(id) on delete set null,
  add column settlement_id uuid references public.auction_settlements(id) on delete set null;

create index auctions_state_close_idx on public.auctions(state, closes_at);
create unique index auctions_one_active_work_idx on public.auctions(work_id)
where state in ('scheduled', 'open', 'closing', 'winner-selected', 'payment-pending', 'paid-risk-hold', 'release-ready');
create index auction_bids_feed_idx on public.auction_bids(auction_id, accepted_at desc);
create unique index mandates_one_active_bidder_idx on public.bidder_payment_mandates(auction_id, bidder_user_id)
where state in ('setup-pending', 'ready', 'requires-action');
create index auction_events_feed_idx on public.auction_events(auction_id, created_at);
create index settlements_state_idx on public.auction_settlements(state, created_at);
create index auction_payment_ledger_settlement_idx on public.auction_payment_ledger_entries(settlement_id, created_at);
create index sponsorship_spend_idx on public.sponsorship_decisions(created_at, decision);

create trigger smart_accounts_updated_at before update on public.smart_accounts for each row execute function public.set_updated_at();
create trigger sponsorship_decisions_updated_at before update on public.sponsorship_decisions for each row execute function public.set_updated_at();
create trigger auctions_updated_at before update on public.auctions for each row execute function public.set_updated_at();
create trigger mandates_updated_at before update on public.bidder_payment_mandates for each row execute function public.set_updated_at();
create trigger settlements_updated_at before update on public.auction_settlements for each row execute function public.set_updated_at();
create trigger auction_payment_ledger_updated_at before update on public.auction_payment_ledger_entries
for each row execute function public.set_updated_at();
create trigger payment_attempts_updated_at before update on public.payment_attempts for each row execute function public.set_updated_at();
create trigger chain_deliveries_updated_at before update on public.chain_deliveries for each row execute function public.set_updated_at();

create or replace function public.protect_auction_configuration()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.state <> 'draft' and (
    new.work_id <> old.work_id or new.settlement_rail <> old.settlement_rail
    or new.bid_currency <> old.bid_currency or new.opens_at <> old.opens_at
    or new.original_closes_at <> old.original_closes_at or new.quantity <> old.quantity
    or new.reserve_amount <> old.reserve_amount or new.minimum_increment <> old.minimum_increment
    or new.anti_snipe_window_seconds <> old.anti_snipe_window_seconds
    or new.anti_snipe_extension_seconds <> old.anti_snipe_extension_seconds
    or new.maximum_extensions <> old.maximum_extensions
    or new.maximum_card_bid_minor is distinct from old.maximum_card_bid_minor
    or new.terms_url <> old.terms_url or new.terms_version <> old.terms_version
    or new.terms_hash <> old.terms_hash
  ) then raise exception 'auction_configuration_immutable'; end if;
  return new;
end;
$$;

create trigger protect_auction_configuration_before_update
before update on public.auctions for each row execute function public.protect_auction_configuration();

create or replace function public.protect_work_nft_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.nft_custody_state <> 'unconfigured' and (
    new.nft_collection_id is distinct from old.nft_collection_id
    or new.nft_work_id is distinct from old.nft_work_id
    or new.nft_token_id is distinct from old.nft_token_id
    or new.nft_quantity is distinct from old.nft_quantity
  ) then raise exception 'work_nft_identity_immutable'; end if;
  return new;
end;
$$;

create trigger protect_work_nft_identity_before_update
before update on public.works for each row execute function public.protect_work_nft_identity();

-- This function accepts only a bid whose EIP-712 signature has already been verified
-- against the deployed Safe through ERC-1271 at signature_verified_block. Its grants are
-- service-role only; browsers cannot assert that verification themselves. The auction row
-- lock is the serialization point for amount, close time, and winner ordering.
create or replace function public.place_verified_auction_bid(
  auction_uuid uuid,
  bidder_uuid uuid,
  account_uuid uuid,
  mandate_uuid uuid,
  bid_amount numeric,
  bid_currency_required text,
  bid_nonce numeric,
  bid_intent_hash text,
  bid_signature bytea,
  verified_block bigint,
  valid_after_at timestamptz,
  valid_until_at timestamptz,
  bid_origin_hash text,
  request_key text
)
returns public.auction_bids
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_auction public.auctions%rowtype;
  selected_work public.works%rowtype;
  selected_account public.smart_accounts%rowtype;
  selected_mandate public.bidder_payment_mandates%rowtype;
  existing_bid public.auction_bids%rowtype;
  accepted_bid public.auction_bids%rowtype;
  current_amount numeric(78, 0);
  required_amount numeric(78, 0);
begin
  if bidder_uuid is null or request_key is null or char_length(request_key) < 16 or char_length(request_key) > 200 then
    raise exception 'invalid_bid_request';
  end if;
  if bid_intent_hash is null or bid_intent_hash !~ '^0x[0-9a-f]{64}$'
     or bid_origin_hash is null or bid_origin_hash !~ '^0x[0-9a-f]{64}$' or octet_length(bid_signature) < 1
     or verified_block is null or verified_block < 0 then
    raise exception 'invalid_signature_proof';
  end if;

  select * into existing_bid from public.auction_bids
  where bidder_user_id = bidder_uuid and idempotency_key = request_key;
  if found then
    if existing_bid.auction_id <> auction_uuid or existing_bid.intent_hash <> bid_intent_hash then
      raise exception 'idempotency_conflict';
    end if;
    return existing_bid;
  end if;

  select * into selected_auction from public.auctions where id = auction_uuid for update;
  if not found or selected_auction.state <> 'open' or now() < selected_auction.opens_at
     or now() >= selected_auction.closes_at then
    raise exception 'auction_not_open';
  end if;
  if bid_currency_required <> selected_auction.bid_currency then raise exception 'currency_mismatch'; end if;
  -- A winning intent must remain valid through every configured anti-sniping
  -- extension plus a close-worker grace period. This prevents the auction clock
  -- from extending beyond the signature that authorizes settlement.
  if valid_after_at > now() or valid_until_at < selected_auction.original_closes_at
      + make_interval(secs => selected_auction.maximum_extensions * selected_auction.anti_snipe_extension_seconds)
      + interval '15 minutes'
     or valid_until_at > selected_auction.original_closes_at
      + make_interval(secs => selected_auction.maximum_extensions * selected_auction.anti_snipe_extension_seconds)
      + interval '1 day' then
    raise exception 'bid_signature_outside_window';
  end if;

  select * into selected_work from public.works where id = selected_auction.work_id;
  if not found or selected_work.nft_custody_state <> 'inventory-safe' or selected_work.contract_status <> 'minted'
     or selected_auction.quantity > selected_work.nft_quantity then
    raise exception 'nft_not_in_inventory';
  end if;

  select * into selected_account from public.smart_accounts where id = account_uuid;
  if not found or selected_account.user_id <> bidder_uuid or selected_account.state <> 'recovery-ready'
     or not selected_account.recovery_ready or selected_account.finalized_at is null then
    raise exception 'wallet_not_ready';
  end if;

  if selected_auction.settlement_rail = 'card' then
    select * into selected_mandate from public.bidder_payment_mandates where id = mandate_uuid for update;
    if not found or selected_mandate.auction_id <> auction_uuid or selected_mandate.bidder_user_id <> bidder_uuid
       or selected_mandate.state <> 'ready' or selected_mandate.ready_at is null or selected_mandate.expires_at <= now()
       or selected_mandate.provider_customer_ref is null or selected_mandate.setup_intent_ref is null
       or selected_mandate.setup_session_ref is null or selected_mandate.payment_method_ref is null
       or selected_mandate.setup_usage <> 'off_session' or selected_mandate.consent_session_completed_at is null
       or selected_mandate.consent_terms_accepted_at is null
       or selected_mandate.mandate_terms_version <> selected_auction.terms_version
       or selected_mandate.mandate_terms_hash <> selected_auction.terms_hash
       or bid_amount > selected_mandate.maximum_hammer_minor
       or bid_amount > selected_auction.maximum_card_bid_minor then
      raise exception 'payment_mandate_not_ready';
    end if;
  elsif mandate_uuid is not null then
    raise exception 'crypto_bid_has_payment_mandate';
  end if;

  select amount into current_amount from public.auction_bids where id = selected_auction.high_bid_id;
  required_amount := case
    when current_amount is null then greatest(selected_auction.reserve_amount, selected_auction.minimum_increment)
    else current_amount + selected_auction.minimum_increment
  end;
  if bid_amount < required_amount then raise exception 'bid_too_low'; end if;

  update public.auction_bids set state = 'outbid'
  where id = selected_auction.high_bid_id and state = 'winning';

  insert into public.auction_bids (
    auction_id, bidder_user_id, smart_account_id, payment_mandate_id, amount, currency,
    intent_nonce, intent_hash, signature, signature_verified_block, intent_origin_hash, valid_after, valid_until,
    idempotency_key, state
  ) values (
    auction_uuid, bidder_uuid, account_uuid, mandate_uuid, bid_amount, bid_currency_required,
    bid_nonce, bid_intent_hash, bid_signature, verified_block, bid_origin_hash, valid_after_at, valid_until_at,
    request_key, 'winning'
  ) returning * into accepted_bid;

  update public.auctions
  set high_bid_id = accepted_bid.id,
      closes_at = case
        when anti_snipe_window_seconds > 0 and extension_count < maximum_extensions
          and closes_at - now() <= make_interval(secs => anti_snipe_window_seconds)
        then closes_at + make_interval(secs => anti_snipe_extension_seconds)
        else closes_at
      end,
      extension_count = case
        when anti_snipe_window_seconds > 0 and extension_count < maximum_extensions
          and closes_at - now() <= make_interval(secs => anti_snipe_window_seconds)
        then extension_count + 1
        else extension_count
      end
  where id = auction_uuid;

  insert into public.auction_events (auction_id, event_type, actor_kind, actor_user_id, bid_id, event_data)
  values (auction_uuid, 'bid.accepted', 'bidder', bidder_uuid, accepted_bid.id,
    jsonb_build_object('amount', bid_amount, 'currency', bid_currency_required));
  return accepted_bid;
end;
$$;

create or replace function public.close_auction(
  auction_uuid uuid,
  expected_high_bid_uuid uuid,
  expected_intent_hash text,
  signature_verified_block bigint,
  inventory_verified_block bigint,
  inventory_verified_block_hash text
)
returns public.auction_settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_auction public.auctions%rowtype;
  winning_bid public.auction_bids%rowtype;
  winning_account public.smart_accounts%rowtype;
  winning_mandate public.bidder_payment_mandates%rowtype;
  selected_work public.works%rowtype;
  result public.auction_settlements%rowtype;
begin
  select * into result from public.auction_settlements where auction_id = auction_uuid;
  if found then return result; end if;

  select * into selected_auction from public.auctions where id = auction_uuid for update;
  if not found then raise exception 'auction_not_found'; end if;
  if selected_auction.state <> 'open' or now() < selected_auction.closes_at then raise exception 'auction_not_closable'; end if;
  if inventory_verified_block is null or inventory_verified_block < 0
     or inventory_verified_block_hash is null or inventory_verified_block_hash !~ '^0x[0-9a-f]{64}$' then
    raise exception 'inventory_proof_invalid';
  end if;
  select * into selected_work from public.works where id = selected_auction.work_id for update;
  if not found or selected_work.nft_custody_state <> 'inventory-safe' or selected_work.contract_status <> 'minted'
     or selected_auction.quantity > selected_work.nft_quantity then raise exception 'nft_not_in_inventory'; end if;

  select * into winning_bid from public.auction_bids where id = selected_auction.high_bid_id for update;
  if not found or winning_bid.amount < selected_auction.reserve_amount then
    if expected_high_bid_uuid is not null or expected_intent_hash is not null or signature_verified_block is not null then
      raise exception 'close_proof_mismatch';
    end if;
    update public.auctions set state = 'no-sale' where id = auction_uuid;
    insert into public.auction_events (auction_id, event_type, actor_kind)
    values (auction_uuid, 'auction.no-sale', 'system');
    return null;
  end if;

  if expected_high_bid_uuid is distinct from winning_bid.id or expected_intent_hash is distinct from winning_bid.intent_hash
     or signature_verified_block is null or signature_verified_block < 0 or winning_bid.valid_until <= now() then
    raise exception 'close_proof_mismatch';
  end if;
  select * into winning_account from public.smart_accounts where id = winning_bid.smart_account_id for update;
  if not found or winning_account.user_id <> winning_bid.bidder_user_id or winning_account.state <> 'recovery-ready'
     or not winning_account.recovery_ready or winning_account.finalized_at is null then raise exception 'winner_wallet_not_ready'; end if;
  if selected_auction.settlement_rail = 'card' then
    select * into winning_mandate from public.bidder_payment_mandates where id = winning_bid.payment_mandate_id for update;
    if not found or winning_mandate.auction_id <> auction_uuid or winning_mandate.bidder_user_id <> winning_bid.bidder_user_id
       or winning_mandate.state <> 'ready' or winning_mandate.expires_at <= now()
       or winning_mandate.maximum_hammer_minor < winning_bid.amount
       or winning_mandate.mandate_terms_version <> selected_auction.terms_version
       or winning_mandate.mandate_terms_hash <> selected_auction.terms_hash
       or winning_mandate.provider_customer_ref is null or winning_mandate.setup_intent_ref is null
       or winning_mandate.setup_session_ref is null or winning_mandate.payment_method_ref is null
       or winning_mandate.setup_usage <> 'off_session' or winning_mandate.consent_session_completed_at is null
       or winning_mandate.consent_terms_accepted_at is null then raise exception 'winner_payment_mandate_not_ready'; end if;
  end if;

  -- The close worker must revalidate this signature with ERC-1271 immediately before this RPC.
  update public.auction_bids
  set state = case when id = winning_bid.id then 'won' else 'lost' end
  where auction_id = auction_uuid and state in ('accepted', 'outbid', 'winning');

  insert into public.auction_settlements (
    auction_id, winning_bid_id, bidder_user_id, smart_account_id, rail, hammer_amount, currency,
    close_signature_verified_block, inventory_verified_block, inventory_verified_block_hash
  ) values (
    auction_uuid, winning_bid.id, winning_bid.bidder_user_id, winning_bid.smart_account_id,
    selected_auction.settlement_rail, winning_bid.amount, winning_bid.currency,
    signature_verified_block, inventory_verified_block, inventory_verified_block_hash
  ) returning * into result;

  update public.auctions
  set state = 'winner-selected', winner_bid_id = winning_bid.id
  where id = auction_uuid;
  insert into public.auction_events (auction_id, event_type, actor_kind, bid_id, event_data)
  values (auction_uuid, 'auction.winner-selected', 'system', winning_bid.id,
    jsonb_build_object('settlement_id', result.id));
  return result;
end;
$$;

create or replace function public.finalize_wallet_link(
  challenge_uuid uuid,
  member_uuid uuid,
  account_uuid uuid,
  expected_challenge_hash text,
  signed_typed_data_hash text,
  verified_block bigint
)
returns public.wallet_links
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_challenge public.wallet_link_challenges%rowtype;
  selected_account public.smart_accounts%rowtype;
  result public.wallet_links%rowtype;
begin
  select * into selected_challenge from public.wallet_link_challenges where id = challenge_uuid for update;
  if not found or selected_challenge.user_id <> member_uuid or selected_challenge.smart_account_id <> account_uuid
     or selected_challenge.challenge_hash <> expected_challenge_hash or selected_challenge.expires_at <= now()
     or selected_challenge.consumed_at is not null then
    raise exception 'wallet_challenge_invalid';
  end if;
  select * into selected_account from public.smart_accounts where id = account_uuid for update;
  if not found or selected_account.user_id <> member_uuid or selected_account.state not in ('deployed', 'recovery-ready')
     or selected_account.finalized_at is null then raise exception 'wallet_not_deployed'; end if;
  if signed_typed_data_hash !~ '^0x[0-9a-f]{64}$' or verified_block < 0 then raise exception 'wallet_proof_invalid'; end if;

  update public.wallet_link_challenges set consumed_at = now() where id = challenge_uuid;
  insert into public.wallet_links (
    user_id, smart_account_id, challenge_hash, typed_data_hash, verification_block, verified_at
  ) values (
    member_uuid, account_uuid, expected_challenge_hash, signed_typed_data_hash, verified_block, now()
  ) on conflict (user_id) do update set
    smart_account_id = excluded.smart_account_id,
    challenge_hash = excluded.challenge_hash,
    typed_data_hash = excluded.typed_data_hash,
    verification_block = excluded.verification_block,
    verified_at = excluded.verified_at,
    revoked_at = null
  returning * into result;
  return result;
end;
$$;

create or replace function public.apply_stripe_auction_setup_event(
  stripe_event_id text,
  stripe_event_type text,
  auction_uuid uuid,
  mandate_uuid uuid,
  checkout_session_id text,
  setup_intent_id text,
  customer_id text,
  payment_method_id text,
  setup_status text,
  setup_usage_value text,
  terms_acceptance_status text,
  event_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_mandate public.bidder_payment_mandates%rowtype;
  session_completed boolean;
  terms_accepted boolean;
begin
  insert into public.provider_events (provider, event_id, event_type, auction_id, mandate_id, payload)
  values ('stripe', stripe_event_id, stripe_event_type, auction_uuid, mandate_uuid, event_payload)
  on conflict (provider, event_id) do nothing;
  if not found then return 'duplicate'; end if;

  select * into selected_mandate from public.bidder_payment_mandates where id = mandate_uuid for update;
  if not found or selected_mandate.auction_id <> auction_uuid then raise exception 'mandate_mismatch'; end if;
  if (checkout_session_id is not null and selected_mandate.setup_session_ref is not null
      and selected_mandate.setup_session_ref <> checkout_session_id)
     or (setup_intent_id is not null and selected_mandate.setup_intent_ref is not null
      and selected_mandate.setup_intent_ref <> setup_intent_id) then
    update public.provider_events set processed_at = now(), processing_error = 'stale_setup_attempt'
    where provider = 'stripe' and event_id = stripe_event_id;
    return 'stale';
  end if;
  if stripe_event_type <> 'checkout.session.expired'
     and (setup_intent_id is null or setup_intent_id !~ '^seti_') then raise exception 'setup_intent_invalid'; end if;
  if customer_id is null or customer_id !~ '^cus_' then raise exception 'customer_invalid'; end if;
  if setup_usage_value is not null and setup_usage_value <> 'off_session' then raise exception 'setup_usage_invalid'; end if;

  session_completed := stripe_event_type = 'checkout.session.completed';
  terms_accepted := session_completed and terms_acceptance_status = 'accepted';
  update public.bidder_payment_mandates
    set setup_session_ref = coalesce(setup_session_ref, checkout_session_id),
      setup_intent_ref = coalesce(setup_intent_id, setup_intent_ref),
      provider_customer_ref = customer_id,
      payment_method_ref = case when payment_method_id ~ '^pm_' then payment_method_id else payment_method_ref end,
      setup_usage = coalesce(setup_usage_value, setup_usage),
      consent_session_completed_at = case when session_completed then coalesce(consent_session_completed_at, now()) else consent_session_completed_at end,
      consent_terms_accepted_at = case when terms_accepted then coalesce(consent_terms_accepted_at, now()) else consent_terms_accepted_at end,
      consent_evidence = case when session_completed then jsonb_build_object(
        'provider', 'stripe', 'checkout_session_id', checkout_session_id,
        'event_id', stripe_event_id, 'terms_status', terms_acceptance_status
      ) else consent_evidence end,
      state = case
        when state = 'ready' then state
        when stripe_event_type = 'checkout.session.expired' or setup_status in ('canceled', 'setup_failed') then 'failed'
        when setup_status = 'succeeded' and coalesce(payment_method_id, payment_method_ref) ~ '^pm_'
          and coalesce(setup_usage_value, setup_usage) = 'off_session'
          and (session_completed or consent_session_completed_at is not null)
          and (terms_accepted or consent_terms_accepted_at is not null) then 'ready'
        else 'setup-pending'
      end,
      ready_at = case
        when setup_status = 'succeeded' and coalesce(payment_method_id, payment_method_ref) ~ '^pm_'
          and coalesce(setup_usage_value, setup_usage) = 'off_session'
          and (session_completed or consent_session_completed_at is not null)
          and (terms_accepted or consent_terms_accepted_at is not null) then coalesce(ready_at, now())
        else ready_at
      end
  where id = mandate_uuid;
  select state into selected_mandate.state from public.bidder_payment_mandates where id = mandate_uuid;
  update public.provider_events set processed_at = now() where provider = 'stripe' and event_id = stripe_event_id;
  insert into public.auction_events (auction_id, event_type, actor_kind, event_data)
  values (auction_uuid, 'payment-mandate.' || selected_mandate.state, 'provider', jsonb_build_object('mandate_id', mandate_uuid));
  return selected_mandate.state;
end;
$$;

-- Bind exactly one Stripe PaymentIntent generation before confirmation. A webhook
-- for any other intent is rejected and retried instead of mutating this settlement.
create or replace function public.register_auction_payment_attempt(
  settlement_uuid uuid,
  payment_intent_id text,
  expected_amount integer,
  attempt_kind_required text
)
returns public.payment_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
  result public.payment_attempts%rowtype;
  next_generation integer;
begin
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or selected_settlement.rail <> 'card' then raise exception 'settlement_mismatch'; end if;
  if payment_intent_id is null or payment_intent_id !~ '^pi_' then raise exception 'payment_intent_invalid'; end if;
  if expected_amount < 50 or selected_settlement.total_amount is null
     or selected_settlement.total_amount <> expected_amount then raise exception 'payment_amount_mismatch'; end if;
  if attempt_kind_required not in ('off-session', 'interactive-cure') then raise exception 'attempt_kind_invalid'; end if;
  if selected_settlement.state not in ('winner-selected', 'tax-pending', 'charge-pending') then
    raise exception 'settlement_not_chargeable';
  end if;
  if selected_settlement.current_payment_intent_ref = payment_intent_id then
    select * into result from public.payment_attempts
      where settlement_id = settlement_uuid and payment_intent_ref = payment_intent_id;
    return result;
  end if;
  if selected_settlement.current_payment_intent_ref is not null then
    raise exception 'payment_attempt_already_bound';
  end if;
  next_generation := selected_settlement.payment_generation + 1;
  insert into public.payment_attempts (
    settlement_id, payment_intent_ref, generation, attempt_kind, amount_minor, state
  ) values (
    settlement_uuid, payment_intent_id, next_generation, attempt_kind_required, expected_amount, 'created'
  ) returning * into result;
  update public.auction_settlements set
    current_payment_intent_ref = payment_intent_id,
    payment_generation = next_generation,
    state = 'charge-pending'
  where id = settlement_uuid;
  return result;
end;
$$;

-- A replacement PaymentIntent is allowed only after Stripe reports the bound
-- generation canceled. The caller must name that locked intent and generation.
create or replace function public.replace_auction_payment_attempt(
  settlement_uuid uuid,
  expected_prior_payment_intent_id text,
  replacement_payment_intent_id text,
  expected_amount integer,
  attempt_kind_required text
)
returns public.payment_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
  prior_attempt public.payment_attempts%rowtype;
  result public.payment_attempts%rowtype;
  next_generation integer;
begin
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or selected_settlement.rail <> 'card' then raise exception 'settlement_mismatch'; end if;
  if selected_settlement.current_payment_intent_ref is distinct from expected_prior_payment_intent_id
     or selected_settlement.state <> 'payment-failed' then raise exception 'prior_payment_not_replaceable'; end if;
  select * into prior_attempt from public.payment_attempts
    where settlement_id = settlement_uuid and payment_intent_ref = expected_prior_payment_intent_id for update;
  if not found or prior_attempt.state <> 'canceled'
     or prior_attempt.generation <> selected_settlement.payment_generation then raise exception 'prior_payment_not_replaceable'; end if;
  if replacement_payment_intent_id is null or replacement_payment_intent_id !~ '^pi_'
     or replacement_payment_intent_id = expected_prior_payment_intent_id then raise exception 'payment_intent_invalid'; end if;
  if expected_amount < 50 or selected_settlement.total_amount is null
     or selected_settlement.total_amount <> expected_amount then raise exception 'payment_amount_mismatch'; end if;
  if attempt_kind_required <> 'interactive-cure' then raise exception 'attempt_kind_invalid'; end if;
  next_generation := selected_settlement.payment_generation + 1;
  insert into public.payment_attempts (
    settlement_id, payment_intent_ref, generation, attempt_kind, amount_minor, state
  ) values (
    settlement_uuid, replacement_payment_intent_id, next_generation, attempt_kind_required, expected_amount, 'created'
  ) returning * into result;
  update public.auction_settlements set
    current_payment_intent_ref = replacement_payment_intent_id,
    payment_generation = next_generation,
    state = 'charge-pending'
  where id = settlement_uuid and current_payment_intent_ref = expected_prior_payment_intent_id;
  if not found then raise exception 'payment_attempt_race'; end if;
  return result;
end;
$$;

create or replace function public.apply_stripe_auction_payment_event(
  stripe_event_id text,
  stripe_event_type text,
  settlement_uuid uuid,
  payment_intent_id text,
  stripe_object_id text,
  object_status text,
  object_amount integer,
  object_currency text,
  event_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
  attempt_state text;
  next_state text;
  nft_already_released boolean;
  succeeded_refund_amount bigint;
begin
  insert into public.provider_events (provider, event_id, event_type, auction_id, settlement_id, payload)
  select 'stripe', stripe_event_id, stripe_event_type, s.auction_id, s.id, event_payload
  from public.auction_settlements s where s.id = settlement_uuid
  on conflict (provider, event_id) do nothing;
  if not found then return 'duplicate'; end if;

  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or selected_settlement.rail <> 'card' then raise exception 'settlement_mismatch'; end if;
  if payment_intent_id is null or payment_intent_id !~ '^pi_' then raise exception 'payment_intent_invalid'; end if;
  if selected_settlement.current_payment_intent_ref is distinct from payment_intent_id then
    raise exception 'payment_intent_not_current';
  end if;
  if lower(object_currency) <> 'usd' then raise exception 'payment_currency_mismatch'; end if;
  nft_already_released := selected_settlement.state in ('nft-submitted', 'nft-finalized', 'fulfilled', 'disputed-post-mint');

  if stripe_event_type like 'payment_intent.%' then
    attempt_state := case
      when stripe_event_type = 'payment_intent.succeeded' then 'succeeded'
      when stripe_event_type = 'payment_intent.processing' then 'processing'
      when stripe_event_type = 'payment_intent.requires_action' then 'requires-action'
      when stripe_event_type = 'payment_intent.payment_failed' then 'failed'
      when stripe_event_type = 'payment_intent.canceled' then 'canceled'
      else 'created'
    end;
    insert into public.payment_attempts (
      settlement_id, payment_intent_ref, generation, attempt_kind, amount_minor, state, last_error_code
    ) values (
      settlement_uuid, payment_intent_id, selected_settlement.payment_generation, 'off-session', object_amount, attempt_state,
      case when attempt_state in ('failed', 'canceled') then left(object_status, 120) else null end
    ) on conflict (provider, payment_intent_ref) do update set
      state = excluded.state, last_error_code = excluded.last_error_code
    where payment_attempts.settlement_id = excluded.settlement_id
      and payment_attempts.generation = excluded.generation;
  end if;

  if stripe_event_type like 'refund.%' then
    insert into public.auction_payment_ledger_entries (
      settlement_id, provider_object_id, kind, amount_minor, status
    ) values (
      settlement_uuid, stripe_object_id, 'refund', object_amount, coalesce(object_status, 'unknown')
    ) on conflict (provider, provider_object_id) do update set
      amount_minor = case
        when auction_payment_ledger_entries.status = 'succeeded' then auction_payment_ledger_entries.amount_minor
        else excluded.amount_minor
      end,
      status = case
        when auction_payment_ledger_entries.status = 'succeeded' then auction_payment_ledger_entries.status
        else excluded.status
      end;
    select coalesce(sum(amount_minor), 0) into succeeded_refund_amount
    from public.auction_payment_ledger_entries
    where settlement_id = settlement_uuid and kind = 'refund' and status = 'succeeded';
  else
    succeeded_refund_amount := 0;
  end if;

  next_state := case
    when stripe_event_type like 'payment_intent.%'
      and selected_settlement.state in ('paid-risk-hold', 'release-ready', 'nft-submitted', 'nft-finalized', 'fulfilled', 'partially-refunded', 'refunded', 'disputed-post-mint')
      then selected_settlement.state
    when stripe_event_type = 'payment_intent.succeeded'
      and selected_settlement.total_amount = object_amount and selected_settlement.risk_hold_until is not null
      then 'paid-risk-hold'
    when stripe_event_type = 'payment_intent.succeeded' then 'exception'
    when stripe_event_type = 'payment_intent.processing' then 'processing'
    when stripe_event_type = 'payment_intent.requires_action' then 'requires-action'
    when stripe_event_type in ('payment_intent.payment_failed', 'payment_intent.canceled') then 'payment-failed'
    when stripe_event_type like 'refund.%' and object_status = 'succeeded' and nft_already_released then 'disputed-post-mint'
    when stripe_event_type like 'refund.%' and object_status = 'succeeded'
      and succeeded_refund_amount >= selected_settlement.total_amount then 'refunded'
    when stripe_event_type like 'refund.%' and object_status = 'succeeded' and succeeded_refund_amount > 0 then 'partially-refunded'
    when stripe_event_type like 'refund.%' then selected_settlement.state
    when stripe_event_type in ('charge.dispute.created', 'charge.dispute.lost')
      then case when nft_already_released then 'disputed-post-mint' else 'exception' end
    when stripe_event_type in ('charge.dispute.won', 'charge.dispute.prevented', 'charge.dispute.warning_closed')
      then selected_settlement.state
    else selected_settlement.state
  end;
  update public.auction_settlements set state = next_state where id = settlement_uuid;
  update public.provider_events set processed_at = now() where provider = 'stripe' and event_id = stripe_event_id;
  insert into public.auction_events (auction_id, event_type, actor_kind, event_data)
  values (selected_settlement.auction_id, 'settlement.' || next_state, 'provider',
    jsonb_build_object('settlement_id', settlement_uuid, 'stripe_object_id', stripe_object_id));
  return next_state;
end;
$$;

-- Public projections deliberately omit social identity, member UUIDs, wallet addresses,
-- signatures, provider references, fraud state, and precise recovery configuration.
create view public.public_auctions with (security_barrier = true) as
select a.id, a.work_id, w.slug, w.artist_name, w.title, w.media_url, w.format, a.quantity, a.settlement_rail,
  a.bid_currency, a.state, a.opens_at, a.closes_at, a.reserve_amount, a.minimum_increment,
  a.high_bid_id, hb.amount as current_bid_amount, a.terms_url, a.terms_version, w.nft_token_id, c.standard as nft_standard,
  c.contract_address as nft_contract_address, c.chain_id
from public.auctions a
join public.works w on w.id = a.work_id
join public.nft_collections c on c.id = w.nft_collection_id
left join public.auction_bids hb on hb.id = a.high_bid_id
where a.state not in ('draft', 'cancelled');

create view public.public_auction_bids with (security_barrier = true) as
select b.id, b.auction_id, b.amount, b.currency, b.state, b.accepted_at,
  'bidder-' || substr(encode(extensions.digest(b.auction_id::text || ':' || b.smart_account_id::text, 'sha256'), 'hex'), 1, 10) as bidder_alias
from public.auction_bids b;

alter table public.smart_accounts enable row level security;
alter table public.wallet_credentials enable row level security;
alter table public.wallet_links enable row level security;
alter table public.wallet_link_challenges enable row level security;
alter table public.sponsorship_decisions enable row level security;
alter table public.nft_collections enable row level security;
alter table public.auctions enable row level security;
alter table public.bidder_payment_mandates enable row level security;
alter table public.auction_bids enable row level security;
alter table public.auction_events enable row level security;
alter table public.auction_settlements enable row level security;
alter table public.auction_payment_ledger_entries enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.chain_deliveries enable row level security;

create policy "members read their smart account" on public.smart_accounts for select to authenticated using (user_id = auth.uid());
create policy "members read credential commitments" on public.wallet_credentials for select to authenticated using (
  smart_account_id in (select id from public.smart_accounts where user_id = auth.uid())
);
create policy "members read their wallet link" on public.wallet_links for select to authenticated using (user_id = auth.uid());
create policy "members read their sponsorship decisions" on public.sponsorship_decisions for select to authenticated using (user_id = auth.uid());
create policy "bidders read their mandates" on public.bidder_payment_mandates for select to authenticated using (bidder_user_id = auth.uid());
create policy "bidders read their bids" on public.auction_bids for select to authenticated using (bidder_user_id = auth.uid());
create policy "winners read their settlement" on public.auction_settlements for select to authenticated using (bidder_user_id = auth.uid());
create policy "winners read their payment attempts" on public.payment_attempts for select to authenticated using (
  settlement_id in (select id from public.auction_settlements where bidder_user_id = auth.uid())
);
create policy "winners read their auction payment ledger" on public.auction_payment_ledger_entries for select to authenticated using (
  settlement_id in (select id from public.auction_settlements where bidder_user_id = auth.uid())
);
create policy "winners read their chain delivery" on public.chain_deliveries for select to authenticated using (
  settlement_id in (select id from public.auction_settlements where bidder_user_id = auth.uid())
);

revoke all on public.smart_accounts, public.wallet_credentials, public.wallet_links, public.sponsorship_decisions,
  public.wallet_link_challenges, public.nft_collections, public.auctions, public.bidder_payment_mandates, public.auction_bids, public.auction_events,
  public.auction_settlements, public.auction_payment_ledger_entries, public.payment_attempts, public.chain_deliveries from anon, authenticated;
grant select on public.smart_accounts, public.wallet_credentials, public.wallet_links, public.sponsorship_decisions,
  public.bidder_payment_mandates, public.auction_bids, public.auction_settlements, public.payment_attempts,
  public.auction_payment_ledger_entries, public.chain_deliveries to authenticated;
revoke all on public.public_auctions, public.public_auction_bids from public, anon, authenticated;
revoke all on function public.place_verified_auction_bid(uuid, uuid, uuid, uuid, numeric, text, numeric, text, bytea, bigint, timestamptz, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.close_auction(uuid, uuid, text, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.finalize_wallet_link(uuid, uuid, uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.apply_stripe_auction_setup_event(text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.register_auction_payment_attempt(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.replace_auction_payment_attempt(uuid, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.apply_stripe_auction_payment_event(text, text, uuid, text, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.place_verified_auction_bid(uuid, uuid, uuid, uuid, numeric, text, numeric, text, bytea, bigint, timestamptz, timestamptz, text, text) to service_role;
grant execute on function public.close_auction(uuid, uuid, text, bigint, bigint, text) to service_role;
grant execute on function public.finalize_wallet_link(uuid, uuid, uuid, text, text, bigint) to service_role;
grant execute on function public.apply_stripe_auction_setup_event(text, text, uuid, uuid, text, text, text, text, text, text, text, jsonb) to service_role;
grant execute on function public.register_auction_payment_attempt(uuid, text, integer, text) to service_role;
grant execute on function public.replace_auction_payment_attempt(uuid, text, text, integer, text) to service_role;
grant execute on function public.apply_stripe_auction_payment_event(text, text, uuid, text, text, text, integer, text, jsonb) to service_role;

commit;

begin;

-- Secondary-market V1 is intentionally narrow: one Grove ERC-721, sold at one
-- fixed price for native USDC through canonical Seaport 1.6. The seller keeps
-- custody. Browsers never write these tables directly; service code must first
-- verify ownership, exact-token approval, the ERC-1271 signature, and every
-- order component against a pinned block before inserting an open order.
create table public.resale_orders (
  id uuid primary key default extensions.gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete restrict,
  collection_id uuid not null references public.nft_collections(id) on delete restrict,
  seller_user_id uuid not null references auth.users(id) on delete restrict,
  seller_smart_account_id uuid not null references public.smart_accounts(id) on delete restrict,
  chain_id bigint not null check (chain_id in (1, 11155111)),
  collection_address text not null check (collection_address ~ '^0x[0-9a-f]{40}$'),
  token_id numeric(78, 0) not null check (token_id >= 0),
  quantity numeric(78, 0) not null default 1 check (quantity = 1),
  seller_address text not null check (seller_address ~ '^0x[0-9a-f]{40}$'),
  seaport_address text not null default '0x0000000000000068f116a894984e2db1123eb395'
    check (seaport_address = '0x0000000000000068f116a894984e2db1123eb395'),
  seaport_version text not null default '1.6' check (seaport_version = '1.6'),
  seaport_order_type smallint not null default 0 check (seaport_order_type = 0),
  zone_address text not null default '0x0000000000000000000000000000000000000000'
    check (zone_address = '0x0000000000000000000000000000000000000000'),
  conduit_key text not null default '0x0000000000000000000000000000000000000000000000000000000000000000'
    check (conduit_key = '0x0000000000000000000000000000000000000000000000000000000000000000'),
  partial_fills_allowed boolean not null default false check (not partial_fills_allowed),
  currency text not null default 'USDC' check (currency = 'USDC'),
  currency_address text not null check (currency_address ~ '^0x[0-9a-f]{40}$'),
  currency_decimals smallint not null default 6 check (currency_decimals = 6),
  gross_amount numeric(78, 0) not null check (gross_amount > 0),
  seller_proceeds_recipient text not null check (seller_proceeds_recipient ~ '^0x[0-9a-f]{40}$'),
  seller_proceeds_amount numeric(78, 0) not null check (seller_proceeds_amount >= 0),
  royalty_recipient text not null check (royalty_recipient ~ '^0x[0-9a-f]{40}$'),
  royalty_amount numeric(78, 0) not null default 0 check (royalty_amount >= 0),
  marketplace_fee_recipient text not null check (marketplace_fee_recipient ~ '^0x[0-9a-f]{40}$'),
  marketplace_fee_amount numeric(78, 0) not null default 0 check (marketplace_fee_amount >= 0),
  start_time_epoch bigint not null check (start_time_epoch >= 0),
  end_time_epoch bigint not null check (end_time_epoch > start_time_epoch),
  salt numeric(78, 0) not null check (salt >= 0),
  counter numeric(78, 0) not null check (counter >= 0),
  order_hash text not null unique check (order_hash ~ '^0x[0-9a-f]{64}$'),
  signature bytea not null check (octet_length(signature) between 1 and 8192),
  order_components jsonb not null check (
    jsonb_typeof(order_components) = 'object'
    and octet_length(order_components::text) between 2 and 32768
  ),
  validation_policy_version text not null check (char_length(validation_policy_version) between 1 and 80),
  validation_evidence_hash text not null check (validation_evidence_hash ~ '^0x[0-9a-f]{64}$'),
  validated_block_number bigint not null check (validated_block_number >= 0),
  validated_block_hash text not null check (validated_block_hash ~ '^0x[0-9a-f]{64}$'),
  validated_at timestamptz not null,
  approval_kind text not null default 'ERC721-exact-token' check (approval_kind = 'ERC721-exact-token'),
  approval_operator_address text not null default '0x0000000000000068f116a894984e2db1123eb395'
    check (approval_operator_address = '0x0000000000000068f116a894984e2db1123eb395'),
  approval_evidence_hash text not null check (approval_evidence_hash ~ '^0x[0-9a-f]{64}$'),
  approval_verified_block_number bigint not null check (
    approval_verified_block_number >= 0 and approval_verified_block_number <= validated_block_number
  ),
  approval_verified_block_hash text not null check (approval_verified_block_hash ~ '^0x[0-9a-f]{64}$'),
  approval_verified_at timestamptz not null check (approval_verified_at <= validated_at),
  terms_version text not null check (char_length(terms_version) between 1 and 120),
  terms_hash text not null check (terms_hash ~ '^0x[0-9a-f]{64}$'),
  state text not null default 'open' check (state in (
    'open', 'cancel-requested', 'fill-submitted', 'included', 'finalized',
    'cancelled', 'expired', 'invalidated', 'reorged', 'exception'
  )),
  published_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (chain_id = 1 and currency_address = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
    or
    (chain_id = 11155111 and currency_address = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238')
  ),
  check (seller_proceeds_recipient = seller_address),
  check (gross_amount = seller_proceeds_amount + royalty_amount + marketplace_fee_amount),
  check (
    (royalty_amount = 0 and royalty_recipient = '0x0000000000000000000000000000000000000000')
    or
    (royalty_amount > 0 and royalty_recipient <> '0x0000000000000000000000000000000000000000')
  ),
  check (
    (marketplace_fee_amount = 0 and marketplace_fee_recipient = '0x0000000000000000000000000000000000000000')
    or
    (marketplace_fee_amount > 0 and marketplace_fee_recipient <> '0x0000000000000000000000000000000000000000')
  ),
  check (
    (state in ('finalized', 'cancelled', 'expired', 'invalidated') and closed_at is not null)
    or
    (state not in ('finalized', 'cancelled', 'expired', 'invalidated') and closed_at is null)
  )
);

-- Uncertain orders continue to reserve the token. A reconciler must establish a
-- terminal chain result before another signed order can be published.
create unique index resale_orders_one_unresolved_token_idx
  on public.resale_orders(chain_id, collection_address, token_id)
  where state in ('open', 'cancel-requested', 'fill-submitted', 'included', 'reorged', 'exception');
create index resale_orders_seller_created_idx
  on public.resale_orders(seller_user_id, created_at desc);
create index resale_orders_live_expiry_idx
  on public.resale_orders(state, end_time_epoch);

-- Provider-independent, append-only log inbox. A normal observation and its
-- later removed-log observation are distinct rows; canonicality is derived from
-- the checkpoint history instead of mutating previously received evidence.
create table public.chain_event_inbox (
  id bigint generated always as identity primary key,
  resale_order_id uuid references public.resale_orders(id) on delete restrict,
  chain_id bigint not null check (chain_id in (1, 11155111)),
  event_name text not null check (event_name in (
    'Transfer', 'Approval', 'OrderFulfilled', 'OrderCancelled', 'CounterIncremented'
  )),
  emitter_address text not null check (emitter_address ~ '^0x[0-9a-f]{40}$'),
  topic0 text not null check (topic0 ~ '^0x[0-9a-f]{64}$'),
  transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_index integer not null check (transaction_index >= 0),
  log_index integer not null check (log_index >= 0),
  block_number bigint not null check (block_number >= 0),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  removed boolean not null default false,
  order_hash text check (order_hash is null or order_hash ~ '^0x[0-9a-f]{64}$'),
  token_id numeric(78, 0) check (token_id is null or token_id >= 0),
  from_address text check (from_address is null or from_address ~ '^0x[0-9a-f]{40}$'),
  to_address text check (to_address is null or to_address ~ '^0x[0-9a-f]{40}$'),
  counter numeric(78, 0) check (counter is null or counter >= 0),
  event_data jsonb not null default '{}'::jsonb check (
    jsonb_typeof(event_data) = 'object' and octet_length(event_data::text) <= 32768
  ),
  payload_hash text not null check (payload_hash ~ '^0x[0-9a-f]{64}$'),
  provider text not null check (char_length(provider) between 1 and 80),
  observed_at timestamptz not null default now(),
  unique (chain_id, block_hash, transaction_hash, log_index, removed),
  check (event_name <> 'Transfer' or (
    token_id is not null and from_address is not null and to_address is not null
  )),
  check (event_name <> 'OrderFulfilled' or (
    order_hash is not null and from_address is not null and to_address is not null
  )),
  check (event_name <> 'OrderCancelled' or (order_hash is not null and from_address is not null)),
  check (event_name <> 'CounterIncremented' or (from_address is not null and counter is not null))
);

create index chain_event_inbox_order_idx
  on public.chain_event_inbox(resale_order_id, observed_at);
create index chain_event_inbox_scan_idx
  on public.chain_event_inbox(chain_id, block_number, transaction_index, log_index);
create index chain_event_inbox_order_hash_idx
  on public.chain_event_inbox(chain_id, order_hash)
  where order_hash is not null;

-- Checkpoints are also append-only. Retaining every observed block/hash pair makes
-- an RPC disagreement or reorg diagnosable and prevents a cursor update from
-- erasing the evidence used to build a projection.
create table public.chain_indexer_checkpoints (
  id bigint generated always as identity primary key,
  worker_name text not null check (char_length(worker_name) between 1 and 120),
  chain_id bigint not null check (chain_id in (1, 11155111)),
  from_block_number bigint not null check (from_block_number >= 0),
  from_block_hash text not null check (from_block_hash ~ '^0x[0-9a-f]{64}$'),
  through_block_number bigint not null check (through_block_number >= from_block_number),
  through_block_hash text not null check (through_block_hash ~ '^0x[0-9a-f]{64}$'),
  finalized_block_number bigint not null check (
    finalized_block_number >= 0 and finalized_block_number <= through_block_number
  ),
  finalized_block_hash text not null check (finalized_block_hash ~ '^0x[0-9a-f]{64}$'),
  provider text not null check (char_length(provider) between 1 and 80),
  observed_at timestamptz not null default now(),
  unique (
    worker_name, chain_id, through_block_number, through_block_hash,
    finalized_block_number, finalized_block_hash
  )
);

create index chain_indexer_checkpoint_head_idx
  on public.chain_indexer_checkpoints(worker_name, chain_id, observed_at desc, id desc);

-- This is a replaceable current projection, not chain authority. Every version
-- points to an immutable checkpoint and, for event-derived ownership, an
-- immutable non-removed Transfer observation.
create table public.token_ownership_projection (
  chain_id bigint not null check (chain_id in (1, 11155111)),
  collection_id uuid not null references public.nft_collections(id) on delete restrict,
  collection_address text not null check (collection_address ~ '^0x[0-9a-f]{40}$'),
  token_id numeric(78, 0) not null check (token_id >= 0),
  work_id uuid not null unique references public.works(id) on delete restrict,
  owner_address text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  owner_smart_account_id uuid references public.smart_accounts(id) on delete set null,
  ownership_state text not null check (ownership_state in ('owned', 'burned')),
  finality text not null check (finality in ('observed', 'finalized')),
  source_kind text not null check (source_kind in ('event', 'snapshot')),
  source_event_id bigint references public.chain_event_inbox(id) on delete restrict,
  source_checkpoint_id bigint not null references public.chain_indexer_checkpoints(id) on delete restrict,
  observed_block_number bigint not null check (observed_block_number >= 0),
  observed_block_hash text not null check (observed_block_hash ~ '^0x[0-9a-f]{64}$'),
  projected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, collection_address, token_id),
  check (
    (ownership_state = 'burned' and owner_address = '0x0000000000000000000000000000000000000000')
    or
    (ownership_state = 'owned' and owner_address <> '0x0000000000000000000000000000000000000000')
  ),
  check (
    (source_kind = 'event' and source_event_id is not null)
    or
    (source_kind = 'snapshot' and source_event_id is null)
  )
);

create index token_ownership_projection_owner_idx
  on public.token_ownership_projection(chain_id, owner_address);

-- A failed sponsored attempt can be retried, but no order can have two unresolved
-- fills. Externally submitted fills use a deterministic chain-derived request key.
create table public.resale_fills (
  id uuid primary key default extensions.gen_random_uuid(),
  resale_order_id uuid not null references public.resale_orders(id) on delete restrict,
  buyer_user_id uuid references auth.users(id) on delete restrict,
  buyer_smart_account_id uuid references public.smart_accounts(id) on delete restrict,
  buyer_address text not null check (buyer_address ~ '^0x[0-9a-f]{40}$'),
  submission_kind text not null check (submission_kind in ('sponsored', 'external')),
  request_key text not null unique check (char_length(request_key) between 16 and 200),
  amount numeric(78, 0) not null check (amount > 0),
  currency text not null default 'USDC' check (currency = 'USDC'),
  currency_address text not null check (currency_address ~ '^0x[0-9a-f]{40}$'),
  userop_hash text check (userop_hash is null or userop_hash ~ '^0x[0-9a-f]{64}$'),
  call_data_hash text check (call_data_hash is null or call_data_hash ~ '^0x[0-9a-f]{64}$'),
  prepared_block_number bigint check (prepared_block_number is null or prepared_block_number >= 0),
  prepared_block_hash text check (prepared_block_hash is null or prepared_block_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_hash text check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'),
  block_number bigint check (block_number is null or block_number >= 0),
  block_hash text check (block_hash is null or block_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer check (log_index is null or log_index >= 0),
  source_event_id bigint unique references public.chain_event_inbox(id) on delete restrict,
  finalized_block_number bigint check (finalized_block_number is null or finalized_block_number >= 0),
  finalized_block_hash text check (finalized_block_hash is null or finalized_block_hash ~ '^0x[0-9a-f]{64}$'),
  state text not null default 'submitted'
    check (state in ('submitted', 'included', 'finalized', 'reorged', 'failed')),
  finalized_at timestamptz,
  failure_code text check (failure_code is null or char_length(failure_code) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    submission_kind <> 'sponsored'
    or (
      buyer_user_id is not null and buyer_smart_account_id is not null
      and userop_hash is not null and call_data_hash is not null
      and prepared_block_number is not null and prepared_block_hash is not null
    )
  ),
  check (
    (transaction_hash is null and block_number is null and block_hash is null
      and log_index is null and source_event_id is null)
    or
    (transaction_hash is not null and block_number is not null and block_hash is not null
      and log_index is not null and source_event_id is not null)
  ),
  check (
    (state in ('included', 'finalized', 'reorged') and transaction_hash is not null)
    or
    (state in ('submitted', 'failed'))
  ),
  check (
    (state = 'finalized' and finalized_at is not null and finalized_block_number is not null
      and finalized_block_hash is not null)
    or
    (state not in ('finalized', 'reorged') and finalized_at is null and finalized_block_number is null
      and finalized_block_hash is null)
    or
    (state = 'reorged' and (
      (finalized_at is null and finalized_block_number is null and finalized_block_hash is null)
      or
      (finalized_at is not null and finalized_block_number is not null and finalized_block_hash is not null)
    ))
  )
);

create unique index resale_fills_one_unresolved_order_idx
  on public.resale_fills(resale_order_id)
  where state in ('submitted', 'included', 'finalized');
create index resale_fills_buyer_created_idx
  on public.resale_fills(buyer_user_id, created_at desc);

-- Local order acceptance commits independently from third-party distribution.
-- This durable outbox retries OpenSea publication without making provider uptime
-- part of the order transaction or treating provider state as chain authority.
create table public.resale_order_publications (
  id uuid primary key default extensions.gen_random_uuid(),
  resale_order_id uuid not null references public.resale_orders(id) on delete restrict,
  provider text not null default 'opensea' check (provider = 'opensea'),
  state text not null default 'pending' check (state in ('pending', 'published', 'retry', 'failed')),
  provider_order_hash text check (provider_order_hash is null or provider_order_hash ~ '^0x[0-9a-f]{64}$'),
  provider_order_ref text check (provider_order_ref is null or char_length(provider_order_ref) between 1 and 240),
  last_error_code text check (last_error_code is null or char_length(last_error_code) between 1 and 120),
  last_error_detail text check (last_error_detail is null or char_length(last_error_detail) between 1 and 1000),
  attempt_count integer not null default 0 check (attempt_count between 0 and 1000),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (resale_order_id, provider),
  check (
    (state = 'pending' and attempt_count = 0 and last_attempt_at is null
      and next_attempt_at is null and published_at is null
      and provider_order_hash is null and last_error_code is null and last_error_detail is null)
    or
    (state = 'published' and attempt_count > 0 and last_attempt_at is not null
      and published_at is not null and provider_order_hash is not null
      and next_attempt_at is null and last_error_code is null and last_error_detail is null)
    or
    (state = 'retry' and attempt_count > 0 and last_attempt_at is not null
      and next_attempt_at is not null and published_at is null
      and last_error_code is not null)
    or
    (state = 'failed' and attempt_count > 0 and last_attempt_at is not null
      and next_attempt_at is null and published_at is null
      and last_error_code is not null)
  )
);

create index resale_order_publications_due_idx
  on public.resale_order_publications(state, next_attempt_at, created_at)
  where state in ('pending', 'retry');

-- Gas sponsorship remains gas-only. These action names let the existing policy
-- ledger bind an approval, revocation, cancellation, or fulfillment decision to
-- exact decoded calldata in policy_input.
alter table public.sponsorship_decisions
  drop constraint sponsorship_decisions_action_check;
alter table public.sponsorship_decisions
  add constraint sponsorship_decisions_action_check check (action in (
    'account-deploy', 'recovery-change', 'bid-cancel', 'marketplace-transfer',
    'resale-approve-token', 'resale-revoke-token', 'resale-cancel-order',
    'resale-cancel-all', 'resale-approve-usdc', 'resale-revoke-usdc', 'resale-fulfill'
  ));

create trigger resale_orders_updated_at before update on public.resale_orders
for each row execute function public.set_updated_at();
create trigger token_ownership_projection_updated_at before update on public.token_ownership_projection
for each row execute function public.set_updated_at();
create trigger resale_fills_updated_at before update on public.resale_fills
for each row execute function public.set_updated_at();
create trigger resale_order_publications_updated_at before update on public.resale_order_publications
for each row execute function public.set_updated_at();

create or replace function public.reject_resale_append_only_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'resale_chain_evidence_append_only';
end;
$$;

create trigger protect_resale_chain_event_inbox
before update or delete on public.chain_event_inbox
for each row execute function public.reject_resale_append_only_mutation();
create trigger protect_resale_chain_checkpoints
before update or delete on public.chain_indexer_checkpoints
for each row execute function public.reject_resale_append_only_mutation();

create or replace function public.validate_resale_order_record()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  selected_work public.works%rowtype;
  selected_collection public.nft_collections%rowtype;
  selected_account public.smart_accounts%rowtype;
  selected_owner public.token_ownership_projection%rowtype;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'open' or new.closed_at is not null then
      raise exception 'resale_order_must_start_open';
    end if;
    if new.end_time_epoch <= extract(epoch from now())::bigint then
      raise exception 'resale_order_already_expired';
    end if;

    select * into selected_work from public.works where id = new.work_id;
    select * into selected_collection from public.nft_collections where id = new.collection_id;
    select * into selected_account from public.smart_accounts where id = new.seller_smart_account_id;
    select * into selected_owner from public.token_ownership_projection
      where chain_id = new.chain_id
        and collection_address = new.collection_address
        and token_id = new.token_id;

    if selected_work.id is null or selected_work.format <> 'digital'
       or selected_work.nft_collection_id is distinct from new.collection_id
       or selected_work.nft_token_id is distinct from new.token_id then
      raise exception 'resale_work_not_eligible';
    end if;
    if selected_collection.id is null or selected_collection.standard <> 'ERC721'
       or selected_collection.chain_id <> new.chain_id
       or selected_collection.contract_address <> new.collection_address
       or selected_collection.state not in ('rehearsal', 'active') then
      raise exception 'resale_collection_not_eligible';
    end if;
    if selected_account.id is null or selected_account.user_id <> new.seller_user_id
       or selected_account.chain_id <> new.chain_id
       or selected_account.account_address <> new.seller_address
       or selected_account.state <> 'recovery-ready' or not selected_account.recovery_ready then
      raise exception 'resale_seller_account_not_ready';
    end if;
    if selected_owner.work_id is distinct from new.work_id
       or selected_owner.collection_id is distinct from new.collection_id
       or selected_owner.owner_address is distinct from new.seller_address
       or selected_owner.ownership_state <> 'owned'
       or selected_owner.finality <> 'finalized'
       or selected_owner.observed_block_number > new.validated_block_number then
      raise exception 'resale_seller_not_finalized_owner';
    end if;
    return new;
  end if;

  if (to_jsonb(new) - array['state', 'closed_at', 'updated_at'])
       is distinct from
     (to_jsonb(old) - array['state', 'closed_at', 'updated_at']) then
    raise exception 'resale_order_terms_immutable';
  end if;
  if old.state = 'expired'
     and new.state <> old.state then
    raise exception 'resale_order_terminal';
  end if;
  if not (
    new.state = old.state
    or (old.state = 'open' and new.state in (
      'cancel-requested', 'fill-submitted', 'expired', 'invalidated', 'exception'
    ))
    or (old.state = 'cancel-requested' and new.state in (
      'fill-submitted', 'included', 'cancelled', 'expired', 'invalidated', 'exception'
    ))
    or (old.state = 'fill-submitted' and new.state in (
      'open', 'cancel-requested', 'included', 'cancelled', 'expired', 'invalidated', 'exception'
    ))
    or (old.state = 'included' and new.state in ('finalized', 'reorged', 'exception'))
    or (old.state in ('finalized', 'cancelled', 'invalidated')
      and new.state in ('reorged', 'exception'))
    or (old.state = 'reorged' and new.state in (
      'open', 'cancel-requested', 'fill-submitted', 'included', 'cancelled',
      'expired', 'invalidated', 'exception'
    ))
    or (old.state = 'exception' and new.state in (
      'open', 'cancel-requested', 'fill-submitted', 'included', 'finalized',
      'cancelled', 'expired', 'invalidated', 'reorged'
    ))
  ) then
    raise exception 'resale_order_state_transition_invalid';
  end if;
  return new;
end;
$$;

create trigger validate_resale_order_record_before_write
before insert or update on public.resale_orders
for each row execute function public.validate_resale_order_record();

create or replace function public.prevent_resale_order_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'resale_order_delete_forbidden';
end;
$$;

create trigger prevent_resale_order_delete_before_delete
before delete on public.resale_orders
for each row execute function public.prevent_resale_order_delete();

create or replace function public.validate_resale_ownership_projection()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  selected_collection public.nft_collections%rowtype;
  selected_work public.works%rowtype;
  selected_account public.smart_accounts%rowtype;
  selected_event public.chain_event_inbox%rowtype;
  selected_checkpoint public.chain_indexer_checkpoints%rowtype;
begin
  if tg_op = 'UPDATE' and (
    new.chain_id <> old.chain_id
    or new.collection_address <> old.collection_address
    or new.token_id <> old.token_id
    or new.collection_id <> old.collection_id
    or new.work_id <> old.work_id
  ) then
    raise exception 'resale_ownership_identity_immutable';
  end if;

  select * into selected_collection from public.nft_collections where id = new.collection_id;
  select * into selected_work from public.works where id = new.work_id;
  select * into selected_checkpoint from public.chain_indexer_checkpoints where id = new.source_checkpoint_id;

  if selected_collection.id is null or selected_collection.standard <> 'ERC721'
     or selected_collection.chain_id <> new.chain_id
     or selected_collection.contract_address <> new.collection_address then
    raise exception 'resale_ownership_collection_mismatch';
  end if;
  if selected_work.id is null
     or selected_work.nft_collection_id is distinct from new.collection_id
     or selected_work.nft_token_id is distinct from new.token_id then
    raise exception 'resale_ownership_work_mismatch';
  end if;
  if new.owner_smart_account_id is not null then
    select * into selected_account from public.smart_accounts where id = new.owner_smart_account_id;
    if selected_account.id is null or selected_account.chain_id <> new.chain_id
       or selected_account.account_address <> new.owner_address then
      raise exception 'resale_ownership_smart_account_mismatch';
    end if;
  end if;
  if selected_checkpoint.id is null or selected_checkpoint.chain_id <> new.chain_id
     or selected_checkpoint.through_block_number < new.observed_block_number
     or (new.finality = 'finalized'
       and selected_checkpoint.finalized_block_number < new.observed_block_number) then
    raise exception 'resale_ownership_checkpoint_mismatch';
  end if;

  if new.source_kind = 'event' then
    select * into selected_event from public.chain_event_inbox where id = new.source_event_id;
    if selected_event.id is null or selected_event.removed
       or selected_event.event_name <> 'Transfer'
       or selected_event.chain_id <> new.chain_id
       or selected_event.emitter_address <> new.collection_address
       or selected_event.token_id is distinct from new.token_id
       or selected_event.to_address is distinct from new.owner_address
       or selected_event.block_number <> new.observed_block_number
       or selected_event.block_hash <> new.observed_block_hash then
      raise exception 'resale_ownership_event_mismatch';
    end if;
  elsif selected_checkpoint.through_block_number <> new.observed_block_number
     or selected_checkpoint.through_block_hash <> new.observed_block_hash then
    raise exception 'resale_ownership_snapshot_mismatch';
  end if;
  return new;
end;
$$;

create trigger validate_resale_ownership_projection_before_write
before insert or update on public.token_ownership_projection
for each row execute function public.validate_resale_ownership_projection();

create or replace function public.protect_resale_fill_evidence()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  selected_order public.resale_orders%rowtype;
  selected_account public.smart_accounts%rowtype;
  selected_event public.chain_event_inbox%rowtype;
begin
  select * into selected_order from public.resale_orders where id = new.resale_order_id;
  if selected_order.id is null
     or selected_order.gross_amount <> new.amount
     or selected_order.currency <> new.currency
     or selected_order.currency_address <> new.currency_address then
    raise exception 'resale_fill_order_mismatch';
  end if;

  if new.submission_kind = 'sponsored' then
    select * into selected_account from public.smart_accounts where id = new.buyer_smart_account_id;
    if selected_account.id is null or selected_account.user_id is distinct from new.buyer_user_id
       or selected_account.chain_id <> selected_order.chain_id
       or selected_account.account_address <> new.buyer_address
       or selected_account.state <> 'recovery-ready' or not selected_account.recovery_ready then
      raise exception 'resale_fill_buyer_account_not_ready';
    end if;
  end if;

  if new.transaction_hash is not null then
    select * into selected_event from public.chain_event_inbox where id = new.source_event_id;
    if selected_event.id is null or selected_event.removed
       or selected_event.event_name <> 'OrderFulfilled'
       or selected_event.chain_id <> selected_order.chain_id
       or selected_event.emitter_address <> selected_order.seaport_address
       or selected_event.order_hash is distinct from selected_order.order_hash
       or selected_event.from_address is distinct from selected_order.seller_address
       or selected_event.to_address is distinct from new.buyer_address
       or selected_event.transaction_hash <> new.transaction_hash
       or selected_event.block_number <> new.block_number
       or selected_event.block_hash <> new.block_hash
       or selected_event.log_index <> new.log_index then
      raise exception 'resale_fill_event_mismatch';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if (new.submission_kind = 'sponsored' and new.state <> 'submitted')
       or (new.submission_kind = 'external' and new.state not in ('included', 'finalized')) then
      raise exception 'resale_fill_initial_state_invalid';
    end if;
    return new;
  end if;

  if new.resale_order_id <> old.resale_order_id
     or new.buyer_user_id is distinct from old.buyer_user_id
     or new.buyer_smart_account_id is distinct from old.buyer_smart_account_id
     or new.buyer_address <> old.buyer_address
     or new.submission_kind <> old.submission_kind
     or new.request_key <> old.request_key
     or new.amount <> old.amount
     or new.currency <> old.currency
     or new.currency_address <> old.currency_address
     or new.userop_hash is distinct from old.userop_hash
     or new.call_data_hash is distinct from old.call_data_hash
     or new.prepared_block_number is distinct from old.prepared_block_number
     or new.prepared_block_hash is distinct from old.prepared_block_hash then
    raise exception 'resale_fill_request_immutable';
  end if;
  if old.transaction_hash is not null and (
    new.transaction_hash is distinct from old.transaction_hash
    or new.block_number is distinct from old.block_number
    or new.block_hash is distinct from old.block_hash
    or new.log_index is distinct from old.log_index
    or new.source_event_id is distinct from old.source_event_id
  ) then
    raise exception 'resale_fill_inclusion_immutable';
  end if;
  if old.finalized_at is not null and (
    new.finalized_at is distinct from old.finalized_at
    or new.finalized_block_number is distinct from old.finalized_block_number
    or new.finalized_block_hash is distinct from old.finalized_block_hash
  ) then
    raise exception 'resale_fill_finality_immutable';
  end if;
  if not (
    new.state = old.state
    or (old.state = 'submitted' and new.state in ('included', 'failed'))
    or (old.state = 'included' and new.state in ('finalized', 'reorged', 'failed'))
    or (old.state = 'finalized' and new.state = 'reorged')
  ) then
    raise exception 'resale_fill_state_transition_invalid';
  end if;
  return new;
end;
$$;

create trigger protect_resale_fill_evidence_before_update
before insert or update on public.resale_fills
for each row execute function public.protect_resale_fill_evidence();
create trigger prevent_resale_fill_delete_before_delete
before delete on public.resale_fills
for each row execute function public.prevent_resale_order_delete();

create or replace function public.protect_resale_order_publication()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'pending' then
      raise exception 'resale_publication_must_start_pending';
    end if;
    return new;
  end if;
  if new.resale_order_id <> old.resale_order_id
     or new.provider <> old.provider
     or new.created_at <> old.created_at then
    raise exception 'resale_publication_identity_immutable';
  end if;
  if old.state = 'published' and new is distinct from old then
    raise exception 'resale_publication_final';
  end if;
  if not (
    new.state = old.state
    or (old.state = 'pending' and new.state in ('published', 'retry', 'failed'))
    or (old.state = 'retry' and new.state in ('published', 'retry', 'failed'))
    or (old.state = 'failed' and new.state = 'retry')
  ) then
    raise exception 'resale_publication_state_transition_invalid';
  end if;
  if new.attempt_count < old.attempt_count then
    raise exception 'resale_publication_attempt_count_regressed';
  end if;
  if old.provider_order_hash is not null
     and new.provider_order_hash is distinct from old.provider_order_hash then
    raise exception 'resale_publication_provider_hash_immutable';
  end if;
  return new;
end;
$$;

create trigger protect_resale_order_publication_before_write
before insert or update on public.resale_order_publications
for each row execute function public.protect_resale_order_publication();
create trigger prevent_resale_order_publication_delete_before_delete
before delete on public.resale_order_publications
for each row execute function public.prevent_resale_order_delete();

-- Public order data necessarily contains the on-chain offerer and signature so a
-- buyer can independently verify and fulfill it. It deliberately omits Supabase
-- user/account IDs, validation internals, policy evidence, and private fill data.
create view public.public_resale_orders with (security_barrier = true) as
select
  o.id, o.work_id, w.slug, w.artist_name, w.title, w.media_url,
  o.chain_id, o.collection_address, o.token_id, o.quantity, o.seller_address,
  o.seaport_address, o.seaport_version, o.seaport_order_type, o.zone_address,
  o.conduit_key, o.currency, o.currency_address, o.currency_decimals,
  o.gross_amount, o.seller_proceeds_recipient, o.seller_proceeds_amount,
  o.royalty_recipient, o.royalty_amount,
  o.marketplace_fee_recipient, o.marketplace_fee_amount,
  o.start_time_epoch, o.end_time_epoch, o.salt, o.counter,
  o.order_hash, '0x' || encode(o.signature, 'hex') as signature, o.order_components,
  o.partial_fills_allowed, o.state, o.published_at,
  o.terms_version, o.terms_hash
from public.resale_orders o
join public.works w on w.id = o.work_id
where o.state in ('open', 'fill-submitted', 'included')
  and o.end_time_epoch > extract(epoch from now())::bigint;

-- Sellers may inspect fulfillment without learning the buyer's private account
-- UUID. Buyers read only their own complete fill record through base-table RLS.
create view public.seller_resale_fills with (security_barrier = true) as
select
  f.id, f.resale_order_id, f.buyer_address, f.submission_kind, f.amount,
  f.currency, f.currency_address, f.userop_hash, f.transaction_hash,
  f.block_number, f.block_hash, f.log_index, f.state, f.finalized_at,
  f.failure_code, f.created_at, f.updated_at
from public.resale_fills f
join public.resale_orders o on o.id = f.resale_order_id
where o.seller_user_id = auth.uid();

alter table public.resale_orders enable row level security;
alter table public.chain_event_inbox enable row level security;
alter table public.chain_indexer_checkpoints enable row level security;
alter table public.token_ownership_projection enable row level security;
alter table public.resale_fills enable row level security;
alter table public.resale_order_publications enable row level security;

create policy "sellers read their resale orders" on public.resale_orders
for select to authenticated using (seller_user_id = auth.uid());
create policy "buyers read their resale fills" on public.resale_fills
for select to authenticated using (buyer_user_id = auth.uid());

revoke all on public.resale_orders, public.chain_event_inbox,
  public.chain_indexer_checkpoints, public.token_ownership_projection, public.resale_fills,
  public.resale_order_publications
  from public, anon, authenticated;
grant select on public.resale_orders, public.resale_fills to authenticated;
grant all on public.resale_orders, public.chain_event_inbox,
  public.chain_indexer_checkpoints, public.token_ownership_projection, public.resale_fills,
  public.resale_order_publications
  to service_role;

revoke all on public.public_resale_orders, public.seller_resale_fills
  from public, anon, authenticated;
grant select on public.public_resale_orders to anon, authenticated;
grant select on public.seller_resale_fills to authenticated;

grant usage, select on sequence public.chain_event_inbox_id_seq to service_role;
grant usage, select on sequence public.chain_indexer_checkpoints_id_seq to service_role;

revoke all on function public.reject_resale_append_only_mutation() from public, anon, authenticated;
revoke all on function public.validate_resale_order_record() from public, anon, authenticated;
revoke all on function public.prevent_resale_order_delete() from public, anon, authenticated;
revoke all on function public.validate_resale_ownership_projection() from public, anon, authenticated;
revoke all on function public.protect_resale_fill_evidence() from public, anon, authenticated;
revoke all on function public.protect_resale_order_publication() from public, anon, authenticated;

commit;

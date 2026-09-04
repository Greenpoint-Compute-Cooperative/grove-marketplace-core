begin;

-- Release authorization is separate from payment ingestion. The caller must have
-- just retrieved the authoritative provider state; this table records the exact,
-- reviewed evidence and makes retries compare-and-return instead of overwriting it.
alter table public.auction_settlements
  add column release_authorization_key text unique
    check (release_authorization_key is null or char_length(release_authorization_key) between 16 and 200),
  add column release_policy_version text
    check (release_policy_version is null or char_length(release_policy_version) between 1 and 80),
  add column release_evidence_hash text
    check (release_evidence_hash is null or release_evidence_hash ~ '^0x[0-9a-f]{64}$'),
  add column release_provider_checked_at timestamptz,
  add column release_authorized_by text
    check (release_authorized_by is null or char_length(release_authorized_by) between 3 and 160),
  add column release_authorized_at timestamptz,
  add constraint auction_settlement_release_evidence_complete check (
    (release_authorization_key is null and release_policy_version is null and release_evidence_hash is null
      and release_provider_checked_at is null and release_authorized_by is null and release_authorized_at is null)
    or
    (release_authorization_key is not null and release_policy_version is not null and release_evidence_hash is not null
      and release_provider_checked_at is not null and release_authorized_by is not null and release_authorized_at is not null)
  );

-- No delivery rows exist in a released environment yet. Requiring these columns
-- makes an incomplete legacy row stop the migration instead of gaining defaults.
alter table public.chain_deliveries
  add column standard text not null check (standard in ('ERC721', 'ERC1155')),
  add column safe_nonce numeric(78, 0) not null check (safe_nonce >= 0),
  add column safe_transaction_hash text not null
    check (safe_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  add column call_data_hash text not null
    check (call_data_hash ~ '^0x[0-9a-f]{64}$'),
  add column prepared_block_number bigint not null check (prepared_block_number >= 0),
  add column prepared_block_hash text not null
    check (prepared_block_hash ~ '^0x[0-9a-f]{64}$'),
  add column included_log_index integer check (included_log_index is null or included_log_index >= 0),
  add column finalized_block_number bigint check (finalized_block_number is null or finalized_block_number >= 0),
  add column finalized_block_hash text
    check (finalized_block_hash is null or finalized_block_hash ~ '^0x[0-9a-f]{64}$'),
  add constraint chain_delivery_standard_quantity check (standard <> 'ERC721' or quantity = 1),
  add constraint chain_delivery_inclusion_complete check (
    (transaction_hash is null and block_number is null and block_hash is null and included_log_index is null)
    or
    (transaction_hash is not null and block_number is not null and block_hash is not null and included_log_index is not null)
  ),
  add constraint chain_delivery_finality_complete check (
    (finalized_at is null and finalized_block_number is null and finalized_block_hash is null)
    or
    (finalized_at is not null and finalized_block_number is not null and finalized_block_hash is not null
      and transaction_hash is not null and block_number is not null and block_hash is not null)
  ),
  add constraint chain_delivery_state_evidence check (
    (state in ('queued', 'submitted', 'failed') and finalized_at is null)
    or (state in ('included', 'reorged') and transaction_hash is not null and finalized_at is null)
    or (state = 'finalized' and transaction_hash is not null and finalized_at is not null)
  );

create unique index chain_deliveries_safe_transaction_idx
  on public.chain_deliveries(chain_id, safe_transaction_hash);
create unique index chain_deliveries_safe_nonce_idx
  on public.chain_deliveries(chain_id, from_address, safe_nonce);
create unique index chain_deliveries_execution_transaction_idx
  on public.chain_deliveries(chain_id, transaction_hash)
  where transaction_hash is not null;

create or replace function public.protect_chain_delivery_evidence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.settlement_id is distinct from old.settlement_id
     or new.chain_id is distinct from old.chain_id
     or new.standard is distinct from old.standard
     or new.collection_address is distinct from old.collection_address
     or new.token_id is distinct from old.token_id
     or new.quantity is distinct from old.quantity
     or new.from_address is distinct from old.from_address
     or new.to_address is distinct from old.to_address
     or new.safe_nonce is distinct from old.safe_nonce
     or new.safe_transaction_hash is distinct from old.safe_transaction_hash
     or new.call_data_hash is distinct from old.call_data_hash
     or new.prepared_block_number is distinct from old.prepared_block_number
     or new.prepared_block_hash is distinct from old.prepared_block_hash then
    raise exception 'delivery_evidence_immutable';
  end if;
  if old.transaction_hash is not null and (
    new.transaction_hash is distinct from old.transaction_hash
    or new.block_number is distinct from old.block_number
    or new.block_hash is distinct from old.block_hash
    or new.included_log_index is distinct from old.included_log_index
  ) then
    raise EXCEPTION 'delivery_inclusion_immutable';
  end if;
  if old.state = 'finalized' and new is distinct from old then
    raise exception 'finalized_delivery_immutable';
  end if;
  return new;
end;
$$;

create trigger protect_chain_delivery_evidence_before_update
before update on public.chain_deliveries
for each row execute function public.protect_chain_delivery_evidence();

create or replace function public.protect_settlement_release_evidence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.release_authorization_key is not null and (
    new.release_authorization_key is distinct from old.release_authorization_key
    or new.release_policy_version is distinct from old.release_policy_version
    or new.release_evidence_hash is distinct from old.release_evidence_hash
    or new.release_provider_checked_at is distinct from old.release_provider_checked_at
    or new.release_authorized_by is distinct from old.release_authorized_by
    or new.release_authorized_at is distinct from old.release_authorized_at
  ) then
    raise exception 'release_authorization_immutable';
  end if;
  return new;
end;
$$;

create trigger protect_settlement_release_evidence_before_update
before update on public.auction_settlements
for each row execute function public.protect_settlement_release_evidence();

-- A fresh provider observation is intentionally an input to this service-only
-- function: Postgres cannot contact Stripe, but it can reject stale, incomplete,
-- refunded, superseded, or non-succeeded payment evidence.
create or replace function public.authorize_auction_delivery(
  settlement_uuid uuid,
  expected_payment_intent_id text,
  authorization_key text,
  policy_version text,
  provider_evidence_hash text,
  provider_checked_at timestamptz,
  authorized_by text
)
returns public.auction_settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
  selected_attempt public.payment_attempts%rowtype;
  selected_account public.smart_accounts%rowtype;
  selected_auction public.auctions%rowtype;
  successful_refunds bigint;
begin
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found then raise exception 'settlement_not_found'; end if;
  if authorization_key is null or char_length(authorization_key) not between 16 and 200
     or policy_version is null or char_length(policy_version) not between 1 and 80
     or provider_evidence_hash is null or provider_evidence_hash !~ '^0x[0-9a-f]{64}$'
     or authorized_by is null or char_length(authorized_by) not between 3 and 160
     or provider_checked_at is null then
    raise exception 'release_evidence_invalid';
  end if;

  if selected_settlement.state = 'release-ready' then
    if selected_settlement.current_payment_intent_ref is distinct from expected_payment_intent_id
       or selected_settlement.release_authorization_key is distinct from authorization_key
       or selected_settlement.release_policy_version is distinct from policy_version
       or selected_settlement.release_evidence_hash is distinct from provider_evidence_hash
       or selected_settlement.release_provider_checked_at is distinct from provider_checked_at
       or selected_settlement.release_authorized_by is distinct from authorized_by then
      raise exception 'release_authorization_conflict';
    end if;
    return selected_settlement;
  end if;

  if provider_checked_at > now() + interval '1 minute'
     or provider_checked_at < now() - interval '10 minutes' then
    raise exception 'release_evidence_stale';
  end if;

  if selected_settlement.rail <> 'card' or selected_settlement.currency <> 'USD'
     or selected_settlement.state <> 'paid-risk-hold'
     or selected_settlement.current_payment_intent_ref is distinct from expected_payment_intent_id
     or selected_settlement.tax_transaction_ref is null or selected_settlement.paid_at is null
     or selected_settlement.total_amount is null or selected_settlement.total_amount < 50
     or selected_settlement.risk_hold_until is null or selected_settlement.risk_hold_until > now() then
    raise exception 'settlement_not_release_ready';
  end if;

  select * into selected_attempt from public.payment_attempts
  where settlement_id = settlement_uuid and payment_intent_ref = expected_payment_intent_id for update;
  if not found or selected_attempt.generation <> selected_settlement.payment_generation
     or selected_attempt.state <> 'succeeded'
     or selected_attempt.currency <> 'USD'
     or selected_attempt.amount_minor <> selected_settlement.total_amount then
    raise exception 'payment_not_cleared';
  end if;
  select coalesce(sum(amount_minor), 0) into successful_refunds
  from public.auction_payment_ledger_entries
  where settlement_id = settlement_uuid and kind = 'refund' and status = 'succeeded';
  if successful_refunds <> 0 then raise exception 'payment_not_cleared'; end if;
  if exists (
    select 1 from public.auction_payment_risk_signals
    where settlement_id = settlement_uuid
      and actionable
      and (signal_kind = 'early-fraud-warning' or payment_intent_ref = expected_payment_intent_id)
  ) then raise exception 'payment_risk_not_cleared'; end if;

  select * into selected_account from public.smart_accounts where id = selected_settlement.smart_account_id for update;
  if not found or selected_account.user_id <> selected_settlement.bidder_user_id
     or selected_account.state <> 'recovery-ready' or not selected_account.recovery_ready
     or selected_account.finalized_at is null
     or not exists (
       select 1 from public.wallet_links l
       where l.user_id = selected_settlement.bidder_user_id
         and l.smart_account_id = selected_account.id and l.revoked_at is null
     ) then
    raise exception 'winner_wallet_not_ready';
  end if;
  select * into selected_auction from public.auctions where id = selected_settlement.auction_id for update;
  if not found or selected_auction.winner_bid_id is distinct from selected_settlement.winning_bid_id then
    raise exception 'settlement_winner_mismatch';
  end if;

  update public.auction_settlements set
    state = 'release-ready',
    release_authorization_key = authorization_key,
    release_policy_version = policy_version,
    release_evidence_hash = provider_evidence_hash,
    release_provider_checked_at = provider_checked_at,
    release_authorized_by = authorized_by,
    release_authorized_at = now()
  where id = settlement_uuid
  returning * into selected_settlement;
  update public.auctions set state = 'release-ready' where id = selected_settlement.auction_id;
  insert into public.auction_events (auction_id, event_type, actor_kind, event_data)
  values (selected_settlement.auction_id, 'settlement.release-authorized', 'operator', jsonb_build_object(
    'settlement_id', settlement_uuid,
    'authorization_key', authorization_key,
    'policy_version', policy_version,
    'provider_evidence_hash', provider_evidence_hash,
    'authorized_by', authorized_by
  ));
  return selected_settlement;
end;
$$;

-- The worker calls this only after finalized collection, inventory, and recipient
-- checks. The immutable Safe hash/nonce/calldata tuple is the human review packet.
create or replace function public.claim_auction_delivery(
  settlement_uuid uuid,
  expected_chain_id bigint,
  expected_standard text,
  expected_collection_address text,
  expected_token_id numeric,
  expected_quantity numeric,
  expected_from_address text,
  expected_to_address text,
  expected_safe_nonce numeric,
  expected_safe_transaction_hash text,
  expected_call_data_hash text,
  evidence_block_number bigint,
  evidence_block_hash text
)
returns public.chain_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
  selected_auction public.auctions%rowtype;
  selected_work public.works%rowtype;
  selected_collection public.nft_collections%rowtype;
  selected_account public.smart_accounts%rowtype;
  selected_attempt public.payment_attempts%rowtype;
  existing_delivery public.chain_deliveries%rowtype;
  result public.chain_deliveries%rowtype;
begin
  select * into existing_delivery from public.chain_deliveries where settlement_id = settlement_uuid for update;
  if found then
    if existing_delivery.chain_id is distinct from expected_chain_id
       or existing_delivery.standard is distinct from expected_standard
       or existing_delivery.collection_address is distinct from expected_collection_address
       or existing_delivery.token_id is distinct from expected_token_id
       or existing_delivery.quantity is distinct from expected_quantity
       or existing_delivery.from_address is distinct from expected_from_address
       or existing_delivery.to_address is distinct from expected_to_address
       or existing_delivery.safe_nonce is distinct from expected_safe_nonce
       or existing_delivery.safe_transaction_hash is distinct from expected_safe_transaction_hash
       or existing_delivery.call_data_hash is distinct from expected_call_data_hash
       or existing_delivery.prepared_block_number is distinct from evidence_block_number
       or existing_delivery.prepared_block_hash is distinct from evidence_block_hash then
      raise exception 'delivery_claim_conflict';
    end if;
    return existing_delivery;
  end if;

  if expected_chain_id not in (1, 11155111) or expected_standard not in ('ERC721', 'ERC1155')
     or expected_collection_address !~ '^0x[0-9a-f]{40}$'
     or expected_from_address !~ '^0x[0-9a-f]{40}$' or expected_to_address !~ '^0x[0-9a-f]{40}$'
     or expected_token_id < 0 or expected_quantity <= 0
     or (expected_standard = 'ERC721' and expected_quantity <> 1)
     or expected_safe_nonce < 0
     or expected_safe_transaction_hash !~ '^0x[0-9a-f]{64}$'
     or expected_call_data_hash !~ '^0x[0-9a-f]{64}$'
     or evidence_block_number < 0 or evidence_block_hash !~ '^0x[0-9a-f]{64}$' then
    raise exception 'delivery_evidence_invalid';
  end if;

  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or selected_settlement.state <> 'release-ready'
     or selected_settlement.release_authorization_key is null
     or selected_settlement.release_evidence_hash is null
     or selected_settlement.release_authorized_at is null
     or selected_settlement.tax_transaction_ref is null or selected_settlement.paid_at is null
     or selected_settlement.risk_hold_until is null or selected_settlement.risk_hold_until > now() then
    raise exception 'settlement_not_release_ready';
  end if;
  if exists (
    select 1 from public.auction_payment_ledger_entries
    where settlement_id = settlement_uuid and kind = 'refund' and status = 'succeeded' and amount_minor > 0
  ) then raise exception 'payment_not_cleared'; end if;
  if exists (
    select 1 from public.auction_payment_risk_signals
    where settlement_id = settlement_uuid
      and actionable
      and (signal_kind = 'early-fraud-warning'
        or payment_intent_ref = selected_settlement.current_payment_intent_ref)
  ) then raise exception 'payment_risk_not_cleared'; end if;
  select * into selected_attempt from public.payment_attempts
  where settlement_id = settlement_uuid
    and payment_intent_ref = selected_settlement.current_payment_intent_ref for update;
  if not found or selected_attempt.generation <> selected_settlement.payment_generation
     or selected_attempt.state <> 'succeeded'
     or selected_attempt.amount_minor <> selected_settlement.total_amount
     or selected_attempt.currency <> selected_settlement.currency then
    raise exception 'payment_not_cleared';
  end if;

  select * into selected_auction from public.auctions where id = selected_settlement.auction_id for update;
  select * into selected_work from public.works where id = selected_auction.work_id for update;
  select * into selected_collection from public.nft_collections where id = selected_work.nft_collection_id;
  select * into selected_account from public.smart_accounts where id = selected_settlement.smart_account_id for update;
  if selected_auction.winner_bid_id is distinct from selected_settlement.winning_bid_id
     or selected_auction.quantity is distinct from expected_quantity
     or selected_work.nft_custody_state <> 'inventory-safe' or selected_work.contract_status <> 'minted'
     or selected_work.nft_token_id is distinct from expected_token_id
     or selected_work.nft_quantity < expected_quantity
     or selected_work.inventory_available < expected_quantity
     or selected_collection.chain_id is distinct from expected_chain_id
     or selected_collection.standard is distinct from expected_standard
     or selected_collection.contract_address is distinct from expected_collection_address
     or selected_collection.inventory_safe is distinct from expected_from_address
     or not (selected_collection.state = 'active'
       or (expected_chain_id = 11155111 and selected_collection.state = 'rehearsal'))
     or selected_work.nft_mint_block > evidence_block_number
     or selected_collection.deployment_block > evidence_block_number
     or selected_account.user_id <> selected_settlement.bidder_user_id
     or selected_account.account_address is distinct from expected_to_address
     or selected_account.chain_id is distinct from expected_chain_id
     or selected_account.state <> 'recovery-ready' or not selected_account.recovery_ready
     or selected_account.finalized_at is null
     or not exists (
       select 1 from public.wallet_links l
       where l.user_id = selected_settlement.bidder_user_id
         and l.smart_account_id = selected_account.id and l.revoked_at is null
     )
     or coalesce(selected_account.deployment_block, evidence_block_number + 1) > evidence_block_number then
    raise exception 'delivery_binding_mismatch';
  end if;

  insert into public.chain_deliveries (
    settlement_id, chain_id, standard, collection_address, token_id, quantity,
    from_address, to_address, safe_nonce, safe_transaction_hash, call_data_hash,
    prepared_block_number, prepared_block_hash, state
  ) values (
    settlement_uuid, expected_chain_id, expected_standard, expected_collection_address,
    expected_token_id, expected_quantity, expected_from_address, expected_to_address,
    expected_safe_nonce, expected_safe_transaction_hash, expected_call_data_hash,
    evidence_block_number, evidence_block_hash, 'queued'
  ) returning * into result;
  insert into public.auction_events (auction_id, event_type, actor_kind, event_data)
  values (selected_settlement.auction_id, 'delivery.prepared', 'system', jsonb_build_object(
    'settlement_id', settlement_uuid,
    'delivery_id', result.id,
    'safe_transaction_hash', expected_safe_transaction_hash,
    'safe_nonce', expected_safe_nonce,
    'call_data_hash', expected_call_data_hash
  ));
  return result;
end;
$$;

create or replace function public.record_auction_delivery_inclusion(
  settlement_uuid uuid,
  expected_safe_transaction_hash text,
  execution_transaction_hash text,
  execution_block_number bigint,
  execution_block_hash text,
  execution_log_index integer
)
returns public.chain_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  delivery public.chain_deliveries%rowtype;
  settlement public.auction_settlements%rowtype;
begin
  select * into delivery from public.chain_deliveries where settlement_id = settlement_uuid for update;
  if not found or delivery.safe_transaction_hash is distinct from expected_safe_transaction_hash then
    raise exception 'delivery_not_found';
  end if;
  if execution_transaction_hash !~ '^0x[0-9a-f]{64}$' or execution_block_number < 0
     or execution_block_hash !~ '^0x[0-9a-f]{64}$' or execution_log_index < 0 then
    raise exception 'delivery_inclusion_invalid';
  end if;
  if delivery.transaction_hash is not null then
    if delivery.transaction_hash is distinct from execution_transaction_hash
       or delivery.block_number is distinct from execution_block_number
       or delivery.block_hash is distinct from execution_block_hash
       or delivery.included_log_index is distinct from execution_log_index then
      raise exception 'delivery_inclusion_conflict';
    end if;
    return delivery;
  end if;
  if delivery.state not in ('queued', 'submitted') then raise exception 'delivery_not_includable'; end if;

  update public.chain_deliveries set
    transaction_hash = execution_transaction_hash,
    block_number = execution_block_number,
    block_hash = execution_block_hash,
    included_log_index = execution_log_index,
    state = 'included'
  where id = delivery.id returning * into delivery;
  select * into settlement from public.auction_settlements where id = settlement_uuid for update;
  update public.auction_settlements set
    state = case when settlement.state = 'release-ready' then 'nft-submitted' else 'disputed-post-mint' end,
    released_at = coalesce(released_at, now())
  where id = settlement_uuid;
  insert into public.auction_events (auction_id, event_type, actor_kind, event_data)
  values (settlement.auction_id, 'delivery.included', 'chain', jsonb_build_object(
    'settlement_id', settlement_uuid,
    'delivery_id', delivery.id,
    'safe_transaction_hash', expected_safe_transaction_hash,
    'transaction_hash', execution_transaction_hash,
    'block_number', execution_block_number,
    'block_hash', execution_block_hash
  ));
  return delivery;
end;
$$;

create or replace function public.finalize_auction_delivery(
  settlement_uuid uuid,
  expected_safe_transaction_hash text,
  execution_transaction_hash text,
  execution_block_number bigint,
  execution_block_hash text,
  finalized_head_number bigint,
  finalized_head_hash text
)
returns public.chain_deliveries
language plpgsql
security definer
set search_path = public
as $$
declare
  delivery public.chain_deliveries%rowtype;
  settlement public.auction_settlements%rowtype;
  auction public.auctions%rowtype;
  work public.works%rowtype;
begin
  select * into delivery from public.chain_deliveries where settlement_id = settlement_uuid for update;
  if not found or delivery.safe_transaction_hash is distinct from expected_safe_transaction_hash
     or delivery.transaction_hash is distinct from execution_transaction_hash
     or delivery.block_number is distinct from execution_block_number
     or delivery.block_hash is distinct from execution_block_hash then
    raise exception 'delivery_finality_mismatch';
  end if;
  if finalized_head_number < execution_block_number
     or finalized_head_hash !~ '^0x[0-9a-f]{64}$' then raise exception 'delivery_not_finalized'; end if;
  if delivery.state = 'finalized' then return delivery; end if;
  if delivery.state <> 'included' then raise exception 'delivery_not_finalizable'; end if;

  select * into settlement from public.auction_settlements where id = settlement_uuid for update;
  select * into auction from public.auctions where id = settlement.auction_id for update;
  select * into work from public.works where id = auction.work_id for update;
  if work.inventory_available < delivery.quantity then raise exception 'inventory_accounting_mismatch'; end if;

  update public.chain_deliveries set
    state = 'finalized', finalized_at = now(),
    finalized_block_number = finalized_head_number,
    finalized_block_hash = finalized_head_hash
  where id = delivery.id returning * into delivery;
  update public.works set
    inventory_available = inventory_available - delivery.quantity::integer,
    status = case when inventory_available - delivery.quantity::integer = 0 then 'sold' else status end,
    nft_custody_state = case when inventory_available - delivery.quantity::integer = 0 then 'transferred' else 'inventory-safe' end
  where id = work.id;
  update public.auction_settlements set
    state = case when state = 'nft-submitted' then 'fulfilled' else 'disputed-post-mint' end
  where id = settlement_uuid;
  update public.auctions set
    state = case when settlement.state = 'nft-submitted' then 'settled' else 'exception' end
  where id = auction.id;
  insert into public.auction_events (auction_id, event_type, actor_kind, event_data)
  values (auction.id, 'delivery.finalized', 'chain', jsonb_build_object(
    'settlement_id', settlement_uuid,
    'delivery_id', delivery.id,
    'transaction_hash', execution_transaction_hash,
    'finalized_head_number', finalized_head_number,
    'finalized_head_hash', finalized_head_hash
  ));
  return delivery;
end;
$$;

revoke all on function public.authorize_auction_delivery(uuid, text, text, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.claim_auction_delivery(uuid, bigint, text, text, numeric, numeric, text, text, numeric, text, text, bigint, text)
  from public, anon, authenticated;
revoke all on function public.record_auction_delivery_inclusion(uuid, text, text, bigint, text, integer)
  from public, anon, authenticated;
revoke all on function public.finalize_auction_delivery(uuid, text, text, bigint, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.authorize_auction_delivery(uuid, text, text, text, text, timestamptz, text)
  to service_role;
grant execute on function public.claim_auction_delivery(uuid, bigint, text, text, numeric, numeric, text, text, numeric, text, text, bigint, text)
  to service_role;
grant execute on function public.record_auction_delivery_inclusion(uuid, text, text, bigint, text, integer)
  to service_role;
grant execute on function public.finalize_auction_delivery(uuid, text, text, bigint, text, bigint, text)
  to service_role;

commit;

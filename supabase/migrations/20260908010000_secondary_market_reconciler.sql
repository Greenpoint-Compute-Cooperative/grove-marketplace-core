begin;

-- A lease, rather than a session advisory lock, spans the separate HTTP
-- requests made by the serverless indexer. Every mutating RPC checks and renews
-- the lease while holding this row lock.
create table public.resale_indexer_leases (
  worker_name text not null check (char_length(worker_name) between 1 and 120),
  chain_id bigint not null check (chain_id in (1, 11155111)),
  lease_token uuid not null,
  leased_until timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (worker_name, chain_id)
);

alter table public.resale_indexer_leases enable row level security;
revoke all on public.resale_indexer_leases from public, anon, authenticated;
grant all on public.resale_indexer_leases to service_role;

-- Event ordering is required when one token transfers more than once in the
-- same block. Existing snapshots remain valid with null log coordinates.
alter table public.token_ownership_projection
  add column observed_transaction_index integer check (
    observed_transaction_index is null or observed_transaction_index >= 0
  ),
  add column observed_log_index integer check (
    observed_log_index is null or observed_log_index >= 0
  );

alter table public.token_ownership_projection
  add constraint token_ownership_projection_event_position_check check (
    (source_kind = 'snapshot' and observed_transaction_index is null and observed_log_index is null)
    or
    (source_kind = 'event' and observed_transaction_index is not null and observed_log_index is not null)
  ) not valid;

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

  if tg_op = 'UPDATE' and (
    new.observed_block_number < old.observed_block_number
    or (
      new.observed_block_number = old.observed_block_number
      and old.source_kind = 'snapshot'
      and new.source_kind = 'event'
    )
    or (
      new.observed_block_number = old.observed_block_number
      and old.source_kind = 'event'
      and new.source_kind = 'event'
      and (new.observed_transaction_index, new.observed_log_index)
        < (old.observed_transaction_index, old.observed_log_index)
    )
  ) then
    raise exception 'resale_ownership_projection_regressed';
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
       or selected_event.block_hash <> new.observed_block_hash
       or selected_event.transaction_index <> new.observed_transaction_index
       or selected_event.log_index <> new.observed_log_index then
      raise exception 'resale_ownership_event_mismatch';
    end if;
  elsif new.observed_transaction_index is not null or new.observed_log_index is not null
     or selected_checkpoint.through_block_number <> new.observed_block_number
     or selected_checkpoint.through_block_hash <> new.observed_block_hash then
    raise exception 'resale_ownership_snapshot_mismatch';
  end if;
  return new;
end;
$$;

create or replace function public.claim_resale_indexer_lease(
  p_worker_name text,
  p_chain_id bigint,
  p_lease_token uuid,
  p_lease_seconds integer default 240
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  acquired boolean;
begin
  if char_length(coalesce(p_worker_name, '')) not between 1 and 120
     or p_chain_id not in (1, 11155111)
     or p_lease_token is null
     or p_lease_seconds not between 30 and 600 then
    raise exception 'resale_indexer_lease_invalid';
  end if;

  insert into public.resale_indexer_leases (
    worker_name, chain_id, lease_token, leased_until, updated_at
  ) values (
    p_worker_name, p_chain_id, p_lease_token,
    now() + make_interval(secs => p_lease_seconds), now()
  )
  on conflict (worker_name, chain_id) do update
  set lease_token = excluded.lease_token,
      leased_until = excluded.leased_until,
      updated_at = now()
  where public.resale_indexer_leases.leased_until <= now()
     or public.resale_indexer_leases.lease_token = excluded.lease_token
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create or replace function public.release_resale_indexer_lease(
  p_worker_name text,
  p_chain_id bigint,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  released integer;
begin
  update public.resale_indexer_leases
  set leased_until = now(), updated_at = now()
  where worker_name = p_worker_name
    and chain_id = p_chain_id
    and lease_token = p_lease_token;
  get diagnostics released = row_count;
  return released = 1;
end;
$$;

create or replace function public.apply_resale_indexer_batch(
  p_worker_name text,
  p_chain_id bigint,
  p_lease_token uuid,
  p_indexer_start_block bigint,
  p_from_block_number bigint,
  p_from_block_hash text,
  p_previous_block_hash text,
  p_through_block_number bigint,
  p_through_block_hash text,
  p_finalized_block_number bigint,
  p_finalized_block_hash text,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_lease public.resale_indexer_leases%rowtype;
  previous_checkpoint public.chain_indexer_checkpoints%rowtype;
  selected_order public.resale_orders%rowtype;
  selected_fill public.resale_fills%rowtype;
  selected_event public.chain_event_inbox%rowtype;
  selected_collection public.nft_collections%rowtype;
  selected_work public.works%rowtype;
  selected_account public.smart_accounts%rowtype;
  event_value jsonb;
  event_id bigint;
  order_id uuid;
  checkpoint_id bigint;
  changed integer;
  events_inserted integer := 0;
  fills_finalized integer := 0;
  ownership_updates integer := 0;
  orders_cancelled integer := 0;
  orders_invalidated integer := 0;
  event_ids bigint[] := array[]::bigint[];
begin
  select * into selected_lease
  from public.resale_indexer_leases
  where worker_name = p_worker_name and chain_id = p_chain_id
  for update;
  if selected_lease.worker_name is null
     or selected_lease.lease_token <> p_lease_token
     or selected_lease.leased_until <= now() then
    raise exception 'resale_indexer_lease_lost';
  end if;
  update public.resale_indexer_leases
  set leased_until = now() + interval '240 seconds', updated_at = now()
  where worker_name = p_worker_name and chain_id = p_chain_id;

  if p_indexer_start_block < 0
     or p_from_block_number < p_indexer_start_block
     or p_through_block_number < p_from_block_number
     or p_finalized_block_number < p_through_block_number
     or p_from_block_hash !~ '^0x[0-9a-f]{64}$'
     or p_through_block_hash !~ '^0x[0-9a-f]{64}$'
     or p_finalized_block_hash !~ '^0x[0-9a-f]{64}$'
     or (p_previous_block_hash is not null and p_previous_block_hash !~ '^0x[0-9a-f]{64}$')
     or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) > 2000 then
    raise exception 'resale_indexer_batch_invalid';
  end if;

  select * into previous_checkpoint
  from public.chain_indexer_checkpoints
  where worker_name = p_worker_name and chain_id = p_chain_id
  order by through_block_number desc, id desc
  limit 1
  for update;

  if previous_checkpoint.id is null then
    if p_from_block_number <> p_indexer_start_block or p_previous_block_hash is not null then
      raise exception 'resale_indexer_start_mismatch';
    end if;
  elsif p_from_block_number <> previous_checkpoint.through_block_number + 1
     or p_previous_block_hash is distinct from previous_checkpoint.through_block_hash then
    raise exception 'resale_indexer_checkpoint_discontinuity';
  end if;

  insert into public.chain_indexer_checkpoints (
    worker_name, chain_id, from_block_number, from_block_hash,
    through_block_number, through_block_hash,
    finalized_block_number, finalized_block_hash, provider
  ) values (
    p_worker_name, p_chain_id, p_from_block_number, p_from_block_hash,
    p_through_block_number, p_through_block_hash,
    p_through_block_number, p_through_block_hash, 'configured-rpc'
  ) returning id into checkpoint_id;

  for event_value in
    select value from jsonb_array_elements(p_events)
  loop
    if event_value ->> 'event_name' not in (
      'Transfer', 'OrderFulfilled', 'OrderCancelled', 'CounterIncremented'
    )
       or (event_value ->> 'block_number')::bigint not between p_from_block_number and p_through_block_number
       or event_value ->> 'block_hash' !~ '^0x[0-9a-f]{64}$'
       or event_value ->> 'transaction_hash' !~ '^0x[0-9a-f]{64}$'
       or event_value ->> 'topic0' !~ '^0x[0-9a-f]{64}$'
       or event_value ->> 'topic0' <> (case event_value ->> 'event_name'
         when 'Transfer' then '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
         when 'CounterIncremented' then '0x721c20121297512b72821b97f5326877ea8ecf4bb9948fea5bfcb6453074d37f'
         when 'OrderCancelled' then '0x6bacc01dbe442496068f7d234edd811f1a5f833243e0aec824f86ab861f3c90d'
         when 'OrderFulfilled' then '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31'
       end)
       or event_value ->> 'emitter_address' !~ '^0x[0-9a-f]{40}$'
       or event_value ->> 'payload_hash' !~ '^0x[0-9a-f]{64}$'
       or coalesce((event_value ->> 'removed')::boolean, false) then
      raise exception 'resale_indexer_event_invalid';
    end if;

    if event_value ->> 'event_name' in ('OrderFulfilled', 'OrderCancelled', 'CounterIncremented')
       and event_value ->> 'emitter_address' <> '0x0000000000000068f116a894984e2db1123eb395' then
      raise exception 'resale_indexer_seaport_emitter_invalid';
    end if;

    order_id := null;
    if event_value ? 'order_hash' then
      select id into order_id
      from public.resale_orders
      where chain_id = p_chain_id and order_hash = event_value ->> 'order_hash';
    end if;

    event_id := null;
    insert into public.chain_event_inbox (
      resale_order_id, chain_id, event_name, emitter_address, topic0,
      transaction_hash, transaction_index, log_index, block_number, block_hash,
      removed, order_hash, token_id, from_address, to_address, counter,
      event_data, payload_hash, provider
    ) values (
      order_id, p_chain_id, event_value ->> 'event_name', event_value ->> 'emitter_address',
      event_value ->> 'topic0', event_value ->> 'transaction_hash',
      (event_value ->> 'transaction_index')::integer, (event_value ->> 'log_index')::integer,
      (event_value ->> 'block_number')::bigint, event_value ->> 'block_hash', false,
      event_value ->> 'order_hash', (event_value ->> 'token_id')::numeric,
      event_value ->> 'from_address', event_value ->> 'to_address',
      (event_value ->> 'counter')::numeric, coalesce(event_value -> 'event_data', '{}'::jsonb),
      event_value ->> 'payload_hash', 'configured-rpc'
    )
    on conflict (chain_id, block_hash, transaction_hash, log_index, removed) do nothing
    returning id into event_id;
    if event_id is not null then
      events_inserted := events_inserted + 1;
    else
      select * into selected_event
      from public.chain_event_inbox
      where chain_id = p_chain_id
        and block_hash = event_value ->> 'block_hash'
        and transaction_hash = event_value ->> 'transaction_hash'
        and log_index = (event_value ->> 'log_index')::integer
        and not removed;
      if selected_event.id is null
         or selected_event.payload_hash <> event_value ->> 'payload_hash' then
        raise exception 'resale_indexer_event_evidence_conflict';
      end if;
      event_id := selected_event.id;
    end if;
    event_ids := array_append(event_ids, event_id);
  end loop;

  -- Fulfillment wins over the ERC-721 Transfer emitted inside that fulfillment.
  -- This prevents the transfer phase from misclassifying a canonical sale as an
  -- unrelated ownership invalidation.
  for selected_event in
    select * from public.chain_event_inbox
    where id = any(event_ids) and event_name = 'OrderFulfilled'
    order by block_number, transaction_index, log_index
  loop
    select * into selected_order
    from public.resale_orders
    where id = selected_event.resale_order_id
    for update;
    if selected_order.id is null then
      continue;
    end if;
    if selected_order.state in ('cancelled', 'expired', 'invalidated') then
      raise exception 'resale_fulfillment_conflicts_with_terminal_order';
    end if;

    select * into selected_fill
    from public.resale_fills
    where resale_order_id = selected_order.id
      and state in ('submitted', 'included', 'finalized')
    order by created_at desc
    limit 1
    for update;

    if selected_fill.id is not null and selected_fill.state = 'finalized' then
      if selected_fill.source_event_id is distinct from selected_event.id then
        raise exception 'resale_finalized_fill_evidence_conflict';
      end if;
    else
      if selected_fill.id is not null and selected_fill.state = 'submitted'
         and selected_fill.buyer_address <> selected_event.to_address then
        update public.resale_fills
        set state = 'failed', failure_code = 'superseded_by_external_fill'
        where id = selected_fill.id;
        selected_fill.id := null;
      end if;

      if selected_fill.id is null then
        select * into selected_account
        from public.smart_accounts
        where chain_id = p_chain_id and account_address = selected_event.to_address
        limit 1;
        insert into public.resale_fills (
          resale_order_id, buyer_user_id, buyer_smart_account_id, buyer_address,
          submission_kind, request_key, amount, currency, currency_address,
          transaction_hash, block_number, block_hash, log_index, source_event_id,
          finalized_block_number, finalized_block_hash, state, finalized_at
        ) values (
          selected_order.id, selected_account.user_id, selected_account.id, selected_event.to_address,
          'external', 'chain:' || p_chain_id || ':' || selected_event.transaction_hash || ':' || selected_event.log_index,
          selected_order.gross_amount, selected_order.currency, selected_order.currency_address,
          selected_event.transaction_hash, selected_event.block_number, selected_event.block_hash,
          selected_event.log_index, selected_event.id, p_finalized_block_number,
          p_finalized_block_hash, 'finalized', now()
        );
        fills_finalized := fills_finalized + 1;
      elsif selected_fill.state = 'submitted' then
        update public.resale_fills
        set state = 'included', transaction_hash = selected_event.transaction_hash,
            block_number = selected_event.block_number, block_hash = selected_event.block_hash,
            log_index = selected_event.log_index, source_event_id = selected_event.id
        where id = selected_fill.id;
        update public.resale_fills
        set state = 'finalized', finalized_block_number = p_finalized_block_number,
            finalized_block_hash = p_finalized_block_hash, finalized_at = now()
        where id = selected_fill.id;
        fills_finalized := fills_finalized + 1;
      elsif selected_fill.state = 'included' then
        if selected_fill.buyer_address <> selected_event.to_address
           or selected_fill.transaction_hash <> selected_event.transaction_hash
           or selected_fill.block_hash <> selected_event.block_hash
           or selected_fill.log_index <> selected_event.log_index then
          raise exception 'resale_included_fill_evidence_conflict';
        end if;
        update public.resale_fills
        set state = 'finalized', finalized_block_number = p_finalized_block_number,
            finalized_block_hash = p_finalized_block_hash, finalized_at = now()
        where id = selected_fill.id;
        fills_finalized := fills_finalized + 1;
      end if;
    end if;

    update public.resale_orders set state = 'fill-submitted'
    where id = selected_order.id and state in ('open', 'cancel-requested', 'reorged', 'exception');
    update public.resale_orders set state = 'included'
    where id = selected_order.id and state = 'fill-submitted';
    update public.resale_orders set state = 'finalized', closed_at = now()
    where id = selected_order.id and state = 'included';
  end loop;

  for selected_event in
    select * from public.chain_event_inbox
    where id = any(event_ids) and event_name = 'OrderCancelled'
    order by block_number, transaction_index, log_index
  loop
    select * into selected_order
    from public.resale_orders where id = selected_event.resale_order_id for update;
    if selected_order.id is null or selected_order.state in ('cancelled', 'expired', 'invalidated', 'finalized') then
      continue;
    end if;
    if selected_order.state = 'included' then
      update public.resale_orders set state = 'exception' where id = selected_order.id;
      continue;
    end if;
    update public.resale_orders set state = 'cancel-requested'
    where id = selected_order.id and state = 'open';
    update public.resale_orders set state = 'cancelled', closed_at = now()
    where id = selected_order.id and state in ('cancel-requested', 'fill-submitted', 'reorged', 'exception');
    get diagnostics changed = row_count;
    orders_cancelled := orders_cancelled + changed;
  end loop;

  for selected_event in
    select * from public.chain_event_inbox
    where id = any(event_ids) and event_name = 'CounterIncremented'
    order by block_number, transaction_index, log_index
  loop
    update public.resale_orders
    set state = case when state = 'included' then 'exception' else 'invalidated' end,
        closed_at = case when state = 'included' then null else now() end
    where chain_id = p_chain_id
      and seller_address = selected_event.from_address
      and counter < selected_event.counter
      and state in ('open', 'cancel-requested', 'fill-submitted', 'included', 'reorged', 'exception');
    get diagnostics changed = row_count;
    orders_invalidated := orders_invalidated + changed;
  end loop;

  for selected_event in
    select * from public.chain_event_inbox
    where id = any(event_ids) and event_name = 'Transfer'
    order by block_number, transaction_index, log_index
  loop
    select * into selected_collection
    from public.nft_collections
    where chain_id = p_chain_id
      and standard = 'ERC721'
      and contract_address = selected_event.emitter_address;
    if selected_collection.id is null then
      continue;
    end if;
    select * into selected_work
    from public.works
    where nft_collection_id = selected_collection.id
      and nft_token_id = selected_event.token_id
      and format = 'digital'
      and contract_status = 'minted';
    if selected_work.id is null then
      continue;
    end if;
    select * into selected_account
    from public.smart_accounts
    where chain_id = p_chain_id and account_address = selected_event.to_address
    limit 1;

    insert into public.token_ownership_projection (
      chain_id, collection_id, collection_address, token_id, work_id,
      owner_address, owner_smart_account_id, ownership_state, finality,
      source_kind, source_event_id, source_checkpoint_id,
      observed_block_number, observed_block_hash,
      observed_transaction_index, observed_log_index, projected_at
    ) values (
      p_chain_id, selected_collection.id, selected_collection.contract_address,
      selected_event.token_id, selected_work.id, selected_event.to_address,
      selected_account.id,
      case when selected_event.to_address = '0x0000000000000000000000000000000000000000' then 'burned' else 'owned' end,
      'finalized', 'event', selected_event.id, checkpoint_id,
      selected_event.block_number, selected_event.block_hash,
      selected_event.transaction_index, selected_event.log_index, now()
    )
    on conflict (chain_id, collection_address, token_id) do update
    set owner_address = excluded.owner_address,
        owner_smart_account_id = excluded.owner_smart_account_id,
        ownership_state = excluded.ownership_state,
        finality = excluded.finality,
        source_kind = excluded.source_kind,
        source_event_id = excluded.source_event_id,
        source_checkpoint_id = excluded.source_checkpoint_id,
        observed_block_number = excluded.observed_block_number,
        observed_block_hash = excluded.observed_block_hash,
        observed_transaction_index = excluded.observed_transaction_index,
        observed_log_index = excluded.observed_log_index,
        projected_at = excluded.projected_at
    where public.token_ownership_projection.observed_block_number < excluded.observed_block_number
       or (
         public.token_ownership_projection.observed_block_number = excluded.observed_block_number
         and public.token_ownership_projection.source_kind = 'event'
         and (public.token_ownership_projection.observed_transaction_index,
              public.token_ownership_projection.observed_log_index)
           < (excluded.observed_transaction_index, excluded.observed_log_index)
       );
    get diagnostics changed = row_count;
    ownership_updates := ownership_updates + changed;

    update public.resale_orders
    set state = case when state = 'included' then 'exception' else 'invalidated' end,
        closed_at = case when state = 'included' then null else now() end
    where chain_id = p_chain_id
      and collection_address = selected_event.emitter_address
      and token_id = selected_event.token_id
      and seller_address <> selected_event.to_address
      and state in ('open', 'cancel-requested', 'fill-submitted', 'included', 'reorged', 'exception');
    get diagnostics changed = row_count;
    orders_invalidated := orders_invalidated + changed;
  end loop;

  return jsonb_build_object(
    'checkpoint_id', checkpoint_id,
    'events_inserted', events_inserted,
    'fills_finalized', fills_finalized,
    'ownership_updates', ownership_updates,
    'orders_cancelled', orders_cancelled,
    'orders_invalidated', orders_invalidated
  );
end;
$$;

create or replace function public.expire_resale_orders_at_finalized_head(
  p_worker_name text,
  p_chain_id bigint,
  p_lease_token uuid,
  p_finalized_block_number bigint,
  p_finalized_block_hash text,
  p_finalized_timestamp timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_lease public.resale_indexer_leases%rowtype;
  selected_checkpoint public.chain_indexer_checkpoints%rowtype;
  changed integer;
begin
  select * into selected_lease
  from public.resale_indexer_leases
  where worker_name = p_worker_name and chain_id = p_chain_id
  for update;
  if selected_lease.worker_name is null
     or selected_lease.lease_token <> p_lease_token
     or selected_lease.leased_until <= now() then
    raise exception 'resale_indexer_lease_lost';
  end if;

  select * into selected_checkpoint
  from public.chain_indexer_checkpoints
  where worker_name = p_worker_name and chain_id = p_chain_id
  order by through_block_number desc, id desc
  limit 1;
  if selected_checkpoint.id is null
     or selected_checkpoint.through_block_number <> p_finalized_block_number
     or selected_checkpoint.through_block_hash <> p_finalized_block_hash then
    raise exception 'resale_indexer_not_caught_up';
  end if;

  update public.resale_orders
  set state = 'expired', closed_at = now()
  where chain_id = p_chain_id
    and end_time_epoch <= extract(epoch from p_finalized_timestamp)::bigint
    -- A submitted fill may already be mined above the finalized head. Keep its
    -- order reserved until the receipt reconciler or a finalized chain event
    -- establishes the outcome.
    and state in ('open', 'cancel-requested', 'reorged');
  get diagnostics changed = row_count;
  return changed;
end;
$$;

revoke all on function public.claim_resale_indexer_lease(text, bigint, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_resale_indexer_lease(text, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.apply_resale_indexer_batch(
  text, bigint, uuid, bigint, bigint, text, text, bigint, text, bigint, text, jsonb
) from public, anon, authenticated;
revoke all on function public.expire_resale_orders_at_finalized_head(
  text, bigint, uuid, bigint, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.claim_resale_indexer_lease(text, bigint, uuid, integer)
  to service_role;
grant execute on function public.release_resale_indexer_lease(text, bigint, uuid)
  to service_role;
grant execute on function public.apply_resale_indexer_batch(
  text, bigint, uuid, bigint, bigint, text, text, bigint, text, bigint, text, jsonb
) to service_role;
grant execute on function public.expire_resale_orders_at_finalized_head(
  text, bigint, uuid, bigint, text, timestamptz
) to service_role;

commit;

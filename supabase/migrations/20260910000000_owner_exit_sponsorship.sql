begin;

-- A token-changing request is both budgeted and token-exclusive while it can
-- still execute. This prevents a prepared Seaport approval from racing a
-- prepared owner exit; terminal decisions release the shared resource lock.
do $$
begin
  if exists (
    select 1 from public.sponsorship_decisions
      where action in ('marketplace-transfer', 'resale-approve-token', 'resale-revoke-token')
        and decision in ('approved', 'submitted')
        and (
          policy_input->>'chain_id' is null
          or policy_input->'reference'->>'collection_id' is null
          or policy_input->'reference'->>'token_id' is null
        )
  ) then
    raise exception 'sponsorship_active_token_reference_missing';
  end if;
  if exists (
    select 1 from public.sponsorship_decisions
      where action in ('marketplace-transfer', 'resale-approve-token', 'resale-revoke-token')
        and decision in ('approved', 'submitted')
      group by policy_input->>'chain_id',
        policy_input->'reference'->>'collection_id',
        policy_input->'reference'->>'token_id'
      having count(*) > 1
  ) then
    raise exception 'sponsorship_active_token_action_duplicate';
  end if;
end;
$$;

create unique index sponsorship_erc721_active_token_action_idx
  on public.sponsorship_decisions (
    ((policy_input->>'chain_id')),
    ((policy_input->'reference'->>'collection_id')),
    ((policy_input->'reference'->>'token_id'))
  )
  where action in ('marketplace-transfer', 'resale-approve-token', 'resale-revoke-token')
    and decision in ('approved', 'submitted');

-- Publishing a new open order and reserving an exit share the same transaction
-- lock. Whichever commits first prevents the other, so the check cannot race.
create or replace function public.reject_resale_listing_during_owner_exit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state <> 'open' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.state = 'open' then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('grove-secondary-sponsorship-budget', 0)
  );
  if exists (
    select 1 from public.sponsorship_decisions decision_row
      where decision_row.action = 'marketplace-transfer'
        and decision_row.policy_input->>'chain_id' = new.chain_id::text
        and decision_row.policy_input->'reference'->>'collection_id' = new.collection_id::text
        and decision_row.policy_input->'reference'->>'token_id' = new.token_id::text
        and (
          decision_row.decision = 'submitted'
          or (
            decision_row.decision = 'approved'
            and decision_row.policy_input->>'valid_until' ~ '^[0-9]+$'
            and (decision_row.policy_input->>'valid_until')::numeric >= pg_catalog.date_part('epoch', pg_catalog.now())
          )
        )
  ) then
    raise exception 'resale_listing_owner_exit_conflict';
  end if;
  return new;
end;
$$;

create trigger reject_resale_listing_during_owner_exit_before_write
before insert or update on public.resale_orders
for each row execute function public.reject_resale_listing_during_owner_exit();

-- Replace the shared reservation function additively so owner exits receive the
-- same atomic idempotency and rolling budget protections as resale actions.
create or replace function public.reserve_secondary_sponsorship(
  request_key_input text,
  client_request_key_input text,
  user_id_input uuid,
  smart_account_id_input uuid,
  action_input text,
  policy_version_input text,
  target_input text,
  selector_input text,
  quoted_cost_wei_input numeric,
  policy_input_input jsonb,
  per_operation_limit_input numeric,
  per_user_daily_limit_input numeric,
  global_daily_limit_input numeric,
  provider_input text
)
returns public.sponsorship_decisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected public.sponsorship_decisions%rowtype;
  user_reserved numeric(78, 0);
  global_reserved numeric(78, 0);
  rejection text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'sponsorship_service_role_required';
  end if;
  if action_input not in (
    'marketplace-transfer',
    'resale-approve-token', 'resale-revoke-token', 'resale-cancel-order',
    'resale-approve-usdc', 'resale-revoke-usdc', 'resale-fulfill'
  ) then
    raise exception 'sponsorship_action_rejected';
  end if;
  if char_length(client_request_key_input) not between 16 and 200
     or policy_input_input->>'schema' <> 'secondary-userop-v1'
     or policy_input_input->>'client_request_key' is distinct from client_request_key_input then
    raise exception 'sponsorship_client_request_invalid';
  end if;
  if action_input = 'marketplace-transfer' and (
       policy_input_input->'reference'->>'work_id' is null
       or policy_input_input->'reference'->>'collection_id' is null
       or policy_input_input->'reference'->>'collection_address' !~ '^0x[0-9a-f]{40}$'
       or policy_input_input->'reference'->>'token_id' !~ '^(0|[1-9][0-9]*)$'
       or policy_input_input->'reference'->>'from_address' !~ '^0x[0-9a-f]{40}$'
       or policy_input_input->'reference'->>'recipient_address' !~ '^0x[0-9a-f]{40}$'
       or policy_input_input->'expected_call'->>'from_address' !~ '^0x[0-9A-Fa-f]{40}$'
       or policy_input_input->'expected_call'->>'recipient_address' !~ '^0x[0-9A-Fa-f]{40}$'
       or lower(policy_input_input->'expected_call'->>'recipient_address')
          is distinct from policy_input_input->'reference'->>'recipient_address'
       or lower(policy_input_input->'expected_call'->>'from_address')
          is distinct from policy_input_input->'reference'->>'from_address'
       or policy_input_input->'expected_call'->>'token_id'
          is distinct from policy_input_input->'reference'->>'token_id'
       or lower(policy_input_input->'expected_call'->>'to')
          is distinct from policy_input_input->'reference'->>'collection_address'
       or lower(policy_input_input->'user_operation'->>'sender')
          is distinct from policy_input_input->'reference'->>'from_address'
     ) then
    raise exception 'sponsorship_transfer_reference_invalid';
  end if;
  if quoted_cost_wei_input <= 0 or per_operation_limit_input <= 0
     or per_user_daily_limit_input < per_operation_limit_input
     or global_daily_limit_input < per_user_daily_limit_input then
    raise exception 'sponsorship_budget_configuration_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('grove-secondary-sponsorship-budget', 0)
  );
  update public.sponsorship_decisions
    set decision = 'failed', actual_cost_wei = 0,
        rejection_code = 'sponsorship_preparation_expired'
    where decision = 'approved'
      and action in (
        'marketplace-transfer',
        'resale-approve-token', 'resale-revoke-token', 'resale-cancel-order',
        'resale-approve-usdc', 'resale-revoke-usdc', 'resale-fulfill'
      )
      and policy_input->>'schema' = 'secondary-userop-v1'
      and policy_input->>'valid_until' ~ '^[0-9]+$'
      and (policy_input->>'valid_until')::numeric < pg_catalog.date_part('epoch', pg_catalog.now());
  if action_input = 'marketplace-transfer' and exists (
    select 1 from public.resale_orders order_row
      where order_row.chain_id::text = policy_input_input->>'chain_id'
        and order_row.collection_id::text = policy_input_input->'reference'->>'collection_id'
        and order_row.token_id::text = policy_input_input->'reference'->>'token_id'
        and order_row.state in ('open', 'cancel-requested', 'fill-submitted', 'included', 'reorged', 'exception')
  ) then
    raise exception 'sponsorship_transfer_listing_conflict';
  end if;
  select * into selected from public.sponsorship_decisions
    where user_id = user_id_input
      and policy_input->>'schema' = 'secondary-userop-v1'
      and policy_input->>'client_request_key' = client_request_key_input
      and decision in ('approved', 'submitted', 'included')
    order by id desc
    limit 1
    for update;
  if selected.id is not null
     and selected.decision = 'approved'
     and selected.policy_input->>'valid_until' ~ '^[0-9]+$'
     and (selected.policy_input->>'valid_until')::numeric < pg_catalog.date_part('epoch', pg_catalog.now()) then
    update public.sponsorship_decisions
      set decision = 'failed', actual_cost_wei = 0,
          rejection_code = 'sponsorship_preparation_expired'
      where id = selected.id;
    selected := null;
  end if;
  if selected.id is not null then
    if selected.smart_account_id is distinct from smart_account_id_input
       or selected.action <> action_input
       or selected.policy_input->'reference' is distinct from policy_input_input->'reference' then
      raise exception 'sponsorship_request_key_conflict';
    end if;
    return selected;
  end if;

  select * into selected from public.sponsorship_decisions
    where request_key = request_key_input;
  if selected.id is not null then
    if selected.user_id is distinct from user_id_input
       or selected.smart_account_id is distinct from smart_account_id_input
       or selected.action <> action_input
       or selected.policy_version <> policy_version_input
       or selected.target is distinct from target_input
       or selected.selector is distinct from selector_input
       or selected.quoted_cost_wei is distinct from quoted_cost_wei_input
       or selected.policy_input is distinct from policy_input_input then
      raise exception 'sponsorship_request_key_conflict';
    end if;
    return selected;
  end if;

  select coalesce(sum(
      case when decision in ('included', 'failed') and actual_cost_wei is not null
        then actual_cost_wei else coalesce(quoted_cost_wei, 0) end
    ), 0)
    into user_reserved
    from public.sponsorship_decisions
    where user_id = user_id_input
      and (
        decision in ('submitted', 'included', 'failed')
        or (
          decision = 'approved'
          and (
            action not in (
              'marketplace-transfer',
              'resale-approve-token', 'resale-revoke-token', 'resale-cancel-order',
              'resale-approve-usdc', 'resale-revoke-usdc', 'resale-fulfill'
            )
            or coalesce(policy_input->>'valid_until', '') !~ '^[0-9]+$'
            or (policy_input->>'valid_until')::numeric >= pg_catalog.date_part('epoch', pg_catalog.now())
          )
        )
      )
      and created_at >= pg_catalog.now() - interval '24 hours';
  select coalesce(sum(
      case when decision in ('included', 'failed') and actual_cost_wei is not null
        then actual_cost_wei else coalesce(quoted_cost_wei, 0) end
    ), 0)
    into global_reserved
    from public.sponsorship_decisions
    where (
        decision in ('submitted', 'included', 'failed')
        or (
          decision = 'approved'
          and (
            action not in (
              'marketplace-transfer',
              'resale-approve-token', 'resale-revoke-token', 'resale-cancel-order',
              'resale-approve-usdc', 'resale-revoke-usdc', 'resale-fulfill'
            )
            or coalesce(policy_input->>'valid_until', '') !~ '^[0-9]+$'
            or (policy_input->>'valid_until')::numeric >= pg_catalog.date_part('epoch', pg_catalog.now())
          )
        )
      )
      and created_at >= pg_catalog.now() - interval '24 hours';

  if quoted_cost_wei_input > per_operation_limit_input then
    rejection := 'sponsorship_per_operation_budget_exceeded';
  elsif user_reserved + quoted_cost_wei_input > per_user_daily_limit_input then
    rejection := 'sponsorship_user_daily_budget_exceeded';
  elsif global_reserved + quoted_cost_wei_input > global_daily_limit_input then
    rejection := 'sponsorship_global_daily_budget_exceeded';
  end if;

  insert into public.sponsorship_decisions (
    user_id, smart_account_id, request_key, action, decision, policy_version,
    target, selector, provider, quoted_cost_wei, rejection_code, policy_input
  ) values (
    user_id_input, smart_account_id_input, request_key_input, action_input,
    case when rejection is null then 'approved' else 'rejected' end,
    policy_version_input, target_input, selector_input, provider_input,
    quoted_cost_wei_input, rejection, policy_input_input
  ) returning * into selected;
  return selected;
end;
$$;

-- Submission remains a durable pre-send outbox. Owner exits require no resale
-- state mutation, while fulfillment/cancellation retain their atomic updates.
create or replace function public.record_secondary_userop_submission(
  decision_id_input bigint,
  user_id_input uuid,
  userop_hash_input text,
  call_data_hash_input text,
  signed_user_operation_input jsonb
)
returns public.sponsorship_decisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected public.sponsorship_decisions%rowtype;
  selected_fill public.resale_fills%rowtype;
  listing_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'sponsorship_service_role_required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('grove-secondary-sponsorship-budget', 0)
  );
  select * into selected from public.sponsorship_decisions
    where id = decision_id_input and user_id = user_id_input
    for update;
  if selected.id is null or selected.action not in (
       'marketplace-transfer',
       'resale-approve-token', 'resale-revoke-token', 'resale-cancel-order',
       'resale-approve-usdc', 'resale-revoke-usdc', 'resale-fulfill'
     )
     or selected.decision not in ('approved', 'submitted')
     or selected.policy_input->>'schema' <> 'secondary-userop-v1'
     or selected.policy_input->>'valid_until' !~ '^[0-9]+$'
     or (selected.policy_input->>'valid_until')::numeric < pg_catalog.date_part('epoch', pg_catalog.now()) then
    raise exception 'sponsorship_submission_not_allowed';
  end if;
  if selected.userop_hash is not null and selected.userop_hash <> userop_hash_input then
    raise exception 'sponsorship_userop_hash_conflict';
  end if;
  if jsonb_typeof(signed_user_operation_input) <> 'object'
     or signed_user_operation_input->>'signature' !~ '^0x[0-9a-f]+$'
     or signed_user_operation_input->>'callData' is distinct from selected.policy_input->'user_operation'->>'callData' then
    raise exception 'sponsorship_signed_userop_invalid';
  end if;
  if selected.action = 'marketplace-transfer' and exists (
    select 1 from public.resale_orders order_row
      where order_row.chain_id::text = selected.policy_input->>'chain_id'
        and order_row.collection_id::text = selected.policy_input->'reference'->>'collection_id'
        and order_row.token_id::text = selected.policy_input->'reference'->>'token_id'
        and order_row.state in ('open', 'cancel-requested', 'fill-submitted', 'included', 'reorged', 'exception')
  ) then
    raise exception 'sponsorship_transfer_listing_conflict';
  end if;

  update public.sponsorship_decisions
    set decision = 'submitted', userop_hash = userop_hash_input,
        policy_input = pg_catalog.jsonb_set(
          policy_input,
          '{signed_user_operation}',
          signed_user_operation_input,
          true
        )
    where id = selected.id
    returning * into selected;

  if selected.action in ('resale-fulfill', 'resale-cancel-order') then
    listing_id := (selected.policy_input->'reference'->>'listing_id')::uuid;
  end if;
  if selected.action = 'resale-fulfill' then
    insert into public.resale_fills (
      resale_order_id, buyer_user_id, buyer_smart_account_id, buyer_address,
      submission_kind, request_key, amount, currency, currency_address,
      userop_hash, call_data_hash, prepared_block_number, prepared_block_hash, state
    ) values (
      listing_id, selected.user_id, selected.smart_account_id,
      lower(selected.policy_input->'user_operation'->>'sender'),
      'sponsored', selected.request_key,
      (selected.policy_input->'expected_call'->>'gross_amount')::numeric,
      'USDC', lower(selected.policy_input->'expected_call'->>'currency_address'),
      userop_hash_input, call_data_hash_input,
      (selected.policy_input->'simulation'->>'blockNumber')::bigint,
      lower(selected.policy_input->'simulation'->>'blockHash'), 'submitted'
    ) on conflict (request_key) do nothing;
    select * into selected_fill from public.resale_fills where request_key = selected.request_key;
    if selected_fill.id is null or selected_fill.resale_order_id <> listing_id
       or selected_fill.buyer_user_id is distinct from selected.user_id
       or selected_fill.buyer_smart_account_id is distinct from selected.smart_account_id
       or selected_fill.userop_hash <> userop_hash_input
       or selected_fill.call_data_hash <> call_data_hash_input then
      raise exception 'sponsorship_fill_conflict';
    end if;
    update public.resale_orders set state = 'fill-submitted'
      where id = listing_id and state = 'open';
  elsif selected.action = 'resale-cancel-order' then
    update public.resale_orders set state = 'cancel-requested'
      where id = listing_id and state = 'open';
  end if;
  return selected;
end;
$$;

revoke all on function public.reserve_secondary_sponsorship(
  text, text, uuid, uuid, text, text, text, text, numeric, jsonb, numeric, numeric, numeric, text
) from public, anon, authenticated;
grant execute on function public.reserve_secondary_sponsorship(
  text, text, uuid, uuid, text, text, text, text, numeric, jsonb, numeric, numeric, numeric, text
) to service_role;
revoke all on function public.record_secondary_userop_submission(bigint, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_secondary_userop_submission(bigint, uuid, text, text, jsonb)
  to service_role;

commit;

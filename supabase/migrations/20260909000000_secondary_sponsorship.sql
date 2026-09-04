begin;

-- One live generation per authenticated user/client key. Failed, rejected, or
-- expired unsigned generations leave the partial index and may be retried.
create unique index sponsorship_secondary_client_request_active_idx
  on public.sponsorship_decisions (user_id, ((policy_input->>'client_request_key')))
  where decision in ('approved', 'submitted', 'included')
    and policy_input->>'schema' = 'secondary-userop-v1';

-- Atomic reservation against the existing private sponsorship ledger. The
-- advisory transaction lock serializes all rolling-day budget checks so two
-- concurrent prepares cannot independently spend the same remaining budget.
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
  if quoted_cost_wei_input <= 0 or per_operation_limit_input <= 0
     or per_user_daily_limit_input < per_operation_limit_input
     or global_daily_limit_input < per_user_daily_limit_input then
    raise exception 'sponsorship_budget_configuration_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('grove-secondary-sponsorship-budget', 0)
  );
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

-- Persist a signed, hash-bound submission intent before contacting the bundler.
-- The identical UserOperation can then be replayed safely after any ambiguous
-- network failure. The decision, optional fill, and order transition are one
-- atomic outbox record.
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
  select * into selected from public.sponsorship_decisions
    where id = decision_id_input and user_id = user_id_input
    for update;
  if selected.id is null or selected.action not in (
       'resale-approve-token', 'resale-revoke-token', 'resale-cancel-order',
       'resale-approve-usdc', 'resale-revoke-usdc', 'resale-fulfill'
     )
     or selected.decision not in ('approved', 'submitted')
     or selected.policy_input->>'schema' <> 'secondary-userop-v1' then
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

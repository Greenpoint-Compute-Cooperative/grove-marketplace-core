begin;

alter table public.auction_settlements
  add column tax_calculation_ref text unique
    check (tax_calculation_ref is null or tax_calculation_ref ~ '^taxcalc_[A-Za-z0-9_]+$'),
  add column tax_transaction_ref text unique
    check (tax_transaction_ref is null or tax_transaction_ref ~ '^tax_[A-Za-z0-9_]+$'),
  add column paid_at timestamptz,
  add column settlement_deadline timestamptz,
  add column risk_hold_seconds integer check (risk_hold_seconds is null or risk_hold_seconds between 0 and 2592000),
  add column cure_checkout_session_ref text unique
    check (cure_checkout_session_ref is null or cure_checkout_session_ref ~ '^cs_[A-Za-z0-9_]+$'),
  add column cure_prior_payment_intent_ref text
    check (cure_prior_payment_intent_ref is null or cure_prior_payment_intent_ref ~ '^pi_[A-Za-z0-9_]+$'),
  add column cure_state text check (cure_state is null or cure_state in ('open', 'completed', 'expired')),
  add column cure_expires_at timestamptz,
  add check (
    (cure_checkout_session_ref is null and cure_prior_payment_intent_ref is null and cure_state is null and cure_expires_at is null)
    or
    (cure_checkout_session_ref is not null and cure_prior_payment_intent_ref is not null and cure_state is not null and cure_expires_at is not null)
  );

alter table public.auction_payment_ledger_entries
  add column tax_reversal_ref text unique
    check (tax_reversal_ref is null or tax_reversal_ref ~ '^tax_[A-Za-z0-9_]+$');

create table public.auction_payment_risk_signals (
  id uuid primary key default extensions.gen_random_uuid(),
  settlement_id uuid not null references public.auction_settlements(id) on delete restrict,
  payment_intent_ref text not null check (payment_intent_ref ~ '^pi_[A-Za-z0-9_]+$'),
  provider_object_ref text not null unique check (char_length(provider_object_ref) between 4 and 240),
  signal_kind text not null check (signal_kind in ('review', 'early-fraud-warning')),
  actionable boolean not null,
  status text not null check (char_length(status) between 1 and 120),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index auction_payment_risk_open_idx
  on public.auction_payment_risk_signals(settlement_id, actionable, observed_at);
create trigger auction_payment_risk_updated_at before update on public.auction_payment_risk_signals
for each row execute function public.set_updated_at();
alter table public.auction_payment_risk_signals enable row level security;
revoke all on public.auction_payment_risk_signals from public, anon, authenticated;

-- The wrapper makes settlement/cure and risk policy deadlines part of the same
-- transaction as winner selection. The underlying function is no longer callable
-- by the service role, so no new card settlement can bypass these fields.
create or replace function public.close_auction_for_settlement(
  auction_uuid uuid,
  expected_high_bid_uuid uuid,
  expected_intent_hash text,
  signature_verified_block bigint,
  inventory_verified_block bigint,
  inventory_verified_block_hash text,
  settlement_deadline_at timestamptz,
  risk_hold_seconds_value integer
)
returns public.auction_settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.auction_settlements%rowtype;
begin
  if settlement_deadline_at is null or settlement_deadline_at <= now()
     or settlement_deadline_at > now() + interval '30 days'
     or risk_hold_seconds_value is null or risk_hold_seconds_value not between 0 and 2592000 then
    raise exception 'settlement_policy_invalid';
  end if;
  result := public.close_auction(
    auction_uuid, expected_high_bid_uuid, expected_intent_hash, signature_verified_block,
    inventory_verified_block, inventory_verified_block_hash
  );
  if result is null then return null; end if;
  select * into result from public.auction_settlements where id = result.id for update;
  if result.settlement_deadline is null then
    update public.auction_settlements set
      settlement_deadline = settlement_deadline_at,
      risk_hold_seconds = risk_hold_seconds_value
    where id = result.id returning * into result;
    update public.auctions set settlement_deadline = settlement_deadline_at where id = auction_uuid;
  elsif result.risk_hold_seconds is null then
    raise exception 'settlement_policy_missing';
  end if;
  return result;
end;
$$;
revoke execute on function public.close_auction(uuid, uuid, text, bigint, bigint, text) from service_role;

-- Freeze the provider-calculated card total exactly once. Provider calls happen
-- before this RPC with a stable idempotency key; retries must present the same
-- calculation and amounts or fail closed.
create or replace function public.freeze_auction_settlement_total(
  settlement_uuid uuid,
  tax_calculation_id text,
  tax_amount_minor integer,
  shipping_amount_minor integer
)
returns public.auction_settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
begin
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or selected_settlement.rail <> 'card' or selected_settlement.currency <> 'USD' then
    raise exception 'settlement_mismatch';
  end if;
  if tax_calculation_id is null or tax_calculation_id !~ '^taxcalc_' then
    raise exception 'tax_calculation_invalid';
  end if;
  if tax_amount_minor < 0 or shipping_amount_minor < 0 then
    raise exception 'settlement_amount_invalid';
  end if;
  if selected_settlement.tax_calculation_ref is not null then
    if selected_settlement.tax_calculation_ref is distinct from tax_calculation_id
       or selected_settlement.tax_amount <> tax_amount_minor
       or selected_settlement.shipping_amount <> shipping_amount_minor
       or selected_settlement.total_amount <> selected_settlement.hammer_amount + tax_amount_minor + shipping_amount_minor then
      raise exception 'settlement_total_already_frozen';
    end if;
    return selected_settlement;
  end if;
  if selected_settlement.state <> 'winner-selected' or selected_settlement.current_payment_intent_ref is not null
     or selected_settlement.settlement_deadline is null or selected_settlement.settlement_deadline <= now()
     or selected_settlement.risk_hold_seconds is null then
    raise exception 'settlement_not_freezable';
  end if;
  update public.auction_settlements set
    tax_calculation_ref = tax_calculation_id,
    tax_amount = tax_amount_minor,
    shipping_amount = shipping_amount_minor,
    total_amount = hammer_amount + tax_amount_minor + shipping_amount_minor,
    state = 'tax-pending'
  where id = settlement_uuid
  returning * into selected_settlement;
  insert into public.auction_events (auction_id, event_type, actor_kind, event_data)
  values (selected_settlement.auction_id, 'settlement.total-frozen', 'system', jsonb_build_object(
    'settlement_id', settlement_uuid,
    'tax_calculation_id', tax_calculation_id,
    'tax_amount_minor', tax_amount_minor,
    'shipping_amount_minor', shipping_amount_minor,
    'total_amount_minor', selected_settlement.total_amount
  ));
  return selected_settlement;
end;
$$;

-- Record the retrieved-current result of the server's immediate Stripe call.
-- A direct observation can stop retries or expose a cure, but deliberately
-- cannot enter paid-risk-hold; only apply_stripe_auction_payment_event can.
create or replace function public.record_auction_payment_observation(
  settlement_uuid uuid,
  payment_intent_id text,
  object_status text,
  object_error_code text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
  selected_attempt public.payment_attempts%rowtype;
  next_attempt_state text;
  next_settlement_state text;
begin
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or selected_settlement.rail <> 'card'
     or selected_settlement.current_payment_intent_ref is distinct from payment_intent_id then
    raise exception 'payment_intent_not_current';
  end if;
  select * into selected_attempt from public.payment_attempts
  where settlement_id = settlement_uuid and payment_intent_ref = payment_intent_id for update;
  if not found or selected_attempt.generation <> selected_settlement.payment_generation then
    raise exception 'payment_attempt_mismatch';
  end if;
  if object_status not in ('requires_confirmation', 'requires_action', 'requires_payment_method', 'processing', 'succeeded', 'canceled') then
    raise exception 'payment_status_invalid';
  end if;
  if selected_settlement.state in ('paid-risk-hold', 'release-ready', 'nft-submitted', 'nft-finalized', 'fulfilled', 'partially-refunded', 'refunded', 'disputed-post-mint') then
    return selected_settlement.state;
  end if;

  next_attempt_state := case
    when object_status = 'requires_action' then 'requires-action'
    when object_status in ('requires_payment_method') then 'failed'
    when object_status = 'canceled' then 'canceled'
    when object_status in ('processing', 'succeeded') then 'processing'
    else 'created'
  end;
  next_settlement_state := case
    when object_status = 'requires_action' then 'requires-action'
    when object_status in ('requires_payment_method', 'canceled') then 'payment-failed'
    when object_status in ('processing', 'succeeded') then 'processing'
    else 'charge-pending'
  end;
  update public.payment_attempts set
    state = next_attempt_state,
    last_error_code = case when next_attempt_state in ('failed', 'canceled') then left(object_error_code, 120) else null end
  where id = selected_attempt.id;
  update public.auction_settlements set state = next_settlement_state where id = settlement_uuid;
  insert into public.auction_events (auction_id, event_type, actor_kind, event_data)
  values (selected_settlement.auction_id, 'settlement.provider-observed', 'system', jsonb_build_object(
    'settlement_id', settlement_uuid,
    'payment_intent_id', payment_intent_id,
    'provider_status', object_status,
    'settlement_state', next_settlement_state
  ));
  return next_settlement_state;
end;
$$;

create or replace function public.register_auction_payment_cure(
  settlement_uuid uuid,
  expected_payment_intent_id text,
  checkout_session_id text,
  expires_at_value timestamptz
)
returns public.auction_settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
  selected_attempt public.payment_attempts%rowtype;
begin
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or selected_settlement.rail <> 'card' then raise exception 'settlement_mismatch'; end if;
  if checkout_session_id is null or checkout_session_id !~ '^cs_' or expires_at_value <= now() then
    raise exception 'cure_session_invalid';
  end if;
  if selected_settlement.cure_checkout_session_ref is not null then
    if selected_settlement.cure_checkout_session_ref is distinct from checkout_session_id
       or selected_settlement.cure_prior_payment_intent_ref is distinct from expected_payment_intent_id then
      raise exception 'cure_session_already_bound';
    end if;
    return selected_settlement;
  end if;
  if selected_settlement.state <> 'payment-failed'
     or selected_settlement.current_payment_intent_ref is distinct from expected_payment_intent_id
     or selected_settlement.settlement_deadline is null or selected_settlement.settlement_deadline <= now()
     or expires_at_value > selected_settlement.settlement_deadline then
    raise exception 'payment_not_curable';
  end if;
  select * into selected_attempt from public.payment_attempts
  where settlement_id = settlement_uuid and payment_intent_ref = expected_payment_intent_id for update;
  if not found or selected_attempt.state <> 'canceled'
     or selected_attempt.generation <> selected_settlement.payment_generation then
    raise exception 'payment_not_curable';
  end if;
  update public.auction_settlements set
    cure_checkout_session_ref = checkout_session_id,
    cure_prior_payment_intent_ref = expected_payment_intent_id,
    cure_state = 'open',
    cure_expires_at = expires_at_value
  where id = settlement_uuid
  returning * into selected_settlement;
  return selected_settlement;
end;
$$;

-- The signed Checkout webhook binds its newly-created PaymentIntent as the one
-- allowed replacement. This wrapper is retry-idempotent across a crash between
-- binding and applying the same signed provider event.
create or replace function public.bind_auction_payment_cure(
  settlement_uuid uuid,
  checkout_session_id text,
  replacement_payment_intent_id text,
  expected_amount integer
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
  if not found or selected_settlement.rail <> 'card'
     or selected_settlement.cure_checkout_session_ref is distinct from checkout_session_id then
    raise exception 'cure_session_mismatch';
  end if;
  if replacement_payment_intent_id is null or replacement_payment_intent_id !~ '^pi_'
     or replacement_payment_intent_id = selected_settlement.cure_prior_payment_intent_ref
     or expected_amount < 50 or selected_settlement.total_amount <> expected_amount then
    raise exception 'cure_payment_invalid';
  end if;
  if selected_settlement.current_payment_intent_ref = replacement_payment_intent_id
     and selected_settlement.cure_state = 'completed' then
    select * into result from public.payment_attempts
    where settlement_id = settlement_uuid and payment_intent_ref = replacement_payment_intent_id;
    if not found then raise exception 'payment_attempt_mismatch'; end if;
    return result;
  end if;
  if selected_settlement.cure_state <> 'open' or selected_settlement.state <> 'payment-failed'
     or selected_settlement.current_payment_intent_ref is distinct from selected_settlement.cure_prior_payment_intent_ref then
    raise exception 'cure_not_bindable';
  end if;
  select * into prior_attempt from public.payment_attempts
  where settlement_id = settlement_uuid and payment_intent_ref = selected_settlement.cure_prior_payment_intent_ref for update;
  if not found or prior_attempt.state <> 'canceled'
     or prior_attempt.generation <> selected_settlement.payment_generation then
    raise exception 'prior_payment_not_replaceable';
  end if;
  next_generation := selected_settlement.payment_generation + 1;
  insert into public.payment_attempts (
    settlement_id, payment_intent_ref, generation, attempt_kind, amount_minor, state
  ) values (
    settlement_uuid, replacement_payment_intent_id, next_generation, 'interactive-cure', expected_amount, 'created'
  ) returning * into result;
  update public.auction_settlements set
    current_payment_intent_ref = replacement_payment_intent_id,
    payment_generation = next_generation,
    state = 'charge-pending',
    cure_state = 'completed'
  where id = settlement_uuid;
  return result;
end;
$$;

-- Called only after the signed webhook has retrieved the currently-bound
-- PaymentIntent as succeeded and Stripe has committed the Tax Transaction.
create or replace function public.record_auction_tax_transaction(
  settlement_uuid uuid,
  payment_intent_id text,
  tax_transaction_id text,
  provider_paid_at timestamptz
)
returns public.auction_settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
  selected_attempt public.payment_attempts%rowtype;
begin
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or selected_settlement.rail <> 'card'
     or selected_settlement.current_payment_intent_ref is distinct from payment_intent_id then
    raise exception 'payment_intent_not_current';
  end if;
  if tax_transaction_id is null or tax_transaction_id !~ '^tax_'
     or selected_settlement.tax_calculation_ref is null
     or selected_settlement.total_amount is null or selected_settlement.risk_hold_seconds is null
     or provider_paid_at is null or provider_paid_at > now() + interval '5 minutes'
     or provider_paid_at < selected_settlement.created_at - interval '5 minutes' then
    raise exception 'tax_transaction_invalid';
  end if;
  select * into selected_attempt from public.payment_attempts
  where settlement_id = settlement_uuid and payment_intent_ref = payment_intent_id for update;
  if not found or selected_attempt.generation <> selected_settlement.payment_generation
     or selected_attempt.amount_minor <> selected_settlement.total_amount then
    raise exception 'payment_attempt_mismatch';
  end if;
  if selected_settlement.tax_transaction_ref is not null then
    if selected_settlement.tax_transaction_ref is distinct from tax_transaction_id then
      raise exception 'tax_transaction_conflict';
    end if;
    return selected_settlement;
  end if;
  update public.auction_settlements set
    tax_transaction_ref = tax_transaction_id,
    paid_at = provider_paid_at,
    risk_hold_until = provider_paid_at + make_interval(secs => risk_hold_seconds)
  where id = settlement_uuid returning * into selected_settlement;
  return selected_settlement;
end;
$$;

create or replace function public.record_auction_tax_reversal(
  settlement_uuid uuid,
  payment_intent_id text,
  refund_id text,
  tax_reversal_id text,
  refund_amount integer,
  refund_status text
)
returns public.auction_payment_ledger_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
  result public.auction_payment_ledger_entries%rowtype;
begin
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or selected_settlement.current_payment_intent_ref is distinct from payment_intent_id
     or selected_settlement.tax_transaction_ref is null then raise exception 'payment_intent_not_current'; end if;
  if refund_id is null or refund_id !~ '^re_' or tax_reversal_id is null or tax_reversal_id !~ '^tax_'
     or refund_amount <= 0 or refund_amount > selected_settlement.total_amount or refund_status <> 'succeeded' then
    raise exception 'tax_reversal_invalid';
  end if;
  insert into public.auction_payment_ledger_entries (
    settlement_id, provider_object_id, kind, amount_minor, status, tax_reversal_ref
  ) values (
    settlement_uuid, refund_id, 'refund', refund_amount, refund_status, tax_reversal_id
  ) on conflict (provider, provider_object_id) do update set
    tax_reversal_ref = case
      when auction_payment_ledger_entries.tax_reversal_ref is null
        or auction_payment_ledger_entries.tax_reversal_ref = excluded.tax_reversal_ref
        then excluded.tax_reversal_ref
      else null
    end
  returning * into result;
  if result.tax_reversal_ref is null then raise exception 'tax_reversal_conflict'; end if;
  return result;
end;
$$;

create or replace function public.apply_stripe_auction_risk_event(
  stripe_event_id text,
  stripe_event_type text,
  settlement_uuid uuid,
  payment_intent_id text,
  provider_object_id text,
  signal_kind_value text,
  actionable_value boolean,
  object_status text,
  provider_observed_at timestamptz,
  event_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
begin
  insert into public.provider_events (provider, event_id, event_type, auction_id, settlement_id, payload)
  select 'stripe', stripe_event_id, stripe_event_type, s.auction_id, s.id, event_payload
  from public.auction_settlements s where s.id = settlement_uuid
  on conflict (provider, event_id) do nothing;
  if not found then return 'duplicate'; end if;
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found then raise exception 'settlement_mismatch'; end if;
  if selected_settlement.current_payment_intent_ref is distinct from payment_intent_id then
    if exists (select 1 from public.payment_attempts where settlement_id = settlement_uuid and payment_intent_ref = payment_intent_id) then
      update public.provider_events set processed_at = now(), processing_error = 'stale_prior_generation'
      where provider = 'stripe' and event_id = stripe_event_id;
      return 'stale';
    end if;
    raise exception 'payment_intent_not_known';
  end if;
  if provider_object_id is null or char_length(provider_object_id) < 4
     or signal_kind_value not in ('review', 'early-fraud-warning')
     or actionable_value is null or object_status is null or char_length(object_status) > 120
     or provider_observed_at is null then raise exception 'risk_signal_invalid'; end if;
  insert into public.auction_payment_risk_signals (
    settlement_id, payment_intent_ref, provider_object_ref, signal_kind, actionable, status, observed_at
  ) values (
    settlement_uuid, payment_intent_id, provider_object_id, signal_kind_value,
    actionable_value, object_status, provider_observed_at
  ) on conflict (provider_object_ref) do update set
    actionable = excluded.actionable,
    status = excluded.status,
    observed_at = excluded.observed_at
  where auction_payment_risk_signals.settlement_id = excluded.settlement_id
    and auction_payment_risk_signals.payment_intent_ref = excluded.payment_intent_ref
    and auction_payment_risk_signals.signal_kind = excluded.signal_kind;
  if not found then raise exception 'risk_signal_conflict'; end if;
  if actionable_value and selected_settlement.state = 'release-ready' then
    update public.auction_settlements set state = 'paid-risk-hold' where id = settlement_uuid;
    update public.auctions set state = 'paid-risk-hold' where id = selected_settlement.auction_id;
  end if;
  update public.provider_events set processed_at = now() where provider = 'stripe' and event_id = stripe_event_id;
  return case when actionable_value then 'actionable' else 'cleared' end;
end;
$$;

create or replace function public.expire_auction_payment_cure(
  stripe_event_id text,
  settlement_uuid uuid,
  checkout_session_id text,
  event_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
begin
  insert into public.provider_events (provider, event_id, event_type, auction_id, settlement_id, payload)
  select 'stripe', stripe_event_id, 'checkout.session.expired', s.auction_id, s.id, event_payload
  from public.auction_settlements s where s.id = settlement_uuid
  on conflict (provider, event_id) do nothing;
  if not found then return 'duplicate'; end if;
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or selected_settlement.cure_checkout_session_ref is distinct from checkout_session_id then
    raise exception 'cure_session_mismatch';
  end if;
  if selected_settlement.cure_state = 'open' then
    update public.auction_settlements set cure_state = 'expired' where id = settlement_uuid;
  end if;
  update public.provider_events set processed_at = now() where provider = 'stripe' and event_id = stripe_event_id;
  return 'expired';
end;
$$;

-- Replace the foundation handler so out-of-order events for a known, retired
-- generation are durably acknowledged while an unknown intent remains an error.
-- Paid state additionally requires the Tax Transaction and authoritative paid time.
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
  nft_finalized_or_released boolean;
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
    if exists (
      select 1 from public.payment_attempts
      where settlement_id = settlement_uuid and payment_intent_ref = payment_intent_id
    ) then
      update public.provider_events set processed_at = now(), processing_error = 'stale_prior_generation'
      where provider = 'stripe' and event_id = stripe_event_id;
      return 'stale';
    end if;
    raise exception 'payment_intent_not_known';
  end if;
  if lower(object_currency) <> 'usd' then raise exception 'payment_currency_mismatch'; end if;
  nft_finalized_or_released := selected_settlement.state in ('nft-finalized', 'fulfilled', 'disputed-post-mint');

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
    if object_status = 'succeeded' and not exists (
      select 1 from public.auction_payment_ledger_entries
      where settlement_id = settlement_uuid and provider_object_id = stripe_object_id
        and tax_reversal_ref is not null
    ) then raise exception 'tax_reversal_missing'; end if;
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

  if stripe_event_type = 'payment_intent.succeeded'
     and (selected_settlement.total_amount is distinct from object_amount
       or selected_settlement.tax_transaction_ref is null
       or selected_settlement.paid_at is null
       or selected_settlement.risk_hold_until is null) then
    raise exception 'payment_success_evidence_missing';
  end if;
  next_state := case
    when stripe_event_type like 'payment_intent.%'
      and selected_settlement.state in ('paid-risk-hold', 'release-ready', 'nft-submitted', 'nft-finalized', 'fulfilled', 'partially-refunded', 'refunded', 'disputed-post-mint')
      then selected_settlement.state
    when stripe_event_type = 'payment_intent.succeeded' then 'paid-risk-hold'
    when stripe_event_type = 'payment_intent.processing' then 'processing'
    when stripe_event_type = 'payment_intent.requires_action' then 'requires-action'
    when stripe_event_type in ('payment_intent.payment_failed', 'payment_intent.canceled') then 'payment-failed'
    when stripe_event_type like 'refund.%' and object_status = 'succeeded' and nft_finalized_or_released then 'disputed-post-mint'
    when stripe_event_type like 'refund.%' and object_status = 'succeeded'
      and selected_settlement.state = 'nft-submitted' then 'exception'
    when stripe_event_type like 'refund.%' and object_status = 'succeeded'
      and succeeded_refund_amount >= selected_settlement.total_amount then 'refunded'
    when stripe_event_type like 'refund.%' and object_status = 'succeeded' and succeeded_refund_amount > 0 then 'partially-refunded'
    when stripe_event_type like 'refund.%' then selected_settlement.state
    when stripe_event_type in ('charge.dispute.created', 'charge.dispute.lost')
      then case when nft_finalized_or_released then 'disputed-post-mint' else 'exception' end
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

revoke all on function public.close_auction_for_settlement(uuid, uuid, text, bigint, bigint, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.freeze_auction_settlement_total(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.record_auction_payment_observation(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.register_auction_payment_cure(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.bind_auction_payment_cure(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.expire_auction_payment_cure(text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.record_auction_tax_transaction(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.record_auction_tax_reversal(uuid, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.apply_stripe_auction_risk_event(text, text, uuid, text, text, text, boolean, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.close_auction_for_settlement(uuid, uuid, text, bigint, bigint, text, timestamptz, integer) to service_role;
grant execute on function public.freeze_auction_settlement_total(uuid, text, integer, integer) to service_role;
grant execute on function public.record_auction_payment_observation(uuid, text, text, text) to service_role;
grant execute on function public.register_auction_payment_cure(uuid, text, text, timestamptz) to service_role;
grant execute on function public.bind_auction_payment_cure(uuid, text, text, integer) to service_role;
grant execute on function public.expire_auction_payment_cure(text, uuid, text, jsonb) to service_role;
grant execute on function public.record_auction_tax_transaction(uuid, text, text, timestamptz) to service_role;
grant execute on function public.record_auction_tax_reversal(uuid, text, text, text, integer, text) to service_role;
grant execute on function public.apply_stripe_auction_risk_event(text, text, uuid, text, text, text, boolean, text, timestamptz, jsonb) to service_role;

commit;

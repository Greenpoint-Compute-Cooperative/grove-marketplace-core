begin;

-- Stripe's actionable flag is not a clearance signal. An Early Fraud Warning
-- stays blocking until an operator records a separate, freshly retrieved
-- provider-resolution artifact through the service-only RPC below.
alter table public.auction_payment_risk_signals
  add column resolution_reference text
    check (resolution_reference is null or char_length(resolution_reference) between 4 and 240),
  add column resolution_evidence_hash text
    check (resolution_evidence_hash is null or resolution_evidence_hash ~ '^0x[0-9a-f]{64}$'),
  add column resolution_provider_checked_at timestamptz,
  add column resolved_by text
    check (resolved_by is null or char_length(resolved_by) between 3 and 160),
  add column resolved_at timestamptz,
  add constraint auction_payment_risk_resolution_complete check (
    (resolution_reference is null and resolution_evidence_hash is null
      and resolution_provider_checked_at is null and resolved_by is null and resolved_at is null)
    or
    (signal_kind = 'early-fraud-warning' and resolution_reference is not null
      and resolution_evidence_hash is not null and resolution_provider_checked_at is not null
      and resolved_by is not null and resolved_at is not null)
  );

update public.auction_payment_risk_signals
set actionable = true
where signal_kind = 'early-fraud-warning' and resolved_at is null;

update public.auctions a set state = 'paid-risk-hold'
where a.id in (
  select s.auction_id from public.auction_settlements s
  where s.state = 'release-ready' and exists (
    select 1 from public.auction_payment_risk_signals r
    where r.settlement_id = s.id and r.signal_kind = 'early-fraud-warning' and r.actionable
  )
);
update public.auction_settlements s set state = 'paid-risk-hold'
where s.state = 'release-ready' and exists (
  select 1 from public.auction_payment_risk_signals r
  where r.settlement_id = s.id and r.signal_kind = 'early-fraud-warning' and r.actionable
);

create or replace function public.protect_auction_payment_risk_resolution()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.signal_kind = 'early-fraud-warning' then
    new.actionable := new.resolved_at is null;
  end if;
  if tg_op = 'UPDATE' and old.resolved_at is not null and (
    new.resolution_reference is distinct from old.resolution_reference
    or new.resolution_evidence_hash is distinct from old.resolution_evidence_hash
    or new.resolution_provider_checked_at is distinct from old.resolution_provider_checked_at
    or new.resolved_by is distinct from old.resolved_by
    or new.resolved_at is distinct from old.resolved_at
  ) then
    raise exception 'risk_resolution_immutable';
  end if;
  return new;
end;
$$;

create trigger protect_auction_payment_risk_resolution_before_write
before insert or update on public.auction_payment_risk_signals
for each row execute function public.protect_auction_payment_risk_resolution();

-- Replace provider ingestion so a non-actionable EFW still revokes a release.
-- A previously resolved warning stays resolved; a distinct warning object must
-- receive its own resolution evidence.
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
  selected_signal public.auction_payment_risk_signals%rowtype;
  prior_generation boolean := false;
begin
  insert into public.provider_events (provider, event_id, event_type, auction_id, settlement_id, payload)
  select 'stripe', stripe_event_id, stripe_event_type, s.auction_id, s.id, event_payload
  from public.auction_settlements s where s.id = settlement_uuid
  on conflict (provider, event_id) do nothing;
  if not found then return 'duplicate'; end if;
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found then raise exception 'settlement_mismatch'; end if;
  if selected_settlement.current_payment_intent_ref is distinct from payment_intent_id then
    if exists (
      select 1 from public.payment_attempts
      where settlement_id = settlement_uuid and payment_intent_ref = payment_intent_id
    ) then
      prior_generation := true;
    else
      raise exception 'payment_intent_not_known';
    end if;
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
    actionable = case
      when excluded.signal_kind = 'early-fraud-warning'
        then auction_payment_risk_signals.resolved_at is null
      else excluded.actionable
    end,
    status = excluded.status,
    observed_at = excluded.observed_at
  where auction_payment_risk_signals.settlement_id = excluded.settlement_id
    and auction_payment_risk_signals.payment_intent_ref = excluded.payment_intent_ref
    and auction_payment_risk_signals.signal_kind = excluded.signal_kind
  returning * into selected_signal;
  if not found then raise exception 'risk_signal_conflict'; end if;
  if selected_signal.actionable and selected_settlement.state = 'release-ready' then
    update public.auction_settlements set state = 'paid-risk-hold' where id = settlement_uuid;
    update public.auctions set state = 'paid-risk-hold' where id = selected_settlement.auction_id;
  end if;
  update public.provider_events set
    processed_at = now(),
    processing_error = case when prior_generation then 'prior_generation_risk_signal' else null end
  where provider = 'stripe' and event_id = stripe_event_id;
  return case when selected_signal.actionable then 'actionable' else 'cleared' end;
end;
$$;

create or replace function public.resolve_auction_early_fraud_warning(
  settlement_uuid uuid,
  payment_intent_id text,
  provider_object_id text,
  resolution_reference_value text,
  resolution_evidence_hash_value text,
  provider_checked_at timestamptz,
  resolved_by_value text
)
returns public.auction_payment_risk_signals
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_settlement public.auction_settlements%rowtype;
  selected_signal public.auction_payment_risk_signals%rowtype;
begin
  if resolution_reference_value is null or char_length(resolution_reference_value) not between 4 and 240
     or resolution_evidence_hash_value is null
     or resolution_evidence_hash_value !~ '^0x[0-9a-f]{64}$'
     or provider_checked_at is null
     or resolved_by_value is null or char_length(resolved_by_value) not between 3 and 160 then
    raise exception 'risk_resolution_invalid';
  end if;
  select * into selected_settlement from public.auction_settlements where id = settlement_uuid for update;
  if not found or not exists (
    select 1 from public.payment_attempts
    where settlement_id = settlement_uuid and payment_intent_ref = payment_intent_id
  ) then
    raise exception 'payment_intent_not_known';
  end if;
  select * into selected_signal from public.auction_payment_risk_signals
  where provider_object_ref = provider_object_id for update;
  if not found or selected_signal.settlement_id is distinct from settlement_uuid
     or selected_signal.payment_intent_ref is distinct from payment_intent_id
     or selected_signal.signal_kind <> 'early-fraud-warning' then
    raise exception 'early_fraud_warning_not_found';
  end if;
  if selected_signal.resolved_at is not null then
    if selected_signal.resolution_reference is distinct from resolution_reference_value
       or selected_signal.resolution_evidence_hash is distinct from resolution_evidence_hash_value
       or selected_signal.resolution_provider_checked_at is distinct from provider_checked_at
       or selected_signal.resolved_by is distinct from resolved_by_value then
      raise exception 'risk_resolution_conflict';
    end if;
    return selected_signal;
  end if;
  if provider_checked_at > now() + interval '1 minute'
     or provider_checked_at < now() - interval '10 minutes'
     or provider_checked_at < selected_signal.observed_at then
    raise exception 'risk_resolution_stale';
  end if;
  update public.auction_payment_risk_signals set
    resolution_reference = resolution_reference_value,
    resolution_evidence_hash = resolution_evidence_hash_value,
    resolution_provider_checked_at = provider_checked_at,
    resolved_by = resolved_by_value,
    resolved_at = now(),
    actionable = false
  where id = selected_signal.id returning * into selected_signal;
  insert into public.auction_events (auction_id, event_type, actor_kind, event_data)
  values (selected_settlement.auction_id, 'settlement.efw-resolved', 'operator', jsonb_build_object(
    'settlement_id', settlement_uuid,
    'payment_intent_id', payment_intent_id,
    'provider_object_id', provider_object_id,
    'resolution_reference', resolution_reference_value,
    'resolution_evidence_hash', resolution_evidence_hash_value,
    'resolved_by', resolved_by_value
  ));
  return selected_signal;
end;
$$;

-- A late warning can revoke release authorization. Fresh authorization evidence
-- may replace the old tuple only before any Safe delivery packet was claimed.
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
  ) and not (
    old.state = 'paid-risk-hold' and new.state = 'release-ready'
    and not exists (
      select 1 from public.chain_deliveries where settlement_id = old.id
    )
  ) then
    raise exception 'release_authorization_immutable';
  end if;
  return new;
end;
$$;

revoke all on function public.resolve_auction_early_fraud_warning(uuid, text, text, text, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.resolve_auction_early_fraud_warning(uuid, text, text, text, text, timestamptz, text)
  to service_role;

commit;

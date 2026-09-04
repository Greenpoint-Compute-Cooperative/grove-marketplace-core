begin;

-- Seller, rights, inventory, and order state stay authoritative in Postgres. Provider
-- objects and browser redirects are projections of these records, never the reverse.
create table public.sellers (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  display_name text not null check (char_length(display_name) between 1 and 160),
  legal_name text check (legal_name is null or char_length(legal_name) <= 240),
  email text check (email is null or char_length(email) <= 320),
  status text not null default 'pending' check (status in ('pending', 'active', 'restricted', 'suspended')),
  terms_version text,
  terms_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.rights_assertions (
  id uuid primary key default extensions.gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete cascade,
  seller_id uuid not null references public.sellers(id) on delete restrict,
  assertion_type text not null check (assertion_type in ('sale', 'media', 'mint', 'copyright-license', 'physical-fulfillment')),
  status text not null default 'pending' check (status in ('pending', 'cleared', 'rejected', 'expired')),
  evidence_url text check (evidence_url is null or char_length(evidence_url) <= 2000),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (work_id, assertion_type)
);

alter table public.works
  add column seller_id uuid references public.sellers(id) on delete restrict,
  add column sale_enabled boolean not null default false,
  add column sale_kind text not null default 'fixed' check (sale_kind in ('fixed', 'auction')),
  add column inventory_total integer not null default 1 check (inventory_total > 0),
  add column inventory_available integer not null default 1 check (inventory_available between 0 and inventory_total),
  add column requires_shipping boolean not null default false,
  add column stripe_tax_code text check (stripe_tax_code is null or stripe_tax_code ~ '^txcd_[0-9]+$'),
  add column stripe_shipping_rate_id text check (stripe_shipping_rate_id is null or stripe_shipping_rate_id ~ '^shr_[A-Za-z0-9_]+$'),
  add column buyer_terms_url text check (buyer_terms_url is null or (char_length(buyer_terms_url) <= 2000 and buyer_terms_url ~ '^https://')),
  add column buyer_terms_version text check (buyer_terms_version is null or char_length(buyer_terms_version) <= 120),
  add column license_uri text check (license_uri is null or (char_length(license_uri) <= 2000 and license_uri ~ '^(https://|ipfs://)')),
  add column metadata_uri text check (metadata_uri is null or char_length(metadata_uri) <= 2000),
  add column mint_recipient_required boolean not null default false;

update public.works
set inventory_available = 0
where status = 'sold';

alter table public.acquisitions drop constraint if exists acquisitions_state_check;
alter table public.acquisitions
  add constraint acquisitions_state_check check (state in (
    'created', 'checkout-pending', 'onchain-pending', 'paid', 'mint-pending', 'fulfilled',
    'payout-pending', 'paid-out', 'failed', 'expired', 'cancelled', 'disputed', 'refunded'
  )),
  add column seller_id uuid references public.sellers(id) on delete restrict,
  add column idempotency_key text,
  add column reservation_expires_at timestamptz,
  add column provider_payment_ref text check (provider_payment_ref is null or char_length(provider_payment_ref) <= 240),
  add column buyer_email text check (buyer_email is null or char_length(buyer_email) <= 320),
  add column tax_minor integer not null default 0 check (tax_minor >= 0),
  add column shipping_minor integer not null default 0 check (shipping_minor >= 0),
  add column seller_proceeds_minor integer check (seller_proceeds_minor is null or seller_proceeds_minor >= 0),
  add column buyer_terms_url text check (buyer_terms_url is null or char_length(buyer_terms_url) <= 2000),
  add column buyer_terms_version text check (buyer_terms_version is null or char_length(buyer_terms_version) <= 120),
  add column buyer_terms_accepted_at timestamptz,
  add column license_uri text check (license_uri is null or char_length(license_uri) <= 2000),
  add column pre_dispute_state text,
  add column error_code text check (error_code is null or char_length(error_code) <= 120),
  add column fulfilled_at timestamptz;

create unique index acquisitions_idempotency_idx on public.acquisitions(idempotency_key) where idempotency_key is not null;
create unique index acquisitions_payment_ref_idx on public.acquisitions(provider_payment_ref) where provider_payment_ref is not null;
create index acquisitions_reservation_expiry_idx
  on public.acquisitions(reservation_expires_at)
  where state = 'checkout-pending';

create table public.provider_events (
  provider text not null,
  event_id text not null,
  event_type text not null,
  acquisition_id uuid references public.acquisitions(id) on delete set null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  primary key (provider, event_id)
);

create table public.payment_ledger_entries (
  id bigint generated always as identity primary key,
  acquisition_id uuid not null references public.acquisitions(id) on delete restrict,
  provider text not null,
  provider_object_id text not null,
  kind text not null check (kind in ('refund')),
  amount_minor integer not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_object_id)
);

create table public.fulfillments (
  id uuid primary key default extensions.gen_random_uuid(),
  acquisition_id uuid not null references public.acquisitions(id) on delete restrict,
  kind text not null check (kind in ('physical', 'mint', 'digital-delivery')),
  state text not null default 'pending' check (state in ('pending', 'ready', 'in-progress', 'complete', 'failed', 'returned')),
  provider_ref text check (provider_ref is null or char_length(provider_ref) <= 240),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (acquisition_id, kind)
);

create table public.commerce_outbox (
  id bigint generated always as identity primary key,
  topic text not null,
  dedupe_key text not null unique,
  payload jsonb not null,
  available_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table public.commerce_audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_kind text not null check (actor_kind in ('user', 'operator', 'provider', 'system')),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create trigger sellers_updated_at before update on public.sellers for each row execute function public.set_updated_at();
create trigger fulfillments_updated_at before update on public.fulfillments for each row execute function public.set_updated_at();
create trigger payment_ledger_entries_updated_at before update on public.payment_ledger_entries
for each row execute function public.set_updated_at();

alter table public.sellers enable row level security;
alter table public.rights_assertions enable row level security;
alter table public.provider_events enable row level security;
alter table public.payment_ledger_entries enable row level security;
alter table public.fulfillments enable row level security;
alter table public.commerce_outbox enable row level security;
alter table public.commerce_audit_log enable row level security;

create policy "sellers read their own profile" on public.sellers for select to authenticated using (user_id = auth.uid());
create policy "sellers read their rights records" on public.rights_assertions for select to authenticated using (
  seller_id in (select id from public.sellers where user_id = auth.uid())
);
create policy "buyers read their fulfillment" on public.fulfillments for select to authenticated using (
  acquisition_id in (select id from public.acquisitions where buyer_user_id = auth.uid())
);

revoke all on public.sellers, public.rights_assertions, public.provider_events, public.payment_ledger_entries, public.fulfillments,
  public.commerce_outbox, public.commerce_audit_log from anon, authenticated;
grant select on public.sellers, public.rights_assertions, public.fulfillments to authenticated;

-- Reserve exactly one unit using a row lock. The PSP session is created only after this
-- commits. Ambiguous PSP failures keep the same reservation/key for safe reconciliation.
create or replace function public.reserve_card_checkout(
  work_uuid uuid,
  buyer_uuid uuid,
  request_key text,
  terms_version_required text,
  buyer_terms_url_required text,
  buyer_terms_version_required text,
  max_item_price_minor integer,
  reservation_deadline timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_work public.works%rowtype;
  selected_seller public.sellers%rowtype;
  acquisition public.acquisitions%rowtype;
begin
  if buyer_uuid is null then
    raise exception 'authentication_required';
  end if;
  if request_key is null or char_length(request_key) < 16 or char_length(request_key) > 200 then
    raise exception 'invalid_idempotency_key';
  end if;

  -- Serialize the reservation limit across different works and idempotency keys for one buyer.
  perform 1 from auth.users where id = buyer_uuid for update;
  if not found then
    raise exception 'authentication_required';
  end if;

  select * into acquisition from public.acquisitions where idempotency_key = request_key;
  if found then
    if acquisition.work_id <> work_uuid or acquisition.buyer_user_id <> buyer_uuid then
      raise exception 'idempotency_conflict';
    end if;
    if acquisition.state <> 'checkout-pending' then
      raise exception 'idempotency_terminal';
    end if;
    select * into selected_work from public.works where id = acquisition.work_id;
    return jsonb_build_object(
      'acquisition_id', acquisition.id,
      'work_id', selected_work.id,
      'slug', selected_work.slug,
      'title', selected_work.title,
      'artist_name', selected_work.artist_name,
      'format', selected_work.format,
      'amount_minor', acquisition.amount_minor,
      'currency', acquisition.currency,
      'requires_shipping', selected_work.requires_shipping,
      'stripe_tax_code', selected_work.stripe_tax_code,
      'stripe_shipping_rate_id', selected_work.stripe_shipping_rate_id,
      'buyer_terms_version', acquisition.buyer_terms_version,
      'provider_ref', acquisition.provider_ref,
      'state', acquisition.state,
      'reservation_expires_at', acquisition.reservation_expires_at
    );
  end if;

  select * into selected_work from public.works where id = work_uuid for update;
  if not found or selected_work.status <> 'listed' or not selected_work.sale_enabled
     or selected_work.sale_kind <> 'fixed' or selected_work.inventory_available < 1 then
    raise exception 'work_unavailable';
  end if;
  if selected_work.format <> 'physical' then
    raise exception 'nft_sale_not_enabled';
  end if;
  if selected_work.price_minor is null or selected_work.currency <> 'USD' or selected_work.stripe_tax_code is null
     or selected_work.price_minor < 50 or max_item_price_minor is null
     or selected_work.price_minor > max_item_price_minor then
    raise exception 'work_price_unavailable';
  end if;
  if selected_work.requires_shipping and selected_work.stripe_shipping_rate_id is null then
    raise exception 'work_shipping_unavailable';
  end if;
  if selected_work.buyer_terms_url is null or selected_work.buyer_terms_url <> buyer_terms_url_required
     or selected_work.buyer_terms_version is null or selected_work.buyer_terms_version <> buyer_terms_version_required
     or selected_work.license_uri is null then
    raise exception 'work_terms_unavailable';
  end if;

  select * into selected_seller from public.sellers where id = selected_work.seller_id;
  if not found or selected_seller.status <> 'active' or selected_seller.terms_accepted_at is null
     or terms_version_required is null or selected_seller.terms_version <> terms_version_required then
    raise exception 'seller_unavailable';
  end if;
  if (select count(*) from public.acquisitions
      where buyer_user_id = buyer_uuid and state = 'checkout-pending' and reservation_expires_at > now()) >= 3 then
    raise exception 'buyer_reservation_limit';
  end if;
  if not exists (
    select 1 from public.rights_assertions
    where work_id = selected_work.id and seller_id = selected_work.seller_id
      and assertion_type = 'sale' and status = 'cleared' and (expires_at is null or expires_at > now())
  ) or not exists (
    select 1 from public.rights_assertions
    where work_id = selected_work.id and seller_id = selected_work.seller_id
      and assertion_type = 'media' and status = 'cleared' and (expires_at is null or expires_at > now())
  ) or (selected_work.format in ('digital', 'paired') and not exists (
    select 1 from public.rights_assertions
    where work_id = selected_work.id and seller_id = selected_work.seller_id
      and assertion_type = 'mint' and status = 'cleared' and (expires_at is null or expires_at > now())
  )) or (selected_work.format in ('physical', 'paired') and not exists (
    select 1 from public.rights_assertions
    where work_id = selected_work.id and seller_id = selected_work.seller_id
      and assertion_type = 'physical-fulfillment' and status = 'cleared' and (expires_at is null or expires_at > now())
  )) then
    raise exception 'rights_not_cleared';
  end if;

  insert into public.acquisitions (
    work_id, buyer_user_id, method, state, amount_minor, currency, seller_id, idempotency_key, reservation_expires_at,
    buyer_terms_url, buyer_terms_version, license_uri
  ) values (
    selected_work.id,
    buyer_uuid,
    'card',
    'checkout-pending',
    selected_work.price_minor,
    selected_work.currency,
    selected_seller.id,
    request_key,
    greatest(now() + interval '5 minutes', least(reservation_deadline, now() + interval '1 hour')),
    selected_work.buyer_terms_url,
    selected_work.buyer_terms_version,
    selected_work.license_uri
  ) returning * into acquisition;

  update public.works
  set inventory_available = inventory_available - 1,
      status = case when inventory_available - 1 = 0 then 'reserved' else status end
  where id = selected_work.id;

  insert into public.commerce_audit_log (actor_kind, action, entity_type, entity_id, details)
  values ('system', 'inventory.reserved', 'acquisition', acquisition.id::text, jsonb_build_object('work_id', selected_work.id));

  return jsonb_build_object(
    'acquisition_id', acquisition.id,
    'work_id', selected_work.id,
    'slug', selected_work.slug,
    'title', selected_work.title,
    'artist_name', selected_work.artist_name,
    'format', selected_work.format,
    'amount_minor', acquisition.amount_minor,
    'currency', acquisition.currency,
    'requires_shipping', selected_work.requires_shipping,
    'stripe_tax_code', selected_work.stripe_tax_code,
    'stripe_shipping_rate_id', selected_work.stripe_shipping_rate_id,
    'buyer_terms_version', selected_work.buyer_terms_version,
    'provider_ref', acquisition.provider_ref,
    'state', acquisition.state,
    'reservation_expires_at', acquisition.reservation_expires_at
  );
end;
$$;

create or replace function public.attach_card_checkout(acquisition_uuid uuid, checkout_session_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if checkout_session_id is null or checkout_session_id !~ '^cs_' then raise exception 'invalid_checkout_session'; end if;
  update public.acquisitions
  set provider_ref = checkout_session_id
  where id = acquisition_uuid and state = 'checkout-pending' and provider_ref is null;
  if not found then raise exception 'reservation_unavailable'; end if;
end;
$$;

create or replace function public.release_card_reservation(acquisition_uuid uuid, reason_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  acquisition public.acquisitions%rowtype;
begin
  select * into acquisition from public.acquisitions where id = acquisition_uuid for update;
  if not found or acquisition.state <> 'checkout-pending' then return false; end if;

  update public.acquisitions
  set state = 'failed', error_code = left(coalesce(reason_code, 'checkout_failed'), 120)
  where id = acquisition.id;
  update public.works
  set inventory_available = least(inventory_total, inventory_available + 1),
      status = case when status = 'reserved' and sale_enabled then 'listed' else status end
  where id = acquisition.work_id;
  insert into public.commerce_audit_log (actor_kind, action, entity_type, entity_id, details)
  values ('system', 'inventory.released', 'acquisition', acquisition.id::text, jsonb_build_object('reason', reason_code));
  return true;
end;
$$;

create or replace function public.apply_stripe_checkout_event(
  stripe_event_id text,
  stripe_event_type text,
  acquisition_uuid uuid,
  checkout_session_id text,
  payment_intent_id text,
  checkout_payment_status text,
  customer_email_address text,
  checkout_amount_total integer,
  checkout_amount_subtotal integer,
  checkout_amount_tax integer,
  checkout_amount_shipping integer,
  checkout_currency text,
  checkout_mode text,
  automatic_tax_enabled boolean,
  terms_acceptance_status text,
  event_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  acquisition public.acquisitions%rowtype;
  event_processed_at timestamptz;
begin
  insert into public.provider_events (provider, event_id, event_type, acquisition_id, payload)
  values ('stripe', stripe_event_id, stripe_event_type, acquisition_uuid, event_payload)
  on conflict do nothing;
  select processed_at into event_processed_at
  from public.provider_events where provider = 'stripe' and event_id = stripe_event_id for update;
  if event_processed_at is not null then return 'duplicate'; end if;
  update public.provider_events
  set event_type = stripe_event_type, acquisition_id = acquisition_uuid, payload = event_payload, processing_error = null
  where provider = 'stripe' and event_id = stripe_event_id;

  select * into acquisition from public.acquisitions where id = acquisition_uuid for update;
  if not found or (acquisition.provider_ref is not null and acquisition.provider_ref <> checkout_session_id) then
    update public.provider_events set processing_error = 'acquisition_mismatch' where provider = 'stripe' and event_id = stripe_event_id;
    return 'ignored';
  end if;

  if stripe_event_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded')
     and checkout_payment_status = 'paid' and acquisition.state = 'checkout-pending' then
    if checkout_mode <> 'payment' or not coalesce(automatic_tax_enabled, false) or terms_acceptance_status <> 'accepted'
       or checkout_amount_subtotal is distinct from acquisition.amount_minor
       or checkout_amount_total is distinct from acquisition.amount_minor + coalesce(checkout_amount_tax, 0) + coalesce(checkout_amount_shipping, 0)
       or upper(coalesce(checkout_currency, '')) <> acquisition.currency
       or payment_intent_id is null then
      update public.provider_events set processing_error = 'amount_mismatch' where provider = 'stripe' and event_id = stripe_event_id;
      return 'ignored';
    end if;
    update public.acquisitions
    set state = 'paid', provider_ref = checkout_session_id, provider_payment_ref = payment_intent_id,
        buyer_email = left(customer_email_address, 320), tax_minor = coalesce(checkout_amount_tax, 0),
        shipping_minor = coalesce(checkout_amount_shipping, 0), buyer_terms_accepted_at = now(), error_code = null
    where id = acquisition.id;
    update public.works
    set status = case
      when status = 'reserved' and inventory_available = 0 then 'sold'
      when status = 'reserved' then 'listed'
      else status
    end
    where id = acquisition.work_id;
    insert into public.commerce_outbox (topic, dedupe_key, payload)
    values ('fulfillment.requested', 'fulfillment:' || acquisition.id::text, jsonb_build_object('acquisition_id', acquisition.id))
    on conflict do nothing;
    insert into public.commerce_audit_log (actor_kind, action, entity_type, entity_id, details)
    values ('provider', 'payment.succeeded', 'acquisition', acquisition.id::text, jsonb_build_object('event_id', stripe_event_id));
  elsif stripe_event_type in ('checkout.session.expired', 'checkout.session.async_payment_failed')
        and acquisition.state = 'checkout-pending' then
    update public.acquisitions
    set state = case when stripe_event_type = 'checkout.session.expired' then 'expired' else 'failed' end,
        error_code = stripe_event_type
    where id = acquisition.id;
    update public.works
    set inventory_available = least(inventory_total, inventory_available + 1),
        status = case when status = 'reserved' and sale_enabled then 'listed' else status end
    where id = acquisition.work_id;
    insert into public.commerce_audit_log (actor_kind, action, entity_type, entity_id, details)
    values ('provider', 'payment.released', 'acquisition', acquisition.id::text, jsonb_build_object('event_id', stripe_event_id));
  end if;

  update public.provider_events set processed_at = now(), processing_error = null
  where provider = 'stripe' and event_id = stripe_event_id;
  return 'processed';
end;
$$;

create or replace function public.apply_stripe_financial_event(
  stripe_event_id text,
  stripe_event_type text,
  acquisition_uuid uuid,
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
  acquisition public.acquisitions%rowtype;
  event_processed_at timestamptz;
  refunded_total bigint;
begin
  insert into public.provider_events (provider, event_id, event_type, acquisition_id, payload)
  values ('stripe', stripe_event_id, stripe_event_type, acquisition_uuid, event_payload)
  on conflict do nothing;
  select processed_at into event_processed_at
  from public.provider_events where provider = 'stripe' and event_id = stripe_event_id for update;
  if event_processed_at is not null then return 'duplicate'; end if;
  update public.provider_events
  set event_type = stripe_event_type, acquisition_id = acquisition_uuid, payload = event_payload, processing_error = null
  where provider = 'stripe' and event_id = stripe_event_id;

  select * into acquisition from public.acquisitions where id = acquisition_uuid for update;
  if not found then
    update public.provider_events set processing_error = 'payment_mismatch'
    where provider = 'stripe' and event_id = stripe_event_id;
    return 'ignored';
  end if;
  if acquisition.provider_payment_ref is null and acquisition.state = 'checkout-pending' then
    update public.provider_events set processing_error = 'payment_linkage_pending'
    where provider = 'stripe' and event_id = stripe_event_id;
    return 'retry';
  end if;
  if acquisition.provider_payment_ref is null or acquisition.provider_payment_ref <> payment_intent_id then
    update public.provider_events set processing_error = 'payment_mismatch'
    where provider = 'stripe' and event_id = stripe_event_id;
    return 'ignored';
  end if;

  if stripe_event_type in ('refund.created', 'refund.updated', 'refund.failed') then
    if object_amount is null or object_amount < 0 or upper(coalesce(object_currency, '')) <> acquisition.currency then
      update public.provider_events set processing_error = 'refund_amount_mismatch'
      where provider = 'stripe' and event_id = stripe_event_id;
      return 'ignored';
    end if;
    insert into public.payment_ledger_entries (
      acquisition_id, provider, provider_object_id, kind, amount_minor, currency, status
    ) values (
      acquisition.id, 'stripe', stripe_object_id, 'refund', object_amount, acquisition.currency, object_status
    ) on conflict (provider, provider_object_id) do update
      set status = excluded.status, amount_minor = excluded.amount_minor, currency = excluded.currency;

    select coalesce(sum(amount_minor), 0) into refunded_total
    from public.payment_ledger_entries
    where acquisition_id = acquisition.id and kind = 'refund' and status = 'succeeded';
    if refunded_total >= acquisition.amount_minor + acquisition.tax_minor + acquisition.shipping_minor then
      update public.acquisitions set state = 'refunded', error_code = null where id = acquisition.id;
    end if;
    insert into public.commerce_outbox (topic, dedupe_key, payload)
    values ('finance.refund_recorded', 'stripe-event:' || stripe_event_id, jsonb_build_object('acquisition_id', acquisition.id))
    on conflict do nothing;
  elsif stripe_event_type = 'charge.dispute.created' then
    if acquisition.state <> 'disputed' then
      update public.acquisitions
      set pre_dispute_state = acquisition.state, state = 'disputed', error_code = 'charge.dispute.created'
      where id = acquisition.id;
    end if;
    insert into public.commerce_outbox (topic, dedupe_key, payload)
    values ('finance.dispute_opened', 'stripe-event:' || stripe_event_id, jsonb_build_object('acquisition_id', acquisition.id))
    on conflict do nothing;
  elsif stripe_event_type = 'charge.dispute.closed' then
    update public.acquisitions
    set state = case
          when acquisition.state = 'refunded' then 'refunded'
          when object_status in ('won', 'warning_closed', 'prevented') then coalesce(pre_dispute_state, 'paid')
          when object_status = 'lost' then 'refunded'
          else 'disputed'
        end,
        pre_dispute_state = case when object_status in ('won', 'lost', 'warning_closed', 'prevented') then null else pre_dispute_state end,
        error_code = case
          when acquisition.state = 'refunded' or object_status in ('won', 'warning_closed', 'prevented') then null
          else 'charge.dispute.' || coalesce(object_status, 'unknown')
        end
    where id = acquisition.id;
    insert into public.commerce_outbox (topic, dedupe_key, payload)
    values ('finance.dispute_closed', 'stripe-event:' || stripe_event_id, jsonb_build_object('acquisition_id', acquisition.id, 'status', object_status))
    on conflict do nothing;
  end if;

  insert into public.commerce_audit_log (actor_kind, action, entity_type, entity_id, details)
  values ('provider', stripe_event_type, 'acquisition', acquisition.id::text, jsonb_build_object('event_id', stripe_event_id));
  update public.provider_events set processed_at = now(), processing_error = null
  where provider = 'stripe' and event_id = stripe_event_id;
  return 'processed';
end;
$$;

revoke all on function public.reserve_card_checkout(uuid, uuid, text, text, text, text, integer, timestamptz) from public;
revoke all on function public.attach_card_checkout(uuid, text) from public;
revoke all on function public.release_card_reservation(uuid, text) from public;
revoke all on function public.apply_stripe_checkout_event(text, text, uuid, text, text, text, text, integer, integer, integer, integer, text, text, boolean, text, jsonb) from public;
revoke all on function public.apply_stripe_financial_event(text, text, uuid, text, text, text, integer, text, jsonb) from public;
grant execute on function public.reserve_card_checkout(uuid, uuid, text, text, text, text, integer, timestamptz) to service_role;
grant execute on function public.attach_card_checkout(uuid, text) to service_role;
grant execute on function public.release_card_reservation(uuid, text) to service_role;
grant execute on function public.apply_stripe_checkout_event(text, text, uuid, text, text, text, text, integer, integer, integer, integer, text, text, boolean, text, jsonb) to service_role;
grant execute on function public.apply_stripe_financial_event(text, text, uuid, text, text, text, integer, text, jsonb) to service_role;

commit;

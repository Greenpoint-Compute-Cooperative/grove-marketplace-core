begin;

create table public.product_events (
  id bigint generated always as identity primary key,
  event_name text not null check (event_name in (
    'page_view',
    'discovery_saved',
    'discovery_unsaved',
    'discovery_sponsored',
    'discovery_filter_changed',
    'work_filter_changed',
    'work_viewed',
    'curator_viewed',
    'exhibition_viewed',
    'bazaar_viewed',
    'calendar_saved',
    'join_started',
    'join_unavailable',
    'join_completed',
    'join_cancelled',
    'draft_started',
    'draft_reviewed',
    'acquisition_preview_opened',
    'acquisition_method_changed',
    'client_error'
  )),
  occurred_at timestamptz not null default now(),
  client_timestamp timestamptz,
  session_id uuid not null,
  curator_id uuid references public.curators(id) on delete set null,
  route text not null check (route ~ '^[a-z0-9][a-z0-9/_-]{0,119}$'),
  entity_type text check (entity_type is null or entity_type in ('work', 'curator', 'discovery', 'exhibition', 'bazaar', 'provider')),
  entity_id text check (entity_id is null or char_length(entity_id) <= 160),
  properties jsonb not null default '{}'::jsonb check (
    jsonb_typeof(properties) = 'object'
    and octet_length(properties::text) <= 2048
  )
);

create index product_events_occurred_idx on public.product_events(occurred_at desc);
create index product_events_name_occurred_idx on public.product_events(event_name, occurred_at desc);
create index product_events_session_occurred_idx on public.product_events(session_id, occurred_at desc);
create index product_events_entity_occurred_idx on public.product_events(entity_type, entity_id, occurred_at desc) where entity_id is not null;
create index product_events_curator_occurred_idx on public.product_events(curator_id, occurred_at desc) where curator_id is not null;

alter table public.product_events enable row level security;
revoke all on public.product_events from anon, authenticated;

create or replace function public.record_product_event(
  event_name_input text,
  session_uuid uuid,
  route_input text,
  curator_uuid uuid default null,
  entity_type_input text default null,
  entity_id_input text default null,
  properties_input jsonb default '{}'::jsonb,
  client_timestamp_input timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  event_id bigint;
  recent_events integer;
begin
  select count(*) into recent_events
  from public.product_events
  where session_id = session_uuid
    and occurred_at > now() - interval '1 minute';

  if recent_events >= 60 then
    raise exception 'rate_limit';
  end if;

  insert into public.product_events (
    event_name,
    client_timestamp,
    session_id,
    curator_id,
    route,
    entity_type,
    entity_id,
    properties
  ) values (
    event_name_input,
    client_timestamp_input,
    session_uuid,
    curator_uuid,
    route_input,
    entity_type_input,
    entity_id_input,
    coalesce(properties_input, '{}'::jsonb)
  ) returning id into event_id;

  return event_id;
end;
$$;

create or replace function public.product_metrics_summary(range_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  start_time timestamptz;
  result jsonb;
begin
  if range_days < 1 or range_days > 90 then
    raise exception 'range_days must be between 1 and 90';
  end if;

  start_time := date_trunc('day', now()) - make_interval(days => range_days - 1);

  select jsonb_build_object(
    'range_days', range_days,
    'starts_at', start_time,
    'totals', (
      select jsonb_build_object(
        'events', count(*),
        'sessions', count(distinct session_id),
        'signed_in_curators', count(distinct curator_id)
      )
      from public.product_events
      where occurred_at >= start_time
    ),
    'events', coalesce((
      select jsonb_object_agg(event_name, event_count)
      from (
        select event_name, count(*) event_count
        from public.product_events
        where occurred_at >= start_time
        group by event_name
      ) event_counts
    ), '{}'::jsonb),
    'daily', coalesce((
      select jsonb_agg(to_jsonb(daily_counts) order by event_day)
      from (
        select occurred_at::date as event_day,
               count(*) events,
               count(distinct session_id) sessions,
               count(distinct curator_id) signed_in_curators
        from public.product_events
        where occurred_at >= start_time
        group by occurred_at::date
      ) daily_counts
    ), '[]'::jsonb),
    'top_routes', coalesce((
      select jsonb_agg(to_jsonb(route_counts) order by views desc, route)
      from (
        select route, count(*) views, count(distinct session_id) sessions
        from public.product_events
        where occurred_at >= start_time and event_name = 'page_view'
        group by route
        order by views desc, route
        limit 20
      ) route_counts
    ), '[]'::jsonb),
    'top_works', coalesce((
      select jsonb_agg(to_jsonb(work_counts) order by views desc, acquisition_previews desc, work_id)
      from (
        select entity_id work_id,
               count(*) filter (where event_name = 'work_viewed') views,
               count(*) filter (where event_name = 'acquisition_preview_opened') acquisition_previews,
               count(distinct session_id) sessions
        from public.product_events
        where occurred_at >= start_time
          and entity_type = 'work'
          and event_name in ('work_viewed', 'acquisition_preview_opened')
        group by entity_id
        order by views desc, acquisition_previews desc, entity_id
        limit 20
      ) work_counts
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create or replace function public.prune_product_events(retention_days integer default 180)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_rows bigint;
begin
  if retention_days < 30 or retention_days > 730 then
    raise exception 'retention_days must be between 30 and 730';
  end if;

  delete from public.product_events
  where occurred_at < now() - make_interval(days => retention_days);
  get diagnostics deleted_rows = row_count;
  return deleted_rows;
end;
$$;

revoke all on function public.record_product_event(text, uuid, text, uuid, text, text, jsonb, timestamptz) from public;
revoke all on function public.product_metrics_summary(integer) from public;
revoke all on function public.prune_product_events(integer) from public;
grant execute on function public.record_product_event(text, uuid, text, uuid, text, text, jsonb, timestamptz) to service_role;
grant execute on function public.product_metrics_summary(integer) to service_role;
grant execute on function public.prune_product_events(integer) to service_role;

commit;

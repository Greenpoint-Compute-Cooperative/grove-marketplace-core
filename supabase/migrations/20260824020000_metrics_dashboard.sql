begin;

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
    'engagement', (
      select jsonb_build_object(
        'engaged_sessions', count(*) filter (where event_count >= 3),
        'high_intent_sessions', count(*) filter (where intent_count > 0),
        'error_sessions', count(*) filter (where error_count > 0),
        'average_events_per_session', coalesce(round(avg(event_count), 2), 0)
      )
      from (
        select session_id,
               count(*)::numeric event_count,
               count(*) filter (where event_name in (
                 'discovery_saved', 'discovery_sponsored', 'draft_reviewed',
                 'join_started', 'acquisition_preview_opened', 'calendar_saved'
               )) intent_count,
               count(*) filter (where event_name = 'client_error') error_count
        from public.product_events
        where occurred_at >= start_time
        group by session_id
      ) session_counts
    ),
    'funnels', jsonb_build_object(
      'curator', (
        select jsonb_build_object(
          'discover_sessions', count(distinct session_id) filter (where event_name = 'page_view' and route = 'discover'),
          'save_sessions', count(distinct session_id) filter (where event_name = 'discovery_saved'),
          'sponsor_sessions', count(distinct session_id) filter (where event_name = 'discovery_sponsored'),
          'draft_sessions', count(distinct session_id) filter (where event_name = 'draft_started'),
          'review_sessions', count(distinct session_id) filter (where event_name = 'draft_reviewed')
        )
        from public.product_events
        where occurred_at >= start_time
      ),
      'membership', (
        select jsonb_build_object(
          'join_sessions', count(distinct session_id) filter (where event_name = 'page_view' and route = 'join'),
          'start_sessions', count(distinct session_id) filter (where event_name = 'join_started'),
          'complete_sessions', count(distinct session_id) filter (where event_name = 'join_completed'),
          'cancel_sessions', count(distinct session_id) filter (where event_name = 'join_cancelled'),
          'unavailable_sessions', count(distinct session_id) filter (where event_name = 'join_unavailable')
        )
        from public.product_events
        where occurred_at >= start_time
      ),
      'collection', (
        select jsonb_build_object(
          'market_sessions', count(distinct session_id) filter (where event_name = 'page_view' and route = 'market'),
          'work_sessions', count(distinct session_id) filter (where event_name = 'work_viewed'),
          'preview_sessions', count(distinct session_id) filter (where event_name = 'acquisition_preview_opened')
        )
        from public.product_events
        where occurred_at >= start_time
      ),
      'bazaar', (
        select jsonb_build_object(
          'view_sessions', count(distinct session_id) filter (where event_name = 'bazaar_viewed'),
          'calendar_sessions', count(distinct session_id) filter (where event_name = 'calendar_saved')
        )
        from public.product_events
        where occurred_at >= start_time
      )
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
               count(distinct curator_id) signed_in_curators,
               count(distinct session_id) filter (where event_name = 'client_error') error_sessions
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
    ), '[]'::jsonb),
    'breakdowns', jsonb_build_object(
      'work_formats', coalesce((
        select jsonb_agg(to_jsonb(format_counts) order by events desc, dimension_value)
        from (
          select properties ->> 'format' dimension_value,
                 count(*) events,
                 count(distinct session_id) sessions
          from public.product_events
          where occurred_at >= start_time and event_name = 'work_viewed' and properties ? 'format'
          group by properties ->> 'format'
        ) format_counts
      ), '[]'::jsonb),
      'acquisition_methods', coalesce((
        select jsonb_agg(to_jsonb(method_counts) order by events desc, dimension_value)
        from (
          select properties ->> 'method' dimension_value,
                 count(*) events,
                 count(distinct session_id) sessions
          from public.product_events
          where occurred_at >= start_time
            and event_name in ('acquisition_preview_opened', 'acquisition_method_changed')
            and properties ? 'method'
          group by properties ->> 'method'
        ) method_counts
      ), '[]'::jsonb),
      'join_providers', coalesce((
        select jsonb_agg(to_jsonb(provider_counts) order by events desc, dimension_value)
        from (
          select coalesce(properties ->> 'provider', entity_id) dimension_value,
                 count(*) events,
                 count(distinct session_id) sessions
          from public.product_events
          where occurred_at >= start_time
            and event_name in ('join_started', 'join_unavailable', 'join_completed')
            and coalesce(properties ->> 'provider', entity_id) is not null
          group by coalesce(properties ->> 'provider', entity_id)
        ) provider_counts
      ), '[]'::jsonb),
      'draft_formats', coalesce((
        select jsonb_agg(to_jsonb(format_counts) order by events desc, dimension_value)
        from (
          select properties ->> 'format' dimension_value,
                 count(*) events,
                 count(distinct session_id) sessions
          from public.product_events
          where occurred_at >= start_time and event_name = 'draft_reviewed' and properties ? 'format'
          group by properties ->> 'format'
        ) format_counts
      ), '[]'::jsonb),
      'client_errors', coalesce((
        select jsonb_agg(to_jsonb(error_counts) order by events desc, dimension_value)
        from (
          select coalesce(properties ->> 'kind', 'unknown') dimension_value,
                 count(*) events,
                 count(distinct session_id) sessions
          from public.product_events
          where occurred_at >= start_time and event_name = 'client_error'
          group by coalesce(properties ->> 'kind', 'unknown')
        ) error_counts
      ), '[]'::jsonb)
    ),
    'operations', jsonb_build_object(
      'curators', coalesce((select jsonb_object_agg(status, item_count) from (select status, count(*) item_count from public.curators group by status) counts), '{}'::jsonb),
      'discoveries', coalesce((select jsonb_object_agg(status, item_count) from (select status, count(*) item_count from public.discoveries group by status) counts), '{}'::jsonb),
      'sponsorships', coalesce((select jsonb_object_agg(status, item_count) from (select status, count(*) item_count from public.sponsorships group by status) counts), '{}'::jsonb),
      'works', coalesce((select jsonb_object_agg(status, item_count) from (select status, count(*) item_count from public.works group by status) counts), '{}'::jsonb),
      'acquisitions', coalesce((select jsonb_object_agg(state, item_count) from (select state, count(*) item_count from public.acquisitions group by state) counts), '{}'::jsonb),
      'bazaars', coalesce((select jsonb_object_agg(status, item_count) from (select status, count(*) item_count from public.bazaar_events group by status) counts), '{}'::jsonb)
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.product_metrics_summary(integer) from public;
grant execute on function public.product_metrics_summary(integer) to service_role;

commit;

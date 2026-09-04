begin;

-- Display media is normalized before publication. Provider URLs and raw social
-- payloads remain private; only rights-cleared, content-addressed files may be
-- exposed to the storefront image optimizer.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'marketplace-media',
  'marketplace-media',
  true,
  26214400,
  array['image/avif', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.media_assets (
  id uuid primary key default extensions.gen_random_uuid(),
  content_sha256 text not null unique check (content_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text unique check (
    storage_path is null
    or storage_path ~ '^sha256/[0-9a-f]{64}/[a-z0-9][a-z0-9._/-]*\.(avif|jpe?g|png|webp)$'
  ),
  canonical_uri text check (
    canonical_uri is null or (char_length(canonical_uri) <= 2000 and canonical_uri ~ '^ipfs://')
  ),
  source_provider text not null default 'direct'
    check (source_provider in ('direct', 'instagram', 'x', 'ipfs')),
  source_reference text check (source_reference is null or char_length(source_reference) <= 2000),
  mime_type text not null check (mime_type in ('image/avif', 'image/jpeg', 'image/png', 'image/webp')),
  byte_length bigint not null check (byte_length between 1 and 26214400),
  width integer not null check (width between 1 and 10000),
  height integer not null check (height between 1 and 10000),
  placeholder text check (placeholder is null or char_length(placeholder) <= 500),
  rights_state text not null default 'unverified'
    check (rights_state in ('unverified', 'permission-requested', 'cleared', 'restricted')),
  moderation_state text not null default 'pending'
    check (moderation_state in ('pending', 'approved', 'blocked')),
  publication_state text not null default 'quarantined'
    check (publication_state in ('quarantined', 'verified', 'published', 'blocked', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (width::bigint * height::bigint <= 50000000),
  check (
    publication_state <> 'published'
    or (storage_path is not null and rights_state = 'cleared' and moderation_state = 'approved')
  )
);

alter table public.works
  add column media_asset_id uuid references public.media_assets(id) on delete restrict,
  add column media_width integer check (media_width is null or media_width between 1 and 10000),
  add column media_height integer check (media_height is null or media_height between 1 and 10000),
  add constraint works_media_dimensions_complete check (
    (media_width is null and media_height is null)
    or (media_width is not null and media_height is not null
      and media_width::bigint * media_height::bigint <= 50000000)
  );

update public.works set media_width = 1536, media_height = 1024
where media_url ~ '/(digital|physical)-works\.jpg$' and media_width is null;
update public.works set media_width = 1717, media_height = 916
where media_url ~ '/celestial-school\.svg$' and media_width is null;
update public.works set media_width = 1254, media_height = 1254
where media_url ~ '/school-seed\.svg$' and media_width is null;

create trigger media_assets_updated_at before update on public.media_assets
for each row execute function public.set_updated_at();

create or replace function public.protect_published_media_asset()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.publication_state = 'published' and (
    new.content_sha256 <> old.content_sha256
    or new.storage_path is distinct from old.storage_path
    or new.canonical_uri is distinct from old.canonical_uri
    or new.mime_type <> old.mime_type
    or new.byte_length <> old.byte_length
    or new.width <> old.width
    or new.height <> old.height
  ) then raise exception 'published_media_identity_immutable'; end if;
  return new;
end;
$$;

create trigger protect_published_media_asset_before_update
before update on public.media_assets for each row
execute function public.protect_published_media_asset();

-- Instagram bot credentials are intentionally not stored here. This durable
-- inbox accepts only signed provider webhooks after the separate bot gate is on.
create table public.social_event_inbox (
  id bigint generated always as identity primary key,
  provider text not null check (provider = 'instagram'),
  environment text not null check (environment in ('development', 'preview', 'staging', 'production')),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 240),
  professional_account_id text not null check (char_length(professional_account_id) between 1 and 160),
  sender_id text check (sender_id is null or char_length(sender_id) <= 160),
  event_type text not null check (char_length(event_type) between 1 and 120),
  provider_timestamp timestamptz,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 32768
  ),
  state text not null default 'received'
    check (state in ('received', 'processing', 'processed', 'retry', 'dead-letter')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  leased_until timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, environment, provider_event_id),
  check ((state = 'processed' and processed_at is not null) or (state <> 'processed'))
);

create index social_event_inbox_work_idx
  on public.social_event_inbox(state, received_at)
  where state in ('received', 'retry');

create or replace function public.protect_social_event_evidence()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.provider <> old.provider or new.environment <> old.environment
     or new.provider_event_id <> old.provider_event_id
     or new.professional_account_id <> old.professional_account_id
     or new.sender_id is distinct from old.sender_id
     or new.event_type <> old.event_type
     or new.provider_timestamp is distinct from old.provider_timestamp
     or new.payload_hash <> old.payload_hash or new.payload <> old.payload
     or new.received_at <> old.received_at then
    raise exception 'social_event_evidence_immutable';
  end if;
  return new;
end;
$$;

create trigger protect_social_event_evidence_before_update
before update on public.social_event_inbox for each row
execute function public.protect_social_event_evidence();

create table public.social_sender_links (
  id uuid primary key default extensions.gen_random_uuid(),
  curator_id uuid not null references public.curators(id) on delete cascade,
  provider text not null check (provider = 'instagram'),
  professional_account_id text not null check (char_length(professional_account_id) between 1 and 160),
  sender_id text not null check (char_length(sender_id) between 1 and 160),
  state text not null default 'pending' check (state in ('pending', 'active', 'revoked')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, professional_account_id, sender_id),
  check ((state = 'active' and verified_at is not null) or state <> 'active')
);

create trigger social_sender_links_updated_at before update on public.social_sender_links
for each row execute function public.set_updated_at();

create table public.discovery_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  discovery_id uuid not null references public.discoveries(id) on delete cascade,
  social_event_id bigint references public.social_event_inbox(id) on delete restrict,
  provider text not null check (provider in ('instagram', 'x', 'web', 'direct')),
  provider_object_id text check (provider_object_id is null or char_length(provider_object_id) <= 240),
  canonical_permalink text check (
    canonical_permalink is null or (char_length(canonical_permalink) <= 2000 and canonical_permalink ~ '^https://')
  ),
  media_asset_id uuid references public.media_assets(id) on delete restrict,
  consent_evidence jsonb not null default '{}'::jsonb check (
    jsonb_typeof(consent_evidence) = 'object' and octet_length(consent_evidence::text) <= 4096
  ),
  created_at timestamptz not null default now(),
  unique nulls not distinct (provider, provider_object_id, discovery_id)
);

-- Worker history makes stale projections observable without exposing raw chain,
-- wallet, or social records to the public stats endpoint.
create table public.indexer_worker_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  worker_name text not null check (char_length(worker_name) between 1 and 120),
  chain_id bigint not null check (chain_id in (1, 11155111)),
  deployment_sha text check (deployment_sha is null or deployment_sha ~ '^[0-9a-f]{7,64}$'),
  state text not null check (state in ('running', 'succeeded', 'failed', 'locked')),
  caught_up boolean not null default false,
  indexed_through_block bigint check (indexed_through_block is null or indexed_through_block >= 0),
  observed_finalized_block bigint check (observed_finalized_block is null or observed_finalized_block >= 0),
  observed_finalized_hash text check (observed_finalized_hash is null or observed_finalized_hash ~ '^0x[0-9a-f]{64}$'),
  counters jsonb not null default '{}'::jsonb check (
    jsonb_typeof(counters) = 'object' and octet_length(counters::text) <= 4096
  ),
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,80}$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((state = 'running' and finished_at is null) or (state <> 'running' and finished_at is not null))
);

create index indexer_worker_runs_latest_idx
  on public.indexer_worker_runs(worker_name, chain_id, started_at desc);

create or replace function public.protect_indexer_worker_run()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.state <> 'running' then raise exception 'terminal_indexer_run_immutable'; end if;
  if new.worker_name <> old.worker_name or new.chain_id <> old.chain_id
     or new.deployment_sha is distinct from old.deployment_sha
     or new.started_at <> old.started_at then
    raise exception 'indexer_run_identity_immutable';
  end if;
  return new;
end;
$$;

create trigger protect_indexer_worker_run_before_update
before update on public.indexer_worker_runs for each row
execute function public.protect_indexer_worker_run();

create table public.market_stats_current (
  chain_id bigint primary key check (chain_id in (1, 11155111)),
  state text not null check (state in ('ready', 'syncing')),
  source_worker_run_id uuid not null references public.indexer_worker_runs(id) on delete restrict,
  indexed_through_block bigint not null check (indexed_through_block >= 0),
  indexed_through_hash text not null check (indexed_through_hash ~ '^0x[0-9a-f]{64}$'),
  stats jsonb not null check (jsonb_typeof(stats) = 'object' and octet_length(stats::text) <= 32768),
  schema_version text not null default 'market-stats-v1' check (schema_version = 'market-stats-v1'),
  computed_at timestamptz not null default now()
);

create or replace function public.refresh_market_stats_current(
  p_chain_id bigint,
  p_source_worker_run_id uuid
)
returns public.market_stats_current
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_run public.indexer_worker_runs%rowtype;
  selected_checkpoint public.chain_indexer_checkpoints%rowtype;
  registered_tokens integer;
  projected_tokens integer;
  holder_addresses integer;
  active_listings integer;
  lowest_ask text;
  primary_sales integer;
  primary_volume jsonb;
  secondary_sales integer;
  secondary_volume jsonb;
  published_works integer;
  open_auctions integer;
  snapshot_state text;
  result public.market_stats_current%rowtype;
begin
  if p_chain_id not in (1, 11155111) then raise exception 'market_stats_chain_invalid'; end if;
  select * into selected_run from public.indexer_worker_runs where id = p_source_worker_run_id;
  if selected_run.id is null or selected_run.worker_name <> 'resale-finalized-v2'
     or selected_run.chain_id <> p_chain_id or selected_run.state <> 'succeeded'
     or not selected_run.caught_up or selected_run.observed_finalized_block is null
     or selected_run.observed_finalized_hash is null then
    raise exception 'market_stats_source_run_invalid';
  end if;
  select * into selected_checkpoint from public.chain_indexer_checkpoints
  where worker_name = selected_run.worker_name and chain_id = p_chain_id
  order by through_block_number desc, id desc limit 1;
  if selected_checkpoint.id is null
     or selected_checkpoint.through_block_number <> selected_run.observed_finalized_block
     or selected_checkpoint.through_block_hash <> selected_run.observed_finalized_hash then
    raise exception 'market_stats_checkpoint_mismatch';
  end if;

  select count(*)::integer into published_works
  from public.works where status in ('listed', 'reserved', 'sold');
  select count(*)::integer into registered_tokens
  from public.works w join public.nft_collections c on c.id = w.nft_collection_id
  where c.chain_id = p_chain_id and c.standard = 'ERC721'
    and w.format = 'digital' and w.contract_status = 'minted';
  select count(*)::integer into projected_tokens
  from public.token_ownership_projection p
  where p.chain_id = p_chain_id and p.finality = 'finalized';
  select count(distinct p.owner_address)::integer into holder_addresses
  from public.token_ownership_projection p
  join public.nft_collections c on c.id = p.collection_id
  where p.chain_id = p_chain_id and p.finality = 'finalized'
    and p.ownership_state = 'owned' and p.owner_address <> c.inventory_safe;

  select count(*)::integer into open_auctions
  from public.auctions a
  join public.works w on w.id = a.work_id
  join public.nft_collections c on c.id = w.nft_collection_id
  where c.chain_id = p_chain_id and a.state = 'open';
  select count(*)::integer into primary_sales
  from public.auction_settlements s
  join public.chain_deliveries d on d.settlement_id = s.id and d.state = 'finalized'
  join public.auctions a on a.id = s.auction_id
  join public.works w on w.id = a.work_id
  join public.nft_collections c on c.id = w.nft_collection_id
  where c.chain_id = p_chain_id;
  select coalesce(jsonb_object_agg(currency, amount), '{}'::jsonb) into primary_volume
  from (
    select s.currency, sum(s.hammer_amount)::text amount
    from public.auction_settlements s
    join public.chain_deliveries d on d.settlement_id = s.id and d.state = 'finalized'
    join public.auctions a on a.id = s.auction_id
    join public.works w on w.id = a.work_id
    join public.nft_collections c on c.id = w.nft_collection_id
    where c.chain_id = p_chain_id group by s.currency
  ) totals;

  select count(*)::integer, min(o.gross_amount)::text into active_listings, lowest_ask
  from public.resale_orders o
  join public.token_ownership_projection p
    on p.chain_id = o.chain_id and p.collection_address = o.collection_address
      and p.token_id = o.token_id and p.owner_address = o.seller_address
      and p.finality = 'finalized' and p.ownership_state = 'owned'
  where o.chain_id = p_chain_id and o.state = 'open'
    and o.end_time_epoch > extract(epoch from now())::bigint;
  select count(*)::integer into secondary_sales
  from public.resale_fills f join public.resale_orders o on o.id = f.resale_order_id
  where o.chain_id = p_chain_id and f.state = 'finalized';
  select coalesce(jsonb_object_agg(currency, amount), '{}'::jsonb) into secondary_volume
  from (
    select f.currency, sum(f.amount)::text amount
    from public.resale_fills f join public.resale_orders o on o.id = f.resale_order_id
    where o.chain_id = p_chain_id and f.state = 'finalized' group by f.currency
  ) totals;

  snapshot_state := case when registered_tokens = projected_tokens then 'ready' else 'syncing' end;
  insert into public.market_stats_current (
    chain_id, state, source_worker_run_id, indexed_through_block,
    indexed_through_hash, stats, computed_at
  ) values (
    p_chain_id, snapshot_state, selected_run.id, selected_checkpoint.through_block_number,
    selected_checkpoint.through_block_hash,
    jsonb_build_object(
      'catalog', jsonb_build_object('published_works', published_works, 'minted_erc721_works', registered_tokens),
      'ownership', jsonb_build_object(
        'indexed_tokens', projected_tokens,
        'holder_addresses_excluding_inventory', holder_addresses,
        'coverage_complete', registered_tokens = projected_tokens
      ),
      'auctions', jsonb_build_object(
        'open', open_auctions, 'finalized_sales', primary_sales,
        'volume_by_currency_base_units', primary_volume
      ),
      'secondary', jsonb_build_object(
        'active_listings', active_listings,
        'lowest_ask', case when lowest_ask is null then null else jsonb_build_object('amount', lowest_ask, 'currency', 'USDC', 'decimals', 6) end,
        'finalized_sales', secondary_sales,
        'volume_by_currency_base_units', secondary_volume
      )
    ), now()
  )
  on conflict (chain_id) do update set
    state = excluded.state,
    source_worker_run_id = excluded.source_worker_run_id,
    indexed_through_block = excluded.indexed_through_block,
    indexed_through_hash = excluded.indexed_through_hash,
    stats = excluded.stats,
    schema_version = excluded.schema_version,
    computed_at = excluded.computed_at
  returning * into result;
  return result;
end;
$$;

alter table public.media_assets enable row level security;
alter table public.social_event_inbox enable row level security;
alter table public.social_sender_links enable row level security;
alter table public.discovery_sources enable row level security;
alter table public.indexer_worker_runs enable row level security;
alter table public.market_stats_current enable row level security;

revoke all on public.media_assets, public.social_event_inbox, public.social_sender_links,
  public.discovery_sources, public.indexer_worker_runs, public.market_stats_current
  from public, anon, authenticated;
grant all on public.media_assets, public.social_event_inbox, public.social_sender_links,
  public.discovery_sources, public.indexer_worker_runs, public.market_stats_current
  to service_role;
grant usage, select on sequence public.social_event_inbox_id_seq to service_role;

revoke all on function public.refresh_market_stats_current(bigint, uuid) from public;
grant execute on function public.refresh_market_stats_current(bigint, uuid) to service_role;

commit;

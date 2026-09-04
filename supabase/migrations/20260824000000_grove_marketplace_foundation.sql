begin;

create extension if not exists pgcrypto with schema extensions;

create table public.curators (
  id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider in ('instagram', 'x')),
  provider_subject text not null,
  display_name text not null check (char_length(display_name) between 1 and 160),
  handle text check (handle is null or char_length(handle) <= 80),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2000),
  bio text check (bio is null or char_length(bio) <= 500),
  focus text check (focus is null or char_length(focus) <= 240),
  status text not null default 'active' check (status in ('active', 'pending', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.discoveries (
  id uuid primary key default extensions.gen_random_uuid(),
  curator_id uuid not null references public.curators(id) on delete cascade,
  source_url text not null check (char_length(source_url) <= 2000),
  source_provider text not null default 'web' check (source_provider in ('instagram', 'x', 'web', 'direct')),
  artist_name text check (artist_name is null or char_length(artist_name) <= 160),
  work_title text check (work_title is null or char_length(work_title) <= 240),
  thumbnail_url text check (thumbnail_url is null or char_length(thumbnail_url) <= 2000),
  note text check (note is null or char_length(note) <= 1200),
  status text not null default 'new' check (status in ('new', 'saved', 'sponsored', 'archived')),
  rights_status text not null default 'unverified' check (rights_status in ('unverified', 'permission-requested', 'cleared', 'restricted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index discoveries_curator_created_idx on public.discoveries(curator_id, created_at desc);

create table public.sponsorships (
  id uuid primary key default extensions.gen_random_uuid(),
  curator_id uuid not null references public.curators(id) on delete cascade,
  discovery_id uuid not null references public.discoveries(id) on delete cascade,
  recommendation text check (recommendation is null or char_length(recommendation) <= 1200),
  status text not null default 'submitted' check (status in ('draft', 'submitted', 'accepted', 'declined', 'withdrawn')),
  rights_status text not null default 'unverified' check (rights_status in ('unverified', 'permission-requested', 'cleared', 'restricted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (curator_id, discovery_id)
);

create table public.works (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  curator_id uuid references public.curators(id) on delete set null,
  sponsorship_id uuid unique references public.sponsorships(id) on delete set null,
  artist_name text not null check (char_length(artist_name) between 1 and 160),
  title text not null check (char_length(title) between 1 and 240),
  description text check (description is null or char_length(description) <= 2400),
  format text not null check (format in ('physical', 'digital', 'paired')),
  media_url text not null check (char_length(media_url) <= 2000),
  price_minor integer check (price_minor is null or price_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  crypto_amount numeric(30, 12) check (crypto_amount is null or crypto_amount >= 0),
  crypto_asset text check (crypto_asset is null or char_length(crypto_asset) <= 20),
  chain text check (chain is null or char_length(chain) <= 60),
  contract_address text check (contract_address is null or char_length(contract_address) <= 160),
  token_id text check (token_id is null or char_length(token_id) <= 160),
  contract_status text not null default 'not-configured' check (contract_status in ('not-configured', 'review', 'verified', 'mint-ready', 'minted')),
  location text check (location is null or char_length(location) <= 240),
  status text not null default 'draft' check (status in ('draft', 'listed', 'reserved', 'sold', 'archived')),
  listed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index works_status_listed_idx on public.works(status, listed_at desc);

create table public.bazaar_events (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (char_length(title) between 1 and 240),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  venue text not null check (char_length(venue) <= 240),
  address text not null check (char_length(address) <= 500),
  city text not null default 'New York' check (char_length(city) <= 120),
  summary text check (summary is null or char_length(summary) <= 1200),
  status text not null default 'draft' check (status in ('draft', 'published', 'complete', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bazaar_status_start_idx on public.bazaar_events(status, starts_at);

create table public.acquisitions (
  id uuid primary key default extensions.gen_random_uuid(),
  work_id uuid not null references public.works(id) on delete restrict,
  buyer_user_id uuid references auth.users(id) on delete set null,
  method text not null check (method in ('crypto', 'card')),
  state text not null default 'created' check (state in ('created', 'checkout-pending', 'onchain-pending', 'paid', 'fulfilled', 'cancelled', 'refunded')),
  provider_ref text check (provider_ref is null or char_length(provider_ref) <= 240),
  wallet_address text check (wallet_address is null or char_length(wallet_address) <= 160),
  amount_minor integer check (amount_minor is null or amount_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  crypto_amount numeric(30, 12) check (crypto_amount is null or crypto_amount >= 0),
  crypto_asset text check (crypto_asset is null or char_length(crypto_asset) <= 20),
  chain text check (chain is null or char_length(chain) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index acquisitions_provider_ref_idx on public.acquisitions(provider_ref) where provider_ref is not null;
create index acquisitions_buyer_created_idx on public.acquisitions(buyer_user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger curators_updated_at before update on public.curators for each row execute function public.set_updated_at();
create trigger discoveries_updated_at before update on public.discoveries for each row execute function public.set_updated_at();
create trigger sponsorships_updated_at before update on public.sponsorships for each row execute function public.set_updated_at();
create trigger works_updated_at before update on public.works for each row execute function public.set_updated_at();
create trigger bazaar_events_updated_at before update on public.bazaar_events for each row execute function public.set_updated_at();
create trigger acquisitions_updated_at before update on public.acquisitions for each row execute function public.set_updated_at();

create or replace function public.initialize_curator_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  metadata jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  source_provider text := lower(coalesce(new.raw_app_meta_data ->> 'provider', metadata ->> 'provider', ''));
  normalized_provider text;
  imported_name text;
  imported_handle text;
  imported_avatar text;
begin
  normalized_provider := case
    when source_provider like '%instagram%' then 'instagram'
    when source_provider in ('twitter', 'x') or source_provider like '%twitter%' then 'x'
    else null
  end;

  -- Email, phone, tokens, and credentials are deliberately not copied into public.curators.
  if normalized_provider is null then return new; end if;

  imported_name := nullif(left(coalesce(
    metadata ->> 'full_name',
    metadata ->> 'name',
    metadata ->> 'display_name',
    metadata ->> 'preferred_username',
    metadata ->> 'user_name',
    metadata ->> 'username',
    'Curator'
  ), 160), '');
  imported_handle := nullif(left(ltrim(coalesce(
    metadata ->> 'preferred_username',
    metadata ->> 'user_name',
    metadata ->> 'username',
    ''
  ), '@'), 80), '');
  imported_avatar := nullif(left(coalesce(
    metadata ->> 'avatar_url',
    metadata ->> 'picture',
    metadata ->> 'profile_image_url',
    metadata ->> 'profile_picture_url',
    ''
  ), 2000), '');

  insert into public.curators (id, provider, provider_subject, display_name, handle, avatar_url)
  values (
    new.id,
    normalized_provider,
    coalesce(metadata ->> 'provider_id', metadata ->> 'sub', new.id::text),
    coalesce(imported_name, 'Curator'),
    imported_handle,
    imported_avatar
  )
  on conflict (id) do update set
    display_name = excluded.display_name,
    handle = excluded.handle,
    avatar_url = excluded.avatar_url,
    updated_at = now();

  return new;
end;
$$;

create trigger initialize_curator_after_auth
after insert or update of raw_user_meta_data, raw_app_meta_data on auth.users
for each row execute function public.initialize_curator_profile();

create or replace function public.sponsor_discovery(discovery_uuid uuid, recommendation_text text default null)
returns public.sponsorships
language plpgsql
security invoker
set search_path = public
as $$
declare
  result public.sponsorships;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if recommendation_text is not null and char_length(recommendation_text) > 1200 then raise exception 'recommendation too long'; end if;

  insert into public.sponsorships (curator_id, discovery_id, recommendation)
  select auth.uid(), discovery_uuid, recommendation_text
  from public.discoveries
  where id = discovery_uuid and curator_id = auth.uid()
  on conflict (curator_id, discovery_id) do update
    set recommendation = excluded.recommendation,
        updated_at = now()
  returning * into result;

  if result.id is null then raise exception 'discovery unavailable'; end if;
  update public.discoveries set status = 'sponsored' where id = discovery_uuid and curator_id = auth.uid();
  return result;
end;
$$;

alter table public.curators enable row level security;
alter table public.discoveries enable row level security;
alter table public.sponsorships enable row level security;
alter table public.works enable row level security;
alter table public.bazaar_events enable row level security;
alter table public.acquisitions enable row level security;

create policy "active curator profiles are public" on public.curators for select to anon, authenticated using (status = 'active');
create policy "curators can read their profile" on public.curators for select to authenticated using (id = auth.uid());
create policy "curators can update their profile" on public.curators for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "curators own discoveries" on public.discoveries for all to authenticated using (curator_id = auth.uid()) with check (curator_id = auth.uid());

create policy "accepted sponsorships are public" on public.sponsorships for select to anon, authenticated using (status = 'accepted');
create policy "curators read their sponsorships" on public.sponsorships for select to authenticated using (curator_id = auth.uid());
create policy "curators add sponsorships" on public.sponsorships for insert to authenticated with check (curator_id = auth.uid());
create policy "curators revise their sponsorships" on public.sponsorships for update to authenticated using (curator_id = auth.uid()) with check (curator_id = auth.uid());

create policy "listed works are public" on public.works for select to anon, authenticated using (status in ('listed', 'reserved', 'sold'));
create policy "curators see sponsored drafts" on public.works for select to authenticated using (curator_id = auth.uid());

create policy "published bazaars are public" on public.bazaar_events for select to anon, authenticated using (status in ('published', 'complete'));

create policy "buyers read their acquisitions" on public.acquisitions for select to authenticated using (buyer_user_id = auth.uid());

revoke all on public.curators, public.discoveries, public.sponsorships, public.works, public.bazaar_events, public.acquisitions from anon, authenticated;

grant select (id, provider, display_name, handle, avatar_url, bio, focus, status, created_at, updated_at) on public.curators to anon, authenticated;
grant select on public.works, public.bazaar_events to anon, authenticated;
grant update (display_name, handle, avatar_url, bio, focus) on public.curators to authenticated;

grant select, delete on public.discoveries to authenticated;
grant insert (curator_id, source_url, source_provider, artist_name, work_title, thumbnail_url, note, status) on public.discoveries to authenticated;
grant update (source_url, source_provider, artist_name, work_title, thumbnail_url, note, status) on public.discoveries to authenticated;

grant select on public.sponsorships to anon, authenticated;
grant insert (curator_id, discovery_id, recommendation) on public.sponsorships to authenticated;
grant update (recommendation) on public.sponsorships to authenticated;

grant select on public.acquisitions to authenticated;
revoke all on function public.sponsor_discovery(uuid, text) from public;
grant execute on function public.sponsor_discovery(uuid, text) to authenticated;

commit;

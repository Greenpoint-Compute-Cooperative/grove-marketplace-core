begin;

-- OpenSea publication is an at-least-once side effect. A short lease plus
-- row-level SKIP LOCKED claiming prevents concurrent workers from publishing
-- the same order while still allowing a crashed worker to be recovered.
alter table public.resale_order_publications
  add column lease_token uuid,
  add column lease_expires_at timestamptz;

alter table public.resale_order_publications
  drop constraint if exists resale_order_publications_state_check,
  drop constraint if exists resale_order_publications_check;

alter table public.resale_order_publications
  add constraint resale_order_publications_state_check
    check (state in ('pending', 'processing', 'published', 'retry', 'failed')),
  add constraint resale_order_publications_state_coherence_check check (
    (state = 'pending' and attempt_count = 0 and last_attempt_at is null
      and next_attempt_at is null and published_at is null
      and provider_order_hash is null and last_error_code is null
      and last_error_detail is null and lease_token is null and lease_expires_at is null)
    or
    (state = 'processing' and attempt_count > 0 and last_attempt_at is not null
      and next_attempt_at is null and published_at is null
      and lease_token is not null and lease_expires_at is not null)
    or
    (state = 'published' and attempt_count > 0 and last_attempt_at is not null
      and published_at is not null and provider_order_hash is not null
      and next_attempt_at is null and last_error_code is null
      and last_error_detail is null and lease_token is null and lease_expires_at is null)
    or
    (state = 'retry' and attempt_count > 0 and last_attempt_at is not null
      and next_attempt_at is not null and published_at is null
      and last_error_code is not null and lease_token is null and lease_expires_at is null)
    or
    (state = 'failed' and attempt_count > 0 and last_attempt_at is not null
      and next_attempt_at is null and published_at is null
      and last_error_code is not null and lease_token is null and lease_expires_at is null)
  );

create or replace function public.protect_resale_order_publication()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'pending' then
      raise exception 'resale_publication_must_start_pending';
    end if;
    return new;
  end if;
  if new.resale_order_id <> old.resale_order_id
     or new.provider <> old.provider
     or new.created_at <> old.created_at then
    raise exception 'resale_publication_identity_immutable';
  end if;
  if old.state = 'published' and new is distinct from old then
    raise exception 'resale_publication_final';
  end if;
  if not (
    new.state = old.state
    or (old.state in ('pending', 'retry') and new.state = 'processing')
    or (old.state = 'processing' and new.state in ('published', 'retry', 'failed'))
    or (old.state = 'failed' and new.state = 'retry')
  ) then
    raise exception 'resale_publication_state_transition_invalid';
  end if;
  if new.attempt_count < old.attempt_count then
    raise exception 'resale_publication_attempt_count_regressed';
  end if;
  if old.provider_order_hash is not null
     and new.provider_order_hash is distinct from old.provider_order_hash then
    raise exception 'resale_publication_provider_hash_immutable';
  end if;
  return new;
end;
$$;

create or replace function public.claim_opensea_publications(
  p_limit integer default 10,
  p_lease_seconds integer default 90
)
returns setof public.resale_order_publications
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_limit < 1 or p_limit > 25 or p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'invalid_opensea_claim_parameters';
  end if;

  return query
  with candidates as (
    select p.id
    from public.resale_order_publications p
    where p.provider = 'opensea'
      and (
        p.state = 'pending'
        or (p.state = 'retry' and p.next_attempt_at <= now())
        or (p.state = 'processing' and p.lease_expires_at <= now())
      )
    order by p.created_at, p.id
    for update skip locked
    limit p_limit
  )
  update public.resale_order_publications p
  set state = 'processing',
      attempt_count = p.attempt_count + 1,
      last_attempt_at = now(),
      next_attempt_at = null,
      last_error_code = null,
      last_error_detail = null,
      lease_token = extensions.gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  from candidates c
  where p.id = c.id
  returning p.*;
end;
$$;

revoke all on function public.claim_opensea_publications(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_opensea_publications(integer, integer)
  to service_role;

commit;

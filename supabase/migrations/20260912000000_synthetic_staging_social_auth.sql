begin;

-- Synthetic identities are a staging-only exception used to exercise the normal
-- authenticated auction boundary before external social-provider credentials
-- exist. They are visibly synthetic and never create wallet links or signing
-- authority. Browser roles cannot create curator rows.
alter table public.curators drop constraint if exists curators_provider_check;
alter table public.curators add constraint curators_provider_check
  check (provider in ('instagram', 'x', 'synthetic'));
create unique index curators_one_synthetic_subject_idx
  on public.curators(provider_subject)
  where provider = 'synthetic';

create table public.synthetic_social_auth_tickets (
  id uuid primary key,
  environment text not null check (environment = 'staging'),
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  provider_subject text not null check (provider_subject ~ '^synthetic:staging:[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  session_established_at timestamptz,
  evidence jsonb not null check (
    jsonb_typeof(evidence) = 'object'
    and octet_length(evidence::text) <= 2048
    and evidence ->> 'wallet_authority' = 'false'
  ),
  created_at timestamptz not null default now(),
  check (expires_at > issued_at and expires_at <= issued_at + interval '5 minutes'),
  check (session_established_at is null or consumed_at is not null)
);

create index synthetic_social_auth_ticket_expiry_idx
  on public.synthetic_social_auth_tickets(expires_at)
  where consumed_at is null;

create table public.synthetic_social_auth_audit (
  id bigint generated always as identity primary key,
  ticket_id uuid references public.synthetic_social_auth_tickets(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in (
    'identity.created', 'identity.linked', 'ticket.issued',
    'ticket.consumed', 'session.established'
  )),
  evidence jsonb not null check (
    jsonb_typeof(evidence) = 'object'
    and octet_length(evidence::text) <= 2048
    and evidence ->> 'wallet_authority' = 'false'
  ),
  occurred_at timestamptz not null default now()
);

create index synthetic_social_auth_audit_user_idx
  on public.synthetic_social_auth_audit(auth_user_id, occurred_at desc);

alter table public.synthetic_social_auth_tickets enable row level security;
alter table public.synthetic_social_auth_audit enable row level security;
revoke all on public.synthetic_social_auth_tickets, public.synthetic_social_auth_audit from public, anon, authenticated;
grant select on public.synthetic_social_auth_tickets, public.synthetic_social_auth_audit to service_role;

-- This harness is intentionally pinned to the isolated staging Supabase
-- project. Even a mis-scoped service key or Vercel target label cannot make
-- these functions run through another project's PostgREST host.
create or replace function public.assert_synthetic_staging_environment()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  request_headers text := current_setting('request.headers', true);
  request_host text;
begin
  begin
    request_host := nullif(request_headers, '')::jsonb ->> 'host';
  exception when others then
    request_host := null;
  end;
  if split_part(coalesce(request_host, ''), ':', 1) <> 'examplepreviewrefxxxx.supabase.co' then
    raise exception 'synthetic_staging_environment_invalid';
  end if;
end;
$$;

create or replace function public.resolve_synthetic_social_identity(
  environment_input text,
  provider_subject_input text,
  email_input text,
  display_name_input text,
  handle_input text
)
returns table(user_id uuid, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_user auth.users%rowtype;
  selected_curator public.curators%rowtype;
  inserted_rows integer := 0;
begin
  perform public.assert_synthetic_staging_environment();
  if environment_input <> 'staging'
     or provider_subject_input !~ '^synthetic:staging:[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'
     or email_input !~ '^grove-synthetic-[0-9a-f]{24}@staging\.invalid$'
     or char_length(display_name_input) not between 1 and 160
     or handle_input !~ '^synthetic-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$' then
    raise exception 'synthetic_identity_invalid';
  end if;

  select * into selected_curator from public.curators
  where provider = 'synthetic' and provider_subject = provider_subject_input;
  if found then
    select * into selected_user from auth.users where id = selected_curator.id;
    if not found or selected_user.raw_user_meta_data ->> 'synthetic_social_e2e' <> 'true'
       or selected_user.raw_user_meta_data ->> 'synthetic_provider_subject' <> provider_subject_input
       or selected_user.raw_user_meta_data ->> 'synthetic_environment' <> 'staging'
       or lower(selected_user.email) <> lower(email_input) then
      raise exception 'synthetic_identity_mismatch';
    end if;
    return query select selected_curator.id, false;
    return;
  end if;

  select * into selected_user from auth.users where lower(email) = lower(email_input) limit 1;
  if not found then return; end if;
  if selected_user.raw_user_meta_data ->> 'synthetic_social_e2e' <> 'true'
     or selected_user.raw_user_meta_data ->> 'synthetic_provider_subject' <> provider_subject_input
     or selected_user.raw_user_meta_data ->> 'synthetic_environment' <> 'staging' then
    raise exception 'synthetic_identity_mismatch';
  end if;

  insert into public.curators (id, provider, provider_subject, display_name, handle, status)
  values (selected_user.id, 'synthetic', provider_subject_input, display_name_input, handle_input, 'active')
  on conflict do nothing;
  get diagnostics inserted_rows = row_count;
  select * into selected_curator from public.curators
  where provider = 'synthetic' and provider_subject = provider_subject_input;
  if not found or selected_curator.id <> selected_user.id then
    raise exception 'synthetic_identity_conflict';
  end if;
  insert into public.synthetic_social_auth_audit (auth_user_id, action, evidence)
  values (
    selected_user.id,
    case when inserted_rows = 1 then 'identity.created' else 'identity.linked' end,
    jsonb_build_object('environment', 'staging', 'provider_subject', provider_subject_input, 'wallet_authority', false)
  );
  return query select selected_user.id, inserted_rows = 1;
end;
$$;

create or replace function public.issue_synthetic_social_auth_ticket(
  ticket_id_input uuid,
  environment_input text,
  auth_user_id_input uuid,
  provider_subject_input text,
  token_digest_input text,
  issued_at_input timestamptz,
  expires_at_input timestamptz,
  evidence_input jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_synthetic_staging_environment();
  perform pg_advisory_xact_lock(hashtextextended('synthetic-social-ticket-issue', 0));
  if environment_input <> 'staging' or token_digest_input !~ '^[0-9a-f]{64}$'
     or issued_at_input < now() - interval '30 seconds' or issued_at_input > now() + interval '30 seconds'
     or expires_at_input <= now() or expires_at_input > issued_at_input + interval '5 minutes'
     or jsonb_typeof(evidence_input) <> 'object' or evidence_input ->> 'wallet_authority' <> 'false'
     or not exists (
       select 1 from public.curators c join auth.users u on u.id = c.id
       where c.id = auth_user_id_input and c.provider = 'synthetic'
         and c.provider_subject = provider_subject_input and c.status = 'active'
         and u.raw_user_meta_data ->> 'synthetic_social_e2e' = 'true'
         and u.raw_user_meta_data ->> 'synthetic_provider_subject' = provider_subject_input
     ) then
    raise exception 'synthetic_ticket_invalid';
  end if;
  if (select count(*) from public.synthetic_social_auth_tickets where issued_at > now() - interval '1 minute') >= 30 then
    raise exception 'synthetic_ticket_rate_limit';
  end if;
  insert into public.synthetic_social_auth_tickets (
    id, environment, auth_user_id, provider_subject, token_digest,
    issued_at, expires_at, evidence
  ) values (
    ticket_id_input, environment_input, auth_user_id_input, provider_subject_input,
    token_digest_input, issued_at_input, expires_at_input, evidence_input
  );
  insert into public.synthetic_social_auth_audit (ticket_id, auth_user_id, action, evidence)
  values (ticket_id_input, auth_user_id_input, 'ticket.issued', evidence_input);
  return true;
end;
$$;

create or replace function public.consume_synthetic_social_auth_ticket(
  ticket_id_input uuid,
  token_digest_input text,
  auth_user_id_input uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_ticket public.synthetic_social_auth_tickets%rowtype;
begin
  perform public.assert_synthetic_staging_environment();
  select * into selected_ticket from public.synthetic_social_auth_tickets
  where id = ticket_id_input for update;
  if not found or selected_ticket.environment <> 'staging'
     or selected_ticket.auth_user_id <> auth_user_id_input
     or selected_ticket.token_digest <> token_digest_input
     or selected_ticket.consumed_at is not null or selected_ticket.expires_at <= now()
     or not exists (
       select 1 from public.curators c
       where c.id = auth_user_id_input and c.provider = 'synthetic'
         and c.provider_subject = selected_ticket.provider_subject and c.status = 'active'
     ) then return false;
  end if;
  update public.synthetic_social_auth_tickets set consumed_at = now() where id = ticket_id_input;
  insert into public.synthetic_social_auth_audit (ticket_id, auth_user_id, action, evidence)
  values (ticket_id_input, auth_user_id_input, 'ticket.consumed', jsonb_build_object(
    'environment', 'staging', 'provider_subject', selected_ticket.provider_subject, 'wallet_authority', false
  ));
  return true;
end;
$$;

create or replace function public.mark_synthetic_social_session_established(
  ticket_id_input uuid,
  auth_user_id_input uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer;
begin
  perform public.assert_synthetic_staging_environment();
  update public.synthetic_social_auth_tickets set session_established_at = now()
  where id = ticket_id_input and auth_user_id = auth_user_id_input
    and consumed_at is not null and session_established_at is null;
  get diagnostics changed = row_count;
  if changed <> 1 then return false; end if;
  insert into public.synthetic_social_auth_audit (ticket_id, auth_user_id, action, evidence)
  values (ticket_id_input, auth_user_id_input, 'session.established', jsonb_build_object(
    'environment', 'staging', 'wallet_authority', false
  ));
  return true;
end;
$$;

revoke all on function public.assert_synthetic_staging_environment() from public, anon, authenticated;
revoke all on function public.resolve_synthetic_social_identity(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.issue_synthetic_social_auth_ticket(uuid, text, uuid, text, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.consume_synthetic_social_auth_ticket(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.mark_synthetic_social_session_established(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assert_synthetic_staging_environment() to service_role;
grant execute on function public.resolve_synthetic_social_identity(text, text, text, text, text) to service_role;
grant execute on function public.issue_synthetic_social_auth_ticket(uuid, text, uuid, text, text, timestamptz, timestamptz, jsonb) to service_role;
grant execute on function public.consume_synthetic_social_auth_ticket(uuid, text, uuid) to service_role;
grant execute on function public.mark_synthetic_social_session_established(uuid, uuid) to service_role;

commit;

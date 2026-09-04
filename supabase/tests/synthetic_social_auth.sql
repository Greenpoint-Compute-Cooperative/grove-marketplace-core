begin;

do $$
declare
  function_signature text;
begin
  if has_table_privilege('anon', 'public.synthetic_social_auth_tickets', 'select')
     or has_table_privilege('authenticated', 'public.synthetic_social_auth_tickets', 'select')
     or has_table_privilege('anon', 'public.synthetic_social_auth_audit', 'select')
     or has_table_privilege('authenticated', 'public.synthetic_social_auth_audit', 'select') then
    raise exception 'synthetic social authentication evidence must remain private';
  end if;
  if not has_table_privilege('service_role', 'public.synthetic_social_auth_tickets', 'select')
     or not has_table_privilege('service_role', 'public.synthetic_social_auth_audit', 'select') then
    raise exception 'the staging service cannot read synthetic authentication evidence';
  end if;
  foreach function_signature in array array[
    'public.resolve_synthetic_social_identity(text,text,text,text,text)',
    'public.assert_synthetic_staging_environment()',
    'public.issue_synthetic_social_auth_ticket(uuid,text,uuid,text,text,timestamp with time zone,timestamp with time zone,jsonb)',
    'public.consume_synthetic_social_auth_ticket(uuid,text,uuid)',
    'public.mark_synthetic_social_session_established(uuid,uuid)'
  ] loop
    if has_function_privilege('anon', function_signature, 'execute')
       or has_function_privilege('authenticated', function_signature, 'execute') then
      raise exception 'browser roles must not control synthetic social authentication: %', function_signature;
    end if;
    if not has_function_privilege('service_role', function_signature, 'execute') then
      raise exception 'the staging service cannot execute synthetic authentication function: %', function_signature;
    end if;
  end loop;
end;
$$;

do $$
begin
  perform set_config('request.headers', '{"host":"exampleprodrefxxxxxxx.supabase.co"}', true);
  perform public.assert_synthetic_staging_environment();
  raise exception 'production Supabase host was accepted';
exception
  when others then
    if sqlerrm not like '%synthetic_staging_environment_invalid%' then raise; end if;
end;
$$;

select set_config('request.headers', '{"host":"examplepreviewrefxxxx.supabase.co"}', true);

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values (
  '40000000-0000-4000-8000-000000000001',
  'grove-synthetic-e6a8eb7850a259591bb24ae3@staging.invalid',
  '{"synthetic_social_e2e":true,"synthetic_provider_subject":"synthetic:staging:auction-e2e","synthetic_environment":"staging"}',
  '{"synthetic_social_e2e":true,"synthetic_environment":"staging"}'
);

do $$
declare
  resolved record;
  accepted boolean;
begin
  select * into resolved from public.resolve_synthetic_social_identity(
    'staging',
    'synthetic:staging:auction-e2e',
    'grove-synthetic-e6a8eb7850a259591bb24ae3@staging.invalid',
    'Synthetic Staging Bidder · auction-e2e',
    'synthetic-auction-e2e'
  );
  if resolved.user_id <> '40000000-0000-4000-8000-000000000001'::uuid or resolved.created is not true then
    raise exception 'synthetic curator was not created deterministically';
  end if;
  if not exists (
    select 1 from public.curators where id = resolved.user_id
      and provider = 'synthetic' and provider_subject = 'synthetic:staging:auction-e2e'
      and status = 'active'
  ) then
    raise exception 'synthetic curator is not explicit and active';
  end if;

  accepted := public.issue_synthetic_social_auth_ticket(
    '40000000-0000-4000-8000-000000000002',
    'staging',
    resolved.user_id,
    'synthetic:staging:auction-e2e',
    repeat('a', 64),
    now(),
    now() + interval '2 minutes',
    '{"purpose":"sql-e2e","wallet_authority":false}'
  );
  if accepted is not true then raise exception 'synthetic ticket was not issued'; end if;

  accepted := public.consume_synthetic_social_auth_ticket(
    '40000000-0000-4000-8000-000000000002',
    repeat('a', 64),
    resolved.user_id
  );
  if accepted is not true then raise exception 'valid synthetic ticket was not consumed'; end if;
  if public.consume_synthetic_social_auth_ticket(
    '40000000-0000-4000-8000-000000000002',
    repeat('a', 64),
    resolved.user_id
  ) is not false then
    raise exception 'synthetic ticket was reusable';
  end if;
  if public.mark_synthetic_social_session_established(
    '40000000-0000-4000-8000-000000000002',
    resolved.user_id
  ) is not true then
    raise exception 'synthetic session audit could not be established';
  end if;
  if (select count(*) from public.synthetic_social_auth_audit where auth_user_id = resolved.user_id) <> 4 then
    raise exception 'synthetic identity and ticket lifecycle is not fully audited';
  end if;
end;
$$;

do $$
begin
  perform public.resolve_synthetic_social_identity(
    'production',
    'synthetic:staging:auction-e2e',
    'grove-synthetic-e6a8eb7850a259591bb24ae3@staging.invalid',
    'Synthetic Staging Bidder',
    'synthetic-auction-e2e'
  );
  raise exception 'production synthetic identity was accepted';
exception
  when others then
    if sqlerrm not like '%synthetic_identity_invalid%' then raise; end if;
end;
$$;

rollback;

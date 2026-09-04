begin;

do $$
declare
  passkey_member constant uuid := '10000000-0000-4000-8000-000000000091';
  recovery_member constant uuid := '10000000-0000-4000-8000-000000000092';
  passkey_account_uuid uuid;
  recovery_account_uuid uuid;
  prepared public.smart_accounts%rowtype;
  repeated public.smart_accounts%rowtype;
  activated public.smart_accounts%rowtype;
  credential_count integer;
  challenge_consumed timestamptz;
  owner_commitment constant text := '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  recovery_owner_commitment constant text := '0xabababababababababababababababababababababababababababababababab';
  recovery_commitment constant text := '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  recovery_challenge constant text := '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
  recovery_origin constant text := '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  large_salt constant numeric := 31295349875325192094896671340851653026853718638760146165549435881949828419807;
begin
  insert into auth.users (id, email) values
    (passkey_member, 'passkey-only@example.invalid'),
    (recovery_member, 'passkey-recovery@example.invalid');
  insert into public.curators (id, provider, provider_subject, display_name, handle, status) values
    (passkey_member, 'instagram', 'recovery-rate-limit-passkey', 'Passkey member', 'passkey-member', 'active'),
    (recovery_member, 'instagram', 'recovery-rate-limit-recovery', 'Recovery member', 'recovery-member', 'active');

  select * into prepared from public.prepare_smart_account_provisioning(
    passkey_member, 11155111,
    '0x1111111111111111111111111111111111111191', '1.4.1', '0.3.0',
    '0x2222222222222222222222222222222222222291',
    '0x3333333333333333333333333333333333333391',
    '0x9191919191919191919191919191919191919191919191919191919191919191',
    '0x4444444444444444444444444444444444444491', owner_commitment,
    null, null,
    '0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
    '0xf1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1',
    large_salt, 9100000,
    '0x0101010101010101010101010101010101010101010101010101010101010101',
    null, null, null
  );
  passkey_account_uuid := prepared.id;
  if prepared.state <> 'counterfactual' or prepared.recovery_ready
     or prepared.signer_count <> 1 or prepared.threshold <> 1
     or prepared.recovery_proof_hash is not null
     or prepared.salt_nonce_text <> large_salt::text then
    raise exception 'passkey-only Safe did not remain fail-closed';
  end if;
  select count(*) into credential_count from public.wallet_credentials
  where smart_account_id = passkey_account_uuid and state = 'active';
  if credential_count <> 1 then raise exception 'passkey-only Safe has unexpected credentials'; end if;

  select * into repeated from public.prepare_smart_account_provisioning(
    passkey_member, 11155111,
    '0x1111111111111111111111111111111111111191', '1.4.1', '0.3.0',
    '0x2222222222222222222222222222222222222291',
    '0x3333333333333333333333333333333333333391',
    '0x9191919191919191919191919191919191919191919191919191919191919191',
    '0x4444444444444444444444444444444444444491', owner_commitment,
    null, null,
    '0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
    '0xf1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1',
    large_salt, 9100000,
    '0x0101010101010101010101010101010101010101010101010101010101010101',
    null, null, null
  );
  if repeated.id <> passkey_account_uuid then raise exception 'exact preparation retry was not idempotent'; end if;

  begin
    perform public.prepare_smart_account_provisioning(
      passkey_member, 11155111,
      '0x1111111111111111111111111111111111111192', '1.4.1', '0.3.0',
      '0x2222222222222222222222222222222222222291',
      '0x3333333333333333333333333333333333333391',
      '0x9191919191919191919191919191919191919191919191919191919191919191',
      '0x4444444444444444444444444444444444444491', owner_commitment,
      null, null,
      '0xe1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
      '0xf1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1',
      large_salt, 9100000,
      '0x0101010101010101010101010101010101010101010101010101010101010101',
      null, null, null
    );
    raise exception 'changed existing-row account address was accepted';
  exception when others then
    if sqlerrm <> 'smart_account_provisioning_conflict' then raise; end if;
  end;

  select * into activated from public.activate_smart_account_provisioning(
    passkey_member, passkey_account_uuid, prepared.provisioning_commitment, null,
    '0x1212121212121212121212121212121212121212121212121212121212121291',
    9100010, '0x1313131313131313131313131313131313131313131313131313131313131391'
  );
  if activated.state <> 'deployed' or activated.recovery_ready
     or activated.deployment_userop_hash is not null then
    raise exception 'passkey-only finalized deployment did not activate correctly';
  end if;

  if not public.issue_wallet_recovery_challenge(
    recovery_member, recovery_challenge, recovery_owner_commitment,
    '0x5555555555555555555555555555555555555592', recovery_origin, now() + interval '5 minutes'
  ) then raise exception 'recovery challenge was not issued'; end if;
  select * into prepared from public.prepare_smart_account_provisioning(
    recovery_member, 11155111,
    '0x1111111111111111111111111111111111111192', '1.4.1', '0.3.0',
    '0x2222222222222222222222222222222222222291',
    '0x3333333333333333333333333333333333333391',
    '0x9292929292929292929292929292929292929292929292929292929292929292',
    '0x4444444444444444444444444444444444444491', recovery_owner_commitment,
    '0x5555555555555555555555555555555555555592', recovery_commitment,
    '0xe2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2',
    '0xf2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2',
    92, 9200000,
    '0x0202020202020202020202020202020202020202020202020202020202020202',
    '0x0303030303030303030303030303030303030303030303030303030303030303',
    recovery_challenge, recovery_origin
  );
  recovery_account_uuid := prepared.id;
  if prepared.signer_count <> 2 or prepared.recovery_proof_hash is null then
    raise exception 'recovery Safe did not persist verified recovery configuration';
  end if;
  select consumed_at into challenge_consumed from public.wallet_recovery_challenges
  where wallet_recovery_challenges.challenge_hash = recovery_challenge;
  if challenge_consumed is null then raise exception 'recovery challenge was not consumed atomically'; end if;

  begin
    perform public.prepare_smart_account_provisioning(
      recovery_member, 11155111,
      '0x1111111111111111111111111111111111111192', '1.4.1', '0.3.0',
      '0x2222222222222222222222222222222222222291',
      '0x3333333333333333333333333333333333333391',
      '0x9292929292929292929292929292929292929292929292929292929292929292',
      '0x4444444444444444444444444444444444444491', recovery_owner_commitment,
      '0x5555555555555555555555555555555555555592', recovery_commitment,
      '0xe2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2',
      '0xf2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2',
      92, 9200000,
      '0x0202020202020202020202020202020202020202020202020202020202020202',
      '0x0303030303030303030303030303030303030303030303030303030303030303',
      recovery_challenge, recovery_origin
    );
    raise exception 'consumed recovery challenge was replayed';
  exception when others then
    if sqlerrm <> 'smart_account_recovery_challenge_invalid' then raise; end if;
  end;

  -- Five attempts per minute are allowed, each invalidating the previous live
  -- challenge. The sixth request is rejected under the same per-user lock.
  for credential_count in 1..5 loop
    perform public.issue_wallet_recovery_challenge(
      passkey_member,
      '0x' || lpad(to_hex(credential_count), 64, '0'),
      owner_commitment,
      '0x5555555555555555555555555555555555555591',
      recovery_origin,
      now() + interval '5 minutes'
    );
  end loop;
  if (select count(*) from public.wallet_recovery_challenges
      where user_id = passkey_member and consumed_at is null and invalidated_at is null) <> 1 then
    raise exception 'outstanding recovery challenges were not bounded';
  end if;
  begin
    perform public.issue_wallet_recovery_challenge(
      passkey_member, '0x' || repeat('0a', 32),
      owner_commitment, '0x5555555555555555555555555555555555555591',
      recovery_origin, now() + interval '5 minutes'
    );
    raise exception 'recovery challenge rate limit was bypassed';
  exception when others then
    if sqlerrm <> 'wallet_recovery_challenge_rate_limit' then raise; end if;
  end;

  select * into activated from public.activate_smart_account_provisioning(
    recovery_member, recovery_account_uuid, prepared.provisioning_commitment, null,
    '0x2222222222222222222222222222222222222222222222222222222222222292',
    9200010, '0x2323232323232323232323232323232323232323232323232323232323232392'
  );
  if activated.state <> 'recovery-ready' or not activated.recovery_ready then
    raise exception 'recovery Safe finalized deployment did not activate correctly';
  end if;

  begin
    update public.smart_accounts
      set account_address = '0x1515151515151515151515151515151515151591'
      where id = passkey_account_uuid;
    raise exception 'provisioning identity was mutable';
  exception when others then
    if sqlerrm <> 'smart_account_provisioning_identity_immutable' then raise; end if;
  end;
end;
$$;

do $$
begin
  if has_function_privilege(
    'anon',
    'public.prepare_smart_account_provisioning(uuid,bigint,text,text,text,text,text,text,text,text,text,text,text,text,numeric,bigint,text,text,text,text)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.issue_wallet_recovery_challenge(uuid,text,text,text,text,timestamp with time zone)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.activate_smart_account_provisioning(uuid,uuid,text,text,text,bigint,text)',
    'execute'
  ) then
    raise exception 'provisioning RPC escaped service-role boundary';
  end if;
end;
$$;

rollback;

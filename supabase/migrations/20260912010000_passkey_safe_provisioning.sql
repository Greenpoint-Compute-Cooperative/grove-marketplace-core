begin;

alter table public.smart_accounts
  add column provisioning_commitment text check (
    provisioning_commitment is null or provisioning_commitment ~ '^0x[0-9a-f]{64}$'
  ),
  add column factory_data_hash text check (
    factory_data_hash is null or factory_data_hash ~ '^0x[0-9a-f]{64}$'
  ),
  add column salt_nonce numeric(78, 0) check (salt_nonce is null or salt_nonce >= 0),
  add column recovery_proof_hash text check (
    recovery_proof_hash is null or recovery_proof_hash ~ '^0x[0-9a-f]{64}$'
  ),
  add column prepared_finalized_block bigint check (
    prepared_finalized_block is null or prepared_finalized_block >= 0
  ),
  add column prepared_finalized_block_hash text check (
    prepared_finalized_block_hash is null or prepared_finalized_block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  add column deployment_block_hash text check (
    deployment_block_hash is null or deployment_block_hash ~ '^0x[0-9a-f]{64}$'
  ),
  add column provisioned_at timestamptz,
  add constraint smart_accounts_provisioning_tuple_complete check (
    (provisioning_commitment is null and factory_data_hash is null and salt_nonce is null
      and recovery_proof_hash is null and prepared_finalized_block is null
      and prepared_finalized_block_hash is null and provisioned_at is null)
    or
    (provisioning_commitment is not null and factory_data_hash is not null and salt_nonce is not null
      and prepared_finalized_block is not null
      and prepared_finalized_block_hash is not null and provisioned_at is not null)
  ),
  add constraint smart_accounts_optional_recovery_consistent check (
    provisioning_commitment is null
    or (signer_count = 1 and recovery_proof_hash is null)
    or (signer_count = 2 and recovery_proof_hash is not null)
  ),
  add constraint smart_accounts_finalized_deployment_tuple_complete check (
    provisioning_commitment is null
    or (deployment_userop_hash is null and deployment_tx_hash is null and deployment_block is null
      and deployment_block_hash is null and finalized_at is null)
    or (deployment_tx_hash is not null and deployment_block is not null
      and deployment_block_hash is not null and finalized_at is not null)
  );

create unique index smart_accounts_provisioning_commitment_idx
  on public.smart_accounts(provisioning_commitment)
  where provisioning_commitment is not null;

create table public.wallet_recovery_challenges (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_hash text not null unique check (challenge_hash ~ '^0x[0-9a-f]{64}$'),
  passkey_commitment text not null check (passkey_commitment ~ '^0x[0-9a-f]{64}$'),
  recovery_address text not null check (recovery_address ~ '^0x[0-9a-f]{40}$'),
  origin_hash text not null check (origin_hash ~ '^0x[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (consumed_at is null or invalidated_at is null)
);

create index wallet_recovery_challenges_expiry_idx
  on public.wallet_recovery_challenges(expires_at)
  where consumed_at is null and invalidated_at is null;
create unique index wallet_recovery_challenges_one_live_idx
  on public.wallet_recovery_challenges(user_id)
  where consumed_at is null and invalidated_at is null;

alter table public.wallet_recovery_challenges enable row level security;
revoke all on public.wallet_recovery_challenges from public, anon, authenticated;
grant select, insert, update, delete on public.wallet_recovery_challenges to service_role;

create or replace function public.issue_wallet_recovery_challenge(
  member_uuid uuid,
  expected_challenge_hash text,
  expected_passkey_commitment text,
  expected_recovery_address text,
  expected_origin_hash text,
  expected_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if member_uuid is null
     or expected_challenge_hash !~ '^0x[0-9a-f]{64}$'
     or expected_passkey_commitment !~ '^0x[0-9a-f]{64}$'
     or expected_recovery_address !~ '^0x[0-9a-f]{40}$'
     or expected_recovery_address = '0x0000000000000000000000000000000000000000'
     or expected_origin_hash !~ '^0x[0-9a-f]{64}$'
     or expected_expires_at <= now()
     or expected_expires_at > now() + interval '10 minutes'
     or not exists (
       select 1 from public.curators
       where id = member_uuid and status = 'active'
     ) then
    raise exception 'wallet_recovery_challenge_invalid';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(member_uuid::text, 912741));
  if (
    select count(*) from public.wallet_recovery_challenges
    where user_id = member_uuid and created_at > now() - interval '1 minute'
  ) >= 5 then
    raise exception 'wallet_recovery_challenge_rate_limit';
  end if;

  -- One live proof request per member keeps the signing UX deterministic while
  -- retained invalidations make the rate cap durable and auditable.
  update public.wallet_recovery_challenges set invalidated_at = now()
  where user_id = member_uuid and consumed_at is null and invalidated_at is null;
  delete from public.wallet_recovery_challenges
  where user_id = member_uuid
    and expires_at < now() - interval '1 day';

  insert into public.wallet_recovery_challenges (
    user_id, challenge_hash, passkey_commitment, recovery_address, origin_hash, expires_at
  ) values (
    member_uuid, expected_challenge_hash, expected_passkey_commitment,
    expected_recovery_address, expected_origin_hash, expected_expires_at
  );
  return true;
end;
$$;

create or replace function public.protect_smart_account_provisioning()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.provisioning_commitment is not null and (
    new.user_id is distinct from old.user_id
    or new.chain_id is distinct from old.chain_id
    or new.account_address is distinct from old.account_address
    or new.safe_version is distinct from old.safe_version
    or new.module_version is distinct from old.module_version
    or new.entry_point_address is distinct from old.entry_point_address
    or new.factory_address is distinct from old.factory_address
    or new.code_hash is distinct from old.code_hash
    or new.signer_count is distinct from old.signer_count
    or new.threshold is distinct from old.threshold
    or new.provisioning_commitment is distinct from old.provisioning_commitment
    or new.factory_data_hash is distinct from old.factory_data_hash
    or new.salt_nonce is distinct from old.salt_nonce
    or new.prepared_finalized_block is distinct from old.prepared_finalized_block
    or new.prepared_finalized_block_hash is distinct from old.prepared_finalized_block_hash
    or new.provisioned_at is distinct from old.provisioned_at
  ) then
    raise exception 'smart_account_provisioning_identity_immutable';
  end if;
  if old.deployment_tx_hash is not null and (
    new.deployment_userop_hash is distinct from old.deployment_userop_hash
    or new.deployment_tx_hash is distinct from old.deployment_tx_hash
    or new.deployment_block is distinct from old.deployment_block
    or new.deployment_block_hash is distinct from old.deployment_block_hash
    or new.finalized_at is distinct from old.finalized_at
  ) then
    raise exception 'smart_account_deployment_evidence_immutable';
  end if;
  if old.recovery_ready and not new.recovery_ready then
    raise exception 'smart_account_recovery_cannot_regress';
  end if;
  return new;
end;
$$;

create trigger smart_accounts_provisioning_protected
before update on public.smart_accounts
for each row execute function public.protect_smart_account_provisioning();

create or replace function public.prepare_smart_account_provisioning(
  member_uuid uuid,
  expected_chain_id bigint,
  expected_account_address text,
  expected_safe_version text,
  expected_module_version text,
  expected_entry_point_address text,
  expected_factory_address text,
  expected_code_hash text,
  expected_shared_signer_address text,
  owner_credential_commitment text,
  recovery_owner_address text,
  recovery_credential_commitment text,
  expected_provisioning_commitment text,
  expected_factory_data_hash text,
  expected_salt_nonce numeric,
  verified_finalized_block bigint,
  verified_finalized_block_hash text,
  verified_recovery_proof_hash text,
  expected_recovery_challenge_hash text,
  expected_origin_hash text
)
returns public.smart_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_account public.smart_accounts%rowtype;
  active_owner_count integer;
  active_recovery_count integer;
  active_credential_count integer;
  expected_signer_count integer;
  selected_challenge public.wallet_recovery_challenges%rowtype;
begin
  if member_uuid is null or expected_chain_id not in (1, 11155111)
     or expected_account_address !~ '^0x[0-9a-f]{40}$'
     or expected_entry_point_address !~ '^0x[0-9a-f]{40}$'
     or expected_factory_address !~ '^0x[0-9a-f]{40}$'
     or expected_shared_signer_address !~ '^0x[0-9a-f]{40}$'
     or expected_code_hash !~ '^0x[0-9a-f]{64}$'
     or owner_credential_commitment !~ '^0x[0-9a-f]{64}$'
     or expected_provisioning_commitment !~ '^0x[0-9a-f]{64}$'
     or expected_factory_data_hash !~ '^0x[0-9a-f]{64}$'
     or expected_salt_nonce is null or expected_salt_nonce < 0
     or verified_finalized_block is null or verified_finalized_block < 0
     or verified_finalized_block_hash !~ '^0x[0-9a-f]{64}$'
     or not (
       (recovery_owner_address is null and recovery_credential_commitment is null
         and verified_recovery_proof_hash is null and expected_recovery_challenge_hash is null
         and expected_origin_hash is null)
       or
       (recovery_owner_address ~ '^0x[0-9a-f]{40}$'
         and recovery_owner_address <> '0x0000000000000000000000000000000000000000'
         and recovery_owner_address <> expected_shared_signer_address
         and recovery_credential_commitment ~ '^0x[0-9a-f]{64}$'
         and owner_credential_commitment <> recovery_credential_commitment
         and verified_recovery_proof_hash ~ '^0x[0-9a-f]{64}$'
         and expected_recovery_challenge_hash ~ '^0x[0-9a-f]{64}$'
         and expected_origin_hash ~ '^0x[0-9a-f]{64}$')
     ) then
    raise exception 'smart_account_provisioning_invalid';
  end if;

  expected_signer_count := case when recovery_owner_address is null then 1 else 2 end;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(member_uuid::text, 781739));
  if recovery_owner_address is not null then
    select * into selected_challenge
    from public.wallet_recovery_challenges
    where challenge_hash = expected_recovery_challenge_hash for update;
    if not found or selected_challenge.user_id is distinct from member_uuid
       or selected_challenge.passkey_commitment is distinct from owner_credential_commitment
       or selected_challenge.recovery_address is distinct from recovery_owner_address
       or selected_challenge.origin_hash is distinct from expected_origin_hash
       or selected_challenge.expires_at <= now() or selected_challenge.consumed_at is not null
       or selected_challenge.invalidated_at is not null then
      raise exception 'smart_account_recovery_challenge_invalid';
    end if;
  end if;
  select * into selected_account from public.smart_accounts where user_id = member_uuid for update;
  if found then
    if selected_account.chain_id is distinct from expected_chain_id
       or selected_account.account_address is distinct from expected_account_address
       or selected_account.safe_version is distinct from expected_safe_version
       or selected_account.module_version is distinct from expected_module_version
       or selected_account.entry_point_address is distinct from expected_entry_point_address
       or selected_account.factory_address is distinct from expected_factory_address
       or selected_account.code_hash is distinct from expected_code_hash
       or selected_account.signer_count is distinct from expected_signer_count
       or selected_account.threshold is distinct from 1
       or selected_account.provisioning_commitment is distinct from expected_provisioning_commitment
       or selected_account.factory_data_hash is distinct from expected_factory_data_hash
       or selected_account.salt_nonce is distinct from expected_salt_nonce then
      raise exception 'smart_account_provisioning_conflict';
    end if;
  else
    insert into public.smart_accounts (
      user_id, chain_id, account_address, safe_version, module_version,
      entry_point_address, factory_address, code_hash, signer_count, threshold,
      recovery_ready, state, provisioning_commitment, factory_data_hash, salt_nonce,
      recovery_proof_hash, prepared_finalized_block, prepared_finalized_block_hash, provisioned_at
    ) values (
      member_uuid, expected_chain_id, expected_account_address, expected_safe_version, expected_module_version,
      expected_entry_point_address, expected_factory_address, expected_code_hash, expected_signer_count, 1,
      false, 'counterfactual', expected_provisioning_commitment, expected_factory_data_hash, expected_salt_nonce,
      verified_recovery_proof_hash, verified_finalized_block, verified_finalized_block_hash, now()
    ) returning * into selected_account;

    insert into public.wallet_credentials (
      smart_account_id, credential_commitment, owner_address, purpose
    ) values (selected_account.id, owner_credential_commitment, expected_shared_signer_address, 'owner');
    if recovery_owner_address is not null then
      insert into public.wallet_credentials (
        smart_account_id, credential_commitment, owner_address, purpose
      ) values (selected_account.id, recovery_credential_commitment, recovery_owner_address, 'recovery');
    end if;
  end if;

  select count(*), count(*) filter (
      where purpose = 'owner' and owner_address = expected_shared_signer_address
        and credential_commitment = owner_credential_commitment
    ), count(*) filter (
      where purpose = 'recovery' and owner_address = recovery_owner_address
        and credential_commitment = recovery_credential_commitment
    )
    into active_credential_count, active_owner_count, active_recovery_count
  from public.wallet_credentials
  where smart_account_id = selected_account.id and state = 'active';
  if active_credential_count <> expected_signer_count or active_owner_count <> 1
     or active_recovery_count <> (case when recovery_owner_address is null then 0 else 1 end) then
    raise exception 'smart_account_credentials_conflict';
  end if;
  if recovery_owner_address is not null then
    update public.wallet_recovery_challenges set consumed_at = now()
    where id = selected_challenge.id and consumed_at is null;
    if not found then raise exception 'smart_account_recovery_challenge_invalid'; end if;
  end if;
  return selected_account;
end;
$$;

create or replace function public.activate_smart_account_provisioning(
  member_uuid uuid,
  account_uuid uuid,
  expected_provisioning_commitment text,
  finalized_userop_hash text,
  finalized_transaction_hash text,
  finalized_block_number bigint,
  finalized_block_hash text
)
returns public.smart_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_account public.smart_accounts%rowtype;
  active_owner_count integer;
  active_recovery_count integer;
  active_credential_count integer;
  recovery_configured boolean;
  activation_state text;
begin
  select * into selected_account from public.smart_accounts where id = account_uuid for update;
  if not found or selected_account.user_id is distinct from member_uuid
     or selected_account.provisioning_commitment is distinct from expected_provisioning_commitment
     or selected_account.state = 'suspended'
     or (finalized_userop_hash is not null and finalized_userop_hash !~ '^0x[0-9a-f]{64}$')
     or finalized_transaction_hash is null or finalized_transaction_hash !~ '^0x[0-9a-f]{64}$'
     or finalized_block_number is null or finalized_block_number < 0
     or finalized_block_hash is null or finalized_block_hash !~ '^0x[0-9a-f]{64}$' then
    raise exception 'smart_account_activation_invalid';
  end if;

  select count(*), count(*) filter (where purpose = 'owner'), count(*) filter (where purpose = 'recovery')
    into active_credential_count, active_owner_count, active_recovery_count
  from public.wallet_credentials
  where smart_account_id = selected_account.id and state = 'active';
  recovery_configured := selected_account.signer_count = 2 and active_credential_count = 2
    and active_owner_count = 1 and active_recovery_count = 1;
  if selected_account.threshold <> 1 or not (
    recovery_configured
    or (selected_account.signer_count = 1 and active_credential_count = 1
      and active_owner_count = 1 and active_recovery_count = 0)
  ) then
    raise exception 'smart_account_credentials_not_configured';
  end if;
  activation_state := case when recovery_configured then 'recovery-ready' else 'deployed' end;

  if selected_account.state in ('deployed', 'recovery-ready') then
    if selected_account.state is distinct from activation_state
       or selected_account.recovery_ready is distinct from recovery_configured
       or selected_account.finalized_at is null
       or selected_account.deployment_userop_hash is distinct from finalized_userop_hash
       or selected_account.deployment_tx_hash is distinct from finalized_transaction_hash
       or selected_account.deployment_block is distinct from finalized_block_number
       or selected_account.deployment_block_hash is distinct from finalized_block_hash then
      raise exception 'smart_account_activation_conflict';
    end if;
    return selected_account;
  end if;

  if selected_account.deployment_tx_hash is not null then
    if selected_account.deployment_userop_hash is distinct from finalized_userop_hash
       or selected_account.deployment_tx_hash is distinct from finalized_transaction_hash
       or selected_account.deployment_block is distinct from finalized_block_number
       or selected_account.deployment_block_hash is distinct from finalized_block_hash then
      raise exception 'smart_account_activation_conflict';
    end if;
  end if;

  if selected_account.state not in ('counterfactual', 'deploying', 'deployed') then
    raise exception 'smart_account_activation_state_invalid';
  end if;
  update public.smart_accounts set
    state = activation_state,
    recovery_ready = recovery_configured,
    deployment_userop_hash = finalized_userop_hash,
    deployment_tx_hash = finalized_transaction_hash,
    deployment_block = finalized_block_number,
    deployment_block_hash = finalized_block_hash,
    finalized_at = now()
  where id = selected_account.id
  returning * into selected_account;
  return selected_account;
end;
$$;

revoke all on function public.prepare_smart_account_provisioning(
  uuid, bigint, text, text, text, text, text, text, text, text, text, text,
  text, text, numeric, bigint, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.issue_wallet_recovery_challenge(
  uuid, text, text, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.activate_smart_account_provisioning(
  uuid, uuid, text, text, text, bigint, text
) from public, anon, authenticated;
grant execute on function public.issue_wallet_recovery_challenge(
  uuid, text, text, text, text, timestamptz
) to service_role;
grant execute on function public.prepare_smart_account_provisioning(
  uuid, bigint, text, text, text, text, text, text, text, text, text, text,
  text, text, numeric, bigint, text, text, text, text
) to service_role;
grant execute on function public.activate_smart_account_provisioning(
  uuid, uuid, text, text, text, bigint, text
) to service_role;

commit;

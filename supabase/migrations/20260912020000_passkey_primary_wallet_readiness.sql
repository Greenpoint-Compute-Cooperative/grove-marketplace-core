begin;

create or replace function public.primary_wallet_ready(account public.smart_accounts)
returns boolean
language sql
immutable
set search_path = public
as $$
  select account.finalized_at is not null and (
    (account.state = 'deployed' and not account.recovery_ready)
    or (account.state = 'recovery-ready' and account.recovery_ready)
  )
$$;
revoke all on function public.primary_wallet_ready(public.smart_accounts) from public, anon, authenticated;

-- These functions predate passkey-only onboarding. Replace only the exact legacy
-- predicates and abort the migration if a function has drifted, rather than
-- silently widening any other settlement or delivery condition.
do $$
declare
  definition text;
  rewritten text;
begin
  definition := pg_get_functiondef(
    'public.place_verified_auction_bid(uuid,uuid,uuid,uuid,numeric,text,numeric,text,bytea,bigint,timestamptz,timestamptz,text,text)'::regprocedure
  );
  rewritten := replace(
    definition,
    $gate$selected_account.state <> 'recovery-ready'
     or not selected_account.recovery_ready or selected_account.finalized_at is null$gate$,
    $gate$not public.primary_wallet_ready(selected_account)$gate$
  );
  if rewritten = definition then raise exception 'place_verified_auction_bid_wallet_gate_drifted'; end if;
  execute rewritten;

  definition := pg_get_functiondef(
    'public.close_auction(uuid,uuid,text,bigint,bigint,text)'::regprocedure
  );
  rewritten := replace(
    definition,
    $gate$winning_account.state <> 'recovery-ready'
     or not winning_account.recovery_ready or winning_account.finalized_at is null$gate$,
    $gate$not public.primary_wallet_ready(winning_account)$gate$
  );
  if rewritten = definition then raise exception 'close_auction_wallet_gate_drifted'; end if;
  execute rewritten;

  definition := pg_get_functiondef(
    'public.authorize_auction_delivery(uuid,text,text,text,text,timestamptz,text)'::regprocedure
  );
  rewritten := replace(
    definition,
    $gate$selected_account.state <> 'recovery-ready' or not selected_account.recovery_ready
     or selected_account.finalized_at is null$gate$,
    $gate$not public.primary_wallet_ready(selected_account)$gate$
  );
  if rewritten = definition then raise exception 'authorize_auction_delivery_wallet_gate_drifted'; end if;
  execute rewritten;

  definition := pg_get_functiondef(
    'public.claim_auction_delivery(uuid,bigint,text,text,numeric,numeric,text,text,numeric,text,text,bigint,text)'::regprocedure
  );
  rewritten := replace(
    definition,
    $gate$selected_account.state <> 'recovery-ready' or not selected_account.recovery_ready
     or selected_account.finalized_at is null$gate$,
    $gate$not public.primary_wallet_ready(selected_account)$gate$
  );
  if rewritten = definition then raise exception 'claim_auction_delivery_wallet_gate_drifted'; end if;
  execute rewritten;
end;
$$;

commit;

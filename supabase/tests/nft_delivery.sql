begin;

insert into auth.users (id) values ('91000000-0000-4000-8000-000000000001');

insert into public.nft_collections (
  id, standard, chain_id, contract_address, deployed_code_hash, inventory_safe,
  deployment_tx_hash, deployment_block, contract_version, state
) values (
  '92000000-0000-4000-8000-000000000001', 'ERC721', 11155111,
  '0x1111111111111111111111111111111111111111',
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '0x2222222222222222222222222222222222222222',
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  100, 'test', 'rehearsal'
);

insert into public.works (
  id, slug, artist_name, title, format, media_url, sale_kind, inventory_total, inventory_available,
  status, contract_status, nft_collection_id, nft_work_id, nft_token_id, nft_quantity,
  nft_custody_state, nft_mint_tx_hash, nft_mint_block, nft_finalized_at
) values (
  '93000000-0000-4000-8000-000000000001', 'delivery-work', 'Artist', 'Delivery Work',
  'digital', 'https://example.test/work.jpg', 'auction', 1, 1, 'listed', 'minted',
  '92000000-0000-4000-8000-000000000001',
  '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 7, 1,
  'inventory-safe', '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 101, now()
);

insert into public.smart_accounts (
  id, user_id, chain_id, account_address, safe_version, module_version, entry_point_address,
  factory_address, code_hash, signer_count, threshold, recovery_ready, state, deployment_block, finalized_at
) values (
  '94000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 11155111,
  '0x3333333333333333333333333333333333333333', '1.4.1', '0.3.0',
  '0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  1, 1, false, 'deployed', 102, now()
);

insert into public.wallet_links (
  user_id, smart_account_id, challenge_hash, typed_data_hash, verification_block, verified_at
) values (
  '91000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001',
  '0x0101010101010101010101010101010101010101010101010101010101010101',
  '0x0202020202020202020202020202020202020202020202020202020202020202', 103, now()
);

insert into public.auctions (
  id, work_id, settlement_rail, bid_currency, state, opens_at, closes_at, original_closes_at,
  quantity, reserve_amount, minimum_increment, maximum_card_bid_minor, terms_url, terms_version, terms_hash
) values (
  '95000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001',
  'card', 'USD', 'open', now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour',
  1, 10000, 500, 50000, 'https://example.test/terms', 'terms-v1',
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
);

insert into public.auction_bids (
  id, auction_id, bidder_user_id, smart_account_id, amount, currency, intent_nonce,
  intent_hash, signature, signature_verified_block, intent_origin_hash,
  valid_after, valid_until, idempotency_key, state
) values (
  '96000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001',
  10000, 'USD', 1,
  '0x1212121212121212121212121212121212121212121212121212121212121212', decode('01', 'hex'), 103,
  '0x3434343434343434343434343434343434343434343434343434343434343434',
  now() - interval '2 hours', now() + interval '1 day', 'delivery-bid-request-0001', 'won'
);

update public.auctions set
  high_bid_id = '96000000-0000-4000-8000-000000000001',
  winner_bid_id = '96000000-0000-4000-8000-000000000001', state = 'paid-risk-hold'
where id = '95000000-0000-4000-8000-000000000001';

insert into public.auction_settlements (
  id, auction_id, winning_bid_id, bidder_user_id, smart_account_id, rail, hammer_amount,
  total_amount, currency, state, risk_hold_until, current_payment_intent_ref, payment_generation,
  inventory_verified_block, inventory_verified_block_hash, tax_calculation_ref,
  tax_transaction_ref, paid_at, settlement_deadline, risk_hold_seconds
) values (
  '97000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000001',
  '96000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001', 'card', 10000, 10000, 'USD', 'paid-risk-hold',
  now() - interval '1 minute', 'pi_delivery', 2, 150,
  '0x4545454545454545454545454545454545454545454545454545454545454545',
  'taxcalc_delivery', 'tax_delivery', now() - interval '2 hours', now() + interval '1 hour', 3600
);

insert into public.payment_attempts (
  settlement_id, payment_intent_ref, generation, attempt_kind, amount_minor, currency, state
) values
  ('97000000-0000-4000-8000-000000000001', 'pi_delivery_prior', 1, 'off-session', 10000, 'USD', 'canceled'),
  ('97000000-0000-4000-8000-000000000001', 'pi_delivery', 2, 'interactive-cure', 10000, 'USD', 'succeeded');

insert into public.auction_payment_risk_signals (
  settlement_id, payment_intent_ref, provider_object_ref, signal_kind, actionable, status, observed_at
) values (
  '97000000-0000-4000-8000-000000000001', 'pi_delivery', 'iss_delivery',
  'early-fraud-warning', false, 'not-actionable', now()
);

do $$
begin
  begin
    perform public.authorize_auction_delivery(
      '97000000-0000-4000-8000-000000000001', 'pi_delivery', 'release-authorization-0001', 'policy-v1',
      '0x5656565656565656565656565656565656565656565656565656565656565656', now(), 'operator:test'
    );
    raise exception 'unresolved non-actionable EFW authorized release';
  exception when others then
    if sqlerrm <> 'payment_risk_not_cleared' then raise; end if;
  end;
end;
$$;

do $$
begin
  if not (select actionable from public.auction_payment_risk_signals where provider_object_ref = 'iss_delivery') then
    raise exception 'non-actionable EFW did not remain blocking';
  end if;
end;
$$;

select public.resolve_auction_early_fraud_warning(
  '97000000-0000-4000-8000-000000000001', 'pi_delivery', 'iss_delivery',
  'provider-resolution-0001',
  '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  now(), 'operator:test'
);
select public.resolve_auction_early_fraud_warning(
  '97000000-0000-4000-8000-000000000001', 'pi_delivery', 'iss_delivery',
  'provider-resolution-0001',
  '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  now(), 'operator:test'
);

select public.authorize_auction_delivery(
  '97000000-0000-4000-8000-000000000001', 'pi_delivery', 'release-authorization-0001', 'policy-v1',
  '0x5656565656565656565656565656565656565656565656565656565656565656', now(), 'operator:test'
);
select public.authorize_auction_delivery(
  '97000000-0000-4000-8000-000000000001', 'pi_delivery', 'release-authorization-0001', 'policy-v1',
  '0x5656565656565656565656565656565656565656565656565656565656565656', now(), 'operator:test'
);

select public.apply_stripe_auction_risk_event(
  'evt_delivery_efw', 'radar.early_fraud_warning.created',
  '97000000-0000-4000-8000-000000000001', 'pi_delivery_prior', 'iss_delivery_late',
  'early-fraud-warning', false, 'not-actionable', now(), '{"source":"test"}'::jsonb
);

do $$
begin
  begin
    perform public.claim_auction_delivery(
      '97000000-0000-4000-8000-000000000001', 11155111, 'ERC721',
      '0x1111111111111111111111111111111111111111', 7, 1,
      '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333', 0,
      '0x6767676767676767676767676767676767676767676767676767676767676767',
      '0x7878787878787878787878787878787878787878787878787878787878787878',
      200, '0x8989898989898989898989898989898989898989898989898989898989898989'
    );
    raise exception 'late unresolved EFW allowed delivery claim';
  exception when others then
    if sqlerrm <> 'settlement_not_release_ready' then raise; end if;
  end;
end;
$$;

select public.resolve_auction_early_fraud_warning(
  '97000000-0000-4000-8000-000000000001', 'pi_delivery_prior', 'iss_delivery_late',
  'provider-resolution-0002',
  '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2',
  now(), 'operator:test'
);

select public.authorize_auction_delivery(
  '97000000-0000-4000-8000-000000000001', 'pi_delivery', 'release-authorization-0002', 'policy-v1',
  '0x5757575757575757575757575757575757575757575757575757575757575757', now(), 'operator:test'
);

select public.claim_auction_delivery(
  '97000000-0000-4000-8000-000000000001', 11155111, 'ERC721',
  '0x1111111111111111111111111111111111111111', 7, 1,
  '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333', 0,
  '0x6767676767676767676767676767676767676767676767676767676767676767',
  '0x7878787878787878787878787878787878787878787878787878787878787878',
  200, '0x8989898989898989898989898989898989898989898989898989898989898989'
);
select public.claim_auction_delivery(
  '97000000-0000-4000-8000-000000000001', 11155111, 'ERC721',
  '0x1111111111111111111111111111111111111111', 7, 1,
  '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333', 0,
  '0x6767676767676767676767676767676767676767676767676767676767676767',
  '0x7878787878787878787878787878787878787878787878787878787878787878',
  200, '0x8989898989898989898989898989898989898989898989898989898989898989'
);

do $$
begin
  begin
    perform public.claim_auction_delivery(
      '97000000-0000-4000-8000-000000000001', 11155111, 'ERC721',
      '0x1111111111111111111111111111111111111111', 7, 1,
      '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333', 1,
      '0x6767676767676767676767676767676767676767676767676767676767676767',
      '0x7878787878787878787878787878787878787878787878787878787878787878',
      200, '0x8989898989898989898989898989898989898989898989898989898989898989'
    );
    raise exception 'conflicting delivery claim was accepted';
  exception when others then
    if sqlerrm <> 'delivery_claim_conflict' then raise; end if;
  end;
end;
$$;

do $$
begin
  begin
    update public.chain_deliveries
    set call_data_hash = '0x9999999999999999999999999999999999999999999999999999999999999999'
    where settlement_id = '97000000-0000-4000-8000-000000000001';
    raise exception 'delivery evidence was mutable';
  exception when others then
    if sqlerrm <> 'delivery_evidence_immutable' then raise; end if;
  end;
end;
$$;

select public.record_auction_delivery_inclusion(
  '97000000-0000-4000-8000-000000000001',
  '0x6767676767676767676767676767676767676767676767676767676767676767',
  '0x9090909090909090909090909090909090909090909090909090909090909090',
  205, '0x9191919191919191919191919191919191919191919191919191919191919191', 4
);
select public.finalize_auction_delivery(
  '97000000-0000-4000-8000-000000000001',
  '0x6767676767676767676767676767676767676767676767676767676767676767',
  '0x9090909090909090909090909090909090909090909090909090909090909090',
  205, '0x9191919191919191919191919191919191919191919191919191919191919191',
  210, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);

do $$
begin
  if (select state from public.chain_deliveries where settlement_id = '97000000-0000-4000-8000-000000000001') <> 'finalized'
     or (select state from public.auction_settlements where id = '97000000-0000-4000-8000-000000000001') <> 'fulfilled'
     or (select state from public.auctions where id = '95000000-0000-4000-8000-000000000001') <> 'settled'
     or (select inventory_available from public.works where id = '93000000-0000-4000-8000-000000000001') <> 0
     or (select nft_custody_state from public.works where id = '93000000-0000-4000-8000-000000000001') <> 'transferred' then
    raise exception 'delivery finalization was not atomic';
  end if;
  if exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name in ('authorize_auction_delivery', 'claim_auction_delivery', 'finalize_auction_delivery')
      and grantee in ('PUBLIC', 'anon', 'authenticated') and privilege_type = 'EXECUTE'
  ) then raise exception 'delivery RPC is browser executable'; end if;
end;
$$;

rollback;

begin;

do $$
begin
  if has_table_privilege('anon', 'public.resale_indexer_leases', 'select')
     or has_table_privilege('authenticated', 'public.resale_indexer_leases', 'select') then
    raise exception 'resale indexer leases must remain private';
  end if;
  if has_function_privilege(
    'anon',
    'public.apply_resale_indexer_batch(text,bigint,uuid,bigint,bigint,text,text,bigint,text,bigint,text,jsonb)',
    'execute'
  ) then
    raise exception 'anonymous callers must not advance the resale indexer';
  end if;
end;
$$;

select public.claim_resale_indexer_lease(
  'resale-finalized-test', 11155111,
  '10000000-0000-4000-8000-000000000001'::uuid, 240
);

do $$
begin
  if public.claim_resale_indexer_lease(
    'resale-finalized-test', 11155111,
    '10000000-0000-4000-8000-000000000002'::uuid, 240
  ) then
    raise exception 'a second worker acquired an active resale indexer lease';
  end if;
end;
$$;

do $$
declare
  result jsonb;
begin
  result := public.apply_resale_indexer_batch(
    'resale-finalized-test',
    11155111,
    '10000000-0000-4000-8000-000000000001'::uuid,
    100,
    100,
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    null,
    100,
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    101,
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    jsonb_build_array(
      jsonb_build_object(
        'event_name', 'CounterIncremented',
        'emitter_address', '0x0000000000000068f116a894984e2db1123eb395',
        'topic0', '0x721c20121297512b72821b97f5326877ea8ecf4bb9948fea5bfcb6453074d37f',
        'transaction_hash', '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        'transaction_index', 0,
        'log_index', 0,
        'block_number', 100,
        'block_hash', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'removed', false,
        'from_address', '0x1111111111111111111111111111111111111111',
        'counter', 1,
        'event_data', '{}'::jsonb,
        'payload_hash', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      ),
      jsonb_build_object(
        'event_name', 'CounterIncremented',
        'emitter_address', '0x0000000000000068f116a894984e2db1123eb395',
        'topic0', '0x721c20121297512b72821b97f5326877ea8ecf4bb9948fea5bfcb6453074d37f',
        'transaction_hash', '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        'transaction_index', 0,
        'log_index', 0,
        'block_number', 100,
        'block_hash', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'removed', false,
        'from_address', '0x1111111111111111111111111111111111111111',
        'counter', 1,
        'event_data', '{}'::jsonb,
        'payload_hash', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      )
    )
  );
  if (result ->> 'events_inserted')::integer <> 1 then
    raise exception 'duplicate chain evidence was not idempotent';
  end if;
end;
$$;

do $$
begin
  perform public.apply_resale_indexer_batch(
    'resale-finalized-test',
    11155111,
    '10000000-0000-4000-8000-000000000001'::uuid,
    100,
    101,
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    101,
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    101,
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    jsonb_build_array(
      jsonb_build_object(
        'event_name', 'CounterIncremented',
        'emitter_address', '0x0000000000000068f116a894984e2db1123eb395',
        'topic0', '0x721c20121297512b72821b97f5326877ea8ecf4bb9948fea5bfcb6453074d37f',
        'transaction_hash', '0xabababababababababababababababababababababababababababababababab',
        'transaction_index', 0, 'log_index', 0, 'block_number', 101,
        'block_hash', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'removed', false, 'from_address', '0x1111111111111111111111111111111111111111',
        'counter', 2, 'event_data', '{}'::jsonb,
        'payload_hash', '0xacacacacacacacacacacacacacacacacacacacacacacacacacacacacacacacac'
      ),
      jsonb_build_object(
        'event_name', 'CounterIncremented',
        'emitter_address', '0x0000000000000068f116a894984e2db1123eb395',
        'topic0', '0x721c20121297512b72821b97f5326877ea8ecf4bb9948fea5bfcb6453074d37f',
        'transaction_hash', '0xabababababababababababababababababababababababababababababababab',
        'transaction_index', 0, 'log_index', 0, 'block_number', 101,
        'block_hash', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'removed', false, 'from_address', '0x1111111111111111111111111111111111111111',
        'counter', 2, 'event_data', '{}'::jsonb,
        'payload_hash', '0xadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadadad'
      )
    )
  );
  raise exception 'conflicting chain evidence was accepted';
exception
  when others then
    if sqlerrm not like '%resale_indexer_event_evidence_conflict%' then
      raise;
    end if;
end;
$$;

do $$
begin
  perform public.apply_resale_indexer_batch(
    'resale-finalized-test',
    11155111,
    '10000000-0000-4000-8000-000000000001'::uuid,
    100,
    102,
    '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    102,
    '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    102,
    '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    '[]'::jsonb
  );
  raise exception 'a discontinuous indexer batch was accepted';
exception
  when others then
    if sqlerrm not like '%resale_indexer_checkpoint_discontinuity%' then
      raise;
    end if;
end;
$$;

insert into auth.users (id) values
  ('20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002');

insert into public.nft_collections (
  id, standard, chain_id, contract_address, deployed_code_hash, inventory_safe,
  deployment_tx_hash, deployment_block, contract_version, state
) values (
  '21000000-0000-4000-8000-000000000001', 'ERC721', 11155111,
  '0x2222222222222222222222222222222222222222',
  '0x1212121212121212121212121212121212121212121212121212121212121212',
  '0x9999999999999999999999999999999999999999',
  '0x1313131313131313131313131313131313131313131313131313131313131313',
  99, 'test', 'rehearsal'
);

insert into public.works (
  id, slug, artist_name, title, format, media_url, sale_kind,
  inventory_total, inventory_available, status, contract_status,
  nft_collection_id, nft_work_id, nft_token_id, nft_quantity,
  nft_custody_state, nft_mint_tx_hash, nft_mint_block, nft_finalized_at
) values
  (
    '22000000-0000-4000-8000-000000000001', 'secondary-fill', 'Artist', 'Fill',
    'digital', 'https://example.test/fill.jpg', 'auction', 1, 0, 'sold', 'minted',
    '21000000-0000-4000-8000-000000000001',
    '0x1414141414141414141414141414141414141414141414141414141414141414', 7, 1,
    'transferred', '0x1515151515151515151515151515151515151515151515151515151515151515', 99, now()
  ),
  (
    '22000000-0000-4000-8000-000000000002', 'secondary-cancel', 'Artist', 'Cancel',
    'digital', 'https://example.test/cancel.jpg', 'auction', 1, 0, 'sold', 'minted',
    '21000000-0000-4000-8000-000000000001',
    '0x1616161616161616161616161616161616161616161616161616161616161616', 8, 1,
    'transferred', '0x1717171717171717171717171717171717171717171717171717171717171717', 99, now()
  ),
  (
    '22000000-0000-4000-8000-000000000003', 'secondary-counter', 'Artist', 'Counter',
    'digital', 'https://example.test/counter.jpg', 'auction', 1, 0, 'sold', 'minted',
    '21000000-0000-4000-8000-000000000001',
    '0x1818181818181818181818181818181818181818181818181818181818181818', 9, 1,
    'transferred', '0x1919191919191919191919191919191919191919191919191919191919191919', 99, now()
  );

insert into public.smart_accounts (
  id, user_id, chain_id, account_address, safe_version, module_version,
  entry_point_address, factory_address, code_hash, signer_count, threshold,
  recovery_ready, state, deployment_block, finalized_at
) values
  (
    '23000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001', 11155111,
    '0x3333333333333333333333333333333333333333', '1.4.1', '0.3.0',
    '0x7777777777777777777777777777777777777777',
    '0x8888888888888888888888888888888888888888',
    '0x2020202020202020202020202020202020202020202020202020202020202020',
    2, 1, true, 'recovery-ready', 99, now()
  ),
  (
    '23000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002', 11155111,
    '0x4444444444444444444444444444444444444444', '1.4.1', '0.3.0',
    '0x7777777777777777777777777777777777777777',
    '0x8888888888888888888888888888888888888888',
    '0x2020202020202020202020202020202020202020202020202020202020202020',
    2, 1, true, 'recovery-ready', 99, now()
  );

insert into public.token_ownership_projection (
  chain_id, collection_id, collection_address, token_id, work_id,
  owner_address, owner_smart_account_id, ownership_state, finality,
  source_kind, source_checkpoint_id, observed_block_number, observed_block_hash
) values
  (
    11155111, '21000000-0000-4000-8000-000000000001',
    '0x2222222222222222222222222222222222222222', 7,
    '22000000-0000-4000-8000-000000000001',
    '0x3333333333333333333333333333333333333333',
    '23000000-0000-4000-8000-000000000001', 'owned', 'finalized', 'snapshot',
    (select id from public.chain_indexer_checkpoints where worker_name = 'resale-finalized-test' and through_block_number = 100),
    100, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ),
  (
    11155111, '21000000-0000-4000-8000-000000000001',
    '0x2222222222222222222222222222222222222222', 8,
    '22000000-0000-4000-8000-000000000002',
    '0x3333333333333333333333333333333333333333',
    '23000000-0000-4000-8000-000000000001', 'owned', 'finalized', 'snapshot',
    (select id from public.chain_indexer_checkpoints where worker_name = 'resale-finalized-test' and through_block_number = 100),
    100, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ),
  (
    11155111, '21000000-0000-4000-8000-000000000001',
    '0x2222222222222222222222222222222222222222', 9,
    '22000000-0000-4000-8000-000000000003',
    '0x3333333333333333333333333333333333333333',
    '23000000-0000-4000-8000-000000000001', 'owned', 'finalized', 'snapshot',
    (select id from public.chain_indexer_checkpoints where worker_name = 'resale-finalized-test' and through_block_number = 100),
    100, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );

insert into public.resale_orders (
  id, work_id, collection_id, seller_user_id, seller_smart_account_id,
  chain_id, collection_address, token_id, seller_address, currency_address,
  gross_amount, seller_proceeds_recipient, seller_proceeds_amount,
  royalty_recipient, royalty_amount, marketplace_fee_recipient, marketplace_fee_amount,
  start_time_epoch, end_time_epoch, salt, counter, order_hash, signature,
  order_components, validation_policy_version, validation_evidence_hash,
  validated_block_number, validated_block_hash, validated_at,
  approval_evidence_hash, approval_verified_block_number,
  approval_verified_block_hash, approval_verified_at, terms_version, terms_hash
) values
  (
    '24000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001',
    '21000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000001', 11155111,
    '0x2222222222222222222222222222222222222222', 7,
    '0x3333333333333333333333333333333333333333',
    '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', 1000000,
    '0x3333333333333333333333333333333333333333', 1000000,
    '0x0000000000000000000000000000000000000000', 0,
    '0x0000000000000000000000000000000000000000', 0,
    extract(epoch from now() - interval '1 minute')::bigint,
    extract(epoch from now() + interval '1 hour')::bigint,
    1, 0, '0x5151515151515151515151515151515151515151515151515151515151515151',
    decode('01', 'hex'), '{}'::jsonb, 'test',
    '0x5252525252525252525252525252525252525252525252525252525252525252',
    100, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(),
    '0x5353535353535353535353535353535353535353535353535353535353535353',
    100, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(),
    'test', '0x5454545454545454545454545454545454545454545454545454545454545454'
  ),
  (
    '24000000-0000-4000-8000-000000000002',
    '22000000-0000-4000-8000-000000000002',
    '21000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000001', 11155111,
    '0x2222222222222222222222222222222222222222', 8,
    '0x3333333333333333333333333333333333333333',
    '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', 1000000,
    '0x3333333333333333333333333333333333333333', 1000000,
    '0x0000000000000000000000000000000000000000', 0,
    '0x0000000000000000000000000000000000000000', 0,
    extract(epoch from now() - interval '1 minute')::bigint,
    extract(epoch from now() + interval '1 hour')::bigint,
    2, 0, '0x6161616161616161616161616161616161616161616161616161616161616161',
    decode('01', 'hex'), '{}'::jsonb, 'test',
    '0x6262626262626262626262626262626262626262626262626262626262626262',
    100, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(),
    '0x6363636363636363636363636363636363636363636363636363636363636363',
    100, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(),
    'test', '0x6464646464646464646464646464646464646464646464646464646464646464'
  ),
  (
    '24000000-0000-4000-8000-000000000003',
    '22000000-0000-4000-8000-000000000003',
    '21000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000001', 11155111,
    '0x2222222222222222222222222222222222222222', 9,
    '0x3333333333333333333333333333333333333333',
    '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', 1000000,
    '0x3333333333333333333333333333333333333333', 1000000,
    '0x0000000000000000000000000000000000000000', 0,
    '0x0000000000000000000000000000000000000000', 0,
    extract(epoch from now() - interval '1 minute')::bigint,
    extract(epoch from now() + interval '1 hour')::bigint,
    3, 0, '0x7171717171717171717171717171717171717171717171717171717171717171',
    decode('01', 'hex'), '{}'::jsonb, 'test',
    '0x7272727272727272727272727272727272727272727272727272727272727272',
    100, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(),
    '0x7373737373737373737373737373737373737373737373737373737373737373',
    100, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(),
    'test', '0x7474747474747474747474747474747474747474747474747474747474747474'
  );

do $$
declare
  result jsonb;
begin
  result := public.apply_resale_indexer_batch(
    'resale-finalized-test',
    11155111,
    '10000000-0000-4000-8000-000000000001'::uuid,
    100,
    101,
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    101,
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    101,
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    jsonb_build_array(
      jsonb_build_object(
        'event_name', 'Transfer', 'emitter_address', '0x2222222222222222222222222222222222222222',
        'topic0', '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        'transaction_hash', '0x7676767676767676767676767676767676767676767676767676767676767676',
        'transaction_index', 0, 'log_index', 0, 'block_number', 101,
        'block_hash', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'removed', false, 'token_id', 7,
        'from_address', '0x3333333333333333333333333333333333333333',
        'to_address', '0x4444444444444444444444444444444444444444',
        'event_data', '{}'::jsonb,
        'payload_hash', '0x7777777777777777777777777777777777777777777777777777777777777777'
      ),
      jsonb_build_object(
        'event_name', 'OrderFulfilled', 'emitter_address', '0x0000000000000068f116a894984e2db1123eb395',
        'topic0', '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31',
        'transaction_hash', '0x7676767676767676767676767676767676767676767676767676767676767676',
        'transaction_index', 0, 'log_index', 1, 'block_number', 101,
        'block_hash', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'removed', false,
        'order_hash', '0x5151515151515151515151515151515151515151515151515151515151515151',
        'from_address', '0x3333333333333333333333333333333333333333',
        'to_address', '0x4444444444444444444444444444444444444444',
        'event_data', '{}'::jsonb,
        'payload_hash', '0x7979797979797979797979797979797979797979797979797979797979797979'
      ),
      jsonb_build_object(
        'event_name', 'OrderCancelled', 'emitter_address', '0x0000000000000068f116a894984e2db1123eb395',
        'topic0', '0x6bacc01dbe442496068f7d234edd811f1a5f833243e0aec824f86ab861f3c90d',
        'transaction_hash', '0x8181818181818181818181818181818181818181818181818181818181818181',
        'transaction_index', 1, 'log_index', 0, 'block_number', 101,
        'block_hash', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'removed', false,
        'order_hash', '0x6161616161616161616161616161616161616161616161616161616161616161',
        'from_address', '0x3333333333333333333333333333333333333333',
        'event_data', '{}'::jsonb,
        'payload_hash', '0x8282828282828282828282828282828282828282828282828282828282828282'
      ),
      jsonb_build_object(
        'event_name', 'CounterIncremented', 'emitter_address', '0x0000000000000068f116a894984e2db1123eb395',
        'topic0', '0x721c20121297512b72821b97f5326877ea8ecf4bb9948fea5bfcb6453074d37f',
        'transaction_hash', '0x8484848484848484848484848484848484848484848484848484848484848484',
        'transaction_index', 2, 'log_index', 0, 'block_number', 101,
        'block_hash', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'removed', false,
        'from_address', '0x3333333333333333333333333333333333333333', 'counter', 1,
        'event_data', '{}'::jsonb,
        'payload_hash', '0x8585858585858585858585858585858585858585858585858585858585858585'
      )
    )
  );
  if (result ->> 'fills_finalized')::integer <> 1
     or (result ->> 'ownership_updates')::integer <> 1
     or (result ->> 'orders_cancelled')::integer <> 1
     or (result ->> 'orders_invalidated')::integer <> 1 then
    raise exception 'resale finalized event reconciliation counts were incorrect: %', result;
  end if;
end;
$$;

do $$
begin
  if (select state from public.resale_orders where id = '24000000-0000-4000-8000-000000000001') <> 'finalized'
     or (select state from public.resale_orders where id = '24000000-0000-4000-8000-000000000002') <> 'cancelled'
     or (select state from public.resale_orders where id = '24000000-0000-4000-8000-000000000003') <> 'invalidated'
     or (select state from public.resale_fills where resale_order_id = '24000000-0000-4000-8000-000000000001') <> 'finalized'
     or (select owner_address from public.token_ownership_projection where work_id = '22000000-0000-4000-8000-000000000001')
       <> '0x4444444444444444444444444444444444444444' then
    raise exception 'resale finalized event reconciliation did not converge';
  end if;
end;
$$;

do $$
begin
  -- Pending fill submission remains reserved even after its order end time;
  -- it may already be mined above the finalized head.
  update public.resale_orders
  set state = 'exception', closed_at = null
  where id = '24000000-0000-4000-8000-000000000003';
  update public.resale_orders
  set state = 'fill-submitted'
  where id = '24000000-0000-4000-8000-000000000003';

  perform public.expire_resale_orders_at_finalized_head(
    'resale-finalized-test',
    11155111,
    '10000000-0000-4000-8000-000000000001'::uuid,
    101,
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    now() + interval '2 hours'
  );
  if (select state from public.resale_orders where id = '24000000-0000-4000-8000-000000000003')
     <> 'fill-submitted' then
    raise exception 'expiry closed an order with an unresolved fill submission';
  end if;
end;
$$;

-- Owner exit and listing publication are serialized around the same token.
-- The local SQL harness supplies the Supabase role claim used by service-only
-- RPCs; hosted Supabase provides this function itself.
create or replace function auth.role()
returns text
language sql
stable
as $$ select 'service_role'::text $$;

do $$
declare
  transfer_decision public.sponsorship_decisions%rowtype;
  transfer_policy jsonb;
begin
  transfer_policy := jsonb_build_object(
    'schema', 'secondary-userop-v1',
    'chain_id', 11155111,
    'client_request_key', 'owner-exit-request-00000001',
    'valid_after', pg_catalog.date_part('epoch', pg_catalog.now())::bigint - 60,
    'valid_until', pg_catalog.date_part('epoch', pg_catalog.now())::bigint + 3600,
    'reference', jsonb_build_object(
      'work_id', '22000000-0000-4000-8000-000000000002',
      'collection_id', '21000000-0000-4000-8000-000000000001',
      'collection_address', '0x2222222222222222222222222222222222222222',
      'token_id', '8',
      'from_address', '0x3333333333333333333333333333333333333333',
      'recipient_address', '0x5555555555555555555555555555555555555555'
    ),
    'expected_call', jsonb_build_object(
      'to', '0x2222222222222222222222222222222222222222',
      'from_address', '0x3333333333333333333333333333333333333333',
      'recipient_address', '0x5555555555555555555555555555555555555555',
      'token_id', '8'
    ),
    'user_operation', jsonb_build_object(
      'sender', '0x3333333333333333333333333333333333333333',
      'callData', '0x1234'
    )
  );

  select * into transfer_decision from public.reserve_secondary_sponsorship(
    'owner-exit-ledger-000000000001', 'owner-exit-request-00000001',
    '20000000-0000-4000-8000-000000000001'::uuid,
    '23000000-0000-4000-8000-000000000001'::uuid,
    'marketplace-transfer', 'test-policy',
    '0x2222222222222222222222222222222222222222', '0x42842e0e',
    1, transfer_policy, 1, 2, 3, 'test-provider'
  );
  if transfer_decision.decision <> 'approved' then
    raise exception 'owner exit was not reserved';
  end if;

  begin
    update public.resale_orders set state = 'open', closed_at = null
      where id = '24000000-0000-4000-8000-000000000002';
    raise exception 'listing reopened while owner exit was active';
  exception
    when others then
      if sqlerrm not like '%resale_listing_owner_exit_conflict%' then
        raise;
      end if;
  end;

  perform public.record_secondary_userop_submission(
    transfer_decision.id,
    '20000000-0000-4000-8000-000000000001'::uuid,
    '0x8686868686868686868686868686868686868686868686868686868686868686',
    '0x8787878787878787878787878787878787878787878787878787878787878787',
    jsonb_build_object('sender', '0x3333333333333333333333333333333333333333', 'callData', '0x1234', 'signature', '0x01')
  );
  if (select decision from public.sponsorship_decisions where id = transfer_decision.id) <> 'submitted' then
    raise exception 'owner exit durable outbox was not submitted';
  end if;

  begin
    perform public.reserve_secondary_sponsorship(
      'owner-exit-ledger-000000000002', 'owner-exit-request-00000002',
      '20000000-0000-4000-8000-000000000001'::uuid,
      '23000000-0000-4000-8000-000000000001'::uuid,
      'marketplace-transfer', 'test-policy',
      '0x2222222222222222222222222222222222222222', '0x42842e0e',
      1,
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(transfer_policy, '{client_request_key}', '"owner-exit-request-00000002"'::jsonb),
          '{reference,work_id}', '"22000000-0000-4000-8000-000000000003"'::jsonb
        ),
        '{reference,token_id}', '"9"'::jsonb
      ) || jsonb_build_object(
        'expected_call', pg_catalog.jsonb_set(transfer_policy->'expected_call', '{token_id}', '"9"'::jsonb)
      ),
      1, 2, 3, 'test-provider'
    );
    raise exception 'owner exit reserved a token with unresolved resale state';
  exception
    when others then
      if sqlerrm not like '%sponsorship_transfer_listing_conflict%' then
        raise;
      end if;
  end;
end;
$$;

select public.release_resale_indexer_lease(
  'resale-finalized-test', 11155111,
  '10000000-0000-4000-8000-000000000001'::uuid
);

rollback;

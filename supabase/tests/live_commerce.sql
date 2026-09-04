\set ON_ERROR_STOP on

begin;

insert into auth.users (id, raw_user_meta_data, raw_app_meta_data)
values (
  '00000000-0000-4000-8000-000000000001',
  '{"name":"Test Buyer"}',
  '{"provider":"x"}'
);

insert into public.sellers (id, display_name, status, terms_version, terms_accepted_at)
values ('00000000-0000-4000-8000-000000000010', 'Test Artist', 'active', '2026-09', now());

insert into public.works (
  id, slug, artist_name, title, format, media_url, price_minor, currency, location, status, listed_at,
  seller_id, sale_enabled, sale_kind, inventory_total, inventory_available, requires_shipping,
  stripe_tax_code, stripe_shipping_rate_id, buyer_terms_url, buyer_terms_version, license_uri
) values (
  '00000000-0000-4000-8000-000000000020', 'verified-physical-work', 'Test Artist', 'Verified Work',
  'physical', 'https://example.test/work.jpg', 10000, 'USD', 'Brooklyn', 'listed', now(),
  '00000000-0000-4000-8000-000000000010', true, 'fixed', 1, 1, true,
  'txcd_99999999', 'shr_test_domestic', 'https://example.test/terms', 'work-terms-v1', 'https://example.test/license'
), (
  '00000000-0000-4000-8000-000000000021', 'archived-during-checkout', 'Test Artist', 'Archived Work',
  'physical', 'https://example.test/archive.jpg', 20000, 'USD', 'Brooklyn', 'listed', now(),
  '00000000-0000-4000-8000-000000000010', true, 'fixed', 1, 1, true,
  'txcd_99999999', 'shr_test_domestic', 'https://example.test/terms', 'work-terms-v1', 'https://example.test/license'
);

insert into public.rights_assertions (work_id, seller_id, assertion_type, status, reviewed_at)
select work_id, '00000000-0000-4000-8000-000000000010', assertion_type, 'cleared', now()
from (values
  ('00000000-0000-4000-8000-000000000020'::uuid),
  ('00000000-0000-4000-8000-000000000021'::uuid)
) works(work_id)
cross join (values ('sale'), ('media'), ('physical-fulfillment')) assertions(assertion_type);

do $$
declare
  first_reservation jsonb;
  repeated_reservation jsonb;
  archived_reservation jsonb;
  result text;
begin
  first_reservation := public.reserve_card_checkout(
    '00000000-0000-4000-8000-000000000020',
    '00000000-0000-4000-8000-000000000001',
    'checkout-test-key-00000001',
    '2026-09',
    'https://example.test/terms',
    'work-terms-v1',
    1000000,
    now() + interval '35 minutes'
  );
  repeated_reservation := public.reserve_card_checkout(
    '00000000-0000-4000-8000-000000000020',
    '00000000-0000-4000-8000-000000000001',
    'checkout-test-key-00000001',
    '2026-09',
    'https://example.test/terms',
    'work-terms-v1',
    1000000,
    now() + interval '35 minutes'
  );
  if first_reservation ->> 'acquisition_id' <> repeated_reservation ->> 'acquisition_id' then
    raise exception 'idempotent reservation returned a different acquisition';
  end if;
  if (select inventory_available from public.works where slug = 'verified-physical-work') <> 0 then
    raise exception 'inventory was not reserved exactly once';
  end if;

  perform public.attach_card_checkout((first_reservation ->> 'acquisition_id')::uuid, 'cs_test_verified');
  result := public.apply_stripe_financial_event(
    'evt_refund', 'refund.created', (first_reservation ->> 'acquisition_id')::uuid,
    'pi_test_verified', 're_test_verified', 'succeeded', 11000, 'usd', '{"source":"sql-test","attempt":"early"}'
  );
  if result <> 'retry' then raise exception 'early financial event was not retained for retry'; end if;
  result := public.apply_stripe_checkout_event(
    'evt_checkout_paid', 'checkout.session.async_payment_succeeded',
    (first_reservation ->> 'acquisition_id')::uuid, 'cs_test_verified', 'pi_test_verified', 'paid',
    'buyer@example.test', 10999, 9999, 1000, 0, 'usd', 'payment', true, 'accepted',
    '{"source":"sql-test","attempt":"invalid"}'
  );
  if result <> 'ignored' then raise exception 'invalid paid event was not rejected'; end if;
  result := public.apply_stripe_checkout_event(
    'evt_checkout_paid', 'checkout.session.async_payment_succeeded',
    (first_reservation ->> 'acquisition_id')::uuid, 'cs_test_verified', 'pi_test_verified', 'paid',
    'buyer@example.test', 11000, 10000, 1000, 0, 'usd', 'payment', true, 'accepted',
    '{"source":"sql-test"}'
  );
  if result <> 'processed' then raise exception 'paid event was not processed'; end if;
  if public.apply_stripe_checkout_event(
    'evt_checkout_paid', 'checkout.session.async_payment_succeeded',
    (first_reservation ->> 'acquisition_id')::uuid, 'cs_test_verified', 'pi_test_verified', 'paid',
    'buyer@example.test', 11000, 10000, 1000, 0, 'usd', 'payment', true, 'accepted',
    '{"source":"sql-test"}'
  ) <> 'duplicate' then raise exception 'duplicate event was not idempotent'; end if;

  result := public.apply_stripe_financial_event(
    'evt_refund', 'refund.created', (first_reservation ->> 'acquisition_id')::uuid,
    'pi_test_verified', 're_test_verified', 'succeeded', 11000, 'usd', '{"source":"sql-test"}'
  );
  if result <> 'processed' then raise exception 'refund event was not processed'; end if;
  if (select state from public.acquisitions where id = (first_reservation ->> 'acquisition_id')::uuid) <> 'refunded' then
    raise exception 'full refund did not update authoritative state';
  end if;
  result := public.apply_stripe_financial_event(
    'evt_dispute_open_after_refund', 'charge.dispute.created', (first_reservation ->> 'acquisition_id')::uuid,
    'pi_test_verified', 'dp_test_verified', 'warning_needs_response', 11000, 'usd', '{"source":"sql-test"}'
  );
  if result <> 'processed' then raise exception 'dispute inquiry was not processed'; end if;
  result := public.apply_stripe_financial_event(
    'evt_dispute_warning_closed', 'charge.dispute.closed', (first_reservation ->> 'acquisition_id')::uuid,
    'pi_test_verified', 'dp_test_verified', 'warning_closed', 11000, 'usd', '{"source":"sql-test"}'
  );
  if result <> 'processed' then raise exception 'closed dispute inquiry was not processed'; end if;
  if (select state from public.acquisitions where id = (first_reservation ->> 'acquisition_id')::uuid) <> 'refunded' then
    raise exception 'closed dispute inquiry regressed a completed refund';
  end if;
  result := public.apply_stripe_financial_event(
    'evt_dispute_prevented', 'charge.dispute.closed', (first_reservation ->> 'acquisition_id')::uuid,
    'pi_test_verified', 'dp_test_prevented', 'prevented', 11000, 'usd', '{"source":"sql-test"}'
  );
  if result <> 'processed' then raise exception 'prevented dispute was not processed'; end if;
  if (select state from public.acquisitions where id = (first_reservation ->> 'acquisition_id')::uuid) <> 'refunded' then
    raise exception 'prevented dispute regressed a completed refund';
  end if;

  archived_reservation := public.reserve_card_checkout(
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',
    'checkout-test-key-00000002',
    '2026-09',
    'https://example.test/terms',
    'work-terms-v1',
    1000000,
    now() + interval '35 minutes'
  );
  perform public.attach_card_checkout((archived_reservation ->> 'acquisition_id')::uuid, 'cs_test_archived');
  update public.works set status = 'archived', sale_enabled = false where slug = 'archived-during-checkout';
  perform public.apply_stripe_checkout_event(
    'evt_checkout_expired', 'checkout.session.expired',
    (archived_reservation ->> 'acquisition_id')::uuid, 'cs_test_archived', null, 'unpaid',
    null, 20000, 20000, 0, 0, 'usd', 'payment', true, null, '{"source":"sql-test"}'
  );
  if (select status from public.works where slug = 'archived-during-checkout') <> 'archived' then
    raise exception 'expiry republished an archived work';
  end if;
end;
$$;

rollback;

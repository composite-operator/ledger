-- Backfill the original SPY MARKET test that was submitted before live-quote
-- activation existed. Preserve its immutable reference entry and record the
-- verified Yahoo quote as the operational current price.

begin;

with target as (
  select s.id, s.entry
  from public.setups s
  join public.profiles p on p.id = s.user_id
  where p.handle = 'daft'
    and s.ticker = 'SPY'
    and s.trigger_type = 'MARKET'
    and s.status = 'QUEUED'
    and s.entry = 777.77
  order by s.submitted_at desc
  limit 1
), activated as (
  update public.setups s
  set status = 'ACTIVE',
      current_price = 777.88,
      price_source = 'YAHOO_FINANCE',
      triggered_at = now(),
      updated_at = now()
  from target
  where s.id = target.id
  returning s.id, s.entry, s.triggered_at
)
insert into public.setup_events (setup_id, event_type, event_at, price, payload, created_by)
select
  id,
  'MARKET_VERIFIED_AND_ACTIVATED',
  triggered_at,
  777.88,
  jsonb_build_object(
    'source', 'YAHOO_FINANCE',
    'exchange', 'PCX',
    'currency', 'USD',
    'quoted_at', '2026-08-13T20:00:00Z',
    'submitted_reference_entry', entry,
    'verified_entry', 777.88,
    'difference_pct', abs(entry - 777.88) / 777.88 * 100,
    'tolerance_pct', 0.5,
    'backfill', true
  ),
  'VERIFIED_BACKFILL'
from activated;

commit;

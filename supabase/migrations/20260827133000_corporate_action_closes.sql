begin;

alter table public.setup_lifecycle_events
  drop constraint if exists setup_lifecycle_events_event_type_check;

alter table public.setup_lifecycle_events
  add constraint setup_lifecycle_events_event_type_check
  check (event_type = any (array[
    'LEDGER_STOP_REVISED'::text,
    'THESIS_REVIEWED'::text,
    'ENTRY_EXPIRED'::text,
    'OPERATOR_CANCELLED'::text,
    'COACH_PROMPTED'::text,
    'POSITION_MARKET_CLOSED'::text,
    'CORPORATE_ACTION_CLOSED'::text
  ]));

alter table public.setups
  drop constraint if exists setups_resolution_kind;

alter table public.setups
  add constraint setups_resolution_kind
  check (
    resolution_kind is null
    or resolution_kind = any (array[
      'TRADE'::text,
      'ENTRY_EXPIRED'::text,
      'OPERATOR_CANCELLED'::text,
      'TECHNICAL_VOID'::text,
      'CORPORATE_ACTION'::text
    ])
  );

create or replace function public.close_setup_for_corporate_action(
  p_setup_public_id uuid,
  p_exit_price numeric,
  p_price_method text,
  p_source_url text,
  p_effective_at timestamptz default now(),
  p_note text default null,
  p_chart_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target public.setups%rowtype;
  close_price numeric;
  close_time timestamptz;
  price_method text;
  source_url text;
  risk_amount numeric;
  allocation_resolved numeric;
  weighted_r numeric;
begin
  select * into target
  from public.setups
  where public_id = p_setup_public_id
  for update;

  if target.id is null then
    raise exception 'Setup not found.' using errcode = 'P0002';
  end if;
  if target.user_id <> auth.uid() then
    raise exception 'Only the setup author can resolve this public position.' using errcode = '42501';
  end if;
  if target.status not in ('ACTIVE', 'T1_HIT', 'T2_HIT') or target.triggered_at is null or target.resolved_at is not null then
    raise exception 'Only an open, triggered setup can receive a corporate-action close.' using errcode = '22000';
  end if;
  if p_chart_path is not null and p_chart_path !~ ('^' || auth.uid()::text || '/ledger-media/setups/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    raise exception 'The review chart path is invalid.' using errcode = '22000';
  end if;

  close_price := p_exit_price;
  if close_price is null or close_price <= 0 then
    raise exception 'A positive documented exit price is required.' using errcode = '22000';
  end if;

  price_method := upper(trim(coalesce(p_price_method, '')));
  if price_method not in ('FINAL_EXCHANGE_CLOSE', 'CASH_CONSIDERATION', 'STOCK_CONVERSION_VALUE', 'LAST_VERIFIED_QUOTE') then
    raise exception 'Choose a supported corporate-action pricing method.' using errcode = '22000';
  end if;

  source_url := trim(coalesce(p_source_url, ''));
  if char_length(source_url) > 2000 or source_url !~ '^https://[^[:space:]]+$' then
    raise exception 'A valid HTTPS source URL is required.' using errcode = '22000';
  end if;

  close_time := coalesce(p_effective_at, now());
  if close_time < target.triggered_at or close_time > now() + interval '5 minutes' then
    raise exception 'The corporate-action effective time is outside the active trade window.' using errcode = '22000';
  end if;

  risk_amount := abs(target.entry - target.stop);
  if risk_amount <= 0 then
    raise exception 'The original risk contract is invalid. The trade remains open.' using errcode = '22000';
  end if;

  insert into public.setup_tranche_outcomes (setup_id, tranche_number, allocation, exit_price, r_result, resolved_at)
  select
    target.id,
    tranche.tranche_number,
    tranche.allocation,
    close_price,
    case
      when target.direction = 'LONG' then (close_price - target.entry) / risk_amount
      else (target.entry - close_price) / risk_amount
    end,
    close_time
  from (values
    (1::smallint, target.t1_allocation),
    (2::smallint, target.t2_allocation),
    (3::smallint, target.t3_allocation)
  ) as tranche(tranche_number, allocation)
  where tranche.allocation > 0
    and not exists (
      select 1
      from public.setup_tranche_outcomes existing
      where existing.setup_id = target.id
        and existing.tranche_number = tranche.tranche_number
    );

  select coalesce(sum(allocation), 0), coalesce(sum(allocation * r_result), 0)
  into allocation_resolved, weighted_r
  from public.setup_tranche_outcomes
  where setup_id = target.id;

  if allocation_resolved < 0.999999 then
    raise exception 'The published tranche allocations could not be fully resolved. The trade remains open.' using errcode = '22000';
  end if;

  update public.setups
  set
    status = 'CLOSED',
    final_status = null,
    current_price = close_price,
    price_source = 'CORPORATE_ACTION:' || price_method,
    r_result = weighted_r,
    score = weighted_r,
    resolved_at = close_time,
    resolution_kind = 'CORPORATE_ACTION',
    ledger_chart_path = coalesce(p_chart_path, target.ledger_chart_path),
    review_due_at = null,
    updated_at = now()
  where id = target.id;

  insert into public.setup_events (setup_id, event_type, event_at, price, payload, created_by)
  values (
    target.id,
    'CORPORATE_ACTION_CLOSED',
    close_time,
    close_price,
    jsonb_build_object(
      'price_method', price_method,
      'source_url', source_url,
      'resolved_allocation', allocation_resolved,
      'weighted_r', weighted_r,
      'original_risk', risk_amount
    ),
    auth.uid()::text
  );

  insert into public.setup_lifecycle_events (setup_id, event_type, note, payload, created_by)
  values (
    target.id,
    'CORPORATE_ACTION_CLOSED',
    left(nullif(trim(p_note), ''), 500),
    jsonb_build_object(
      'close_price', close_price,
      'price_method', price_method,
      'source_url', source_url,
      'effective_at', close_time,
      'weighted_r', weighted_r,
      'ledger_chart_path', coalesce(p_chart_path, target.ledger_chart_path),
      'original_plan_preserved', true
    ),
    auth.uid()
  );

  return jsonb_build_object(
    'status', 'CLOSED',
    'close_price', close_price,
    'r_result', weighted_r,
    'resolved_at', close_time,
    'resolution_kind', 'CORPORATE_ACTION',
    'price_method', price_method,
    'source_url', source_url,
    'ledger_chart_path', coalesce(p_chart_path, target.ledger_chart_path)
  );
end;
$function$;

comment on function public.close_setup_for_corporate_action(uuid, numeric, text, text, timestamptz, text, text)
  is 'Resolves an open triggered setup at a documented corporate-action value while preserving prior tranche outcomes and the original plan.';

revoke all on function public.close_setup_for_corporate_action(uuid, numeric, text, text, timestamptz, text, text) from public;
revoke all on function public.close_setup_for_corporate_action(uuid, numeric, text, text, timestamptz, text, text) from anon;
grant execute on function public.close_setup_for_corporate_action(uuid, numeric, text, text, timestamptz, text, text) to authenticated;
grant execute on function public.close_setup_for_corporate_action(uuid, numeric, text, text, timestamptz, text, text) to service_role;

commit;

-- GOAT 2.0 production lifecycle contract.
-- Adds explicit entry expiry, review cadence, prospective Ledger stop revisions,
-- allocation-weighted outcomes, automated quote transitions, and versioned scoring.

begin;

alter table public.setups
  add column entry_expires_at timestamptz,
  add column review_due_at timestamptz,
  add column review_cadence_days integer,
  add column expected_holding_guide text,
  add column management_style text not null default 'FULL_T1',
  add column t1_allocation numeric(7, 6) not null default 1,
  add column t2_allocation numeric(7, 6) not null default 0,
  add column t3_allocation numeric(7, 6) not null default 0,
  add column ledger_stop numeric(24, 8),
  add column scoring_version text not null default 'LEGACY_T1_V1',
  add column resolution_kind text,
  add column discipline_debit numeric(7, 4) not null default 0,
  add column resolved_at timestamptz,
  add column expiry_reason text,
  add column void_reason text;

alter table public.setups
  add constraint setups_review_cadence_positive check (review_cadence_days is null or review_cadence_days between 1 and 366),
  add constraint setups_management_style check (management_style in ('FULL_T1', 'SCALE_PROTECT', 'CUSTOM')),
  add constraint setups_target_allocations_range check (
    t1_allocation between 0 and 1 and
    t2_allocation between 0 and 1 and
    t3_allocation between 0 and 1
  ),
  add constraint setups_target_allocations_total check (abs((t1_allocation + t2_allocation + t3_allocation) - 1) < 0.000001),
  add constraint setups_target_allocations_match_targets check (
    (t2 is not null or t2_allocation = 0) and
    (t3 is not null or t3_allocation = 0)
  ),
  add constraint setups_ledger_stop_positive check (ledger_stop is null or ledger_stop > 0),
  add constraint setups_resolution_kind check (
    resolution_kind is null or resolution_kind in ('TRADE', 'ENTRY_EXPIRED', 'OPERATOR_CANCELLED', 'TECHNICAL_VOID')
  ),
  add constraint setups_discipline_debit_nonpositive check (discipline_debit between -1 and 0),
  add constraint setups_entry_expiry_after_submit check (entry_expires_at is null or entry_expires_at > submitted_at);

update public.setups
set
  ledger_stop = stop,
  management_style = 'FULL_T1',
  t1_allocation = 1,
  t2_allocation = 0,
  t3_allocation = 0,
  scoring_version = 'LEGACY_T1_V1'
where ledger_stop is null;

alter table public.setups alter column ledger_stop set not null;

create table public.setup_lifecycle_events (
  id bigint generated always as identity primary key,
  setup_id bigint not null references public.setups(id) on delete cascade,
  event_type text not null check (event_type in (
    'LEDGER_STOP_REVISED',
    'THESIS_REVIEWED',
    'ENTRY_EXPIRED',
    'OPERATOR_CANCELLED',
    'COACH_PROMPTED'
  )),
  event_at timestamptz not null default now(),
  previous_ledger_stop numeric(24, 8),
  next_ledger_stop numeric(24, 8),
  note text,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  constraint setup_lifecycle_event_note_length check (note is null or char_length(note) <= 500)
);

create table public.setup_tranche_outcomes (
  id bigint generated always as identity primary key,
  setup_id bigint not null references public.setups(id) on delete cascade,
  tranche_number smallint not null check (tranche_number between 1 and 3),
  allocation numeric(7, 6) not null check (allocation > 0 and allocation <= 1),
  exit_price numeric(24, 8) not null check (exit_price > 0),
  r_result numeric(18, 8) not null,
  resolved_at timestamptz not null default now(),
  source_event_id bigint references public.setup_events(id) on delete set null,
  unique (setup_id, tranche_number)
);

create index setups_entry_expiry_due_idx on public.setups (entry_expires_at)
where triggered_at is null and status in ('NEW', 'QUEUED', 'WATCHING', 'NEAR', 'HOT');

create index setups_review_due_idx on public.setups (review_due_at)
where triggered_at is not null and status in ('ACTIVE', 'T1_HIT', 'T2_HIT');

create index setup_lifecycle_events_setup_time_idx on public.setup_lifecycle_events (setup_id, event_at desc);
create index setup_tranche_outcomes_setup_idx on public.setup_tranche_outcomes (setup_id, tranche_number);

create or replace function public.initialize_setup_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  validity_days integer;
  validity_max_days integer;
  base_time timestamptz;
begin
  base_time := coalesce(new.submitted_at, now());
  validity_days := case new.horizon
    when 'DAY_TRADE' then 1
    when 'SWING' then 14
    when 'POSITION' then 45
    else 180
  end;
  validity_max_days := case new.horizon
    when 'DAY_TRADE' then 7
    when 'SWING' then 28
    when 'POSITION' then 90
    else 365
  end;

  new.review_cadence_days := case new.horizon
    when 'DAY_TRADE' then 1
    when 'SWING' then 7
    when 'POSITION' then 30
    else 90
  end;
  new.expected_holding_guide := case new.horizon
    when 'DAY_TRADE' then 'Minutes to one week'
    when 'SWING' then 'Days to several months'
    when 'POSITION' then 'Months to several years'
    else 'Years or open-ended'
  end;
  new.entry_expires_at := coalesce(new.entry_expires_at, base_time + make_interval(days => validity_days));
  if new.entry_expires_at <= base_time or new.entry_expires_at > base_time + make_interval(days => validity_max_days) then
    raise exception 'Entry expiry is outside the selected horizon limit.' using errcode = '22000';
  end if;

  if new.management_style = 'FULL_T1' then
    new.t1_allocation := 1;
    new.t2_allocation := 0;
    new.t3_allocation := 0;
  end if;

  new.ledger_stop := new.stop;
  new.scoring_version := 'GOAT_V2';
  new.resolution_kind := null;
  new.discipline_debit := 0;
  if new.triggered_at is not null then
    new.review_due_at := new.triggered_at + make_interval(days => new.review_cadence_days);
  end if;
  return new;
end;
$$;

create trigger setups_initialize_lifecycle
before insert on public.setups
for each row execute function public.initialize_setup_lifecycle();

create or replace function public.prevent_setup_core_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.user_id is distinct from new.user_id
    or old.ticker is distinct from new.ticker
    or old.direction is distinct from new.direction
    or old.horizon is distinct from new.horizon
    or old.trigger_type is distinct from new.trigger_type
    or old.entry is distinct from new.entry
    or old.stop is distinct from new.stop
    or old.t1 is distinct from new.t1
    or old.t2 is distinct from new.t2
    or old.t3 is distinct from new.t3
    or old.strategy is distinct from new.strategy
    or old.thesis is distinct from new.thesis
    or old.submitted_at is distinct from new.submitted_at
    or old.entry_expires_at is distinct from new.entry_expires_at
    or old.review_cadence_days is distinct from new.review_cadence_days
    or old.expected_holding_guide is distinct from new.expected_holding_guide
    or old.management_style is distinct from new.management_style
    or old.t1_allocation is distinct from new.t1_allocation
    or old.t2_allocation is distinct from new.t2_allocation
    or old.t3_allocation is distinct from new.t3_allocation
    or old.scoring_version is distinct from new.scoring_version then
      raise exception 'Core setup fields are immutable after publication.' using errcode = '22000';
  end if;
  return new;
end;
$$;

create or replace function public.sync_setup_lifecycle_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.triggered_at is null and new.triggered_at is not null then
    new.review_due_at := new.triggered_at + make_interval(days => coalesce(new.review_cadence_days, 7));
  end if;

  if new.triggered_at is null and new.status = 'EXPIRED' and old.status <> 'EXPIRED' then
    new.resolution_kind := 'ENTRY_EXPIRED';
    new.discipline_debit := -0.10;
    new.score := -0.10;
    new.resolved_at := coalesce(new.resolved_at, now());
    new.expiry_reason := coalesce(new.expiry_reason, 'ENTRY_WINDOW_ELAPSED');
    new.final_status := 'EXPIRED';
  elsif new.triggered_at is null and new.status = 'CANCELLED' and old.status <> 'CANCELLED' then
    new.resolution_kind := 'OPERATOR_CANCELLED';
    new.discipline_debit := -0.10;
    new.score := -0.10;
    new.resolved_at := coalesce(new.resolved_at, now());
    new.final_status := 'CANCELLED';
  elsif new.triggered_at is not null and new.status in ('STOPPED', 'CLOSED', 'RESOLVED', 'T3_HIT') then
    new.resolution_kind := coalesce(new.resolution_kind, 'TRADE');
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  return new;
end;
$$;

create trigger setups_sync_lifecycle_transition
before update of status, triggered_at, resolved_at on public.setups
for each row execute function public.sync_setup_lifecycle_transition();

create or replace function public.revise_ledger_stop(p_setup_public_id uuid, p_proposed_stop numeric)
returns table (event_id bigint, effective_at timestamptz, previous_stop numeric, next_stop numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.setups%rowtype;
  prior_stop numeric;
  inserted_event public.setup_lifecycle_events%rowtype;
begin
  select * into target from public.setups where public_id = p_setup_public_id for update;
  if target.id is null then raise exception 'Setup not found.' using errcode = 'P0002'; end if;
  if target.user_id <> auth.uid() then raise exception 'Only the setup author can revise the public Ledger stop.' using errcode = '42501'; end if;
  if target.status not in ('ACTIVE', 'T1_HIT', 'T2_HIT') then raise exception 'The setup is not active.' using errcode = '22000'; end if;
  if p_proposed_stop is null or p_proposed_stop <= 0 or target.current_price is null then raise exception 'A valid stop and current price are required.' using errcode = '22000'; end if;

  prior_stop := target.ledger_stop;
  if target.direction = 'LONG' and p_proposed_stop <= prior_stop then raise exception 'A LONG Ledger stop can only move up.' using errcode = '22000'; end if;
  if target.direction = 'SHORT' and p_proposed_stop >= prior_stop then raise exception 'A SHORT Ledger stop can only move down.' using errcode = '22000'; end if;
  if target.direction = 'LONG' and p_proposed_stop >= target.current_price then raise exception 'A LONG Ledger stop must remain below current price.' using errcode = '22000'; end if;
  if target.direction = 'SHORT' and p_proposed_stop <= target.current_price then raise exception 'A SHORT Ledger stop must remain above current price.' using errcode = '22000'; end if;

  update public.setups set ledger_stop = p_proposed_stop where id = target.id;
  insert into public.setup_lifecycle_events (setup_id, event_type, previous_ledger_stop, next_ledger_stop, note, created_by)
  values (target.id, 'LEDGER_STOP_REVISED', prior_stop, p_proposed_stop, 'Public Ledger stop revised. No broker action is claimed.', auth.uid())
  returning * into inserted_event;

  return query select inserted_event.id, inserted_event.event_at, prior_stop, p_proposed_stop;
end;
$$;

create or replace function public.record_setup_review(p_setup_public_id uuid, p_note text default null)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.setups%rowtype;
  next_review timestamptz;
begin
  select * into target from public.setups where public_id = p_setup_public_id for update;
  if target.id is null then raise exception 'Setup not found.' using errcode = 'P0002'; end if;
  if target.user_id <> auth.uid() then raise exception 'Only the setup author can record its review.' using errcode = '42501'; end if;
  if target.status not in ('ACTIVE', 'T1_HIT', 'T2_HIT') then raise exception 'The setup is not active.' using errcode = '22000'; end if;

  next_review := now() + make_interval(days => coalesce(target.review_cadence_days, 7));
  update public.setups set review_due_at = next_review where id = target.id;
  insert into public.setup_lifecycle_events (setup_id, event_type, note, created_by)
  values (target.id, 'THESIS_REVIEWED', left(nullif(trim(p_note), ''), 500), auth.uid());
  return next_review;
end;
$$;

create or replace function public.expire_due_pending_setups()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  with expired as (
    update public.setups
    set status = 'EXPIRED', updated_at = now()
    where triggered_at is null
      and entry_expires_at <= now()
      and status in ('NEW', 'QUEUED', 'WATCHING', 'NEAR', 'HOT')
    returning id
  ), logged as (
    insert into public.setup_lifecycle_events (setup_id, event_type, note)
    select id, 'ENTRY_EXPIRED', 'Entry window elapsed before trigger.' from expired
    returning 1
  )
  select count(*)::integer into affected from logged;
  return affected;
end;
$$;

create or replace view public.setup_score_v2
with (security_invoker = true)
as
with tranches as (
  select setup_id, sum(allocation * r_result) as weighted_r
  from public.setup_tranche_outcomes
  group by setup_id
)
select
  s.public_id as setup_id,
  s.id as internal_setup_id,
  s.user_id,
  s.submitted_at,
  s.scoring_version,
  s.resolution_kind,
  case
    when s.resolution_kind = 'TECHNICAL_VOID' then null
    when s.resolution_kind in ('ENTRY_EXPIRED', 'OPERATOR_CANCELLED') then s.discipline_debit
    when s.triggered_at is not null and s.resolved_at is not null then coalesce(t.weighted_r, s.r_result)
    else null
  end as ledger_score,
  case
    when s.triggered_at is not null and s.resolved_at is not null
      then greatest(-1::numeric, least(5::numeric, coalesce(t.weighted_r, s.r_result)))
    else null
  end as goat_r,
  s.triggered_at is not null and s.resolved_at is not null as is_triggered_evidence
from public.setups s
left join tranches t on t.setup_id = s.id;

create or replace view public.operator_goat_v2
with (security_invoker = true)
as
with aggregates as (
  select
    user_id,
    count(*) filter (where is_triggered_evidence)::integer as triggered_resolved,
    count(*) filter (where is_triggered_evidence and ledger_score > 0)::integer as profitable_trades,
    count(*) filter (where resolution_kind = 'ENTRY_EXPIRED')::integer as expiry_count,
    count(*) filter (where resolution_kind = 'OPERATOR_CANCELLED')::integer as cancel_count,
    coalesce(sum(goat_r) filter (where is_triggered_evidence), 0) as sum_goat_r,
    coalesce(sum(ledger_score), 0) as total_score,
    coalesce(sum(ledger_score) filter (where submitted_at >= now() - interval '30 days'), 0) as last_30d_score
  from public.setup_score_v2
  where resolution_kind is distinct from 'TECHNICAL_VOID'
  group by user_id
), components as (
  select
    *,
    case when triggered_resolved > 0 then (sum_goat_r - expiry_count * 0.10 - cancel_count * 0.10) / triggered_resolved else 0 end as net_edge_r,
    (profitable_trades + 2.0) / (triggered_resolved + 4.0) as adjusted_win_rate,
    least(1.0, triggered_resolved / 20.0) as evidence_weight
  from aggregates
), scored as (
  select
    *,
    100 * (
      0.75 * greatest(-1.0, least(1.0, net_edge_r / 2.0)) +
      0.25 * (2.0 * adjusted_win_rate - 1.0)
    ) * evidence_weight as provisional_goat_score_v2
  from components
)
select
  *,
  triggered_resolved >= 3 as is_qualified,
  case when triggered_resolved >= 3 then provisional_goat_score_v2 else null end as goat_score_v2
from scored;

create or replace function public.refresh_trader_metrics(target_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.trader_metrics (
    profile_id, total_setups, triggered_setups, stopped_setups, t1_hits, t2_hits, t3_hits,
    win_rate, avg_pct_from_fill, avg_r, total_score, goat_score, last_30d_score, refreshed_at
  )
  with setup_stats as (
    select
      count(*)::bigint as total_setups,
      count(*) filter (where final_status = 'STOPPED' or stop_hit_at is not null)::bigint as stopped_setups,
      count(*) filter (where t1_hit_at is not null or final_status in ('T1', 'T2', 'T3'))::bigint as t1_hits,
      count(*) filter (where t2_hit_at is not null or final_status in ('T2', 'T3'))::bigint as t2_hits,
      count(*) filter (where t3_hit_at is not null or final_status = 'T3')::bigint as t3_hits,
      avg(pct_from_fill) filter (where pct_from_fill is not null)::numeric(18, 8) as avg_pct_from_fill
    from public.setups
    where user_id = target_profile_id
  ), goat as (
    select * from public.operator_goat_v2 where user_id = target_profile_id
  )
  select
    target_profile_id,
    setup_stats.total_setups,
    coalesce(goat.triggered_resolved, 0)::bigint,
    setup_stats.stopped_setups,
    setup_stats.t1_hits,
    setup_stats.t2_hits,
    setup_stats.t3_hits,
    case when coalesce(goat.triggered_resolved, 0) > 0 then goat.profitable_trades::numeric / goat.triggered_resolved else null end,
    setup_stats.avg_pct_from_fill,
    goat.net_edge_r,
    coalesce(goat.total_score, 0),
    goat.goat_score_v2,
    coalesce(goat.last_30d_score, 0),
    now()
  from setup_stats
  left join goat on true
  on conflict (profile_id) do update set
    total_setups = excluded.total_setups,
    triggered_setups = excluded.triggered_setups,
    stopped_setups = excluded.stopped_setups,
    t1_hits = excluded.t1_hits,
    t2_hits = excluded.t2_hits,
    t3_hits = excluded.t3_hits,
    win_rate = excluded.win_rate,
    avg_pct_from_fill = excluded.avg_pct_from_fill,
    avg_r = excluded.avg_r,
    total_score = excluded.total_score,
    goat_score = excluded.goat_score,
    last_30d_score = excluded.last_30d_score,
    refreshed_at = excluded.refreshed_at;
end;
$$;

create or replace function public.process_setup_quote_results(p_results jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  quote_row record;
  target public.setups%rowtype;
  quote_price numeric;
  next_status public.setup_status;
  next_final public.setup_final_status;
  hit_t1 boolean;
  hit_t2 boolean;
  hit_t3 boolean;
  hit_stop boolean;
  triggered_now boolean;
  allocation_resolved numeric;
  weighted_r numeric;
  risk_amount numeric;
  changed_count integer := 0;
begin
  for quote_row in
    select * from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
      as result(ticker text, price numeric, source text, quoted_at timestamptz, error text)
    where result.error is null and result.price > 0
  loop
    quote_price := quote_row.price;
    for target in
      select * from public.setups
      where upper(trim(ticker)) = upper(trim(quote_row.ticker))
        and final_status is null
        and status not in ('STOPPED', 'CANCELLED', 'EXPIRED', 'CLOSED', 'RESOLVED')
      for update
    loop
      next_status := target.status;
      next_final := target.final_status;
      triggered_now := false;
      risk_amount := abs(target.entry - target.stop);

      if target.triggered_at is null then
        triggered_now :=
          (target.trigger_type = 'BREACH' and ((target.direction = 'LONG' and quote_price >= target.entry) or (target.direction = 'SHORT' and quote_price <= target.entry)))
          or
          (target.trigger_type = 'PULLBACK' and ((target.direction = 'LONG' and quote_price <= target.entry) or (target.direction = 'SHORT' and quote_price >= target.entry)));

        if triggered_now then
          next_status := 'ACTIVE';
        elsif abs(quote_price - target.entry) / target.entry <= 0.02 then
          next_status := 'HOT';
        elsif abs(quote_price - target.entry) / target.entry <= 0.05 then
          next_status := 'NEAR';
        else
          next_status := 'QUEUED';
        end if;

        update public.setups
        set
          current_price = quote_price,
          price_source = quote_row.source,
          pct_from_fill = ((quote_price - entry) / entry) * 100,
          status = next_status,
          triggered_at = case when triggered_now then coalesce(target.triggered_at, quote_row.quoted_at, now()) else target.triggered_at end,
          updated_at = now()
        where id = target.id;

        if triggered_now then
          insert into public.setup_events (setup_id, event_type, event_at, price, payload, created_by)
          values (target.id, 'ENTRY_HIT', coalesce(quote_row.quoted_at, now()), quote_price, jsonb_build_object('source', quote_row.source), 'QUOTE_WORKER');
        end if;
        changed_count := changed_count + 1;
        continue;
      end if;

      hit_stop := (target.direction = 'LONG' and quote_price <= target.ledger_stop)
        or (target.direction = 'SHORT' and quote_price >= target.ledger_stop);
      hit_t1 := (target.direction = 'LONG' and quote_price >= target.t1)
        or (target.direction = 'SHORT' and quote_price <= target.t1);
      hit_t2 := target.t2 is not null and (
        (target.direction = 'LONG' and quote_price >= target.t2)
        or (target.direction = 'SHORT' and quote_price <= target.t2)
      );
      hit_t3 := target.t3 is not null and (
        (target.direction = 'LONG' and quote_price >= target.t3)
        or (target.direction = 'SHORT' and quote_price <= target.t3)
      );

      if not hit_stop then
        if hit_t1 and target.t1_allocation > 0 then
          insert into public.setup_tranche_outcomes (setup_id, tranche_number, allocation, exit_price, r_result, resolved_at)
          values (target.id, 1, target.t1_allocation, target.t1,
            case when target.direction = 'LONG' then (target.t1 - target.entry) / risk_amount else (target.entry - target.t1) / risk_amount end,
            coalesce(quote_row.quoted_at, now()))
          on conflict (setup_id, tranche_number) do nothing;
        end if;
        if hit_t2 and target.t2_allocation > 0 then
          insert into public.setup_tranche_outcomes (setup_id, tranche_number, allocation, exit_price, r_result, resolved_at)
          values (target.id, 2, target.t2_allocation, target.t2,
            case when target.direction = 'LONG' then (target.t2 - target.entry) / risk_amount else (target.entry - target.t2) / risk_amount end,
            coalesce(quote_row.quoted_at, now()))
          on conflict (setup_id, tranche_number) do nothing;
        end if;
        if hit_t3 and target.t3_allocation > 0 then
          insert into public.setup_tranche_outcomes (setup_id, tranche_number, allocation, exit_price, r_result, resolved_at)
          values (target.id, 3, target.t3_allocation, target.t3,
            case when target.direction = 'LONG' then (target.t3 - target.entry) / risk_amount else (target.entry - target.t3) / risk_amount end,
            coalesce(quote_row.quoted_at, now()))
          on conflict (setup_id, tranche_number) do nothing;
        end if;
      else
        insert into public.setup_tranche_outcomes (setup_id, tranche_number, allocation, exit_price, r_result, resolved_at)
        select
          target.id,
          tranche.tranche_number,
          tranche.allocation,
          quote_price,
          case when target.direction = 'LONG' then (quote_price - target.entry) / risk_amount else (target.entry - quote_price) / risk_amount end,
          coalesce(quote_row.quoted_at, now())
        from (values
          (1::smallint, target.t1_allocation),
          (2::smallint, target.t2_allocation),
          (3::smallint, target.t3_allocation)
        ) as tranche(tranche_number, allocation)
        where tranche.allocation > 0
        on conflict (setup_id, tranche_number) do nothing;
      end if;

      select coalesce(sum(allocation), 0), coalesce(sum(allocation * r_result), 0)
      into allocation_resolved, weighted_r
      from public.setup_tranche_outcomes
      where setup_id = target.id;

      if hit_stop then
        next_status := 'STOPPED';
        next_final := 'STOPPED';
      elsif hit_t3 then
        next_status := 'T3_HIT';
        next_final := 'T3';
      elsif hit_t2 then
        next_status := 'T2_HIT';
        next_final := 'T2';
      elsif hit_t1 then
        next_status := 'T1_HIT';
        next_final := 'T1';
      end if;

      if not hit_stop and allocation_resolved >= 0.999999 then
        next_status := 'RESOLVED';
      end if;

      update public.setups
      set
        current_price = quote_price,
        price_source = quote_row.source,
        pct_from_fill = ((quote_price - entry) / entry) * 100,
        status = next_status,
        final_status = case when next_status in ('STOPPED', 'RESOLVED') then next_final else final_status end,
        t1_hit_at = case when hit_t1 or hit_t2 or hit_t3 then coalesce(t1_hit_at, quote_row.quoted_at, now()) else t1_hit_at end,
        t2_hit_at = case when hit_t2 or hit_t3 then coalesce(t2_hit_at, quote_row.quoted_at, now()) else t2_hit_at end,
        t3_hit_at = case when hit_t3 then coalesce(t3_hit_at, quote_row.quoted_at, now()) else t3_hit_at end,
        stop_hit_at = case when hit_stop then coalesce(stop_hit_at, quote_row.quoted_at, now()) else stop_hit_at end,
        r_result = case when next_status in ('STOPPED', 'RESOLVED') then weighted_r else r_result end,
        score = case when next_status in ('STOPPED', 'RESOLVED') then weighted_r else score end,
        resolved_at = case when next_status in ('STOPPED', 'RESOLVED') then coalesce(resolved_at, quote_row.quoted_at, now()) else resolved_at end,
        resolution_kind = case when next_status in ('STOPPED', 'RESOLVED') then 'TRADE' else resolution_kind end,
        updated_at = now()
      where id = target.id;

      if next_status is distinct from target.status then
        insert into public.setup_events (setup_id, event_type, event_at, price, payload, created_by)
        values (target.id, 'STATUS_' || next_status::text, coalesce(quote_row.quoted_at, now()), quote_price, jsonb_build_object('source', quote_row.source), 'QUOTE_WORKER');
      end if;
      perform public.refresh_trader_metrics(target.user_id);
      changed_count := changed_count + 1;
    end loop;
  end loop;
  return changed_count;
end;
$$;

create or replace function public.store_setup_quote_results(p_results jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.setup_quote_cache cache
  set
    price = coalesce(result.price, cache.price),
    currency = coalesce(result.currency, cache.currency),
    exchange = coalesce(result.exchange, cache.exchange),
    source = coalesce(result.source, cache.source),
    requested_symbol = coalesce(result.requested_symbol, cache.requested_symbol),
    resolved_symbol = coalesce(result.resolved_symbol, cache.resolved_symbol),
    asset_class = coalesce(result.asset_class, cache.asset_class),
    quoted_at = coalesce(result.quoted_at, cache.quoted_at),
    refreshed_at = now(),
    next_refresh_at = now() + make_interval(secs => cache.refresh_interval_seconds),
    last_error = result.error
  from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb)) as result(
    ticker text,
    price numeric,
    currency text,
    exchange text,
    source text,
    requested_symbol text,
    resolved_symbol text,
    asset_class text,
    quoted_at timestamptz,
    error text
  )
  where cache.ticker = upper(trim(result.ticker));

  perform public.process_setup_quote_results(p_results);
end;
$$;

create or replace view public.setups_public
with (security_invoker = true)
as
select
  s.public_id as id,
  s.user_id,
  p.handle::text as handle,
  p.display_name,
  p.avatar_url,
  s.ticker,
  s.direction,
  s.horizon,
  s.trigger_type,
  s.entry,
  s.stop,
  s.t1,
  s.t2,
  s.t3,
  s.strategy,
  s.thesis,
  s.status,
  s.current_price,
  s.price_source,
  s.pct_from_fill,
  s.r_result,
  s.score,
  s.final_status,
  s.submitted_at,
  s.triggered_at,
  s.t1_hit_at,
  s.t2_hit_at,
  s.t3_hit_at,
  s.stop_hit_at,
  s.archived_at,
  s.updated_at,
  (select count(*)::bigint from public.setup_comments c where c.setup_id = s.public_id and c.deleted_at is null) as comment_count,
  coalesce(tm.total_setups, 0)::bigint as operator_total_setups,
  coalesce(tm.triggered_setups, 0)::bigint as operator_triggered_setups,
  tm.win_rate as operator_win_rate,
  tm.avg_r as operator_avg_r,
  tm.goat_score as operator_goat_score,
  s.entry_expires_at,
  s.review_due_at,
  s.review_cadence_days,
  s.expected_holding_guide,
  s.management_style,
  s.t1_allocation,
  s.t2_allocation,
  s.t3_allocation,
  s.ledger_stop,
  s.scoring_version,
  s.resolution_kind,
  s.discipline_debit,
  s.resolved_at,
  s.expiry_reason,
  s.void_reason
from public.setups s
join public.profiles p on p.id = s.user_id
left join public.trader_metrics tm on tm.profile_id = s.user_id
where p.is_public = true and p.account_status = 'ACTIVE';

create or replace function public.leaderboard_page(
  p_sort text default 'goat',
  p_search text default '',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  rank_position bigint,
  total_count bigint,
  profile_id uuid,
  handle text,
  display_name text,
  avatar_url text,
  bio text,
  total_setups bigint,
  triggered_setups bigint,
  stopped_setups bigint,
  t1_hits bigint,
  t2_hits bigint,
  t3_hits bigint,
  win_rate numeric,
  avg_pct_from_fill numeric,
  avg_r numeric,
  total_score numeric,
  goat_score numeric,
  last_30d_score numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with visible as (
    select
      p.id as profile_id,
      p.handle::text as handle,
      p.display_name,
      p.avatar_url,
      p.bio,
      coalesce(m.total_setups, 0)::bigint as total_setups,
      coalesce(m.triggered_setups, 0)::bigint as triggered_setups,
      coalesce(m.stopped_setups, 0)::bigint as stopped_setups,
      coalesce(m.t1_hits, 0)::bigint as t1_hits,
      coalesce(m.t2_hits, 0)::bigint as t2_hits,
      coalesce(m.t3_hits, 0)::bigint as t3_hits,
      m.win_rate,
      m.avg_pct_from_fill,
      m.avg_r,
      coalesce(m.total_score, 0) as total_score,
      m.goat_score,
      coalesce(m.last_30d_score, 0) as last_30d_score
    from public.profiles p
    left join public.trader_metrics m on m.profile_id = p.id
    where p.is_public = true
      and p.account_status = 'ACTIVE'
      and (
        coalesce(p_search, '') = ''
        or p.handle::text ilike '%' || p_search || '%'
        or p.display_name ilike '%' || p_search || '%'
      )
  ), ranked as (
    select
      row_number() over (
        order by
          case when lower(coalesce(p_sort, 'goat')) = 'last30' then last_30d_score end desc nulls last,
          case when lower(coalesce(p_sort, 'goat')) = 'score' then total_score end desc nulls last,
          case when lower(coalesce(p_sort, 'goat')) = 'win' then win_rate end desc nulls last,
          case when lower(coalesce(p_sort, 'goat')) = 'goat' then goat_score end desc nulls last,
          triggered_setups desc,
          handle asc
      ) as rank_position,
      count(*) over () as total_count,
      visible.*
    from visible
  )
  select * from ranked
  order by rank_position
  limit least(greatest(coalesce(p_limit, 50), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

alter table public.setup_lifecycle_events enable row level security;
alter table public.setup_tranche_outcomes enable row level security;

create policy setup_lifecycle_events_public_read
on public.setup_lifecycle_events for select
to anon, authenticated
using (exists (
  select 1
  from public.setups s
  join public.profiles p on p.id = s.user_id
  where s.id = setup_lifecycle_events.setup_id
    and ((p.is_public = true and p.account_status = 'ACTIVE') or s.user_id = auth.uid())
));

create policy setup_tranche_outcomes_public_read
on public.setup_tranche_outcomes for select
to anon, authenticated
using (exists (
  select 1
  from public.setups s
  join public.profiles p on p.id = s.user_id
  where s.id = setup_tranche_outcomes.setup_id
    and ((p.is_public = true and p.account_status = 'ACTIVE') or s.user_id = auth.uid())
));

revoke all on public.setup_lifecycle_events from anon, authenticated;
revoke all on public.setup_tranche_outcomes from anon, authenticated;
revoke execute on function public.initialize_setup_lifecycle() from public, anon, authenticated;
revoke execute on function public.sync_setup_lifecycle_transition() from public, anon, authenticated;
revoke execute on function public.revise_ledger_stop(uuid, numeric) from public, anon;
revoke execute on function public.record_setup_review(uuid, text) from public, anon;
revoke execute on function public.expire_due_pending_setups() from public, anon, authenticated;
revoke execute on function public.process_setup_quote_results(jsonb) from public, anon, authenticated;
revoke execute on function public.store_setup_quote_results(jsonb) from public, anon, authenticated;

grant select on public.setup_lifecycle_events to anon, authenticated;
grant select on public.setup_tranche_outcomes to anon, authenticated;
grant select on public.setup_score_v2 to anon, authenticated;
grant select on public.operator_goat_v2 to anon, authenticated;
grant select on public.setups_public to anon, authenticated;
grant execute on function public.revise_ledger_stop(uuid, numeric) to authenticated;
grant execute on function public.record_setup_review(uuid, text) to authenticated;
grant execute on function public.expire_due_pending_setups() to service_role;
grant execute on function public.process_setup_quote_results(jsonb) to service_role;
grant execute on function public.store_setup_quote_results(jsonb) to service_role;
grant select, insert, update, delete on public.setup_lifecycle_events to service_role;
grant select, insert, update, delete on public.setup_tranche_outcomes to service_role;
grant usage, select on sequence public.setup_lifecycle_events_id_seq to service_role;
grant usage, select on sequence public.setup_tranche_outcomes_id_seq to service_role;

revoke insert on public.setups from authenticated;
grant insert (
  client_request_id,
  user_id,
  ticker,
  direction,
  horizon,
  trigger_type,
  entry,
  stop,
  t1,
  t2,
  t3,
  strategy,
  thesis,
  entry_expires_at,
  management_style,
  t1_allocation,
  t2_allocation,
  t3_allocation
) on public.setups to authenticated;

select public.refresh_trader_metrics(id) from public.profiles;

-- Supabase Cron runs the expiry function without upstream price requests.
create extension if not exists pg_cron;
select cron.schedule(
  'ledger-expire-pending-setups',
  '*/5 * * * *',
  'select public.expire_due_pending_setups();'
);

commit;

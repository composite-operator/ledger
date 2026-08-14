-- PROTOTYPE ONLY. Do not apply to the live project before the lifecycle lab is approved.
-- Adds entry expiry, review cadence, append-only Ledger stop revisions,
-- tranche outcomes, and versioned GOAT v2 inputs.

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
  event_type text not null check (event_type in ('LEDGER_STOP_REVISED', 'THESIS_REVIEWED', 'ENTRY_EXPIRED', 'COACH_PROMPTED')),
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
begin
  validity_days := case new.horizon
    when 'DAY_TRADE' then 1
    when 'SWING' then 14
    when 'POSITION' then 45
    else 180
  end;
  new.review_cadence_days := coalesce(new.review_cadence_days, case new.horizon
    when 'DAY_TRADE' then 1
    when 'SWING' then 7
    when 'POSITION' then 30
    else 90
  end);
  new.expected_holding_guide := coalesce(new.expected_holding_guide, case new.horizon
    when 'DAY_TRADE' then 'Minutes to one week'
    when 'SWING' then 'Days to several months'
    when 'POSITION' then 'Months to several years'
    else 'Years or open-ended'
  end);
  new.entry_expires_at := coalesce(new.entry_expires_at, coalesce(new.submitted_at, now()) + make_interval(days => validity_days));
  new.ledger_stop := coalesce(new.ledger_stop, new.stop);
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
  select * into target
  from public.setups
  where public_id = p_setup_public_id
  for update;

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
    set
      status = 'EXPIRED',
      final_status = 'EXPIRED',
      resolution_kind = 'ENTRY_EXPIRED',
      discipline_debit = -0.10,
      score = -0.10,
      resolved_at = now(),
      expiry_reason = 'ENTRY_WINDOW_ELAPSED'
    where triggered_at is null
      and entry_expires_at <= now()
      and status in ('NEW', 'QUEUED', 'WATCHING', 'NEAR', 'HOT')
    returning id
  )
  insert into public.setup_lifecycle_events (setup_id, event_type, note)
  select id, 'ENTRY_EXPIRED', 'Entry window elapsed before trigger.' from expired;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace view public.setup_score_v2
with (security_invoker = true)
as
select
  s.public_id as setup_id,
  s.user_id,
  s.scoring_version,
  s.resolution_kind,
  case
    when s.resolution_kind = 'TECHNICAL_VOID' then null
    when s.resolution_kind in ('ENTRY_EXPIRED', 'OPERATOR_CANCELLED') then s.discipline_debit
    when s.triggered_at is not null and s.resolved_at is not null then coalesce(sum(t.allocation * t.r_result), s.r_result)
    else null
  end as ledger_score,
  case
    when s.triggered_at is not null and s.resolved_at is not null then greatest(-1::numeric, least(5::numeric, coalesce(sum(t.allocation * t.r_result), s.r_result)))
    else null
  end as goat_r,
  s.triggered_at is not null and s.resolved_at is not null as is_triggered_evidence
from public.setups s
left join public.setup_tranche_outcomes t on t.setup_id = s.id
group by s.id;

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
    coalesce(sum(goat_r) filter (where is_triggered_evidence), 0) as sum_goat_r
  from public.setup_score_v2
  where resolution_kind is distinct from 'TECHNICAL_VOID'
  group by user_id
), components as (
  select
    *,
    case when triggered_resolved > 0 then (sum_goat_r - expiry_count * 0.10 - cancel_count * 0.15) / triggered_resolved else 0 end as net_edge_r,
    (profitable_trades + 2.0) / (triggered_resolved + 4.0) as adjusted_win_rate,
    least(1.0, triggered_resolved / 20.0) as evidence_weight
  from aggregates
)
select
  *,
  100 * (
    0.75 * greatest(-1.0, least(1.0, net_edge_r / 2.0)) +
    0.25 * (2.0 * adjusted_win_rate - 1.0)
  ) * evidence_weight as goat_score_v2
from components;

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
  (
    select count(*)::bigint from public.setup_comments c
    where c.setup_id = s.public_id and c.deleted_at is null
  ) as comment_count,
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

alter table public.setup_lifecycle_events enable row level security;
alter table public.setup_tranche_outcomes enable row level security;

create policy setup_lifecycle_events_public_read
on public.setup_lifecycle_events for select
to anon, authenticated
using (exists (select 1 from public.setups s where s.id = setup_lifecycle_events.setup_id));

create policy setup_tranche_outcomes_public_read
on public.setup_tranche_outcomes for select
to anon, authenticated
using (exists (select 1 from public.setups s where s.id = setup_tranche_outcomes.setup_id));

revoke all on public.setup_lifecycle_events from anon, authenticated;
revoke all on public.setup_tranche_outcomes from anon, authenticated;
revoke execute on function public.initialize_setup_lifecycle() from public, anon, authenticated;
revoke execute on function public.revise_ledger_stop(uuid, numeric) from public, anon;
revoke execute on function public.record_setup_review(uuid, text) from public, anon;
revoke execute on function public.expire_due_pending_setups() from public, anon, authenticated;

grant select on public.setup_lifecycle_events to anon, authenticated;
grant select on public.setup_tranche_outcomes to anon, authenticated;
grant select on public.setup_score_v2 to anon, authenticated;
grant select on public.operator_goat_v2 to anon, authenticated;
grant select on public.setups_public to anon, authenticated;
grant execute on function public.revise_ledger_stop(uuid, numeric) to authenticated;
grant execute on function public.record_setup_review(uuid, text) to authenticated;
grant execute on function public.expire_due_pending_setups() to service_role;
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
  review_cadence_days,
  expected_holding_guide,
  management_style,
  t1_allocation,
  t2_allocation,
  t3_allocation,
  ledger_stop,
  scoring_version
) on public.setups to authenticated;

commit;

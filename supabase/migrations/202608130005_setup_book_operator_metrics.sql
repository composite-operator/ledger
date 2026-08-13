begin;

-- Keep setup books independently sortable without loading a separate leaderboard page.
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
    select count(*)::bigint
    from public.setup_comments c
    where c.setup_id = s.public_id
      and c.deleted_at is null
  ) as comment_count,
  coalesce(tm.total_setups, 0)::bigint as operator_total_setups,
  coalesce(tm.triggered_setups, 0)::bigint as operator_triggered_setups,
  tm.win_rate as operator_win_rate,
  tm.avg_r as operator_avg_r,
  tm.goat_score as operator_goat_score
from public.setups s
join public.profiles p on p.id = s.user_id
left join public.trader_metrics tm on tm.profile_id = s.user_id
where p.is_public = true and p.account_status = 'ACTIVE';

grant select on public.setups_public to anon, authenticated;

commit;

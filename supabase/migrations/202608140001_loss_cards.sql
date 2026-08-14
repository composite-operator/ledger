-- Composite Operator Ledger
-- One-time loss-card alerts for negative closed outcomes.

begin;

alter table public.notification_preferences
  add column if not exists notify_losses boolean not null default true;

alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check check (
    notification_type in (
      'NEW_SETUP',
      'COMMENT',
      'REPLY',
      'MENTION',
      'ENTRY_HIT',
      'SETUP_HOT',
      'SETUP_ENTRY',
      'SETUP_T1',
      'SETUP_T2',
      'SETUP_T3',
      'SETUP_STOPPED',
      'VICTORY',
      'LOSS_CARD'
    )
  );

create or replace function public.notify_loss_card_after_setup_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_loss boolean := false;
  is_loss boolean := false;
begin
  is_loss := (
    new.status in ('STOPPED', 'CLOSED', 'RESOLVED')
    and coalesce(new.r_result, new.score, 0) < 0
    and coalesce(new.final_status::text, '') not in ('CANCELLED', 'EXPIRED')
  );

  if tg_op = 'UPDATE' then
    was_loss := (
      old.status in ('STOPPED', 'CLOSED', 'RESOLVED')
      and coalesce(old.r_result, old.score, 0) < 0
      and coalesce(old.final_status::text, '') not in ('CANCELLED', 'EXPIRED')
    );
  end if;

  if not is_loss or was_loss then
    return new;
  end if;

  insert into public.notifications (
    recipient_id,
    actor_id,
    notification_type,
    setup_id,
    comment_id
  )
  select
    audience.recipient_id,
    new.user_id,
    'LOSS_CARD',
    new.public_id,
    null
  from (
    select new.user_id as recipient_id
    union
    select setup_follow.follower_id
    from public.setup_follows setup_follow
    where setup_follow.setup_id = new.public_id
    union
    select operator_follow.follower_id
    from public.operator_follows operator_follow
    where operator_follow.following_id = new.user_id
  ) audience
  left join public.notification_preferences preferences
    on preferences.user_id = audience.recipient_id
  where coalesce(preferences.notifications_muted, false) = false
    and coalesce(preferences.notify_losses, true) = true
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists setups_notify_loss_card_after_insert on public.setups;
create trigger setups_notify_loss_card_after_insert
after insert on public.setups
for each row execute function public.notify_loss_card_after_setup_close();

drop trigger if exists setups_notify_loss_card_after_update on public.setups;
create trigger setups_notify_loss_card_after_update
after update of status, final_status, r_result, score, archived_at on public.setups
for each row execute function public.notify_loss_card_after_setup_close();

revoke update on public.notification_preferences from authenticated;
grant update (
  notifications_muted,
  notify_new_setups,
  notify_comments,
  notify_entry_hits,
  notify_followed_setup_hot,
  notify_followed_setup_entry,
  notify_followed_setup_targets,
  notify_followed_setup_stops,
  notify_wins,
  notify_losses
) on public.notification_preferences to authenticated;

revoke execute on function public.notify_loss_card_after_setup_close()
  from public, anon, authenticated;

commit;

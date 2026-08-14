-- Composite Operator Ledger
-- Per-setup watchlists and lifecycle alerts for HOT, entry, targets, and stop-out.

begin;

create table public.setup_follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  setup_id uuid not null references public.setups(public_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, setup_id)
);

create index setup_follows_setup_created_idx
on public.setup_follows (setup_id, created_at desc);

alter table public.setup_follows enable row level security;

create policy setup_follows_owner_read
on public.setup_follows for select
to authenticated
using (follower_id = auth.uid());

create policy setup_follows_owner_insert
on public.setup_follows for insert
to authenticated
with check (
  follower_id = auth.uid()
  and exists (
    select 1
    from public.setups setup
    join public.profiles owner on owner.id = setup.user_id
    where setup.public_id = setup_follows.setup_id
      and owner.is_public = true
      and owner.account_status = 'ACTIVE'
  )
);

create policy setup_follows_owner_delete
on public.setup_follows for delete
to authenticated
using (follower_id = auth.uid());

alter table public.notification_preferences
  add column notify_followed_setup_hot boolean not null default true,
  add column notify_followed_setup_entry boolean not null default true,
  add column notify_followed_setup_targets boolean not null default true,
  add column notify_followed_setup_stops boolean not null default true;

alter table public.notifications
  drop constraint notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check check (
    notification_type in (
      'NEW_SETUP',
      'COMMENT',
      'ENTRY_HIT',
      'SETUP_HOT',
      'SETUP_ENTRY',
      'SETUP_T1',
      'SETUP_T2',
      'SETUP_T3',
      'SETUP_STOPPED'
    )
  );

create or replace function public.enqueue_follow_notifications(
  p_actor_id uuid,
  p_notification_type text,
  p_setup_id uuid,
  p_comment_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_notification_type not in ('NEW_SETUP', 'COMMENT', 'ENTRY_HIT') then
    raise exception 'Unsupported notification type.' using errcode = '22000';
  end if;

  insert into public.notifications (
    recipient_id,
    actor_id,
    notification_type,
    setup_id,
    comment_id
  )
  select
    follows.follower_id,
    p_actor_id,
    p_notification_type,
    p_setup_id,
    p_comment_id
  from public.operator_follows follows
  left join public.notification_preferences preferences
    on preferences.user_id = follows.follower_id
  where follows.following_id = p_actor_id
    and follows.follower_id <> p_actor_id
    and coalesce(preferences.notifications_muted, false) = false
    and case p_notification_type
      when 'NEW_SETUP' then coalesce(preferences.notify_new_setups, true)
      when 'COMMENT' then coalesce(preferences.notify_comments, true)
      when 'ENTRY_HIT' then coalesce(preferences.notify_entry_hits, true)
      else false
    end
    and not (
      p_notification_type = 'ENTRY_HIT'
      and coalesce(preferences.notify_followed_setup_entry, true)
      and exists (
        select 1
        from public.setup_follows setup_follow
        where setup_follow.follower_id = follows.follower_id
          and setup_follow.setup_id = p_setup_id
      )
    )
  on conflict do nothing;
end;
$$;

create or replace function public.enqueue_setup_follow_notifications(
  p_actor_id uuid,
  p_notification_type text,
  p_setup_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_notification_type not in (
    'SETUP_HOT',
    'SETUP_ENTRY',
    'SETUP_T1',
    'SETUP_T2',
    'SETUP_T3',
    'SETUP_STOPPED'
  ) then
    raise exception 'Unsupported setup notification type.' using errcode = '22000';
  end if;

  insert into public.notifications (
    recipient_id,
    actor_id,
    notification_type,
    setup_id,
    comment_id
  )
  select
    follows.follower_id,
    p_actor_id,
    p_notification_type,
    p_setup_id,
    null
  from public.setup_follows follows
  left join public.notification_preferences preferences
    on preferences.user_id = follows.follower_id
  where follows.setup_id = p_setup_id
    and coalesce(preferences.notifications_muted, false) = false
    and case p_notification_type
      when 'SETUP_HOT' then coalesce(preferences.notify_followed_setup_hot, true)
      when 'SETUP_ENTRY' then coalesce(preferences.notify_followed_setup_entry, true)
      when 'SETUP_T1' then coalesce(preferences.notify_followed_setup_targets, true)
      when 'SETUP_T2' then coalesce(preferences.notify_followed_setup_targets, true)
      when 'SETUP_T3' then coalesce(preferences.notify_followed_setup_targets, true)
      when 'SETUP_STOPPED' then coalesce(preferences.notify_followed_setup_stops, true)
      else false
    end
  on conflict do nothing;
end;
$$;

create or replace function public.notify_setup_followers_after_lifecycle_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from new.status and new.status = 'HOT' then
    perform public.enqueue_setup_follow_notifications(new.user_id, 'SETUP_HOT', new.public_id);
  end if;

  if (old.triggered_at is null and new.triggered_at is not null)
    or (
      old.status not in ('ACTIVE', 'T1_HIT', 'T2_HIT', 'T3_HIT')
      and new.status in ('ACTIVE', 'T1_HIT', 'T2_HIT', 'T3_HIT')
    ) then
    perform public.enqueue_setup_follow_notifications(new.user_id, 'SETUP_ENTRY', new.public_id);
  end if;

  if (old.t1_hit_at is null and new.t1_hit_at is not null)
    or (
      old.status not in ('T1_HIT', 'T2_HIT', 'T3_HIT')
      and new.status in ('T1_HIT', 'T2_HIT', 'T3_HIT')
    ) then
    perform public.enqueue_setup_follow_notifications(new.user_id, 'SETUP_T1', new.public_id);
  end if;

  if (old.t2_hit_at is null and new.t2_hit_at is not null)
    or (
      new.t2 is not null
      and
      old.status not in ('T2_HIT', 'T3_HIT')
      and new.status in ('T2_HIT', 'T3_HIT')
    ) then
    perform public.enqueue_setup_follow_notifications(new.user_id, 'SETUP_T2', new.public_id);
  end if;

  if (old.t3_hit_at is null and new.t3_hit_at is not null)
    or (new.t3 is not null and old.status <> 'T3_HIT' and new.status = 'T3_HIT') then
    perform public.enqueue_setup_follow_notifications(new.user_id, 'SETUP_T3', new.public_id);
  end if;

  if (old.stop_hit_at is null and new.stop_hit_at is not null)
    or (old.status <> 'STOPPED' and new.status = 'STOPPED') then
    perform public.enqueue_setup_follow_notifications(new.user_id, 'SETUP_STOPPED', new.public_id);
  end if;

  return new;
end;
$$;

create trigger setups_notify_setup_followers_after_lifecycle
after update of status, triggered_at, t1_hit_at, t2_hit_at, t3_hit_at, stop_hit_at
on public.setups
for each row execute function public.notify_setup_followers_after_lifecycle_update();

revoke all on public.setup_follows from anon, authenticated;
grant select, insert, delete on public.setup_follows to authenticated;

revoke update on public.notification_preferences from authenticated;
grant update (
  notifications_muted,
  notify_new_setups,
  notify_comments,
  notify_entry_hits,
  notify_followed_setup_hot,
  notify_followed_setup_entry,
  notify_followed_setup_targets,
  notify_followed_setup_stops
) on public.notification_preferences to authenticated;

revoke execute on function public.enqueue_follow_notifications(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.enqueue_setup_follow_notifications(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.notify_setup_followers_after_lifecycle_update() from public, anon, authenticated;

commit;

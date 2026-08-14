-- Composite Operator Ledger
-- Operator follows, private notification inboxes, per-account preferences, and server-side event delivery.

begin;

create table public.operator_follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint operator_follows_no_self_follow check (follower_id <> following_id)
);

create index operator_follows_following_created_idx
on public.operator_follows (following_id, created_at desc);

create table public.notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  notifications_muted boolean not null default false,
  notify_new_setups boolean not null default true,
  notify_comments boolean not null default true,
  notify_entry_hits boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default extensions.gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  notification_type text not null,
  setup_id uuid references public.setups(public_id) on delete cascade,
  comment_id uuid references public.setup_comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_type_check check (notification_type in ('NEW_SETUP', 'COMMENT', 'ENTRY_HIT')),
  constraint notifications_related_record_check check (setup_id is not null)
);

create index notifications_recipient_created_idx
on public.notifications (recipient_id, created_at desc);

create index notifications_recipient_unread_idx
on public.notifications (recipient_id, created_at desc)
where read_at is null;

create unique index notifications_setup_event_once_idx
on public.notifications (recipient_id, actor_id, notification_type, setup_id)
where comment_id is null;

create unique index notifications_comment_once_idx
on public.notifications (recipient_id, actor_id, notification_type, comment_id)
where comment_id is not null;

alter table public.operator_follows enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notifications enable row level security;

create policy operator_follows_member_read
on public.operator_follows for select
to authenticated
using (follower_id = auth.uid() or following_id = auth.uid());

create policy operator_follows_owner_insert
on public.operator_follows for insert
to authenticated
with check (
  follower_id = auth.uid()
  and follower_id <> following_id
  and exists (
    select 1
    from public.profiles target
    where target.id = following_id
      and target.is_public = true
      and target.account_status = 'ACTIVE'
  )
);

create policy operator_follows_owner_delete
on public.operator_follows for delete
to authenticated
using (follower_id = auth.uid());

create policy notification_preferences_owner_read
on public.notification_preferences for select
to authenticated
using (user_id = auth.uid());

create policy notification_preferences_owner_insert
on public.notification_preferences for insert
to authenticated
with check (user_id = auth.uid());

create policy notification_preferences_owner_update
on public.notification_preferences for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy notifications_owner_read
on public.notifications for select
to authenticated
using (recipient_id = auth.uid());

create policy notifications_owner_update
on public.notifications for update
to authenticated
using (recipient_id = auth.uid())
with check (recipient_id = auth.uid());

create policy notifications_owner_delete
on public.notifications for delete
to authenticated
using (recipient_id = auth.uid());

create or replace function public.touch_notification_preferences_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger notification_preferences_touch_updated_at
before update on public.notification_preferences
for each row execute function public.touch_notification_preferences_updated_at();

insert into public.notification_preferences (user_id)
select id from public.profiles
on conflict (user_id) do nothing;

create or replace function public.create_notification_preferences_for_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.notification_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger profiles_notification_preferences_after_insert
after insert on public.profiles
for each row execute function public.create_notification_preferences_for_profile();

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
  on conflict do nothing;
end;
$$;

create or replace function public.notify_followers_after_setup_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_follow_notifications(new.user_id, 'NEW_SETUP', new.public_id, null);

  if new.triggered_at is not null
    or new.status in ('ACTIVE', 'T1_HIT', 'T2_HIT', 'T3_HIT') then
    perform public.enqueue_follow_notifications(new.user_id, 'ENTRY_HIT', new.public_id, null);
  end if;

  return new;
end;
$$;

create trigger setups_notify_followers_after_insert
after insert on public.setups
for each row execute function public.notify_followers_after_setup_insert();

create or replace function public.notify_followers_after_setup_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (old.triggered_at is null and new.triggered_at is not null)
    or (
      old.status is distinct from new.status
      and new.status in ('ACTIVE', 'T1_HIT', 'T2_HIT', 'T3_HIT')
    ) then
    perform public.enqueue_follow_notifications(new.user_id, 'ENTRY_HIT', new.public_id, null);
  end if;

  return new;
end;
$$;

create trigger setups_notify_followers_after_entry
after update of status, triggered_at on public.setups
for each row execute function public.notify_followers_after_setup_entry();

create or replace function public.notify_followers_after_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.enqueue_follow_notifications(new.user_id, 'COMMENT', new.setup_id, new.id);
  return new;
end;
$$;

create trigger setup_comments_notify_followers_after_insert
after insert on public.setup_comments
for each row execute function public.notify_followers_after_comment_insert();

create or replace view public.notification_feed
with (security_invoker = true)
as
select
  notification.id,
  notification.recipient_id,
  notification.actor_id,
  actor.handle::text as actor_handle,
  actor.display_name as actor_display_name,
  actor.avatar_url as actor_avatar_url,
  notification.notification_type,
  notification.setup_id,
  notification.comment_id,
  setup.ticker,
  setup.status as setup_status,
  notification.created_at,
  notification.read_at
from public.notifications notification
join public.profiles actor on actor.id = notification.actor_id
join public.setups setup on setup.public_id = notification.setup_id
where notification.recipient_id = auth.uid();

create or replace function public.operator_social_summary(p_profile_id uuid)
returns table (
  follower_count bigint,
  following_count bigint,
  is_following boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select count(*)::bigint from public.operator_follows where following_id = p_profile_id),
    (select count(*)::bigint from public.operator_follows where follower_id = p_profile_id),
    exists (
      select 1
      from public.operator_follows
      where follower_id = auth.uid()
        and following_id = p_profile_id
    )
  where exists (
    select 1
    from public.profiles profile
    where profile.id = p_profile_id
      and (profile.is_public = true or profile.id = auth.uid())
      and profile.account_status = 'ACTIVE'
  );
$$;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;

revoke all on public.operator_follows from anon, authenticated;
revoke all on public.notification_preferences from anon, authenticated;
revoke all on public.notifications from anon, authenticated;

grant select, insert, delete on public.operator_follows to authenticated;
grant select, insert on public.notification_preferences to authenticated;
grant update (notifications_muted, notify_new_setups, notify_comments, notify_entry_hits) on public.notification_preferences to authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant delete on public.notifications to authenticated;
grant select on public.notification_feed to authenticated;

revoke execute on function public.touch_notification_preferences_updated_at() from public, anon, authenticated;
revoke execute on function public.create_notification_preferences_for_profile() from public, anon, authenticated;
revoke execute on function public.enqueue_follow_notifications(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.notify_followers_after_setup_insert() from public, anon, authenticated;
revoke execute on function public.notify_followers_after_setup_entry() from public, anon, authenticated;
revoke execute on function public.notify_followers_after_comment_insert() from public, anon, authenticated;
revoke execute on function public.operator_social_summary(uuid) from public, anon, authenticated;
grant execute on function public.operator_social_summary(uuid) to anon, authenticated;

commit;

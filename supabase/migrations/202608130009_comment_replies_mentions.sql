-- Composite Operator Ledger
-- Flat comment replies, clickable references, handle mentions, and private reply alerts.

begin;

alter table public.setup_comments
  add column reply_to_comment_id uuid references public.setup_comments(id) on delete set null;

create index setup_comments_reply_idx
on public.setup_comments (reply_to_comment_id)
where reply_to_comment_id is not null;

create or replace function public.validate_setup_comment_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_setup_id uuid;
  parent_deleted_at timestamptz;
begin
  if new.reply_to_comment_id is null then
    return new;
  end if;

  select parent.setup_id, parent.deleted_at
  into parent_setup_id, parent_deleted_at
  from public.setup_comments parent
  where parent.id = new.reply_to_comment_id;

  if parent_setup_id is null then
    raise exception 'Referenced comment does not exist.' using errcode = '23503';
  end if;

  if parent_setup_id <> new.setup_id then
    raise exception 'Replies must reference a comment in the same setup thread.' using errcode = '23514';
  end if;

  if parent_deleted_at is not null then
    raise exception 'Replies cannot reference a removed comment.' using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger setup_comments_validate_reply_before_insert
before insert on public.setup_comments
for each row execute function public.validate_setup_comment_reply();

create or replace view public.setup_comments_public
with (security_invoker = true)
as
select
  comment.id,
  comment.setup_id,
  comment.user_id,
  author.handle::text as handle,
  author.display_name,
  author.avatar_url,
  case when comment.deleted_at is null then comment.body else '[comment removed]' end as body,
  (comment.user_id = setup.user_id) as is_op,
  (comment.deleted_at is not null) as is_deleted,
  comment.created_at,
  comment.reply_to_comment_id,
  parent_author.handle::text as reply_to_handle,
  case
    when parent.id is null then null
    when parent.deleted_at is null then parent.body
    else '[comment removed]'
  end as reply_to_body,
  coalesce(parent.deleted_at is not null, false) as reply_to_is_deleted
from public.setup_comments comment
join public.profiles author on author.id = comment.user_id
join public.setups setup on setup.public_id = comment.setup_id
left join public.setup_comments parent on parent.id = comment.reply_to_comment_id
left join public.profiles parent_author on parent_author.id = parent.user_id
where author.is_public = true
  and author.account_status = 'ACTIVE';

alter table public.notifications
  drop constraint notifications_type_check;

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
      'SETUP_STOPPED'
    )
  );

create or replace function public.notify_comment_reply_and_mentions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reply_recipient_id uuid;
begin
  if new.reply_to_comment_id is not null then
    select parent.user_id
    into reply_recipient_id
    from public.setup_comments parent
    where parent.id = new.reply_to_comment_id;

    if reply_recipient_id is distinct from new.user_id then
      insert into public.notifications (
        recipient_id,
        actor_id,
        notification_type,
        setup_id,
        comment_id
      )
      select
        reply_recipient_id,
        new.user_id,
        'REPLY',
        new.setup_id,
        new.id
      from public.profiles recipient
      left join public.notification_preferences preferences
        on preferences.user_id = recipient.id
      where recipient.id = reply_recipient_id
        and recipient.is_public = true
        and recipient.account_status = 'ACTIVE'
        and coalesce(preferences.notifications_muted, false) = false
        and coalesce(preferences.notify_comments, true) = true
      on conflict do nothing;
    end if;
  end if;

  insert into public.notifications (
    recipient_id,
    actor_id,
    notification_type,
    setup_id,
    comment_id
  )
  select distinct
    mentioned.id,
    new.user_id,
    'MENTION',
    new.setup_id,
    new.id
  from regexp_matches(
    new.body,
    '@([a-z0-9][a-z0-9_-]{2,29})',
    'gi'
  ) as mention(handle_match)
  join public.profiles mentioned
    on lower(mentioned.handle::text) = lower((mention.handle_match)[1])
  left join public.notification_preferences preferences
    on preferences.user_id = mentioned.id
  where mentioned.id <> new.user_id
    and mentioned.id is distinct from reply_recipient_id
    and mentioned.is_public = true
    and mentioned.account_status = 'ACTIVE'
    and coalesce(preferences.notifications_muted, false) = false
    and coalesce(preferences.notify_comments, true) = true
  on conflict do nothing;

  return new;
end;
$$;

create trigger setup_comments_notify_reply_mentions_after_insert
after insert on public.setup_comments
for each row execute function public.notify_comment_reply_and_mentions();

grant insert (reply_to_comment_id) on public.setup_comments to authenticated;
grant select on public.setup_comments_public to anon, authenticated;

revoke execute on function public.validate_setup_comment_reply() from public, anon, authenticated;
revoke execute on function public.notify_comment_reply_and_mentions() from public, anon, authenticated;

commit;

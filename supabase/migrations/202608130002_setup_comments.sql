-- Composite Operator Ledger
-- Public setup discussions with authenticated authors, OP attribution, and soft deletion.

begin;

create table public.setup_comments (
  id uuid primary key default extensions.gen_random_uuid(),
  setup_id uuid not null references public.setups(public_id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint setup_comments_body_length check (char_length(btrim(body)) between 1 and 600)
);

create index setup_comments_setup_created_idx
on public.setup_comments (setup_id, created_at asc);

create index setup_comments_user_created_idx
on public.setup_comments (user_id, created_at desc);

alter table public.setup_comments enable row level security;

create policy setup_comments_public_read
on public.setup_comments for select
to anon, authenticated
using (
  exists (
    select 1
    from public.setups s
    join public.profiles op on op.id = s.user_id
    join public.profiles author on author.id = setup_comments.user_id
    where s.public_id = setup_comments.setup_id
      and op.is_public = true
      and op.account_status = 'ACTIVE'
      and author.is_public = true
      and author.account_status = 'ACTIVE'
  )
);

create policy setup_comments_member_insert
on public.setup_comments for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.profiles author
    where author.id = auth.uid()
      and author.account_status = 'ACTIVE'
  )
  and exists (
    select 1
    from public.setups s
    join public.profiles op on op.id = s.user_id
    where s.public_id = setup_comments.setup_id
      and op.is_public = true
      and op.account_status = 'ACTIVE'
  )
);

create policy setup_comments_owner_soft_delete
on public.setup_comments for update
to authenticated
using (user_id = auth.uid() and deleted_at is null)
with check (user_id = auth.uid() and deleted_at is not null);

create or replace view public.setup_comments_public
with (security_invoker = true)
as
select
  c.id,
  c.setup_id,
  c.user_id,
  p.handle::text as handle,
  p.display_name,
  p.avatar_url,
  case when c.deleted_at is null then c.body else '[comment removed]' end as body,
  (c.user_id = s.user_id) as is_op,
  (c.deleted_at is not null) as is_deleted,
  c.created_at
from public.setup_comments c
join public.profiles p on p.id = c.user_id
join public.setups s on s.public_id = c.setup_id
where p.is_public = true
  and p.account_status = 'ACTIVE';

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
  ) as comment_count
from public.setups s
join public.profiles p on p.id = s.user_id
where p.is_public = true and p.account_status = 'ACTIVE';

revoke all on public.setup_comments from anon, authenticated;
grant select on public.setup_comments to anon, authenticated;
grant insert (setup_id, user_id, body) on public.setup_comments to authenticated;
grant update (deleted_at) on public.setup_comments to authenticated;
grant select on public.setup_comments_public to anon, authenticated;
grant select on public.setups_public to anon, authenticated;

commit;

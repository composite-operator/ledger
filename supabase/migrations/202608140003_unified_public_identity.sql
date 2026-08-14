-- One public identity: the canonical handle also supplies the legacy
-- display_name column used by existing views and API response shapes.

update public.profiles
set display_name = handle::text
where display_name is distinct from handle::text;

create or replace function public.sync_profile_public_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.display_name := new.handle::text;
  return new;
end;
$$;

drop trigger if exists profiles_sync_public_identity on public.profiles;

create trigger profiles_sync_public_identity
before insert or update of handle, display_name on public.profiles
for each row execute function public.sync_profile_public_identity();

alter table public.profiles
  drop constraint if exists profiles_public_identity_matches;

alter table public.profiles
  add constraint profiles_public_identity_matches
  check (display_name = handle::text);

revoke execute on function public.sync_profile_public_identity() from public, anon, authenticated;

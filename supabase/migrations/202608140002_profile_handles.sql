-- Owner-editable public handles. The existing citext unique constraint keeps
-- collisions case-insensitive, and profiles_owner_update limits writes to self.

grant update (handle) on public.profiles to authenticated;

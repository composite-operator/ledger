-- Allow the trusted market-order Edge Function to activate verified setups.
-- Browser roles keep their narrower grants and RLS policies.

begin;

grant select, insert on public.setups to service_role;
grant insert on public.setup_events to service_role;
grant usage, select on sequence public.setups_id_seq to service_role;

commit;

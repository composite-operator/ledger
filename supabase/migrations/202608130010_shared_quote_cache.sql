-- Shared, demand-driven quote cache for every public non-final Ledger symbol.
-- Browser visits can request a refresh, but Postgres claims each stale symbol once
-- so concurrent visitors do not multiply upstream quote-provider requests.

begin;

create table public.setup_quote_cache (
  ticker text primary key,
  price numeric(24, 8),
  currency text,
  exchange text,
  source text,
  requested_symbol text,
  resolved_symbol text,
  asset_class text,
  quoted_at timestamptz,
  refreshed_at timestamptz,
  next_refresh_at timestamptz not null default to_timestamp(0),
  refresh_interval_seconds integer not null default 300
    check (refresh_interval_seconds between 30 and 3600),
  last_error text,
  constraint setup_quote_cache_ticker_shape check (ticker ~ '^[A-Z0-9.^=_-]{1,16}$'),
  constraint setup_quote_cache_price_positive check (price is null or price > 0)
);

create index setup_quote_cache_due_idx
  on public.setup_quote_cache (next_refresh_at, ticker);

alter table public.setup_quote_cache enable row level security;

revoke all on public.setup_quote_cache from public, anon, authenticated;
grant select, insert, update, delete on public.setup_quote_cache to service_role;

create or replace function public.claim_setup_quote_refreshes(
  p_preferred text[] default array[]::text[],
  p_limit integer default 24,
  p_lease_seconds integer default 45
)
returns table (ticker text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A symbol remains tracked while at least one public setup for it is non-final.
  delete from public.setup_quote_cache cache
  where not exists (
    select 1
    from public.setups setup
    join public.profiles profile on profile.id = setup.user_id
    where upper(trim(setup.ticker)) = cache.ticker
      and setup.final_status is null
      and setup.status not in (
        'STOPPED'::public.setup_status,
        'CANCELLED'::public.setup_status,
        'EXPIRED'::public.setup_status,
        'CLOSED'::public.setup_status,
        'RESOLVED'::public.setup_status
      )
      and profile.is_public = true
      and profile.account_status = 'ACTIVE'
  );

  insert into public.setup_quote_cache (ticker, refresh_interval_seconds)
  select
    open_symbol.ticker,
    open_symbol.refresh_interval_seconds
  from (
    select
      upper(trim(setup.ticker)) as ticker,
      min(
        case
          when setup.status in (
            'HOT'::public.setup_status,
            'ACTIVE'::public.setup_status,
            'T1_HIT'::public.setup_status,
            'T2_HIT'::public.setup_status,
            'T3_HIT'::public.setup_status
          ) then 60
          when setup.status = 'NEAR'::public.setup_status then 120
          else 300
        end
      )::integer as refresh_interval_seconds
    from public.setups setup
    join public.profiles profile on profile.id = setup.user_id
    where setup.final_status is null
      and setup.status not in (
        'STOPPED'::public.setup_status,
        'CANCELLED'::public.setup_status,
        'EXPIRED'::public.setup_status,
        'CLOSED'::public.setup_status,
        'RESOLVED'::public.setup_status
      )
      and profile.is_public = true
      and profile.account_status = 'ACTIVE'
    group by upper(trim(setup.ticker))
  ) open_symbol
  on conflict on constraint setup_quote_cache_pkey do update
  set
    next_refresh_at = case
      when excluded.refresh_interval_seconds < setup_quote_cache.refresh_interval_seconds
        then least(setup_quote_cache.next_refresh_at, now())
      else setup_quote_cache.next_refresh_at
    end,
    refresh_interval_seconds = excluded.refresh_interval_seconds;

  return query
  with candidates as (
    select cache.ticker
    from public.setup_quote_cache cache
    where cache.next_refresh_at <= now()
    order by
      (cache.price is null and cache.ticker = any(coalesce(p_preferred, array[]::text[]))) desc,
      cache.next_refresh_at asc,
      (cache.ticker = any(coalesce(p_preferred, array[]::text[]))) desc,
      cache.ticker asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 24), 40))
  ), claimed as (
    update public.setup_quote_cache cache
    set next_refresh_at = now() + make_interval(
      secs => greatest(
        cache.refresh_interval_seconds,
        greatest(30, least(coalesce(p_lease_seconds, 45), 300))
      )
    )
    from candidates
    where cache.ticker = candidates.ticker
    returning cache.ticker
  )
  select claimed.ticker
  from claimed;
end;
$$;

create or replace function public.setup_quote_snapshot(
  p_tickers text[] default array[]::text[]
)
returns table (
  ticker text,
  price numeric,
  currency text,
  exchange text,
  source text,
  requested_symbol text,
  resolved_symbol text,
  asset_class text,
  quoted_at timestamptz,
  refreshed_at timestamptz,
  next_refresh_at timestamptz
)
language sql
security definer
set search_path = ''
as $$
  select
    cache.ticker,
    cache.price,
    cache.currency,
    cache.exchange,
    cache.source,
    cache.requested_symbol,
    cache.resolved_symbol,
    cache.asset_class,
    cache.quoted_at,
    cache.refreshed_at,
    cache.next_refresh_at
  from public.setup_quote_cache cache
  where cardinality(coalesce(p_tickers, array[]::text[])) = 0
     or cache.ticker = any(p_tickers)
  order by cache.ticker
  limit 500;
$$;

create or replace function public.store_setup_quote_results(p_results jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.setup_quote_cache cache
  set
    price = coalesce(result.price, cache.price),
    currency = coalesce(result.currency, cache.currency),
    exchange = coalesce(result.exchange, cache.exchange),
    source = coalesce(result.source, cache.source),
    requested_symbol = coalesce(result.requested_symbol, cache.requested_symbol),
    resolved_symbol = coalesce(result.resolved_symbol, cache.resolved_symbol),
    asset_class = coalesce(result.asset_class, cache.asset_class),
    quoted_at = coalesce(result.quoted_at, cache.quoted_at),
    refreshed_at = case when result.price is not null then now() else cache.refreshed_at end,
    last_error = result.error
  from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb)) as result(
    ticker text,
    price numeric,
    currency text,
    exchange text,
    source text,
    requested_symbol text,
    resolved_symbol text,
    asset_class text,
    quoted_at timestamptz,
    error text
  )
  where cache.ticker = upper(trim(result.ticker));
$$;

revoke execute on function public.claim_setup_quote_refreshes(text[], integer, integer)
  from public, anon, authenticated;
revoke execute on function public.setup_quote_snapshot(text[])
  from public, anon, authenticated;
revoke execute on function public.store_setup_quote_results(jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_setup_quote_refreshes(text[], integer, integer)
  to service_role;
grant execute on function public.setup_quote_snapshot(text[])
  to service_role;
grant execute on function public.store_setup_quote_results(jsonb)
  to service_role;

commit;

# Architecture

## Production topology

```text
GitHub Pages
  └─ Static Ledger interface
       ├─ Supabase Auth → Ledger email/password accounts
       └─ Supabase Data API → Postgres + row-level security
                                    ↑
                                    └─ trusted outcome worker
                                       (Apps Script during migration)
```

GitHub Pages cannot run server-side code or keep secrets. Supabase is the identity, database, policy, and query layer. The private Apps Script workbook can remain the price and outcome worker until those jobs move to a dedicated service.

## Shared quote refresh

The browser requests an immediate quote snapshot after Ledger data loads. While the tab is visible, it checks again after a randomized 45-to-75-second delay. Hidden tabs do not poll, and a returning tab refreshes only when its prior request is old enough.

`setup-book-quotes` does not trust the browser as the tracking inventory. Its Postgres claim function derives unique symbols from public, non-final setups. Each stale cache row can be claimed by only one concurrent function request. The function refreshes at most 24 symbols per request, which lets higher traffic process separate rolling chunks without duplicating provider calls.

Postgres makes symbols due by their most urgent open setup:

- `HOT`, `ACTIVE`, and target-hit states: 60 seconds
- `NEAR`: 120 seconds
- Other non-final states: 300 seconds

When the last open setup for a ticker becomes final, the next cache claim removes that ticker. A closed setup does not stop a shared ticker that another open setup still needs.

## Main records

### `profiles`

One public operator profile exists per authenticated Supabase user. The `auth.users` insert trigger creates a collision-safe handle from Ledger signup metadata. The user can change public display fields, but cannot assign another user ID. Google and X can be linked later without changing this ownership model.

### `setups`

The public submission record. Core risk fields are immutable after insertion:

- operator
- ticker
- direction
- horizon
- trigger type
- entry
- stop
- targets
- strategy
- thesis
- submission time

Trusted processes can update only market state and outcome columns. Corrections use cancel-and-resubmit instead of retroactive edits.

### `setup_events`

Append-only operator events for price triggers, target hits, stops, and archival transitions. Browser roles receive no direct access.

### `trader_metrics`

One indexed aggregate row per user. A database trigger recalculates only the user affected by a setup or outcome change. Leaderboard queries do not scan every historical setup on every page view.

## Preserved scoring contract

The SQL migration preserves the current Apps Script logic:

- `Win Rate = T1 Hits / Total Setups`
- `Avg R = average resolved R result`
- `Total Score = sum of resolved setup scores`
- `Last 30D Score = sum of scores for setups submitted in the last 30 days`
- GOAT score requires at least 3 triggered setups
- Average R is capped to the range `[-5, 5]` inside GOAT score
- Sample weight reaches 100% at 20 triggered setups

```text
GOAT = (0.7 × capped Avg R + 0.3 × Win Rate) × min(1, Triggered / 20)
```

## Scale properties

- B-tree indexes cover user history, state feeds, ticker lookup, and ranking modes.
- `leaderboard_page` caps each request at 500 rows and accepts an offset.
- The UI uses pagination and local search for the first release.
- Each user has one profile route and any number of setup records.
- Outcome refresh recalculates one user, not the full network.
- A future cursor-based RPC can replace offset paging without changing stored records.

## Security properties

- Public users can read public profiles, public setups, and public metrics.
- Authenticated users can insert setups only for `auth.uid()`.
- Authenticated users have no update or delete policy on setups.
- Column grants limit profile updates to display fields.
- Core setup mutation is blocked by a database trigger, including trusted updates.
- `setup_events` has row-level security with no browser policies.
- Password hashes stay inside Supabase Auth and are never sent to the site or repository.

## Operator controls to add before open registration

The initial schema supplies the core security boundary. Before broad promotion, add:

1. Supabase CAPTCHA or Turnstile on sign-up.
2. A rate-limited submission Edge Function if abuse starts.
3. Terms, privacy, moderation, and optional provider-review pages before adding external social identity links.
4. An admin audit surface for suspensions and cancelled records.
5. Monitoring for repeated ticker spam and duplicate setup fingerprints.

# Workbook migration

## Goal

Move the user-facing workflow to the Ledger site without interrupting the current Apps Script price, state, archive, and score engines.

## Phase 1 — parallel read path

1. Deploy the GitHub Pages interface in preview mode.
2. Create Supabase and run the migration.
3. Enable native Ledger email/password accounts.
4. Import the existing public profiles, setups, archive, and leaderboard history.
5. Compare Supabase metrics with the current `Leaderboard` tab.
6. Keep the Google Form active during validation.

Do not call the migration complete until these measures match per operator:

- Total Setups
- Triggered Setups
- Stopped Setups
- T1, T2, and T3 Hits
- Win Rate
- Average percent from fill
- Average R
- Total Score
- GOAT Score
- Last 30D Score

## Phase 2 — website intake

1. Change `demoMode` to `false`.
2. Publish the configured Supabase URL and publishable key.
3. Accept setup inserts from the signed-in website form.
4. Add an Apps Script sync stage that reads unprocessed Supabase setups.
5. Append those rows into the private `Setups Master` processing path.
6. Write state and outcomes back to Supabase with the service role.

Store the service role key in Apps Script Properties. Never place it in a sheet cell, GitHub secret exposed to Pages, or browser JavaScript.

## Phase 3 — retire Google Form intake

After a successful parallel period:

1. Replace public Google Form links with `https://composite-operator.github.io/ledger/`.
2. Keep the private workbook as the operator console.
3. Disable new Google Form responses.
4. Preserve the Intake tab as historical evidence.
5. Continue privacy publishing only if the public workbook remains useful as a fallback export.

## Import map

### Identity Registry → `profiles`

The Supabase auth user must exist before its profile can own imported records. For historical handles with no login, use a controlled migration identity or retain them as legacy profiles in a dedicated import process. Do not fabricate account ownership.

### Setups Master / Archive → `setups`

| Workbook value | Supabase value |
| --- | --- |
| Poster Key | migration lookup to `profiles.id` |
| Poster | `profiles.handle` / `display_name` |
| Ticker Normalized | `setups.ticker` |
| Direction | `setups.direction` |
| Time Horizon | `setups.horizon` |
| Entry Trigger Type | `setups.trigger_type` |
| Entry / Stop / T1–T3 | matching numeric columns |
| Strategy / Notes | `strategy` / `thesis` |
| Entry Status | mapped `status` enum |
| Trigger / hit timestamps | matching timestamp columns |
| Final Status | `final_status` |
| R Result / Score | matching numeric columns |

Generate a stable `client_request_id` for each imported row and keep an import manifest. That gives the migration an idempotent replay key.

## Trusted worker contract

The current Apps Script engine can remain the trusted outcome worker during migration:

1. Select setups not yet mirrored to the workbook.
2. Append a canonical private row.
3. Mark the mirror ID in a private operator mapping.
4. Run price and state refresh.
5. Update only these Supabase fields:
   - `status`
   - `current_price`
   - `price_source`
   - trigger, target, stop, and archive timestamps
   - `pct_from_fill`
   - `r_result`
   - `score`
   - `final_status`
6. Append a corresponding `setup_events` row for each transition.

The database trigger rejects changes to the original risk plan.

## Cutover gates

- Ledger account creation succeeds from the production Pages URL.
- Email/password sign-in and sign-out succeed.
- Repeated sign-in returns the same profile.
- A user cannot submit for another profile ID.
- A user cannot update or delete a published setup.
- Long and short risk geometry rejects invalid values.
- Imported leaderboard metrics match the workbook.
- Pages contains no private key, service role key, email list, or private workbook ID.
- Mobile form and leaderboard pass visual checks.

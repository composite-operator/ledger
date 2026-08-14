# Composite Operator Ledger

## GOAT lifecycle

New Ledger records use explicit entry windows, horizon-based review cadence, allocation-weighted target outcomes, prospective public stop coaching, and the GOAT ranking formula. See [GOAT Lifecycle + Coaching Contract](docs/LIFECYCLE_COACHING_PROTOTYPE.md).

A public setup tracker and operator leaderboard for the Composite Operator Hub.

The site is designed for GitHub Pages. Supabase supplies the parts that a static host cannot supply:

- native Ledger email/password accounts
- public operator profiles
- durable setup records
- row-level access control
- indexed leaderboard metrics
- paginated search and profile views

If the live backend is unavailable, the interface shows an empty state. It does not invent operators, setups, or performance metrics.

## What ships

- Modern responsive Ledger interface
- Password-manager-friendly email/password sign-in with editable, unique public handles
- Searchable and sortable leaderboard
- Public per-operator profile drawers
- Owner-editable profile pictures, unique public handles, and bios
- Case-insensitive public-handle availability checks and collision-safe profile updates
- Setup-card author avatars with initials fallbacks for rapid operator identification
- Public join dates, complete performance stats, and recent setup history
- Queue, Hot, Near, Active, and Resolved setup states
- Permanent setup-book URLs for every state and the operator index
- Reversible heading sorts for posted date, entry distance, planned R, operator history, and comments, plus score sorting in the dropdown
- Adaptive setup-book rail with Network Pulse physically nested directly below the state filters
- Readable default typography for controls, setup records, discussions, authentication, and the complete submission form
- Device-local Readable mode for larger interface text and stronger contrast without changing the default presentation
- Direction-aware execution maps with SL, entry, current price, TP1-TP3, R multiples, and accessible hover or keyboard explanations
- Persistent Panels, Linear, and At a glance setup-book layouts for responsive comparison, full-record reading, or execution-bar scanning with one distance percentage
- Live Yahoo Finance quotes with Google Finance fallback for setup-to-entry distance
- Shared demand-driven quote cache with visible-tab refresh and automatic closed-symbol cleanup
- Top-100 crypto normalization from bare symbols such as `BTC` and `ETH` to canonical USD pairs
- Topbar ticker style guide with copyable commodity, index, foreign-exchange, and crypto symbols
- Structured setup form with live risk/reward checks
- Explicit horizon-bounded entry expiry and post-entry review cadence
- Full-T1, scale-and-protect, or custom target allocation plans
- Quote-driven Near, Hot, entry, target, stop, and resolution transitions
- GOAT scoring with NQ qualification until three triggered records resolve
- Author-only prospective Ledger stop revisions and review coaching
- Server-verified MARKET activation with a ±0.5% reference-price tolerance
- Collapsible public discussions with authenticated comments and starred OP replies
- Optional JPG, PNG, or WEBP chart attachments on original theses and comments, with direct `Ctrl+V` clipboard paste
- Operator follows with private, newest-first alerts for new setups, comments, and entry activation
- Notification mute, mark-read, sweep, and per-channel account settings
- Meme-native victory cards for positive closed trades, with stable share links, verified stats, and one-time win alerts
- Sardonic loss cards for negative closed trades, with red outcome art, stable share links, and optional one-time loss alerts
- Shareable setup links and a most-discussed feed sort
- Immutable entry, stop, target, and thesis fields after publication
- Supabase migration with row-level security
- GitHub Pages deployment workflow

## Turn on the live application

### 1. Create Supabase

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Run [`supabase/migrations/202608130001_initial_ledger.sql`](supabase/migrations/202608130001_initial_ledger.sql).
4. Run [`supabase/migrations/202608130002_setup_comments.sql`](supabase/migrations/202608130002_setup_comments.sql).
5. Run [`supabase/migrations/202608130003_market_edge_function.sql`](supabase/migrations/202608130003_market_edge_function.sql).
6. Run [`supabase/migrations/202608130004_activate_original_spy_market_test.sql`](supabase/migrations/202608130004_activate_original_spy_market_test.sql) only when the original SPY test row exists.
7. Run [`supabase/migrations/202608130005_setup_book_operator_metrics.sql`](supabase/migrations/202608130005_setup_book_operator_metrics.sql).
8. Deploy `supabase/functions/submit-market-setup`. Deploy `setup-book-quotes` after its cache migration in step 13.
9. Run [`supabase/migrations/202608130006_profile_avatars.sql`](supabase/migrations/202608130006_profile_avatars.sql) to create the public avatar bucket and owner-only upload policies.
10. Run [`supabase/migrations/202608130007_operator_notifications.sql`](supabase/migrations/202608130007_operator_notifications.sql) to add follows, private notification feeds, preferences, triggers, and Realtime delivery.
11. Run [`supabase/migrations/202608130008_setup_follows.sql`](supabase/migrations/202608130008_setup_follows.sql) to add personal setup watchlists plus Hot, entry, target, and stop-out alerts.
12. Run [`supabase/migrations/202608130009_comment_replies_mentions.sql`](supabase/migrations/202608130009_comment_replies_mentions.sql) to add comment replies, clickable references, handle mentions, and private reply or mention alerts.
13. Run [`supabase/migrations/202608130010_shared_quote_cache.sql`](supabase/migrations/202608130010_shared_quote_cache.sql) before deploying the latest `setup-book-quotes` function. This adds the shared quote cache and atomic rolling refresh claims.
14. Run [`supabase/migrations/202608130011_victory_cards.sql`](supabase/migrations/202608130011_victory_cards.sql) to add victory alerts, the win-notification preference, and the result fields used by notification cards.
15. Run [`supabase/migrations/202608140001_loss_cards.sql`](supabase/migrations/202608140001_loss_cards.sql) to add loss-card alerts and the separate loss-notification preference.
16. Run [`supabase/migrations/202608140002_profile_handles.sql`](supabase/migrations/202608140002_profile_handles.sql) to let authenticated owners change their unique public handle.
17. Run [`supabase/migrations/202608140003_unified_public_identity.sql`](supabase/migrations/202608140003_unified_public_identity.sql) to synchronize the legacy display-name column to the canonical handle and prevent future drift.
18. Run [`supabase/migrations/202608140004_lifecycle_coaching_prototype.sql`](supabase/migrations/202608140004_lifecycle_coaching_prototype.sql) to activate GOAT lifecycle automation, scoring, and the five-minute expiry job.
19. In **Authentication → URL Configuration**, set:
   - Site URL: `https://composite-operator.github.io/ledger/`
   - Redirect URL: `https://composite-operator.github.io/ledger/`

20. In **Authentication → Sign In / Providers → Email**, keep Email enabled.
21. For the $0 MVP, turn **Confirm email** off. This avoids relying on a paid production mail service. Add verified-email delivery later if the product needs email ownership proof or password-reset email.

Google and X are optional future identity links. They are not required for Ledger accounts.

### 2. Configure the browser client

Copy the project URL and publishable key from **Supabase → Project Settings → API** into [`assets/runtime-config.js`](assets/runtime-config.js):

```js
window.LEDGER_CONFIG = Object.freeze({
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabasePublishableKey: "sb_publishable_REPLACE_ME",
  siteUrl: "https://composite-operator.github.io/ledger/",
  demoMode: false
});
```

The Supabase publishable key is safe in a browser application when row-level security is active. Never put the `service_role` key in this repository or in browser code.

### 3. Enable GitHub Pages

In **Repository Settings → Pages**, select **GitHub Actions** as the source. A push to `main` then runs [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml). The workflow injects the current Git commit ID into local CSS, configuration, and JavaScript URLs so a browser cannot combine files from different Ledger releases.

## Local preview

Serve the repository root through any static HTTP server. Do not open `index.html` through a `file://` URL because authentication and API requests require an HTTP origin.

```powershell
python -m http.server 4173
```

Open `http://127.0.0.1:4173/`.

## Data contract

The new form preserves the current Google Form fields:

| Current field | Ledger field |
| --- | --- |
| Username | Authenticated profile handle |
| Private Handle Key | Removed; the private Ledger account owns identity |
| Ticker | `setups.ticker` |
| Direction | `LONG` or `SHORT` |
| Time Horizon | `DAY_TRADE`, `SWING`, `POSITION`, `LONG_TERM` |
| Entry Trigger Type | `BREACH`, `PULLBACK`, `MARKET` |
| Entry Price | `setups.entry` |
| Stop Loss | `setups.stop` |
| T1 / T2 / T3 | `setups.t1`, `t2`, `t3` |
| Strategy Tag | `setups.strategy` |
| Notes / Thesis | `setups.thesis` |

### Ticker resolution

- Bare symbols in the current CoinGecko top 100 resolve as crypto USD pairs. For example, `BTC` becomes `BTC-USD` and `ETH` becomes `ETH-USD`.
- Compact crypto pairs such as `BTCUSD` also become `BTC-USD`.
- Explicit pairs such as `BTC-USD` remain unchanged.
- Commodity futures use Yahoo Finance symbols such as `GC=F` for gold and `CL=F` for WTI crude. The topbar **Symbol guide** lists the supported common formats.
- A bare top-100 crypto symbol takes precedence over a same-named exchange-traded product. Use the intended product's explicit market symbol when you do not want the crypto pair.

The metric contract preserves the current 14-column leaderboard. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for scoring and [`docs/MIGRATION.md`](docs/MIGRATION.md) for the workbook transition.

## Security boundary

- GitHub Pages hosts only static public files.
- Password hashes stay in Supabase Auth and never enter this repository.
- Browser users receive only a publishable Supabase key.
- Row-level security limits user writes to their own setup submissions.
- Public risk fields lock after submission.
- Outcome updates use a trusted service process.
- MARKET submissions use an authenticated Edge Function. It classifies current top-100 crypto symbols through CoinGecko and verifies Yahoo Finance first. Crypto uses the matching CoinGecko market price before the final Google fallback; other assets use Google directly as the Yahoo fallback. The function snaps entry to the verified quote and activates the setup immediately when the submitted reference is within ±0.5%.
- Setup-book distance uses a publishable-key Edge Function with request-size and per-minute limits. The function reads the open-symbol set from Postgres, atomically claims stale symbols in rolling batches, and stores one shared quote for all visitors. Hot and active symbols become due every 60 seconds, near-entry symbols every 120 seconds, and other non-final symbols every 300 seconds. Final symbols leave the cache unless another open setup still uses the ticker. A 50% entry sanity gate suppresses ambiguous equity symbols. Explicit crypto, futures, index, and foreign-exchange resolutions bypass that ambiguity gate.
- Avatar files live in the public `avatars` bucket. Storage policies limit upload and replacement to the authenticated owner folder, while public reads support profile, leaderboard, header, and discussion images.
- Thesis and discussion images reuse the public `avatars` bucket under each authenticated owner's protected folder. Attachment references are retained inside the immutable thesis or comment record. The bucket accepts JPG, PNG, and WEBP images up to 2 MB.
- Follow relationships allow only owner-created writes. Notification rows and notification preferences are readable and mutable only by their recipient account.
- Private Google workbook tabs remain outside the public application.

## License

All rights reserved unless the repository owner adds a separate license.

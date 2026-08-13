# Composite Operator Ledger

A public setup tracker and operator leaderboard for the Composite Operator Hub.

The site is designed for GitHub Pages. Supabase supplies the parts that a static host cannot supply:

- Google and X OAuth sign-in
- public operator profiles
- durable setup records
- row-level access control
- indexed leaderboard metrics
- paginated search and profile views

The repository starts in an explicit preview mode. Preview mode shows only a verified snapshot from the current Ledger source Sheet. It does not invent operators, setups, or performance metrics while credentials and live records are unavailable.

## What ships

- Modern responsive Ledger interface
- Google and X sign-in buttons
- Searchable and sortable leaderboard
- Public per-operator profile drawers
- Queue, Hot, Near, Active, and Resolved setup states
- Structured setup form with live risk/reward checks
- Immutable entry, stop, target, and thesis fields after publication
- Supabase migration with row-level security
- GitHub Pages deployment workflow

## Turn on the live application

### 1. Create Supabase

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Run [`supabase/migrations/202608130001_initial_ledger.sql`](supabase/migrations/202608130001_initial_ledger.sql).
4. In **Authentication → URL Configuration**, set:
   - Site URL: `https://ximxesabortion.github.io/ledger/`
   - Redirect URL: `https://ximxesabortion.github.io/ledger/`

### 2. Enable Google sign-in

1. Create a Web application client in Google Auth Platform.
2. Add `https://ximxesabortion.github.io` as an authorized JavaScript origin.
3. Add the callback URL shown in **Supabase → Authentication → Providers → Google** as an authorized redirect URI. It has this shape:
   - `https://<project-ref>.supabase.co/auth/v1/callback`
4. Add the Google client ID and client secret to the Supabase Google provider.

### 3. Enable X sign-in

1. Create a Web App in the X Developer Portal.
2. Enable user authentication and request email access.
3. Use the callback URL shown in **Supabase → Authentication → Providers → X / Twitter (OAuth 2.0)**:
   - `https://<project-ref>.supabase.co/auth/v1/callback`
4. Add the X OAuth 2.0 client ID and client secret to Supabase.

The browser code uses the current Supabase provider name `x`. It does not use the legacy OAuth 1.0a `twitter` provider.

### 4. Configure the browser client

Copy the project URL and publishable key from **Supabase → Project Settings → API** into [`assets/runtime-config.js`](assets/runtime-config.js):

```js
window.LEDGER_CONFIG = Object.freeze({
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabasePublishableKey: "sb_publishable_REPLACE_ME",
  siteUrl: "https://ximxesabortion.github.io/ledger/",
  demoMode: false
});
```

The Supabase publishable key is safe in a browser application when row-level security is active. Never put the `service_role` key in this repository or in browser code.

### 5. Enable GitHub Pages

In **Repository Settings → Pages**, select **GitHub Actions** as the source. A push to `main` then runs [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml).

## Local preview

Serve the repository root through any static HTTP server. Do not open `index.html` through a `file://` URL because OAuth redirects and module requests require an HTTP origin.

```powershell
python -m http.server 4173
```

Open `http://127.0.0.1:4173/`.

## Data contract

The new form preserves the current Google Form fields:

| Current field | Ledger field |
| --- | --- |
| Username | Authenticated profile handle |
| Private Handle Key | Removed; Google/X account owns identity |
| Ticker | `setups.ticker` |
| Direction | `LONG` or `SHORT` |
| Time Horizon | `DAY_TRADE`, `SWING`, `POSITION`, `LONG_TERM` |
| Entry Trigger Type | `BREACH`, `PULLBACK`, `MARKET` |
| Entry Price | `setups.entry` |
| Stop Loss | `setups.stop` |
| T1 / T2 / T3 | `setups.t1`, `t2`, `t3` |
| Strategy Tag | `setups.strategy` |
| Notes / Thesis | `setups.thesis` |

The metric contract preserves the current 14-column leaderboard. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for scoring and [`docs/MIGRATION.md`](docs/MIGRATION.md) for the workbook transition.

## Security boundary

- GitHub Pages hosts only static public files.
- Google and X secrets live in Supabase provider settings.
- Browser users receive only a publishable Supabase key.
- Row-level security limits user writes to their own setup submissions.
- Public risk fields lock after submission.
- Outcome updates use a trusted service process.
- Private Google workbook tabs remain outside the public application.

## License

All rights reserved unless the repository owner adds a separate license.

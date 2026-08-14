# Lifecycle + Coaching Prototype

This branch is an isolated evaluation build. It does not change the live GitHub Pages site or the live Supabase project.

## Open the evaluation build

From the prototype worktree:

```powershell
python -m http.server 4173
```

Open:

```text
http://localhost:4173/?prototype=lifecycle#setups
```

The `prototype=lifecycle` parameter blocks the live Supabase connection and loads the fictional matrix. Remove that parameter to see the ordinary preview behavior.

## What is implemented

- High-contrast readable styling is the default. The old contrast toggle is removed.
- `DAY_TRADE` keeps its internal compatibility value but displays as **Scalp / short term**.
- Each horizon supplies a low-friction entry-validity default, maximum entry window, review cadence, and expected holding guide.
- The submission form has one visible management choice:
  - Full exit at T1
  - Scale out + protect
  - Custom allocation in a collapsed advanced panel
- Pending records expire after their explicit entry window. They remain in history and retain comments.
- Triggered records stop using entry expiry. They use review cadence and never lose score only because they are old.
- T1 and overdue-review states produce restrained coaching prompts.
- A stop change is a prospective **public Ledger stop revision**. The application does not claim that a broker order moved or that a partial exit occurred.
- Original entry, stop, and targets stay unchanged.
- LONG Ledger stops can only move up. SHORT Ledger stops can only move down. A stop cannot move through the current price or be backdated.
- Resolved target tranches are allocation-weighted in R.
- Scoring is versioned. Legacy records remain `LEGACY_T1_V1`; prototype records use `GOAT_V2_PROTOTYPE`.

## Horizon defaults

| Display horizon | Internal value | Default entry validity | Maximum entry validity | Review after entry | Expected holding guide |
| --- | --- | ---: | ---: | ---: | --- |
| Scalp / short term | `DAY_TRADE` | 1 day | 7 days | Daily | Minutes to one week |
| Swing | `SWING` | 14 days | 28 days | Weekly | Days to several months |
| Position | `POSITION` | 45 days | 90 days | Monthly | Months to several years |
| Long term | `LONG_TERM` | 180 days | 365 days | Quarterly | Years or open-ended |

These are defaults and bounded entry windows. They are not forced holding-period exits.

## GOAT v2 prototype

For one resolved trade:

```text
TradeR = sum(tranche allocation × tranche exit R)
GOAT_R = clamp(TradeR, -1, +5)
```

Discipline outcomes:

```text
Untriggered entry expiry = -0.10
Operator cancellation while entry is valid = -0.15
Technical or administrative void = excluded
```

Operator components:

```text
NetEdgeR = (sum(GOAT_R) - 0.10×expiries - 0.15×cancellations) / triggered resolved trades
EdgeComponent = clamp(NetEdgeR / 2, -1, +1)
AdjustedWinRate = (profitable trades + 2) / (triggered resolved trades + 4)
ConsistencyComponent = 2×AdjustedWinRate - 1
EvidenceWeight = min(1, triggered resolved trades / 20)
GOATv2 = 100 × (0.75×EdgeComponent + 0.25×ConsistencyComponent) × EvidenceWeight
```

The adjusted win rate shrinks small samples toward 50%. The evidence weight prevents a one-trade operator from taking the top career rank. Untriggered ideas do not count as full trading losses or as triggered evidence.

## Fictional evaluation matrix

The build contains 16 clearly marked records across four fictional operators:

1. Pending LONG scalp with a valid entry countdown.
2. Expired untriggered SHORT scalp with a -0.10 debit.
3. Active LONG scalp with an overdue daily review.
4. SHORT scalp stopped at the original stop.
5. LONG swing at T1 with a protect-remainder suggestion.
6. LONG BTC swing at T2 with a breakeven runner.
7. Weighted swing resolution: T1, T2, and breakeven runner.
8. Full three-target swing progression.
9. SHORT ETH swing at T1 with reversed stop direction.
10. SHORT position closed by thesis review after T1.
11. Valid pending position canceled by the operator.
12. SHORT swing with a T1 scale-out and entry stop.
13. Position trade that reaches T3.
14. Multi-year active record with a healthy quarterly review.
15. Technical void excluded from scoring.
16. Extreme long-term winner that demonstrates the +5R GOAT anti-outlier cap while retaining its +6.40R total result.

The prototype submission button also adds evaluator-created records to the current browser session. It does not write to Supabase.

## Evaluation checklist

- Change the form horizon and confirm that entry validity, review cadence, and holding guidance update together.
- Add or remove T2 and T3. Confirm that default target allocations stay at 100% total.
- Select Custom allocation and confirm that publication blocks totals other than 100%.
- Use **Update Ledger stop** on LONG and SHORT T1 cases. Confirm that the public stop changes but the original stop remains visible.
- Use **Review thesis** on the overdue active scalp. Confirm that the next review advances by one day and score does not change.
- Compare the weighted +0.50R, +1.00R, +1.90R, and +6.40R resolved examples.
- Confirm that expiry and cancellation are visible discipline debits, while the technical void is excluded.
- Compare the four fictional operators in the GOAT v2 panel and confirm that evidence weight is visible.
- Test Panels, Linear, and At a glance layouts. The compact view intentionally hides lifecycle detail and preserves the execution bar.

## Production gates

The migration file is a reviewable contract only. Do not apply it until these gates pass:

1. Product approval of horizon defaults and penalty values.
2. SQL review against a disposable Supabase branch or local Supabase instance.
3. Historical backfill verification. Legacy records must remain `LEGACY_T1_V1` with 100% at T1 unless their original allocations are known.
4. Quote-worker integration. The worker must set `review_due_at` when entry triggers and must stop entry-expiry processing for active records.
5. Resolution-worker integration for append-only tranche outcomes.
6. Scheduled call to `expire_due_pending_setups()` with service-role authority.
7. RLS and RPC abuse tests for author-only stop revisions and review events.
8. UI copy review. Public events must never claim a brokerage execution.

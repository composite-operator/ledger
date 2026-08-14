# GOAT 2.0 Lifecycle + Coaching Contract

This contract is active for new public Ledger records. It preserves the original plan, automates entry expiry and quote-driven lifecycle transitions, and scores resolved target allocations in R.

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
- Scoring is versioned. Legacy records remain `LEGACY_T1_V1`; new records use `GOAT_V2`.

## Horizon defaults

| Display horizon | Internal value | Default entry validity | Maximum entry validity | Review after entry | Expected holding guide |
| --- | --- | ---: | ---: | ---: | --- |
| Scalp / short term | `DAY_TRADE` | 1 day | 7 days | Daily | Minutes to one week |
| Swing | `SWING` | 14 days | 28 days | Weekly | Days to several months |
| Position | `POSITION` | 45 days | 90 days | Monthly | Months to several years |
| Long term | `LONG_TERM` | 180 days | 365 days | Quarterly | Years or open-ended |

These are defaults and bounded entry windows. They are not forced holding-period exits.

## GOAT v2

For one resolved trade:

```text
TradeR = sum(tranche allocation × tranche exit R)
GOAT_R = clamp(TradeR, -1, +5)
```

Discipline outcomes:

```text
Untriggered entry expiry = -0.10
Operator cancellation while entry is valid = -0.10
Technical or administrative void = excluded
```

Operator components:

```text
NetEdgeR = (sum(GOAT_R) - 0.10×expiries - 0.10×cancellations) / triggered resolved trades
EdgeComponent = clamp(NetEdgeR / 2, -1, +1)
AdjustedWinRate = (profitable trades + 2) / (triggered resolved trades + 4)
ConsistencyComponent = 2×AdjustedWinRate - 1
EvidenceWeight = min(1, triggered resolved trades / 20)
GOATv2 = 100 × (0.75×EdgeComponent + 0.25×ConsistencyComponent) × EvidenceWeight
```

The adjusted win rate shrinks small samples toward 50%. The public score remains **NQ** until three triggered records resolve. Evidence reaches full weight at twenty resolved trades. Untriggered ideas do not count as full trading losses or triggered evidence.

## Automation contract

- Supabase Cron expires due pending records every five minutes.
- The shared quote worker processes only symbols that still have a non-final public setup.
- Quote results move pending records through Near and Hot, trigger valid entries, record target tranches, and stop final records.
- Final records leave the quote cache unless another open setup uses the same symbol.
- Review reminders begin only after entry. Active records never expire because of age.
- Coaching actions are author-only public Ledger updates. They never claim a brokerage execution.

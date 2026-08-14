(function (root) {
  "use strict";

  const engine = root.LedgerLifecycle;
  if (!engine) throw new Error("LedgerLifecycle must load before lifecycle fixtures.");

  const HOUR_MS = 3600000;
  const DAY_MS = engine.DAY_MS;
  const operators = [
    { id: "prototype-op-orbit", handle: "orbit", bio: "Systematic swing trader. Fictional lifecycle evaluation operator." },
    { id: "prototype-op-hedgewitch", handle: "hedgewitch", bio: "Short-biased risk manager. Fictional lifecycle evaluation operator." },
    { id: "prototype-op-tapeghost", handle: "tapeghost", bio: "Fast tape and scalp specialist. Fictional lifecycle evaluation operator." },
    { id: "prototype-op-slowcapital", handle: "slowcapital", bio: "Position and long-horizon allocator. Fictional lifecycle evaluation operator." }
  ];

  function atOffset(base, offsetMs) {
    return new Date(base.getTime() + offsetMs).toISOString();
  }

  function buildLifecyclePrototype(nowValue) {
    const now = new Date(nowValue || Date.now());
    const ago = (amount, unit = DAY_MS) => atOffset(now, -amount * unit);
    const ahead = (amount, unit = DAY_MS) => atOffset(now, amount * unit);
    const setup = (values) => ({
      quote_symbol: values.ticker,
      live_quote_source: "fictional simulation",
      live_quote_at: ago(4, HOUR_MS),
      scoring_version: "GOAT_V2_PROTOTYPE",
      strategy: "Lifecycle simulation",
      trigger_type: "BREACH",
      comment_count: 0,
      ...values
    });

    const setups = [
      setup({
        id: "sim-001", user_id: operators[2].id, handle: operators[2].handle,
        scenario_label: "Pending scalp / valid entry window", ticker: "ES=F", direction: "LONG", horizon: "DAY_TRADE", status: "NEAR",
        entry: 6488, stop: 6468, t1: 6528, t2: 6548, current_price: 6483,
        management_style: "SCALE_PROTECT", target_allocations: [0.5, 0.5, 0], ledger_stop: 6468,
        submitted_at: ago(6, HOUR_MS), entry_expires_at: ahead(18, HOUR_MS), review_due_at: ahead(1), review_cadence_days: 1,
        thesis: "SIMULATION: a short-term entry remains valid and displays a hard countdown before it can trigger.", comment_count: 3
      }),
      setup({
        id: "sim-002", user_id: operators[2].id, handle: operators[2].handle,
        scenario_label: "Expired untriggered scalp", ticker: "NQ=F", direction: "SHORT", horizon: "DAY_TRADE", status: "EXPIRED",
        entry: 23620, stop: 23720, t1: 23420, current_price: 23805,
        management_style: "FULL_T1", target_allocations: [1, 0, 0], ledger_stop: 23720,
        submitted_at: ago(4), entry_expires_at: ago(3), resolved_at: ago(3), expiry_reason: "ENTRY_WINDOW_ELAPSED",
        thesis: "SIMULATION: the market never reached entry. The record stays visible and receives only a -0.10 discipline debit.", comment_count: 6
      }),
      setup({
        id: "sim-003", user_id: operators[2].id, handle: operators[2].handle,
        scenario_label: "Active scalp / review due", ticker: "SPY", direction: "LONG", horizon: "DAY_TRADE", status: "ACTIVE",
        entry: 777.8, stop: 773.8, t1: 785.8, t2: 789.8, current_price: 780.1,
        management_style: "SCALE_PROTECT", target_allocations: [0.5, 0.5, 0], ledger_stop: 773.8,
        submitted_at: ago(3), triggered_at: ago(2), entry_expires_at: ago(2), review_due_at: ago(1), review_cadence_days: 1,
        thesis: "SIMULATION: entry triggered, so expiry stopped. A daily thesis review is now overdue without score decay.", comment_count: 9
      }),
      setup({
        id: "sim-004", user_id: operators[2].id, handle: operators[2].handle,
        scenario_label: "Scalp stopped before T1", ticker: "QQQ", direction: "SHORT", horizon: "DAY_TRADE", status: "STOPPED",
        entry: 581, stop: 586, t1: 571, current_price: 586,
        management_style: "FULL_T1", target_allocations: [1, 0, 0], ledger_stop: 586,
        submitted_at: ago(8), triggered_at: ago(8), resolved_at: ago(7), tranche_outcomes: [{ allocation: 1, r: -1 }],
        thesis: "SIMULATION: a clean original-stop loss demonstrates the -1R floor and immutable initial risk map.", comment_count: 11
      }),
      setup({
        id: "sim-005", user_id: operators[0].id, handle: operators[0].handle,
        scenario_label: "Swing T1 / protect remainder", ticker: "IWM", direction: "LONG", horizon: "SWING", status: "T1_HIT",
        entry: 303.5, stop: 294.4, t1: 312.6, t2: 321.7, t3: 330.8, current_price: 315.2,
        management_style: "SCALE_PROTECT", target_allocations: [0.4, 0.3, 0.3], ledger_stop: 294.4,
        submitted_at: ago(11), triggered_at: ago(9), entry_expires_at: ahead(3), review_due_at: ahead(4), review_cadence_days: 7,
        thesis: "SIMULATION: T1 is recorded. The coach suggests a prospective Ledger stop at entry for the remaining 60%.", comment_count: 12
      }),
      setup({
        id: "sim-006", user_id: operators[0].id, handle: operators[0].handle,
        scenario_label: "Swing T2 / breakeven runner", ticker: "BTC-USD", direction: "LONG", horizon: "SWING", status: "T2_HIT",
        entry: 112000, stop: 106000, t1: 118000, t2: 124000, t3: 130000, current_price: 125400,
        management_style: "SCALE_PROTECT", target_allocations: [0.4, 0.3, 0.3], ledger_stop: 112000,
        submitted_at: ago(24), triggered_at: ago(20), entry_expires_at: ago(10), review_due_at: ahead(1), review_cadence_days: 7,
        thesis: "SIMULATION: two tranches have paid 1R and 2R. The final 30% remains live behind the revised entry stop.", comment_count: 18,
        management_events: [{ type: "LEDGER_STOP_REVISED", from: 106000, to: 112000, effective_at: ago(12) }]
      }),
      setup({
        id: "sim-007", user_id: operators[0].id, handle: operators[0].handle,
        scenario_label: "Resolved swing / weighted T2 win", ticker: "META", direction: "LONG", horizon: "SWING", status: "RESOLVED",
        entry: 704, stop: 684, t1: 724, t2: 744, t3: 764, current_price: 744,
        management_style: "SCALE_PROTECT", target_allocations: [0.4, 0.3, 0.3], ledger_stop: 704,
        submitted_at: ago(48), triggered_at: ago(43), resolved_at: ago(29), tranche_outcomes: [{ allocation: 0.4, r: 1 }, { allocation: 0.3, r: 2 }, { allocation: 0.3, r: 0 }],
        thesis: "SIMULATION: 40% exited at T1, 30% at T2, and the protected runner exited at entry for a weighted +1.00R.", comment_count: 14
      }),
      setup({
        id: "sim-008", user_id: operators[0].id, handle: operators[0].handle,
        scenario_label: "Resolved swing / full T3 progression", ticker: "AVGO", direction: "LONG", horizon: "SWING", status: "RESOLVED",
        entry: 292, stop: 282, t1: 302, t2: 312, t3: 322, current_price: 322,
        management_style: "SCALE_PROTECT", target_allocations: [0.4, 0.3, 0.3], ledger_stop: 302,
        submitted_at: ago(70), triggered_at: ago(63), resolved_at: ago(37), tranche_outcomes: [{ allocation: 0.4, r: 1 }, { allocation: 0.3, r: 2 }, { allocation: 0.3, r: 3 }],
        thesis: "SIMULATION: all three target tranches filled for a transparent weighted +1.90R outcome.", comment_count: 22
      }),
      setup({
        id: "sim-009", user_id: operators[1].id, handle: operators[1].handle,
        scenario_label: "Short swing / T1 protection suggestion", ticker: "ETH-USD", direction: "SHORT", horizon: "SWING", status: "T1_HIT",
        entry: 4200, stop: 4380, t1: 4020, t2: 3840, t3: 3660, current_price: 3988,
        management_style: "SCALE_PROTECT", target_allocations: [0.4, 0.3, 0.3], ledger_stop: 4380,
        submitted_at: ago(15), triggered_at: ago(12), entry_expires_at: ahead(1), review_due_at: ahead(2), review_cadence_days: 7,
        thesis: "SIMULATION: a SHORT reaches T1. The prospective stop rule reverses direction and suggests moving down to entry.", comment_count: 13
      }),
      setup({
        id: "sim-010", user_id: operators[1].id, handle: operators[1].handle,
        scenario_label: "Short position / time-based close", ticker: "CL=F", direction: "SHORT", horizon: "POSITION", status: "CLOSED",
        entry: 92, stop: 98, t1: 86, t2: 80, current_price: 84.5,
        management_style: "SCALE_PROTECT", target_allocations: [0.5, 0.5, 0], ledger_stop: 92,
        submitted_at: ago(120), triggered_at: ago(101), resolved_at: ago(32), tranche_outcomes: [{ allocation: 0.5, r: 1 }, { allocation: 0.5, r: 1.25 }],
        thesis: "SIMULATION: a position closes by thesis review after T1, with its second tranche scored at the actual +1.25R exit.", comment_count: 17
      }),
      setup({
        id: "sim-011", user_id: operators[1].id, handle: operators[1].handle,
        scenario_label: "Operator-cancelled pending position", ticker: "AAPL", direction: "LONG", horizon: "POSITION", status: "CANCELLED",
        entry: 248, stop: 232, t1: 280, current_price: 241,
        management_style: "FULL_T1", target_allocations: [1, 0, 0], ledger_stop: 232,
        submitted_at: ago(22), entry_expires_at: ahead(23), resolved_at: ago(2),
        thesis: "SIMULATION: the operator canceled a still-valid idea. It remains auditable with a small -0.15 discipline debit.", comment_count: 5
      }),
      setup({
        id: "sim-012", user_id: operators[1].id, handle: operators[1].handle,
        scenario_label: "Short loss after T1 scale-out", ticker: "NVDA", direction: "SHORT", horizon: "SWING", status: "STOPPED",
        entry: 225, stop: 237, t1: 213, t2: 201, current_price: 225,
        management_style: "SCALE_PROTECT", target_allocations: [0.5, 0.5, 0], ledger_stop: 225,
        submitted_at: ago(61), triggered_at: ago(55), resolved_at: ago(40), tranche_outcomes: [{ allocation: 0.5, r: 1 }, { allocation: 0.5, r: 0 }],
        thesis: "SIMULATION: half paid at T1 and half stopped at entry. The outcome is +0.50R, not a binary win or loss.", comment_count: 20
      }),
      setup({
        id: "sim-013", user_id: operators[3].id, handle: operators[3].handle,
        scenario_label: "Position T3 / complete winner", ticker: "GLD", direction: "LONG", horizon: "POSITION", status: "RESOLVED",
        entry: 295, stop: 275, t1: 315, t2: 335, t3: 355, current_price: 355,
        management_style: "SCALE_PROTECT", target_allocations: [0.4, 0.3, 0.3], ledger_stop: 315,
        submitted_at: ago(210), triggered_at: ago(182), resolved_at: ago(28), tranche_outcomes: [{ allocation: 0.4, r: 1 }, { allocation: 0.3, r: 2 }, { allocation: 0.3, r: 3 }],
        thesis: "SIMULATION: the long-running position reaches every target and resolves at weighted +1.90R.", comment_count: 26
      }),
      setup({
        id: "sim-014", user_id: operators[3].id, handle: operators[3].handle,
        scenario_label: "Long-term active / quarterly review healthy", ticker: "MSFT", direction: "LONG", horizon: "LONG_TERM", status: "ACTIVE",
        entry: 430, stop: 360, t1: 570, t2: 640, t3: 710, current_price: 512,
        management_style: "SCALE_PROTECT", target_allocations: [0.4, 0.3, 0.3], ledger_stop: 430,
        submitted_at: ago(490), triggered_at: ago(430), entry_expires_at: ago(310), review_due_at: ahead(42), review_cadence_days: 90,
        thesis: "SIMULATION: a multi-year thesis remains healthy because its quarterly review is current. Age alone causes no score decay.", comment_count: 31,
        management_events: [{ type: "LEDGER_STOP_REVISED", from: 360, to: 430, effective_at: ago(220) }]
      }),
      setup({
        id: "sim-015", user_id: operators[3].id, handle: operators[3].handle,
        scenario_label: "Long-term technical void", ticker: "BRK-B", direction: "LONG", horizon: "LONG_TERM", status: "TECHNICAL_VOID",
        entry: 525, stop: 470, t1: 635, current_price: 531,
        management_style: "FULL_T1", target_allocations: [1, 0, 0], ledger_stop: 470,
        submitted_at: ago(380), resolved_at: ago(360), void_reason: "BAD_VENDOR_SYMBOL_MAPPING",
        thesis: "SIMULATION: a vendor mapping error voids the record. It stays visible but is excluded from score and evidence.", comment_count: 4
      }),
      setup({
        id: "sim-016", user_id: operators[3].id, handle: operators[3].handle,
        scenario_label: "Long-term resolved / capped outlier", ticker: "AMZN", direction: "LONG", horizon: "LONG_TERM", status: "RESOLVED",
        entry: 86, stop: 74, t1: 110, t2: 146, t3: 194, current_price: 194,
        management_style: "CUSTOM", target_allocations: [0.2, 0.3, 0.5], ledger_stop: 110,
        submitted_at: ago(910), triggered_at: ago(850), resolved_at: ago(65), tranche_outcomes: [{ allocation: 0.2, r: 2 }, { allocation: 0.3, r: 5 }, { allocation: 0.5, r: 9 }],
        thesis: "SIMULATION: an extreme +6.40R weighted result stays in total score but contributes at the +5R GOAT anti-outlier cap.", comment_count: 38
      })
    ];

    setups.forEach((record) => {
      const score = engine.scoreSetup(record);
      if (score.kind === "trade") {
        record.r_result = score.tradeR;
        record.score = score.tradeR;
      } else if (["expiry", "cancel", "void"].includes(score.kind)) {
        record.score = score.score;
      }
      record.lifecycle = engine.lifecycleState(record, now);
      record.coaching = engine.coachingSuggestion(record, now);
    });

    const leaders = operators.map((operator) => {
      const records = setups.filter((record) => record.user_id === operator.id);
      const goat = engine.goatV2(records);
      return {
        ...operator,
        display_name: operator.handle,
        total_setups: records.length,
        triggered_setups: goat.triggeredResolved,
        stopped_setups: records.filter((record) => record.status === "STOPPED").length,
        t1_hits: records.filter((record) => ["T1_HIT", "T2_HIT", "T3_HIT", "RESOLVED", "CLOSED"].includes(record.status)).length,
        t2_hits: records.filter((record) => ["T2_HIT", "T3_HIT"].includes(record.status) || (record.tranche_outcomes || []).length >= 2).length,
        t3_hits: records.filter((record) => record.status === "T3_HIT" || (record.tranche_outcomes || []).length >= 3).length,
        win_rate: goat.triggeredResolved ? goat.profitableCount / goat.triggeredResolved : null,
        avg_r: goat.triggeredResolved ? goat.netEdgeR : null,
        total_score: goat.totalScore,
        goat_score: goat.goatScore,
        last_30d_score: records.filter((record) => new Date(record.resolved_at || 0) >= new Date(now.getTime() - 30 * DAY_MS)).reduce((total, record) => total + (engine.scoreSetup(record).score || 0), 0),
        goat_v2: goat,
        created_at: ago(1100)
      };
    }).sort((a, b) => b.goat_score - a.goat_score).map((operator, index) => ({ ...operator, rank_position: index + 1, total_count: operators.length }));

    setups.forEach((record) => {
      const operator = leaders.find((leader) => leader.id === record.user_id);
      record.operator_total_setups = operator.total_setups;
      record.operator_triggered_setups = operator.triggered_setups;
      record.operator_win_rate = operator.win_rate;
      record.operator_avg_r = operator.avg_r;
      record.operator_goat_score = operator.goat_score;
    });

    return {
      generatedAt: now.toISOString(),
      setups,
      leaders,
      summary: {
        records: setups.length,
        operators: leaders.length,
        entryExpired: setups.filter((record) => engine.scoreSetup(record).kind === "expiry").length,
        reviewDue: setups.filter((record) => engine.lifecycleState(record, now).state === "REVIEW_DUE").length,
        coachPrompts: setups.filter((record) => engine.coachingSuggestion(record, now)).length,
        scoredTrades: setups.filter((record) => engine.scoreSetup(record).kind === "trade").length,
        technicalVoids: setups.filter((record) => engine.scoreSetup(record).kind === "void").length
      }
    };
  }

  root.LEDGER_LIFECYCLE_FIXTURES = Object.freeze({ build: buildLifecyclePrototype });
})(typeof globalThis !== "undefined" ? globalThis : this);

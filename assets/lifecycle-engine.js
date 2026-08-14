(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LedgerLifecycle = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY_MS = 86400000;
  const HORIZON_PRESETS = Object.freeze({
    DAY_TRADE: Object.freeze({
      label: "Scalp / short term",
      entryValidityDays: 1,
      entryValidityMaxDays: 7,
      reviewCadenceDays: 1,
      reviewLabel: "Daily",
      holdingGuide: "Minutes to one week"
    }),
    SWING: Object.freeze({
      label: "Swing",
      entryValidityDays: 14,
      entryValidityMaxDays: 28,
      reviewCadenceDays: 7,
      reviewLabel: "Weekly",
      holdingGuide: "Days to several months"
    }),
    POSITION: Object.freeze({
      label: "Position",
      entryValidityDays: 45,
      entryValidityMaxDays: 90,
      reviewCadenceDays: 30,
      reviewLabel: "Monthly",
      holdingGuide: "Months to several years"
    }),
    LONG_TERM: Object.freeze({
      label: "Long term",
      entryValidityDays: 180,
      entryValidityMaxDays: 365,
      reviewCadenceDays: 90,
      reviewLabel: "Quarterly",
      holdingGuide: "Years or open-ended"
    })
  });

  const MANAGEMENT_PRESETS = Object.freeze({
    FULL_T1: Object.freeze({
      label: "Full exit at T1",
      description: "Score the full position at the first target."
    }),
    SCALE_PROTECT: Object.freeze({
      label: "Scale out + protect",
      description: "Take partial gains, then protect the remaining thesis."
    }),
    CUSTOM: Object.freeze({
      label: "Custom allocation",
      description: "Set explicit target allocations in the advanced panel."
    })
  });

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function horizonPreset(horizon) {
    return HORIZON_PRESETS[String(horizon || "SWING").toUpperCase()] || HORIZON_PRESETS.SWING;
  }

  function deriveLifecycleDefaults(horizon, nowValue) {
    const preset = horizonPreset(horizon);
    const now = new Date(nowValue || Date.now());
    const entryExpiresAt = new Date(now.getTime() + preset.entryValidityDays * DAY_MS);
    const reviewDueAt = new Date(now.getTime() + preset.reviewCadenceDays * DAY_MS);
    return {
      entryExpiresAt: entryExpiresAt.toISOString(),
      reviewDueAt: reviewDueAt.toISOString(),
      reviewCadenceDays: preset.reviewCadenceDays,
      entryValidityDays: preset.entryValidityDays,
      entryValidityMaxDays: preset.entryValidityMaxDays,
      holdingGuide: preset.holdingGuide
    };
  }

  function computeTargetR(direction, entryValue, stopValue, targetValue) {
    const entry = finiteNumber(entryValue);
    const stop = finiteNumber(stopValue);
    const target = finiteNumber(targetValue);
    if (entry == null || stop == null || target == null || entry === stop) return null;
    const reward = String(direction).toUpperCase() === "SHORT" ? entry - target : target - entry;
    return reward / Math.abs(entry - stop);
  }

  function defaultAllocations(targetCount, managementStyle) {
    const count = clamp(Math.trunc(Number(targetCount) || 1), 1, 3);
    if (managementStyle === "FULL_T1" || count === 1) return [1, 0, 0];
    if (count === 2) return [0.5, 0.5, 0];
    return [0.4, 0.3, 0.3];
  }

  function normalizeAllocations(values, targetCount) {
    const count = clamp(Math.trunc(Number(targetCount) || 1), 1, 3);
    const supplied = Array.from({ length: 3 }, (_, index) => {
      const value = finiteNumber(values?.[index]);
      return index < count && value != null && value >= 0 ? value : 0;
    });
    const sum = supplied.reduce((total, value) => total + value, 0);
    if (sum <= 0) return defaultAllocations(count, "SCALE_PROTECT");
    return supplied.map((value) => value / sum);
  }

  function calculateTradeR(setup) {
    const outcomes = Array.isArray(setup?.tranche_outcomes) ? setup.tranche_outcomes : [];
    if (!outcomes.length) {
      const stored = finiteNumber(setup?.r_result);
      return stored;
    }
    const totalAllocation = outcomes.reduce((total, item) => total + Math.max(0, finiteNumber(item.allocation) || 0), 0);
    if (totalAllocation <= 0) return null;
    return outcomes.reduce((total, item) => {
      const allocation = Math.max(0, finiteNumber(item.allocation) || 0) / totalAllocation;
      const explicitR = finiteNumber(item.r);
      const exitR = explicitR == null
        ? computeTargetR(setup.direction, setup.entry, setup.original_stop || setup.stop, item.exit_price)
        : explicitR;
      return total + allocation * (exitR == null ? 0 : exitR);
    }, 0);
  }

  function scoreSetup(setup) {
    const status = String(setup?.status || "").toUpperCase();
    if (["VOID", "TECHNICAL_VOID"].includes(status)) {
      return { kind: "void", tradeR: null, goatR: 0, score: 0, included: false, reason: "Technical or administrative void" };
    }
    if (status === "EXPIRED" && !setup?.triggered_at) {
      return { kind: "expiry", tradeR: null, goatR: 0, score: -0.1, included: true, reason: "Entry window expired before trigger" };
    }
    if (["CANCELLED", "CANCELED"].includes(status) && !setup?.triggered_at) {
      return { kind: "cancel", tradeR: null, goatR: 0, score: -0.15, included: true, reason: "Operator canceled a valid pending idea" };
    }
    const resolved = ["STOPPED", "CLOSED", "RESOLVED", "T3_HIT"].includes(status) || Boolean(setup?.resolved_at);
    if (!resolved || !setup?.triggered_at) return { kind: "open", tradeR: null, goatR: 0, score: 0, included: false, reason: "Open record" };
    const tradeR = calculateTradeR(setup);
    if (tradeR == null) return { kind: "open", tradeR: null, goatR: 0, score: 0, included: false, reason: "Resolution is incomplete" };
    return {
      kind: "trade",
      tradeR,
      goatR: clamp(tradeR, -1, 5),
      score: tradeR,
      included: true,
      reason: "Triggered, resolved, tranche-weighted outcome"
    };
  }

  function goatV2(records) {
    const scores = (records || []).map(scoreSetup);
    const trades = scores.filter((item) => item.kind === "trade");
    const expiryCount = scores.filter((item) => item.kind === "expiry").length;
    const cancelCount = scores.filter((item) => item.kind === "cancel").length;
    const profitableCount = trades.filter((item) => item.tradeR > 0).length;
    const triggeredResolved = trades.length;
    const sumGoatR = trades.reduce((total, item) => total + item.goatR, 0);
    const disciplineDebits = expiryCount * 0.1 + cancelCount * 0.15;
    const netEdgeR = triggeredResolved ? (sumGoatR - disciplineDebits) / triggeredResolved : 0;
    const adjustedWinRate = (profitableCount + 2) / (triggeredResolved + 4);
    const edgeComponent = clamp(netEdgeR / 2, -1, 1);
    const consistencyComponent = adjustedWinRate * 2 - 1;
    const evidenceWeight = Math.min(1, triggeredResolved / 20);
    const goatScore = 100 * (0.75 * edgeComponent + 0.25 * consistencyComponent) * evidenceWeight;
    return {
      version: "GOAT_V2_PROTOTYPE",
      goatScore,
      netEdgeR,
      adjustedWinRate,
      evidenceWeight,
      triggeredResolved,
      profitableCount,
      expiryCount,
      cancelCount,
      voidCount: scores.filter((item) => item.kind === "void").length,
      disciplineDebits,
      totalScore: scores.reduce((total, item) => total + item.score, 0)
    };
  }

  function lifecycleState(setup, nowValue) {
    const now = new Date(nowValue || Date.now()).getTime();
    const status = String(setup?.status || "QUEUED").toUpperCase();
    const closed = ["STOPPED", "CLOSED", "RESOLVED", "T3_HIT", "EXPIRED", "CANCELLED", "CANCELED", "VOID", "TECHNICAL_VOID"].includes(status);
    if (closed) return { state: "CLOSED", label: scoreSetup(setup).reason, tone: "neutral" };
    const entryExpiry = new Date(setup?.entry_expires_at || 0).getTime();
    if (!setup?.triggered_at && entryExpiry > 0 && entryExpiry <= now) return { state: "ENTRY_EXPIRED", label: "Entry window elapsed", tone: "negative" };
    const reviewDue = new Date(setup?.review_due_at || 0).getTime();
    if (setup?.triggered_at && reviewDue > 0 && reviewDue <= now) return { state: "REVIEW_DUE", label: "Thesis review is due", tone: "warning" };
    if (!setup?.triggered_at) return { state: "ENTRY_VALID", label: "Entry window is open", tone: "neutral" };
    return { state: "MONITORED", label: "Active and within review cadence", tone: "positive" };
  }

  function coachingSuggestion(setup, nowValue) {
    const lifecycle = lifecycleState(setup, nowValue);
    if (lifecycle.state === "REVIEW_DUE") {
      return {
        kind: "REVIEW",
        title: "Structured review due",
        message: "Recheck the thesis and publish a new Ledger stop only if the original risk rules allow it.",
        action: "REVIEW THESIS"
      };
    }
    const status = String(setup?.status || "").toUpperCase();
    const currentStop = finiteNumber(setup?.ledger_stop ?? setup?.stop);
    const entry = finiteNumber(setup?.entry);
    if (["T1_HIT", "T2_HIT"].includes(status) && entry != null && currentStop !== entry) {
      return {
        kind: "PROTECT",
        title: `${status.replace("_", " ")} recorded`,
        message: "Moving the public Ledger stop to entry would remove remaining planned downside. This does not claim a broker order.",
        action: "UPDATE LEDGER STOP",
        suggestedStop: entry
      };
    }
    return null;
  }

  function validateStopRevision(input) {
    const direction = String(input?.direction || "LONG").toUpperCase();
    const currentStop = finiteNumber(input?.currentLedgerStop);
    const proposedStop = finiteNumber(input?.proposedStop);
    const currentPrice = finiteNumber(input?.currentPrice);
    if (currentStop == null || proposedStop == null || currentPrice == null) return { valid: false, reason: "Stop and current price must be valid numbers." };
    if (direction === "LONG" && proposedStop <= currentStop) return { valid: false, reason: "A LONG Ledger stop can only move up." };
    if (direction === "SHORT" && proposedStop >= currentStop) return { valid: false, reason: "A SHORT Ledger stop can only move down." };
    if (direction === "LONG" && proposedStop >= currentPrice) return { valid: false, reason: "A LONG Ledger stop must remain below the current price." };
    if (direction === "SHORT" && proposedStop <= currentPrice) return { valid: false, reason: "A SHORT Ledger stop must remain above the current price." };
    const effectiveAt = new Date(input?.effectiveAt || Date.now()).getTime();
    const latestEventAt = input?.latestEventAt ? new Date(input.latestEventAt).getTime() : 0;
    if (!Number.isFinite(effectiveAt) || effectiveAt < latestEventAt) return { valid: false, reason: "A Ledger stop revision cannot be backdated." };
    return { valid: true, reason: "Prospective Ledger stop revision is valid." };
  }

  return Object.freeze({
    DAY_MS,
    HORIZON_PRESETS,
    MANAGEMENT_PRESETS,
    horizonPreset,
    deriveLifecycleDefaults,
    computeTargetR,
    defaultAllocations,
    normalizeAllocations,
    calculateTradeR,
    scoreSetup,
    goatV2,
    lifecycleState,
    coachingSuggestion,
    validateStopRevision
  });
});

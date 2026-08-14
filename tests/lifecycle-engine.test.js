"use strict";

const assert = require("node:assert/strict");
const engine = require("../assets/lifecycle-engine.js");

function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

const defaults = engine.deriveLifecycleDefaults("DAY_TRADE", "2026-08-14T12:00:00.000Z");
assert.equal(defaults.entryExpiresAt, "2026-08-15T12:00:00.000Z");
assert.equal(defaults.reviewCadenceDays, 1);
assert.equal(engine.horizonPreset("LONG_TERM").holdingGuide, "Years or open-ended");

close(engine.computeTargetR("LONG", 100, 95, 110), 2);
close(engine.computeTargetR("SHORT", 100, 105, 90), 2);

const weighted = engine.calculateTradeR({
  direction: "LONG",
  entry: 100,
  stop: 90,
  tranche_outcomes: [
    { allocation: 0.4, r: 1 },
    { allocation: 0.3, r: 2 },
    { allocation: 0.3, r: 0 }
  ]
});
close(weighted, 1);

assert.equal(engine.scoreSetup({ status: "EXPIRED" }).score, -0.1);
assert.equal(engine.scoreSetup({ status: "CANCELLED" }).score, -0.1);
assert.equal(engine.scoreSetup({ status: "TECHNICAL_VOID" }).included, false);

const t1Protected = engine.scoreSetup({
  status: "RESOLVED",
  triggered_at: "2026-08-01T00:00:00.000Z",
  resolved_at: "2026-08-02T00:00:00.000Z",
  tranche_outcomes: [{ allocation: 0.5, r: 1 }, { allocation: 0.5, r: 0 }]
});
close(t1Protected.tradeR, 0.5);

const goat = engine.goatV2([
  { status: "RESOLVED", triggered_at: "2026-08-01T00:00:00.000Z", resolved_at: "2026-08-02T00:00:00.000Z", tranche_outcomes: [{ allocation: 1, r: 2 }] },
  { status: "STOPPED", triggered_at: "2026-08-03T00:00:00.000Z", resolved_at: "2026-08-04T00:00:00.000Z", tranche_outcomes: [{ allocation: 1, r: -1 }] },
  { status: "EXPIRED" },
  { status: "CANCELLED" },
  { status: "TECHNICAL_VOID" }
]);
assert.equal(goat.triggeredResolved, 2);
assert.equal(goat.profitableCount, 1);
assert.equal(goat.expiryCount, 1);
assert.equal(goat.cancelCount, 1);
assert.equal(goat.voidCount, 1);
close(goat.netEdgeR, 0.4);
close(goat.evidenceWeight, 0.1);
assert.equal(goat.qualified, false);
assert.equal(goat.goatScore, null);
assert.ok(Number.isFinite(goat.provisionalGoatScore));

const qualifiedGoat = engine.goatV2([
  { status: "RESOLVED", triggered_at: "2026-08-01T00:00:00.000Z", resolved_at: "2026-08-02T00:00:00.000Z", r_result: 1 },
  { status: "RESOLVED", triggered_at: "2026-08-03T00:00:00.000Z", resolved_at: "2026-08-04T00:00:00.000Z", r_result: 1 },
  { status: "RESOLVED", triggered_at: "2026-08-05T00:00:00.000Z", resolved_at: "2026-08-06T00:00:00.000Z", r_result: 1 }
]);
assert.equal(qualifiedGoat.qualified, true);
assert.ok(Number.isFinite(qualifiedGoat.goatScore));

assert.equal(engine.lifecycleState({ status: "QUEUED", entry_expires_at: "2026-08-13T00:00:00.000Z" }, "2026-08-14T00:00:00.000Z").state, "ENTRY_EXPIRED");
assert.equal(engine.lifecycleState({ status: "ACTIVE", triggered_at: "2026-08-10T00:00:00.000Z", review_due_at: "2026-08-13T00:00:00.000Z" }, "2026-08-14T00:00:00.000Z").state, "REVIEW_DUE");

assert.equal(engine.validateStopRevision({ direction: "LONG", currentLedgerStop: 90, proposedStop: 100, currentPrice: 110 }).valid, true);
assert.equal(engine.validateStopRevision({ direction: "LONG", currentLedgerStop: 90, proposedStop: 85, currentPrice: 110 }).valid, false);
assert.equal(engine.validateStopRevision({ direction: "SHORT", currentLedgerStop: 110, proposedStop: 100, currentPrice: 90 }).valid, true);
assert.equal(engine.validateStopRevision({ direction: "SHORT", currentLedgerStop: 110, proposedStop: 115, currentPrice: 90 }).valid, false);

console.log("GOAT lifecycle engine assertions passed.");

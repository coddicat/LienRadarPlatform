import assert from "node:assert/strict";
import { applyStatusGuard, decideFinalBid } from "./finalBidGuard.js";
import { classifyOutcomeReason, isExplicitFailedSaleReason } from "./outcomeReason.js";

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

check("fresh price wins", () => {
  const d = decideFinalBid({
    newBid: 120000,
    appliedStatus: "SOLD",
    newSaleDate: "2026-10-01",
    prev: { winningBid: 99000, saleDate: "2026-10-01" },
    today: "2026-11-10",
  });
  assert.equal(d.value, 120000);
  assert.equal(d.reason, "fresh_price");
});

check("drop sticky bid when not sold", () => {
  const d = decideFinalBid({
    newBid: null,
    appliedStatus: "NOT_SOLD",
    newSaleDate: "2026-10-01",
    prev: { winningBid: 33900, saleDate: "2026-10-01" },
    today: "2026-11-10",
  });
  assert.equal(d.value, null);
  assert.equal(d.dropped, 33900);
  assert.equal(d.reason, "drop_not_sold");
});

check("drop sticky bid on future sale date", () => {
  const d = decideFinalBid({
    newBid: null,
    appliedStatus: "SOLD",
    newSaleDate: "2026-12-01",
    prev: { winningBid: 33900, saleDate: "2026-08-01" },
    today: "2026-11-10",
  });
  assert.equal(d.value, null);
  assert.equal(d.reason, "drop_future_sale");
});

check("scheduled never overwrites past outcome", () => {
  const g = applyStatusGuard({
    nextStatus: "SCHEDULED",
    prevStatus: "SOLD",
    newSaleDate: "2026-10-01",
    prevSaleDate: "2026-10-01",
    authority: "platform",
    today: "2026-11-10",
  });
  assert.equal(g.status, "SOLD");
  assert.equal(g.guarded, true);
});

check("explicit failed sale can reverse sold", () => {
  assert.equal(isExplicitFailedSaleReason("Bidder Walked Away"), true);
  const g = applyStatusGuard({
    nextStatus: "NOT_SOLD",
    prevStatus: "SOLD",
    newSaleDate: "2026-10-01",
    prevSaleDate: "2026-10-01",
    authority: "platform",
    outcomeText: "Bidder Walked Away",
    today: "2026-11-10",
  });
  assert.equal(g.guarded, false);
  assert.equal(g.status, "NOT_SOLD");
});

check("outcome dictionary exact match", () => {
  const r = classifyOutcomeReason("Canceled per Bankruptcy");
  assert.equal(r.matched, "exact");
  assert.equal(r.category, "bankruptcy");
});

check("unknown outcome wording not guessed", () => {
  const r = classifyOutcomeReason("Weird new platform phrase");
  assert.equal(r.matched, "none");
  assert.equal(r.category, "unknown");
  assert.equal(r.text, "Weird new platform phrase");
});

console.log("finalBidGuard tests passed");

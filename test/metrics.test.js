import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  RequestMetrics,
  createRequestMetrics,
} from "../dist/server/metrics.js";

describe("RequestMetrics", () => {
  /** @type {RequestMetrics} */
  let metrics;

  beforeEach(() => {
    metrics = createRequestMetrics();
  });

  it("records chat with pool source and ttft", () => {
    metrics.recordChat({ pool: "warm", ttftMs: 1200, ok: true });
    metrics.recordChat({ pool: "cold", ttftMs: 8000, ok: true });
    metrics.recordChat({ pool: "warm", ok: false });

    const snap = metrics.snapshot();
    assert.equal(snap.requests, 3);
    assert.equal(snap.errors, 1);
    assert.equal(snap.pool.warm, 2);
    assert.equal(snap.pool.cold, 1);
    assert.equal(snap.pool.replacement, 0);
    assert.equal(snap.ttft.count, 2);
    assert.equal(snap.ttft.avg_ms, 4600);
    assert.equal(snap.ttft.max_ms, 8000);
  });

  it("exposes last_request_at after first record", () => {
    assert.equal(snapNull(metrics.snapshot().last_request_at), null);
    metrics.recordChat({ pool: "warm", ok: true });
    assert.ok(typeof metrics.snapshot().last_request_at === "string");
  });
});

function snapNull(v) {
  return v ?? null;
}

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
    assert.equal(snap.in_flight, 0);
  });

  it("exposes last_request_at after first record", () => {
    assert.equal(snapNull(metrics.snapshot().last_request_at), null);
    metrics.recordChat({ pool: "warm", ok: true });
    assert.ok(typeof metrics.snapshot().last_request_at === "string");
  });

  it("beginChat counts request and acquire immediately while in flight", () => {
    metrics.beginChat("cold");

    const mid = metrics.snapshot();
    assert.equal(mid.requests, 1);
    assert.equal(mid.pool.cold, 1);
    assert.equal(mid.errors, 0);
    assert.equal(mid.in_flight, 1);
    assert.equal(mid.ttft.count, 0);
    assert.ok(typeof mid.last_request_at === "string");
  });

  it("finishChat records outcome without double-counting requests", () => {
    metrics.beginChat("warm");
    metrics.finishChat({ ttftMs: 2500, ok: true });

    const snap = metrics.snapshot();
    assert.equal(snap.requests, 1);
    assert.equal(snap.pool.warm, 1);
    assert.equal(snap.errors, 0);
    assert.equal(snap.in_flight, 0);
    assert.equal(snap.ttft.count, 1);
    assert.equal(snap.ttft.avg_ms, 2500);
    assert.equal(snap.ttft.max_ms, 2500);
  });

  it("finishChat marks errors on failure", () => {
    metrics.beginChat("replacement");
    metrics.finishChat({ ok: false });

    const snap = metrics.snapshot();
    assert.equal(snap.requests, 1);
    assert.equal(snap.pool.replacement, 1);
    assert.equal(snap.errors, 1);
    assert.equal(snap.in_flight, 0);
    assert.equal(snap.ttft.count, 0);
  });

  it("tracks multiple in-flight requests independently", () => {
    metrics.beginChat("warm");
    metrics.beginChat("cold");
    assert.equal(metrics.snapshot().in_flight, 2);
    assert.equal(metrics.snapshot().requests, 2);

    metrics.finishChat({ ok: true, ttftMs: 100 });
    assert.equal(metrics.snapshot().in_flight, 1);

    metrics.finishChat({ ok: false });
    assert.equal(metrics.snapshot().in_flight, 0);
    assert.equal(metrics.snapshot().errors, 1);
    assert.equal(metrics.snapshot().ttft.count, 1);
  });
});

function snapNull(v) {
  return v ?? null;
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PREWARM_MODEL,
  canUseWarmPool,
  resolveAcquireModel,
  warmNeedsRespawn,
  shouldReapWarm,
  shouldPoolAccount,
} from "../dist/subprocess/pool-policy.js";

describe("pool-policy model routing", () => {
  it("prewarm model is auto", () => {
    assert.equal(PREWARM_MODEL, "auto");
  });

  it("auto and empty requests use warm pool", () => {
    assert.equal(canUseWarmPool("auto"), true);
    assert.equal(canUseWarmPool(undefined), true);
    assert.equal(canUseWarmPool(""), true);
  });

  it("specific models skip warm pool", () => {
    assert.equal(canUseWarmPool("opus-4.6"), false);
    assert.equal(canUseWarmPool("sonnet-4.5"), false);
  });

  it("resolveAcquireModel keeps specific models", () => {
    assert.equal(resolveAcquireModel("opus-4.6"), "opus-4.6");
    assert.equal(resolveAcquireModel("auto"), "auto");
    assert.equal(resolveAcquireModel(undefined), "auto");
  });

  it("warmNeedsRespawn when request model differs from spawned", () => {
    assert.equal(warmNeedsRespawn("auto", "opus-4.6"), true);
    assert.equal(warmNeedsRespawn("auto", "auto"), false);
    assert.equal(warmNeedsRespawn("opus-4.6", "opus-4.6"), false);
    assert.equal(warmNeedsRespawn("auto", undefined), false);
  });
});

describe("pool-policy idle reap", () => {
  it("reaps when idle age reaches ttl", () => {
    assert.equal(shouldReapWarm(0, 5 * 60 * 1000, 5 * 60 * 1000), true);
    assert.equal(shouldReapWarm(0, 5 * 60 * 1000 - 1, 5 * 60 * 1000), false);
  });
});

describe("pool-policy account pooling", () => {
  it("pools unknown ids only when no accounts configured", () => {
    const known = new Set(["gaofei"]);
    assert.equal(shouldPoolAccount("ghost", known, true), false);
    assert.equal(shouldPoolAccount("gaofei", known, true), true);
    assert.equal(shouldPoolAccount("ghost", known, false), true);
  });
});

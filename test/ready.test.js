import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubprocessPool } from "../dist/subprocess/pool.js";
import {
  readyHttpStatus,
  buildReadyBody,
} from "../dist/subprocess/ready.js";

describe("readiness helpers", () => {
  it("maps not-ready to 503 and ready to 200", () => {
    assert.equal(readyHttpStatus(false), 503);
    assert.equal(readyHttpStatus(true), 200);
  });

  it("buildReadyBody exposes ready flag and pool stats", () => {
    const body = buildReadyBody(false, { a: { warm: 0, alive: 0, spawning: 2, targetSize: 2 } });
    assert.equal(body.status, "not_ready");
    assert.equal(body.ready, false);
    assert.equal(body.pool.a.spawning, 2);

    const ok = buildReadyBody(true, {});
    assert.equal(ok.status, "ready");
    assert.equal(ok.ready, true);
  });
});

describe("SubprocessPool.isReady", () => {
  it("is false until markReady / prewarmAll completes", async () => {
    const pool = new SubprocessPool({
      instanceAccount: null,
      targetSize: 1,
      createSubprocess: () => {
        throw new Error("should not spawn in this test");
      },
      resolveAccounts: () => ({
        list: () => [],
        hasAccounts: () => false,
        resolveApiKey: () => undefined,
        get: () => null,
      }),
    });

    assert.equal(pool.isReady(), false);
    await pool.prewarmAll(); // no accounts → markReady
    assert.equal(pool.isReady(), true);
    pool.shutdown();
    assert.equal(pool.isReady(), false);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { SubprocessPool } from "../dist/subprocess/pool.js";

function fakeSub() {
  const ee = new EventEmitter();
  /** @type {any} */
  const sub = ee;
  sub.warm = true;
  sub.running = true;
  sub.killed = false;
  sub.spawnedModel = "auto";
  sub.preSpawn = async (opts) => {
    sub.spawnedModel = opts?.model ?? "auto";
    sub.warm = true;
    sub.running = true;
    sub.killed = false;
  };
  sub.kill = () => {
    sub.killed = true;
    sub.warm = false;
    sub.running = false;
  };
  sub.isWarmProcess = () => sub.warm && sub.running && !sub.killed;
  sub.isRunning = () => sub.running && !sub.killed;
  sub.getSpawnedModel = () => sub.spawnedModel;
  return sub;
}

/** Isolate tests from host CURSOR_INSTANCE_ACCOUNT / pool env. */
function testPool(deps = {}) {
  return new SubprocessPool({
    instanceAccount: null,
    ...deps,
  });
}

describe("SubprocessPool model-aware acquire", () => {
  it("uses warm for auto and cold-starts specific models without draining warm", async () => {
    const pool = testPool({
      targetSize: 1,
      createSubprocess: () => fakeSub(),
      resolveAccounts: () => ({
        list: () => [{ id: "a" }],
        hasAccounts: () => true,
        resolveApiKey: () => "crsr_test",
        get: (id) => (id === "a" ? {} : null),
      }),
    });

    pool.enqueueWarm("a", fakeSub(), Date.now());
    // Intentionally not markReady yet — avoid async refill racing assertions.

    const warmHit = await pool.acquire("a", "crsr_test", "auto");
    assert.equal(warmHit.source, "warm");

    pool.enqueueWarm("a", fakeSub(), Date.now());
    const cold = await pool.acquire("a", "crsr_test", "opus-4.6");
    assert.equal(cold.source, "cold");
    assert.equal(cold.subprocess.getSpawnedModel(), "opus-4.6");
    // Warm slot for auto must still be there (non-auto must not drain it)
    const stats = pool.stats();
    assert.equal(stats.a.alive, 1);

    pool.shutdown();
  });

  it("does not create pool keys for unknown accounts when accounts are configured", async () => {
    const pool = testPool({
      targetSize: 1,
      createSubprocess: () => fakeSub(),
      resolveAccounts: () => ({
        list: () => [{ id: "known" }],
        hasAccounts: () => true,
        resolveApiKey: () => "crsr_test",
        get: (id) => (id === "known" ? {} : null),
      }),
    });
    pool.markReady();

    await pool.acquire("ghost", "crsr_test", "auto");
    assert.equal(pool.stats().ghost, undefined);

    pool.shutdown();
  });
});

describe("SubprocessPool idle TTL", () => {
  it("reaps warm processes idle longer than TTL and does not refill", () => {
    let now = 1_000_000;
    const sub = fakeSub();
    const pool = testPool({
      idleTtlMs: 5_000,
      targetSize: 2,
      now: () => now,
      createSubprocess: () => fakeSub(),
      resolveAccounts: () => ({
        list: () => [{ id: "a" }],
        hasAccounts: () => true,
        resolveApiKey: () => "crsr_test",
        get: () => ({}),
      }),
    });

    pool.enqueueWarm("a", sub, now - 5_000);
    pool.markReady();
    assert.equal(pool.stats().a.alive, 1);

    pool.runIdleReaper();
    assert.equal(sub.killed, true);
    assert.equal(pool.stats().a?.alive ?? 0, 0);
    // Must NOT immediately refill after idle reap (memory savings)
    assert.equal(pool.stats().a?.spawning ?? 0, 0);

    pool.shutdown();
  });

  it("keeps warm processes younger than TTL", () => {
    let now = 1_000_000;
    const sub = fakeSub();
    const pool = testPool({
      idleTtlMs: 5_000,
      now: () => now,
      createSubprocess: () => fakeSub(),
      resolveAccounts: () => ({
        list: () => [{ id: "a" }],
        hasAccounts: () => true,
        resolveApiKey: () => "crsr_test",
        get: () => ({}),
      }),
    });

    pool.enqueueWarm("a", sub, now - 4_999);
    pool.markReady();
    pool.runIdleReaper();
    assert.equal(sub.killed, false);
    assert.equal(pool.stats().a.alive, 1);

    pool.shutdown();
  });
});

describe("SubprocessPool account lifecycle", () => {
  it("remove kills warm processes for that account", () => {
    const sub = fakeSub();
    const pool = testPool({
      createSubprocess: () => fakeSub(),
      resolveAccounts: () => ({
        list: () => [{ id: "a" }],
        hasAccounts: () => true,
        resolveApiKey: () => "crsr_test",
        get: () => ({}),
      }),
    });
    pool.enqueueWarm("a", sub, Date.now());
    pool.remove("a");
    assert.equal(sub.killed, true);
    assert.equal(pool.stats().a, undefined);
    pool.shutdown();
  });

  it("ensure refills warm queue for a new account after ready", async () => {
    const pool = testPool({
      targetSize: 2,
      createSubprocess: () => fakeSub(),
      resolveAccounts: () => ({
        list: () => [{ id: "acct-new" }],
        hasAccounts: () => true,
        resolveApiKey: (id) => (id === "acct-new" ? "crsr_new" : undefined),
        get: (id) => (id === "acct-new" ? {} : null),
      }),
    });
    pool.markReady();
    pool.ensure("acct-new");
    // spawnWarm is async — wait a tick
    await new Promise((r) => setTimeout(r, 20));
    assert.ok((pool.stats()["acct-new"]?.alive ?? 0) >= 1);
    pool.shutdown();
  });
});

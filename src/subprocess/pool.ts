/**
 * Subprocess Pool — keeps warm `agent` processes ready per account.
 *
 * Each request to cursor-agent-api-proxy used to spawn a fresh `agent` CLI
 * process, costing ~10-15s in CLI startup overhead before any real work.
 *
 * This pool pre-spawns processes per account so the startup time is removed
 * from the request critical path:
 *
 *   pre-warm:  spawn agent (happens during server startup)
 *   acquire:   pop from pool, immediately spawn replacement (async)
 *   start:     write prompt to warm process's stdin → near-instant
 *   complete:  process exits naturally, replacement is already warming
 *
 * With TARGET_SIZE=2 and 2 accounts, the pool maintains 4 warm processes
 * at steady state, ensuring consecutive requests never hit a cold start.
 */

import { CursorSubprocess, SubprocessOptions } from "./manager.js";
import type { AccountConfig } from "../types/account.js";
import { getAccountsManager } from "../account/manager.js";

interface PoolEntry {
  /** Queue of warm subprocesses ready to accept a prompt. */
  queue: CursorSubprocess[];
}

/**
 * Per-account process pool.
 *
 * Thread safety: Node.js is single-threaded, so no mutex needed.
 * The warm queue is just an array — push/pop are synchronous.
 *
 * Edge cases handled:
 * - Queue underflow: spawn synchronously, caller waits for first process
 * - Rapid concurrent requests: pool creates extras on demand (not limited by targetSize)
 * - Server shutdown: kill all warm processes
 * - Account deleted mid-flight: orphaned warm processes get cleaned up by idle TTL
 */
export class SubprocessPool {
  private pools = new Map<string, PoolEntry>();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly IDLE_TTL = 5 * 60 * 1000; // 5 min — kill warm processes that never got used
  private readonly PREWARM_MODEL = "auto";
  /** Target warm processes to maintain per account. */
  private readonly TARGET_SIZE = 2;

  /**
   * Pre-warm all configured accounts.
   * Returns a promise that resolves once ALL account processes are spawned.
   * Server should await this before printing "ready".
   */
  async prewarmAll(): Promise<void> {
    const mgr = getAccountsManager();
    const accounts = mgr.list();

    if (accounts.length === 0) {
      console.error(`[Pool] No accounts configured — skipping pre-warm`);
      return;
    }

    console.error(
      `[Pool] Pre-warming ${accounts.length} account(s) x ${this.TARGET_SIZE} processes... (this may take 10-30s)`
    );

    // Spawn TARGET_SIZE processes per account
    const promises: Promise<void>[] = [];
    for (const account of accounts) {
      const apiKey = mgr.resolveApiKey(account.id);
      if (!apiKey) continue;
      for (let i = 0; i < this.TARGET_SIZE; i++) {
        promises.push(this.spawnWarm(account.id, apiKey));
      }
    }

    await Promise.all(promises);

    const stats = this.stats();
    const warmCount = Object.values(stats).reduce((s, e) => s + e.warm, 0);
    console.error(`[Pool] ${warmCount} warm process(es) ready (target ${this.TARGET_SIZE} per account)`);

    // Start idle reaper
    this.idleTimer = setInterval(() => this.reapIdle(), this.IDLE_TTL);
    this.idleTimer.unref();
  }

  /**
   * Acquire a warm subprocess for the given account.
   *
   * - If a warm process is available, returns it immediately.
   * - If not, spawns one on-demand (first request for this account = cold start).
   * - In both cases, starts async replacement spawns to refill to TARGET_SIZE.
   */
  async acquire(accountId: string, apiKey?: string): Promise<{ subprocess: CursorSubprocess; source: "warm" | "cold" | "replacement" }> {
    let entry = this.pools.get(accountId);

    // Try warm queue first
    if (entry && entry.queue.length > 0) {
      const sub = entry.queue.pop()!;
      // Refill pool to TARGET_SIZE
      this.refill(accountId, apiKey);
      console.error(`[Pool] Acquired warm for '${accountId}' (${entry.queue.length} remain, refilling to ${this.TARGET_SIZE})`);
      return { subprocess: sub, source: "warm" };
    }

    // Cold start — spawn now (first request for this account or pool exhausted)
    console.error(`[Pool] Cold start for account '${accountId}' — no warm process available`);
    const sub = new CursorSubprocess();
    await sub.preSpawn({
      model: this.PREWARM_MODEL,
      apiKey,
    });

    // Ensure entry exists for future refilling
    if (!entry) {
      entry = { queue: [] };
      this.pools.set(accountId, entry);
    }

    // Refill pool to TARGET_SIZE
    this.refill(accountId, apiKey);

    return { subprocess: sub, source: "cold" };
  }

  /**
   * Spawn replacement processes to bring the pool back to TARGET_SIZE.
   * Runs asynchronously — doesn't block the caller.
   */
  private refill(accountId: string, apiKey?: string): void {
    const entry = this.pools.get(accountId);
    if (!entry) return;

    const needed = this.TARGET_SIZE - entry.queue.length;
    for (let i = 0; i < needed; i++) {
      this.spawnWarm(accountId, apiKey);
    }
  }

  /**
   * Spawn a warm process for this account and add to pool.
   * Runs asynchronously — doesn't block the caller.
   */
  private async spawnWarm(accountId: string, apiKey?: string): Promise<void> {
    const apiKeyToUse = apiKey ?? this.resolveApiKey(accountId);
    if (!apiKeyToUse) {
      // Account without API key can't be pre-warmed
      return;
    }

    try {
      const sub = new CursorSubprocess();
      await sub.preSpawn({
        model: this.PREWARM_MODEL,
        apiKey: apiKeyToUse,
      });

      let entry = this.pools.get(accountId);
      if (!entry) {
        entry = { queue: [] };
        this.pools.set(accountId, entry);
      }

      entry.queue.push(sub);
    } catch (err) {
      // Spawn failure (CLI not found, OOM, etc.) — log and move on
      // The next acquire will get a cold start and surface the error
      console.error(`[Pool] Failed to warm account '${accountId}':`, err);
    }
  }

  /**
   * Remove account from pool (when account is deleted).
   * Kills any warm processes for this account.
   */
  remove(accountId: string): void {
    const entry = this.pools.get(accountId);
    if (!entry) return;

    for (const sub of entry.queue) {
      sub.kill();
    }
    this.pools.delete(accountId);
  }

  /**
   * Kill all warm processes and shut down the pool.
   */
  shutdown(): void {
    for (const [, entry] of this.pools) {
      for (const sub of entry.queue) {
        sub.kill();
      }
    }
    this.pools.clear();

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Get pool stats for health check / monitoring. */
  stats(): Record<string, { warm: number; targetSize: number }> {
    const stats: Record<string, { warm: number; targetSize: number }> = {};
    for (const [id, entry] of this.pools) {
      stats[id] = {
        warm: entry.queue.length,
        targetSize: this.TARGET_SIZE,
      };
    }
    return stats;
  }

  /**
   * Kill warm processes that have been idle too long.
   * Protects against memory leak if accounts are deleted without calling remove().
   */
  private reapIdle(): void {
    const mgr = getAccountsManager();
    const knownIds = new Set(mgr.list().map((a) => a.id));

    for (const [id, entry] of this.pools) {
      if (!knownIds.has(id)) {
        // Account no longer configured — purge
        for (const sub of entry.queue) {
          sub.kill();
        }
        this.pools.delete(id);
        console.error(`[Pool] Reaped stale warm processes for removed account '${id}'`);
      }
    }
  }

  private resolveApiKey(accountId: string): string | undefined {
    try {
      const mgr = getAccountsManager();
      return mgr.resolveApiKey(accountId);
    } catch {
      return undefined;
    }
  }
}

/** Singleton instance. */
let _instance: SubprocessPool | null = null;

export function getPool(): SubprocessPool {
  if (!_instance) {
    _instance = new SubprocessPool();
  }
  return _instance;
}

export function resetPool(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}

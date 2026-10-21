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
 * Warm slots always use PREWARM_MODEL ("auto"). Requests for a specific
 * model cold-start so `--model` matches. Idle warm processes are reaped
 * after IDLE_TTL and are NOT auto-refilled (next request cold-starts then refills).
 */

import { CursorSubprocess, SubprocessOptions } from "./manager.js";
import { getAccountsManager } from "../account/manager.js";
import {
  PREWARM_MODEL,
  canUseWarmPool,
  resolveAcquireModel,
  shouldPoolAccount,
  shouldReapWarm,
} from "./pool-policy.js";

interface WarmItem {
  sub: CursorSubprocess;
  /** Wall-clock ms when this process entered (or re-entered) the warm queue. */
  idleSince: number;
}

interface PoolEntry {
  queue: WarmItem[];
  /** In-flight spawn count — prevents over/under refill under burst load. */
  spawning: number;
}

export interface PoolAccountResolver {
  list: () => { id: string }[];
  hasAccounts: () => boolean;
  resolveApiKey: (id?: string) => string | undefined;
  get: (id: string) => unknown;
}

export interface PoolDeps {
  idleTtlMs?: number;
  targetSize?: number;
  now?: () => number;
  createSubprocess?: () => CursorSubprocess;
  resolveAccounts?: () => PoolAccountResolver;
  /** Multi-instance binding — only warm this account when set. */
  instanceAccount?: string | null;
}

/**
 * Per-account process pool.
 *
 * Thread safety: Node.js is single-threaded, so no mutex needed.
 */
export class SubprocessPool {
  private pools = new Map<string, PoolEntry>();
  private prewarmDone = false;
  private idleTimer: NodeJS.Timeout | null = null;

  private readonly IDLE_TTL: number;
  private readonly TARGET_SIZE: number;
  private readonly now: () => number;
  private readonly createSubprocess: () => CursorSubprocess;
  private readonly resolveAccounts: () => PoolAccountResolver;
  private readonly instanceAccount: string | null;

  constructor(deps: PoolDeps = {}) {
    this.IDLE_TTL =
      deps.idleTtlMs ??
      Math.max(
        60_000,
        parseInt(process.env.CURSOR_POOL_IDLE_TTL_MS ?? "", 10) || 5 * 60 * 1000
      );
    this.TARGET_SIZE =
      deps.targetSize ??
      Math.max(1, parseInt(process.env.CURSOR_POOL_SIZE ?? "2", 10) || 2);
    this.now = deps.now ?? Date.now;
    this.createSubprocess = deps.createSubprocess ?? (() => new CursorSubprocess());
    this.resolveAccounts =
      deps.resolveAccounts ??
      (() => {
        const mgr = getAccountsManager();
        return {
          list: () => mgr.list(),
          hasAccounts: () => mgr.hasAccounts(),
          resolveApiKey: (id?: string) => mgr.resolveApiKey(id),
          get: (id: string) => mgr.get(id),
        };
      });
    this.instanceAccount =
      deps.instanceAccount !== undefined
        ? deps.instanceAccount
        : process.env.CURSOR_INSTANCE_ACCOUNT ?? null;
  }

  /**
   * Pre-warm all configured accounts.
   * Returns a promise that resolves once ALL account processes are spawned.
   * Server should await this before printing "ready".
   */
  async prewarmAll(): Promise<void> {
    const accounts = this.resolveAccounts();
    const all = accounts.list();

    if (all.length === 0) {
      console.error(`[Pool] No accounts configured — skipping pre-warm`);
      this.markReady();
      return;
    }

    const accountsToWarm = this.instanceAccount
      ? all.filter((a) => a.id === this.instanceAccount)
      : all;

    if (accountsToWarm.length === 0) {
      console.error(`[Pool] No accounts to pre-warm`);
      this.markReady();
      return;
    }

    console.error(
      `[Pool] Pre-warming ${accountsToWarm.length} account(s) x ${this.TARGET_SIZE} processes... (this may take 10-30s)`
    );

    const promises: Promise<void>[] = [];
    for (const account of accountsToWarm) {
      const apiKey = accounts.resolveApiKey(account.id);
      if (!apiKey) continue;
      for (let i = 0; i < this.TARGET_SIZE; i++) {
        promises.push(this.spawnWarm(account.id, apiKey));
      }
    }

    await Promise.all(promises);
    this.markReady();

    const stats = this.stats();
    const warmCount = Object.values(stats).reduce((s, e) => s + e.alive, 0);
    console.error(
      `[Pool] ${warmCount} warm process(es) ready (target ${this.TARGET_SIZE} per account, idle TTL ${this.IDLE_TTL}ms)`
    );
  }

  /** Mark pool ready for refill / idle reaper (also used by tests). */
  markReady(): void {
    this.prewarmDone = true;
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => this.reapIdle(), this.IDLE_TTL);
      this.idleTimer.unref();
    }
  }

  /**
   * Acquire a subprocess for the given account.
   *
   * - auto / empty model → prefer warm queue (spawned with PREWARM_MODEL)
   * - specific model → always cold-start with that `--model` (does not drain warm)
   * - unknown account ids (when accounts configured) → one-shot cold, no pool key
   */
  async acquire(
    accountId: string,
    apiKey?: string,
    model?: string
  ): Promise<{ subprocess: CursorSubprocess; source: "warm" | "cold" | "replacement" }> {
    const accounts = this.resolveAccounts();
    const knownIds = new Set(accounts.list().map((a) => a.id));
    const poolThis = shouldPoolAccount(accountId, knownIds, accounts.hasAccounts());
    const useWarm = canUseWarmPool(model);

    if (useWarm && poolThis) {
      let entry = this.pools.get(accountId);
      while (entry && entry.queue.length > 0) {
        const item = entry.queue.pop()!;
        if (item.sub.isWarmProcess() && item.sub.isRunning()) {
          this.refill(accountId, apiKey);
          console.error(
            `[Pool] Acquired warm for '${accountId}' (${entry.queue.length} remain, refilling to ${this.TARGET_SIZE})`
          );
          return { subprocess: item.sub, source: "warm" };
        }
        console.error(`[Pool] Discarded stale warm process for '${accountId}'`);
      }
    }

    const acquireModel = resolveAcquireModel(model);
    console.error(
      `[Pool] Cold start for account '${accountId}' model=${acquireModel}${useWarm ? "" : " (non-auto)"}`
    );
    const sub = this.createSubprocess();
    await sub.preSpawn({
      model: acquireModel,
      apiKey,
      skipSettle: true,
    });

    if (poolThis) {
      if (!this.pools.get(accountId)) {
        this.pools.set(accountId, { queue: [], spawning: 0 });
      }
      this.refill(accountId, apiKey);
    }

    return { subprocess: sub, source: "cold" };
  }

  /**
   * Ensure warm capacity for an account after CRUD upsert.
   * No-op until prewarm finishes, or if account has no API key / wrong instance.
   */
  ensure(accountId: string): void {
    if (!this.prewarmDone) return;
    if (this.instanceAccount && accountId !== this.instanceAccount) return;
    const accounts = this.resolveAccounts();
    if (!accounts.get(accountId)) return;
    const apiKey = accounts.resolveApiKey(accountId);
    if (!apiKey) return;
    this.refill(accountId, apiKey);
  }

  /**
   * Spawn replacement processes to bring the pool back to TARGET_SIZE.
   * Runs asynchronously — doesn't block the caller.
   */
  private refill(accountId: string, apiKey?: string): void {
    if (!this.prewarmDone) return;

    let entry = this.pools.get(accountId);
    if (!entry) {
      entry = { queue: [], spawning: 0 };
      this.pools.set(accountId, entry);
    }

    const alive = entry.queue.filter((i) => i.sub.isWarmProcess() && i.sub.isRunning()).length;
    const needed = this.TARGET_SIZE - alive - entry.spawning;
    for (let i = 0; i < needed; i++) {
      entry.spawning++;
      this.spawnWarm(accountId, apiKey).finally(() => {
        const e = this.pools.get(accountId);
        if (e) e.spawning = Math.max(0, e.spawning - 1);
      });
    }
  }

  private async spawnWarm(accountId: string, apiKey?: string): Promise<void> {
    const apiKeyToUse = apiKey ?? this.resolveApiKey(accountId);
    if (!apiKeyToUse) return;

    try {
      const sub = this.createSubprocess();
      await sub.preSpawn({
        model: PREWARM_MODEL,
        apiKey: apiKeyToUse,
      } as SubprocessOptions);

      let entry = this.pools.get(accountId);
      if (!entry) {
        entry = { queue: [], spawning: 0 };
        this.pools.set(accountId, entry);
      }

      if (entry.queue.length >= this.TARGET_SIZE) {
        sub.kill();
        return;
      }

      const alive = entry.queue.filter((i) => i.sub.isWarmProcess() && i.sub.isRunning()).length;
      if (alive >= this.TARGET_SIZE) {
        sub.kill();
        return;
      }

      this.trackWarmProcess(accountId, sub);
      entry.queue.push({ sub, idleSince: this.now() });
    } catch (err) {
      console.error(`[Pool] Failed to warm account '${accountId}':`, err);
    }
  }

  /** Remove account from pool (when account is deleted). */
  remove(accountId: string): void {
    const entry = this.pools.get(accountId);
    if (!entry) return;

    for (const item of entry.queue) {
      item.sub.kill();
    }
    this.pools.delete(accountId);
  }

  /** Kill all warm processes and shut down the pool. */
  shutdown(): void {
    this.prewarmDone = false;
    for (const [, entry] of this.pools) {
      for (const item of entry.queue) {
        item.sub.kill();
      }
    }
    this.pools.clear();

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private trackWarmProcess(accountId: string, sub: CursorSubprocess): void {
    const onDead = () => {
      sub.removeListener("close", onDead);
      sub.removeListener("error", onDead);
      const entry = this.pools.get(accountId);
      if (!entry) return;
      const idx = entry.queue.findIndex((i) => i.sub === sub);
      if (idx >= 0) {
        entry.queue.splice(idx, 1);
        console.error(
          `[Pool] Warm process for '${accountId}' exited early (${entry.queue.length} remain)`
        );
        this.refill(accountId);
      }
    };
    sub.once("close", onDead);
    sub.once("error", onDead);
  }

  stats(): Record<string, { warm: number; alive: number; spawning: number; targetSize: number }> {
    const stats: Record<
      string,
      { warm: number; alive: number; spawning: number; targetSize: number }
    > = {};
    for (const [id, entry] of this.pools) {
      const alive = entry.queue.filter((i) => i.sub.isWarmProcess() && i.sub.isRunning()).length;
      stats[id] = {
        warm: entry.queue.length,
        alive,
        spawning: entry.spawning,
        targetSize: this.TARGET_SIZE,
      };
    }
    return stats;
  }

  /** Run one idle-reap cycle (interval + tests). */
  runIdleReaper(): void {
    this.reapIdle();
  }

  /**
   * Seed a warm slot without spawning (tests / recovery).
   */
  enqueueWarm(accountId: string, sub: CursorSubprocess, idleSince: number): void {
    let entry = this.pools.get(accountId);
    if (!entry) {
      entry = { queue: [], spawning: 0 };
      this.pools.set(accountId, entry);
    }
    this.trackWarmProcess(accountId, sub);
    entry.queue.push({ sub, idleSince });
  }

  /**
   * Kill warm processes idle longer than IDLE_TTL, and purge deleted accounts.
   * Does NOT refill after idle reap — next request cold-starts then refills.
   */
  private reapIdle(): void {
    const accounts = this.resolveAccounts();
    const knownIds = new Set(accounts.list().map((a) => a.id));
    const hasAccounts = accounts.hasAccounts();
    const now = this.now();

    for (const [id, entry] of this.pools) {
      if (hasAccounts && !knownIds.has(id)) {
        for (const item of entry.queue) {
          item.sub.kill();
        }
        this.pools.delete(id);
        console.error(`[Pool] Reaped stale warm processes for removed account '${id}'`);
        continue;
      }

      const keep: WarmItem[] = [];
      let reaped = 0;
      for (const item of entry.queue) {
        if (!item.sub.isWarmProcess() || !item.sub.isRunning()) {
          continue;
        }
        if (shouldReapWarm(item.idleSince, now, this.IDLE_TTL)) {
          item.sub.kill();
          reaped++;
          continue;
        }
        keep.push(item);
      }
      entry.queue = keep;

      if (reaped > 0) {
        console.error(
          `[Pool] Reaped ${reaped} idle warm process(es) for '${id}' (TTL ${this.IDLE_TTL}ms)`
        );
      }

      if (entry.queue.length === 0 && entry.spawning === 0) {
        this.pools.delete(id);
      }
    }
  }

  private resolveApiKey(accountId: string): string | undefined {
    try {
      return this.resolveAccounts().resolveApiKey(accountId);
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

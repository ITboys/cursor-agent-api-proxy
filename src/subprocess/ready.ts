/**
 * Readiness helpers — separate liveness (/health) from warm-pool readiness (/ready).
 */

export type ReadyHttpStatus = 200 | 503;

export function readyHttpStatus(isReady: boolean): ReadyHttpStatus {
  return isReady ? 200 : 503;
}

export interface ReadyBody {
  status: "ready" | "not_ready";
  ready: boolean;
  pool: Record<string, unknown>;
  timestamp: string;
}

export function buildReadyBody(
  isReady: boolean,
  poolStats: Record<string, unknown>
): ReadyBody {
  return {
    status: isReady ? "ready" : "not_ready",
    ready: isReady,
    pool: poolStats,
    timestamp: new Date().toISOString(),
  };
}

/**
 * In-process request metrics for ops (cold/warm, TTFT, errors).
 * Per-instance — multi-account LB aggregates via manager usage + /v1/metrics.
 */

export type PoolSource = "warm" | "cold" | "replacement";

export interface ChatMetricInput {
  pool: PoolSource;
  ttftMs?: number;
  ok: boolean;
}

export interface MetricsSnapshot {
  requests: number;
  errors: number;
  pool: Record<PoolSource, number>;
  ttft: {
    count: number;
    avg_ms: number | null;
    max_ms: number | null;
  };
  last_request_at: string | null;
}

export class RequestMetrics {
  private requests = 0;
  private errors = 0;
  private pool: Record<PoolSource, number> = {
    warm: 0,
    cold: 0,
    replacement: 0,
  };
  private ttftSum = 0;
  private ttftCount = 0;
  private ttftMax = 0;
  private lastRequestAt: string | null = null;

  recordChat(input: ChatMetricInput): void {
    this.requests += 1;
    this.lastRequestAt = new Date().toISOString();
    if (!input.ok) this.errors += 1;
    this.pool[input.pool] = (this.pool[input.pool] ?? 0) + 1;
    if (typeof input.ttftMs === "number" && Number.isFinite(input.ttftMs)) {
      this.ttftSum += input.ttftMs;
      this.ttftCount += 1;
      if (input.ttftMs > this.ttftMax) this.ttftMax = input.ttftMs;
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      requests: this.requests,
      errors: this.errors,
      pool: { ...this.pool },
      ttft: {
        count: this.ttftCount,
        avg_ms: this.ttftCount ? Math.round(this.ttftSum / this.ttftCount) : null,
        max_ms: this.ttftCount ? this.ttftMax : null,
      },
      last_request_at: this.lastRequestAt,
    };
  }
}

let _metrics: RequestMetrics | null = null;

export function createRequestMetrics(): RequestMetrics {
  return new RequestMetrics();
}

export function getRequestMetrics(): RequestMetrics {
  if (!_metrics) _metrics = createRequestMetrics();
  return _metrics;
}

/** Test helper — reset singleton. */
export function resetRequestMetrics(): void {
  _metrics = null;
}

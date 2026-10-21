/**
 * Idle timeout that renews on activity.
 *
 * `touch()` arms (or renews) a timer; if no further touch arrives within
 * `idleMs`, `onTimeout` fires once. `clear()` cancels without firing.
 */

export class IdleTimeout {
  private timer: NodeJS.Timeout | null = null;
  private _armed = false;

  constructor(
    private readonly idleMs: number,
    private readonly onTimeout: () => void
  ) {}

  /** Arm or renew the idle timer. */
  touch(): void {
    this.clearTimer();
    this._armed = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._armed = false;
      this.onTimeout();
    }, this.idleMs);
  }

  /** Cancel without firing. */
  clear(): void {
    this.clearTimer();
    this._armed = false;
  }

  get armed(): boolean {
    return this._armed;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

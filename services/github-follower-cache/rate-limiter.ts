import type { RateLimitState } from './types';

const TARGET_UTILIZATION = 0.80;

/**
 * Adaptive rate limiter that tracks GitHub API quota from response headers
 * and paces requests to use the budget evenly across the reset window.
 */
export class AdaptiveRateLimiter {
  private remaining: number;
  private limitTotal: number;
  private resetAt: Date;
  private lastRequestAt = 0;

  constructor(initial?: RateLimitState) {
    this.remaining = initial?.remaining ?? 5000;
    this.limitTotal = initial?.limitTotal ?? 5000;
    this.resetAt = initial?.resetAt ?? new Date();
  }

  /** Update state from GitHub response headers. */
  updateFromHeaders(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const limit = headers.get('x-ratelimit-limit');
    const reset = headers.get('x-ratelimit-reset');

    if (remaining !== null) this.remaining = parseInt(remaining, 10);
    if (limit !== null) this.limitTotal = parseInt(limit, 10);
    if (reset !== null) this.resetAt = new Date(parseInt(reset, 10) * 1000);
  }

  /** Return the number of milliseconds to wait before the next request. */
  getDelay(): number {
    const now = Date.now();
    const msUntilReset = Math.max(this.resetAt.getTime() - now, 1000);

    if (this.remaining <= 10) {
      // Nearly exhausted — wait for the full reset window.
      return msUntilReset;
    }

    // Distribute remaining budget evenly across the reset window,
    // scaled by the target utilization factor.
    const budgetRequests = Math.floor(this.remaining * TARGET_UTILIZATION);
    const interval = msUntilReset / Math.max(budgetRequests, 1);

    // Enforce a floor of 750ms between requests to avoid micro-bursts.
    return Math.max(interval, 750);
  }

  /** Wait the calculated delay, then mark the request as sent. */
  async waitForSlot(): Promise<void> {
    const delay = this.getDelay();
    const elapsed = Date.now() - this.lastRequestAt;
    const wait = Math.max(delay - elapsed, 0);

    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    this.lastRequestAt = Date.now();
    this.remaining = Math.max(this.remaining - 1, 0);
  }

  getState(): RateLimitState {
    return {
      remaining: this.remaining,
      limitTotal: this.limitTotal,
      resetAt: this.resetAt,
    };
  }
}

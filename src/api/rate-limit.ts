import { AppError } from '../domain/errors.js';

// One shared budget is sufficient for the loopback-only service.
export function createAuthLimiter(now: () => number = Date.now) {
  let resetAt = 0;
  let attempts = 0;
  return (): void => {
    const time = now();
    if (time >= resetAt) { resetAt = time + 60000; attempts = 0; }
    if (attempts >= 10) {
      const retryAfter = Math.ceil((resetAt - time) / 1000);
      throw new AppError(429, 'RATE_LIMITED', 'Too many authentication attempts.', `Retry in ${retryAfter}s.`, retryAfter);
    }
    attempts++;
  };
}

import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter, backoffDelay } from '../../src/moneybird/rate-limit.js';

function clock(startAt = 0) {
  let now = startAt;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('SlidingWindowLimiter', () => {
  it('allows requests up to the limit without delay', () => {
    const { now } = clock();
    const limiter = new SlidingWindowLimiter(3, 1000, now);

    expect(limiter.delayUntilSlot()).toBe(0);
    limiter.record();
    expect(limiter.delayUntilSlot()).toBe(0);
    limiter.record();
    expect(limiter.delayUntilSlot()).toBe(0);
    limiter.record();

    expect(limiter.inFlightWindowCount).toBe(3);
  });

  it('reports a delay once the limit is reached', () => {
    const time = clock();
    const limiter = new SlidingWindowLimiter(2, 1000, time.now);

    limiter.record();
    time.advance(400);
    limiter.record();

    expect(limiter.delayUntilSlot()).toBe(600);
  });

  it('frees a slot once its window has passed', () => {
    const time = clock();
    const limiter = new SlidingWindowLimiter(1, 1000, time.now);

    limiter.record();
    expect(limiter.delayUntilSlot()).toBe(1000);

    time.advance(1001);
    expect(limiter.delayUntilSlot()).toBe(0);
    expect(limiter.inFlightWindowCount).toBe(0);
  });
});

describe('backoffDelay', () => {
  it('honours Retry-After over exponential backoff', () => {
    expect(backoffDelay({ attempt: 5, retryAfterSeconds: 3 })).toBe(3000);
  });

  it('caps Retry-After at maxMs', () => {
    expect(backoffDelay({ attempt: 0, retryAfterSeconds: 120, maxMs: 30_000 })).toBe(30_000);
  });

  it('keeps jitter within the exponential ceiling', () => {
    const delay = backoffDelay({ attempt: 2, baseMs: 500, random: () => 1 });
    expect(delay).toBe(2000);
  });

  it('caps the exponential ceiling at maxMs', () => {
    const delay = backoffDelay({ attempt: 10, baseMs: 500, maxMs: 5000, random: () => 1 });
    expect(delay).toBe(5000);
  });

  it('returns 0 jitter at the low end of the range', () => {
    expect(backoffDelay({ attempt: 3, baseMs: 500, random: () => 0 })).toBe(0);
  });
});

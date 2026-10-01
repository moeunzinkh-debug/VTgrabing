import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { num } from '../src/env';
import { testEnv } from './helpers';

/**
 * `num()` decides whether a configured zero is a real setting or a typo. That is
 * load-bearing for the SSSTik pacer (an operator who sets
 * `TIKTOK_SSTIK_MIN_INTERVAL_MS=0` expects pacing off, not the 1500 ms default),
 * and for vars such as `MAX_ATTEMPTS` where a zero would be destructive.
 */
describe('num', () => {
  function envWith(overrides: Partial<Env>): Env {
    return { ...testEnv, ...overrides } as Env;
  }

  // wrangler.test.jsonc sets both SSSTik pacer vars to "0", so "unset" has to be
  // constructed here rather than read off testEnv.
  function envWithout(key: keyof Env): Env {
    const copy: Record<string, unknown> = { ...testEnv };
    delete copy[String(key)];
    // Through `unknown`: `Record<string, unknown>` and `Env` do not overlap enough
    // for a direct assertion, since Env's bindings (DB, FILES, JOB_QUEUE) are
    // object types a string-index signature says nothing about.
    return copy as unknown as Env;
  }

  it('falls back when the var is absent or not an integer', () => {
    expect(num(envWithout('TIKTOK_SSTIK_MIN_INTERVAL_MS'), 'TIKTOK_SSTIK_MIN_INTERVAL_MS', 1_500, 0)).toBe(1_500);
    expect(num(envWith({ TIKTOK_SSTIK_MIN_INTERVAL_MS: '' }), 'TIKTOK_SSTIK_MIN_INTERVAL_MS', 1_500, 0)).toBe(1_500);
    expect(num(envWith({ TIKTOK_SSTIK_MIN_INTERVAL_MS: 'abc' }), 'TIKTOK_SSTIK_MIN_INTERVAL_MS', 1_500, 0)).toBe(1_500);
    expect(num(envWith({ TIKTOK_SSTIK_MIN_INTERVAL_MS: 'NaN' }), 'TIKTOK_SSTIK_MIN_INTERVAL_MS', 1_500, 0)).toBe(1_500);
  });

  it('honours an explicit zero only when the caller allows it', () => {
    const env = envWith({ TIKTOK_SSTIK_COOLDOWN_SECONDS: '0' });
    expect(num(env, 'TIKTOK_SSTIK_COOLDOWN_SECONDS', 12, 0)).toBe(0);
    // Default minimum is 1: zero means "not configured", so the default applies.
    expect(num(env, 'TIKTOK_SSTIK_COOLDOWN_SECONDS', 12)).toBe(12);
    expect(num(envWith({ MAX_ATTEMPTS: '0' }), 'MAX_ATTEMPTS', 3)).toBe(3);
  });

  it('reads the pacer vars the suite itself is configured with', () => {
    // Guards the wrangler.test.jsonc defaults: the suite must never really sleep.
    expect(num(testEnv, 'TIKTOK_SSTIK_MIN_INTERVAL_MS', 1_500, 0)).toBe(0);
    expect(num(testEnv, 'TIKTOK_SSTIK_COOLDOWN_SECONDS', 12, 0)).toBe(0);
  });

  it('rejects negatives at every minimum, leaving clamping to the caller', () => {
    expect(num(envWith({ TIKTOK_SSTIK_MIN_INTERVAL_MS: '-5' }), 'TIKTOK_SSTIK_MIN_INTERVAL_MS', 1_500, 0)).toBe(1_500);
    expect(num(envWith({ GRAB_MAX_VIDEOS: '-1' }), 'GRAB_MAX_VIDEOS', 200)).toBe(200);
  });

  it('reads positive integers, truncating like parseInt', () => {
    expect(num(envWith({ TIKTOK_SSTIK_MIN_INTERVAL_MS: '120' }), 'TIKTOK_SSTIK_MIN_INTERVAL_MS', 1_500, 0)).toBe(120);
    expect(num(envWith({ GRAB_MAX_VIDEOS: '250' }), 'GRAB_MAX_VIDEOS', 200)).toBe(250);
    expect(num(envWith({ GRAB_MAX_VIDEOS: '250.9' }), 'GRAB_MAX_VIDEOS', 200)).toBe(250);
  });
});

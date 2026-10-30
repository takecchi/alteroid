import { describe, expect, it } from 'vitest';

import * as light from './cli-light.js';
import { LEASE_DRAIN_MS } from './lease.js';
import { DAEMON_FORCED_EXIT_MS, DAEMON_SHUTDOWN_GRACE_MS } from './shutdown-grace.js';

describe('停止の猶予の値（issue #5839）', () => {
  it('runner の猶予（LEASE_DRAIN_MS）は 60 秒（railway/runner.json の drainingSeconds と compose.yaml の stop_grace_period が正本）', () => {
    expect(LEASE_DRAIN_MS).toBe(60_000);
  });

  it('daemon の猶予は 60 秒で、自分の意思で exit する最後の口はそれより 5 秒手前', () => {
    expect(DAEMON_SHUTDOWN_GRACE_MS).toBe(60_000);
    expect(DAEMON_FORCED_EXIT_MS).toBe(DAEMON_SHUTDOWN_GRACE_MS - 5_000);
    expect(DAEMON_FORCED_EXIT_MS).toBe(55_000);
  });

  it('CLI が読める軽い出口から同じ値が引ける', () => {
    expect(light.DAEMON_SHUTDOWN_GRACE_MS).toBe(DAEMON_SHUTDOWN_GRACE_MS);
    expect(light.DAEMON_FORCED_EXIT_MS).toBe(DAEMON_FORCED_EXIT_MS);
  });
});

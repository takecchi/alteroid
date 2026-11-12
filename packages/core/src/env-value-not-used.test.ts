import { beforeEach, describe, expect, it } from 'vitest';

import { resetEnvValueNotUsedForTesting } from './env-value-not-used.js';
import {
  DEFAULT_RESCUE_INTERVAL_MS,
  MAX_RESCUE_INTERVAL_MS,
  MIN_RESCUE_INTERVAL_MS,
  RESCUE_INTERVAL_MS_ENV_KEY,
  resolveRescueIntervalMs,
} from './rescue-ref.js';
import { captureStderr } from './testing.js';

beforeEach(() => {
  resetEnvValueNotUsedForTesting();
});

describe('置かれた環境変数の値を使わずに倒したら、stderr に1行残す（#5976）', () => {
  it('同じ変数・同じ値では1回だけ言う（担当ごとに呼ばれても埋もれさせない）', async () => {
    const lines = await captureStderr(() => {
      resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: 'abc' });
      resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: 'abc' });
      resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: 'xyz' });
    });
    expect(lines).toHaveLength(2);
  });

  it('退避: setTimeout の上限（2^31-1 ms）を超える値は上限へ挟む', () => {
    expect(resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: '9999999999' })).toBe(
      MAX_RESCUE_INTERVAL_MS,
    );
  });

  it('退避: 読めない値は既定へ倒して言う', async () => {
    let interval = 0;
    const lines = await captureStderr(() => {
      interval = resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: '-5' });
    });
    expect(interval).toBe(DEFAULT_RESCUE_INTERVAL_MS);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${RESCUE_INTERVAL_MS_ENV_KEY}="-5" は正の数として読めないので既定`);
  });

  it('退避: 範囲の端へ寄せたときも、寄せた値を言う', async () => {
    let interval = 0;
    const lines = await captureStderr(() => {
      interval = resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: '10' });
    });
    expect(interval).toBe(MIN_RESCUE_INTERVAL_MS);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`の外なので ${String(MIN_RESCUE_INTERVAL_MS)} を使う`);
  });

  it('退避: 正しい値・未設定では何も言わない', async () => {
    const lines = await captureStderr(() => {
      resolveRescueIntervalMs({});
      resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: '60000' });
    });
    expect(lines).toEqual([]);
  });
});

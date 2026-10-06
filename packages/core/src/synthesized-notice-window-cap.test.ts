import { describe, expect, it } from 'vitest';

import {
  resolveSynthesizedNoticeWindowMs,
  SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY,
} from './manager.js';
import {
  MAX_RESCUE_INTERVAL_MS,
  RESCUE_INTERVAL_MS_ENV_KEY,
  resolveRescueIntervalMs,
} from './rescue-ref.js';

/**
 * `setTimeout` は 2^31-1 ms を超える値を 1ms に倒す（Node の TimeoutOverflowWarning）。
 * 兄弟の `resolveRescueIntervalMs` は MAX_RESCUE_INTERVAL_MS で挟む。合流窓の読み取りには上限が無い。
 */
const MAX_TIMER_MS = 2_147_483_647;

describe('環境変数から読むタイマー長は setTimeout の上限（2^31-1 ms）を超えない', () => {
  it('参考: resolveRescueIntervalMs は挟む（この枝でも緑のはず）', () => {
    const value = resolveRescueIntervalMs({ [RESCUE_INTERVAL_MS_ENV_KEY]: '9999999999' });
    expect(value).toBe(MAX_RESCUE_INTERVAL_MS);
  });

  it.each(['2147483648', '9999999999', '1e12'])(
    'resolveSynthesizedNoticeWindowMs: %s は上限以下に挟む',
    (raw) => {
      const value = resolveSynthesizedNoticeWindowMs({
        [SYNTHESIZED_NOTICE_WINDOW_MS_ENV_KEY]: raw,
      });
      expect(value).toBeLessThanOrEqual(MAX_TIMER_MS);
      expect(value).toBeGreaterThan(1);
    },
  );
});

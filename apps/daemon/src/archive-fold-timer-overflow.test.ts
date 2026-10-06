import { createMemoryStores } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_FOLD_EVERY_ENV,
  readArchiveFoldConfig,
  startArchiveFolding,
} from './archive-folder.js';

/**
 * `ALTEROID_ARCHIVE_FOLD_EVERY` に大きな分数を置くと、畳み込みが1ms 周期の空回りになる。
 *
 * Node の `setTimeout` は 2^31-1 ms（約24.8日 = 35791分）を超える遅延を **1ms に倒す**
 * （`TimeoutOverflowWarning`）。`readArchiveFoldConfig` は「有限で正」なら分数をそのまま通し、
 * `startArchiveFolding` はそれを `everyMinutes * 60_000` にして `setTimeout` へ渡すだけで挟まない。
 * 同じ形の兄弟（`resolveRescueIntervalMs` / `resolveScratchSweepIntervalMs`）は「`setInterval` は
 * 2^31-1 ms を超える値を 1ms 周期へ倒す」と明記して上限へ挟んでいる。この口だけ挟んでいない。
 */
const TIMER_MAX_MS = 2_147_483_647;

describe('ALTEROID_ARCHIVE_FOLD_EVERY が大きくても、次の回のタイマーは setTimeout の範囲に収まる', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('40000 分（約27.8日）を読んだ周期で仕込む setTimeout の遅延が 2^31-1 ms を超えない', async () => {
    const config = readArchiveFoldConfig({ [ARCHIVE_FOLD_EVERY_ENV]: '40000' });
    // 読めた値を使う（既定へ倒れたなら、この試験の前提が崩れたので別の赤にする）。
    expect(config.everyMinutes).not.toBeNull();

    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((_fn: unknown, delay?: number) => {
      delays.push(delay ?? 0);
      return {
        unref() {},
        ref() {},
        hasRef: () => false,
        refresh() {},
        [Symbol.toPrimitive]: () => 0,
      };
    }) as unknown as typeof setTimeout);

    const folder = startArchiveFolding({
      stores: createMemoryStores(),
      managers: undefined,
      everyMinutes: config.everyMinutes,
    });
    // 起動直後の1回が終わると、次の回のタイマーが仕込まれる。
    await folder.refresh();
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    folder.stop();

    expect(delays.length).toBeGreaterThan(0);
    // 超えると Node は 1ms に倒す＝畳み込みが全行走査を休みなく回す。
    expect(Math.max(...delays)).toBeLessThanOrEqual(TIMER_MAX_MS);
  });
});

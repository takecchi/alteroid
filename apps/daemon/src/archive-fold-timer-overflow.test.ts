import { createMemoryStores } from '@alteroid/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ARCHIVE_FOLD_EVERY_ENV,
  readArchiveFoldConfig,
  startArchiveFolding,
} from './archive-folder.js';

const TIMER_MAX_MS = 2_147_483_647;

describe('ALTEROID_ARCHIVE_FOLD_EVERY が大きくても、次の回のタイマーは setTimeout の範囲に収まる', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('40000 分（約27.8日）を読んだ周期で仕込む setTimeout の遅延が 2^31-1 ms を超えない', async () => {
    const config = readArchiveFoldConfig({ [ARCHIVE_FOLD_EVERY_ENV]: '40000' });
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
    await folder.refresh();
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    folder.stop();

    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(TIMER_MAX_MS);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeThreadpoolWait, measureThreadpoolWait } from './threadpool-wait.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('スレッドの枠の待ち（#4890）', () => {
  it('既定の処理（stat）は枠を通って返り、返るまでの ms を測る', async () => {
    const wait = await measureThreadpoolWait();
    expect(wait.settled).toBe(true);
    expect(wait.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it('処理が失敗しても、枠を通って返ったものとして測る', async () => {
    const wait = await measureThreadpoolWait({ probe: () => Promise.reject(new Error('ENOENT')) });
    expect(wait.settled).toBe(true);
  });

  it('上限まで返らなければ待つのをやめ、上限の値と settled=false を返す（待ち続けない）', async () => {
    vi.useFakeTimers();
    const pending = measureThreadpoolWait({
      capMs: 500,
      probe: () => new Promise(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual({ waitedMs: 500, settled: false });
  });

  it('文言: 測れた回は ms と枠の大きさ、上限で止めた回は「以上」、測れなかった回は「不明」', () => {
    vi.stubEnv('UV_THREADPOOL_SIZE', '16');
    expect(describeThreadpoolWait({ waitedMs: 12, settled: true })).toBe(
      'スレッドの枠の待ち 12ms（環境変数 UV_THREADPOOL_SIZE=16）',
    );
    expect(describeThreadpoolWait({ waitedMs: 2000, settled: false })).toContain(
      'スレッドの枠の待ち 2000ms 以上',
    );
    vi.stubEnv('UV_THREADPOOL_SIZE', '');
    expect(describeThreadpoolWait(undefined)).toBe(
      'スレッドの枠の待ち: 不明（環境変数 UV_THREADPOOL_SIZE=未設定）',
    );
  });
});

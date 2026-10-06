import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScheduler } from './schedule.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * `every` の分数に上限が無いので、`minutes: 1e15`（1e15 分 = 約19億年）のような値が保存でき、
 * そのときスケジューラは「次の予定」を Invalid Date にする。
 *
 * - `scheduleSpecSchema` の `every` は `z.number().int().min(1)` で上限が無い。`POST /schedule` も
 *   `schedule_create` も 200 で保存する（`Date` の範囲は ±8.64e15 ms ≒ 1.44e11 分まで）。
 * - `entry.nextAt(seed)` が Invalid Date になり、`due` が NaN になる。`#arm()` の遅延も NaN になって
 *   `setTimeout(fn, NaN)` は 1ms に倒れる。`tick()` は毎回その依頼を「期限が来た」と読み、**1ms ごとに**
 *   `timer` を受信箱へ積む。クローンの受信箱が1依頼で洪水になる。
 * - `list()`（＝`GET /schedule` / `schedule_list` の材料）は `nextAt.toISOString()` で
 *   `RangeError: Invalid time value` を投げる。定期ジョブの一覧が丸ごと読めなくなる。
 * - 行は保存済みなので、デーモンを再起動しても直らない。
 */
const T = '2026-10-05T00:00:00.000Z';

async function setup(minutes: number) {
  const stores = createMemoryStores();
  await stores.schedules.put({
    kind: 'huge',
    spec: { type: 'every', minutes },
    request: '確認する',
    createdAt: T,
    updatedAt: T,
  });
  const posted: InboxEvent[] = [];
  const scheduler = createScheduler({
    entries: [],
    post: (event) => posted.push(event),
    schedules: stores.schedules,
  });
  await scheduler.refresh();
  return { scheduler, posted };
}

describe('every の分数が Date の範囲を超えても、スケジューラは洪水を起こさず一覧も読める', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1e15 分ごとの依頼が、10秒の間に何十回も timer を積まない', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T00:00:00.000Z'));
    const { scheduler, posted } = await setup(1e15);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();

    // 正しければ 0 回（1e15 分後まで来ない）。1ms 周期に倒れると約 10000 回になる。
    expect(posted.length).toBeLessThan(5);
  });

  it('1e15 分ごとの依頼が在っても list() は投げない', async () => {
    const { scheduler } = await setup(1e15);
    scheduler.start();
    try {
      expect(() => scheduler.list()).not.toThrow();
    } finally {
      scheduler.stop();
    }
  });
});

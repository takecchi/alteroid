import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryStores } from '@alteroid/core';

import { startDailyReportCatchup } from './report-catchup.js';

/**
 * issue #2908 の歯。起動時の日報の後追いが日誌を読めなかったとき、stderr だけで
 * 終わらず、日誌に跡を残し、有限回、間を置いて調べ直す。
 */

/**
 * 日報の時刻（`at`）と `now` は器のローカル時刻で読む（`new Date(年, 月, …)`）。器の TZ に
 * 依らず同じ日付になるよう、このファイルの TZ を固定する（`scripts/check-test-tz-fixed.test.ts`。
 * 書き方は `apps/web/app/routes/reports.test.tsx` に倣う: import より先に効かせるため
 * vi.hoisted の中で代入し、他のファイルへ漏らさないよう戻す）。
 */
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

const AT = { hour: 22, minute: 0 };

function setup(failScans: number, delays: number[]) {
  const stores = createMemoryStores();
  const rawListPage = stores.journal.listPage.bind(stores.journal);
  let scans = 0;
  stores.journal.listPage = ((query) => {
    scans += 1;
    if (scans <= failScans) return Promise.reject(new Error('db unreachable\nsecret-line'));
    return rawListPage(query);
  }) as typeof stores.journal.listPage;
  const posted: { target?: string; cause?: string }[] = [];
  const stderr: string[] = [];
  const handle = startDailyReportCatchup({
    journal: stores.journal,
    at: AT,
    lookbackDays: 3,
    post: (event) => posted.push(event as never),
    retryDelaysMs: delays,
    now: () => new Date(2026, 9, 5, 23, 0, 0),
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
  });
  return { stores, rawListPage, posted, stderr, handle, scans: () => scans };
}

describe('日報の起動時の後追いが日誌を読めなかった回（#2908）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // **偽の時計の「現在」を、`now`（10/5 23:00）と同じ日の日報の時刻より前に固定する。** 固定しないと、
    // 日誌へ積む活動の `at` が実際の時計の時刻になり、実際の日付が `now` の翌日以降になった回
    // （CI が JST の 0 時を越えて走った回）は、活動が `now` より後の日になって後追いの対象から外れ、
    // `posted` が空になる（main d6149b1e の CI run 37328947897）。
    vi.setSystemTime(new Date(2026, 9, 5, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('跡を日誌へ [失敗] で残し、間を置いて調べ直し、見つかった日を後追いで積む', async () => {
    const s = setup(1, [10]);
    await s.stores.journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: '活動',
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    const notes = (await s.rawListPage({ types: ['exchange'], order: 'asc' })).entries as {
      text: string;
    }[];
    expect(notes.some((e) => e.text.includes('取りこぼした日報を調べられなかった'))).toBe(true);
    expect(notes.some((e) => e.text.includes('secret-line'))).toBe(false);
    expect(s.posted).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10);
    expect(s.scans()).toBeGreaterThanOrEqual(2);
    expect(s.posted.map((e) => e.cause)).toEqual(['schedule_catchup']);
    s.handle.stop();
  });

  it('読めない状態が続くなら有限回で止まり、stop() で待機を破棄する', async () => {
    const s = setup(99, [10, 10]);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.scans()).toBe(3);
    const s2 = setup(99, [10, 10]);
    s2.handle.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(s2.scans()).toBe(1);
  });

  it('日誌へも書けないときは stderr に落ち、投げない', async () => {
    const s = setup(1, [10]);
    s.stores.journal.append = () => Promise.reject(new Error('write failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.stderr.join('')).toContain('日誌にも残せませんでした');
    s.handle.stop();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClone } from './clone.js';
import { fakeSdk, flushPendingMicrotasks } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

/**
 * `stop()` の先頭（`if (stopped || inbox.closed) return;` の**前**）で、日報の再試行の timer を同期に全部消す順序の固定。
 * 日報を協力者へ切り出す前に置いた（今の作りで通る）。切り出しのあと `this.#daily.dispose()`（同期）の1行になっても、この3点は変えない。
 *
 * 1. 同期に消える: `stop()` の呼びの直後、最初の `await` に戻る前に消えている
 * 2. 蒸留を待つ間に発火しない: shutdown の蒸留（`#postAndWait`）が終わるまでに時間を進めても、追い合図が投函されない
 * 3. 2 度目の `stop()` でも消える: 1 度目の途中（`inbox.closed` が立っている間）に仕掛かった timer を、早期 return の前に消す
 */

const DATE = '2026-10-04';
// 数字の関係: 日報のターンと蒸留のターンが各 TURN_MS かかる。再試行の間隔は、日報が失敗した直後から蒸留の途中に収まる長さにする
const TURN_MS = 1000;
const RETRY_MS = 300;

type Setup = ReturnType<typeof build>;

function build(failTurns: (turnIndex: number) => boolean) {
  const stores = createMemoryStores();
  const { fn, calls } = fakeSdk(() => '今日はログイン周りを直した。', {
    delayMs: TURN_MS,
    resultFor: (turnIndex) =>
      failTurns(turnIndex)
        ? { subtype: 'error_during_execution', text: 'API の一時的な過負荷' }
        : undefined,
  });
  const clone = createClone({
    stores,
    queryFn: fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    dailyReportRetryDelaysMs: [RETRY_MS, RETRY_MS],
  } as Parameters<typeof createClone>[0]);
  return { clone, stores, calls };
}

const dailyEvent = (date: string) =>
  ({
    type: 'timer',
    id: `evt-timer-${date}`,
    at: new Date().toISOString(),
    kind: 'daily_report',
    target: date,
  }) as never;

const rowsOf = async (s: Setup) =>
  (await s.stores.journal.list({ types: ['daily_report'] })) as {
    unavailable?: string;
  }[];

// 失敗の印が書かれ、そのあとの `#scheduleDailyReportRetry`（印を書く await の次の同期の行）まで進める
async function untilRetryScheduled(s: Setup, marks: number): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if ((await rowsOf(s)).filter((r) => r.unavailable !== undefined).length >= marks) {
      await flushPendingMicrotasks();
      return;
    }
    await vi.advanceTimersByTimeAsync(10);
  }
  throw new Error('日報の失敗の印が書かれなかった');
}

describe('クローン — stop() の先頭で日報の再試行の timer を消す順序', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('1. stop() を呼んだ直後（最初の await に戻る前）に、再試行の timer が消えている', async () => {
    const s = build((turn) => turn === 0);
    s.clone.post(dailyEvent(DATE));
    await untilRetryScheduled(s, 1);

    const before = vi.getTimerCount();
    const stopped = s.clone.stop();
    // 同期に確かめる: ここまで一度も await していない
    expect(vi.getTimerCount()).toBe(before - 1);

    await vi.advanceTimersByTimeAsync(TURN_MS * 3);
    await stopped;
  });

  it('2. 蒸留を待つ間に時間を進めても、日報の追い合図は投函されない', async () => {
    const s = build((turn) => turn === 0);
    s.clone.post(dailyEvent(DATE));
    await untilRetryScheduled(s, 1);

    const posted = vi.spyOn(s.clone, 'post');
    let finished = false;
    const stopped = s.clone.stop().then(() => {
      finished = true;
    });
    // 蒸留（1 ターン = TURN_MS）の途中まで: 消し忘れていれば RETRY_MS の timer はここで発火する
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(finished).toBe(false);
    expect(posted.mock.calls.filter(([event]) => event.type === 'timer')).toEqual([]);

    await vi.advanceTimersByTimeAsync(TURN_MS * 3);
    await stopped;
    expect(posted.mock.calls.filter(([event]) => event.type === 'timer')).toEqual([]);
  });

  it('3. 1 度目の stop() の途中（inbox が閉じた後）に仕掛かった timer を、2 度目の stop() が消す', async () => {
    // turn 0: 日報（失敗）。turn 1: shutdown の蒸留。turn 2: 蒸留の間に積んだ日報（失敗）— inbox を閉じた後の読み切りで走る
    const s = build((turn) => turn === 0 || turn === 2);
    s.clone.post(dailyEvent(DATE));
    await untilRetryScheduled(s, 1);

    // 1 度目の stop() を最後の段（`managers.stop`）で止めておく: 読み切りが終わって inbox が閉じ、`#stopped` も立った後の、2 度目の呼びが早期 return する状態を作る
    let releaseManagers!: () => void;
    const managersGate = new Promise<void>((resolve) => {
      releaseManagers = resolve;
    });
    (s.clone as unknown as { managers: { stop: () => Promise<void> } }).managers.stop = () =>
      managersGate;

    let finished = false;
    const first = s.clone.stop().then(() => {
      finished = true;
    });
    // 蒸留が走っている間に別の日の日報を積む（同じ日だと重複確認で畳まれる）
    s.clone.post(dailyEvent('2026-10-05'));
    // 蒸留の終わり（inbox を閉じる）のあとの読み切りで、2 本目の日報が失敗して印を書き、timer が仕掛かるまで
    await untilRetryScheduled(s, 2);
    await flushPendingMicrotasks();
    expect(finished).toBe(false);

    const posted = vi.spyOn(s.clone, 'post');
    const before = vi.getTimerCount();
    const second = s.clone.stop();
    expect(vi.getTimerCount()).toBe(before - 1);

    await vi.advanceTimersByTimeAsync(RETRY_MS * 4);
    expect(posted.mock.calls.filter(([event]) => event.type === 'timer')).toEqual([]);
    releaseManagers();
    await first;
    await second;
  });
});

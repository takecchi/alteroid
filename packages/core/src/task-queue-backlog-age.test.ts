import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setup, waitFor } from './clone-test-harness.js';
import { buildActivityDigest } from './digest.js';
import type { Task } from './schema.js';
import type { Stores, TaskList } from './store.js';
import { describeTaskBacklogAge, describeTaskQueueHead } from './task-tools.js';
import { createMemoryStores, humanMessage } from './testing.js';

// 滞留している Task（waiting / needs_decision）の件数と、最も古いものの古さ（updatedAt からの経過）を、待ち行列の節に1行足す。
// 新しい仕様を先に書いた試験（実装の前は赤）。今の出力を固定する側は task-queue-notice-pin.test.ts が持つ。
// 期待の文字列:
//   - 「今の作りの出力」: 件数の行・先頭の行・固定の1文（この試験では 0 件のとき・滞留が無いときの全文として、変わらないことを見る）
//   - 「新しい仕様」: `- 滞留: needs_decision 3 件（最も古いのは 5日3時間前）` の形の 1 行（件数の行の次。読めない行の断りがあればその次）
// 古さの描き方は situation.ts と同じ `formatMinutesAgo`（分・時間+分・日+時間）。しきい値は置かない（waiting / needs_decision が1件でもあれば出る）。
// 時刻は `Date` だけを止める（実時間の待ちは足さない）。

const NOW = Date.parse('2026-11-01T09:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function task(id: string, status: Task['status'], updatedAt: string): Task {
  return {
    id,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
    status,
    origin: 'self',
    title: `title-${id}`,
    body: `body-${id}`,
  };
}

const list = (entries: Task[], unreadable: TaskList['unreadable'] = []): TaskList => ({
  entries,
  unreadable,
});

const COUNT_LINE = (queued: number, waiting: number, needs: number): string =>
  `- 待ち行列: 開いている ${queued + waiting + needs} 件（queued ${queued} / waiting ${waiting} / needs_decision ${needs}）`;

const BACKLOG_PREFIX = '- 滞留: ';

describe('describeTaskBacklogAge（純関数）', () => {
  it('(a) needs_decision が 1 件以上: 件数と、最も古いものの古さが出る（並びの先頭ではなく最古を取る）', () => {
    const entries = [
      task('n-new', 'needs_decision', ago(2 * HOUR)),
      task('n-old', 'needs_decision', ago(5 * DAY + 3 * HOUR)),
      task('n-mid', 'needs_decision', ago(1 * DAY)),
    ];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
      '- 滞留: needs_decision 3 件（最も古いのは 5日3時間前）',
    ]);
  });

  it('(b) waiting も同様', () => {
    const entries = [
      task('w-1', 'waiting', ago(1 * HOUR + 20 * MIN)),
      task('w-2', 'waiting', ago(30 * MIN)),
    ];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
      '- 滞留: waiting 2 件（最も古いのは 1時間20分前）',
    ]);
  });

  it('両方あるとき: 1 行に needs_decision、waiting の順で並ぶ', () => {
    const entries = [
      task('w-1', 'waiting', ago(40 * MIN)),
      task('n-1', 'needs_decision', ago(2 * DAY)),
    ];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
      '- 滞留: needs_decision 1 件（最も古いのは 2日0時間前） / waiting 1 件（最も古いのは 40分前）',
    ]);
  });

  it('(c) 両方 0 件なら何も返さない（queued だけ・閉じた件だけ・空でも）', () => {
    expect(describeTaskBacklogAge(list([]), NOW)).toEqual([]);
    expect(describeTaskBacklogAge(list([task('q', 'queued', ago(30 * DAY))]), NOW)).toEqual([]);
    const closed = [task('d', 'done', ago(30 * DAY)), task('c', 'cancelled', ago(30 * DAY))];
    expect(describeTaskBacklogAge(list(closed), NOW)).toEqual([]);
  });

  it('閉じた件は数えない（waiting だった履歴は古さに入らない）', () => {
    const entries = [
      task('n-1', 'needs_decision', ago(3 * HOUR)),
      task('d', 'done', ago(30 * DAY)),
    ];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
      '- 滞留: needs_decision 1 件（最も古いのは 3時間0分前）',
    ]);
  });

  describe('(d) 古さの境目（formatMinutesAgo と同じ描き分け）', () => {
    it.each([
      [0, '1分未満前'],
      [59 * SEC, '1分未満前'],
      [60 * SEC, '1分前'],
      [59 * MIN + 59 * SEC, '59分前'],
      [60 * MIN, '1時間0分前'],
      [23 * HOUR + 59 * MIN + 59 * SEC, '23時間59分前'],
      [24 * HOUR, '1日0時間前'],
      [5 * DAY + 3 * HOUR + 59 * MIN, '5日3時間前'],
      [-5 * MIN, '1分未満前'],
    ])('経過 %i ms は「%s」', (elapsed, label) => {
      expect(
        describeTaskBacklogAge(list([task('n', 'needs_decision', ago(elapsed))]), NOW),
      ).toEqual([`- 滞留: needs_decision 1 件（最も古いのは ${label}）`]);
    });
  });

  describe('(e) updatedAt が読めない行', () => {
    it('件数には入れ、古さは読める行の中の最古で言う', () => {
      const entries = [
        task('n-bad', 'needs_decision', 'not-a-date'),
        task('n-ok', 'needs_decision', ago(2 * HOUR)),
      ];
      expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
        '- 滞留: needs_decision 2 件（最も古いのは 2時間0分前）',
      ]);
    });

    it('全部読めなければ、件数と「経過不明」だけを言う（0 分前などへ丸めない）', () => {
      const entries = [task('w-bad', 'waiting', ''), task('w-bad2', 'waiting', 'xx')];
      expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
        '- 滞留: waiting 2 件（経過不明）',
      ]);
    });
  });
});

describe('describeTaskQueueHead への足し方', () => {
  it('件数の行の次・先頭の行の前に 1 行入る', () => {
    const entries = [
      task('q-1', 'queued', ago(1 * DAY)),
      task('n-1', 'needs_decision', ago(5 * DAY)),
    ];
    const lines = describeTaskQueueHead(list(entries), { limit: 3, nowMs: NOW });
    expect(lines.slice(0, 2)).toEqual([
      COUNT_LINE(1, 0, 1),
      '- 滞留: needs_decision 1 件（最も古いのは 5日0時間前）',
    ]);
    expect(lines).toHaveLength(5);
  });

  it('読めない行の断りがあれば、その次に入る', () => {
    const lines = describeTaskQueueHead(
      list([task('w-1', 'waiting', ago(2 * HOUR))], [{ reason: '不正' }]),
      { limit: 3, nowMs: NOW },
    );
    expect(lines[1]).toContain('読めない task の行が 1 件ある');
    expect(lines[2]).toBe('- 滞留: waiting 1 件（最も古いのは 2時間0分前）');
  });

  it('(c) waiting / needs_decision が 0 件なら、今の出力から 1 字も変わらない', () => {
    const entries = [task('a', 'queued', ago(30 * DAY)), task('b', 'queued', ago(1 * DAY))];
    expect(describeTaskQueueHead(list(entries), { limit: 3, nowMs: NOW })).toEqual([
      COUNT_LINE(2, 0, 0),
      '- a（状態: queued（待ち行列） / origin: self）title-a',
      '- b（状態: queued（待ち行列） / origin: self）title-b',
      '（先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）',
    ]);
    expect(describeTaskQueueHead(list([]), { limit: 3, nowMs: NOW })).toEqual([
      COUNT_LINE(0, 0, 0),
    ]);
  });

  it('開いている件が無ければ（閉じた件だけ）、滞留の行は出ない', () => {
    const lines = describeTaskQueueHead(list([task('d', 'done', ago(9 * DAY))]), {
      limit: 3,
      nowMs: NOW,
    });
    expect(lines).toEqual([COUNT_LINE(0, 0, 0)]);
  });
});

async function seed(stores: Stores): Promise<void> {
  await stores.tasks.add(task('q-1', 'queued', ago(1 * DAY)));
  await stores.tasks.add(task('w-1', 'waiting', ago(1 * HOUR + 20 * MIN)));
  await stores.tasks.add(task('n-1', 'needs_decision', ago(5 * DAY + 3 * HOUR)));
}

const BACKLOG_LINE =
  '- 滞留: needs_decision 1 件（最も古いのは 5日3時間前） / waiting 1 件（最も古いのは 1時間20分前）';

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('(f) 呼び元ごとの出方（既存の振る舞いを保つ）', () => {
  it('人間以外の報告のターン: 断り書きの待ち行列の節に 1 回だけ出る', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'manager_message',
      id: 'evt-report',
      at: new Date().toISOString(),
      managerId: 'mgr-T',
      kind: 'report',
      text: '本文',
    });
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '報告のターン');
    const input = s.calls[0]?.inputs[0] ?? '';
    await s.clone.stop();

    expect(count(input, BACKLOG_LINE)).toBe(1);
    const start = input.indexOf('[system] 待ち行列（');
    expect(input.indexOf(BACKLOG_LINE)).toBeGreaterThan(start);
    expect(input.indexOf(BACKLOG_LINE)).toBeLessThan(input.indexOf('- q-1（'));
  });

  it('発意の tick: 先頭を要約に任せる回。滞留の行も要約の節に 1 回だけで、断り書き側には出ない', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const s = setup(undefined, stores);
    s.clone.post({
      type: 'self_initiative',
      id: 'evt-self-1',
      at: new Date().toISOString(),
      reason: '定期 tick',
    });
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '発意の tick のターン');
    const input = s.calls[0]?.inputs[0] ?? '';
    await s.clone.stop();

    expect(input).not.toContain('[system] 待ち行列（');
    expect(count(input, BACKLOG_LINE)).toBe(1);
    expect(input.indexOf(BACKLOG_LINE)).toBeGreaterThan(input.indexOf('## 待ち行列の先頭'));
  });

  it('蒸留のターンには載せない（滞留の Task が在っても）', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const s = setup(undefined, stores);
    // 蒸留は会話が始まっていないと走らない: 1 回目の人間の発言のターン（滞留の行が出る側）を先に済ませる
    s.clone.post(humanMessage('1回目'));
    await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length >= 1);
    s.clone.post({
      type: 'distill',
      id: 'evt-tidy-1',
      at: new Date().toISOString(),
      reason: 'scheduled',
    });
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 2, '蒸留のターン');
    const first = s.calls[0]?.inputs[0] ?? '';
    const distill = s.calls[0]?.inputs[1] ?? '';
    await s.clone.stop();

    expect(first).toContain(BACKLOG_LINE);
    expect(distill).toContain('定期の棚卸しの刻みが来た');
    expect(distill).not.toContain(BACKLOG_PREFIX);
  });

  it('digest（full 形）: 件数の行の次に出る。時刻は呼んだ時点（Date）から数える', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const digest = await buildActivityDigest(stores, { since: new Date(NOW - 60_000) });
    const lines = digest.split('\n');
    const at = lines.indexOf(BACKLOG_LINE);
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe(COUNT_LINE(1, 1, 1));
  });

  it('digest（counts 形）: 件数の 1 行だけで、滞留の行は足さない（定期の依頼の tick は件数の形のまま）', async () => {
    const stores = createMemoryStores();
    await seed(stores);
    const counts = await buildActivityDigest(
      stores,
      { since: new Date(NOW - 60_000) },
      undefined,
      undefined,
      { shape: 'counts' },
    );
    expect(counts).not.toContain(BACKLOG_PREFIX);
    expect(counts).toContain(COUNT_LINE(1, 1, 1));
  });

  it('滞留が無いふつうの回: 断り書きにも digest にも滞留の行は出ない', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('q-1', 'queued', ago(1 * DAY)));
    const digest = await buildActivityDigest(stores, { since: new Date(NOW - 60_000) });
    expect(digest).not.toContain(BACKLOG_PREFIX);
  });
});

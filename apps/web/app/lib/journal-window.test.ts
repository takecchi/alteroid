/**
 * `journal-window.ts` の歯。**jsdom を指定していない** — この対象は DOM にも
 * virtua にも触れないので、素の node 環境で測れる（vitest の既定環境）。
 *
 * ここで測るのは「カーソル送りのロジック」であって、`virtua` が実際に画面へ
 * 何行描くかではない（`journal.test.tsx` の冒頭コメントを参照。あちらは
 * jsdom で測れないものと測れるものを分けている）。
 */
import { describe, expect, it } from 'vitest';

import type { JournalEntry } from '~/lib/types';

import {
  applyNewerPage,
  applyOlderPage,
  filterByType,
  mergeBack,
  mergeFront,
  newestAt,
  oldestAt,
  pageOutcome,
  shiftForPrepend,
} from './journal-window';

function entry(id: string, at: string, type: JournalEntry['type'] = 'decision'): JournalEntry {
  if (type === 'decision') {
    return { type, id, at, decision: `d-${id}`, grounds: 'g' };
  }
  return { type: 'tool_use', id, at, actor: 'clone', tool: 't', input: {} };
}

describe('mergeFront（先頭＝新着側へ差し込む）', () => {
  it('新規分だけを先頭へ足し、新しい順を保つ', () => {
    const existing = [entry('b', '2026-08-20T00:01:00.000Z')];
    const incoming = [entry('a', '2026-08-20T00:02:00.000Z')];
    const result = mergeFront(existing, incoming);
    expect(result.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.freshCount).toBe(1);
  });

  it('id が既存と重なる分は二重に足さない', () => {
    const existing = [entry('shared', '2026-08-20T00:01:00.000Z')];
    const incoming = [entry('shared', '2026-08-20T00:01:00.000Z')];
    const result = mergeFront(existing, incoming);
    expect(result.entries.map((e) => e.id)).toEqual(['shared']);
    expect(result.freshCount).toBe(0);
  });

  it('新規0件なら既存の配列をそのまま返す（新しい配列を作らない）', () => {
    const existing = [entry('shared', '2026-08-20T00:01:00.000Z')];
    const result = mergeFront(existing, [entry('shared', '2026-08-20T00:01:00.000Z')]);
    expect(result.entries).toBe(existing);
  });

  it('incoming が空でも既存をそのまま返す', () => {
    const existing = [entry('x', '2026-08-20T00:01:00.000Z')];
    const result = mergeFront(existing, []);
    expect(result.entries).toBe(existing);
    expect(result.freshCount).toBe(0);
  });
});

describe('mergeBack（末尾＝過去側へ差し込む）', () => {
  it('新規分だけを末尾へ足す', () => {
    const existing = [entry('a', '2026-08-20T00:02:00.000Z')];
    const incoming = [entry('b', '2026-08-20T00:01:00.000Z')];
    const result = mergeBack(existing, incoming);
    expect(result.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(result.freshCount).toBe(1);
  });

  it('境界の1件（inclusive の until で必ず再度返る分）は重複として落ちる', () => {
    const oldest = entry('oldest', '2026-08-20T00:00:00.000Z');
    const existing = [entry('a', '2026-08-20T00:02:00.000Z'), oldest];
    // until=oldest.at で撃つと oldest 自身が必ず再度返る
    const result = mergeBack(existing, [oldest]);
    expect(result.entries).toBe(existing);
    expect(result.freshCount).toBe(0);
  });
});

describe('pageOutcome（このページの後、次に何をすべきか）', () => {
  it('新規が1件でもあれば progress', () => {
    expect(pageOutcome(50, 50, 1, 1000)).toBe('progress');
    expect(pageOutcome(1, 50, 1, 1000)).toBe('progress');
  });

  it('新規0件・応答が limit 未満 → 本当の終端（end）', () => {
    // サーバの list() は取れるだけ取ってから返すので、limit 未満で返った
    // 時点で「探しうる範囲を全部見た」ことが確定する。limit と maxLimit が
    // 同じでも end が優先される（進めるはずが無いので retryLarger にしない）。
    expect(pageOutcome(3, 50, 0, 1000)).toBe('end');
    expect(pageOutcome(0, 50, 0, 1000)).toBe('end');
    expect(pageOutcome(999, 1000, 0, 1000)).toBe('end');
  });

  it('新規0件・応答が limit ちょうど・limit がまだ上限未満 → retryLarger', () => {
    // 1ページ丸ごと使い切ったのに1件も前進していない＝境界と同じ at を持つ
    // エントリが limit 件を超えて並んでいる可能性がある。まだ limit を
    // 上げる余地があるので、ここで終端扱いにしない。
    expect(pageOutcome(50, 50, 0, 1000)).toBe('retryLarger');
  });

  it('新規0件・応答が limit ちょうど・limit が上限に達している → blocked', () => {
    // サーバが許す上限（1000）まで上げても1件も進まない＝本物の限界。
    // 「終端」でも「空」でもない、区別して見せるべき状態。
    expect(pageOutcome(1000, 1000, 0, 1000)).toBe('blocked');
  });

  it('既定の maxLimit は JOURNAL_MAX_LIMIT（1000）', () => {
    expect(pageOutcome(1000, 1000, 0)).toBe('blocked');
  });
});

describe('applyOlderPage / applyNewerPage（マージと判定を1回で行う合成）', () => {
  it('applyOlderPage は末尾へ足し、end/retryLarger/blocked を返す', () => {
    const oldest = entry('oldest', '2026-08-20T00:00:00.000Z');
    const existing = [entry('a', '2026-08-20T00:02:00.000Z'), oldest];

    const progressed = applyOlderPage(
      existing,
      [oldest, entry('older', '2026-08-19T00:00:00.000Z')],
      50,
    );
    expect(progressed.entries.map((e) => e.id)).toEqual(['a', 'oldest', 'older']);
    expect(progressed.outcome).toBe('progress');

    const ended = applyOlderPage(existing, [oldest], 50);
    expect(ended.entries).toBe(existing);
    expect(ended.outcome).toBe('end');
  });

  it('applyNewerPage は先頭へ足す', () => {
    const newest = entry('newest', '2026-08-20T00:02:00.000Z');
    const existing = [newest, entry('a', '2026-08-20T00:01:00.000Z')];
    const result = applyNewerPage(
      existing,
      [entry('fresher', '2026-08-20T00:03:00.000Z'), newest],
      50,
    );
    expect(result.entries.map((e) => e.id)).toEqual(['fresher', 'newest', 'a']);
    expect(result.outcome).toBe('progress');
    expect(result.freshCount).toBe(1);
  });
});

describe('oldestAt / newestAt', () => {
  it('新しい順の配列から境界を取り出す', () => {
    const entries = [
      entry('new', '2026-08-20T00:02:00.000Z'),
      entry('old', '2026-08-20T00:01:00.000Z'),
    ];
    expect(newestAt(entries)).toBe('2026-08-20T00:02:00.000Z');
    expect(oldestAt(entries)).toBe('2026-08-20T00:01:00.000Z');
  });

  it('空配列なら undefined（撃つ材料が無い）', () => {
    expect(newestAt([])).toBeUndefined();
    expect(oldestAt([])).toBeUndefined();
  });
});

describe('filterByType', () => {
  const decision = entry('d', '2026-08-20T00:01:00.000Z', 'decision');
  const tool = entry('t', '2026-08-20T00:02:00.000Z', 'tool_use');

  it('選択が空なら絞らない', () => {
    expect(filterByType([decision, tool], [])).toEqual([decision, tool]);
  });

  it('選択した種別だけ残す', () => {
    expect(filterByType([decision, tool], ['tool_use'])).toEqual([tool]);
  });
});

describe('shiftForPrepend（新着を先頭に足すとき shift に何を渡すか）', () => {
  it('何も足されていないなら、上端に居ようが居まいが shift しない', () => {
    expect(shiftForPrepend(false, true)).toBe(false);
    expect(shiftForPrepend(false, false)).toBe(false);
  });

  it('足された・上端に居る → shift しない（新着がそのまま見える。仮想化前と同じ）', () => {
    expect(shiftForPrepend(true, true)).toBe(false);
  });

  it('足された・上端に居ない（遡って読んでいる） → shift する（読んでいる行が動かない）', () => {
    expect(shiftForPrepend(true, false)).toBe(true);
  });
});

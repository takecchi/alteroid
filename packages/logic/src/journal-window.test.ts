import { describe, expect, it } from 'vitest';

import type { JournalEntry } from './types.js';

import {
  applyInitialPage,
  applyOlderPage,
  filterByType,
  filterRecent,
  journalHorizonNote,
  journalHorizonNoteForHuman,
  mergeBack,
  mergeFront,
  newerPageQuery,
  newestAt,
  oldestAt,
  olderPageQuery,
  readThroughUnreadable,
  shiftForPrepend,
} from './journal-window.js';

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
    const result = mergeBack(existing, [oldest]);
    expect(result.entries).toBe(existing);
    expect(result.freshCount).toBe(0);
  });
});

describe('applyOlderPage（マージと判定を1回で行う合成）', () => {
  it('applyOlderPage は末尾へ足し、outcome は next だけで決める', () => {
    const oldest = entry('oldest', '2026-08-20T00:00:00.000Z');
    const existing = [entry('a', '2026-08-20T00:02:00.000Z'), oldest];
    const cursor = { id: 'c', at: '2026-08-19T00:00:00.000Z' };

    const progressed = applyOlderPage(
      existing,
      [oldest, entry('older', '2026-08-19T00:00:00.000Z')],
      cursor,
    );
    expect(progressed.entries.map((e) => e.id)).toEqual(['a', 'oldest', 'older']);
    expect(progressed.outcome).toBe('progress');

    const ended = applyOlderPage(existing, [oldest], null);
    expect(ended.entries).toBe(existing);
    expect(ended.outcome).toBe('end');
  });
});

describe('applyInitialPage（窓の無い初期読み込み1回の適用。issue #1530）', () => {
  it('next が null なら、中身がいくつあっても end（freshCount を待たない）', () => {
    const page = [entry('a', '2026-08-20T00:02:00.000Z'), entry('b', '2026-08-20T00:01:00.000Z')];
    const result = applyInitialPage(page, null);
    expect(result.entries).toBe(page);
    expect(result.outcome).toBe('end');
    expect(result.freshCount).toBe(2);
  });

  it('page.length が0でも next が null なら end（空の日誌）', () => {
    const result = applyInitialPage([], null);
    expect(result.outcome).toBe('end');
    expect(result.freshCount).toBe(0);
  });

  it('next が非 null なら progress（まだ続きがある）', () => {
    const page = [entry('a', '2026-08-20T00:02:00.000Z')];
    const result = applyInitialPage(page, { id: 'c', at: '2026-08-20T00:00:00.000Z' });
    expect(result.outcome).toBe('progress');
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

describe('newerPageQuery / olderPageQuery（どちらの端を、どちらのクエリ引数へ載せるか）', () => {
  const entries = [
    entry('new', '2026-08-20T00:02:00.000Z'),
    entry('mid', '2026-08-20T00:01:30.000Z'),
    entry('old', '2026-08-20T00:01:00.000Z'),
  ];

  it('新着方向は、先頭（最新）の at を since に載せる', () => {
    expect(newerPageQuery(entries)).toEqual({ since: '2026-08-20T00:02:00.000Z' });
  });

  it('過去方向は、継続点 next だけを afterId/afterAt に載せる（末尾の at から until へは戻らない）', () => {
    expect(olderPageQuery({ id: 'c', at: '2026-08-20T00:01:00.000Z' })).toEqual({
      afterId: 'c',
      afterAt: '2026-08-20T00:01:00.000Z',
    });
    expect(olderPageQuery(undefined)).toBeUndefined();
  });

  it('一覧が空なら newerPageQuery は undefined（撃つ材料が無い＝撃たない）', () => {
    expect(newerPageQuery([])).toBeUndefined();
  });

  it('1件だけなら新着方向は、その1件の at を指す（境界は inclusive で、その1件が必ず再度返る）', () => {
    const one = [entry('only', '2026-08-20T00:00:00.000Z')];
    expect(newerPageQuery(one)).toEqual({ since: '2026-08-20T00:00:00.000Z' });
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

describe('filterRecent（recent へ、種別と語の絞りを掛け直す）', () => {
  const tomato = entry('a', '2026-08-20T00:01:00.000Z');
  const eggplant: JournalEntry = {
    type: 'decision',
    id: 'b',
    at: '2026-08-20T00:02:00.000Z',
    decision: 'ナスの支柱を立てる',
    grounds: 'g',
  };
  const withWord: JournalEntry = {
    type: 'decision',
    id: 'c',
    at: '2026-08-20T00:03:00.000Z',
    decision: 'トマトの水やり',
    grounds: 'g',
  };

  it('q が空なら語では絞らない（種別の絞りだけが効く）', () => {
    expect(filterRecent([tomato, eggplant], [], '')).toEqual([tomato, eggplant]);
  });

  it('当たらない新着は落とす（検索中の画面へ割り込ませない）', () => {
    expect(filterRecent([withWord, eggplant], [], 'トマト')).toEqual([withWord]);
  });

  it('大文字小文字を区別しない部分一致（サーバ側と同じ照合を通る）', () => {
    const shouted: JournalEntry = {
      type: 'decision',
      id: 'd',
      at: '2026-08-20T00:04:00.000Z',
      decision: 'TOMATO を植えた',
      grounds: 'g',
    };
    expect(filterRecent([shouted, eggplant], [], 'tomato')).toEqual([shouted]);
  });

  it('種別と語の両方が効く（片方だけでは残らない）', () => {
    const toolRow = entry('t2', '2026-08-20T00:06:00.000Z', 'tool_use');
    expect(filterRecent([withWord, toolRow], ['decision'], 'トマト')).toEqual([withWord]);
    expect(filterRecent([withWord, toolRow], ['tool_use'], 'トマト')).toEqual([]);
  });

  it('tool_use の input は探す対象に入っていない', () => {
    const toolUse: JournalEntry = {
      type: 'tool_use',
      id: 'e',
      at: '2026-08-20T00:05:00.000Z',
      actor: 'clone',
      tool: 'Bash',
      input: { command: 'echo トマト' },
    };
    expect(filterRecent([toolUse], [], 'トマト')).toEqual([]);
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

  it('足された・上端に居る・読んでいる（行を展開中／文章を選択中） → shift する（#2774）', () => {
    expect(shiftForPrepend(true, true, true)).toBe(true);
  });

  it('何も足されていなければ、読んでいても shift しない', () => {
    expect(shiftForPrepend(false, true, true)).toBe(false);
    expect(shiftForPrepend(false, false, true)).toBe(false);
  });
});

describe('journalHorizonNote（issue #1510 の積み残し）', () => {
  it('outcome が end で crossesHorizon が真なら、oldestAt を含む注記を返す', () => {
    const note = journalHorizonNote('end', '2026-09-12T20:21:05.123Z', true);
    expect(note).toContain('2026-09-12T20:21:05.123Z');
    expect(note).toContain('区別できない');
  });

  it('outcome が end でも crossesHorizon が偽なら、注記は無い（本当に終端だと言い切れる）', () => {
    expect(journalHorizonNote('end', '2026-09-12T20:21:05.123Z', false)).toBeUndefined();
  });

  it('outcome が progress なら、crossesHorizon が真でも注記は無い', () => {
    expect(journalHorizonNote('progress', '2026-09-12T20:21:05.123Z', true)).toBeUndefined();
  });

  it('oldestAt が無い（サーバが since/until 無しの応答を返した）なら、crossesHorizon が真でも注記は無い', () => {
    expect(journalHorizonNote('end', undefined, true)).toBeUndefined();
    expect(journalHorizonNote('end', null, true)).toBeUndefined();
  });

  it('crossesHorizon が未定義（サーバの応答に無い）なら注記は無い', () => {
    expect(journalHorizonNote('end', '2026-09-12T20:21:05.123Z', undefined)).toBeUndefined();
  });
});

describe('継続点 next（Issue #2604 / #2605）', () => {
  const cursor = { id: 'c', at: '2026-08-20T00:00:00.000Z' };
  const page499 = Array.from({ length: 499 }, (_, i) =>
    entry(`p${i}`, new Date(Date.UTC(2026, 7, 20) - i * 60_000).toISOString()),
  );

  it('applyInitialPage: 499 件で返っても next が非 null なら progress（end にしない）', () => {
    expect(applyInitialPage(page499, cursor).outcome).toBe('progress');
  });

  it('applyInitialPage: next が null なら、件数に関わらず end（本当の終端）', () => {
    const exact = Array.from({ length: 3 }, (_, i) =>
      entry(`e${i}`, `2026-08-20T00:0${i}:00.000Z`),
    );
    expect(applyInitialPage(exact, null).outcome).toBe('end');
  });

  it('applyInitialPage: 空の頁でも next が非 null なら progress', () => {
    expect(applyInitialPage([], cursor).outcome).toBe('progress');
  });

  it('applyOlderPage: next が非 null なら、短い頁（freshCount 0 を含む）でも progress', () => {
    const existing = [entry('a', '2026-08-20T00:02:00.000Z')];
    const older = [entry('b', '2026-08-20T00:01:00.000Z')];
    expect(applyOlderPage(existing, older, cursor).outcome).toBe('progress');
    expect(applyOlderPage(existing, [], cursor).outcome).toBe('progress');
  });

  it('applyOlderPage: next が null なら end', () => {
    const existing = [entry('a', '2026-08-20T00:02:00.000Z')];
    const older = [entry('b', '2026-08-20T00:01:00.000Z')];
    expect(applyOlderPage(existing, older, null).outcome).toBe('end');
  });

  it('古い側の頁は next だけで続きを決め、next が無い（undefined）なら件数から推定せず終わりとする (#5708)', () => {
    // 型は `null` までしか許さない。`next` を返さなかった頃のデーモンの応答を実行時だけで再現する
    const missingNext = undefined as unknown as null;
    const existing = [entry('a', '2026-08-20T00:02:00.000Z')];
    // 新規 0 件の頁でも、件数からの retryLarger にしない
    expect(applyOlderPage(existing, existing, missingNext).outcome).toBe('end');
    // 件数が多くても、`progress` へ推定しない
    expect(applyInitialPage(page499, missingNext).outcome).toBe('end');
    // 継続点が無ければ、末尾の at から until へ戻らない
    expect(olderPageQuery(missingNext)).toBeUndefined();
  });

  it('olderPageQuery: 継続点が在れば afterId/afterAt で読む。null／未取得なら撃たない', () => {
    expect(olderPageQuery(cursor)).toEqual({ afterId: 'c', afterAt: cursor.at });
    expect(olderPageQuery(null)).toBeUndefined();
    expect(olderPageQuery(undefined)).toBeUndefined();
  });

  describe('readThroughUnreadable（空なのに終端でない頁を読み継ぐ）', () => {
    type P = { entries: JournalEntry[]; next: { id: string; at: string } | null };
    const real = entry('r', '2026-08-20T00:00:00.000Z');

    it('空で next が非 null の間、継続点で読み継ぎ、読めた頁か終端の頁で止まる', async () => {
      const seen: string[] = [];
      const pages: Record<string, P> = {
        c1: { entries: [], next: { id: 'c2', at: cursor.at } },
        c2: { entries: [real], next: null },
      };
      const result = await readThroughUnreadable<P>(
        { entries: [], next: { id: 'c1', at: cursor.at } },
        async (c) => {
          seen.push(c.id);
          return pages[c.id]!;
        },
      );
      expect(seen).toEqual(['c1', 'c2']);
      expect(result).toEqual({ entries: [real], next: null });
    });

    it('空でも next が null なら読み継がない（終端）', async () => {
      const never = async (): Promise<P> => {
        throw new Error('呼ばれない');
      };
      expect(await readThroughUnreadable<P>({ entries: [], next: null }, never)).toEqual({
        entries: [],
        next: null,
      });
    });

    it('1件でも読めた頁は、next が非 null でもそのまま返す', async () => {
      const never = async (): Promise<P> => {
        throw new Error('呼ばれない');
      };
      const first: P = { entries: [real], next: cursor };
      expect(await readThroughUnreadable<P>(first, never)).toBe(first);
    });
  });
});

describe('journalHorizonNoteForHuman（issue #2806）', () => {
  const fmt = (iso: string) => `<${iso.slice(0, 10)}>`;

  it('出す条件は journalHorizonNote と同じ', () => {
    expect(
      journalHorizonNoteForHuman('progress', '2026-10-03T01:00:00.000Z', true, fmt),
    ).toBeUndefined();
    expect(
      journalHorizonNoteForHuman('end', '2026-10-03T01:00:00.000Z', false, fmt),
    ).toBeUndefined();
    expect(journalHorizonNoteForHuman('end', null, true, fmt)).toBeUndefined();
  });

  it('時刻は渡された整形で出し、ISO 文字列と内部の言葉（記憶ストア）を出さない', () => {
    const note = journalHorizonNoteForHuman('end', '2026-10-03T01:00:00.000Z', true, fmt);
    expect(note).toContain('<2026-10-03>');
    expect(note).not.toContain('T01:00');
    expect(note).not.toContain('記憶ストア');
  });
});

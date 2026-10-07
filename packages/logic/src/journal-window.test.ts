import { describe, expect, it } from 'vitest';

import type { JournalEntry } from './types.js';

import {
  applyInitialPage,
  applyNewerPage,
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
  pageOutcome,
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

describe('pageOutcome（このページの後、次に何をすべきか）', () => {
  it('新規が1件でもあれば progress', () => {
    expect(pageOutcome(50, 50, 1, 1000)).toBe('progress');
    expect(pageOutcome(1, 50, 1, 1000)).toBe('progress');
  });

  it('新規0件・応答が limit 未満 → 本当の終端（end）', () => {
    expect(pageOutcome(3, 50, 0, 1000)).toBe('end');
    expect(pageOutcome(0, 50, 0, 1000)).toBe('end');
    expect(pageOutcome(999, 1000, 0, 1000)).toBe('end');
  });

  it('新規0件・応答が limit ちょうど・limit がまだ上限未満 → retryLarger', () => {
    expect(pageOutcome(50, 50, 0, 1000)).toBe('retryLarger');
  });

  it('新規0件・応答が limit ちょうど・limit が上限に達している → blocked', () => {
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

describe('applyInitialPage（窓の無い初期読み込み1回の適用。issue #1530）', () => {
  it('page.length が limit 未満なら、中身がいくつあっても end（freshCount を待たない）', () => {
    const page = [entry('a', '2026-08-20T00:02:00.000Z'), entry('b', '2026-08-20T00:01:00.000Z')];
    const result = applyInitialPage(page, 100);
    expect(result.entries).toBe(page);
    expect(result.outcome).toBe('end');
    expect(result.freshCount).toBe(2);
  });

  it('page.length が0でも end（空の日誌）', () => {
    const result = applyInitialPage([], 100);
    expect(result.outcome).toBe('end');
    expect(result.freshCount).toBe(0);
  });

  it('page.length が limit ちょうどなら progress（まだ続きがあるかもしれない）', () => {
    const base = new Date('2026-08-20T00:00:00.000Z').getTime();
    const page = Array.from({ length: 100 }, (_, i) =>
      entry(`p${i}`, new Date(base - i * 60_000).toISOString()),
    );
    const result = applyInitialPage(page, 100);
    expect(result.outcome).toBe('progress');
  });

  it('applyOlderPage との違い——既存が空でも freshCount>0 なら applyOlderPage は progress のまま', () => {
    const page = [entry('a', '2026-08-20T00:02:00.000Z')];
    expect(applyOlderPage([], page, 100).outcome).toBe('progress');
    expect(applyInitialPage(page, 100).outcome).toBe('end');
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

  it('過去方向は、末尾（最古）の at を until に載せる', () => {
    expect(olderPageQuery(entries)).toEqual({ until: '2026-08-20T00:01:00.000Z' });
  });

  it('一覧が空なら undefined（撃つ材料が無い＝撃たない）', () => {
    expect(newerPageQuery([])).toBeUndefined();
    expect(olderPageQuery([])).toBeUndefined();
  });

  it('1件だけなら両方向とも同じ at を指す（境界は inclusive で、その1件が必ず再度返る）', () => {
    const one = [entry('only', '2026-08-20T00:00:00.000Z')];
    expect(newerPageQuery(one)).toEqual({ since: '2026-08-20T00:00:00.000Z' });
    expect(olderPageQuery(one)).toEqual({ until: '2026-08-20T00:00:00.000Z' });
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

  it('outcome が progress/retryLarger/blocked なら、crossesHorizon が真でも注記は無い', () => {
    expect(journalHorizonNote('progress', '2026-09-12T20:21:05.123Z', true)).toBeUndefined();
    expect(journalHorizonNote('retryLarger', '2026-09-12T20:21:05.123Z', true)).toBeUndefined();
    expect(journalHorizonNote('blocked', '2026-09-12T20:21:05.123Z', true)).toBeUndefined();
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
    expect(applyInitialPage(page499, 500, cursor).outcome).toBe('progress');
  });

  it('applyInitialPage: next が null なら、limit ちょうどでも end（本当の終端）', () => {
    const exact = Array.from({ length: 3 }, (_, i) =>
      entry(`e${i}`, `2026-08-20T00:0${i}:00.000Z`),
    );
    expect(applyInitialPage(exact, 3, null).outcome).toBe('end');
  });

  it('applyInitialPage: 空の頁でも next が非 null なら progress', () => {
    expect(applyInitialPage([], 500, cursor).outcome).toBe('progress');
  });

  it('applyInitialPage: next の欄が無い（古いデーモン）なら従来どおり件数で推す', () => {
    expect(applyInitialPage(page499, 500).outcome).toBe('end');
    expect(applyInitialPage(page499, 499).outcome).toBe('progress');
  });

  it('applyOlderPage: next が非 null なら、短い頁（freshCount 0 を含む）でも progress', () => {
    const existing = [entry('a', '2026-08-20T00:02:00.000Z')];
    const older = [entry('b', '2026-08-20T00:01:00.000Z')];
    expect(applyOlderPage(existing, older, 500, 1000, cursor).outcome).toBe('progress');
    expect(applyOlderPage(existing, [], 500, 1000, cursor).outcome).toBe('progress');
  });

  it('applyOlderPage: next が null なら end。next が無ければ従来の判定（短い頁は end）', () => {
    const existing = [entry('a', '2026-08-20T00:02:00.000Z')];
    const older = [entry('b', '2026-08-20T00:01:00.000Z')];
    expect(applyOlderPage(existing, older, 500, 1000, null).outcome).toBe('end');
    expect(applyOlderPage(existing, existing, 1, 1000).outcome).toBe('retryLarger');
  });

  it('olderPageQuery: 継続点が在れば afterId/afterAt で読む（一覧が空でも）。null なら撃たない', () => {
    expect(olderPageQuery([], cursor)).toEqual({ afterId: 'c', afterAt: cursor.at });
    expect(olderPageQuery([entry('a', '2026-08-20T00:02:00.000Z')], cursor)).toEqual({
      afterId: 'c',
      afterAt: cursor.at,
    });
    expect(olderPageQuery([entry('a', '2026-08-20T00:02:00.000Z')], null)).toBeUndefined();
    expect(olderPageQuery([entry('a', '2026-08-20T00:02:00.000Z')])).toEqual({
      until: '2026-08-20T00:02:00.000Z',
    });
  });

  describe('readThroughUnreadable（空なのに終端でない頁を読み継ぐ）', () => {
    type P = { entries: JournalEntry[]; next?: { id: string; at: string } | null };
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

    it('空でも next が null／欄が無いなら読み継がない（終端・古いデーモン）', async () => {
      const never = async (): Promise<P> => {
        throw new Error('呼ばれない');
      };
      expect(await readThroughUnreadable<P>({ entries: [], next: null }, never)).toEqual({
        entries: [],
        next: null,
      });
      expect(await readThroughUnreadable<P>({ entries: [] }, never)).toEqual({ entries: [] });
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
    for (const outcome of ['progress', 'retryLarger', 'blocked'] as const) {
      expect(
        journalHorizonNoteForHuman(outcome, '2026-10-03T01:00:00.000Z', true, fmt),
      ).toBeUndefined();
    }
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

import { describe, expect, it } from 'vitest';

import { fakeApi, gate, journalEntry, minute, said } from './fake-api.js';
import type { HeaderFeed } from './header-feed.js';
import { JournalController } from './journal-controller.js';
import { JOURNAL_PAGE } from '@alteroid/logic';
import { waitFor } from './test-helpers.js';

function setup(
  configure: (api: ReturnType<typeof fakeApi>) => void = () => undefined,
  options: { retainChars?: number } = {},
) {
  const api = fakeApi();
  configure(api);
  const controller = new JournalController(api, options);
  let push: (entry: ReturnType<typeof said>) => void = () => undefined;
  let fire: (type: string) => void = () => undefined;
  const feed = {
    onEntry: (listener: typeof push) => {
      push = listener;
      return () => undefined;
    },
    onEvent: (listener: typeof fire) => {
      fire = listener;
      return () => undefined;
    },
  } as unknown as HeaderFeed;
  controller.attach(feed);
  const state = () => controller.store.getSnapshot();
  const ids = () => state().entries.map((e) => e.id);
  return {
    api,
    controller,
    state,
    ids,
    push: (e: ReturnType<typeof said>) => push(e),
    fire: (t: string) => fire(t),
  };
}

/** 新しい順に `from`..`to` 分目の発言を並べる。 */
const run = (to: number, from = 1) => Array.from({ length: to - from + 1 }, (_, i) => said(to - i));

describe('読み込みと追従', () => {
  it('開いた時に 1 度だけ読む（limit・horizon つき）。選択は最新で、追従する', async () => {
    const { api, controller, state, ids } = setup((a) => {
      a.journalEntries = run(3);
    });
    controller.enter();
    await waitFor(() => state().status === 'ready');
    controller.enter();
    expect(api.journalListCalls).toEqual([
      { limit: JOURNAL_PAGE, types: [], q: '', horizon: true },
    ]);
    expect(ids()).toEqual(['e3', 'e2', 'e1']);
    expect(state().selectedId).toBe('e3');
    expect(state().follow).toBe(true);
    expect(state().older).toBe('end');
  });

  it('SSE の新着は先頭へ足す。追従中は選択も最新へ進む。重複は足さない', async () => {
    const { controller, state, ids, push } = setup((a) => {
      a.journalEntries = run(2);
    });
    controller.enter();
    await waitFor(() => state().status === 'ready');
    push(said(3));
    push(said(3));
    expect(ids()).toEqual(['e3', 'e2', 'e1']);
    expect(state().selectedId).toBe('e3');
  });

  it('遡っている間は位置を止める（新着が来ても選択は動かない）。最新へ戻ると追従に戻る', async () => {
    const { controller, state, push } = setup((a) => {
      a.journalEntries = run(3);
    });
    controller.enter();
    await waitFor(() => state().status === 'ready');
    controller.moveSelection(1);
    expect(state()).toMatchObject({ selectedId: 'e2', follow: false });
    push(said(4));
    push(said(5));
    expect(state()).toMatchObject({ selectedId: 'e2', follow: false });
    controller.moveSelection(-1);
    expect(state().selectedId).toBe('e3');
    controller.moveSelection(-1);
    controller.moveSelection(-1);
    expect(state()).toMatchObject({ selectedId: 'e5', follow: true });
    push(said(6));
    expect(state().selectedId).toBe('e6');
  });

  it('n（最新へ）で追従に戻る', async () => {
    const { controller, state, push } = setup((a) => {
      a.journalEntries = run(3);
    });
    controller.enter();
    await waitFor(() => state().status === 'ready');
    controller.moveSelection(2);
    push(said(4));
    controller.jumpNewest();
    expect(state()).toMatchObject({ selectedId: 'e4', follow: true });
  });

  it('まだ開いていないあいだに届いた新着は拾わない。読んでいる最中に届いた分は読み終えたあとに重なる', async () => {
    const { api, controller, state, ids, push } = setup((a) => {
      a.journalEntries = run(2);
    });
    push(said(9));
    expect(state().entries).toEqual([]);

    const slow = gate();
    const original = api.listJournal.bind(api);
    api.listJournal = async (query) => {
      await slow.wait;
      return original(query);
    };
    controller.enter();
    push(said(3));
    expect(state().entries).toEqual([]);
    slow.open();
    await waitFor(() => state().status === 'ready');
    expect(ids()).toEqual(['e3', 'e2', 'e1']);
  });

  it('最初の読み込みの失敗は空と描かない（status が error で理由を持つ）。r で読み直せる', async () => {
    const { api, controller, state } = setup((a) => {
      a.journalEntries = run(1);
      a.journalListFails = '繋がらない';
    });
    controller.enter();
    await waitFor(() => state().status === 'error');
    expect(state()).toMatchObject({ error: '繋がらない', entries: [] });
    api.journalListFails = null;
    await controller.load();
    expect(state()).toMatchObject({ status: 'ready', error: null });
    expect(state().entries).toHaveLength(1);
  });
});

describe('絞り込み', () => {
  it('絞りはサーバへ投げ、SSE の新着にも同じ絞り（種別・語）を掛ける', async () => {
    const { api, controller, state, ids, push } = setup((a) => {
      a.journalEntries = [
        journalEntry('d1', 'decision', minute(2), { decision: '進める', grounds: '根拠' }),
        said(1),
      ];
    });
    controller.enter();
    await waitFor(() => state().status === 'ready');
    controller.setFilter(['decision'], '');
    await waitFor(() => state().status === 'ready' && state().types.length === 1);
    expect(api.journalListCalls.at(-1)).toMatchObject({ types: ['decision'], q: '' });
    expect(ids()).toEqual(['d1']);

    push(said(3)); // 種別が違う → 割り込まない
    expect(ids()).toEqual(['d1']);
    push(journalEntry('d2', 'decision', minute(4), { decision: '止める', grounds: '根拠' }));
    expect(ids()).toEqual(['d2', 'd1']);

    controller.setFilter(['decision'], 'やめる');
    await waitFor(() => state().q === 'やめる' && state().status === 'ready');
    push(journalEntry('d3', 'decision', minute(5), { decision: '進める', grounds: 'a' }));
    expect(ids()).not.toContain('d3');
    push(journalEntry('d4', 'decision', minute(6), { decision: 'やめる', grounds: 'a' }));
    expect(ids()).toContain('d4');
  });

  it('絞りを変えたあとに戻ってきた古い応答は捨てる', async () => {
    const { api, controller, state, ids } = setup((a) => {
      a.journalEntries = [journalEntry('d1', 'decision', minute(2), {}), said(1)];
    });
    const slow = gate();
    const original = api.listJournal.bind(api);
    let calls = 0;
    api.listJournal = async (query) => {
      calls += 1;
      if (calls === 1) await slow.wait;
      return original(query);
    };
    controller.enter(); // 絞りなし（遅い）
    controller.setFilter(['decision'], ''); // 速い
    await waitFor(() => state().status === 'ready');
    slow.open();
    await controller.load().catch(() => undefined);
    expect(state().types).toEqual(['decision']);
    expect(ids()).toEqual(['d1']);
  });

  it('選択画面: Web のチップと同じ並びで保ち、Enter で適用すると先頭から読み直す', async () => {
    const { api, controller, state } = setup((a) => {
      a.journalEntries = run(1);
    });
    controller.enter();
    await waitFor(() => state().status === 'ready');
    controller.openFilter();
    expect(state().view).toBe('filter');
    // exchange(0) decision(1) escalation(2) tool_use(3)
    controller.moveFilterCursor(2);
    controller.toggleFilterDraft();
    controller.moveFilterCursor(-1);
    controller.toggleFilterDraft();
    expect(state().filterDraft).toEqual(['decision', 'escalation']);
    controller.applyFilter();
    await waitFor(() => state().status === 'ready' && state().types.length === 2);
    expect(api.journalListCalls.at(-1)).toMatchObject({ types: ['decision', 'escalation'] });
    expect(state().view).toBe('list');
    controller.openFilter();
    controller.cancelFilter();
    expect(state().types).toEqual(['decision', 'escalation']);
  });
});

describe('古い側と取りこぼし', () => {
  it('古い側は until（最古の at）で読み足す。境界の重複は足さず、満たない頁で終端', async () => {
    const { api, controller, state, ids } = setup((a) => {
      a.journalEntries = run(5);
    });
    controller.setFilter([], '', 2);
    await waitFor(() => state().status === 'ready');
    expect(ids()).toEqual(['e5', 'e4']);
    expect(state().older).toBe('progress');
    // until は inclusive: 境界の e4 が再度返るが、足すのは新しい e3 だけ。
    await controller.loadOlder();
    expect(api.journalListCalls.at(-1)).toMatchObject({ limit: 2, until: minute(4) });
    expect(ids()).toEqual(['e5', 'e4', 'e3']);
    await controller.loadOlder();
    await controller.loadOlder();
    expect(ids()).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
    expect(state().older).toBe('progress'); // e2,e1 でちょうど頁がいっぱいだった
    await controller.loadOlder(); // 境界の e1 だけが返る = 前進 0 かつ limit 未満 → 終端
    expect(state().older).toBe('end');
    const calls = api.journalListCalls.length;
    await controller.loadOlder(); // 終端なら撃たない
    expect(api.journalListCalls).toHaveLength(calls);
  });

  it('同じ時刻の行が詰まって進まないときは limit を上げて撃ち直し、それでも進まなければ blocked', async () => {
    const { api, controller, state } = setup((a) => {
      a.journalEntries = [
        journalEntry('a', 'exchange', minute(2)),
        journalEntry('b', 'exchange', minute(2)),
      ];
    });
    controller.setFilter([], '', 2);
    await waitFor(() => state().status === 'ready');
    expect(state().older).toBe('progress'); // 頁がちょうどいっぱい
    await controller.loadOlder();
    // 1 回目 limit=2 は境界の 2 件が再度返るだけ → 1000 で撃ち直す → 返りが 1000 未満なので終端。
    expect(api.journalListCalls.slice(-2).map((c) => c.limit)).toEqual([2, 1000]);
    expect(state().older).toBe('end');
  });

  it('一番古いところへ選択が届いたら、続きを自動で読む', async () => {
    const { api, controller, state, ids } = setup((a) => {
      a.journalEntries = run(4);
    });
    controller.setFilter([], '', 2);
    await waitFor(() => state().status === 'ready');
    controller.moveSelection(1);
    await waitFor(() => ids().length === 4);
    expect(api.journalListCalls.at(-1)).toMatchObject({ until: minute(3) });
  });

  it('繋ぎ直した（open）ら、最新の at を since にして取りこぼしを埋める', async () => {
    const { api, controller, state, ids, fire } = setup((a) => {
      a.journalEntries = run(2);
    });
    controller.enter();
    await waitFor(() => state().status === 'ready');
    api.journalEntries = run(4);
    fire('open');
    await waitFor(() => ids().length === 4);
    expect(api.journalListCalls.at(-1)).toMatchObject({ since: minute(2) });
    expect(ids()).toEqual(['e4', 'e3', 'e2', 'e1']);
    expect(state().selectedId).toBe('e4');
  });

  it('まだ開いていなければ、open でも読まない', () => {
    const { api, fire } = setup();
    fire('open');
    expect(api.journalListCalls).toHaveLength(0);
  });
});

describe('文字数の予算', () => {
  const big = (n: number) => said(n, 'あ'.repeat(1000));

  it('初期読み込みが予算を超えたら古い側を手放し、「もう無い」と言わない', async () => {
    const { controller, state } = setup(
      (a) => {
        a.journalEntries = [big(5), big(4), big(3), big(2), big(1)];
      },
      { retainChars: 2500 },
    );
    controller.enter();
    await waitFor(() => state().status === 'ready');
    expect(state().entries.length).toBeLessThan(5);
    expect(state().entries[0]?.id).toBe('e5');
    expect(state().older).toBe('budget');
    expect(state().trimmed).toBe(5 - state().entries.length);
  });

  it('予算に達していれば古い側は撃たない。SSE の新着は古い側から押し出す', async () => {
    const { api, controller, state, ids, push } = setup(
      (a) => {
        a.journalEntries = [big(5), big(4), big(3), big(2), big(1)];
      },
      { retainChars: 2500 },
    );
    controller.enter();
    await waitFor(() => state().status === 'ready');
    const calls = api.journalListCalls.length;
    await controller.loadOlder();
    expect(api.journalListCalls).toHaveLength(calls);
    const before = state().trimmed;
    push(big(6));
    expect(ids()[0]).toBe('e6');
    expect(state().trimmed).toBeGreaterThan(before);
    expect(state().older).toBe('budget');
  });
});

describe('詳細', () => {
  it('選択中の 1 件を開く。一覧から捨てられても実体を持ち続ける', async () => {
    const { controller, state, push } = setup(
      (a) => {
        a.journalEntries = [said(2, 'あ'.repeat(1000)), said(1, 'い'.repeat(1000))];
      },
      { retainChars: 2500 },
    );
    controller.enter();
    await waitFor(() => state().status === 'ready');
    controller.moveSelection(1);
    controller.openDetail();
    expect(state()).toMatchObject({ view: 'detail' });
    expect(state().detail?.id).toBe('e1');
    push(said(3, 'う'.repeat(1000)));
    push(said(4, 'え'.repeat(1000)));
    expect(state().detail?.id).toBe('e1');
    controller.back();
    expect(state()).toMatchObject({ view: 'list', detail: null });
  });
});

/**
 * 継続点（`GET /journal` の `next`。Issue #2604 / #2605）。デーモンは読めない行を
 * `limit` の後で捨てるので、頁が短い・空であることは終端ではない。
 */
describe('継続点 next（Issue #2604 / #2605）', () => {
  it('limit 未満で返っても next が先を指すなら end にせず、続きを読んで古い行へ届く', async () => {
    const { api, controller, state, ids } = setup((a) => {
      a.journalCursors = true;
      a.journalEntries = run(6);
      a.journalUnreadable = new Set(['e5']);
    });
    controller.setFilter([], '', 3);
    await waitFor(() => state().status === 'ready');
    // 生の頁は e6 e5 e4 のうち e5 が読めず、2 件で返る。先に e3.. が在る。
    expect(ids()).toEqual(['e6', 'e4']);
    expect(state().older).toBe('progress');

    await controller.loadOlder();
    expect(ids()).toEqual(['e6', 'e4', 'e3', 'e2', 'e1']);
    expect(state().older).toBe('end');
    // 古い側は until ではなく継続点（afterId）で読む。
    expect(api.journalListCalls.at(-1)).toMatchObject({ afterId: 'e4', horizon: true });
  });

  it('最初の頁が丸ごと読めなくても、空と描かずに古い側まで読み継ぐ', async () => {
    const { controller, state, ids } = setup((a) => {
      a.journalCursors = true;
      a.journalEntries = run(8);
      a.journalUnreadable = new Set(['e8', 'e7', 'e6']);
    });
    controller.setFilter([], '', 3);
    await waitFor(() => state().status === 'ready');
    expect(ids()).toEqual(['e5', 'e4', 'e3']);
    expect(state().older).toBe('progress');
  });

  it('本当の終端: 件数がちょうど limit でも next が null なら end で、読み足さない', async () => {
    const { api, controller, state, ids } = setup((a) => {
      a.journalCursors = true;
      a.journalEntries = run(3);
    });
    controller.setFilter([], '', 3);
    await waitFor(() => state().status === 'ready');
    expect(ids()).toEqual(['e3', 'e2', 'e1']);
    expect(state().older).toBe('end');
    await controller.loadOlder();
    expect(api.journalListCalls).toHaveLength(1);
  });
});

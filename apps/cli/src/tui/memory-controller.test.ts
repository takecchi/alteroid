import { describe, expect, it } from 'vitest';

import { fakeApi, memoryDoc, memoryRow } from './fake-api.js';
import type { HeaderFeed } from './header-feed.js';
import { MEMORY_DETAIL_CHARS, MemoryController } from './memory-controller.js';
import { memoryDescriptionLine, memoryDetailStatus, memoryTitleLine } from './memory-view.js';
import { waitFor } from './test-helpers.js';

function setup(configure: (api: ReturnType<typeof fakeApi>) => void = () => undefined) {
  const api = fakeApi();
  configure(api);
  const controller = new MemoryController(api, { debounceMs: 5 });
  let fire: (type: string) => void = () => undefined;
  const feed = {
    onEvent: (listener: typeof fire) => {
      fire = listener;
      return () => undefined;
    },
  } as unknown as HeaderFeed;
  controller.attach(feed);
  const state = () => controller.store.getSnapshot();
  return { api, controller, state, fire: (t: string) => fire(t) };
}

describe('一覧', () => {
  it('開いた時に 1 度だけ読む（GET /memory）。memory_update の出来事で取り直し、選択は slug で保つ', async () => {
    const { api, controller, state, fire } = setup((a) => {
      a.memoryRows = [memoryRow('a'), memoryRow('b')];
    });
    // 一度も開いていないあいだは、出来事が来ても読まない。
    fire('memory_update');
    expect(state().status).toBe('idle');

    controller.enter();
    await waitFor(() => state().status === 'ready');
    controller.enter();
    controller.moveSelection(1);
    api.memoryRows = [memoryRow('z'), ...api.memoryRows];
    fire('exchange'); // 記憶に関係ない出来事では取り直さない
    fire('memory_update');
    fire('memory_update'); // 続けて届いても 1 回にまとまる
    await waitFor(() => state().rows.length === 3);
    expect(state().rows[state().selected]?.slug).toBe('b');
  });

  it('取り直しの失敗は前の一覧を残して理由を出す。最初の失敗は空と描かない', async () => {
    const { api, controller, state } = setup((a) => {
      a.memoryListFails = '繋がらない';
    });
    controller.enter();
    await waitFor(() => state().status === 'error');
    expect(state()).toMatchObject({ rows: [], error: '繋がらない' });

    api.memoryListFails = null;
    api.memoryRows = [memoryRow('a')];
    await controller.loadList();
    api.memoryListFails = 'また切れた';
    await controller.refreshList();
    expect(state()).toMatchObject({ status: 'ready', error: 'また切れた' });
    expect(state().rows).toHaveLength(1);
  });

  it('選択は端で止まる', async () => {
    const { controller, state } = setup((a) => {
      a.memoryRows = [memoryRow('a'), memoryRow('b')];
    });
    controller.enter();
    await waitFor(() => state().status === 'ready');
    controller.moveSelection(-5);
    expect(state().selected).toBe(0);
    controller.moveSelection(5);
    expect(state().selected).toBe(1);
  });
});

describe('詳細（読むだけ）', () => {
  it('選んだ slug の本文を GET /memory/{slug} で読む。戻ると捨てる', async () => {
    const { api, controller, state } = setup((a) => {
      a.memoryRows = [memoryRow('a'), memoryRow('b')];
      a.memoryDocs['b'] = memoryDoc('b', '# B\n\n本文');
    });
    controller.enter();
    await waitFor(() => state().status === 'ready');
    controller.moveSelection(1);
    controller.openSelected();
    await waitFor(() => state().detail?.status === 'ready');
    expect(api.readMemoryCalls).toEqual(['b']);
    expect(state().detail?.doc?.content).toBe('# B\n\n本文');
    expect(state().detail?.body[0]?.text).toBe('# B\n\n本文');
    controller.back();
    expect(state()).toMatchObject({ view: 'list', detail: null });
  });

  it('無い記憶（404）は missing。読めなかったのは error で、空とは描かない', async () => {
    const { api, controller, state } = setup();
    await controller.open('nothing');
    expect(state().detail?.status).toBe('missing');
    const original = api.readMemory.bind(api);
    api.readMemory = () => Promise.reject(new Error('落ちた'));
    await controller.open('x');
    expect(state().detail).toMatchObject({ status: 'error', error: '落ちた', body: [] });
    api.readMemory = original;
  });

  it('memory_update で詳細を取り直す。本文が変わらなければ同じ参照を保つ', async () => {
    const { api, controller, state, fire } = setup((a) => {
      a.memoryRows = [memoryRow('a')];
      a.memoryDocs['a'] = memoryDoc('a', '一版');
    });
    controller.enter();
    await waitFor(() => state().status === 'ready');
    controller.openSelected();
    await waitFor(() => state().detail?.status === 'ready');
    const first = state().detail?.body;
    await controller.refreshDetail();
    expect(state().detail?.body).toBe(first);

    api.memoryDocs['a'] = memoryDoc('a', '二版');
    fire('memory_update');
    await waitFor(() => state().detail?.doc?.content === '二版');
    expect(state().detail?.body[0]?.text).toBe('二版');
  });

  it('長い本文は文字数の予算で切り、全体の字数を言う', async () => {
    const { controller, state } = setup((a) => {
      a.memoryDocs['big'] = memoryDoc('big', 'あ'.repeat(MEMORY_DETAIL_CHARS + 500));
    });
    await controller.open('big');
    expect(state().detail?.body[0]?.text).toHaveLength(MEMORY_DETAIL_CHARS);
    expect(state().detail?.cutFrom).toBe(MEMORY_DETAIL_CHARS + 500);
    const status = memoryDetailStatus(state().detail ?? (undefined as never), 0);
    expect(status.text).toContain(String(MEMORY_DETAIL_CHARS + 500));
  });
});

describe('一覧の文言', () => {
  it('1 件目はタイトル・slug・大きさ・更新、2 件目は要旨（印は要旨の前）', () => {
    const row = memoryRow('persona', { title: '人となり', kind: 'premise', bytes: 1536 });
    expect(memoryTitleLine(row, Date.parse('2026-10-02T00:10:00.000Z'))).toBe(
      '[premise] 人となり  persona · 1.5 KB · 更新 10分前',
    );
    expect(memoryDescriptionLine(row)).toBe('    要旨の後に本文は動いていない: persona の要旨');
    expect(
      memoryDescriptionLine(
        memoryRow('x', { description: undefined, descriptionFreshness: { kind: 'absent' } }),
      ).trim(),
    ).toBe('');
    expect(
      memoryDescriptionLine(memoryRow('y', { descriptionFreshness: { kind: 'unknown' } })),
    ).toContain('要旨を書いた時刻が記録されていない: ');
  });
});

describe('切り詰めはサロゲートペアを割らない（#2592）', () => {
  it('詳細の本文の予算切り', async () => {
    const { controller, state } = setup((a) => {
      a.memoryDocs['emoji'] = memoryDoc('emoji', `a${'😀'.repeat(MEMORY_DETAIL_CHARS)}`);
    });
    await controller.open('emoji');
    const text = state().detail?.body[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('一覧の要旨の切り詰めはサロゲートペアを割らない（#2592）', () => {
  it('memoryDescriptionLine', () => {
    const row = memoryRow('a', { description: `a${'😀'.repeat(400)}` });
    expect(memoryDescriptionLine(row)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

import type { InboxEvent } from './schema.js';
import type { InboxStore } from './store.js';

// vitest に依存しない素の関数にする（storage-fs / storage-pg へ vitest を持ち込まないため）。
// 器の立て方の違いは `makeStore` で受ける: ケースごとに空の器を作り直す（ケース同士で未読を持ち越さない）。
// 時刻の待ちは使わない: 同着は同じ `at` を渡して作る。
// 実装ごとにしか成り立たない期待（fs の旧い +09:00 の行・pg の生 SQL で仕込む壊れた行）はここへ置かず、各実装の試験に残す。
export type InboxStoreFactory = () => InboxStore | Promise<InboxStore>;

function fail(property: string, detail: string): never {
  throw new Error(`InboxStore の契約（${property}）が破れている — ${detail}`);
}

// undefined の欄も区別して比べる（`{ count: 0 }` と `{ count: 0, oldestAt: undefined }` を同じにしない）。
function show(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner === undefined ? '<undefined>' : inner,
  );
}

function expectEqual(property: string, label: string, actual: unknown, expected: unknown): void {
  if (show(actual) !== show(expected)) {
    fail(property, `${label}（期待: ${show(expected)} / 実際: ${show(actual)}）`);
  }
}

const human = (id: string, at: string, text: string): InboxEvent => ({
  type: 'human_message',
  id,
  at,
  text,
  conversationId: 'conv-1',
});

const textOf = (event: InboxEvent): unknown => (event as { text?: unknown }).text;

const ids = (entries: readonly { event: { id: string } }[]): string[] =>
  entries.map((entry) => entry.event.id);

async function putAt(store: InboxStore, id: string, at: string, text = id): Promise<void> {
  await store.put(human(id, at, text), at);
}

const T1 = '2026-08-10T00:00:00.000Z';
const T2 = '2026-08-11T00:00:00.000Z';
const T3 = '2026-08-12T00:00:00.000Z';

export async function verifyInboxStoreContract(makeStore: InboxStoreFactory): Promise<void> {
  // 積む・配る・消す
  {
    const store = await makeStore();
    await putAt(store, 'evt-2', T2, '2件目');
    await putAt(store, 'evt-1', T1, '1件目');
    const claimed = await store.claimPending();
    expectEqual('古い順', 'claimPending は at の古い順', ids(claimed), ['evt-1', 'evt-2']);
    if (!claimed.every((entry) => entry.deliveries === 1)) {
      fail('古い順', `初回の claimPending は deliveries が 1: ${show(claimed)}`);
    }
  }
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1);
    await store.remove('evt-1');
    expectEqual('remove', 'remove したものは返らない', await store.claimPending(), []);
    try {
      await store.remove('しらない');
    } catch (error) {
      fail('remove', `無い id の remove が投げた: ${String(error)}`);
    }
  }
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1);
    const first = await store.claimPending();
    const second = await store.claimPending();
    expectEqual('deliveries', '1回目の配達回数', first[0]?.deliveries, 1);
    expectEqual('deliveries', '2回目の配達回数', second[0]?.deliveries, 2);
  }
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1, 'もとの本文');
    await store.claimPending();
    await putAt(store, 'evt-1', T1, '直した本文');
    const pending = await store.claimPending();
    expectEqual('再 put', '同じ id の put し直しで配達回数が戻らない', pending[0]?.deliveries, 2);
    expectEqual('再 put', '本文は差し替わる', textOf(pending[0]!.event), '直した本文');
  }
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1, '人間の発言');
    const payload = { deep: { nested: [1, 2, 3] }, note: '日本語も' };
    await store.put({ type: 'external', id: 'evt-2', at: T2, source: 'webhook', payload }, T2);
    const pending = await store.claimPending();
    const humanEntry = pending.find((entry) => entry.event.id === 'evt-1');
    const externalEntry = pending.find((entry) => entry.event.id === 'evt-2');
    expectEqual('往復', 'human_message の text', textOf(humanEntry!.event), '人間の発言');
    expectEqual(
      '往復',
      'external の payload',
      (externalEntry?.event as { payload?: unknown } | undefined)?.payload,
      payload,
    );
  }

  // pending は読むだけで配達回数を進めない（#358）
  {
    const store = await makeStore();
    expectEqual('pending', '0件のときは oldestAt を作らない', await store.pending(), { count: 0 });
    await putAt(store, 'evt-2', T2);
    await putAt(store, 'evt-1', T1);
    expectEqual('pending', '件数といちばん古い時刻', await store.pending(), {
      count: 2,
      oldestAt: T1,
    });
  }
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1);
    await store.pending();
    await store.pending();
    await store.pending();
    expectEqual(
      'pending',
      'pending() を何度呼んでも deliveries は動かない',
      (await store.claimPending())[0]?.deliveries,
      1,
    );
  }

  // peekPending は本文まで返すが配達回数を進めない（#783）
  {
    const store = await makeStore();
    await putAt(store, 'evt-2', T2, '2件目');
    await putAt(store, 'evt-1', T1, '1件目');
    const { entries } = await store.peekPending();
    expectEqual('peekPending', 'claimPending と同じ古い順', ids(entries), ['evt-1', 'evt-2']);
    expectEqual('peekPending', '本文まで返す', textOf(entries[0]!.event), '1件目');
    if (!entries.every((entry) => entry.deliveries === 0)) {
      fail('peekPending', `配達回数を進めない: ${show(entries)}`);
    }
  }
  {
    const store = await makeStore();
    expectEqual('peekPending', '0件なら読めない行も無い', await store.peekPending(), {
      entries: [],
      unreadable: [],
    });
  }
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1);
    await store.peekPending();
    await store.peekPending();
    expectEqual(
      'peekPending',
      'peekPending() の後の claimPending() の deliveries は 1',
      (await store.claimPending())[0]?.deliveries,
      1,
    );
  }

  // removeMany（#972）
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1, '1件目');
    await putAt(store, 'evt-2', T2, '2件目');
    await putAt(store, 'evt-3', T3, '3件目');
    const removed = await store.removeMany(['evt-1', 'evt-3']);
    expectEqual('removeMany', '実際に消えた id を返す', [...removed].sort(), ['evt-1', 'evt-3']);
    expectEqual(
      'removeMany',
      '残りは消していない行だけ',
      ids((await store.peekPending()).entries),
      ['evt-2'],
    );
  }
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1);
    expectEqual(
      'removeMany',
      '存在しない id は戻り値に含めない',
      await store.removeMany(['evt-1', '居ない']),
      ['evt-1'],
    );
  }
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1);
    expectEqual(
      'removeMany',
      '重複した id は戻り値にも1回しか現れない',
      await store.removeMany(['evt-1', 'evt-1']),
      ['evt-1'],
    );
  }
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1);
    expectEqual('removeMany', '空配列は何も消さず空配列を返す', await store.removeMany([]), []);
    expectEqual('removeMany', '空配列の後も未読は残る', await store.pending(), {
      count: 1,
      oldestAt: T1,
    });
  }
  {
    const store = await makeStore();
    await putAt(store, 'evt-1', T1);
    await store.removeMany(['evt-1']);
    expectEqual('removeMany', '消えた行は claimPending で返らない', await store.claimPending(), []);
    expectEqual(
      'removeMany',
      '消えた行は peekPending でも返らない',
      (await store.peekPending()).entries,
      [],
    );
  }

  // put の入口の検査
  {
    const store = await makeStore();
    const badEvent = {
      type: 'human_message',
      id: 'evt-bad',
      at: 'not-a-date',
      conversationId: 'c',
      text: 'x',
    } as unknown as InboxEvent;
    let thrown = false;
    try {
      await store.put(badEvent, 'not-a-date');
    } catch {
      thrown = true;
    }
    if (!thrown) fail('put の検査', 'at が ISO 8601 でない event を拒まない（throw しない）');
  }

  // 外側の at は Z 付きへ正規化して返す。event の中の at は触らない
  {
    const store = await makeStore();
    const offset = '2026-08-12T09:00:00+09:00';
    const utc = '2026-08-12T00:00:00.000Z';
    await putAt(store, 'evt-a', offset);
    const [peeked] = (await store.peekPending()).entries;
    expectEqual('外側の at', 'peekPending の at は Z', peeked?.at, utc);
    expectEqual('外側の at', 'event の中の at は触らない', peeked?.event.at, offset);
    expectEqual('外側の at', 'pending().oldestAt は Z', (await store.pending()).oldestAt, utc);
    const [claimed] = await store.claimPending();
    expectEqual('外側の at', 'claimPending の at は Z', claimed?.at, utc);
    expectEqual(
      '外側の at',
      'claimPending でも event の中の at は触らない',
      claimed?.event.at,
      offset,
    );
  }
  {
    const store = await makeStore();
    let thrown = false;
    try {
      await store.put(human('evt-a', '2026-08-12T09:00:00+09:00', 'a'), 'not-a-date');
    } catch {
      thrown = true;
    }
    if (!thrown) fail('外側の at', '読めない時刻の put を拒まない（throw しない）');
    expectEqual('外側の at', '拒んだ put は何も保存しない', (await store.pending()).count, 0);
  }

  // 同着の2次キー: 再配達された行は末尾へ回る
  {
    const at = '2026-01-01T00:00:00.000Z';
    const store = await makeStore();
    await putAt(store, 'evt-a', at, 'A');
    await putAt(store, 'evt-b', at, 'B');
    await putAt(store, 'evt-a', at, 'A');
    expectEqual(
      '同着の並び',
      '再配達（同じ at）の後、peekPending() は (B, A)',
      ids((await store.peekPending()).entries),
      ['evt-b', 'evt-a'],
    );
  }
  {
    const at = '2026-01-01T00:00:00.000Z';
    const store = await makeStore();
    await putAt(store, 'evt-a', at, 'A');
    await putAt(store, 'evt-b', at, 'B');
    await putAt(store, 'evt-a', at, 'A');
    expectEqual(
      '同着の並び',
      '再配達（同じ at）の後、claimPending() も (B, A)',
      ids(await store.claimPending()),
      ['evt-b', 'evt-a'],
    );
  }

  // 同着の並びは remove と再 put を挟んでも、行の位置ではなく積んだ順に従う（#4059）
  for (const via of ['claimPending', 'peekPending'] as const) {
    const at = '2026-01-01T00:00:00.000Z';
    const name = (n: number): string => `evt-${String(n).padStart(3, '0')}`;
    const store = await makeStore();
    for (let i = 0; i < 40; i += 1) await putAt(store, name(i), at);
    await store.claimPending();
    await store.remove(name(36));
    await store.claimPending();
    await putAt(store, 'evt-new', at);
    await putAt(store, name(0), at);

    const expected = [
      ...Array.from({ length: 35 }, (_, i) => name(i + 1)),
      name(37),
      name(38),
      name(39),
      'evt-new',
      name(0),
    ];
    const actual =
      via === 'claimPending'
        ? ids(await store.claimPending())
        : ids((await store.peekPending()).entries);
    expectEqual(
      '同着の並び',
      `remove と再 put の後の ${via} は再 put した合図が末尾`,
      actual,
      expected,
    );
  }
}

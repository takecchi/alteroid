import { describe, expect, it } from 'vitest';

import {
  bySpeaker,
  collectConversations,
  conversationMessages,
  humanExchanges,
  reachedStart,
  readConversationWindow,
  searchExchanges,
  toMessage,
} from './conversation.js';
import type { Exchange } from './conversation.js';
import type { JournalEntry } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * `conversation.ts` — 日誌の並びを会話へ畳み直す規則の純粋関数。
 *
 * **`collectConversations` は `apps/daemon/src/app.ts` の `GET /conversations`
 * と同じ結果を出すことを固定する。** そちらは状態を持たない同じ規則を持っており
 * （`app.ts:884-916` あたり）、ここが違う結果を返すと、クローンの道具（同じ規則を
 * 使う `conversation_read`）と人間の Web UI が別の会話一覧を見ることになる。
 */

function exchange(overrides: Partial<Exchange> & Pick<Exchange, 'id' | 'at'>): Exchange {
  return {
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: '本文',
    conversationId: undefined,
    ...overrides,
  };
}

describe('humanExchanges', () => {
  it('type: exchange かつ with: human だけを残す（並び順は保つ）', () => {
    const entries: JournalEntry[] = [
      exchange({ id: 'e1', at: '2026-08-20T00:03:00.000Z', conversationId: 'c1' }),
      exchange({
        id: 'e2',
        at: '2026-08-20T00:02:00.000Z',
        with: 'manager',
        conversationId: 'c1',
      }),
      { type: 'decision', id: 'd1', at: '2026-08-20T00:01:30.000Z', decision: 'x', grounds: 'y' },
      exchange({ id: 'e3', at: '2026-08-20T00:01:00.000Z', with: 'self', conversationId: 'c1' }),
      exchange({ id: 'e4', at: '2026-08-20T00:00:00.000Z', conversationId: 'c1' }),
    ];

    const result = humanExchanges(entries);

    expect(result.map((e) => e.id)).toEqual(['e1', 'e4']);
  });
});

describe('bySpeaker', () => {
  const exchanges: Exchange[] = [
    exchange({ id: 'in1', at: '2026-08-20T00:00:00.000Z', role: 'inbound' }),
    exchange({ id: 'out1', at: '2026-08-20T00:01:00.000Z', role: 'outbound' }),
  ];

  it('both は絞らない', () => {
    expect(bySpeaker(exchanges, 'both')).toEqual(exchanges);
  });

  it('human は inbound だけ', () => {
    expect(bySpeaker(exchanges, 'human').map((e) => e.id)).toEqual(['in1']);
  });

  it('clone は outbound だけ', () => {
    expect(bySpeaker(exchanges, 'clone').map((e) => e.id)).toEqual(['out1']);
  });
});

describe('collectConversations', () => {
  it('新しい順のまま畳む（先に出会うのが最新発言）', () => {
    // 日誌は新しい順で来る。同じ会話 c1 の2発言、別会話 c2 の1発言。
    const entries: JournalEntry[] = [
      exchange({
        id: 'e3',
        at: '2026-08-20T00:03:00.000Z',
        conversationId: 'c2',
        text: 'c2の発言',
      }),
      exchange({ id: 'e2', at: '2026-08-20T00:02:00.000Z', conversationId: 'c1', text: '最新' }),
      exchange({ id: 'e1', at: '2026-08-20T00:01:00.000Z', conversationId: 'c1', text: '最初' }),
    ];

    const result = collectConversations(entries);

    // c2 が先に出会うので先頭（新しい順）。
    expect(result.map((c) => c.conversationId)).toEqual(['c2', 'c1']);
  });

  it('startedAt は古い方へ更新される。updatedAt は最初に出会った時刻のまま', () => {
    const entries: JournalEntry[] = [
      exchange({ id: 'e2', at: '2026-08-20T00:02:00.000Z', conversationId: 'c1' }),
      exchange({ id: 'e1', at: '2026-08-20T00:01:00.000Z', conversationId: 'c1' }),
    ];

    const result = collectConversations(entries);

    expect(result).toHaveLength(1);
    expect(result).toMatchObject([
      { updatedAt: '2026-08-20T00:02:00.000Z', startedAt: '2026-08-20T00:01:00.000Z', messages: 2 },
    ]);
  });

  it('conversationId が無い発言は落ちる', () => {
    const entries: JournalEntry[] = [
      exchange({ id: 'e1', at: '2026-08-20T00:01:00.000Z', conversationId: undefined }),
    ];

    expect(collectConversations(entries)).toEqual([]);
  });

  it('with: manager と self は混ざらない（会話として立たない）', () => {
    const entries: JournalEntry[] = [
      exchange({ id: 'e1', at: '2026-08-20T00:01:00.000Z', with: 'manager', conversationId: 'c1' }),
      exchange({ id: 'e2', at: '2026-08-20T00:02:00.000Z', with: 'self', conversationId: 'c2' }),
      exchange({ id: 'e3', at: '2026-08-20T00:03:00.000Z', with: 'human', conversationId: 'c3' }),
    ];

    const result = collectConversations(entries);

    expect(result.map((c) => c.conversationId)).toEqual(['c3']);
  });

  // **この preview は `GET /conversations` がそのまま人間へ返している値である**
  // （`app.ts` から移設した。移設で表示が変わらないよう、長さも切り方もそのまま）。
  it('preview は改行を潰し80文字で切る（人間の口へ出ている値と同じ形）', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'e1',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        text: 'x'.repeat(200),
      }),
    ];

    const result = collectConversations(entries);

    expect(result).toHaveLength(1);
    const preview = result.map((c) => c.preview).join('');
    // **長さそのものを固定する。** `length < 200` と `startsWith(80文字)` の組では、
    // 切る位置を 80 から 100 へ動かしても通ってしまう（人間の画面に出ている値が
    // 移設で変わったことに気づけない）。ここは移設の等価性を担保する歯なので、
    // 「80 で切る」を字義どおり書く。
    expect(preview).toBe(`${'x'.repeat(80)}…`);
  });
});

describe('conversationMessages', () => {
  it('古い順に直す。他の会話は混ざらない', () => {
    const entries: JournalEntry[] = [
      exchange({ id: 'e3', at: '2026-08-20T00:03:00.000Z', conversationId: 'c1', text: '3番目' }),
      exchange({
        id: 'other',
        at: '2026-08-20T00:02:30.000Z',
        conversationId: 'c2',
        text: '別会話',
      }),
      exchange({ id: 'e2', at: '2026-08-20T00:02:00.000Z', conversationId: 'c1', text: '2番目' }),
      exchange({ id: 'e1', at: '2026-08-20T00:01:00.000Z', conversationId: 'c1', text: '1番目' }),
    ];

    const messages = conversationMessages(entries, 'c1');

    expect(messages.map((m) => m.id)).toEqual(['e1', 'e2', 'e3']);
    expect(messages.map((m) => m.text)).toEqual(['1番目', '2番目', '3番目']);
  });
});

describe('searchExchanges', () => {
  it('大文字小文字を区別しない部分一致で探す', () => {
    const exchanges: Exchange[] = [
      exchange({ id: 'a', at: '2026-08-20T00:00:00.000Z', text: 'Hello World' }),
      exchange({ id: 'b', at: '2026-08-20T00:01:00.000Z', text: 'なにも関係ない' }),
    ];

    expect(searchExchanges(exchanges, 'hello').map((m) => m.id)).toEqual(['a']);
    expect(searchExchanges(exchanges, 'HELLO').map((m) => m.id)).toEqual(['a']);
  });

  it('渡された並びのまま返す（順序を変えない）', () => {
    const exchanges: Exchange[] = [
      exchange({ id: 'a', at: '2026-08-20T00:01:00.000Z', text: '当たり1' }),
      exchange({ id: 'b', at: '2026-08-20T00:00:00.000Z', text: '当たり2' }),
    ];

    expect(searchExchanges(exchanges, '当たり').map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('toMessage', () => {
  it('exchange を発言1件へそのまま落とす', () => {
    const source = exchange({
      id: 'e1',
      at: '2026-08-20T00:00:00.000Z',
      role: 'outbound',
      text: '本文そのもの',
      conversationId: 'c1',
    });

    expect(toMessage(source)).toEqual({
      id: 'e1',
      at: '2026-08-20T00:00:00.000Z',
      role: 'outbound',
      text: '本文そのもの',
      conversationId: 'c1',
    });
  });
});

describe('reachedStart', () => {
  it('返った件数が scan を下回れば先頭に届いている', () => {
    expect(reachedStart(1999, 2000)).toBe(true);
  });

  it('ちょうど scan 件のときは、まだあるかもしれない側（届いていない）へ倒す', () => {
    expect(reachedStart(2000, 2000)).toBe(false);
  });

  it('0件でも scan を下回っていれば届いている', () => {
    expect(reachedStart(0, 2000)).toBe(true);
  });
});

/**
 * `readConversationWindow` — `GET /conversations` / `GET /conversations/:id` /
 * `conversation_read` が共有する、唯一の窓の組み立て（issue #418）。
 *
 * **これが #418 の症状そのものを再現・固定する歯である。** 「絞りが効いている」
 * だけでは弱い（`with` を返却後に絞る旧実装でも、`scan` が十分大きければ同じ
 * 結果になる）。ここで測るのは**窓に食われないこと** — `scan` を症状が出るほど
 * 小さくし、manager との往復を `scan` より多く積んでも、human の会話が消えない
 * ことを確かめる。
 */
describe('readConversationWindow（issue #418）', () => {
  it('manager の往復を scan より多く積んでも、human の会話は窓に食われない', async () => {
    const stores = createMemoryStores();
    // human を先に3件積む（古い側）。
    for (let i = 0; i < 3; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `human-${i}`,
        conversationId: 'conv-1',
      });
    }
    // manager / self を、human よりずっと多く（scan を超える数）積む（新しい側）。
    for (let i = 0; i < 50; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: i % 2 === 0 ? 'manager' : 'self',
        role: 'inbound',
        text: `noise-${i}`,
      });
    }

    // scan=3 という、症状が出るほど小さい窓。
    // 旧実装（`types: ['exchange']` だけで窓を切ってから `with` を絞る）だと、
    // 新しい3件はすべて manager/self なので、ここは0件になっていた。
    const entries = await readConversationWindow(stores.journal, { scan: 3 });

    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.type === 'exchange' && entry.with === 'human')).toBe(
      true,
    );
    expect(entries.map((entry) => (entry as Exchange).text)).toEqual([
      'human-2',
      'human-1',
      'human-0',
    ]);
  });

  it("types: ['exchange'] と with: ['human'] を渡す（with が limit より前で効くための前提）", async () => {
    const calls: unknown[] = [];
    const stub = {
      list: async (query?: unknown) => {
        calls.push(query);
        return [];
      },
    };

    await readConversationWindow(stub, { scan: 42 });

    expect(calls).toEqual([{ limit: 42, types: ['exchange'], with: ['human'] }]);
  });

  it('since / until が指定されたときだけ渡す（未指定と空文字を混同しない）', async () => {
    const calls: unknown[] = [];
    const stub = {
      list: async (query?: unknown) => {
        calls.push(query);
        return [];
      },
    };

    await readConversationWindow(stub, {
      scan: 10,
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-20T00:00:00.000Z',
    });

    expect(calls).toEqual([
      {
        limit: 10,
        types: ['exchange'],
        with: ['human'],
        since: '2026-08-01T00:00:00.000Z',
        until: '2026-08-20T00:00:00.000Z',
      },
    ]);

    await readConversationWindow(stub, { scan: 10 });
    expect(calls[1]).not.toHaveProperty('since');
    expect(calls[1]).not.toHaveProperty('until');
  });
});

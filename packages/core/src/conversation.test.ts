import { describe, expect, it } from 'vitest';

import {
  bySpeaker,
  collectConversations,
  computeSupersededIds,
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
 * （`'/conversations'` ルート）と同じ結果を出すことを固定する。** そちらは状態を
 * 持たない同じ規則を持っており、ここが違う結果を返すと、クローンの道具（同じ規則を
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

/**
 * `supersedes` による畳み込み（チャットの「メッセージを編集する」機能）。
 *
 * **`computeSupersededIds` を直接測る歯（防御的条件）と、
 * `conversationMessages` / `collectConversations` を通して測る歯（実際の
 * 使われ方）の両方を置く。** 前者は「隠す・隠さないの境界そのもの」を、
 * 後者は「その境界が2つの呼び出し口で同じ結果になること」を保証する
 * ——別々に測らないと、境界だけ正しくて配線を忘れる／配線だけ揃っていて
 * 境界が緩い、のどちらかを見落とす。
 */
describe('computeSupersededIds（畳み込みの境界そのもの）', () => {
  it('T が見つからない（scan の窓の外）ときは何も隠さない', () => {
    const chronological: Exchange[] = [
      exchange({
        id: 'edit',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        supersedes: 'not-in-window',
      }),
    ];

    expect(computeSupersededIds(chronological)).toEqual(new Map());
  });

  it('T が E より後ろにある（順序が逆）ときは何も隠さない', () => {
    const chronological: Exchange[] = [
      exchange({
        id: 'edit',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        supersedes: 'later',
      }),
      exchange({ id: 'later', at: '2026-08-20T00:02:00.000Z', conversationId: 'c1' }),
    ];

    expect(computeSupersededIds(chronological)).toEqual(new Map());
  });

  it('T の会話が E と違うときは何も隠さない', () => {
    const chronological: Exchange[] = [
      exchange({ id: 'other-conv', at: '2026-08-20T00:00:00.000Z', conversationId: 'c2' }),
      exchange({
        id: 'edit',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        supersedes: 'other-conv',
      }),
    ];

    expect(computeSupersededIds(chronological)).toEqual(new Map());
  });

  it('見つかり・順序も会話も正しいときは、T 以上 E 未満を隠す', () => {
    const chronological: Exchange[] = [
      exchange({ id: 'h1', at: '2026-08-20T00:00:00.000Z', conversationId: 'c1' }),
      exchange({
        id: 'c1r',
        at: '2026-08-20T00:00:30.000Z',
        conversationId: 'c1',
        role: 'outbound',
      }),
      exchange({
        id: 'h2',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        supersedes: 'h1',
      }),
    ];

    expect(computeSupersededIds(chronological)).toEqual(
      new Map([
        ['h1', 'h2'],
        ['c1r', 'h2'],
      ]),
    );
  });
});

describe('conversationMessages（supersedes を畳む）', () => {
  it('単純な編集: 旧発言とその応答が畳まれ、編集後の発言が残る', () => {
    // journal 順（新しい順）で渡す — 実際の呼び出しと同じ形。
    const entries: JournalEntry[] = [
      exchange({
        id: 'c2',
        at: '2026-08-20T00:03:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
        text: '編集後への返答',
      }),
      exchange({
        id: 'h2',
        at: '2026-08-20T00:02:00.000Z',
        conversationId: 'c1',
        text: '編集後の発言',
        supersedes: 'h1',
      }),
      exchange({
        id: 'c1r',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
        text: '旧発言への返答',
      }),
      exchange({
        id: 'h1',
        at: '2026-08-20T00:00:00.000Z',
        conversationId: 'c1',
        text: '旧発言',
      }),
    ];

    const messages = conversationMessages(entries, 'c1');

    expect(messages.map((m) => m.id)).toEqual(['h2', 'c2']);
    expect(messages.map((m) => m.text)).toEqual(['編集後の発言', '編集後への返答']);
    // 編集後の発言は supersedes をそのまま持つ。
    expect(messages[0]).toMatchObject({ id: 'h2', supersedes: 'h1' });
  });

  it('編集の連鎖（編集をさらに編集）が正しく畳まれる', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'c3',
        at: '2026-08-20T00:05:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
      }),
      exchange({
        id: 'h3',
        at: '2026-08-20T00:04:00.000Z',
        conversationId: 'c1',
        text: '2度目の編集',
        supersedes: 'h2',
      }),
      exchange({
        id: 'c2',
        at: '2026-08-20T00:03:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
      }),
      exchange({
        id: 'h2',
        at: '2026-08-20T00:02:00.000Z',
        conversationId: 'c1',
        text: '1度目の編集',
        supersedes: 'h1',
      }),
      exchange({
        id: 'c1r',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
      }),
      exchange({
        id: 'h1',
        at: '2026-08-20T00:00:00.000Z',
        conversationId: 'c1',
        text: '最初の発言',
      }),
    ];

    // 既定（畳んだ後）は最後の編集とその返答だけが残る。
    const visible = conversationMessages(entries, 'c1');
    expect(visible.map((m) => m.id)).toEqual(['h3', 'c3']);

    // 畳まれた分も含めれば、和集合として全4件が隠れている理由を持つ。
    const all = conversationMessages(entries, 'c1', { includeSuperseded: true });
    expect(all.map((m) => m.id)).toEqual(['h1', 'c1r', 'h2', 'c2', 'h3', 'c3']);
    expect(all.map((m) => m.supersededBy)).toEqual(['h2', 'h2', 'h3', 'h3', undefined, undefined]);
  });

  it('編集の後ろに続く往復は残る（畳まれるのは旧発言から編集の直前まで）', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'c3',
        at: '2026-08-20T00:05:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
      }),
      exchange({
        id: 'h3',
        at: '2026-08-20T00:04:00.000Z',
        conversationId: 'c1',
        text: '編集ではない、続きの発言',
      }),
      exchange({
        id: 'c2',
        at: '2026-08-20T00:03:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
      }),
      exchange({
        id: 'h2',
        at: '2026-08-20T00:02:00.000Z',
        conversationId: 'c1',
        text: '編集後の発言',
        supersedes: 'h1',
      }),
      exchange({
        id: 'c1r',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
      }),
      exchange({ id: 'h1', at: '2026-08-20T00:00:00.000Z', conversationId: 'c1', text: '旧発言' }),
    ];

    const messages = conversationMessages(entries, 'c1');

    // h1 / c1r（旧発言とその応答）だけが畳まれ、h2 以降の往復はすべて残る。
    expect(messages.map((m) => m.id)).toEqual(['h2', 'c2', 'h3', 'c3']);
  });

  it('対象が窓の外にあるときに何も畳まれず落ちない', () => {
    // h1（supersedes の対象）が scan の窓に入っておらず、この会話には h2 しか無い。
    const entries: JournalEntry[] = [
      exchange({
        id: 'c2',
        at: '2026-08-20T00:02:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
      }),
      exchange({
        id: 'h2',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        text: '編集後の発言（旧発言は窓の外）',
        supersedes: 'h1-not-in-window',
      }),
    ];

    expect(() => conversationMessages(entries, 'c1')).not.toThrow();
    const messages = conversationMessages(entries, 'c1');
    expect(messages.map((m) => m.id)).toEqual(['h2', 'c2']);
  });

  it('日誌のレコード自体は一切変わらない（射影だけが畳む）', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'c2',
        at: '2026-08-20T00:02:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
      }),
      exchange({
        id: 'h2',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        text: '編集後の発言',
        supersedes: 'h1',
      }),
      exchange({
        id: 'c1r',
        at: '2026-08-20T00:00:30.000Z',
        conversationId: 'c1',
        role: 'outbound',
      }),
      exchange({ id: 'h1', at: '2026-08-20T00:00:00.000Z', conversationId: 'c1', text: '旧発言' }),
    ];
    // 個々のエントリを凍結する — この関数群が1バイトでも書き換えようとすれば
    // strict mode で即座に例外になる（追記専用の記録に対する射影であることの歯）。
    for (const entry of entries) Object.freeze(entry);
    Object.freeze(entries);
    const before = JSON.stringify(entries);

    conversationMessages(entries, 'c1');
    conversationMessages(entries, 'c1', { includeSuperseded: true });
    collectConversations(entries);

    expect(JSON.stringify(entries)).toBe(before);
  });
});

describe('collectConversations（supersedes を畳んだ後で preview / messages を数える）', () => {
  it('畳んだ後の件数・最新発言で preview / messages / updatedAt を数える', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'c2',
        at: '2026-08-20T00:03:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
        text: '編集後への返答',
      }),
      exchange({
        id: 'h2',
        at: '2026-08-20T00:02:00.000Z',
        conversationId: 'c1',
        text: '編集後の発言',
        supersedes: 'h1',
      }),
      exchange({
        id: 'c1r',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
        text: '旧発言への返答',
      }),
      exchange({
        id: 'h1',
        at: '2026-08-20T00:00:00.000Z',
        conversationId: 'c1',
        text: '旧発言（一覧の抜粋に出てはいけない）',
      }),
    ];

    const result = collectConversations(entries);

    expect(result).toHaveLength(1);
    // 畳む前なら messages は4件・startedAt は h1・preview は「旧発言…」になりうるが、
    // 畳んだ後は h2/c2 の2件だけが残る。
    expect(result[0]).toMatchObject({
      conversationId: 'c1',
      startedAt: '2026-08-20T00:02:00.000Z',
      updatedAt: '2026-08-20T00:03:00.000Z',
      messages: 2,
      preview: '編集後への返答',
    });
  });
});

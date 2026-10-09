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

/** 孤立サロゲート（高だけ・低だけ）。`isWellFormed()` は tsconfig の lib に無いので直接探す。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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
    // `length < 200` と `startsWith` の組では、切る位置を動かしても通ってしまう。
    expect(preview).toBe(`${'x'.repeat(80)}…`);
  });

  it('preview の切り口が絵文字をまたいでも、孤立サロゲートを残さない', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'e1',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        text: `${'あ'.repeat(79)}😀😀`,
      }),
    ];

    const preview = collectConversations(entries)
      .map((c) => c.preview)
      .join('');

    expect(preview).toBe(`${'あ'.repeat(79)}…`);
    expect(LONE_SURROGATE.test(preview)).toBe(false);
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

describe('readConversationWindow（issue #418）', () => {
  it('manager の往復を scan より多く積んでも、human の会話は窓に食われない', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 3; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `human-${i}`,
        conversationId: 'conv-1',
      });
    }
    for (let i = 0; i < 50; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: i % 2 === 0 ? 'manager' : 'self',
        role: 'inbound',
        text: `noise-${i}`,
      });
    }

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

    const visible = conversationMessages(entries, 'c1');
    expect(visible.map((m) => m.id)).toEqual(['h3', 'c3']);

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

    expect(messages.map((m) => m.id)).toEqual(['h2', 'c2', 'h3', 'c3']);
  });

  it('対象が窓の外にあるときに何も畳まれず落ちない', () => {
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
    expect(result[0]).toMatchObject({
      conversationId: 'c1',
      startedAt: '2026-08-20T00:02:00.000Z',
      updatedAt: '2026-08-20T00:03:00.000Z',
      messages: 2,
      preview: '編集後への返答',
    });
  });
});

describe('collectConversations（失敗の知らせは一覧の題にしない）', () => {
  const failureNotice = 'この発言には返せなかった（ターンが失敗した）。';

  it('最後が失敗の知らせでも、題は失敗ではない最後の発言から取る', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'f',
        at: '2026-08-20T00:02:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
        text: failureNotice,
        turnFailure: 'failed',
      }),
      exchange({ id: 'h', at: '2026-08-20T00:01:00.000Z', conversationId: 'c1', text: '来週の件' }),
    ];

    expect(collectConversations(entries)).toMatchObject([
      { preview: '来週の件', messages: 2, updatedAt: '2026-08-20T00:02:00.000Z' },
    ]);
  });

  it('文面が同じでも、印が無ければ題から外さない（文面では見分けない）', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'f',
        at: '2026-08-20T00:02:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
        text: failureNotice,
      }),
      exchange({ id: 'h', at: '2026-08-20T00:01:00.000Z', conversationId: 'c1', text: '来週の件' }),
    ];

    expect(collectConversations(entries)[0]?.preview).toBe(failureNotice);
  });

  it('知らせしか無い会話は、知らせを題にする（題が空にならない）', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'f',
        at: '2026-08-20T00:02:00.000Z',
        conversationId: 'c1',
        role: 'outbound',
        text: failureNotice,
        turnFailure: 'held',
      }),
    ];

    expect(collectConversations(entries)[0]?.preview).toBe(failureNotice);
  });

  it('toMessage は印を写す（付いていなければ欄ごと無い）', () => {
    const marked = exchange({
      id: 'f',
      at: '2026-08-20T00:02:00.000Z',
      role: 'outbound',
      turnFailure: 'failed',
    });
    const plain = exchange({ id: 'p', at: '2026-08-20T00:01:00.000Z' });

    expect(toMessage(marked).turnFailure).toBe('failed');
    expect('turnFailure' in toMessage(plain)).toBe(false);
    expect('turnFailureKind' in toMessage(plain)).toBe(false);
  });

  it('toMessage は失敗の種別を写す。種別を持たない古い失敗行は other（文面から読み替えない）', () => {
    const quota = exchange({
      id: 'q',
      at: '2026-08-20T00:02:00.000Z',
      role: 'outbound',
      turnFailure: 'failed',
      turnFailureKind: 'quota',
    });
    const legacy = exchange({
      id: 'l',
      at: '2026-08-20T00:01:00.000Z',
      role: 'outbound',
      text: '401 authentication quota',
      turnFailure: 'failed',
    });

    expect(toMessage(quota).turnFailureKind).toBe('quota');
    expect(toMessage(legacy).turnFailureKind).toBe('other');
  });

  it('toMessage は clientMessageId を写す（付いていなければ欄ごと無い。Issue #3203）', () => {
    const named = exchange({
      id: 'n',
      at: '2026-08-20T00:01:00.000Z',
      clientMessageId: 'cmid-1',
    });
    const plain = exchange({ id: 'p', at: '2026-08-20T00:01:00.000Z' });

    expect(toMessage(named).clientMessageId).toBe('cmid-1');
    expect('clientMessageId' in toMessage(plain)).toBe(false);
  });
});

describe('collectConversations: 添付だけの発言の抜粋', () => {
  const ref = { id: 'a', name: 'x.png', mediaType: 'image/png', size: 1, sha256: 's' };
  it('本文が空で添付がある発言が題になるときは、件数を抜粋にする', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'e1',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        text: '',
        attachments: [ref, ref],
      }),
    ];
    expect(collectConversations(entries)[0]?.preview).toBe('[添付 2 件]');
  });
  it('本文があればそれを抜粋にする', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'e1',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        text: 'ひとこと',
        attachments: [ref],
      }),
    ];
    expect(collectConversations(entries)[0]?.preview).toBe('ひとこと');
  });
});

describe('会話の一覧の cursor の符号化（#3644）', () => {
  it('encode した継続点を decode で取り戻せる', async () => {
    const { decodeConversationCursor, encodeConversationCursor } =
      await import('./conversation.js');
    const cursor = { id: 'jrn-1', at: '2026-01-01T00:00:00.000Z' };
    expect(decodeConversationCursor(encodeConversationCursor(cursor))).toEqual(cursor);
  });

  it.each([
    'not-a-cursor',
    Buffer.from('[]', 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ id: '', at: 'x' }), 'utf8').toString('base64url'),
    Buffer.from(JSON.stringify({ id: 'a' }), 'utf8').toString('base64url'),
    Buffer.from('null', 'utf8').toString('base64url'),
  ])('読めない cursor（%s）は null', async (raw) => {
    const { decodeConversationCursor } = await import('./conversation.js');
    expect(decodeConversationCursor(raw)).toBeNull();
  });
});

describe('取り下げた発言は、一覧の見出しにも件数にも入れない（#4357）', () => {
  it('collectConversations: 取り下げた発言を飛ばして題を取り、件数に数えない', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'e2',
        at: '2026-08-20T00:02:00.000Z',
        conversationId: 'c1',
        text: '取り下げた発言',
        clientMessageId: 'cm-2',
      }),
      exchange({
        id: 'e1',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        text: '残る発言',
        clientMessageId: 'cm-1',
      }),
    ];
    expect(collectConversations(entries)).toMatchObject([{ preview: '取り下げた発言', messages: 2 }]);
    expect(collectConversations(entries, undefined, new Set(['cm-2']))).toMatchObject([
      { preview: '残る発言', messages: 1 },
    ]);
  });

  it('collectConversations: 全部取り下げたら題は空で、件数は 0', () => {
    const entries: JournalEntry[] = [
      exchange({
        id: 'e1',
        at: '2026-08-20T00:01:00.000Z',
        conversationId: 'c1',
        text: '取り下げた発言',
        clientMessageId: 'cm-1',
      }),
    ];
    expect(collectConversations(entries, undefined, new Set(['cm-1']))).toMatchObject([
      { preview: '', messages: 0 },
    ]);
  });

  it('readConversationPage: 日誌の取り下げの印を読んで、一覧の見出しと件数から外す', async () => {
    const { readConversationPage } = await import('./conversation.js');
    const { journal } = createMemoryStores();
    await journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '残る発言',
      conversationId: 'c1',
      clientMessageId: 'cm-1',
    });
    await journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '取り下げた発言',
      conversationId: 'c1',
      clientMessageId: 'cm-2',
    });
    await journal.append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: '取り下げた cm-2',
      conversationId: 'c1',
      withdrawnClientMessageId: 'cm-2',
    });
    const page = await readConversationPage(journal, { limit: 10, scan: 100 });
    expect(page.conversations).toMatchObject([
      { conversationId: 'c1', preview: '残る発言', messages: 1 },
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  encodeConversationCursor,
  readConversationPage,
  type ConversationCursor,
} from './conversation.js';
import type { JournalQuery } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function tools(stores: Stores) {
  const list = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const found = list.find((entry) => entry.name === name);
    if (!found) throw new Error(`道具 ${name} が無い`);
    const result = (await found.handler(args as never, {} as never)) as {
      content: { text: string }[];
    };
    return result.content.map((part) => part.text).join('');
  };
}

function spyOnList(stores: Stores): JournalQuery[] {
  const calls: JournalQuery[] = [];
  const original = stores.journal.list.bind(stores.journal);
  stores.journal.list = async (query?: JournalQuery) => {
    calls.push(query ?? {});
    return original(query);
  };
  return calls;
}

async function humanTurn(
  stores: Stores,
  conversationId: string,
  inboundText: string,
  outboundText: string,
): Promise<void> {
  await stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: inboundText,
    conversationId,
  });
  await stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'outbound',
    text: outboundText,
    conversationId,
  });
}

async function fillNoise(stores: Stores, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await stores.journal.append({
      type: 'exchange',
      with: i % 2 === 0 ? 'manager' : 'self',
      role: 'inbound',
      text: `[noise-${i}] マネージャーとの往復あるいは内部ターンの本文。`.repeat(3),
    });
  }
}

describe('conversation_read — 存在理由（人間の発言が manager/self のノイズに埋もれない）', () => {
  it('speaker: human を指定すると、会話の中身から人間自身の発言だけが取れる', async () => {
    const stores = createMemoryStores();
    await fillNoise(stores, 30);
    await humanTurn(stores, 'conv-1', '人間の質問です', 'クローンの返答です');
    await fillNoise(stores, 30);
    const call = tools(stores);

    const both = await call('conversation_read', { conversationId: 'conv-1' });
    expect(both).toContain('人間の質問です');
    expect(both).toContain('クローンの返答です');

    const humanOnly = await call('conversation_read', {
      conversationId: 'conv-1',
      speaker: 'human',
    });
    expect(humanOnly).toContain('人間の質問です');
    expect(humanOnly).not.toContain('クローンの返答です');
    expect(humanOnly).not.toContain('noise-');
  });

  it('q + speaker: human で、ノイズに埋もれた中から人間の発言だけを語で探せる', async () => {
    const stores = createMemoryStores();
    await fillNoise(stores, 40);
    await humanTurn(stores, 'conv-2', '独自の合言葉トマト', 'トマトについての返答');
    const call = tools(stores);

    const reply = await call('conversation_read', { q: 'トマト', speaker: 'human' });

    expect(reply).toContain('独自の合言葉トマト');
    expect(reply).not.toContain('トマトについての返答');
  });
});

describe('conversation_read — 窓が小さくても manager の往復に食われない（issue #418）', () => {
  it('scan より多い manager の往復を積んでも、既定より遥かに小さい scan で人間の会話が出る', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-1', '人間の質問です', 'クローンの返答です');
    for (let i = 0; i < 20; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: i % 2 === 0 ? 'manager' : 'self',
        role: 'inbound',
        text: `noise-${i}`,
      });
    }
    const call = tools(stores);

    const reply = await call('conversation_read', { conversationId: 'conv-1', scan: 3 });

    expect(reply).toContain('人間の質問です');
    expect(reply).toContain('クローンの返答です');
    expect(reply).not.toContain('この窓には無い');
  });
});

describe('conversation_read — since / until の伝播', () => {
  it('since / until が stores.journal.list へそのまま降りる', async () => {
    const stores = createMemoryStores();
    const calls = spyOnList(stores);
    await humanTurn(stores, 'conv-1', '質問', '返答');
    const call = tools(stores);

    await call('conversation_read', {
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-20T00:00:00.000Z',
      scan: 500,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-20T00:00:00.000Z',
      limit: 500,
      types: ['exchange'],
      with: ['human'],
    });
  });

  it('省略時は since / until を渡さない（未指定と空文字を混同しない）', async () => {
    const stores = createMemoryStores();
    const calls = spyOnList(stores);
    const call = tools(stores);

    await call('conversation_read', {});

    expect(calls[0]).not.toHaveProperty('since');
    expect(calls[0]).not.toHaveProperty('until');
  });
});

describe('conversation_read — since/until の正規化（issue #1515）', () => {
  it('秒を省いた since は toISOString へ正規化されてから stores.journal.list へ渡る', async () => {
    const stores = createMemoryStores();
    const calls = spyOnList(stores);
    const call = tools(stores);

    await call('conversation_read', { since: '2026-08-01T00:00Z' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.since).toBe('2026-08-01T00:00:00.000Z');
  });

  it('オフセット付きの until も toISOString（UTC）へ正規化されてから渡る', async () => {
    const stores = createMemoryStores();
    const calls = spyOnList(stores);
    const call = tools(stores);

    await call('conversation_read', { until: '2026-08-01T09:00:00+09:00' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.until).toBe('2026-08-01T00:00:00.000Z');
  });

  it('since に読めない文字列を渡すと、日誌を読まずに分かる言葉で断る', async () => {
    const stores = createMemoryStores();
    const calls = spyOnList(stores);
    const call = tools(stores);

    const reply = await call('conversation_read', { since: 'not-a-datetime' });

    expect(reply).toContain('since に渡された「not-a-datetime」は日時として読めない');
    expect(calls).toHaveLength(0);
  });

  it('until に読めない文字列を渡すと、日誌を読まずに分かる言葉で断る', async () => {
    const stores = createMemoryStores();
    const calls = spyOnList(stores);
    const call = tools(stores);

    const reply = await call('conversation_read', { until: 'not-a-datetime' });

    expect(reply).toContain('until に渡された「not-a-datetime」は日時として読めない');
    expect(calls).toHaveLength(0);
  });

  it.each(['foo 1', '2026-02-31'])(
    'since に「%s」を渡すと、日誌を読まずに受け付ける形の例つきで断る',
    async (since) => {
      const stores = createMemoryStores();
      const calls = spyOnList(stores);
      const call = tools(stores);

      const reply = await call('conversation_read', { since });

      expect(reply).toContain(`since に渡された「${since}」は日時として読めない`);
      expect(reply).toContain('2026-10-06T09:00:00+09:00');
      expect(calls).toHaveLength(0);
    },
  );
});

describe('conversation_read — 予算を超えたら省略した件数を言う', () => {
  it('黙って切らない（省略した件数が本文に出る）', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 60; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `[msg-${i}] ${'長い発言本文。'.repeat(40)}`,
        conversationId: 'conv-big',
      });
    }
    const call = tools(stores);

    const reply = await call('conversation_read', { conversationId: 'conv-big' });

    expect(reply).toContain('件は省略');
    expect(reply).toContain('conversation_read id=');
  });

  it('会話の中身は新しい側を残し、落としたのが古い側であることを言う', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 60; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `[msg-${i}] ${'長い発言本文。'.repeat(40)}`,
        conversationId: 'conv-big',
      });
    }
    const call = tools(stores);

    const reply = await call('conversation_read', { conversationId: 'conv-big' });

    expect(reply).toContain('[msg-59]');
    expect(reply).not.toContain('[msg-0]');
    expect(reply).toContain('古い側');
    // not.toContain で書かない: 存在しない文言を否定しても、どんな実装でも通ってしまうため
    expect(reply).toContain('until で窓を古い方へずらすこと');
    expect(reply).not.toMatch(/scan を増や(せば|して)/);
  });
});

describe('conversation_read — since で窓を切ったら「先頭に届いた」と言わない', () => {
  it('since より古い側に在る発言を「無い」と言わず、判定できないと言う', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-old', '独自の合言葉デプロイの件', '古い側の返答');
    const call = tools(stores);

    const reply = await call('conversation_read', {
      q: 'デプロイ',
      since: '2099-01-01T00:00:00.000Z',
    });

    expect(reply).not.toContain('に当たる発言は無い');
    expect(reply).toContain('判定できない');
    expect(reply).not.toContain('先頭に届いている');
    expect(reply).toContain('since');
  });

  it('since が無ければ従来どおり「先頭に届いている」と言える', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-1', '質問', '返答');
    const call = tools(stores);

    const reply = await call('conversation_read', { q: '当たらない語' });

    expect(reply).toContain('先頭に届いている');
    expect(reply).toContain('に当たる発言は無い');
  });
});

describe('conversation_read — 一覧が limit で切れたら、その件数と効く手を言う', () => {
  it('limit で落ちた会話の件数が本文に出て、limit を増やせと案内する', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 30; i += 1) {
      await humanTurn(stores, `conv-${i}`, `短い質問${i}`, `短い返答${i}`);
    }
    const call = tools(stores);

    const reply = await call('conversation_read', {});

    expect(reply).toContain('10 件');
    expect(reply).toContain('30 件');
    expect(reply).toContain('limit を増やせば出る');
    expect(reply).not.toContain('limit を増やしても出てこない');
  });

  it('limit に収まっているときは、余計な省略の注記を出さない', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 3; i += 1) {
      await humanTurn(stores, `conv-${i}`, `短い質問${i}`, `短い返答${i}`);
    }
    const call = tools(stores);

    const reply = await call('conversation_read', {});

    expect(reply).not.toContain('件は省略');
    expect(reply).not.toContain('limit を増やせば出る');
    expect(reply).toContain('先頭に届いている');
  });
});

describe('conversation_read — id + offset で全文を続きから読む', () => {
  it('先頭が切れたら続きの取り方が出て、offset で続きが取れる', async () => {
    const stores = createMemoryStores();
    const entry = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: `先頭の目印${'z'.repeat(10_000)}末尾の目印`,
      conversationId: 'conv-1',
    });
    const call = tools(stores);

    const head = await call('conversation_read', { id: entry.id });
    expect(head).toContain('先頭の目印');
    expect(head).not.toContain('末尾の目印');
    expect(head).toContain(`conversation_read id=${entry.id} offset=`);

    const offset = Number(/offset=(\d+)/.exec(head)?.[1]);
    const rest = await call('conversation_read', { id: entry.id, offset });
    expect(rest).toContain('末尾の目印');
  });

  it('無い id は、id だけを言って journal_read/conversation_read の区別に本文を漏らさない', async () => {
    const call = tools(createMemoryStores());
    const reply = await call('conversation_read', { id: 'no-such-id' });
    expect(reply).toContain('no-such-id');
    expect(reply).toContain('無い');
  });

  it('会話の発言ではない id（manager との往復）は journal_read を案内する', async () => {
    const stores = createMemoryStores();
    const entry = await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: 'マネージャーとの往復本文',
    });
    const call = tools(stores);

    const reply = await call('conversation_read', { id: entry.id });

    expect(reply).toContain('journal_read');
    expect(reply).not.toContain('マネージャーとの往復本文');
  });
});

describe('conversation_read — 判定できないことを2値に潰さない', () => {
  it('遡り切れているのに無ければ「無い」と言う', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '別の会話',
      conversationId: 'conv-real',
    });
    const call = tools(stores);

    const reply = await call('conversation_read', { conversationId: 'conv-does-not-exist' });

    expect(reply).toContain('無い');
    expect(reply).not.toContain('判定できない');
  });

  it('遡り切れていないなら「判定できない」と言う（無いと言い切らない）', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 5; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `[filler-${i}] 別会話`,
        conversationId: 'conv-filler',
      });
    }
    const call = tools(stores);

    const reply = await call('conversation_read', {
      conversationId: 'conv-does-not-exist',
      scan: 3,
    });

    expect(reply).toContain('判定できない');
    expect(reply).not.toContain('会話 conv-does-not-exist に当たる発言は無い。');
  });

  it('q でも同じ区別を持つ（一覧が空でも reachedStart で言い分ける）', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 5; i += 1) {
      await stores.journal.append({
        type: 'exchange',
        with: 'human',
        role: 'inbound',
        text: `[filler-${i}] 別の話題`,
        conversationId: 'conv-filler',
      });
    }
    const call = tools(stores);

    const notReached = await call('conversation_read', { q: '存在しない語', scan: 3 });
    expect(notReached).toContain('判定できない');

    const reached = await call('conversation_read', { q: '存在しない語', scan: 500 });
    expect(reached).toContain('無い');
    expect(reached).not.toContain('判定できない');
  });
});

describe('conversation_read — q で語を探す', () => {
  it('大文字小文字を区別しない部分一致で当たる', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-1', 'Deploy の話をしたい', 'デプロイ手順を答えます');
    const call = tools(stores);

    const reply = await call('conversation_read', { q: 'deploy' });

    expect(reply).toContain('Deploy の話をしたい');
    expect(reply).toContain('conversation=conv-1');
  });
});

describe('conversation_read — 会話の一覧', () => {
  it('何も指定しなければ会話の一覧を新しい順に返す', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-old', '古い会話の発言', '古い会話への返答');
    await humanTurn(stores, 'conv-new', '新しい会話の発言', '新しい会話への返答');
    const call = tools(stores);

    const reply = await call('conversation_read', {});

    const oldIndex = reply.indexOf('conv-old');
    const newIndex = reply.indexOf('conv-new');
    expect(oldIndex).toBeGreaterThan(-1);
    expect(newIndex).toBeGreaterThan(-1);
    expect(newIndex).toBeLessThan(oldIndex);
    expect(reply).toContain('conversation_read conversationId=');
  });
});

describe('conversation_read — 出ないものを説明文が名指ししている', () => {
  it('ask_human の回答が出ないことと、その行き先が書いてある', () => {
    const found = createCloneTools({
      memoryCause: () => 'clone',
      conversationId: () => undefined,
      stores: createMemoryStores(),
      emit: () => undefined,
    }).find((entry) => entry.name === 'conversation_read');
    if (!found) throw new Error('道具 conversation_read が無い');

    expect(found.description).toContain('ask_human');
    expect(found.description).toContain('escalation');
    expect(found.description).not.toContain('approvals_list では出ない');
    expect(found.description).not.toContain('答えの本文を持たない');
    expect(found.description).toContain('approvals_list');
    expect(found.description).toMatch(/approvals_list[^。]*id[^。]*答え/);
  });
});

describe('conversation_read — 効かなかった指定を黙らない', () => {
  it('一覧モードで speaker を渡すと、効いていないことを応答に書く', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-1', '人間の発言', 'クローンの返答');
    const call = tools(stores);

    const reply = await call('conversation_read', { speaker: 'human' });

    expect(reply).toContain('speaker=human');
    expect(reply).toContain('効いていない');
  });

  it('speaker を渡さなければ、その注記は出ない（毎回出ると目印が効かなくなる）', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-1', '人間の発言', 'クローンの返答');
    const call = tools(stores);

    const reply = await call('conversation_read', {});

    expect(reply).not.toContain('効いていない');
  });
});

describe('conversation_read — includeSuperseded（編集で畳まれた版）', () => {
  it('既定は編集後の版だけを返し、畳まれた版の件数を注記する（制約A）', async () => {
    const stores = createMemoryStores();
    const original = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の質問',
      conversationId: 'conv-edit',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '元の回答',
      conversationId: 'conv-edit',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '直した質問',
      conversationId: 'conv-edit',
      supersedes: original.id,
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '直した回答',
      conversationId: 'conv-edit',
    });
    const call = tools(stores);

    const reply = await call('conversation_read', { conversationId: 'conv-edit' });

    expect(reply).toContain('直した質問');
    expect(reply).toContain('直した回答');
    expect(reply).not.toContain('元の質問');
    expect(reply).not.toContain('元の回答');
    expect(reply).toContain('畳まれた版が 2 件ある');
    expect(reply).toContain('includeSuperseded=true');
  });

  it('畳まれた版が無ければ、その注記は出ない（0件なら出さない）', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-plain', '質問', '回答');
    const call = tools(stores);

    const reply = await call('conversation_read', { conversationId: 'conv-plain' });

    expect(reply).not.toContain('畳まれた版');
  });

  it('includeSuperseded: true で、畳まれた旧発言・その応答も含めて返す', async () => {
    const stores = createMemoryStores();
    const original = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の質問',
      conversationId: 'conv-edit-2',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '元の回答',
      conversationId: 'conv-edit-2',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '直した質問',
      conversationId: 'conv-edit-2',
      supersedes: original.id,
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '直した回答',
      conversationId: 'conv-edit-2',
    });
    const call = tools(stores);

    const reply = await call('conversation_read', {
      conversationId: 'conv-edit-2',
      includeSuperseded: true,
    });

    expect(reply).toContain('元の質問');
    expect(reply).toContain('元の回答');
    expect(reply).toContain('直した質問');
    expect(reply).toContain('直した回答');
    expect(reply).toContain('畳まれた版が 2 件あり');
  });

  it('speaker での絞りと両立する（畳み込みを解いた後で speaker=human を掛ける）', async () => {
    const stores = createMemoryStores();
    const original = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '元の質問トマト',
      conversationId: 'conv-edit-3',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '元の回答トマト',
      conversationId: 'conv-edit-3',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '直した質問トマト',
      conversationId: 'conv-edit-3',
      supersedes: original.id,
    });
    const call = tools(stores);

    const reply = await call('conversation_read', {
      conversationId: 'conv-edit-3',
      includeSuperseded: true,
      speaker: 'human',
    });

    expect(reply).toContain('元の質問トマト');
    expect(reply).toContain('直した質問トマト');
    expect(reply).not.toContain('元の回答トマト');
  });
});

describe('conversation_read — 一覧の cursor の頁送り（#3644）', () => {
  const cursorOf = (reply: string): string | undefined =>
    /conversation_read[^\n]*?cursor=([A-Za-z0-9_-]+)/.exec(reply)?.[1];
  const idsOf = (reply: string): string[] =>
    [...reply.matchAll(/^(conv-\d+) /gm)].map((match) => match[1] as string);

  it('limit で切れたら cursor が出て、渡すと続きが新しい順に出る（飛ばさず重複しない）', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 5; i += 1) await humanTurn(stores, `conv-${i}`, `質問${i}`, `返答${i}`);
    const call = tools(stores);

    const first = await call('conversation_read', { limit: 2 });
    expect(idsOf(first)).toEqual(['conv-4', 'conv-3']);
    const cursor = cursorOf(first);
    expect(cursor).toBeDefined();

    const second = await call('conversation_read', { limit: 2, cursor });
    expect(idsOf(second)).toEqual(['conv-2', 'conv-1']);
    const third = await call('conversation_read', { limit: 2, cursor: cursorOf(second) });
    expect(idsOf(third)).toEqual(['conv-0']);
    expect(cursorOf(third)).toBeUndefined();
  });

  it('scan の窓の外も cursor で辿れる', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 4; i += 1) await humanTurn(stores, `conv-${i}`, `質問${i}`, `返答${i}`);
    const call = tools(stores);

    const first = await call('conversation_read', { scan: 4 });
    expect(idsOf(first)).toEqual(['conv-3', 'conv-2']);
    const second = await call('conversation_read', { scan: 4, cursor: cursorOf(first) });
    expect(idsOf(second)).toEqual(['conv-1', 'conv-0']);
  });

  it('予算で切れたら、出せた最後の会話からの cursor が出て、渡すと残りが出る', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 120; i += 1) await humanTurn(stores, `conv-${i}`, `質問${i}`, `返答${i}`);
    const call = tools(stores);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const reply = await call('conversation_read', {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...idsOf(reply));
      cursor = cursorOf(reply);
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `conv-${119 - i}`));
  });

  it('壊れた cursor は、先頭から返さず断る', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-0', '質問', '返答');
    const call = tools(stores);

    const reply = await call('conversation_read', { cursor: 'not-a-cursor' });

    expect(reply).toContain('cursor');
    expect(idsOf(reply)).toEqual([]);
  });

  it('HTTP の口（readConversationPage の next を符号化したもの）の cursor を、そのまま受ける', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 4; i += 1) await humanTurn(stores, `conv-${i}`, `質問${i}`, `返答${i}`);
    const first = await readConversationPage(stores.journal, { limit: 2, scan: 2000 });
    expect(first.next).not.toBeNull();
    const cursor = encodeConversationCursor(first.next as ConversationCursor);
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual(first.next);

    const reply = await tools(stores)('conversation_read', { limit: 2, cursor });

    expect(idsOf(reply)).toEqual(['conv-1', 'conv-0']);
  });

  it('続きの案内に、渡した since / until / scan / limit を引き継ぐ', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 5; i += 1) await humanTurn(stores, `conv-${i}`, `質問${i}`, `返答${i}`);

    const reply = await tools(stores)('conversation_read', {
      limit: 2,
      until: '2099-01-01T00:00:00.000Z',
    });

    expect(reply).toMatch(
      /続きを読むには: conversation_read cursor=\S+ until=2099-01-01T00:00:00.000Z limit=2/,
    );
  });

  it('until で窓を切っても、cursor を辿って全会話が重複なく読める', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < 5; i += 1) await humanTurn(stores, `conv-${i}`, `質問${i}`, `返答${i}`);
    const call = tools(stores);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const reply = await call('conversation_read', {
        limit: 2,
        until: '2099-01-01T00:00:00.000Z',
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...idsOf(reply));
      cursor = cursorOf(reply);
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(['conv-4', 'conv-3', 'conv-2', 'conv-1', 'conv-0']);
  });

  it('指す発言が無い cursor は、先頭から返さず断る', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-0', '質問', '返答');
    const cursor = encodeConversationCursor({ id: 'jrn-missing', at: '2026-01-01T00:00:00.000Z' });

    const reply = await tools(stores)('conversation_read', { cursor });

    expect(reply).toContain('cursor が使えない');
    expect(idsOf(reply)).toEqual([]);
  });

  it('conversationId / q のときは cursor を使わない、と言う', async () => {
    const stores = createMemoryStores();
    await humanTurn(stores, 'conv-0', '質問', '返答');
    const call = tools(stores);
    const cursor = encodeConversationCursor({ id: 'x', at: 'y' });

    const byId = await call('conversation_read', { conversationId: 'conv-0', cursor });
    const byQuery = await call('conversation_read', { q: '質問', cursor });

    expect(byId).toContain('cursor は会話の一覧のときだけ効く');
    expect(byQuery).toContain('cursor は会話の一覧のときだけ効く');
  });
});

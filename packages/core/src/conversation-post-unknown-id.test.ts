import { describe, expect, it } from 'vitest';

import { JOURNAL_SCAN_PAGE_SIZE } from './journal-scan.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * `conversation_post` は、渡された会話 id の会話が無ければ断る（Issue #4149）。
 *
 * 本番で、略記の `bf63fd3d` を渡された道具が `bf63fd3d-93d2-…` の続きではなく `bf63fd3d` という
 * 新しい会話を作り、同じ話が人間の画面で2つの会話に分かれた。新しい会話を始めてよいのは
 * id を省いたときだけである。
 */
function setup() {
  const stores = createMemoryStores();
  const posted: { conversationId: string; text: string }[] = [];
  const tools = createCloneTools({
    stores,
    emit: () => {},
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    postToConversation: (conversationId, text) => posted.push({ conversationId, text }),
  });
  const post = async (args: Record<string, unknown>) => {
    const found = tools.find((entry) => entry.name === 'conversation_post');
    const result = await found!.handler(args as never, {});
    return {
      isError: result.isError === true,
      text: result.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
    };
  };
  return { stores, posted, post };
}

async function seedConversation(stores: Stores, conversationId: string, text = '人間の発言') {
  await stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text,
    conversationId,
  });
}

async function conversationIdsInJournal(stores: Stores): Promise<(string | undefined)[]> {
  return (await stores.journal.list({ types: ['exchange'] })).map((entry) =>
    entry.type === 'exchange' ? entry.conversationId : undefined,
  );
}

describe('conversation_post は、無い会話の id で会話を作らない（#4149）', () => {
  it('渡した id の会話が無ければ断り、日誌にも画面にも何も出さない。文言は「無い」と「省けば新しい会話」を言う', async () => {
    const h = setup();
    await seedConversation(h.stores, 'conv-1');

    const result = await h.post({ conversationId: 'conv-unknown', text: '知らせ' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('会話 conv-unknown は無い');
    expect(result.text).toContain('新しい会話を始めるなら conversationId を省くこと');
    expect(await conversationIdsInJournal(h.stores)).toEqual(['conv-1']);
    expect(h.posted).toEqual([]);
  });

  it('略記では書かない。前方一致する会話が1つなら、完全な id を文言に出す（本番の形）', async () => {
    const h = setup();
    const full = 'bf63fd3d-93d2-4f22-b2dc-9fd99662d4f3';
    await seedConversation(h.stores, full);

    const result = await h.post({ conversationId: 'bf63fd3d', text: '報告' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('会話 bf63fd3d は無い');
    expect(result.text).toContain(`bf63fd3d で始まる会話は1つだけ在る: ${full}`);
    expect(await conversationIdsInJournal(h.stores)).toEqual([full]);
    expect(h.posted).toEqual([]);
  });

  it('前方一致する会話が複数なら、どれも選ばずに並べて断る（当たらない会話は出さない）', async () => {
    const h = setup();
    await seedConversation(h.stores, 'abc-1');
    await seedConversation(h.stores, 'abc-2');
    await seedConversation(h.stores, 'xyz-1');

    const result = await h.post({ conversationId: 'abc', text: '報告' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('abc で始まる会話が複数在る');
    expect(result.text).toContain('abc-1');
    expect(result.text).toContain('abc-2');
    expect(result.text).not.toContain('xyz-1');
    expect(h.posted).toEqual([]);
  });

  it('マネージャーとの往復だけに現れる id は、人間の会話として数えない', async () => {
    const h = setup();
    await h.stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: 'マネージャーの報告',
      conversationId: 'conv-manager-only',
    });

    const result = await h.post({ conversationId: 'conv-manager-only', text: '知らせ' });

    expect(result.isError).toBe(true);
    expect(h.posted).toEqual([]);
  });

  it('日誌を走査する1頁より古い会話へも書ける（在る会話を無いと断らない）', async () => {
    const h = setup();
    await seedConversation(h.stores, 'conv-old');
    for (let i = 0; i < JOURNAL_SCAN_PAGE_SIZE + 10; i += 1) {
      await seedConversation(h.stores, 'conv-busy', `発言 ${i}`);
    }

    const result = await h.post({ conversationId: 'conv-old', text: '昔の話の続き' });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('会話 conv-old へ書いた');
    expect(h.posted).toEqual([{ conversationId: 'conv-old', text: '昔の話の続き' }]);
  });

  it('id を省けば新しい会話を始められ、その会話へは続けて書ける（クローンから人間へ話しかける経路は残す）', async () => {
    const h = setup();
    const first = await h.post({ text: '始める' });
    const id = /新しい会話 (\S+) を始めて書いた/.exec(first.text)?.[1];
    expect(first.isError).toBe(false);
    expect(id).toBeDefined();

    const second = await h.post({ conversationId: id, text: '続ける' });

    expect(second.isError).toBe(false);
    expect(second.text).toContain(`会話 ${id ?? ''} へ書いた`);
    expect(h.posted.map((entry) => entry.conversationId)).toEqual([id, id]);
  });
});

import { describe, expect, it } from 'vitest';

import { JOURNAL_SCAN_PAGE_SIZE } from './journal-scan.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * `conversation_post` は、渡された会話 id の会話が無ければ断る。
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

  // 元の歯（#4150）: 「略記では書かない。前方一致する会話が1つなら、完全な id を文言に出す（本番の形）」。
  // 略記 bf63fd3d が文字どおりの新しい会話を作った事故（#4149）の直しで、前方一致では書かずに断ることを固定していた。
  // #5130 で期待値を反転した: クローンが先頭 8 文字だけを渡して断られる誤りが続いたため、一意に決まる 8 文字以上の先頭は、
  // 読み替えたことを名乗ったうえで完全な id の会話へ書く。#4149 の事故そのもの（文字どおりの新しい会話を作る）は起きないことを、下の2行で今も確かめる
  it('略記（8 文字以上の先頭）が1つの会話に決まれば、完全な id の会話へ書き、読み替えたことを名乗る（本番の形。#5130 で反転）', async () => {
    const h = setup();
    const full = 'bf63fd3d-93d2-4f22-b2dc-9fd99662d4f3';
    await seedConversation(h.stores, full);

    const result = await h.post({ conversationId: 'bf63fd3d', text: '報告' });

    expect(result.isError).not.toBe(true);
    expect(result.text).toContain(
      `会話 id の先頭 bf63fd3d を、それで始まる唯一の会話 ${full} と読んだ`,
    );
    expect(result.text).toContain(`会話 ${full} へ書いた`);
    // 文字どおりの bf63fd3d の会話は作らない（#4149 の事故の形）。日誌の会話 id の種類は、完全な id の1つだけ
    expect([...new Set(await conversationIdsInJournal(h.stores))]).toEqual([full]);
    expect(h.posted.map((post) => post.conversationId)).toEqual([full]);
  });

  it('8 文字より短い先頭は、1つの会話に決まっても読み替えずに断り、短いからだと言う（#5130）', async () => {
    const h = setup();
    const full = 'bf63fd3d-93d2-4f22-b2dc-9fd99662d4f3';
    await seedConversation(h.stores, full);

    const result = await h.post({ conversationId: 'bf63fd3', text: '報告' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('会話 bf63fd3 は無い');
    expect(result.text).toContain('先頭が 8 文字より短いので読み替えなかった');
    expect(result.text).toContain(full);
    expect(h.posted).toEqual([]);
  });

  it('完全一致の会話が在れば、前方一致より先にそちらへ書く（#4149 の事故で生まれた文字どおりの会話を守る。#5130）', async () => {
    const h = setup();
    await seedConversation(h.stores, 'bf63fd3d-93d2-4f22-b2dc-9fd99662d4f3');
    await seedConversation(h.stores, 'bf63fd3d');

    const result = await h.post({ conversationId: 'bf63fd3d', text: '報告' });

    expect(result.isError).not.toBe(true);
    expect(result.text).not.toContain('と読んだ');
    expect(h.posted.map((post) => post.conversationId)).toEqual(['bf63fd3d']);
  });

  it('8 文字以上の先頭が2つ以上の会話に当たれば、どれにも書かずに断って候補の完全な id を返す（#5130）', async () => {
    const h = setup();
    await seedConversation(h.stores, 'c60b1940-1111-4111-8111-111111111111');
    await seedConversation(h.stores, 'c60b1940-2222-4222-8222-222222222222');

    const result = await h.post({ conversationId: 'c60b1940', text: '報告' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('c60b1940 で始まる会話が複数在るので、どれか決められない');
    expect(result.text).toContain('c60b1940-1111-4111-8111-111111111111');
    expect(result.text).toContain('c60b1940-2222-4222-8222-222222222222');
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

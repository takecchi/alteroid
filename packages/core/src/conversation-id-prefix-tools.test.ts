import { describe, expect, it } from 'vitest';

import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// クローンの道具は、一意に決まる 8 文字以上の会話 id の先頭を受け付ける（#5130）。conversation_post 以外の口と、いまのターンの会話

const FULL = 'c60b1940-93d2-4f22-b2dc-9fd99662d4f3';

function setup(current?: string) {
  const stores = createMemoryStores();
  const posted: string[] = [];
  const tools = createCloneTools({
    stores,
    emit: () => {},
    memoryCause: () => 'clone',
    conversationId: () => current,
    postToConversation: (conversationId) => posted.push(conversationId),
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const found = tools.find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`道具 ${name} が無い`);
    const result = await found.handler(args as never, {});
    return {
      isError: result.isError === true,
      text: result.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
    };
  };
  return { stores, posted, call };
}

async function seed(stores: Stores, conversationId: string, text: string): Promise<void> {
  await stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text,
    conversationId,
  });
}

describe('会話 id の先頭を受け付ける道具の口（#5130）', () => {
  it('⭐ conversation_read: 先頭 8 文字で、その会話の中身を読み、読み替えたことを名乗る', async () => {
    const h = setup();
    await seed(h.stores, FULL, '先頭で読める発言');

    const result = await h.call('conversation_read', { conversationId: 'c60b1940' });

    expect(result.text).toContain(
      `会話 id の先頭 c60b1940 を、それで始まる唯一の会話 ${FULL} と読んだ`,
    );
    expect(result.text).toContain('先頭で読める発言');
  });

  it('conversation_read: 2つ以上に当たる先頭は読まずに、候補の完全な id を返す', async () => {
    const h = setup();
    await seed(h.stores, `${FULL}-a`, 'a');
    await seed(h.stores, `${FULL}-b`, 'b');

    const result = await h.call('conversation_read', { conversationId: 'c60b1940' });

    expect(result.text).toContain('会話は読んでいない');
    expect(result.text).toContain(`${FULL}-a`);
    expect(result.text).toContain(`${FULL}-b`);
  });

  it('conversation_read: 当たらない id は今どおり「無い／この窓には無い」で答える（解決できないことでは断らない）', async () => {
    const h = setup();
    await seed(h.stores, FULL, '発言');

    const result = await h.call('conversation_read', { conversationId: 'zzzzzzzz' });

    expect(result.text).toContain('会話 zzzzzzzz に当たる発言は無い');
  });

  it('file_list: 先頭 8 文字で、その会話に結ばれた添付だけに絞り、読み替えたことを名乗る', async () => {
    const h = setup();
    await seed(h.stores, FULL, '発言');

    const result = await h.call('file_list', { conversationId: 'c60b1940' });

    expect(result.text).toContain(
      `会話 id の先頭 c60b1940 を、それで始まる唯一の会話 ${FULL} と読んだ`,
    );
  });

  it('conversation_post: いまのターンの会話を先頭で渡しても、読み替えた後の id で断る', async () => {
    const h = setup(FULL);
    await seed(h.stores, FULL, 'いまの会話の発言');

    const result = await h.call('conversation_post', {
      conversationId: 'c60b1940',
      text: '知らせ',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      `会話 ${FULL} はいまのターンの会話なので、この道具では書かなかった`,
    );
    expect(h.posted).toEqual([]);
  });

  it('conversation_post: いまのターンの会話は、1通目が日誌に載る前でも、そのままの id なら同じ文言で断る', async () => {
    const h = setup(FULL);

    const result = await h.call('conversation_post', { conversationId: FULL, text: '知らせ' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      `会話 ${FULL} はいまのターンの会話なので、この道具では書かなかった`,
    );
  });
});

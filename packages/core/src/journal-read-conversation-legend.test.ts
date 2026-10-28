import { describe, expect, it } from 'vitest';

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

const CONVERSATION_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const CONVERSATION_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const CONVERSATION_ONCE = '33333333-cccc-4ccc-8ccc-333333333333';

async function appendExchange(stores: Stores, text: string, conversationId?: string) {
  return stores.journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text,
    ...(conversationId === undefined ? {} : { conversationId }),
  });
}

describe('journal_read — 一覧の会話 id は、2行以上に出る id だけ凡例に1回書いて札にする', () => {
  it('同じ会話の行が複数あるとき、会話 id は凡例に1回だけ出て、行は札で指す', async () => {
    const stores = createMemoryStores();
    await appendExchange(stores, '一つ目', CONVERSATION_A);
    await appendExchange(stores, '二つ目', CONVERSATION_A);
    await appendExchange(stores, '三つ目', CONVERSATION_A);
    const call = tools(stores);

    const listing = await call('journal_read', { types: ['exchange'] });

    expect(listing.split(CONVERSATION_A)).toHaveLength(2);
    expect(listing).toContain(`（conv#1 = conversation ${CONVERSATION_A}）`);
    expect(listing.match(/\[exchange human\/inbound\] conversation=conv#1/g)).toHaveLength(3);
  });

  it('会話ごとに別の札になり、1回しか出ない会話・会話の無い行は、これまでどおり行に書く', async () => {
    const stores = createMemoryStores();
    await appendExchange(stores, 'A1', CONVERSATION_A);
    await appendExchange(stores, 'B1', CONVERSATION_B);
    await appendExchange(stores, 'A2', CONVERSATION_A);
    await appendExchange(stores, 'B2', CONVERSATION_B);
    await appendExchange(stores, '単発', CONVERSATION_ONCE);
    await appendExchange(stores, '会話なし');
    const call = tools(stores);

    const listing = await call('journal_read', { types: ['exchange'] });

    expect(listing).toContain(`（conv#1 = conversation ${CONVERSATION_B}）`);
    expect(listing).toContain(`（conv#2 = conversation ${CONVERSATION_A}）`);
    // 1回しか出ない会話は札にしない（凡例のほうが長くなる）
    expect(listing).toContain(`[exchange human/inbound] conversation=${CONVERSATION_ONCE}`);
    expect(listing).not.toContain(`conv#3`);
    expect(listing).toContain('会話なし');
    // どの行も会話の id を落としていない: 札は凡例で必ず引ける
    for (const id of [CONVERSATION_A, CONVERSATION_B, CONVERSATION_ONCE]) {
      expect(listing).toContain(id);
    }
  });

  it('id 指定の全文読みは札にせず、会話 id をそのまま出す', async () => {
    const stores = createMemoryStores();
    const first = await appendExchange(stores, '一つ目', CONVERSATION_A);
    await appendExchange(stores, '二つ目', CONVERSATION_A);
    const call = tools(stores);

    const single = await call('journal_read', { id: first.id });

    expect(single).toContain(`conversation=${CONVERSATION_A}`);
    expect(single).not.toContain('conv#');
  });

  it('同じ会話が続く一覧は、凡例を入れても札にする前より短い', async () => {
    const stores = createMemoryStores();
    for (let index = 0; index < 20; index += 1) {
      await appendExchange(stores, `発言 ${index}`, CONVERSATION_A);
    }
    const call = tools(stores);

    const listing = await call('journal_read', { types: ['exchange'] });

    const withoutLegend = listing
      .replace(/^（conv#1 = conversation .*）\n/m, '')
      .replaceAll('conversation=conv#1', `conversation=${CONVERSATION_A}`);
    // 札にしないで出した場合との差（凡例の1行を引いた正味）。1行あたり UUID 36 字 → 札 6 字で 30 字、20 行で 600 字、凡例は約 60 字
    expect(withoutLegend.length - listing.length).toBeGreaterThan(500);
  });
});

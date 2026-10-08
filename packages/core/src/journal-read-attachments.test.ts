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

const PNG = {
  id: 'att-png',
  name: 'shot.png',
  mediaType: 'image/png',
  size: 10,
  sha256: 'a'.repeat(64),
};
const LOG = {
  id: 'att-log',
  name: 'run.log',
  mediaType: 'text/plain',
  size: 3,
  sha256: 'b'.repeat(64),
};

describe('journal_read — 添付の控えを出す（#4017）', () => {
  it('添付だけの発言・担い手へ渡した添付・外部イベントの添付が、一覧にも id 指定にも出る', async () => {
    const stores = createMemoryStores();
    const human = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '',
      conversationId: 'c1',
      attachments: [PNG],
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: '[mgr-1] これを見て',
      attachments: [PNG, LOG],
    });
    await stores.journal.append({
      type: 'external_event',
      source: 'ci.main',
      summary: 'failure',
      attachments: [LOG],
    });
    const call = tools(stores);

    const listing = await call('journal_read', { types: ['exchange', 'external_event'] });
    const png = 'id=att-png name=shot.png type=image/png size=10';
    const log = 'id=att-log name=run.log type=text/plain size=3';
    expect(listing).toContain(`[exchange human/inbound] conversation=c1 attachments=[${png}]`);
    expect(listing).toContain(`[exchange manager/outbound] attachments=[${png}; ${log}]`);
    expect(listing).toContain(`[external_event ci.main] attachments=[${log}]`);

    const single = await call('journal_read', { id: human.id });
    expect(single).toContain(`attachments=[${png}]`);
  });

  it('添付が多い行は、一覧では先頭5件と「ほか N 件」に締まり、id 指定では全件出る', async () => {
    const stores = createMemoryStores();
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...PNG,
      id: `att-${i}`,
      name: `f${i}.png`,
    }));
    const entry = await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '',
      attachments: many,
    });
    const call = tools(stores);
    const listing = await call('journal_read', { types: ['exchange'] });
    expect(listing).toContain('id=att-4 ');
    expect(listing).not.toContain('id=att-5 ');
    expect(listing).toContain('ほか 3 件');
    const single = await call('journal_read', { id: entry.id });
    expect(single).toContain('id=att-7 ');
    expect(single).not.toContain('ほか 3 件');
  });

  it('受け取れなかったファイルも出る（全部断られた報告が空に見えない）', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'manager',
      role: 'inbound',
      text: '',
      rejectedAttachments: [{ name: 'big.bin', reason: '大きすぎる' }],
    });
    const listing = await tools(stores)('journal_read', { types: ['exchange'] });
    expect(listing).toContain('rejectedAttachments=[big.bin（大きすぎる）]');
  });

  it('添付の無い行の見出しは変わらない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'やあ' });
    const listing = await tools(stores)('journal_read', { types: ['exchange'] });
    expect(listing).not.toContain('attachments=');
    expect(listing).toContain('[exchange human/inbound]');
  });
});

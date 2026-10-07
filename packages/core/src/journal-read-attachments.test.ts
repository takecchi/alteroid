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
    expect(listing).toContain(
      `[exchange human/inbound] conversation=c1 attachments=[id=att-png name=shot.png]`,
    );
    expect(listing).toContain(
      `[exchange manager/outbound] attachments=[id=att-png name=shot.png; id=att-log name=run.log]`,
    );
    expect(listing).toContain(`[external_event ci.main] attachments=[id=att-log name=run.log]`);

    const single = await call('journal_read', { id: human.id });
    expect(single).toContain('attachments=[id=att-png name=shot.png]');
  });

  it('添付の無い行の見出しは変わらない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'やあ' });
    const listing = await tools(stores)('journal_read', { types: ['exchange'] });
    expect(listing).not.toContain('attachments=');
    expect(listing).toContain('[exchange human/inbound]');
  });
});

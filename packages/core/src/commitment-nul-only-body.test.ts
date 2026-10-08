import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function setup() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const found = tools.find((entry) => entry.name === name);
    expect(found, `${name} という道具が無い`).toBeDefined();
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
  return { stores, call };
}

describe('commitment_open / commitment_edit と NUL だけの本文', () => {
  it('commitment_edit: NUL だけの body は断り、元の本文を残す', async () => {
    const { stores, call } = setup();
    await stores.commitments.open({
      id: 'c-nul-edit',
      at: '2026-10-06T00:00:00.000Z',
      origin: 'self',
      body: '元の本文',
    });

    const reply = await call('commitment_edit', { id: 'c-nul-edit', body: '\u0000' });

    expect((await stores.commitments.get('c-nul-edit'))?.body).toBe('元の本文');
    expect(reply).toContain('body は使えない');
  });

  it('commitment_open: NUL だけの body は載せない（空の本文の行を作らない）', async () => {
    const { stores, call } = setup();

    const reply = await call('commitment_open', { body: '\u0000\u0000' });

    const { entries } = await stores.commitments.list();
    expect(entries).toEqual([]);
    expect(reply).toContain('body は使えない');
  });

  it('commitment_edit: NUL が混じっても、落とした後に本文が残るなら保存できる', async () => {
    const { stores, call } = setup();
    await stores.commitments.open({
      id: 'c-nul-mixed',
      at: '2026-10-06T00:00:00.000Z',
      origin: 'self',
      body: '元の本文',
    });

    await call('commitment_edit', { id: 'c-nul-mixed', body: '新\u0000しい本文' });

    expect((await stores.commitments.get('c-nul-mixed'))?.body).toBe('新しい本文');
  });

  it('commitment_open: NUL が混じっても、落とした後に本文が残るなら載せられる', async () => {
    const { stores, call } = setup();

    await call('commitment_open', { body: '\u0000宿題\u0000' });

    const { entries } = await stores.commitments.list();
    expect(entries.map((entry) => entry.body)).toEqual(['宿題']);
  });
});

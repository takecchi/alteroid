import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ManagerPool } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

const NO_ONE_RUNNING = { runningManagerOwning: () => undefined } as unknown as ManagerPool;

function remover(stores: Stores) {
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: NO_ONE_RUNNING,
  };
  const found = createCloneTools(context).find((entry) => entry.name === 'archive_remove_many');
  expect(found).toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

describe('archive_remove_many の before は、日時として読めない値を別の時刻へ倒さない（#3287 と同じ形。こちらは消す口）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function seed(stores: Stores): Promise<string> {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-02T12:00:00.000Z'));
    const oldRow = await stores.archive.archive('sess-garbage', 'AAA');
    vi.setSystemTime(new Date('2026-03-02T12:00:00.001Z'));
    await stores.archive.archive('sess-garbage', 'AAABBB');
    return oldRow.id;
  }

  it('存在しない日付「2026-02-31T00:00:00.000Z」を 3/3 として読み、3/2 の行を消さない', async () => {
    const stores = createMemoryStores();
    const oldId = await seed(stores);
    const reply = await remover(stores)({
      before: '2026-02-31T00:00:00.000Z',
      summary: '掃除',
      dryRun: false,
    });
    expect(reply).toContain('読めない');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it('日付でない「foo 1」を 2001 年として読まず、断る', async () => {
    const stores = createMemoryStores();
    const oldId = await seed(stores);
    const reply = await remover(stores)({ before: 'foo 1', summary: '掃除', dryRun: false });
    expect(reply).toContain('読めない');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });
});

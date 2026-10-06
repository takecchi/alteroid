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

/**
 * 道具 `inbox_remove_many` の before と、HTTP の `POST /inbox/remove`・`POST /archive/remove` の
 * before は、時差の無い時刻を断る（#2462・#3390）。同じ「元に戻せない一括削除」の道具
 * `archive_remove_many` だけが、時差の無い値を器の地方時刻として読んで消していた。
 */
describe('archive_remove_many の before は時差を必須にする（inbox_remove_many・HTTP と同じ門）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function seed(stores: Stores): Promise<string> {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
    const oldRow = await stores.archive.archive('sess-offset', 'AAA');
    vi.setSystemTime(new Date('2026-10-05T12:00:00.001Z'));
    await stores.archive.archive('sess-offset', 'AAABBB');
    return oldRow.id;
  }

  it.each([
    ['時差の無い日時', '2026-10-06T00:00:00'],
    ['時差の無い日時（秒なし）', '2026-10-06T00:00'],
    ['日付だけ', '2026-10-06'],
  ])('%s「%s」は断り、1件も消さない', async (_label, before) => {
    const stores = createMemoryStores();
    const oldId = await seed(stores);
    const reply = await remover(stores)({ before, summary: '掃除', dryRun: false });
    expect(reply).toContain('時差が無い');
    expect(reply).toContain('1件も消していない');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it.each([
    ['存在しない日付（時差つき）', '2026-02-31T00:00:00+09:00'],
    ['日付でない文字列', 'foo 1'],
  ])('%s「%s」も引き続き断る', async (_label, before) => {
    const stores = createMemoryStores();
    const oldId = await seed(stores);
    const reply = await remover(stores)({ before, summary: '掃除', dryRun: false });
    expect(reply).toContain('読めない');
    expect(reply).toContain('1件も消していない');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it.each([
    ['Z', '2026-10-06T00:00:00.000Z'],
    ['+09:00', '2026-10-06T09:00:00+09:00'],
  ])('時差つき（%s）は今までどおり読み、古い行を消す', async (_label, before) => {
    const stores = createMemoryStores();
    const oldId = await seed(stores);
    const reply = await remover(stores)({ before, summary: '掃除', dryRun: false });
    expect(reply).not.toContain('時差が無い');
    expect(await stores.archive.read(oldId)).not.toEqual({ kind: 'body', body: 'AAA' });
  });
});

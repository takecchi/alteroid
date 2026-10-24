import { describe, expect, it } from 'vitest';

import type { ManagerPool } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// #5244: 退避済み生ログの本文を消す道具は、日誌を先に書いてから消す（本文は戻らない）。

const NO_ONE_RUNNING = { runningManagerOwning: () => undefined } as unknown as ManagerPool;

function tool(stores: Stores, name: 'archive_remove' | 'archive_remove_many') {
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: NO_ONE_RUNNING,
  };
  const found = createCloneTools(context).find((entry) => entry.name === name);
  expect(found, `${name} という道具が無い`).toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

async function decisionTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  // `list` は新しい順: 書いた順（古い順）へ直す
  return entries
    .slice()
    .reverse()
    .map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

describe('archive_remove は日誌を先に書いてから消す', () => {
  it('消す瞬間に、先の行（id と理由）が日誌に既に在る（順序の歯）', async () => {
    const stores = createMemoryStores();
    const id = (await stores.archive.archive('sess-order', 'BODY\n')).id;
    let seenAtRemove: string[] | undefined;
    const originalRemove = stores.archive.remove.bind(stores.archive);
    stores.archive.remove = async (target: string) => {
      seenAtRemove = await decisionTexts(stores);
      return originalRemove(target);
    };

    await tool(stores, 'archive_remove')({ archiveId: id, summary: '順序を測る' });

    expect(seenAtRemove).toHaveLength(1);
    expect(seenAtRemove?.[0]).toContain(id);
    expect(seenAtRemove?.[0]).toContain('順序を測る');
  });

  it('先の行が書けなければ消さず、行為は起きていないと投げる', async () => {
    const stores = createMemoryStores();
    const id = (await stores.archive.archive('sess-first-fail', 'BODY\n')).id;
    stores.journal.append = () => Promise.reject(new Error('日誌が落ちた（テスト用）'));

    await expect(
      tool(stores, 'archive_remove')({ archiveId: id, summary: '消す' }),
    ).rejects.toThrow('行為は起きていない');

    expect(await stores.archive.read(id)).toEqual({ kind: 'body', body: 'BODY\n' });
  });

  it('消した後でないと分からないバイト数は、2行目として足される', async () => {
    const stores = createMemoryStores();
    const id = (await stores.archive.archive('sess-after', 'BODY\n')).id;

    await tool(stores, 'archive_remove')({ archiveId: id, summary: '消す' });

    const texts = await decisionTexts(stores);
    expect(texts).toHaveLength(2);
    expect(texts[0]).not.toContain('バイト');
    expect(texts[1]).toContain('5 バイト');
  });

  it('2行目が書けなくても、消した結果は変わらず成功を返す（best-effort）', async () => {
    const stores = createMemoryStores();
    const id = (await stores.archive.archive('sess-after-fail', 'BODY\n')).id;
    let calls = 0;
    const original = stores.journal.append.bind(stores.journal);
    stores.journal.append = (entry) => {
      calls += 1;
      if (calls >= 2) return Promise.reject(new Error('日誌が落ちた（テスト用）'));
      return original(entry);
    };

    const reply = await tool(stores, 'archive_remove')({ archiveId: id, summary: '消す' });

    expect(reply).toContain('本文を消した');
    expect(await stores.archive.read(id)).toMatchObject({ kind: 'removed' });
  });

  it('消せなかった（無かった）ときは、先の行を打ち消す行が足される', async () => {
    const stores = createMemoryStores();

    const reply = await tool(
      stores,
      'archive_remove',
    )({ archiveId: '居ない.jsonl', summary: '消す' });

    expect(reply).toContain('存在しない');
    const texts = await decisionTexts(stores);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('効いていない');
    expect(texts[1]).toContain('居ない.jsonl');
  });
});

async function seedManySessions(stores: Stores, count: number): Promise<string[]> {
  const oldIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const sessionId = `sess-count-${String(i).padStart(3, '0')}-${'x'.repeat(60)}`;
    oldIds.push((await stores.archive.archive(sessionId, 'AAA')).id);
    await stores.archive.archive(sessionId, 'AAABBB');
  }
  return oldIds;
}

describe('archive_remove_many は塊ごとに「先の行 → 消す」', () => {
  it('消す瞬間に、その塊の先の行が日誌に既に在る（順序の歯）', async () => {
    const stores = createMemoryStores();
    const oldIds = await seedManySessions(stores, 3);
    const seen: string[][] = [];
    const originalRemove = stores.archive.remove.bind(stores.archive);
    stores.archive.remove = async (target: string) => {
      seen.push(await decisionTexts(stores));
      return originalRemove(target);
    };

    await tool(
      stores,
      'archive_remove_many',
    )({
      minStoredBytes: 0,
      summary: '順序を測る',
      dryRun: false,
    });

    expect(seen).toHaveLength(oldIds.length);
    for (const texts of seen) {
      expect(texts).toHaveLength(1);
      for (const id of oldIds) expect(texts[0]).toContain(id);
    }
  });

  it('2つ目の塊の先の行が書けなければ、1つ目だけ消えて止まる（どこまで消したかを返す）', async () => {
    const stores = createMemoryStores();
    const oldIds = await seedManySessions(stores, 150);
    let calls = 0;
    const original = stores.journal.append.bind(stores.journal);
    stores.journal.append = (entry) => {
      calls += 1;
      if (calls >= 2) return Promise.reject(new Error('日誌が落ちた（テスト用）'));
      return original(entry);
    };

    const reply = await tool(
      stores,
      'archive_remove_many',
    )({
      minStoredBytes: 0,
      summary: '2塊目で止める',
      dryRun: false,
    });

    expect(reply).toContain('2/');
    expect(reply).toContain('消さずに止めた');
    const states = await Promise.all(oldIds.map((id) => stores.archive.read(id)));
    const removed = states.filter((s) => s.kind === 'removed').length;
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThan(oldIds.length);
    // 日誌には1つ目の塊の行だけが在り、消えた本文はその行に載っている
    const texts = await decisionTexts(stores);
    expect(texts).toHaveLength(1);
    expect(reply).toContain(`**${removed} 件の本文を tombstone した**`);
  });

  it('1つ目の塊の先の行が書けなければ、1件も消えず、行為は起きていないと投げる', async () => {
    const stores = createMemoryStores();
    const oldIds = await seedManySessions(stores, 3);
    stores.journal.append = () => Promise.reject(new Error('日誌が落ちた（テスト用）'));

    await expect(
      tool(stores, 'archive_remove_many')({ minStoredBytes: 0, summary: '消す', dryRun: false }),
    ).rejects.toThrow('行為は起きていない');

    for (const id of oldIds)
      expect(await stores.archive.read(id)).toEqual({ kind: 'body', body: 'AAA' });
  });
});

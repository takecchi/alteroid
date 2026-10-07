import { describe, expect, it, vi } from 'vitest';

import type { ManagerPool } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

const NO_ONE_RUNNING = { runningManagerOwning: () => undefined } as unknown as ManagerPool;

function remover(stores: Stores, managers: ManagerPool | null = NO_ONE_RUNNING) {
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(managers === null ? {} : { managers }),
  };
  const tools = createCloneTools(context);
  const found = tools.find((entry) => entry.name === 'archive_remove_many');
  expect(found, 'archive_remove_many という道具が無い').toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

function inputShape(stores: Stores): Record<string, unknown> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'archive_remove_many');
  expect(found, 'archive_remove_many という道具が無い').toBeDefined();
  return (found?.inputSchema ?? {}) as Record<string, unknown>;
}

async function decisionTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

async function seedRemovableSession(
  stores: Stores,
  sessionId: string,
): Promise<{ oldId: string; newId: string }> {
  const oldRow = await stores.archive.archive(sessionId, 'AAA');
  const newRow = await stores.archive.archive(sessionId, 'AAABBB');
  expect(newRow.continuity, '前方一致の前提が崩れている（テストの組み立てミス）').toBe('continues');
  return { oldId: oldRow.id, newId: newRow.id };
}

describe('archive_remove_many（アーカイブ済み生ログの本文を絞り込んでまとめて tombstone する）', () => {
  it('既定（dryRun 省略）は試算——1件も消さない', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-dry');
    const call = remover(stores);

    const reply = await call({ sessionIds: ['sess-dry'], summary: '試しに絞り込んでみる' });

    expect(reply).toContain('試算');
    expect(reply).toContain('1件も消していない');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it('sessionIds / before / minStoredBytes のどれも渡さない呼びは断る（1件も消さない）', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-nofilter');
    const call = remover(stores);

    const reply = await call({ summary: '絞り込み忘れ', dryRun: false });

    expect(reply).toContain('1件も消していない');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it('dryRun: false で実際に消える（新しい行は最新行として守られ、古い行だけ消える）', async () => {
    const stores = createMemoryStores();
    const { oldId, newId } = await seedRemovableSession(stores, 'sess-real');
    const call = remover(stores);

    const reply = await call({
      sessionIds: ['sess-real'],
      summary: 'もう要らないので消した',
      dryRun: false,
    });

    expect(reply).toContain('1 件');
    expect(await stores.archive.read(oldId)).toMatchObject({ kind: 'removed' });
    expect(await stores.archive.read(newId)).toEqual({ kind: 'body', body: 'AAABBB' });

    const texts = await decisionTexts(stores);
    const entry = texts.find((t) => t.includes(oldId));
    expect(entry).toBeDefined();
    expect(entry).toContain('もう要らないので消した');
    expect(texts.some((t) => t.includes('AAABBB'))).toBe(false);
  });

  it('消したバイト数の文言は、置き場で解放した量ではないと明記する（#2074）', async () => {
    const stores = createMemoryStores();
    await seedRemovableSession(stores, 'sess-bytes-label');
    const call = remover(stores);

    const reply = await call({
      sessionIds: ['sess-bytes-label'],
      summary: 'バイト数の文言を確かめる',
      dryRun: false,
    });

    expect(reply).toContain('置き場で解放した量ではなく');
    expect(reply).toContain('storedBytes');
  });

  it('走行中のマネージャーが使っている行は飛ばして数える（overrideReason 無し）', async () => {
    const stores = createMemoryStores();
    const { oldId, newId } = await seedRemovableSession(stores, 'sess-running');
    const managers = {
      runningManagerOwning: (archiveId: string) =>
        archiveId === oldId ? 'mgr-running-1' : undefined,
    } as unknown as ManagerPool;
    const call = remover(stores, managers);

    const reply = await call({
      sessionIds: ['sess-running'],
      summary: '掃除',
      dryRun: false,
    });

    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
    expect(await stores.archive.read(newId)).toEqual({ kind: 'body', body: 'AAABBB' });
    expect(reply).toContain('inUse');
    expect(reply).toContain('0 件');
  });

  it('一括に override の口は無い——入力の形に overrideReason が無く、渡しても開かない', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-no-override');
    const managers = {
      runningManagerOwning: (archiveId: string) =>
        archiveId === oldId ? 'mgr-running-2' : undefined,
    } as unknown as ManagerPool;

    expect(Object.keys(inputShape(stores))).not.toContain('overrideReason');

    const reply = await remover(
      stores,
      managers,
    )({
      sessionIds: ['sess-no-override'],
      summary: '掃除',
      dryRun: false,
      overrideReason: '理由を書けば通ると思った',
    });

    expect(reply).toContain('inUse(走行中) 1');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
    expect((await decisionTexts(stores)).some((t) => t.includes(oldId))).toBe(false);
    expect(reply).toContain('archive_remove（単発）');
    expect(reply).toContain('overrideReason');
  });

  it('managers が配線されていない場面は安全側に倒して消さない', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-no-pool');
    const call = remover(stores, null);

    const reply = await call({
      sessionIds: ['sess-no-pool'],
      summary: '掃除',
      dryRun: false,
    });

    expect(reply).toContain('inUse');
    expect(reply).toContain('0 件');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it('絞り込みに当たる行が0件なら、その旨を言って1件も消さない', async () => {
    const stores = createMemoryStores();
    await seedRemovableSession(stores, 'sess-other');
    const call = remover(stores);

    const reply = await call({
      sessionIds: ['sess-does-not-exist'],
      summary: '絞り込みが外れている',
      dryRun: false,
    });

    expect(reply).toContain('0件だった');
    expect(reply).toContain('1件も消していない');
  });

  it('before が ISO8601 として読めない場合は断る', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-bad-before');
    const call = remover(stores);

    const reply = await call({
      before: 'not-a-date',
      summary: '掃除',
      dryRun: false,
    });

    expect(reply).toContain('日時として読めない');
    expect(reply).toContain('ISO 8601');
    expect(reply).toContain('1件も消していない');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });
  it('数の帳尻: 当たった件数 === 対象 + remaining + skipped5欄（下見でも実行でも）', async () => {
    const stores = createMemoryStores();
    const { oldId: chainOld } = await seedRemovableSession(stores, 'sess-inv-chain');
    const { oldId: runningOld } = await seedRemovableSession(stores, 'sess-inv-run');
    const { oldId: goneOld } = await seedRemovableSession(stores, 'sess-inv-gone');
    await stores.archive.remove(goneOld);
    await stores.archive.archive('sess-inv-div', 'XYZ');
    await stores.archive.archive('sess-inv-div', 'QQQ');
    const managers = {
      runningManagerOwning: (archiveId: string) =>
        archiveId === runningOld ? 'mgr-inv' : undefined,
    } as unknown as ManagerPool;
    const call = remover(stores, managers);

    const numbersOf = (reply: string) => {
      const pick = (re: RegExp) => {
        const hit = re.exec(reply);
        expect(hit, `${re} が文面に無い: ${reply}`).not.toBeNull();
        return Number(hit?.[1]);
      };
      const skipped =
        /skipped: protected\(墓標\) (\d+) \/ alreadyRemoved (\d+) \/ newest (\d+) \/ notContained (\d+) \/ inUse\(走行中\) (\d+)/.exec(
          reply,
        );
      expect(skipped, `skipped 行が文面に無い: ${reply}`).not.toBeNull();
      return {
        matched: pick(/絞り込みで (\d+) 件/),
        remaining: pick(/対象にすらならなかった件数）: (\d+)/),
        skipped: {
          protected: Number(skipped?.[1]),
          alreadyRemoved: Number(skipped?.[2]),
          newest: Number(skipped?.[3]),
          notContained: Number(skipped?.[4]),
          inUse: Number(skipped?.[5]),
        },
      };
    };
    const skippedTotal = (n: ReturnType<typeof numbersOf>) =>
      n.skipped.protected +
      n.skipped.alreadyRemoved +
      n.skipped.newest +
      n.skipped.notContained +
      n.skipped.inUse;

    const preview = await call({ minStoredBytes: 0, summary: '帳尻を撃つ' });
    const previewNumbers = numbersOf(preview);
    const previewTargeted = Number(/この呼びで消すのは (\d+) 件/.exec(preview)?.[1]);
    expect(previewTargeted + previewNumbers.remaining + skippedTotal(previewNumbers)).toBe(
      previewNumbers.matched,
    );
    expect(previewNumbers.skipped.newest).toBeGreaterThan(0);
    expect(previewNumbers.skipped.alreadyRemoved).toBeGreaterThan(0);
    expect(previewNumbers.skipped.notContained).toBeGreaterThan(0);
    expect(previewNumbers.skipped.inUse).toBeGreaterThan(0);
    expect(previewTargeted).toBeGreaterThan(0);

    const executed = await call({ minStoredBytes: 0, summary: '帳尻を撃つ', dryRun: false });
    const executedNumbers = numbersOf(executed);
    const removed = Number(/\*\*(\d+) 件の本文を tombstone した\*\*/.exec(executed)?.[1]);
    expect(executed).not.toContain('は消せなかった');
    expect(removed + executedNumbers.remaining + skippedTotal(executedNumbers)).toBe(
      executedNumbers.matched,
    );
    expect(removed).toBe(previewTargeted);
    expect(executedNumbers.skipped.inUse).toBe(previewNumbers.skipped.inUse);
    expect(await stores.archive.read(chainOld)).toMatchObject({ kind: 'removed' });
    expect(await stores.archive.read(runningOld)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it('多数件（220件）を一括で消すと、消した id が全部・過不足なく日誌に残る（2件以上に分割）', async () => {
    const stores = createMemoryStores();
    const ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS_COPY = 3_600;
    const SESSION_COUNT = 220;
    vi.useFakeTimers();
    const baseTime = new Date('2026-01-01T00:00:00.000Z').getTime();
    let tick = 0;
    const nextTime = () => {
      tick += 1;
      return baseTime + tick;
    };
    vi.setSystemTime(nextTime());
    const oldIds: string[] = [];
    try {
      for (let i = 0; i < SESSION_COUNT; i += 1) {
        const sessionId = `sess-archive-flood-${String(i).padStart(4, '0')}-${'x'.repeat(20)}`;
        const oldRow = await stores.archive.archive(sessionId, 'AAA');
        vi.setSystemTime(nextTime());
        const newRow = await stores.archive.archive(sessionId, 'AAABBB');
        vi.setSystemTime(nextTime());
        expect(newRow.continuity, '前方一致の前提が崩れている（テストの組み立てミス）').toBe(
          'continues',
        );
        oldIds.push(oldRow.id);
      }
    } finally {
      vi.useRealTimers();
    }

    const reply = await remover(stores)({
      minStoredBytes: 0,
      summary: `${SESSION_COUNT}件を一括で畳んだ`,
      dryRun: false,
    });

    expect(reply).toContain('全 id は日誌に');

    const texts = await decisionTexts(stores);
    expect(texts.length).toBeGreaterThanOrEqual(2);

    for (const text of texts) expect(text).toContain('消した id: ');

    const seen = new Set<string>();
    for (const text of texts) {
      const idsPart = text.slice(text.indexOf('消した id: ') + '消した id: '.length);
      for (const id of idsPart.split(' ')) if (id.length > 0) seen.add(id);
    }
    expect(seen.size).toBe(oldIds.length);
    expect(seen).toEqual(new Set(oldIds));

    for (const text of texts) {
      const idsPart = text.slice(text.indexOf('消した id: ') + '消した id: '.length);
      expect(idsPart.length).toBeLessThanOrEqual(ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS_COPY + 60);
    }

    const claimed = Number(/全 id は日誌に (\d+) 件に分けて残してある/.exec(reply)?.[1]);
    expect(claimed).toBe(texts.length);

    for (const id of oldIds) {
      expect(await stores.archive.read(id)).toMatchObject({ kind: 'removed' });
    }
  });
});

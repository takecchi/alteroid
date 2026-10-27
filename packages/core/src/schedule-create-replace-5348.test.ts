import { describe, expect, it } from 'vitest';

import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

const KIND = 'watch-5348';

function toolsOf(stores: Stores) {
  return createCloneTools({
    stores,
    emit: () => {},
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
}

async function create(
  stores: Stores,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const found = toolsOf(stores).find((entry) => entry.name === 'schedule_create');
  if (!found) throw new Error('schedule_create が無い');
  try {
    const result = await found.handler(args as never, {});
    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    return { isError: result.isError === true, text };
  } catch (error) {
    return { isError: true, text: error instanceof Error ? error.message : String(error) };
  }
}

async function decisionsOf(stores: Stores): Promise<string[]> {
  return (await stores.journal.list({ types: ['decision'], order: 'asc' })).flatMap((entry) =>
    entry.type === 'decision' ? [entry.decision] : [],
  );
}

describe('schedule_create が既存の kind を置き換えるとき（#5348）', () => {
  it('応答が「置き換えた」と言い、置き換え前の本文と周期を添える', async () => {
    const stores = createMemoryStores();
    await create(stores, { kind: KIND, request: '旧い本文', everyMinutes: 60 });

    const reply = await create(stores, { kind: KIND, request: '新しい本文', everyMinutes: 30 });

    expect(reply.isError).toBe(false);
    expect(reply.text).toContain('置き換えた');
    expect(reply.text).toContain('旧い本文');
    expect(reply.text).toContain('60 分ごと');
    expect(reply.text).toContain('30 分ごと');
    expect(reply.text).not.toContain('仕込んだ。');
    expect((await stores.schedules.get(KIND))?.request).toBe('新しい本文');
  });

  it('置き換え前の本文と周期が、置き換えの前に日誌（decision）へ逐語で残る', async () => {
    const stores = createMemoryStores();
    await create(stores, { kind: KIND, request: '旧い本文', everyMinutes: 60 });

    await create(stores, { kind: KIND, request: '新しい本文', dailyAt: '09:00' });

    const decisions = await decisionsOf(stores);
    const replacing = decisions.filter((line) =>
      line.startsWith('定期の依頼を置き換えようとしている'),
    );
    expect(replacing).toHaveLength(1);
    expect(replacing[0]).toContain('置き換え前（60 分ごと）「旧い本文」');
    expect(replacing[0]).toContain('「新しい本文」');
    // 置き換えの行は、置き換え後の「直した」の行より前に在る
    expect(decisions.indexOf(replacing[0]!)).toBeLessThan(
      decisions.findIndex((line) => line.startsWith('定期の依頼を直した')),
    );
  });

  it('長い旧本文は応答では抜粋にし、全文は日誌に逐語で残して取り方を言う', async () => {
    const stores = createMemoryStores();
    const longRequest = `長い本文の先頭。${'あ'.repeat(500)}末尾の印`;
    await create(stores, { kind: KIND, request: longRequest, everyMinutes: 60 });

    const reply = await create(stores, { kind: KIND, request: '短い本文', everyMinutes: 30 });

    expect(reply.text).toContain('置き換えた');
    expect(reply.text).not.toContain('末尾の印');
    expect(reply.text).toContain('文字省略');
    const replacing = (await stores.journal.list({ types: ['decision'], order: 'asc' })).find(
      (entry) => entry.type === 'decision' && entry.decision.startsWith('定期の依頼を置き換え'),
    );
    expect(replacing).toBeDefined();
    expect(reply.text).toContain(`journal_read id=${replacing?.id}`);
    expect(replacing?.type === 'decision' ? replacing.decision : '').toContain(longRequest);
  });

  it('日誌が書けないと置き換えず、旧い依頼がそのまま残る', async () => {
    const base = createMemoryStores();
    await create(base, { kind: KIND, request: '旧い本文', everyMinutes: 60 });
    const failing: Stores = {
      ...base,
      journal: {
        ...base.journal,
        append: () => Promise.reject(new Error('boom-5348')),
      },
    };

    const reply = await create(failing, { kind: KIND, request: '新しい本文', everyMinutes: 30 });

    expect(reply.isError).toBe(true);
    const kept = await base.schedules.get(KIND);
    expect(kept?.request).toBe('旧い本文');
    expect(kept?.spec).toEqual({ type: 'every', minutes: 60 });
  });

  it('新規作成の応答は変わらない', async () => {
    const stores = createMemoryStores();

    const reply = await create(stores, { kind: KIND, request: '本文', everyMinutes: 30 });

    expect(reply.isError).toBe(false);
    expect(reply.text).toBe(
      `${KIND} を 30 分ごと で仕込んだ。時刻が来たら依頼の本文とともに届く。`,
    );
    expect(await decisionsOf(stores)).toEqual([
      `定期の依頼を設定しようとしている: ${KIND}: 本文`,
      `定期の依頼を仕込んだ: ${KIND}（30 分ごと）: 本文`,
    ]);
  });

  it('読んだ後に別の書き手が直していたら、先の行を打ち消して読み直し、実際に上書きした本文を残す', async () => {
    const base = createMemoryStores();
    await create(base, { kind: KIND, request: '最初の本文', everyMinutes: 60 });
    let interfered = false;
    const racing: Stores = {
      ...base,
      schedules: {
        ...base.schedules,
        list: base.schedules.list.bind(base.schedules),
        get: base.schedules.get.bind(base.schedules),
        put: base.schedules.put.bind(base.schedules),
        remove: base.schedules.remove.bind(base.schedules),
        removeIfPresent: base.schedules.removeIfPresent.bind(base.schedules),
        claimRun: base.schedules.claimRun.bind(base.schedules),
        completeRun: base.schedules.completeRun.bind(base.schedules),
        getPhase: base.schedules.getPhase.bind(base.schedules),
        putPhase: base.schedules.putPhase.bind(base.schedules),
        async editRequest(kind, changes, updatedAt, options) {
          if (!interfered) {
            interfered = true;
            await base.schedules.editRequest(
              kind,
              { request: '他の担当が直した本文', spec: changes.spec },
              '2099-01-01T00:00:00.000Z',
            );
          }
          return base.schedules.editRequest(kind, changes, updatedAt, options);
        },
      },
    };

    const reply = await create(racing, { kind: KIND, request: '新しい本文', everyMinutes: 30 });

    expect(reply.text).toContain('置き換えた');
    expect(reply.text).toContain('他の担当が直した本文');
    const decisions = await decisionsOf(base);
    expect(decisions.some((line) => line.includes('「他の担当が直した本文」'))).toBe(true);
    expect(
      decisions.some((line) => line.startsWith('直前の定期の依頼の設定の行は効いていない')),
    ).toBe(true);
  });
});

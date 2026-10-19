import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Commitment } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// fs の置き場は片付き履歴に保持上限（CLOSED_HISTORY_LIMIT = 500）を持ち、1回で上限を超えて閉じると、閉じたばかりの行もその場で刈る。
// そのとき道具は「N 件を片付けた」とだけ答えると、閉じたと言った行が読めない（commitment_list id= が「台帳に無い」になる）。
// 刈った事実は置き場が `trimmedClosed` で申告する契約（`CommitmentStore` の doc）なので、それを読んで応答に書く

// 閉じた行のうち、閉じた順で `keep` 件を超えた分を刈る置き場（fs の保持上限の振る舞いを写した偽物）
function trimmingStores(keep: number): Stores {
  const stores = createMemoryStores();
  const base = stores.commitments;
  const closedOrder: string[] = [];
  const trimmed = new Set<string>();
  const trimNow = (): void => {
    while (closedOrder.length - trimmed.size > keep) {
      const victim = closedOrder.find((id) => !trimmed.has(id));
      if (victim === undefined) return;
      trimmed.add(victim);
    }
  };
  return {
    ...stores,
    commitments: {
      ...base,
      list: async (options) => {
        const listed = await base.list(options);
        return {
          ...listed,
          entries: listed.entries.filter((entry) => !trimmed.has(entry.id)),
          trimmedClosed: trimmed.size,
        };
      },
      get: async (id) => (trimmed.has(id) ? null : base.get(id)),
      closeMany: async (ids, at, reason, by) => {
        const closed = await base.closeMany(ids, at, reason, by);
        closedOrder.push(...closed);
        trimNow();
        return closed;
      },
    },
  };
}

function closer(stores: Stores) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'commitment_close_many');
  expect(found, 'commitment_close_many という道具が無い').toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

const external = (index: number): Commitment => ({
  id: randomUUID(),
  at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1000).toISOString(),
  origin: 'external',
  body: `仕事 ${index}`,
});

describe('commitment_close_many: 閉じた直後に保持上限で刈られた行があれば、そう言う', () => {
  it('⭐ 閉じた 30 件のうち 10 件が刈られたら、件数と「日誌に残っている」を言う', async () => {
    const stores = trimmingStores(20);
    for (let index = 0; index < 30; index += 1) await stores.commitments.open(external(index));

    const reply = await closer(stores)({
      origin: ['external'],
      reason: 'まとめて片付けた',
      dryRun: false,
    });

    expect(reply).toContain('**30 件を片付けた**');
    const warning = reply.split('\n').filter((line) => line.includes('保持上限'));
    expect(warning, reply).toHaveLength(1);
    expect(warning[0]).toContain('10 件');
    expect(warning[0]).toContain('日誌');
  });

  it('刈られていなければ、その行は出さない', async () => {
    const stores = trimmingStores(100);
    for (let index = 0; index < 30; index += 1) await stores.commitments.open(external(index));

    const reply = await closer(stores)({
      origin: ['external'],
      reason: 'まとめて片付けた',
      dryRun: false,
    });

    expect(reply).toContain('**30 件を片付けた**');
    expect(reply).not.toContain('保持上限');
  });

  it('前からの片付き履歴だけが刈られた回（閉じた行は全部読める）は、その行を出さない', async () => {
    const stores = trimmingStores(30);
    const old = Array.from({ length: 10 }, (_, index) => external(index));
    for (const entry of old) await stores.commitments.open(entry);
    await closer(stores)({ origin: ['external'], reason: '前の片付け', dryRun: false });
    for (let index = 10; index < 40; index += 1) await stores.commitments.open(external(index));

    const reply = await closer(stores)({
      origin: ['external'],
      reason: 'まとめて片付けた',
      dryRun: false,
    });

    expect(reply).toContain('**30 件を片付けた**');
    expect(reply).not.toContain('保持上限');
  });
});

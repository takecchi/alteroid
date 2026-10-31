import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  return {
    stores,
    description(name: string): string {
      return tools.find((entry) => entry.name === name)!.description;
    },
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('approvals_list は作成だけを出し、更新が出ない理由は説明文が言う（#5352）', () => {
  it('更新も、更新＝作成の説明の注記も応答に出ない。作成は各件に1つ', async () => {
    const h = harness();
    for (const n of [1, 2, 3]) {
      await h.stores.jobs.putApproval({
        id: `ap-${n}`,
        createdAt: `2026-05-0${n}T00:00:00.000Z`,
        question: `続けてよいか${n}`,
      });
    }
    const reply = await h.call('approvals_list', {});
    expect(reply).not.toContain('更新');
    for (const n of [1, 2, 3]) expect(count(reply, `2026-05-0${n}T00:00:00.000Z`)).toBe(1);
    expect(h.description('approvals_list')).toContain('更新はいつも作成と同じ');
  });
});

describe('practice_history は作成だけを出す（#5352）', () => {
  it('各版の時刻は1つ。更新は出ず、説明文が理由を言う', async () => {
    const h = harness();
    for (const content of ['一版', '二版']) {
      await h.stores.practices.write({ slug: 'daily', kind: '日報', title: '日報', content });
    }
    const reply = await h.call('practice_history', { slug: 'daily' });
    expect(reply).toContain('版1');
    expect(reply).toContain('版2');
    expect(reply).not.toContain('更新');
    expect(count(reply, '作成: ')).toBe(2);
    expect(h.description('practice_history')).toContain('更新はいつも作成と同じ');
  });
});

import { describe, expect, it } from 'vitest';

import type { ChatStreamEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { CLONE_ALLOWED_TOOLS, createCloneTools, qualifiedToolName } from './tools.js';

interface Harness {
  stores: Stores;
  emitted: ChatStreamEvent[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

function harness(): Harness {
  const stores = createMemoryStores();
  const emitted: ChatStreamEvent[] = [];
  const tools = createCloneTools({ stores, emit: (event) => emitted.push(event) });

  return {
    stores,
    emitted,
    async call(name, args) {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

describe('クローンの道具', () => {
  it('モデルから見える名前は mcp__alteroid__* である', () => {
    expect(qualifiedToolName('ask_human')).toBe('mcp__alteroid__ask_human');
    expect(CLONE_ALLOWED_TOOLS).toContain('mcp__alteroid__memory_write');
  });

  it('memory_write は記憶を更新し、日誌に memory_update を残す', async () => {
    const h = harness();

    await h.call('memory_write', {
      slug: 'values',
      content: '# 価値観\n\n速さより正しさ\n',
      summary: '価値観を書いた',
    });

    expect((await h.stores.persona.read('values'))?.content).toContain('速さより正しさ');
    const [entry] = await h.stores.journal.list({ types: ['memory_update'] });
    expect(entry).toMatchObject({ type: 'memory_update', slug: 'values', cause: 'clone' });
  });

  it('memory_append は既存の記述を消さない（人間の手書きを守る）', async () => {
    const h = harness();
    await h.stores.persona.write('values', '# 価値観\n\n人間が手で書いた\n');

    await h.call('memory_append', {
      slug: 'values',
      content: '- クローンが足した学び',
      summary: '学びを追記',
    });

    const content = (await h.stores.persona.read('values'))?.content ?? '';
    expect(content).toContain('人間が手で書いた');
    expect(content).toContain('クローンが足した学び');
  });

  it('journal_write は判断を日誌に残す（聞かずに実行した判断の記録）', async () => {
    const h = harness();

    await h.call('journal_write', {
      decision: '人間に聞かずに設定を変えた',
      grounds: 'about-me.md に「設定変更は任せる」とある',
    });

    const [entry] = await h.stores.journal.list({ types: ['decision'] });
    expect(entry).toMatchObject({ type: 'decision', grounds: expect.stringContaining('about-me') });
  });

  it('ask_human は承認待ちに積み、日誌に残し、chat へ通知する（応答は待たない）', async () => {
    const h = harness();

    const reply = await h.call('ask_human', { question: 'これを送ってよいか' });

    const pending = await h.stores.jobs.listApprovals({ pendingOnly: true });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.question).toBe('これを送ってよいか');

    const [escalation] = await h.stores.journal.list({ types: ['escalation'] });
    expect(escalation).toMatchObject({ type: 'escalation', question: 'これを送ってよいか' });

    expect(h.emitted).toEqual([
      { type: 'ask_human', approvalId: pending[0]?.id, question: 'これを送ってよいか' },
    ]);
    // 積むだけ。ここでブロックしない（止まるのはその仕事だけ）
    expect(reply).toContain('承認待ちキューに積んだ');
  });

  it('manager_* は M2 まで未実装だと自己申告する（能力の欠落を黙らせない）', async () => {
    const h = harness();

    for (const name of ['manager_start', 'manager_send', 'manager_list']) {
      const reply = await h.call(name, { request: 'x', managerId: 'm', message: 'y' });
      expect(reply).toContain('M2');
    }
  });
});

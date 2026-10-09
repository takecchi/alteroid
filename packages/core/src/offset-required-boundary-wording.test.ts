import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  return {
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

function expectAlignedRefusal(reply: string): void {
  expect(reply).not.toContain('ISO8601 として読めない');
  expect(reply).toContain('ISO 8601 で指定する');
  expect(reply).toContain('受け付ける形の例');
  expect(reply).toContain('実在しない日付も断る');
  expect(reply).toContain('時差が無い');
  expect(reply).toContain('時差 Z か +09:00 を必ず書くこと');
  expect(reply).toContain('+09:00');
  expect(reply).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
}

describe('inbox_remove_many の before を断る文言（ほかの消す口と揃える）', () => {
  it.each([['あした'], ['2026-02-31T00:00:00Z'], ['2026-10-06T09:00']])(
    '読めない・時差の無い before「%s」の断りは、受け付ける形の例と実在しない日付の断りを言う',
    async (before) => {
      const h = harness();
      const reply = await h.call('inbox_remove_many', {
        types: ['manager_message'],
        before,
        reason: '古い合図の整理',
        dryRun: true,
      });
      expect(reply).toContain(`before に渡された「${before}」は日時として読めない`);
      expect(reply).toContain('1件も消していない');
      expectAlignedRefusal(reply);
    },
  );
});

describe('commitment_close_many の until を断る文言（ほかの消す口と揃える）', () => {
  it.each([['あした'], ['2026-02-31T00:00:00Z'], ['2026-10-06T09:00']])(
    '読めない・時差の無い until「%s」の断りは、受け付ける形の例と実在しない日付の断りを言う',
    async (until) => {
      const h = harness();
      const reply = await h.call('commitment_close_many', {
        origin: ['external'],
        until,
        reason: '古い約束の整理',
        dryRun: true,
      });
      expect(reply).toContain(`until に渡された「${until}」は日時として読めない`);
      expect(reply).toContain('1件も閉じていない');
      expectAlignedRefusal(reply);
    },
  );
});

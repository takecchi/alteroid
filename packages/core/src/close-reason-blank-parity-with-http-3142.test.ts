import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * 「閉じる理由」を取る道具のうち、`commitment_close_many` が空白だけの reason を通す取りこぼし。
 * HTTP の `POST /commitments/:id/close` は `nonBlankString`（#3142）で空白だけを 400 にし、道具の
 * `commitment_close` も #3544 で揃えた。同じ `closedReason` を書く `commitment_close_many` は未対応。
 */
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
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

const AT = '2026-10-07T00:00:00.000Z';
const BLANK = [' ', '   ', '\t\n', '　', ' \u0000 '];

describe('commitment_close_many の reason は空白だけを断る（commitment_close・HTTP と同じ）', () => {
  it.each(BLANK)('reason %j は断り、1件も閉じない', async (reason) => {
    const h = harness();
    await h.stores.commitments.open({ id: 'c1', at: AT, origin: 'external', body: '本文' });
    const out = await h.call('commitment_close_many', {
      origin: ['external'],
      until: '2026-12-31T00:00:00.000Z',
      reason,
      dryRun: false,
    });
    expect(out).toContain('reason は使えない');
    expect((await h.stores.commitments.get('c1'))?.closedAt).toBeUndefined();
  });
});

describe('参考: 先に揃えてある commitment_close は同じ値を断る（この枝でも緑のはず）', () => {
  it.each(BLANK)('reason %j', async (reason) => {
    const h = harness();
    await h.stores.commitments.open({ id: 'c1', at: AT, origin: 'self', body: '本文' });
    const out = await h.call('commitment_close', { id: 'c1', reason });
    expect(out).toContain('reason は使えない');
  });
});

import { describe, expect, it } from 'vitest';

import type { ManagerPool } from './manager.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * Issue #3544。クローンの道具を HTTP の検めに揃える。
 * - `commitment_close` の `reason`: `POST /commitments/:id/close` は `nonBlankString`（#3142）
 *   なので、空白だけ・NUL だけ・空文字は断る。
 * - `manager_send` の `message`: `POST /managers/:id/messages` は `min(1)` と「NUL を落として空なら断る」
 *   （#3461）。空白だけは HTTP も通すので、道具も通す（HTTP より厳しくしない）。
 */
function harness() {
  const stores = createMemoryStores();
  const sent: { managerId: string; message: string }[] = [];
  const managers = {
    async send(managerId: string, message: string) {
      sent.push({ managerId, message });
      return { outcome: 'answered' as const, detail: '回答した。' };
    },
  } as unknown as ManagerPool;
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers,
  });
  return {
    stores,
    sent,
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const found = tools.find((entry) => entry.name === name);
      if (!found) throw new Error(`ツール ${name} が無い`);
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

const AT = '2026-10-07T00:00:00.000Z';

describe('commitment_close の reason は HTTP と同じく空白だけを断る（#3544）', () => {
  it.each([' ', '   ', '\t\n', '　', ' \u0000 ', '', '\u0000'])(
    'reason %j は断り、閉じない',
    async (reason) => {
      const h = harness();
      await h.stores.commitments.open({ id: 'c1', at: AT, origin: 'self', body: '本文' });
      const out = await h.call('commitment_close', { id: 'c1', reason });
      expect(out).toContain('reason は使えない');
      expect((await h.stores.commitments.get('c1'))?.closedAt).toBeUndefined();
      const rows = await h.stores.journal.list({ types: ['decision'] });
      expect(rows.some((row) => JSON.stringify(row).includes('自分で片付けた'))).toBe(false);
    },
  );

  it('実のある reason は従来どおり閉じられ、値は trim されない', async () => {
    const h = harness();
    await h.stores.commitments.open({ id: 'c1', at: AT, origin: 'self', body: '本文' });
    const out = await h.call('commitment_close', { id: 'c1', reason: ' 済んだ ' });
    expect(out).not.toContain('reason は使えない');
    const row = await h.stores.commitments.get('c1');
    expect(row?.closedAt).toBeDefined();
    expect(row?.closedReason).toBe(' 済んだ ');
  });
});

describe('manager_send の message は HTTP と同じく空文字・NUL だけを断る（#3544）', () => {
  it.each(['', '\u0000', '\u0000\u0000'])('message %j は断り、送らない', async (message) => {
    const h = harness();
    const out = await h.call('manager_send', { managerId: 'mgr-1', message });
    expect(out).toContain('message は使えない');
    expect(h.sent).toEqual([]);
  });

  it.each(['続けて', ' ', 'a\u0000b'])('message %j は従来どおり送る', async (message) => {
    const h = harness();
    const out = await h.call('manager_send', { managerId: 'mgr-1', message });
    expect(out).not.toContain('message は使えない');
    expect(h.sent).toEqual([{ managerId: 'mgr-1', message }]);
  });
});

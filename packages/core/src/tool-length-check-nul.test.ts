import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

/**
 * 道具の入口の長さ検査（`describeStringLengthViolation`）は NUL を落とした後の値で数える
 * （issue #3435。#3361 / #3384 / #3388 と同じ形）。ストアは NUL を落として残すので、
 * NUL を落とす前の値で数えると NUL だけの理由・本文が空として保存される。
 * `commitment_open` / `commitment_edit` の body は別枝（呼び出し側で `stripNul` を渡す）なので、ここでは持たない。
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

const AT = '2026-10-06T00:00:00.000Z';
const NUL_ONLY = ['\u0000', '\u0000\u0000'];

describe('NUL だけの理由・本文を、道具が空として残す', () => {
  it('commitment_close: reason が NUL だけなら、空の closedReason で閉じない', async () => {
    const h = harness();
    await h.stores.commitments.open({ id: 'c1', at: AT, origin: 'self', body: '本文' });
    const out = await h.call('commitment_close', { id: 'c1', reason: '\u0000' });
    expect(out).toContain('reason は使えない');
    expect((await h.stores.commitments.get('c1'))?.closedReason).toBeUndefined();
  });

  it('commitment_close_many: reason が NUL だけなら、空の closedReason で閉じない', async () => {
    const h = harness();
    await h.stores.commitments.open({ id: 'c2', at: AT, origin: 'external', body: '本文' });
    const out = await h.call('commitment_close_many', {
      origin: ['external'],
      until: '2026-12-31T00:00:00.000Z',
      reason: '\u0000',
      dryRun: false,
    });
    expect(out).toContain('reason は使えない');
    expect((await h.stores.commitments.get('c2'))?.closedReason).toBeUndefined();
  });

  it('approval_withdraw: reason が NUL だけなら、空の withdrawnReason で取り下げない', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({ id: 'ap1', createdAt: AT, question: '質問' });
    const out = await h.call('approval_withdraw', { id: 'ap1', reason: '\u0000' });
    expect(out).toContain('reason は使えない');
    expect((await h.stores.jobs.getApproval('ap1'))?.withdrawnReason).toBeUndefined();
  });

  it('conversation_post: text が NUL だけなら、空の発言を日誌へ残さない', async () => {
    const h = harness();
    const out = await h.call('conversation_post', { text: '\u0000' });
    expect(out).toContain('text は使えない');
    const rows = await h.stores.journal.list({ types: ['exchange'] });
    expect(rows).toEqual([]);
  });

  it.each(NUL_ONLY)('inbox_remove_many: reason %j は断る', async (reason) => {
    const h = harness();
    const out = await h.call('inbox_remove_many', {
      types: ['manager_message'],
      reason,
      dryRun: false,
    });
    expect(out).toContain('reason は使えない');
  });

  it.each(NUL_ONLY)('archive_remove_many: summary %j は断る', async (summary) => {
    const h = harness();
    const out = await h.call('archive_remove_many', {
      sessionIds: ['s1'],
      summary,
      dryRun: false,
    });
    expect(out).toContain('summary は使えない');
  });
});

describe('NUL が混じっても中身が残る値は今までどおり通る', () => {
  it('commitment_close: reason "a\\0b" は閉じ、NUL を落とした値が残る', async () => {
    const h = harness();
    await h.stores.commitments.open({ id: 'c1', at: AT, origin: 'self', body: '本文' });
    const out = await h.call('commitment_close', { id: 'c1', reason: 'a\u0000b' });
    expect(out).not.toContain('は使えない');
    expect((await h.stores.commitments.get('c1'))?.closedReason).toBe('ab');
  });

  it('commitment_close_many: reason は長さ検査を通る', async () => {
    const h = harness();
    const out = await h.call('commitment_close_many', {
      origin: ['external'],
      until: '2026-12-31T00:00:00.000Z',
      reason: 'a\u0000',
    });
    expect(out).not.toContain('reason は使えない');
  });

  it('approval_withdraw: reason は取り下げに通り、NUL を落とした値が残る', async () => {
    const h = harness();
    await h.stores.jobs.putApproval({ id: 'ap1', createdAt: AT, question: '質問' });
    const out = await h.call('approval_withdraw', { id: 'ap1', reason: '\u0000x' });
    expect(out).not.toContain('reason は使えない');
    expect((await h.stores.jobs.getApproval('ap1'))?.withdrawnReason).toBe('x');
  });

  it('conversation_post: text は長さ検査を通る', async () => {
    const h = harness();
    const out = await h.call('conversation_post', { text: 'こん\u0000にちは' });
    expect(out).not.toContain('text は使えない');
  });

  it('inbox_remove_many: reason は長さ検査を通る', async () => {
    const h = harness();
    const out = await h.call('inbox_remove_many', {
      types: ['manager_message'],
      reason: 'a\u0000',
    });
    expect(out).not.toContain('reason は使えない');
  });

  it('archive_remove_many: summary は長さ検査を通る', async () => {
    const h = harness();
    const out = await h.call('archive_remove_many', { sessionIds: ['s1'], summary: '\u0000a' });
    expect(out).not.toContain('summary は使えない');
  });
});

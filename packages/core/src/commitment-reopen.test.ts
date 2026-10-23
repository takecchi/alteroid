import { describe, expect, it } from 'vitest';

import type { ManagerPool } from './manager.js';
import { UnreadableCommitmentError } from './store.js';
import type { CommitmentStore } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function harness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers: {} as unknown as ManagerPool,
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
const CLOSED_AT = '2026-10-07T01:00:00.000Z';

async function closedRow(stores: ReturnType<typeof createMemoryStores>) {
  await stores.commitments.open({
    id: 'c1',
    at: AT,
    origin: 'manager',
    source: 'mgr-1',
    body: '本文',
    autoCloseWhenBack: { managerId: 'mgr-1' },
  });
  await stores.commitments.close('c1', CLOSED_AT, '器が閉じた', 'daemon');
}

describe('commitment_reopen（#5176）', () => {
  it('閉じた行を未了へ戻し、開き直す前の閉じた記録を日誌へ逐語で残す', async () => {
    const h = harness();
    await closedRow(h.stores);
    const out = await h.call('commitment_reopen', { id: 'c1', reason: 'まだ終わっていない' });
    expect(out).toContain('開き直した');
    const row = await h.stores.commitments.get('c1');
    expect(row?.closedAt).toBeUndefined();
    expect(row?.autoCloseWhenBack).toBeUndefined();
    expect(row?.at).toBe(AT);
    const rows = await h.stores.journal.list({ types: ['decision'] });
    const text = JSON.stringify(rows);
    expect(text).toContain('まだ終わっていない');
    expect(text).toContain(`closedAt=${CLOSED_AT}`);
    expect(text).toContain('closedBy=daemon');
    expect(text).toContain('closedReason=器が閉じた');
  });

  it('未了の行は何もせず日誌にも残さない', async () => {
    const h = harness();
    await h.stores.commitments.open({ id: 'c1', at: AT, origin: 'self', body: '本文' });
    const out = await h.call('commitment_reopen', { id: 'c1', reason: '戻す' });
    expect(out).toContain('閉じていない');
    const rows = await h.stores.journal.list({ types: ['decision'] });
    expect(JSON.stringify(rows)).not.toContain('開き直した');
  });

  it.each([' ', '\t\n', ''])('reason %j は断り、開き直さない', async (reason) => {
    const h = harness();
    await closedRow(h.stores);
    const out = await h.call('commitment_reopen', { id: 'c1', reason });
    expect(out).toContain('reason は使えない');
    expect((await h.stores.commitments.get('c1'))?.closedAt).toBe(CLOSED_AT);
  });

  it('同じ担当・同じ本文の未了の行が在れば、開き直さずその id を言う', async () => {
    const h = harness();
    const base = { at: AT, origin: 'manager', source: 'mgr-1', body: '同じ本文' } as const;
    await h.stores.commitments.open({ ...base, id: 'old' });
    await h.stores.commitments.close('old', CLOSED_AT, '片付けた', 'clone');
    await h.stores.commitments.open({ ...base, id: 'new' });
    const out = await h.call('commitment_reopen', { id: 'old', reason: '戻す' });
    expect(out).toContain('new');
    expect(out).toContain('開き直していない');
    expect((await h.stores.commitments.get('old'))?.closedAt).toBe(CLOSED_AT);
  });

  it('無い id は台帳に無いと言う', async () => {
    const h = harness();
    const out = await h.call('commitment_reopen', { id: 'nope', reason: '戻す' });
    expect(out).toContain('台帳に');
  });

  it('読めない行は書き直さず、開き直していないと言う', async () => {
    const h = harness();
    const unreadable: CommitmentStore = {
      ...h.stores.commitments,
      async reopen() {
        throw new UnreadableCommitmentError('引き受けた仕事 c1 が読めない形で入っている');
      },
    };
    const tools = createCloneTools({
      stores: { ...h.stores, commitments: unreadable },
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
      managers: {} as unknown as ManagerPool,
    });
    const found = tools.find((entry) => entry.name === 'commitment_reopen');
    const result = await found?.handler({ id: 'c1', reason: '戻す' } as never, {});
    const out = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(out).toContain('開き直していない');
  });
});

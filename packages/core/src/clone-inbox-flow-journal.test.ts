import { describe, it, expect } from 'vitest';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitForDone } from './clone-test-harness.js';

// `inbox_flow`（受信箱の到着・配達・消し込み・滞留）は新しく書かない。種別は古い行を読むために schema に残す
describe('inbox_flow は新しい日誌に書かない', () => {
  it('ターンを2回回しても、日誌に inbox_flow の行が1行も増えない（ターンの記録そのものは書かれる）', async () => {
    const s = setup(() => 'わかった');
    s.clone.post(humanMessage('1件目'));
    await waitForDone(s.events);
    s.clone.post(humanMessage('2件目'));
    await waitForDone(s.events);
    await s.clone.stop();

    expect(await s.stores.journal.list({ types: ['inbox_flow'] })).toEqual([]);
    const all = await s.stores.journal.list({});
    expect(all.some((entry) => entry.type === 'turn_usage' || entry.type === 'exchange')).toBe(
      true,
    );
    expect(all.filter((entry) => entry.type === 'inbox_flow')).toEqual([]);
  });

  it('過去に書かれた inbox_flow の行は、新しい行と並んでいても読み込みを壊さない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'inbox_flow',
      windowStartedAt: '2026-01-01T00:00:00.000Z',
      arrived: { total: 1, byType: [{ type: 'human_message', count: 1 }] },
      delivered: { total: 1, byType: [{ type: 'human_message', count: 1 }] },
      settled: { total: 0, byType: [] },
      pending: { count: 0 },
    });

    const s = setup(() => 'わかった', stores);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await s.clone.stop();

    const rows = await stores.journal.list({});
    expect(rows.filter((entry) => entry.type === 'inbox_flow')).toHaveLength(1);
    expect(rows.some((entry) => entry.type === 'exchange')).toBe(true);
  });
});

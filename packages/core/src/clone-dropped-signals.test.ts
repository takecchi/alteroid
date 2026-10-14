import { describe, expect, it } from 'vitest';

import { setup, waitFor } from './clone-test-harness.js';
import { describeDroppedSignals, digestOfDroppedSignal } from './dropped-signals.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';

function report(id: string, text: string): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date().toISOString(),
    managerId: 'mgr-4633',
    kind: 'report',
    text,
    requestId: 'req-1',
  };
}

const NOTICE = '[system] 前のターンが枠以外の理由で失敗したので';

describe('失敗したターンで外れた合図の要旨（#4633 の案C）', () => {
  it('要旨は種類・送り主・本文の冒頭・requestId を持ち、回答と蒸留は載せない', () => {
    const digest = digestOfDroppedSignal(report('evt-r', `報告の本文 ${'あ'.repeat(500)}`));
    expect(digest).toMatchObject({
      id: 'evt-r',
      type: 'manager_message',
      from: '担当 mgr-4633（report）',
      requestId: 'req-1',
    });
    expect(digest?.head.length).toBeLessThanOrEqual(201);
    expect(
      digestOfDroppedSignal({
        type: 'human_answer',
        id: 'a',
        at: '2026-10-14T00:00:00.000Z',
        approvalId: 'ap',
        answer: 'はい',
      }),
    ).toBeNull();
    expect(
      digestOfDroppedSignal({
        type: 'distill',
        id: 'd',
        at: '2026-10-14T00:00:00.000Z',
        reason: 'scheduled',
      }),
    ).toBeNull();
    expect(describeDroppedSignals([], 0)).toBe('');
    expect(describeDroppedSignals([], 3)).toContain('ほかに 3 件');
  });

  it('⭐ 報告のターンが枠以外の理由で失敗したら、次の通常ターンの入力に要旨を1度添え、日誌に1行残す。届いた後のターンには添えない', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultFor: (turnIndex) =>
        turnIndex < 1
          ? { subtype: 'error_during_execution', text: 'API Error: 500 Internal server error' }
          : undefined,
    });
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(report('evt-report', '消えてはいけない報告の本文'));
    await waitFor(async () => {
      const rows = await stores.journal.list({ types: ['exchange'] });
      return rows.some((row) => JSON.stringify(row).includes('処理されないまま受信箱から外した'));
    }, '外した合図の日誌の行');

    s.clone.post(humanMessage('次の発言'));
    await waitFor(() => inputs().some((text) => text.includes('次の発言')), '次のターン');
    const next = inputs().find((text) => text.includes('次の発言')) ?? '';
    expect(next).toContain(NOTICE);
    expect(next).toContain('担当 mgr-4633（report）');
    expect(next).toContain('requestId=req-1');
    expect(next).toContain('消えてはいけない報告の本文');

    s.clone.post(humanMessage('その次の発言'));
    await waitFor(() => inputs().some((text) => text.includes('その次の発言')), 'その次のターン');
    const after = inputs().find((text) => text.includes('その次の発言')) ?? '';
    expect(after).not.toContain(NOTICE);
    await s.clone.stop();
  });

  it('要旨を添えたターンもまた失敗したら、次のターンにもう一度添える', async () => {
    const stores = createMemoryStores();
    const s = setup(undefined, stores, {
      resultFor: (turnIndex) =>
        turnIndex < 2
          ? { subtype: 'error_during_execution', text: 'API Error: 500 Internal server error' }
          : undefined,
    });
    const inputs = () => s.calls.flatMap((call) => call.inputs);

    s.clone.post(report('evt-report', '二度目でも残る報告'));
    s.clone.post(humanMessage('失敗する発言'));
    await waitFor(() => inputs().some((text) => text.includes('失敗する発言')), '2本目のターン');
    s.clone.post(humanMessage('通る発言'));
    await waitFor(() => inputs().some((text) => text.includes('通る発言')), '3本目のターン');

    const third = inputs().find((text) => text.includes('通る発言')) ?? '';
    expect(third).toContain('二度目でも残る報告');
    expect(third).toContain('失敗する発言');
    await s.clone.stop();
  });
});

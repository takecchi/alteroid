import { describe, expect, it } from 'vitest';

import { ORIGIN_CONVERSATION_GUIDE, REPORT_FOLLOW_UP_GUIDE } from './clone.js';
import { setup, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';

const AT = '2026-10-28T00:00:00.000Z';

function job(id: string, conversationId?: string): Job {
  return {
    id,
    managerId: id,
    createdAt: AT,
    updatedAt: AT,
    status: 'done',
    summary: `${id} の依頼`,
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

function report(index: number, managerId: string): InboxEvent {
  return {
    type: 'manager_message',
    id: `r${String(index)}`,
    at: new Date().toISOString(),
    managerId,
    kind: 'report',
    text: `${managerId} の報告の本文 ${String(index)}`,
  };
}

/** 先客のターンを走らせてから合図を一度に積み、束のターン（2本目の入力）を返す。 */
async function mergedInput(
  jobs: readonly Job[],
  events: readonly InboxEvent[],
): Promise<{ merged: string; stop: () => Promise<void> }> {
  const stores = createMemoryStores();
  for (const entry of jobs) await stores.jobs.putJob(entry);
  const s = setup(undefined, stores);
  s.clone.post(humanMessage('先客'));
  await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '先客のターンが投げられる');
  for (const event of events) s.clone.post(event);
  const last = events[events.length - 1];
  const lastText = last?.type === 'manager_message' ? last.text : '';
  await waitFor(
    () => ((s.calls[0] as FakeCall).inputs[1] ?? '').includes(lastText),
    '束のターンが投げられる',
  );
  return { merged: (s.calls[0] as FakeCall).inputs[1] ?? '', stop: () => s.clone.stop() };
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('混合の束 — 同じ起点の会話の2件目以降は固定の枠を畳む', () => {
  it('起点が同じ3件: 枠と案内は1件目だけ全文。名前・時刻・経過・起点の id・本文は毎件出る', async () => {
    const { merged, stop } = await mergedInput(
      [job('mgr-A', 'conv-1'), job('mgr-B', 'conv-1'), job('mgr-C', 'conv-1')],
      [report(1, 'mgr-A'), report(2, 'mgr-B'), report(3, 'mgr-C')],
    );

    expect(count(merged, 'から届いた。')).toBe(1);
    expect(count(merged, ORIGIN_CONVERSATION_GUIDE)).toBe(1);
    expect(count(merged, REPORT_FOLLOW_UP_GUIDE)).toBe(1);
    expect(count(merged, '受け取ってから')).toBe(1);
    for (const managerId of ['mgr-A', 'mgr-B', 'mgr-C']) {
      expect(merged).toContain(`[system] マネージャー ${managerId}`);
      expect(merged).toContain(`${managerId} の報告の本文`);
    }
    expect(count(merged, '起点の会話: conv-1')).toBe(3);
    expect(count(merged, '受け取り 20')).toBe(2);
    expect(count(merged, '経過')).toBe(3);
    await stop();
  }, 15_000);

  it('起点が違う件は畳まない: 別の会話の件は枠も案内も全文のまま', async () => {
    const { merged, stop } = await mergedInput(
      [job('mgr-A', 'conv-1'), job('mgr-B', 'conv-2'), job('mgr-C', 'conv-3')],
      [report(1, 'mgr-A'), report(2, 'mgr-B'), report(3, 'mgr-C')],
    );

    expect(count(merged, 'から届いた。')).toBe(3);
    expect(count(merged, ORIGIN_CONVERSATION_GUIDE)).toBe(3);
    expect(count(merged, REPORT_FOLLOW_UP_GUIDE)).toBe(3);
    expect(count(merged, '受け取ってから')).toBe(3);
    expect(count(merged, '受け取り 20')).toBe(0);
    await stop();
  }, 15_000);

  it('起点が混ざる: 1件目と同じ起点の件だけ畳み、違う起点の件は全文のまま', async () => {
    const { merged, stop } = await mergedInput(
      [job('mgr-A', 'conv-1'), job('mgr-B', 'conv-2'), job('mgr-C', 'conv-1')],
      [report(1, 'mgr-A'), report(2, 'mgr-B'), report(3, 'mgr-C')],
    );

    // 全文は A（1件目）と B（起点が違う）の2件。C は A と同じ起点なので畳む
    expect(count(merged, 'から届いた。')).toBe(2);
    expect(count(merged, '受け取ってから')).toBe(2);
    expect(count(merged, '起点の会話: conv-1')).toBe(2);
    expect(count(merged, '起点の会話: conv-2')).toBe(1);
    const fromB = merged.slice(merged.indexOf('マネージャー mgr-B'));
    expect(fromB).toContain('マネージャー mgr-B から届いた。');
    expect(fromB).toContain('受け取ってから');
    await stop();
  }, 15_000);

  it('起点が「無し」の件は同じでも畳まない（会話の外の件は取り違えの判定に使わない）', async () => {
    const { merged, stop } = await mergedInput(
      [job('mgr-A'), job('mgr-B')],
      [report(1, 'mgr-A'), report(2, 'mgr-B')],
    );

    expect(count(merged, 'から届いた。')).toBe(2);
    expect(count(merged, '受け取ってから')).toBe(2);
    await stop();
  }, 15_000);
});

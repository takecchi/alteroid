import { describe, expect, it } from 'vitest';

import { ORIGIN_NO_TASK_GUIDE, REPORT_FOLLOW_UP_GUIDE } from './clone.js';
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
  env: NodeJS.ProcessEnv,
): Promise<{ merged: string; stop: () => Promise<void> }> {
  const stores = createMemoryStores();
  for (const entry of jobs) await stores.jobs.putJob(entry);
  const s = setup(undefined, stores, {}, env);
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

describe('混合の束 — 起点が同じ会話の件でも固定の枠を毎件全文で出す', () => {
  it.each([
    ['未設定', { ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT: undefined }],
    ['0', { ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT: '0' }],
    ['off', { ALTEROID_TOKEN_SAVING_FOLD_FIXED_TEXT: 'off' }],
  ] as const)(
    '⭐ 畳みが切り（%s）なら、起点が同じ3件でも枠と案内と経過を毎件全文で出す',
    async (_name, env) => {
      const { merged, stop } = await mergedInput(
        [job('mgr-A', 'conv-1'), job('mgr-B', 'conv-1'), job('mgr-C', 'conv-1')],
        [report(1, 'mgr-A'), report(2, 'mgr-B'), report(3, 'mgr-C')],
        env,
      );

      expect(count(merged, 'から届いた。')).toBe(3);
      expect(count(merged, ORIGIN_NO_TASK_GUIDE)).toBe(3);
      expect(count(merged, REPORT_FOLLOW_UP_GUIDE)).toBe(3);
      expect(count(merged, '受け取ってから')).toBe(3);
      expect(count(merged, '受け取り 20')).toBe(0);
      await stop();
    },
    15_000,
  );
});

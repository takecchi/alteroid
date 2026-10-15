import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { EXCHANGE_KIND_DECISION_PREFIX } from './exchange-kind.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitForDone, waitForTerminal } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

// 作業者の拒否・上限をクローン自身のターンの失敗にせず、次の道具の結果へ知らせる（#4911）
const LIMIT_TEXT = "You've hit your weekly limit · resets Oct 20, 3am (UTC)";

function workerAssistant(error: string | undefined): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text: LIMIT_TEXT }] },
    ...(error === undefined ? {} : { error }),
    parent_tool_use_id: 'toolu_worker',
    session_id: 'sess-fake',
    uuid: 'uuid-worker-assistant',
  } as unknown as SDKMessage;
}

function taskNotification(status: string, summary: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    status,
    summary,
    output_file: '/tmp/out',
    session_id: 'sess-fake',
    uuid: `uuid-notify-${status}`,
  } as unknown as SDKMessage;
}

async function decisionLines(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'], order: 'asc' });
  return rows.flatMap((row) =>
    row.type === 'exchange' &&
    row.text.startsWith(EXCHANGE_KIND_DECISION_PREFIX) &&
    row.text.includes('作業者')
      ? [row.text]
      : [],
  );
}

async function runPostToolUse(
  call: FakeCall,
  input: Record<string, unknown> = {},
): Promise<{ additionalContext?: string }> {
  const hook = call.options.hooks?.PostToolUse?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
  const out = (await hook({ tool_name: 'Read', ...input } as never, undefined, {
    signal: new AbortController().signal,
  } as never)) as { hookSpecificOutput?: { additionalContext?: string } };
  return out.hookSpecificOutput?.additionalContext === undefined
    ? {}
    : { additionalContext: out.hookSpecificOutput.additionalContext };
}

describe('クローン — 作業者の拒否と上限（#4911）', () => {
  it('作業者の発言に rate_limit の errorCode が付いても、クローンのターンは失敗にならず返答は捨てられない', async () => {
    const s = setup(() => 'できたよ', createMemoryStores(), {
      beforeAssistant: () => [workerAssistant('rate_limit')],
    });
    s.clone.post(humanMessage('やって'));
    await waitForDone(s.events);

    expect(s.events.some((e) => e.type === 'error')).toBe(false);
    expect(s.clone.usageBlocked).toBe(false);
    const sent = s.events.flatMap((e) => (e.type === 'text' ? [e.text] : []));
    expect(sent.join('')).toContain('できたよ');
    await s.clone.stop();
  });

  it('対照: クローン自身の発言の拒否は今どおり失敗になる', async () => {
    const s = setup(undefined, createMemoryStores(), {
      assistantErrorAt: () => ({ error: 'rate_limit', text: '混み合っています' }),
      resultFor: () => ({ subtype: 'success', isError: true, text: '混み合っています' }),
    });
    s.clone.post(humanMessage('やって'));
    await waitForTerminal(s.events);

    expect(s.events.some((e) => e.type === 'error')).toBe(true);
    await s.clone.stop();
  });

  it('作業者の errorCode（quota）で、次の道具の結果へ知らせが添えられ、日誌に1行残る。枠の印は立たない', async () => {
    const s = setup(() => 'できたよ', createMemoryStores(), {
      beforeAssistant: () => [workerAssistant('rate_limit')],
    });
    s.clone.post(humanMessage('やって'));
    await waitForDone(s.events);

    const first = await runPostToolUse(s.calls[0] as FakeCall);
    expect(first.additionalContext).toContain('作業者');
    expect(first.additionalContext).toContain('利用上限で落ちた');
    expect(first.additionalContext).toContain('止める指示ではない');
    expect(s.clone.usageBlocked).toBe(false);
    expect(s.events.some((e) => e.type === 'usage_limited')).toBe(false);

    const lines = await decisionLines(s.stores);
    expect(lines.filter((l) => l.includes('次の道具の結果に知らせを添える'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('知らせを添えた'))).toHaveLength(1);

    // 10分以内に重ねて添えない
    const second = await runPostToolUse(s.calls[0] as FakeCall);
    expect(second.additionalContext).toBeUndefined();
    await s.clone.stop();
  });

  it('作業者の失敗の通知（上限の文言）で知らせが添えられる', async () => {
    const s = setup(() => 'できたよ', createMemoryStores(), {
      beforeAssistant: () => [taskNotification('failed', LIMIT_TEXT)],
    });
    s.clone.post(humanMessage('やって'));
    await waitForDone(s.events);

    const out = await runPostToolUse(s.calls[0] as FakeCall);
    expect(out.additionalContext).toContain('task task-1');
    expect(out.additionalContext).toContain('利用上限で落ちた');
    expect(s.clone.usageBlocked).toBe(false);
    expect((await decisionLines(s.stores)).length).toBeGreaterThanOrEqual(2);
    await s.clone.stop();
  });

  it('completed の通知・本文の引用（errorCode 無し）・上限でない失敗では立たない', async () => {
    const s = setup(() => 'できたよ', createMemoryStores(), {
      beforeAssistant: () => [
        taskNotification('completed', LIMIT_TEXT),
        taskNotification('failed', 'テストが落ちた'),
        workerAssistant(undefined),
      ],
    });
    s.clone.post(humanMessage('やって'));
    await waitForDone(s.events);

    const out = await runPostToolUse(s.calls[0] as FakeCall);
    expect(out.additionalContext).toBeUndefined();
    expect(await decisionLines(s.stores)).toEqual([]);
    await s.clone.stop();
  });
});

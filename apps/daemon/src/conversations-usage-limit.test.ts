import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ALWAYS_REDELIVER,
  createClone,
  createLocalRunner,
  createMemoryStores,
  createRunnerRegistry,
  type CloneHost,
  type Stores,
} from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const spendLimitMessage = "You've hit your individual spend limit for this account.";

function fakeSdk(
  resultFor: (turnIndex: number) => { subtype?: string; text?: string } | undefined,
): typeof import('@anthropic-ai/claude-agent-sdk').query {
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
        model: 'claude-fake-init-model-xyz',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;

      let turnIndex = 0;
      async function* runTurn(idx: number): AsyncGenerator<SDKMessage, void> {
        const override = resultFor(idx);
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: `返信(turn=${idx})` }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: `uuid-assistant-${idx}`,
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: override?.subtype ?? 'success',
          result: override?.text ?? `返信(turn=${idx})`,
          session_id: 'sess-fake',
          uuid: `uuid-result-${idx}`,
        } as unknown as SDKMessage;
      }

      const prompt = params.prompt;
      if (typeof prompt === 'string') {
        yield* runTurn(0);
        return;
      }
      const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) break;
        const idx = turnIndex;
        turnIndex += 1;
        yield* runTurn(idx);
      }
    }
    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;
  return fn;
}

function setupRealCloneApp(
  resultFor: (turnIndex: number) => { subtype?: string; text?: string } | undefined,
): { app: ReturnType<typeof createApp>; stores: Stores; clone: CloneHost } {
  const stores = createMemoryStores();
  const queryFn = fakeSdk(resultFor);
  const clone = createClone({
    stores,
    queryFn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => undefined });
  return { app, stores, clone };
}

let testEpoch = 0;
afterEach(() => {
  testEpoch += 1;
});

async function waitFor(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const epoch = testEpoch;
  for (;;) {
    if (await check()) return;
    if (testEpoch !== epoch) {
      throw new Error(`${label} を待っている途中でテストが終わった（待ちは解けていない）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface ConversationMessage {
  id: string;
  at: string;
  role: 'inbound' | 'outbound';
  text: string;
}

describe('/conversations/:id と枠（利用上限）の再試行 — 症状B', () => {
  it('保持していた合図の再試行が成功すると、/conversations/:id には最終的に inbound → outbound の順で返信が並ぶ', async () => {
    const { app, stores } = setupRealCloneApp((turnIndex) =>
      turnIndex === 0 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    );

    // 在る会話へしか送れない。
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '(種)',
      conversationId: 'conv-1',
    });
    const first = await app.request('/chat', json({ text: '一件目', conversationId: 'conv-1' }));
    const firstBody = await first.text();
    expect(firstBody).toContain('event: usage_limited');
    expect(firstBody).toContain('event: error');

    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return pending.length === 1;
    }, '1本目が未読のまま保持される');

    const eventsResponse = await app.request('/events', json({ source: 'test', payload: {} }));
    expect(eventsResponse.status).toBe(200);

    await waitFor(async () => {
      const detail = await app.request('/conversations/conv-1');
      if (detail.status !== 200) return false;
      const body = (await detail.json()) as { messages: ConversationMessage[] };
      return body.messages.some((m) => m.text.includes('返信(turn=1)'));
    }, '保持していた1本目の再試行の返信が /conversations/conv-1 に現れる');

    expect(firstBody).not.toContain('返信(turn=1)');

    const detail = await app.request('/conversations/conv-1');
    const body = (await detail.json()) as { messages: ConversationMessage[] };

    const humanIndex = body.messages.findIndex((m) => m.role === 'inbound' && m.text === '一件目');
    const replyIndex = body.messages.findIndex(
      (m) => m.role === 'outbound' && m.text === '返信(turn=1)',
    );
    expect(humanIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeGreaterThan(humanIndex);
  });

  it('枠で落ちた1回目の失敗理由（英語）が、クローンの返信として会話に混ざる（人間の言う「英語の文言が返信として出る」の候補）', async () => {
    const { app, stores } = setupRealCloneApp((turnIndex) =>
      turnIndex === 0 ? { subtype: 'error_during_execution', text: spendLimitMessage } : undefined,
    );

    // 在る会話へしか送れない。
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '(種)',
      conversationId: 'conv-1',
    });
    const first = await app.request('/chat', json({ text: '一件目', conversationId: 'conv-1' }));
    await first.text();

    await waitFor(async () => {
      const pending = await stores.inbox.claimPending();
      return pending.length === 1;
    }, '1本目が未読のまま保持される');

    await app.request('/events', json({ source: 'test', payload: {} }));

    await waitFor(async () => {
      const detail = await app.request('/conversations/conv-1');
      if (detail.status !== 200) return false;
      const body = (await detail.json()) as { messages: ConversationMessage[] };
      return body.messages.some((m) => m.text.includes('返信(turn=1)'));
    }, '保持していた1本目の再試行の返信が /conversations/conv-1 に現れる');

    const detail = await app.request('/conversations/conv-1');
    const body = (await detail.json()) as { messages: ConversationMessage[] };
    const outboundTexts = body.messages.filter((m) => m.role === 'outbound').map((m) => m.text);

    const containsRawFailureText = outboundTexts.some((text) => text.includes(spendLimitMessage));
    expect(containsRawFailureText).toBe(false);
  });
});

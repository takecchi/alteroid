import { describe, it, expect } from 'vitest';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { PendingMessage } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, setup, waitFor } from './clone-test-harness.js';

/** 入力ごとに門を張る SDK。`release()` で、届いている入力の古い順に1つずつ通す。 */
function gatedSdk() {
  const inputs: string[] = [];
  const gates: (() => void)[] = [];
  let released = 0;
  let allOpen = false;
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      if (typeof params.prompt === 'string') {
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-side',
          uuid: 'uuid-side',
        } as unknown as SDKMessage;
        return;
      }
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
        let open!: () => void;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        gates.push(open);
        if (allOpen) open();
        inputs.push(String(message.message.content));
        await gate;
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          session_id: 'sess-fake',
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-fake',
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return {
    fn,
    inputs,
    release: () => {
      gates[released]!();
      released += 1;
    },
    openAll: () => {
      allOpen = true;
      gates.forEach((open) => open());
    },
  };
}

function build() {
  const stores = createMemoryStores();
  const sdk = gatedSdk();
  const clone = createClone({
    redeliveryGate: ALWAYS_REDELIVER,
    stores,
    queryFn: sdk.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
  return { stores, clone, ...sdk };
}

function said(text: string, conversationId: string, clientMessageId?: string): InboxEvent {
  const event = humanMessage(text, conversationId);
  return (clientMessageId === undefined ? event : { ...event, clientMessageId }) as InboxEvent;
}

type Attachable = { attach?: ReturnType<typeof build>['clone']['attach'] };

function pendingOf(clone: Attachable, conversationId: string): PendingMessage[] {
  const attached = clone.attach!(conversationId, () => undefined);
  attached.unsubscribe();
  return attached.pending;
}

describe('クローン — attach の pending（#3990）', () => {
  it('走っている発言は running、順番待ちは受信箱の順の queued。別の会話・clientMessageId なしは載らない', async () => {
    const t = build();
    t.clone.post(said('先客', 'conv-a', 'cm-1'));
    await waitFor(() => t.inputs.length === 1, 'ターンが始まる');
    t.clone.post(said('二番目', 'conv-a', 'cm-2'));
    t.clone.post(said('別の会話', 'conv-b', 'cm-b'));
    t.clone.post(said('印なし', 'conv-a'));
    t.clone.post(said('三番目', 'conv-a', 'cm-3'));

    expect(pendingOf(t.clone, 'conv-a')).toEqual([
      { clientMessageId: 'cm-1', state: 'running' },
      { clientMessageId: 'cm-2', state: 'queued' },
      { clientMessageId: 'cm-3', state: 'queued' },
    ]);
    expect(pendingOf(t.clone, 'conv-b')).toEqual([{ clientMessageId: 'cm-b', state: 'queued' }]);
    expect(pendingOf(t.clone, 'conv-none')).toEqual([]);

    t.openAll();
    await waitFor(
      () => t.clone.activeTurn!() === null && pendingOf(t.clone, 'conv-a').length === 0,
      '答え終わる',
    );
    expect(pendingOf(t.clone, 'conv-b')).toEqual([]);
    await t.clone.stop();
  });

  it('まとめ読みされた発言は、そのターンの分がすべて running で載る', async () => {
    const t = build();
    t.clone.post(said('先客', 'conv-a', 'cm-1'));
    await waitFor(() => t.inputs.length === 1, 'ターンが始まる');
    t.clone.post(said('二番目', 'conv-a', 'cm-2'));
    t.clone.post(said('三番目', 'conv-a', 'cm-3'));

    t.release();
    await waitFor(() => t.inputs.length === 2, 'まとめたターンが始まる');
    expect(t.inputs[1]).toContain('二番目');
    expect(t.inputs[1]).toContain('三番目');
    expect(pendingOf(t.clone, 'conv-a')).toEqual([
      { clientMessageId: 'cm-2', state: 'running' },
      { clientMessageId: 'cm-3', state: 'running' },
    ]);

    t.openAll();
    await t.clone.stop();
  });

  it('取り出し済みでターンがまだ始まっていなければ starting', async () => {
    const stores = createMemoryStores();
    const sdk = gatedSdk();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: sdk.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    // ターンの準備（未了の台帳の読み出し）で止めて、取り出し済み・開始前の区間を作る。
    const original = stores.commitments.list.bind(stores.commitments);
    let reached = false;
    let proceed!: () => void;
    const hold = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    stores.commitments.list = async (...args) => {
      reached = true;
      await hold;
      return original(...args);
    };

    clone.post(said('先客', 'conv-a', 'cm-1'));
    await waitFor(() => reached, '準備で止まる');
    expect(pendingOf(clone, 'conv-a')).toEqual([{ clientMessageId: 'cm-1', state: 'starting' }]);

    proceed();
    await waitFor(() => sdk.inputs.length === 1, 'ターンが始まる');
    expect(pendingOf(clone, 'conv-a')).toEqual([{ clientMessageId: 'cm-1', state: 'running' }]);
    sdk.openAll();
    await clone.stop();
  });

  it('枠（利用上限）で保持している発言は held', async () => {
    const s = setup(undefined, createMemoryStores(), {
      resultSubtype: 'error_during_execution',
      resultText: "You've hit your individual spend limit for this account.",
    });
    s.clone.post(said('やあ', 'conv-1', 'cm-h'));

    await waitFor(
      () => pendingOf(s.clone, 'conv-1').some((p) => p.state === 'held'),
      '枠に当たって保持される',
    );
    expect(pendingOf(s.clone, 'conv-1')).toEqual([{ clientMessageId: 'cm-h', state: 'held' }]);
    expect(pendingOf(s.clone, 'conv-other')).toEqual([]);
    await s.clone.stop();
  });
});

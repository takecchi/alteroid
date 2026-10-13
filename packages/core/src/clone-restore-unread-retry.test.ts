import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { waitFor } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `gate` を渡すと、ターンの応答をそれが解けるまで止める（合図を処理し終えず、受信箱に残したままにする）
function fakeSdk(gate?: Promise<void>): { fn: typeof sdkQuery; inputs: string[] } {
  const inputs: string[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;
      for await (const message of params.prompt as AsyncIterable<{
        message: { content: unknown };
      }>) {
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
  return { fn, inputs };
}

// 起動時の読み直し（`claimPending()`）が初めの `failures` 回だけ落ちる受信箱。落ちるたびに `onFailure` を呼ぶ
function storesWithFailingClaim(
  failures: number,
  onFailure: (attempt: number) => Promise<void> = async () => undefined,
): { stores: Stores; attempts: () => number } {
  const base = createMemoryStores();
  const inbox = base.inbox;
  let attempts = 0;
  const stores: Stores = {
    ...base,
    inbox: {
      put: (event, at) => inbox.put(event, at),
      remove: (id) => inbox.remove(id),
      claimPending: async () => {
        attempts += 1;
        if (attempts <= failures) {
          await onFailure(attempts);
          throw new Error(`Connection terminated unexpectedly（${String(attempts)} 回目）`);
        }
        return inbox.claimPending();
      },
      pending: () => inbox.pending(),
      peekPending: () => inbox.peekPending(),
      removeMany: (ids) => inbox.removeMany(ids),
      clear: () => inbox.clear(),
    },
  };
  return { stores, attempts: () => attempts };
}

function bootClone(stores: Stores, gate?: Promise<void>): { clone: CloneHost; inputs: string[] } {
  const fake = fakeSdk(gate);
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
    restoreUnreadRetryDelaysMs: [10],
  });
  return { clone, inputs: fake.inputs };
}

function humanMessage(id: string, text: string): InboxEvent {
  return {
    type: 'human_message',
    id,
    at: new Date().toISOString(),
    text,
    conversationId: `conv-${id}`,
  } as unknown as InboxEvent;
}

describe('起動時の未読の読み直しが落ちても、拾えるまでやり直す（#4647）', () => {
  it('⭐ claimPending() が2回落ちても、前の器が残した未読はこの起動のうちに1回だけ配られる', async () => {
    const { stores, attempts } = storesWithFailingClaim(2);
    const leftover = humanMessage('evt-leftover', '前の器が残した発言（#4647）');
    await stores.inbox.put(leftover, leftover.at);

    const { inputs } = bootClone(stores);

    await waitFor(
      () => inputs.some((input) => input.includes('前の器が残した発言')),
      '前の器の未読の配り直し',
    );
    expect(attempts()).toBe(3);
    expect(inputs.filter((input) => input.includes('前の器が残した発言'))).toHaveLength(1);
  });

  it('やり直しを待つ間に post された合図は、拾い直しで二度配られない（#1984 の守りを崩さない）', async () => {
    const booting: { clone?: CloneHost } = {};
    const live = humanMessage('evt-live', 'やり直しの間に届いた発言（#4647）');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { stores, attempts } = storesWithFailingClaim(1, async () => {
      // 1回目の失敗の直後に届いたことにする。受信箱へ書かれるまで待ってから落とす
      // 1回目の読み直しは `createClone()` の中で始まるので、作り終わるのを待ってから post する
      await waitFor(() => booting.clone !== undefined, 'クローンの作成');
      booting.clone?.post(live);
      await waitFor(
        async () => (await stores.inbox.peekPending()).entries.some((p) => p.event.id === live.id),
        '受信箱への書き込み',
      );
    });

    const booted = bootClone(stores, gate);
    booting.clone = booted.clone;

    // 1回目のターンを止めている間に2回目の読み直しを済ませる: 合図はまだ受信箱に残っているので、守りが無ければ拾い直しがもう一度配る
    await waitFor(
      () => booted.inputs.some((input) => input.includes('やり直しの間に届いた発言')),
      '1回目の配達',
    );
    await waitFor(() => attempts() >= 2, '2回目の読み直し');
    await waitFor(
      async () =>
        (await stores.journal.list({ types: ['exchange'] })).some(
          (entry) => entry.type === 'exchange' && entry.text.includes('未読の拾い直しが終わった'),
        ),
      '拾い直しの終わり',
    );
    release();

    // 実時間では待たない（#2146）: 拾い直しが積んだ分は、後から送った目印より前に並ぶので、目印が届いた時点で数えれば足りる
    booted.clone.post(humanMessage('evt-sentinel', '目印の発言（#4647）'));
    await waitFor(() => booted.inputs.some((input) => input.includes('目印の発言')), '目印の配達');
    // 束ねて1つのターンに入ることがあるので、入力の数ではなく出てきた回数で数える
    const occurrences = booted.inputs.reduce(
      (total, input) => total + input.split('やり直しの間に届いた発言').length - 1,
      0,
    );
    expect(occurrences).toBe(1);
  });
});

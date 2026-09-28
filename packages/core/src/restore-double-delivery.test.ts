import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * issue #1984。`Clone#pump()` は起動時に `#restoreUnread()` を**待たずに**始め、
 * `#restoreUnreadPass()` が `stores.inbox.claimPending()` で前の器の未読を配り直す。
 * 一方、起動直後に `post(event)` された合図は、その場で生きている待ち行列へ入り、
 * 同時に `#remember` が同じ受信箱へ `put` する（これも待たない）。⟹ `claimPending()`
 * がその `put` の後の受信箱を読むと、たった今 `post` で配った合図を「前の器が
 * 残した未読」としてもう一度配る——同じ発言に2回応える形になる。
 *
 * ここでは `claimPending()` を、テストが握った約束で待たせる。その間に `post` し、
 * 受信箱への書き込みが着いたのを見てから約束を解く。そのうえで、同じ合図が
 * ターンの入力に何回出るかを数える。
 */

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
}

function fakeSdk(): Fake {
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

function bootClone(stores: Stores): Fake & { clone: CloneHost } {
  const fake = fakeSdk();
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { ...fake, clone };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > 3000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** `claimPending()` だけを、テストが解くまで待たせるストア。 */
function storesWithHeldClaim(): { stores: Stores; release: () => void } {
  const base = createMemoryStores();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inbox = base.inbox;
  const stores: Stores = {
    ...base,
    inbox: {
      put: (event, at) => inbox.put(event, at),
      remove: (id) => inbox.remove(id),
      claimPending: async () => {
        await held;
        return inbox.claimPending();
      },
      pending: () => inbox.pending(),
      peekPending: () => inbox.peekPending(),
      removeMany: (ids) => inbox.removeMany(ids),
      clear: () => inbox.clear(),
    },
  };
  return { stores, release: () => release() };
}

const MARK = 'この発言は1回だけ届くべき（issue #1984）';

describe('起動直後に post した合図が、未読の配り直しで二重に配られない（issue #1984）', () => {
  it('claimPending() が post の受信箱への書き込みの後に返っても、同じ合図は1回しかターンに乗らない', async () => {
    const { stores, release } = storesWithHeldClaim();
    const { clone, inputs } = bootClone(stores);

    const event = {
      type: 'human_message',
      id: 'evt-live-1',
      at: new Date().toISOString(),
      text: MARK,
      conversationId: 'conv-1',
    } as unknown as InboxEvent;
    clone.post(event);

    // post の永続化（`#remember`）が受信箱へ着くまで待つ——これで claimPending() が
    // 後から読む受信箱に、同じ合図が在る状態になる。
    await waitFor(
      async () => (await stores.inbox.peekPending()).some((p) => p.event.id === 'evt-live-1'),
      '受信箱への書き込み',
    );
    release();

    await waitFor(() => inputs.some((input) => input.includes(MARK)), '1回目の配達');
    // 2回目が来るなら、この間に来る。
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(inputs.filter((input) => input.includes(MARK))).toHaveLength(1);
  });

  it('対照: 前の器が残した未読（この起動では post していない合図）は、今までどおり配り直される', async () => {
    const { stores, release } = storesWithHeldClaim();
    const leftover = {
      type: 'human_message',
      id: 'evt-leftover-1',
      at: new Date().toISOString(),
      text: '前の器が残した発言（issue #1984 の対照）',
      conversationId: 'conv-2',
    } as unknown as InboxEvent;
    await stores.inbox.put(leftover, leftover.at);

    const { inputs } = bootClone(stores);
    release();

    await waitFor(
      () => inputs.some((input) => input.includes('前の器が残した発言')),
      '前の器の未読の配り直し',
    );
    expect(inputs.filter((input) => input.includes('前の器が残した発言'))).toHaveLength(1);
  });
});

import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores } from './testing.js';

/**
 * クローンのセッション id の控え／破棄が失敗したときに、跡が残るか（issue #1157）。
 *
 * **測っているのは「何が起きたか」ではなく「起きたことが外から分かるか」である。**
 * 控えられなければ次の起動で resume を諦めるが、その諦め方は「素材が無かった」
 * （初回起動・意図して捨てた後）という**正常な経路と1文字も違わない**——だから
 * 跡が無いと、会話が1本切れたことが「正常」として通る。
 *
 * **⛔ 陰性対照を必ず対にすること。** 「跡が出る」だけを測ると、**常に跡を出す
 * 実装でも緑になる。** 成功したときに跡が出ないことを、同じ数だけ測る。
 */

const SESSION_ID = 'sess-fake';

interface Fake {
  fn: typeof sdkQuery;
  inputs: string[];
}

/** 素直に1ターン返す SDK の代わり。`init` を流すので `session_started` が起きる。 */
function fakeSdk(): Fake {
  const inputs: string[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: SESSION_ID,
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
          session_id: SESSION_ID,
          uuid: 'uuid-assistant',
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: SESSION_ID,
          uuid: 'uuid-result',
        } as unknown as SDKMessage;
      }
    }
    const generator = generate();
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, inputs };
}

/**
 * `init` を1件も流さずに落ちる SDK の代わり。
 *
 * **`#read` の「init すら来ずに落ちたなら resume 素材が腐っている」分岐
 * （`!this.#sawInit && this.#resumedFrom !== null`）を通すためのもの。** そこが
 * `setCloneSessionId(null)` を打つ側で、この歯のもう半分である。
 */
function throwingSdk(): Fake {
  const inputs: string[] = [];
  const fn = (() => {
    // **generator 関数では書かない。** `yield` を1つも持たない generator は
    // `require-yield` に当たるうえ、ここで欲しいのは「反復した瞬間に落ちる」
    // ことだけである。⟹ 反復子の形を直に作る。
    const generator = {
      next: (): Promise<IteratorResult<SDKMessage>> =>
        Promise.reject(new Error('init の前に落ちた')),
      return: (): Promise<IteratorResult<SDKMessage>> =>
        Promise.resolve({ done: true, value: undefined }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return Object.assign(generator, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, inputs };
}

/**
 * `setCloneSessionId` の片方の向きだけを失敗させる。
 *
 * **`testing.ts` の `failingInboxPut` / `failingJournalAppend` と同じ形である**
 * （あちらに寄せず此処に置いてあるのは、使うのがこのファイルだけだからで、
 * 作法を変えたからではない）。**向きで分けるのが要点** —— 控える側
 * （`id !== null`）と捨てる側（`id === null`）は帰結が違うので、跡も別物である。
 */
function failingSetCloneSessionId(
  stores: Stores,
  direction: 'record' | 'discard',
  reason: string,
): Stores {
  return {
    ...stores,
    sessions: {
      ...stores.sessions,
      setCloneSessionId: (id: string | null) => {
        const failing = direction === 'record' ? id !== null : id === null;
        if (failing) return Promise.reject(new Error(reason));
        return stores.sessions.setCloneSessionId(id);
      },
    },
  };
}

function bootClone(stores: Stores, fake: Fake): { clone: CloneHost } {
  const clone = createClone({
    stores,
    queryFn: fake.fn,
    env: {},
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
    redeliveryGate: ALWAYS_REDELIVER,
  });
  return { clone };
}

function report(text: string, id = 'evt-report'): InboxEvent {
  return {
    type: 'manager_message',
    id,
    at: new Date(0).toISOString(),
    managerId: 'mgr-1',
    kind: 'report',
    text,
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > 3000) throw new Error(`${label} が起きない`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function linesWith(lines: string[], needle: string): string[] {
  return lines.filter((line) => line.includes(needle));
}

describe('セッション id の控えの失敗（#1157）', () => {
  it('控えられなかったら跡が残る', async () => {
    const stores = failingSetCloneSessionId(createMemoryStores(), 'record', '器が落ちている');
    const fake = fakeSdk();
    const { clone } = bootClone(stores, fake);

    const lines = await captureStderr(async () => {
      clone.post(report('控えの失敗を測る'));
      await waitFor(() => fake.inputs.length > 0, '合図が処理に入る');
      await clone.stop();
    });

    const hits = linesWith(lines, 'クローンのセッション id を控えられませんでした');
    expect(hits.length).toBeGreaterThan(0);
    // **理由が載る。**「控えられなかった」だけでは、ディスクなのか器なのかを
    // 疑いに行けない。
    expect(hits[0]).toContain('器が落ちている');
  });

  it('⛔ 陰性対照: 控えられたときは跡が出ない（常に跡を出す実装ではないこと）', async () => {
    const stores = createMemoryStores();
    const fake = fakeSdk();
    const { clone } = bootClone(stores, fake);

    const lines = await captureStderr(async () => {
      clone.post(report('成功する側'));
      await waitFor(() => fake.inputs.length > 0, '合図が処理に入る');
      await clone.stop();
    });

    expect(linesWith(lines, 'クローンのセッション id を控えられませんでした')).toEqual([]);
    // 控えは実際に器へ載っている（＝失敗していない）。
    expect(await stores.sessions.getCloneSessionId()).toBe(SESSION_ID);
  });

  it('跡にセッション id そのものは載らない（stderr は器の外へ出ていく）', async () => {
    const stores = failingSetCloneSessionId(createMemoryStores(), 'record', '器が落ちている');
    const fake = fakeSdk();
    const { clone } = bootClone(stores, fake);

    const lines = await captureStderr(async () => {
      clone.post(report('本文の非流出'));
      await waitFor(() => fake.inputs.length > 0, '合図が処理に入る');
      await clone.stop();
    });

    const hits = linesWith(lines, 'クローンのセッション id を控えられませんでした');
    expect(hits.length).toBeGreaterThan(0);
    for (const line of hits) expect(line).not.toContain(SESSION_ID);
  });

  it('⭐ 控えに失敗してもセッションは死なない（握り潰しをやめて起動が止まる形にしていない）', async () => {
    const stores = failingSetCloneSessionId(createMemoryStores(), 'record', '器が落ちている');
    const fake = fakeSdk();
    const { clone } = bootClone(stores, fake);

    clone.post(report('ターンは通る'));
    await waitFor(() => fake.inputs.length > 0, '合図が処理に入る');
    await clone.stop();

    // 合図は最後まで処理された（消し込みまで届いている）。
    expect(await stores.inbox.claimPending()).toEqual([]);
    expect(fake.inputs.join('\n')).toContain('ターンは通る');
  });
});

describe('セッション id の破棄の失敗（#1157）', () => {
  it('捨てられなかったら跡が残る', async () => {
    const base = createMemoryStores();
    // resume 素材が在る状態にする（`#resumedFrom !== null` がこの分岐の門）。
    await base.sessions.setCloneSessionId('sess-rotten');
    const stores = failingSetCloneSessionId(base, 'discard', '器が落ちている');
    const fake = throwingSdk();
    const { clone } = bootClone(stores, fake);

    const lines = await captureStderr(async () => {
      clone.post(report('腐った素材で resume する'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await clone.stop();
    });

    const hits = linesWith(lines, 'resume 素材の破棄');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toContain('器が落ちている');
  });

  it('⛔ 陰性対照: 捨てられたときは跡が出ない', async () => {
    const stores = createMemoryStores();
    await stores.sessions.setCloneSessionId('sess-rotten');
    const fake = throwingSdk();
    const { clone } = bootClone(stores, fake);

    const lines = await captureStderr(async () => {
      clone.post(report('腐った素材で resume する'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await clone.stop();
    });

    expect(linesWith(lines, 'resume 素材の破棄')).toEqual([]);
    // 実際に捨てられている。
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
  });
});

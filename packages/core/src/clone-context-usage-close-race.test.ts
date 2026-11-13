import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { fakeSdk as harnessFakeSdk, waitFor } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

// クローン: 文脈占有の観測（`getContextUsage`）が走っている間に、閉じる／入力を閉じる境界へ達しても、
// 観測が「閉じたセッションへの問い合わせ」という偽の失敗の行にならない。
// 偽のセッションは、閉じられた（`close()`）・入力を閉じられた（プロンプトの列の終端）後の `getContextUsage` を失敗させる。
const usage = { totalTokens: 12_000, rawMaxTokens: 200_000, percentage: 6 };

/** 実時間で待たず、イベントループを数周回す。 */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

interface FakeSession {
  /** 入力と無関係に、ターンの終わり（`result`）を出させる */
  endTurn(): void;
  readonly dead: () => boolean;
  readonly inputClosed: () => boolean;
}

function fakeSdk(opts: {
  getContextUsage: (callIndex: number, session: FakeSession) => Promise<unknown>;
  sessionUsage?: () => Promise<unknown>;
  lingerAfterInputClose?: boolean;
}) {
  let calls = 0;
  let results = 0;
  const sessions: FakeSession[] = [];
  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    let closed = false;
    let inputClosed = false;
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };
    const result = (): SDKMessage =>
      ({
        type: 'result',
        subtype: 'success',
        result: 'はい',
        session_id: 'sess-clone',
        uuid: `uuid-result-${String((results += 1))}`,
      }) as unknown as SDKMessage;
    const session: FakeSession = {
      endTurn: () => push(result()),
      dead: () => closed || inputClosed,
      inputClosed: () => inputClosed,
    };
    sessions.push(session);
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-clone',
        uuid: `uuid-init-${String(sessions.length)}`,
        model: 'claude-fake',
        claude_code_version: '9.9.9-fake',
        apiKeySource: 'user',
        permissionMode: 'default',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      } as unknown as SDKMessage;
      if (typeof params.prompt !== 'string') {
        void (async () => {
          for await (const message of params.prompt as AsyncIterable<unknown>) {
            void message;
            push(result());
          }
          // 入力が閉じたら SDK のプロセスは終わる（`lingerAfterInputClose` なら、`close()` までは出力を続ける。入力を閉じた後に遅れて来る終わりを作るため）
          inputClosed = true;
          if (emit && opts.lingerAfterInputClose !== true) emit(null);
        })();
      } else {
        push(result());
      }
      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed || (inputClosed && opts.lingerAfterInputClose !== true)) return;
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }
    return Object.assign(generate(), {
      close: () => {
        closed = true;
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
      getContextUsage: () => opts.getContextUsage((calls += 1) - 1, session),
      ...(opts.sessionUsage === undefined
        ? {}
        : { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: opts.sessionUsage }),
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, sessions, callCount: () => calls };
}

function setup(sdk: ReturnType<typeof fakeSdk>, stores: Stores = createMemoryStores()) {
  const onRecycled: string[] = [];
  const clone = createClone({
    inboxSettleMs: 0,
    reportSettleMs: 0,
    stores,
    queryFn: sdk.fn,
    env: {},
    onTokenSessionRecycled: () => onRecycled.push('rung'),
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: harnessFakeSdk().fn, env: {} }),
    ]),
  });
  return { clone, stores, onRecycled };
}

async function rowsOf(stores: Stores) {
  const entries = await stores.journal.list({ types: ['context_usage'], order: 'asc' });
  return entries.flatMap((entry) => (entry.type === 'context_usage' ? [entry] : []));
}

describe('クローン — 観測と閉じる境界の競合', () => {
  it('⭐ stop が観測の完了を待った後・セッションを閉じる前に turn_ended が届いても、偽の失敗の行が書かれない', async () => {
    const g0 = gate();
    const late = gate();
    const usageGate = gate();
    let usageReadStarted = false;
    // ターンごとの累積の読み出しは止めない。止めるのは、観測の待ちを抜けた後の、stop の読み出しだけ
    let armed = false;
    let raceInjected = false;
    const sdk = fakeSdk({
      // stop が入力を閉じた後でも、遅れた終わりが届きうる形にする
      lingerAfterInputClose: true,
      getContextUsage: async (callIndex, session) => {
        if (callIndex === 0) await g0.opened;
        if (raceInjected) await late.opened;
        // 閉じられたセッションへの問い合わせは失敗する（本物の SDK と同じ）
        if (session.dead()) throw new Error('閉じたセッションへの getContextUsage');
        return usage;
      },
      sessionUsage: async () => {
        if (!armed) return undefined;
        usageReadStarted = true;
        await usageGate.opened;
        return undefined;
      },
    });
    const stores = createMemoryStores();
    const { clone } = setup(sdk, stores);
    clone.post(humanMessage('やあ'));
    await waitFor(() => sdk.callCount() === 1, '1つ目の観測が始まる');

    const stopping = clone.stop();
    await settle();
    // 観測が返るまで、stop は先へ進まない（ここまでは今までどおり）
    expect(usageReadStarted).toBe(false);
    armed = true;
    g0.open();
    // 観測の待ちを抜けて、累積の読み出し（閉じる前）で止まる
    await waitFor(() => usageReadStarted, 'stop が累積の読み出しまで進む');

    // 待ちを抜けた後・閉じる前に、ターンの終わりが届く
    const callsBefore = sdk.callCount();
    raceInjected = true;
    sdk.sessions[0]?.endTurn();
    await settle();
    usageGate.open();
    await waitFor(() => sdk.sessions[0]?.dead() === true, 'セッションが閉じられる');
    late.open();
    await stopping;
    await settle();

    // 偽の失敗の行（error 付き）は書かれない。閉じかけに届いたターンの観測は積まない
    expect((await rowsOf(stores)).filter((row) => row.contextUsage.error !== undefined)).toEqual(
      [],
    );
    expect(sdk.callCount()).toBe(callsBefore);
  });

  it('⭐ トークン回転の境界で観測が走っていれば、観測が終わるまで入力を閉じず、行は本来の中身で書かれる', async () => {
    const g = gate();
    const sdk = fakeSdk({
      getContextUsage: async (_callIndex, session) => {
        await g.opened;
        // 入力が閉じて SDK のプロセスが終わった後の問い合わせは失敗する（本物の SDK と同じ）
        if (session.dead()) throw new Error('入力を閉じた後の getContextUsage');
        return usage;
      },
    });
    const stores = createMemoryStores();
    const { clone, onRecycled } = setup(sdk, stores);
    clone.post(humanMessage('やあ'));
    await waitFor(() => sdk.callCount() === 1, '観測が始まる（ターンが境界に達した）');

    expect(clone.recycleSessionForToken()).toBe('deferred');
    await settle(40);
    // (i) 観測が終わるまで、入力は閉じず、知らせも鳴らない
    expect(sdk.sessions[0]?.inputClosed()).toBe(false);
    expect(onRecycled).toEqual([]);

    g.open();
    await waitFor(() => sdk.sessions[0]?.inputClosed() === true, '観測が終わってから入力が閉じる');
    await waitFor(async () => (await rowsOf(stores)).length >= 1, '行が書かれる');
    // (ii) 行は偽の失敗でなく、本来の中身
    const [row] = await rowsOf(stores);
    expect(row?.contextUsage.error).toBeUndefined();
    expect(row?.contextUsage).toEqual({ durationMs: expect.any(Number), ...usage });
    expect(onRecycled).toEqual(['rung']);

    await clone.stop();
  });
});

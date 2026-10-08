import { describe, it, expect } from 'vitest';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import type { TokenRotatorObservation } from './token-rotator.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { ChatStreamEvent } from './schema.js';
import { captureStderr, createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, setup, wireEvents, waitFor, waitForTerminal } from './clone-test-harness.js';

describe('onUsageObservation（回し手へ渡す観測）', () => {
  let seq = 0;

  function cloneObserving(input: {
    sdkOptions?: Parameters<typeof fakeSdk>[1];
    identity?: { tokenId: string; generation: number };
    onObserve?: (o: TokenRotatorObservation) => Promise<void>;
  }) {
    const seen: TokenRotatorObservation[] = [];
    const { fn, calls } = fakeSdk(undefined, input.sdkOptions ?? {});
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      ...(input.identity === undefined ? {} : { tokenIdentity: () => input.identity }),
      onUsageObservation:
        input.onObserve ??
        (async (o) => {
          seen.push(o);
        }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    return { clone, calls, seen, events };
  }

  function limitsOf(seen: readonly TokenRotatorObservation[]): TokenRotatorObservation[] {
    return seen.filter((o) => o.succeeded !== true);
  }

  function say(clone: ReturnType<typeof createClone>): void {
    clone.post({
      type: 'human_message',
      id: `evt-obs-${String(++seq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
  }

  it('文言から分類した通知は、そのまま notice として渡る', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        resultSubtype: 'error_during_execution',
        resultText: "You've hit your org's monthly spend limit",
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    expect(seen[0]?.notice?.kind).toBe('reached');
    expect(seen[0]?.notice?.text).toContain("You've hit your");
  });

  it('⚠️ rate_limit_event は notice ではなく、事実と遷移で渡る', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    const observation = seen[0];
    expect(observation).not.toHaveProperty('notice');
    expect(observation?.transition).toBe('rejected');
    expect(observation?.facts?.status).toBe('rejected');
  });

  it('同じ rejected が毎ターン来ても、遷移として渡るのは1回だけ', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '1回目の観測');
    say(clone);
    say(clone);
    await waitFor(() => seen.length > 0, '追加のターン');
    clone.stop();

    expect(seen.filter((o) => o.transition === 'rejected')).toHaveLength(1);
  });

  it('#668: 2回目以降の rejected も、状態だけを運んで渡る', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '1回目の観測');
    say(clone);
    await waitFor(() => limitsOf(seen).length > 1, '2回目の観測');
    clone.stop();

    const limits = limitsOf(seen);
    expect(limits[1]?.statusNow).toBe('rejected');
    expect(limits[1]?.transition).toBeUndefined();
  });

  it('セッションが起きたときの身元を、その観測すべてに添える', async () => {
    const { clone, seen } = cloneObserving({
      identity: { tokenId: 'tok-a', generation: 3 },
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    expect(seen[0]?.observedBy).toEqual({ tokenId: 'tok-a', generation: 3 });
  });

  it('身元が無ければ添えない（unknown へ倒すのは回し手の側）', async () => {
    const { clone, seen } = cloneObserving({
      sdkOptions: {
        rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
      },
    });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    expect(seen[0]).not.toHaveProperty('observedBy');
  });

  it('回し手が投げてもターンを壊さない（別の失敗で上限の報告を置き換えない）', async () => {
    const limitText = "You've hit your org's monthly spend limit";
    const { clone, calls, events } = cloneObserving({
      onObserve: () => Promise.reject(new Error('回し手が落ちた')),
      sdkOptions: { resultSubtype: 'error_during_execution', resultText: limitText },
    });

    const lines = await captureStderr(async () => {
      say(clone);
      await waitForTerminal(events);
    });
    await clone.stop();

    const limited = events.filter((event) => event.type === 'usage_limited');
    expect(limited).toHaveLength(1);
    const message = (limited[0] as Extract<ChatStreamEvent, { type: 'usage_limited' }>).message;
    expect(message).toContain(limitText);
    expect(message).not.toContain('回し手が落ちた');

    expect(calls.filter((call) => call.kind === 'session')).not.toHaveLength(0);

    const dropped = lines.filter((line) => line.includes('認証トークンの切替')).join('\n');
    expect(dropped).toContain('回し手が落ちた');
  });

  it('⚠️ ターンが成功したら、成功の観測（succeeded: true）も回し手へ渡る', async () => {
    const { clone, seen } = cloneObserving({ identity: { tokenId: 'tok-a', generation: 3 } });
    say(clone);
    await waitFor(() => seen.length > 0, '観測が渡ること');
    clone.stop();

    expect(seen[0]).toEqual({
      succeeded: true,
      observedBy: { tokenId: 'tok-a', generation: 3 },
    });
  });
});

describe('rate_limit を跨いで畳んだ本数を日誌へ残す（Issue #1425、クローン側）', () => {
  function crossFoldLines(entries: unknown[]): string[] {
    return entries
      .map((entry) => (entry as { text?: string }).text ?? '')
      .filter((text) => text.includes('同じ壁を跨いで畳んだ回'));
  }

  function doneCountOf(events: readonly ChatStreamEvent[]): number {
    return events.filter((event) => event.type === 'done').length;
  }

  it('陽性: 別の会話が跨いで畳まれると、次の遷移で本数が1行に残る', async () => {
    const facts: Array<Record<string, unknown>> = [
      { status: 'rejected', rateLimitType: 'five_hour' },
      { status: 'rejected', rateLimitType: 'five_hour' },
      { status: 'rejected', rateLimitType: 'five_hour' },
      { status: 'allowed', rateLimitType: 'five_hour' },
      { status: 'rejected', rateLimitType: 'five_hour' },
    ];
    const s = setup(() => 'ok', createMemoryStores(), {
      rateLimitEventAt: (turnIndex) => facts[turnIndex],
    });
    const convB = wireEvents(s.clone, 'conv-b');
    const convC = wireEvents(s.clone, 'conv-c');

    s.clone.post(humanMessage('t0', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 1);

    s.clone.post(humanMessage('t1', 'conv-b'));
    await convB.waitForEvents((events) => doneCountOf(events) === 1);

    s.clone.post(humanMessage('t2', 'conv-c'));
    await convC.waitForEvents((events) => doneCountOf(events) === 1);

    s.clone.post(humanMessage('t3', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 2);

    s.clone.post(humanMessage('t4', 'conv-b'));
    await convB.waitForEvents((events) => doneCountOf(events) === 2);

    const entries = await s.stores.journal.list({});
    const lines = crossFoldLines(entries);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 本の異なる会話が当たっている');

    await s.clone.stop();
  });

  it('やりすぎの対照: 同じ会話だけが繰り返しても、本数の行は出ない', async () => {
    const facts: Array<Record<string, unknown>> = [
      { status: 'rejected', rateLimitType: 'five_hour' },
      { status: 'allowed', rateLimitType: 'five_hour' },
      { status: 'rejected', rateLimitType: 'five_hour' },
    ];
    const s = setup(() => 'ok', createMemoryStores(), {
      rateLimitEventAt: (turnIndex) => facts[turnIndex],
    });

    s.clone.post(humanMessage('t0', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 1);
    s.clone.post(humanMessage('t1', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 2);
    s.clone.post(humanMessage('t2', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 3);

    const entries = await s.stores.journal.list({});
    expect(crossFoldLines(entries)).toHaveLength(0);

    await s.clone.stop();
  });

  it('やりすぎの対照: 初回の遷移だけでは本数の行は出ない', async () => {
    const s = setup(() => 'ok', createMemoryStores(), {
      rateLimitEventAt: () => ({ status: 'rejected', rateLimitType: 'five_hour' }),
    });

    s.clone.post(humanMessage('t0', 'conv-1'));
    await s.waitForEvents((events) => doneCountOf(events) === 1);

    const entries = await s.stores.journal.list({});
    expect(crossFoldLines(entries)).toHaveLength(0);

    await s.clone.stop();
  });
});

describe('recycleSessionForToken（回した後のセッション作り直し）', () => {
  let seq = 0;

  function lookaheadSdk(turnDelayMs = 20) {
    const sessions: { inputs: string[]; resume: string | undefined }[] = [];
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const session = {
        inputs: [] as string[],
        resume: params.options?.resume,
      };
      sessions.push(session);
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: `sess-lookahead-${String(sessions.length)}`,
          uuid: `uuid-init-${String(sessions.length)}`,
          model: 'claude-fake',
          claude_code_version: '9.9.9-fake',
          apiKeySource: 'user',
          permissionMode: 'default',
          mcp_servers: [{ name: 'alteroid', status: 'connected' }],
        } as unknown as SDKMessage;

        const iterator = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
          Symbol.asyncIterator
        ]();

        for (;;) {
          const current = await iterator.next();
          if (current.done === true) return;
          session.inputs.push(String(current.value.message.content));

          const lookahead = iterator.next();

          await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: `sess-lookahead-${String(sessions.length)}`,
            uuid: `uuid-result-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;

          const next = await lookahead;
          if (next.done === true) return;
          session.inputs.push(String(next.value.message.content));
          await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: `sess-lookahead-${String(sessions.length)}`,
            uuid: `uuid-result-b-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;
        }
      }
      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    return { fn, sessions };
  }

  function say(clone: ReturnType<typeof createClone>): void {
    clone.post({
      type: 'human_message',
      id: `evt-recycle-${String(++seq)}`,
      at: new Date().toISOString(),
      text: 'こんにちは',
      conversationId: 'conv-1',
    });
  }

  function setupRecycle(sdkOptions: Parameters<typeof fakeSdk>[1] = {}) {
    const { fn, calls } = fakeSdk(undefined, sdkOptions);
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    return { clone, calls };
  }

  function abortOnStreamEndSdk(turnDelayMs = 40) {
    const sessions: { inputs: string[] }[] = [];
    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const session = { inputs: [] as string[] };
      sessions.push(session);
      const label = `sess-abort-${String(sessions.length)}`;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: label,
          uuid: `uuid-init-${label}`,
          model: 'claude-fake',
          claude_code_version: '9.9.9-fake',
          apiKeySource: 'user',
          permissionMode: 'default',
          mcp_servers: [{ name: 'alteroid', status: 'connected' }],
        } as unknown as SDKMessage;

        const iterator = (params.prompt as AsyncIterable<{ message: { content: unknown } }>)[
          Symbol.asyncIterator
        ]();

        for (;;) {
          const current = await iterator.next();
          if (current.done === true) return;
          session.inputs.push(String(current.value.message.content));

          const lookahead = iterator.next();
          const finished = await Promise.race([
            lookahead.then((next) =>
              next.done === true ? ('closed' as const) : ('next' as const),
            ),
            new Promise<'turn'>((resolve) => setTimeout(() => resolve('turn'), turnDelayMs)),
          ]);
          if (finished === 'closed') return;

          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: label,
            uuid: `uuid-result-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;

          const next = await lookahead;
          if (next.done === true) return;
          session.inputs.push(String(next.value.message.content));
          await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: label,
            uuid: `uuid-result-b-${String(session.inputs.length)}`,
          } as unknown as SDKMessage;
        }
      }
      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;
    return { fn, sessions };
  }

  function cloneWith(fn: typeof sdkQuery, onTokenSessionRecycled?: () => void) {
    return createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      ...(onTokenSessionRecycled === undefined ? {} : { onTokenSessionRecycled }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
  }

  it('⚠️ ターンの途中では畳まない。走っているターンは最後まで走る', async () => {
    const { fn, sessions } = abortOnStreamEndSdk(40);
    const clone = cloneWith(fn);
    const events: string[] = [];
    clone.subscribe('conv-1', (event) => events.push(event.type));

    say(clone);
    await waitFor(() => sessions.length > 0, 'セッションが開くこと');
    await new Promise((resolve) => setTimeout(resolve, 10));
    clone.recycleSessionForToken();

    await waitFor(() => events.includes('done'), 'ターンが最後まで走ること');
    await clone.stop();

    expect(events).toContain('done');
    expect(events).not.toContain('error');
  });

  it('ターンが終わった境界で畳まれ、次は新しいセッションになる', async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const clone = cloneWith(fn);

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    clone.recycleSessionForToken();
    await new Promise((resolve) => setTimeout(resolve, 80));
    say(clone);

    await waitFor(() => sessions.length > 1, '2本目が開くこと');
    await clone.stop();
    expect(sessions.length).toBeGreaterThan(1);
  });

  it('⭐ 畳んだ後は同じ会話へ resume で戻る（会話を捨てない）', async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const clone = cloneWith(fn);

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    expect(sessions[0]?.resume).toBeUndefined();

    clone.recycleSessionForToken();
    await new Promise((resolve) => setTimeout(resolve, 80));
    say(clone);

    await waitFor(() => sessions.length > 1, '2本目が開くこと');
    await clone.stop();
    expect(sessions[1]?.resume).toBe('sess-lookahead-1');
  });

  it('セッションがまだ無ければ印を立てない', async () => {
    const { fn, sessions } = lookaheadSdk(5);
    const clone = cloneWith(fn);

    clone.recycleSessionForToken();

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    await new Promise((resolve) => setTimeout(resolve, 60));
    say(clone);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await clone.stop();

    expect(sessions).toHaveLength(1);
  });

  it('⚠️ 失敗した直後に畳んでも、余計な失敗が増えない（次は新しいセッションで走る）', async () => {
    let failNext = true;
    const { clone, calls } = setupRecycle({
      resultFor: () =>
        failNext ? { subtype: 'success', isError: true, text: 'Prompt is too long' } : undefined,
    });
    const events: string[] = [];
    clone.subscribe('conv-1', (event) => events.push(event.type));

    say(clone);
    await waitFor(() => events.includes('error'), '1本目が失敗すること');
    failNext = false;

    clone.recycleSessionForToken();
    await new Promise((resolve) => setTimeout(resolve, 80));
    say(clone);

    await waitFor(() => calls.length > 1, '2本目のセッションが開くこと');
    await waitFor(() => events.includes('done'), '2本目が最後まで走ること');
    await clone.stop();

    expect(events.filter((type) => type === 'error')).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('クローン全体の停止（stop）とは別物である', async () => {
    const { clone, calls } = setupRecycle();
    say(clone);
    await waitFor(() => calls.length > 0, 'セッションが開くこと');

    clone.recycleSessionForToken();
    say(clone);

    await waitFor(() => calls.length > 1, '止まらずに次が走ること');
    clone.stop();
  });

  it("セッションが無ければ 'now'、走っていれば 'deferred' を返す", async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const clone = cloneWith(fn);

    expect(clone.recycleSessionForToken()).toBe('now');

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    expect(clone.recycleSessionForToken()).toBe('deferred');
    await clone.stop();
  });

  it('畳んだ後に onTokenSessionRecycled が1度だけ鳴る', async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const recycled: number[] = [];
    const clone = cloneWith(fn, () => recycled.push(sessions.length));

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    clone.recycleSessionForToken();

    await waitFor(() => recycled.length > 0, '畳んだ知らせが鳴ること');
    expect(recycled).toEqual([1]);

    say(clone);
    await waitFor(() => sessions.length > 1, '2本目が開くこと');
    await clone.stop();
    expect(recycled).toEqual([1]);
  });

  it('ターンの最中に回しても、鳴るのは境界を越えてからである', async () => {
    const { fn, sessions } = lookaheadSdk(60);
    const recycled: string[] = [];
    const events: string[] = [];
    const clone = cloneWith(fn, () => recycled.push('rung'));
    clone.subscribe('conv-1', (event) => events.push(event.type));

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    await new Promise((resolve) => setTimeout(resolve, 10));
    clone.recycleSessionForToken();

    expect(recycled).toEqual([]);

    await waitFor(() => events.includes('done'), 'ターンが最後まで走ること');
    await waitFor(() => recycled.length > 0, '境界を越えてから鳴ること');
    await clone.stop();
    expect(recycled).toEqual(['rung']);
  });

  it('文脈窓で畳んだ回には鳴らない', async () => {
    let failNext = false;
    const { fn } = fakeSdk(undefined, {
      resultFor: () =>
        failNext ? { subtype: 'success', isError: true, text: 'Prompt is too long' } : undefined,
    });
    const recycled: string[] = [];
    const stores = createMemoryStores();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      onTokenSessionRecycled: () => recycled.push('rung'),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');

    say(clone);
    await waitFor(() => events.some((e) => e.type === 'done'), '1本目が通ること');
    failNext = true;
    say(clone);
    await waitFor(() => events.some((e) => e.type === 'error'), '2本目が長さで落ちること');
    await waitFor(
      async () => (await stores.sessions.getCloneSessionId()) === null,
      'resume 素材が捨てられること',
    );
    await clone.stop();

    expect(recycled).toEqual([]);
  });

  it('知らせが投げても畳むことは続く', async () => {
    const { fn, sessions } = lookaheadSdk(20);
    const clone = cloneWith(fn, () => {
      throw new Error('聞き手が落ちた');
    });

    say(clone);
    await waitFor(() => sessions.length > 0, '1本目が開くこと');
    clone.recycleSessionForToken();
    await new Promise((resolve) => setTimeout(resolve, 80));
    say(clone);

    await waitFor(() => sessions.length > 1, '畳まれて2本目が開くこと');
    await clone.stop();
    expect(sessions.length).toBeGreaterThan(1);
  });
});

import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { ALWAYS_REDELIVER, CLONE_MODEL, CLONE_MODEL_ENV_KEY, createClone } from './clone.js';
import { renderMemoryDocuments } from './memory.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { memoryVersion, type Stores } from './store.js';
import { createCloneMcpServer, createCloneTools } from './tools.js';
import type { ToolContext } from './tools.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, wireEvents, waitFor, waitForDone } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローン — self_status（runtime facts の配線）', () => {
  function setupCapturing(
    env: NodeJS.ProcessEnv = {},
    stores: Stores = createMemoryStores(),
    fakeSdkOptions: Parameters<typeof fakeSdk>[1] = {},
  ) {
    const { fn, calls } = fakeSdk(undefined, fakeSdkOptions);
    let captured: ToolContext | undefined;
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      mcpServerFactory: (context) => {
        captured = context;
        return createCloneMcpServer(context);
      },
    });
    const { events } = wireEvents(clone, 'conv-1');

    return {
      clone,
      events,
      calls,
      async selfStatus(): Promise<string> {
        if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
        const tools = createCloneTools(captured);
        const found = tools.find((entry) => entry.name === 'self_status');
        if (!found) throw new Error('self_status という道具が無い');
        const result = await found.handler({} as never, {});
        return (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
      },
    };
  }

  it('ALTEROID_CLONE_MODEL を置いた偽 env で呼ぶと、declaredModel がその値で出て、差し替え済みと読める', async () => {
    const s = setupCapturing({ [CLONE_MODEL_ENV_KEY]: 'まだ無いモデル' });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain('宣言されたモデル帯: まだ無いモデル');
    expect(body).toContain(`人間が \`${CLONE_MODEL_ENV_KEY}\` に置いた値`);

    await s.clone.stop();
  });

  it('env が無ければ declaredModel は既定（opus）で出て、差し替えなしと読める', async () => {
    const s = setupCapturing({});
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain(`宣言されたモデル帯: ${CLONE_MODEL}`);
    expect(CLONE_MODEL).toBe('opus');
    expect(body).toContain(`既定。\`${CLONE_MODEL_ENV_KEY}\` は置かれていない`);
    expect(body).not.toContain('に置いた値');

    await s.clone.stop();
  });

  it('偽 SDK が init で報告したモデル id が、宣言した帯とは違う文字列としてそのまま出る', async () => {
    const s = setupCapturing({ [CLONE_MODEL_ENV_KEY]: 'まだ無いモデル' });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain('claude-fake-init-model-xyz');
    const sdkLine = body.split('\n').find((line) => line.includes('SDK が実際に報告したモデル'));
    expect(sdkLine).toBeDefined();
    expect(sdkLine).not.toContain('まだ無いモデル');

    await s.clone.stop();
  });

  it('偽 SDK が init で mcp_servers: [] を報告すると、self_status は「0本」と言い「まだ分からない」は出ない', async () => {
    const s = setupCapturing({}, createMemoryStores(), { mcpServers: [] });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    const mcpLine = body.split('\n').find((line) => line.includes('MCP サーバ'));
    expect(mcpLine).toBeDefined();
    expect(mcpLine).not.toContain('まだ分からない');
    expect(mcpLine).toContain('0本');

    await s.clone.stop();
  });

  it('init を観測する前は sdkModel が「まだ分からない」で、帯の値では埋まらない', async () => {
    let releaseInit: () => void = () => undefined;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    let captured: ToolContext | undefined;
    const stores = createMemoryStores();

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        await initGate;
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-gated',
          uuid: 'uuid-init',
          model: 'claude-fake-init-model-xyz',
          claude_code_version: '9.9.9-fake',
          apiKeySource: 'user',
          permissionMode: 'default',
          mcp_servers: [{ name: 'alteroid', status: 'connected' }],
        } as unknown as SDKMessage;

        for await (const message of params.prompt as AsyncIterable<unknown>) {
          void message;
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'わかった' }] },
            parent_tool_use_id: null,
            session_id: 'sess-gated',
            uuid: 'uuid-assistant',
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: 'sess-gated',
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

    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: { [CLONE_MODEL_ENV_KEY]: 'まだ無いモデル' },
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      mcpServerFactory: (context) => {
        captured = context;
        return createCloneMcpServer(context);
      },
    });
    const { events } = wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitFor(() => captured !== undefined, '値が捕まる');

    if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
    const tools = createCloneTools(captured);
    const found = tools.find((entry) => entry.name === 'self_status');
    if (!found) throw new Error('self_status という道具が無い');
    const result = await found.handler({} as never, {});
    const body = (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');

    expect(body).toContain('SDK が実際に報告したモデル id: まだ分からない');
    expect(body).not.toContain('claude-fake-init-model-xyz');
    const mcpLine = body.split('\n').find((line) => line.includes('MCP サーバ'));
    expect(mcpLine).toBeDefined();
    expect(mcpLine).toContain('まだ分からない');
    expect(mcpLine).not.toContain('0本');

    releaseInit();
    await waitForDone(events);
    await clone.stop();
  });

  it('effort が一度も報告されていなければ「まだ分からない」で、既定値では埋まらない', async () => {
    const s = setupCapturing({});
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain('effort（実効値）: まだ分からない');
    expect(body).not.toMatch(/効な effort.*(low|medium|high|xhigh|max)/);

    await s.clone.stop();
  });

  it('PostToolUse フックが effort: xhigh を運ぶと、self_status にその値が出る', async () => {
    const s = setupCapturing({});
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const main = s.calls[0];
    const hook = main?.options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook({ effort: { level: 'xhigh' } } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    const body = await s.selfStatus();
    expect(body).toContain('effort（実効値）: xhigh');

    await s.clone.stop();
  });

  it('既定と同じ値を人間が置いた場合も「置かれている」と出る（値の比較で言い換えていない）', async () => {
    const s = setupCapturing({ [CLONE_MODEL_ENV_KEY]: CLONE_MODEL });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    expect(body).toContain(`宣言されたモデル帯: ${CLONE_MODEL}`);
    expect(body).toContain(`人間が \`${CLONE_MODEL_ENV_KEY}\` に置いた値`);
    expect(body).not.toContain('は置かれていない');

    await s.clone.stop();
  });

  it('セッションを開き直すと、前のセッションで観測したモデル id と effort を持ち越さない', async () => {
    let attempt = 0;
    let captured: ToolContext | undefined;
    const calls: Options[] = [];

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      calls.push(params.options ?? {});
      const round = ++attempt;
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        if (round === 1) {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: 'sess-first',
            uuid: 'uuid-init',
            model: 'claude-first-session-model',
            claude_code_version: '1.1.1-first',
            apiKeySource: 'user',
            permissionMode: 'default',
            mcp_servers: [{ name: 'alteroid', status: 'connected' }],
          } as unknown as SDKMessage;
          for await (const message of params.prompt as AsyncIterable<unknown>) {
            void message;
            yield {
              type: 'result',
              subtype: 'success',
              result: 'わかった',
              session_id: 'sess-first',
              uuid: 'uuid-result',
            } as unknown as SDKMessage;
            throw new Error('1本目のセッションが落ちた');
          }
          return;
        }
        for await (const message of params.prompt as AsyncIterable<unknown>) {
          void message;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: 'sess-second',
            uuid: 'uuid-result-2',
          } as unknown as SDKMessage;
        }
      }
      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      mcpServerFactory: (context) => {
        captured = context;
        return createCloneMcpServer(context);
      },
    });
    const { events } = wireEvents(clone, 'conv-1');

    async function selfStatus(): Promise<string> {
      if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
      const found = createCloneTools(captured).find((entry) => entry.name === 'self_status');
      if (!found) throw new Error('self_status という道具が無い');
      const result = await found.handler({} as never, {});
      return (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
    }

    clone.post(humanMessage('やあ'));
    await waitForDone(events);
    const hook = calls[0]?.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook({ effort: { level: 'xhigh' } } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
    const first = await selfStatus();
    expect(first).toContain('claude-first-session-model');
    expect(first).toContain('effort（実効値）: xhigh');

    events.length = 0;
    clone.post(humanMessage('もう一度'));
    await waitFor(() => calls.length === 2, '2本目の呼び出し');
    expect(calls.length).toBe(2);
    await waitForDone(events);

    const second = await selfStatus();
    expect(second).toContain('SDK が実際に報告したモデル id: まだ分からない');
    expect(second).not.toContain('claude-first-session-model');
    expect(second).toContain('effort（実効値）: まだ分からない');
    expect(second).not.toContain('effort（実効値）: xhigh');

    await clone.stop();
  });

  it('焼き込んだ記憶の文字数は、走行中に人間が記憶を直しても動かない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', `# 価値観\n\n${'あ'.repeat(50)}\n`);
    const s = setupCapturing({}, stores);

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const baked = renderMemoryDocuments(await stores.persona.documents()).length;
    const line = `焼き込んだ記憶の文字数（このセッションを組み立てた時点）: ${baked.toLocaleString('en-US')} 文字`;
    expect(await s.selfStatus()).toContain(line);

    await stores.persona.write('values', `# 価値観\n\n${'い'.repeat(5000)}\n`);
    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    expect((s.calls[0] as FakeCall).inputs[1] ?? '').toContain('記憶が更新された');

    expect(await s.selfStatus()).toContain(line);

    await s.clone.stop();
  });

  it('⭐⭐⭐ ターン終了後、self_status の「実際に払っていた入力」に free の分が混ざらない', async () => {
    const s = setupCapturing({}, createMemoryStores(), {
      getContextUsage: () => ({
        totalTokens: 12_000,
        rawMaxTokens: 200_000,
        percentage: 6,
        categories: [
          { name: 'System prompt', tokens: 8_000, kind: 'used' },
          { name: 'Tools', tokens: 1_000, kind: 'used' },
          { name: 'Remaining window', tokens: 190_000, kind: 'free' },
          { name: 'Compaction reserve', tokens: 900, kind: 'buffer' },
          { name: 'Deferred tools', tokens: 100, kind: 'deferred' },
        ],
      }),
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const body = await s.selfStatus();
    const usedLine = body.split('\n').find((line) => line.includes('実際に払っていた入力'));
    const unusedLine = body.split('\n').find((line) => line.includes('払っていない枠'));
    if (usedLine === undefined || unusedLine === undefined) {
      throw new Error('self_status に文脈占有の2行が無い');
    }
    expect(usedLine).toContain('9,000 トークン');
    expect(usedLine).not.toContain('190,000');
    expect(unusedLine).toContain('free 190,000');
    expect(unusedLine).toContain('buffer 900');
    expect(unusedLine).toContain('deferred 100');
    expect(unusedLine).toContain('分類できず 0');

    await s.clone.stop();
  });

  it('🔴 self_status を複数回呼んでも getContextUsage の呼び出し回数は増えない', async () => {
    let getContextUsageCalls = 0;
    const s = setupCapturing({}, createMemoryStores(), {
      getContextUsage: () => {
        getContextUsageCalls += 1;
        return {
          totalTokens: 1_000,
          rawMaxTokens: 200_000,
          percentage: 1,
          categories: [{ name: 'System prompt', tokens: 1_000, kind: 'used' }],
        };
      },
    });

    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    expect(getContextUsageCalls).toBe(1);

    await s.selfStatus();
    await s.selfStatus();
    await s.selfStatus();

    expect(getContextUsageCalls).toBe(1);

    await s.clone.stop();
  });
});

describe('クローン — memory_update の cause 配線（蒸留と通常ターンの区別）', () => {
  function fakeGatedSdk() {
    const calls: FakeCall[] = [];
    const gates = new Map<string, () => void>();
    let passThrough = false;

    const fn = ((params: { prompt: unknown; options?: Options }) => {
      const call: FakeCall = {
        options: params.options ?? {},
        inputs: [],
        kind: typeof params.prompt === 'string' ? 'sideQuery' : 'session',
      };
      const callIndex = calls.length;
      calls.push(call);

      async function* generate(): AsyncGenerator<SDKMessage, void> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-fake',
          uuid: 'uuid-init',
        } as unknown as SDKMessage;

        let turnIndex = 0;
        for await (const message of params.prompt as AsyncIterable<{
          message: { content: unknown };
        }>) {
          const text = String(message.message.content);
          call.inputs.push(text);
          const key = `${callIndex}:${turnIndex}`;
          if (!passThrough) {
            await new Promise<void>((resolve) => {
              gates.set(key, resolve);
            });
          }
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'わかった' }] },
            parent_tool_use_id: null,
            session_id: 'sess-fake',
            uuid: `uuid-assistant-${key}`,
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            result: 'わかった',
            session_id: 'sess-fake',
            uuid: `uuid-result-${key}`,
          } as unknown as SDKMessage;
          turnIndex += 1;
        }
      }

      const generator = generate();
      return Object.assign(generator, {
        close: () => undefined,
        interrupt: async () => undefined,
      }) as unknown as Query;
    }) as unknown as typeof sdkQuery;

    return {
      fn,
      calls,
      release(callIndex: number, turnIndex: number): void {
        const key = `${callIndex}:${turnIndex}`;
        const resolve = gates.get(key);
        if (resolve === undefined) throw new Error(`ゲート ${key} がまだ無い`);
        gates.delete(key);
        resolve();
      },
      openGate(): void {
        passThrough = true;
      },
    };
  }

  // callTool のたびに createCloneTools を呼び直さない: 呼び直すと「呼び出し時に1回だけ評価する」変異と正しい実装がテストから区別できなくなるため
  function setupGated() {
    const { fn, calls, release, openGate } = fakeGatedSdk();
    let tools: ReturnType<typeof createCloneTools> | undefined;
    const stores = createMemoryStores();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      mcpServerFactory: (context) => {
        tools = createCloneTools(context);
        return createCloneMcpServer(context);
      },
    });
    const { events, waitForEvents } = wireEvents(clone, 'conv-1');
    return {
      clone,
      stores,
      calls,
      events,
      waitForEvents,
      release,
      openGate,
      tools(): ReturnType<typeof createCloneTools> {
        if (tools === undefined) throw new Error('道具の配列がまだ作られていない');
        return tools;
      },
    };
  }

  async function callTool(
    tools: ReturnType<typeof createCloneTools>,
    name: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`${name} という道具が無い`);
    await found.handler(args as never, {} as never);
  }

  it('T1: 本セッションの蒸留ターンが書いた記憶は cause: distill になる', async () => {
    const s = setupGated();
    await s.stores.persona.write('values', '# 価値観\n\n（下書き）\n');

    s.clone.post(humanMessage('やあ'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '1本目の入力');
    s.release(0, 0);
    await waitForDone(s.events);

    const endPromise = s.clone.endConversation('conv-1');
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 2, '蒸留ターンの入力');
    expect(s.calls[0]?.inputs[1]).toContain('記憶へ移すべきものがあるか確認せよ');

    await callTool(s.tools(), 'memory_write', {
      slug: 'values',
      content: '# 価値観\n\n蒸留が書いた\n',
      summary: '蒸留の書き込みテスト（T1）',
      base_version: memoryVersion((await s.stores.persona.read('values'))!.content),
    });

    s.release(0, 1);
    await endPromise;

    const entries = await s.stores.journal.list({ types: ['memory_update'] });
    expect(entries.at(-1)).toMatchObject({ cause: 'distill' });

    s.openGate();
    await s.clone.stop();
  });

  it('T2: 本セッションの通常ターン（人間の発言）が書いた記憶は cause: clone のまま', async () => {
    const s = setupGated();

    s.clone.post(humanMessage('やあ'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '通常ターンの入力');

    await callTool(s.tools(), 'memory_write', {
      slug: 'values',
      content: '# 価値観\n\n通常ターンが書いた\n',
      summary: '通常ターンの書き込みテスト（T2）',
    });

    s.release(0, 0);
    await waitForDone(s.events);

    const entries = await s.stores.journal.list({ types: ['memory_update'] });
    expect(entries.at(-1)).toMatchObject({ cause: 'clone' });

    const stopPromise = s.clone.stop();
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 2, 'shutdown 蒸留の入力');
    s.release(0, 1);
    await stopPromise;
  });

  it('T3: pre_compact のサイドクエリが書いた記憶は cause: distill になる', async () => {
    const { fn, calls } = fakeSdk();
    const toolsLists: ReturnType<typeof createCloneTools>[] = [];
    const stores = createMemoryStores();
    await stores.persona.write('values', '# 価値観\n\n（下書き）\n');
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      mcpServerFactory: (context) => {
        toolsLists.push(createCloneTools(context));
        return createCloneMcpServer(context);
      },
    });
    const { events } = wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitForDone(events);

    const main = calls[0] as FakeCall;
    const dir = await makeTempDir('alteroid-distill-cause-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const preCompact = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (preCompact === undefined) throw new Error('PreCompact フックが登録されていない');
    await preCompact(
      { session_id: 'sess-fake', transcript_path: transcriptPath } as never,
      undefined,
      { signal: new AbortController().signal } as never,
    );

    expect(toolsLists.length).toBe(2);
    const sideTools = toolsLists[1];
    if (sideTools === undefined) throw new Error('サイドクエリの道具の配列が控えられていない');

    await callTool(sideTools, 'memory_write', {
      slug: 'values',
      content: '# 価値観\n\nサイドクエリが書いた\n',
      summary: 'サイドクエリの書き込みテスト（T3）',
      ...((await stores.persona.read('values')) === null
        ? {}
        : { base_version: memoryVersion((await stores.persona.read('values'))!.content) }),
    });

    const entries = await stores.journal.list({ types: ['memory_update'] });
    expect(entries.at(-1)).toMatchObject({ cause: 'distill' });

    await clone.stop();
  });

  it('T4: 蒸留が追記すると、cause: distill と action: append の両方が出る', async () => {
    const s = setupGated();

    s.clone.post(humanMessage('やあ'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '1本目の入力');
    s.release(0, 0);
    await waitForDone(s.events);

    const endPromise = s.clone.endConversation('conv-1');
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 2, '蒸留ターンの入力');

    await callTool(s.tools(), 'memory_append', {
      slug: 'values',
      content: '追記した学び\n',
      summary: '蒸留の追記テスト（T4）',
    });

    s.release(0, 1);
    await endPromise;

    const entries = await s.stores.journal.list({ types: ['memory_update'] });
    expect(entries.at(-1)).toMatchObject({ cause: 'distill', action: 'append' });

    s.openGate();
    await s.clone.stop();
  });
});

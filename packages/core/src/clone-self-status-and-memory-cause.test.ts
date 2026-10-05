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

/**
 * `self_status`（`self.ts` の `CloneRuntimeFacts`）の配線。
 *
 * **`createSdkMcpServer` は道具を MCP の transport の裏へ隠すので、テストから
 * ハンドラを直接呼べない。** `mcpServerFactory`（クローンの `CloneOptions`。
 * 主にテスト用、既定は `createCloneMcpServer`）でその境界を覗く — 差し替えた
 * 関数は渡ってきた `context`（クローンが実際に組み立てたもの。`runtime` を含む）
 * を控えたうえで、本物の `createCloneMcpServer(context)` をそのまま呼ぶ。
 * 道具の実装もクローンが渡す `context` も本物のまま、呼び出しの境界だけを覗ける。
 *
 * `self_status` 自身のハンドラは、控えた `context` から独立に
 * `createCloneTools(context)` を呼んで取り出す（`tools.test.ts` と同じ形）。
 */
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
    // 宣言した帯の値では埋まっていない（「SDK が実際に報告した」行だけを見る）
    const sdkLine = body.split('\n').find((line) => line.includes('SDK が実際に報告したモデル'));
    expect(sdkLine).toBeDefined();
    expect(sdkLine).not.toContain('まだ無いモデル');

    await s.clone.stop();
  });

  /**
   * **`#captureInitFacts` が本物の init メッセージから読んだ `[]` を、そのまま
   * 「観測できた0本」として `self_status` まで運ぶことを確かめる（#324）。**
   * `self.ts` 側の単体テストは `describeCloneRuntime` に直接 `mcpServers: []` を
   * 渡すだけなので、`clone.ts` が実際に init の `mcp_servers: []` を `null` に
   * 潰さず配線できているかはここでしか見えない —— 直しの本体は `clone.ts` の
   * 側（init を観測したかどうかを実際に区別できること）である。
   */
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

  /**
   * **init が届く前の窓を、タイミングの賭けではなく実際にゲートで止めて作る。**
   * `fakeSdk` は init を即座に流すので、ここだけは init の前で止められる専用の
   * 偽 SDK をローカルに用意する（`#buildOptions` は `#ensureQuery` の中で
   * 呼ばれるので、context は init 到着より前に控えられる — その順序を利用する）。
   */
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
          void message; // 入力の中身は見ない。到着したことだけが要る。
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
    // `#buildOptions`（→ `mcpServerFactory`）は `#ensureQuery` の中、init が
    // 届くより前に走る。ここで context が控えられるのを待つ（init はまだ
    // `initGate` で止めてある）。
    await waitFor(() => captured !== undefined, '値が捕まる');

    if (captured === undefined) throw new Error('ToolContext がまだ捕まっていない');
    const tools = createCloneTools(captured);
    const found = tools.find((entry) => entry.name === 'self_status');
    if (!found) throw new Error('self_status という道具が無い');
    const result = await found.handler({} as never, {});
    const body = (result.content ?? []).map((part) => ('text' in part ? part.text : '')).join('');

    expect(body).toContain('SDK が実際に報告したモデル id: まだ分からない');
    expect(body).not.toContain('claude-fake-init-model-xyz');
    // init 未観測のこの窓では MCP サーバも「まだ分からない」——「0本」ではない
    // （#324）。gate の向こう側で init は非空の mcp_servers を運んでくるので、
    // ここで「0本」が出ていたら「未観測」と「観測できた0本」を区別できていない。
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

    // **偽 SDK に本物として登録されたフックを、実際に呼ぶ。** 私有フィールドを
    // 直接触らない（`options.hooks.PostToolUse[0].hooks[0]` を叩く。既存の
    // PreCompact フックのテストと同じ形）。
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
    // 置いた値が既定と同じでも、置かれている事実は消えない
    expect(body).toContain(`人間が \`${CLONE_MODEL_ENV_KEY}\` に置いた値`);
    expect(body).not.toContain('は置かれていない');

    await s.clone.stop();
  });

  /**
   * **セッションを開き直したら、前のセッションで観測した値は捨てる。**
   *
   * 残すと、新しいセッションの init が届く前（あるいは届かないまま）に
   * `self_status` が前のセッションの値を「いまの値」として返す — 観測していない
   * ものを確信する形になり、この道具の存在理由そのものが壊れる。
   *
   * 1本目のセッションは init（モデル id 付き）を流してから落ち、2本目は
   * **init を1度も流さない**偽 SDK を使う。持ち越していれば1本目の値が出る。
   */
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
          // 1往復だけ返してからセッションが落ちる（＝ `#query` が捨てられる）。
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
        // 2本目は init を1度も流さない。**持ち越していればここで1本目の値が出る。**
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

    // 1本目 — init を観測し、フックで effort も観測させる。
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

    // 2本目 — セッションが落ちたので開き直る（`calls` が2本になるまで待つ）。
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

  /**
   * `injectedMemoryChars` が名乗っているのは**「このセッションを組み立てた時点」**の
   * 文字数である。
   *
   * かつてこの値は、載せ直しの控え（記憶の全文を持っていたフィールド）の長さを
   * そのまま返していた。載せ直しが起きるとその控えが更新されるので、**走行中に
   * 人間が記憶を直すと、この行だけが黙って「いまの総文字数」に化けていた**
   * （そう名乗っていないのに）。`tools.test.ts` は固定値を渡すので、この配線の
   * ずれはクローン側から見ないと出ない。
   */
  it('焼き込んだ記憶の文字数は、走行中に人間が記憶を直しても動かない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('values', `# 価値観\n\n${'あ'.repeat(50)}\n`);
    const s = setupCapturing({}, stores);

    s.clone.post(humanMessage('1回目'));
    await waitForDone(s.events);

    const baked = renderMemoryDocuments(await stores.persona.documents()).length;
    const line = `焼き込んだ記憶の文字数（このセッションを組み立てた時点）: ${baked.toLocaleString('en-US')} 文字`;
    expect(await s.selfStatus()).toContain(line);

    // 人間が記憶を大きく書き換える（載せ直しが起きる量にする）
    await stores.persona.write('values', `# 価値観\n\n${'い'.repeat(5000)}\n`);
    const { events } = wireEvents(s.clone, 'conv-2');
    s.clone.post(humanMessage('2回目', 'conv-2'));
    await waitForDone(events);
    // 載せ直しが実際に起きたことを確かめてから、動いていないことを見る
    expect((s.calls[0] as FakeCall).inputs[1] ?? '').toContain('記憶が更新された');

    expect(await s.selfStatus()).toContain(line);

    await s.clone.stop();
  });

  /**
   * **`#804` の輪を閉じる — ターンの境界で聞いた文脈占有の `kind` 別内訳が、
   * `self_status` まで実際に届くか。** `context-usage.test.ts` は
   * `summarizeContextCategories` を単体で見るだけなので、クローンの
   * `#lastContextUsage` → `#runtimeFacts` → `describeCloneRuntime` という
   * 配線そのものはここでしか見えない。
   *
   * ⭐⭐⭐ **核心の歯**: `free` の軸を混ぜても、「実際に払っていた入力」の
   * 数値に free の分が1トークンも入らないこと。
   */
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
    // used は System prompt + Tools の合計だけ（free/buffer/deferred を1トークンも含まない）。
    expect(usedLine).toContain('9,000 トークン');
    expect(usedLine).not.toContain('190,000');
    // unused 側は free/buffer/deferred の内訳を持ち、「分類できず」も名乗る。
    expect(unusedLine).toContain('free 190,000');
    expect(unusedLine).toContain('buffer 900');
    expect(unusedLine).toContain('deferred 100');
    expect(unusedLine).toContain('分類できず 0');

    await s.clone.stop();
  });

  /**
   * 🔴 **`getContextUsage` の呼び出し回数が増えないことの歯（#804）。** Issue が
   * 「`detail: 'full'` は token-count API を呼ぶので、毎ターン呼ぶ費用を測って
   * から決めること」と釘を刺している——`self_status` を何回呼んでも、
   * `#lastContextUsage` は既に払った1回の観測を保持するだけで、新しい呼び出し
   * を1本も増やさないことを数値で確かめる。
   */
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

    // ターンをまたいでいないので、まだ1回のまま。
    expect(getContextUsageCalls).toBe(1);

    await s.clone.stop();
  });
});

/**
 * `memory_update.cause` の配線 — 蒸留のターンが書いた記憶と、通常のターンが
 * 書いた記憶を、日誌の上で区別できるか。
 *
 * enum に `'distill'` があっても、それを書く本番コードが1つも無ければ、
 * 絞り込んだ側には常に `'clone'` が返り、蒸留は記憶を書いていないと読める。
 * `AGENTS.md`「踏みやすい地雷」の**「取れない軸に 0 の行を作る」**（＝「使って
 * いない」と読める／取れないことが出力から消える）と同じ形だが、**ここは
 * それより一段悪い — 軸は取れる**（実行文脈から導ける）**のに、取れるものに
 * ついて嘘の 0 を出していた。** しかも `cause` の enum は
 * `apps/daemon/openapi.json` に載っている公開の契約なので、その 0 は外へ
 * 出ていた。
 *
 * **`docs/PRD.md`「provider が持たない能力を、持っているように見せない」は
 * ここの根拠ではない。** あちらは provider の能力（許可確認を上げられない
 * provider に「それらしい確認」を出す形）についての要件であって、字義が違う。
 */
describe('クローン — memory_update の cause 配線（蒸留と通常ターンの区別）', () => {
  /**
   * 各ターンの入力が届いた直後、外から解放するまで待つ偽 SDK。
   *
   * **`fakeSdk` では代用できない** — あちらの `reply` は同期関数で `await` を
   * 挟めない。ここでは「入力が届いた（＝ `Clone#turn` が立ち、`kind` が確定
   * した）」瞬間と「結果を返す」瞬間のあいだへ、外から割り込む窓を作る。
   * 窓の中で道具のハンドラを直接呼べば、「そのターンが走っている最中に
   * 書いた記憶」の `cause` を確かめられる。
   *
   * **ターンの外で呼ぶと意味を失う** — `#turn` は `#finishTurn()` でターンの
   * 終わりに `null` へ戻るので、外側で呼ぶと `memoryCause` は既定の `'clone'`
   * に落ち、「蒸留ターンが走っている最中に書いた」という条件を確かめられない。
   */
  function fakeGatedSdk() {
    const calls: FakeCall[] = [];
    const gates = new Map<string, () => void>();
    // 素通しスイッチ。`true` にした後に届く入力はゲートへ登録せず、その場で
    // 先へ進む（誰も `release` を呼ばなくても対応する `result` まで進む）。
    // 片付け（`stop()` など）を、本番の重複防止（`#hasUndistilledActivity`）の
    // 挙動——見送られるか、もう1本ターンが増えるか——に依存させないための道具。
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
          // **ここで止める。** 解放されるまで、このターンは「走っている最中」
          // のままである（`this.#turn` が立ち、`kind` が確定している）。
          // ただし素通しスイッチが入っていれば待たずに先へ進む。
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
      /** 指定したターンの窓を解放する（まだ届いていなければ例外で落ちる）。 */
      release(callIndex: number, turnIndex: number): void {
        const key = `${callIndex}:${turnIndex}`;
        const resolve = gates.get(key);
        if (resolve === undefined) throw new Error(`ゲート ${key} がまだ無い`);
        gates.delete(key);
        resolve();
      },
      /**
       * 以後届く入力はゲートで待たず素通しする。**片付けの直前に呼ぶこと。**
       * これを呼んだ後は、本番の重複防止が「見送る」か「もう1本ターンを
       * 増やす」かのどちらであっても、そのターンはゲートに引っかからず
       * 進むので、片付けが本番の別の機能の挙動へ依存しなくなる。
       */
      openGate(): void {
        passThrough = true;
      },
    };
  }

  /**
   * `setup` と同じ配線（本物の SDK やマネージャーを誤って起こさない）だが、
   * `queryFn` を `fakeGatedSdk` に差し替え、`mcpServerFactory` の中で
   * **本物の配線と同じタイミングで一度だけ** `createCloneTools` を呼んで
   * 道具の配列を控える。
   *
   * **`callTool` のたびに `createCloneTools` を呼び直さないこと。** 本番では
   * `createCloneTools` はセッションを組むとき（`mcpServerFactory` 呼び出し時）
   * に一度だけ呼ばれ、以後のターンはすべて同じ道具の配列を使い回す
   * （`createCloneMcpServer` の中）。呼び直す形でテストを書くと、
   * 「`createCloneTools` の呼び出し時に1回だけ評価する」変異
   * （`memoryCause` をハンドラの外で先に確定させる形）と「道具の実行時に
   * 毎回評価する」正しい実装が、テストからは区別できなくなる — 呼び直す
   * たびに変異後のコードも新しく評価し直されてしまうため。
   */
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

  /** 控えた道具の配列から1本取り出し、ハンドラを直接呼ぶ。 */
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
    // **human guard（記憶の保護）の前提を先に満たしておく。** `values` に
    // 一度も書き込みが無い（履歴が無い＝ unknown）状態のまま distill から
    // `memory_write`（全文置換）すると、その歯で断られてしまい journal に
    // `memory_update` が1件も残らない——ここで確かめたいのは「distill が書けば
    // cause: distill になる」ことであって、歯そのものはガードのテスト
    // （`tools.test.ts`）が持つ。既存の記憶を蒸留が上書きする、という現実の
    // 形に合わせて先に1回 clone-only の下書きを作っておく。
    await s.stores.persona.write('values', '# 価値観\n\n（下書き）\n');

    // 1本目 — 通常ターンをまず1本通し、セッションを確立する
    // （`endConversation` は `this.#query` が無ければ何もしない）。
    s.clone.post(humanMessage('やあ'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 1, '1本目の入力');
    s.release(0, 0);
    await waitForDone(s.events);

    // 2本目 — 会話終了で促される蒸留ターン。`endConversation` は完了を待つので
    // await せず、ターンが走っている最中に道具を呼んでから解放する。
    const endPromise = s.clone.endConversation('conv-1');
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 2, '蒸留ターンの入力');
    // 見分け方は文面（`buildDistillPrompt` が書く固定の呼びかけ）。
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

    // 片付け。`stop()` が shutdown 蒸留をもう1本走らせるかどうか
    // （＝重複防止 `#hasUndistilledActivity` が下りているか）に依存しない
    // よう、以後の入力はゲートで待たず素通しにする。見送られて新しい
    // ターンが増えなくても、増えても、どちらでも `stop()` は返る。
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

    // ここでは `#hasUndistilledActivity` がまだ立っているので、`stop()` は
    // shutdown 蒸留をもう1本走らせる。そのターンも解放してやる必要がある
    // （解放しないと `stop()` が `#reader` の完了待ちで戻らない）。
    const stopPromise = s.clone.stop();
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) === 2, 'shutdown 蒸留の入力');
    s.release(0, 1);
    await stopPromise;
  });

  it('T3: pre_compact のサイドクエリが書いた記憶は cause: distill になる', async () => {
    const { fn, calls } = fakeSdk();
    // **ここも `mcpServerFactory` の呼び出し時に一度だけ `createCloneTools` を
    // 呼ぶ**（`setupGated` の doc と同じ理由。本セッションとサイドクエリで
    // それぞれ1回ずつ呼ばれるので、道具の配列も2本控わる）。
    const toolsLists: ReturnType<typeof createCloneTools>[] = [];
    const stores = createMemoryStores();
    // T1 と同じ理由（human guard: 履歴の無い `values` への distill 全文置換は
    // 断られる。ここで確かめたいのは cause: distill のタグ付けであって、
    // 歯そのものは `tools.test.ts` が持つ）。
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

    // `mcpServerFactory` は本セッションの初期化で1回、サイドクエリでもう1回呼ばれる。
    // **サイドクエリで控えた側（2回目）を使う**（依頼書の指示どおり）。
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

    // 片付け。T1 と同じ理由で、以後の入力はゲートで待たず素通しにする。
    s.openGate();
    await s.clone.stop();
  });
});

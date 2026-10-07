import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir, makeTempDirSync } from '../../../vitest.tmpdir.js';

import { cloneMcpServers } from './claude-provider.js';
import {
  CLONE_TOOL_RELAY_SOCKET_ENV,
  CLONE_TOOL_RELAY_TOKEN_ENV,
} from './clone-tool-relay-child.js';
import { buildCloneToolRelayChildDistForTesting } from './clone-tool-relay-child-build.test-support.js';
import { CLONE_TOOLS_TRANSPORT_ENV_KEY } from './clone-tools-transport.js';
import { ALWAYS_REDELIVER, CLONE_MODEL_ENV_KEY, createClone } from './clone.js';
import { DEFAULT_PERMISSION_MODE } from './permission-mode.js';
import { buildManagerSystemPrompt, buildWorkerPrompt } from './prompt.js';
import {
  MANAGER_AUTO_MEMORY_ENV_KEY,
  MANAGER_MODEL,
  MANAGER_MODEL_ENV_KEY,
  WORKER_AGENT_NAME,
  WORKER_MODEL,
  WORKER_MODEL_ENV_KEY,
  createRunnerHost,
  type RunnerHost,
} from './runner.js';
import { CLONE_ALLOWED_TOOLS, CLONE_TOOL_NAMES, MCP_SERVER_NAME } from './tools.js';
import { createMemoryStores, humanMessage } from './testing.js';

/**
 * これは特性試験（characterization test）である。
 *
 * ここで固定したいのは「SDK の `query()` へ実際に渡している `Options` の中身」
 * そのもの。この後のリファクタが `options` の組み立て方を変えても、SDK へ渡る
 * 値そのものが変わっていないことを、このファイルが1文字も変わらずに保証する
 * （リファクタ側の作業者はこのファイルを書き換えずに green で通すことが目標）。
 *
 * **「無いこと」の固定が本題である**（AGENTS.md 地雷1・2・7 / `tools` を絞らない・
 * `maxTurns` で止めない・クローンには `canUseTool` を繋がない）。既存の実装が
 * これらを守っていることは複数のコメントで説明されているが、その説明はコードから
 * 読み手が離れれば追従しない。ここでは「無い」ことそのものを assertion にする。
 */

/**
 * Issue #1917: 下の stdio e2e 歯（「子プロセスを実際に spawn する」）が本物の
 * `packages/core/dist/clone-tool-relay-child.js` を読んでいた。`clone.ts` は
 * `resolveCloneToolRelayChildEntry(import.meta.url)`（`clone-tools-transport.ts`）
 * で `../dist/clone-tool-relay-child.js` を解決するので、テスト側から差し込む
 * 既存の口が無い（`createClone` のオプションは `cloneToolRelaySocketDir` だけを
 * 持ち、子プロセスの実体そのものは差し替えられない）。
 *
 * **製品コードに新しい注入口は足していない。** `clone.ts` は
 * `resolveCloneToolRelayChildEntry` を `./clone-tools-transport.js` から
 * 名前 import しているだけなので、この1本の named export だけを vitest の
 * モジュールモックで差し替える——他の export（`resolveCloneToolsTransport` /
 * `CLONE_TOOLS_TRANSPORT_ENV_KEY` など）は `importOriginal` で本物のまま
 * 素通しする。返す値は `clone-tool-relay-integration.test.ts` と同じ
 * `clone-tool-relay-child-build.test-support.ts` が一時ディレクトリへ build
 * した成果物——束ね方の回帰（共有チャンクへの括り出し）を捕まえる力は、
 * 本物の tsup で束ねること自体から来るので、ここでも落ちない。
 *
 * `vi.hoisted` が要る理由: `vi.mock` はファイル先頭へ引き上げられる（hoist
 * される）ので、下の `const relayChildEntryDist = { path: undefined }` を
 * 素の `const` で書くと、引き上げられた `vi.mock` のファクトリが実行される
 * 時点でまだ束縛されておらず（TDZ）例外になる——`AGENTS.md`「時刻の扱い」の
 * `reports.test.tsx` と同じ注意。
 */
const relayChildEntryDist = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock('./clone-tools-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./clone-tools-transport.js')>();
  return {
    ...actual,
    resolveCloneToolRelayChildEntry: () => {
      if (relayChildEntryDist.path === undefined) {
        throw new Error(
          'clone-tool-relay-child-build.test-support.ts の build がまだ終わっていない' +
            '（beforeAll の完了前に呼ばれた）',
        );
      }
      return relayChildEntryDist.path;
    },
  };
});

// ---------------------------------------------------------------------------
// A. クローン本セッション
// ---------------------------------------------------------------------------

/**
 * クローンの `queryFn` を差し替えて `options` を捕まえる偽 SDK。
 *
 * `runner-registry.test.ts` の `fakeSdk(sessions)` と同じ形（`params.options`
 * を配列へ積むだけ）だが、クローンは本セッション（入力は非同期イテラブル）と
 * 蒸留のサイドクエリ（入力は文字列）の両方で `queryFn` を呼ぶので、両方が
 * 完了できるようにしてある。
 *
 * - 非同期イテラブルのとき（本セッション）: 入力を受け取るたびに1往復
 *   （assistant + result）を返す。`clone.stop()` が入力ストリームを終わらせると
 *   自然にこの `for await` も終わる。
 * - 文字列のとき（蒸留のサイドクエリ）: 即座に1往復を返して終わる
 *   （`#distillFromTranscript` の `for await` が `result` を受け取れないと
 *   永久に終わらない）。
 */
function fakeCloneSdk(): { fn: typeof sdkQuery; calls: { options: Options }[] } {
  const calls: { options: Options }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    calls.push({ options: params.options ?? {} });

    function* turn(): Generator<SDKMessage> {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'わかった' }] },
        parent_tool_use_id: null,
        session_id: 'sess-fake',
        uuid: 'uuid-assistant',
      } as unknown as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        result: 'わかった',
        session_id: 'sess-fake',
        uuid: 'uuid-result',
      } as unknown as SDKMessage;
    }

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-fake',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      const { prompt } = params;
      if (typeof prompt === 'string') {
        yield* turn();
        return;
      }

      for await (const message of prompt as AsyncIterable<unknown>) {
        void message; // ここで見たいのは options の中身だけなので読み捨てる
        yield* turn();
      }
    }

    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, calls };
}

describe('クローン本セッションへ渡す Options', () => {
  // Issue #1917: このファイルの stdio 関連の歯（下の3本）が
  // `resolveCloneToolRelayChildEntry` を経由して読む成果物を、ここで1回だけ
  // 一時ディレクトリへ build しておく（ファイル冒頭の doc）。
  beforeAll(async () => {
    relayChildEntryDist.path = await buildCloneToolRelayChildDistForTesting(
      'agent-session-options-relay-child-dist-',
    );
  }, 60_000);

  it('既定のモデル帯・道具の配置・許可モードを固定する', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const clone = createClone({ stores, queryFn: fn, env: {}, redeliveryGate: ALWAYS_REDELIVER });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const { options } = calls[0] as { options: Options };

    // 既定はクローン = Opus（2026-09-30 の人間の決定で Fable から変更）。差し替えられるのは
    // 人間の承認だけである（AGENTS.md 地雷5）。
    expect(options.model).toBe('opus');
    // preset 一式（明示リストで絞らない = 地雷1）。CLONE_ALLOWED_TOOLS は
    // 「確認なしで通す一覧」であって「使える道具の一覧」ではない。
    expect(options.allowedTools).toEqual(CLONE_ALLOWED_TOOLS);
    expect(options.permissionMode).toBe(DEFAULT_PERMISSION_MODE);
    expect(Object.keys(options.mcpServers ?? {})).toEqual([MCP_SERVER_NAME]);
    expect(typeof options.systemPrompt).toBe('string');
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.includePartialMessages).toBe(true);

    // PreCompact は1件、PostToolUse も1件。
    expect(options.hooks?.PreCompact).toHaveLength(1);
    // **`PRE_COMPACT_HOOK_TIMEOUT_SECONDS` は clone.ts の非 export な定数である
    // （`export` が付いていない）。本番コードを変えずに import できないので、
    // ここはリテラル 120 で固定する。リファクタでこの値が変わればここが落ちて
    // 気づける（characterization test として意味は保たれる）。
    expect(options.hooks?.PreCompact?.[0]?.timeout).toBe(120);
    expect(options.hooks?.PostToolUse).toHaveLength(1);
    // 失敗・中断した道具呼び出しも観測する（Issue #924）。`PostToolUse` と
    // 排他で発火するので、両方に登録しても二重記録にはならない。
    expect(options.hooks?.PostToolUseFailure).toHaveLength(1);

    // --- ⭐ 「無いこと」の固定 ---
    // `tools` は渡さない（地雷1: 明示リストで絞らない = preset 一式）。
    expect(options.tools).toBeUndefined();
    // `maxTurns` は渡さない（地雷2: 回数上限で暴走を止めない）。
    expect(options.maxTurns).toBeUndefined();
    // `canUseTool` は繋がない。クローンは長寿命セッション1本で受信箱の全ターンが
    // そこを直列に通るので、ここで人間の回答を待って止めると全部が止まる
    // （clone.ts の `#buildOptions` 内コメント。マネージャーとは事情が違う）。
    expect(options.canUseTool).toBeUndefined();
    // 初回なので resume 素材が無い（resume は null のときキーごと渡されない）。
    expect(options.resume).toBeUndefined();
    // `settings`（auto-memory を塞ぐ口）はクローン側には無い（#1189）。
    // `buildManagerSessionOptions` だけが持つ引数で、`buildCloneSessionOptions`
    // は `managerAutoMemoryEnabled` を受け取らない — auto-memory が「書いた本人の
    // 次のセッション」に届くという前提は、長寿命1本のクローンでは崩れていない。
    expect(options.settings).toBeUndefined();

    await clone.stop();
  });

  it('ALTEROID_CLONE_MODEL を置くとモデル帯が差し替わる', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn: fn,
      env: { [CLONE_MODEL_ENV_KEY]: 'opus' },
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    expect((calls[0] as { options: Options }).options.model).toBe('opus');

    await clone.stop();
  });

  // -------------------------------------------------------------------------
  // クローンの道具の中継（Issue #486 48(a) PR2）: ALTEROID_CLONE_TOOLS_TRANSPORT
  // -------------------------------------------------------------------------

  it('ALTEROID_CLONE_TOOLS_TRANSPORT 未設定・空・空白は、今日どおり type: sdk のまま（既定固定）', async () => {
    for (const value of [undefined, '', '   ']) {
      const { fn, calls } = fakeCloneSdk();
      const stores = createMemoryStores();
      const clone = createClone({
        stores,
        queryFn: fn,
        env: value === undefined ? {} : { [CLONE_TOOLS_TRANSPORT_ENV_KEY]: value },
        redeliveryGate: ALWAYS_REDELIVER,
      });

      clone.post(humanMessage('やあ'));
      await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

      const mcpServers = (calls[0] as { options: Options }).options.mcpServers ?? {};
      expect(Object.keys(mcpServers)).toEqual([MCP_SERVER_NAME]);
      const own = mcpServers[MCP_SERVER_NAME] as { type?: string; alwaysLoad?: boolean };
      expect(own.type).toBe('sdk');
      // **`alwaysLoad` はここでは「渡していない」欄そのものが無い**
      // （`McpSdkServerConfig` は `timeout` しか持たない）。stdio 側と
      // 同じ「揃っている」を、後続の stdio テストと対で固定する。
      expect(own.alwaysLoad).toBeUndefined();

      await clone.stop();
    }
  });

  it('ALTEROID_CLONE_TOOLS_TRANSPORT=stdio のとき、鍵は同じ1本のまま type: stdio へ切り替わる', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const socketDir = makeTempDirSync('clone-tool-relay-wire-');
    const clone = createClone({
      stores,
      queryFn: fn,
      env: { [CLONE_TOOLS_TRANSPORT_ENV_KEY]: 'stdio' },
      cloneToolRelaySocketDir: socketDir,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const mcpServers = (calls[0] as { options: Options }).options.mcpServers ?? {};
    // **鍵は `sdk` のときと同じ1本のまま**（`MCP_SERVER_NAME`）。
    expect(Object.keys(mcpServers)).toEqual([MCP_SERVER_NAME]);
    const own = mcpServers[MCP_SERVER_NAME] as {
      type?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      alwaysLoad?: boolean;
    };
    expect(own.type).toBe('stdio');
    expect(own.command).toBe(process.execPath);
    expect(own.args).toHaveLength(1);
    expect(own.args?.[0]).toMatch(/clone-tool-relay-child\.js$/);
    expect(Object.keys(own.env ?? {}).sort()).toEqual(
      [CLONE_TOOL_RELAY_SOCKET_ENV, CLONE_TOOL_RELAY_TOKEN_ENV].sort(),
    );
    // **in-process（sdk）と同じ扱い。** 今日は渡していない——stdio 側にだけ
    // `alwaysLoad` を足すと、transport を切り替えただけで道具の読み込みの
    // タイミングが変わってしまう（`#mcpServerConfigFor` の doc）。
    expect(own.alwaysLoad).toBeUndefined();

    await clone.stop();
  });

  it('ALTEROID_CLONE_TOOLS_TRANSPORT に未知の値を置くと、黙って倒さずに構築そのものを止める', () => {
    const { fn } = fakeCloneSdk();
    const stores = createMemoryStores();
    expect(() =>
      createClone({
        stores,
        queryFn: fn,
        env: { [CLONE_TOOLS_TRANSPORT_ENV_KEY]: 'stido' }, // 綴りの間違いを模す
        redeliveryGate: ALWAYS_REDELIVER,
      }),
    ).toThrow(/ALTEROID_CLONE_TOOLS_TRANSPORT/);
  });

  it(
    'stdio モードでも clone.ts の配線を通して本物の createCloneMcpServer へ ' +
      'tools/list が CLONE_TOOL_NAMES の全本数（52本）届く（実際に子プロセスを spawn する）',
    async () => {
      // **Issue #1917 でビルド済み成果物の出所を変えた。** 本物の
      // `packages/core/dist/clone-tool-relay-child.js` ではなく、ファイル
      // 冒頭の `vi.mock('./clone-tools-transport.js', ...)` が差し込む
      // テスト専用の一時ビルド（`clone-tool-relay-child-build.test-support.ts`）
      // を読む。`pnpm build` を先に走らせる必要はない——`beforeAll` が
      // このテストファイル自身の中で build を済ませている。
      const { fn, calls } = fakeCloneSdk();
      const stores = createMemoryStores();
      const socketDir = makeTempDirSync('clone-tool-relay-wire-e2e-');
      const clone = createClone({
        stores,
        queryFn: fn,
        env: { [CLONE_TOOLS_TRANSPORT_ENV_KEY]: 'stdio' },
        cloneToolRelaySocketDir: socketDir,
        redeliveryGate: ALWAYS_REDELIVER,
      });

      clone.post(humanMessage('やあ'));
      await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

      // clone.ts が実際に組み立てた設定（本物の token・socketPath・子プロセスの
      // 絶対パス）をそのまま使って、本物の MCP クライアントで繋ぎに行く——
      // `queryFn` を差し替えてあるので SDK 自身はこの設定を一度も使わないが、
      // ここではその設定を横取りして自分で使う。
      const own = ((calls[0] as { options: Options }).options.mcpServers ?? {})[
        MCP_SERVER_NAME
      ] as { command: string; args: string[]; env: Record<string, string> };

      const transport = new StdioClientTransport({
        command: own.command,
        args: own.args,
        env: own.env,
      });
      const client = new Client({ name: 'agent-session-options.test', version: '0' });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([...CLONE_TOOL_NAMES].sort());
      } finally {
        await client.close();
      }

      await clone.stop();
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// B. マネージャー（runner 側）
// ---------------------------------------------------------------------------

interface Started {
  options: Options;
}

/**
 * `runner-credentials.test.ts` / `runner-profile.test.ts` と同じ形の偽 SDK。
 * `host.start(...)` は `RunnerSession#begin` → `#open` を同期に辿って
 * `queryFn` を呼ぶので、`await host.start(...)` の直後に `started[n].options`
 * が読める。
 */
function fakeRunnerSdk(): { fn: typeof sdkQuery; started: Started[] } {
  const started: Started[] = [];
  const fn = ((input: { options: Options }) => {
    started.push({ options: input.options });
    let finish: (() => void) | undefined;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, started };
}

describe('マネージャー（runner）へ渡す Options', () => {
  let dir: string;
  let host: RunnerHost | undefined;

  beforeEach(() => {
    dir = makeTempDirSync('alteroid-agent-session-options-');
  });

  afterEach(async () => {
    await host?.shutdown().catch(() => undefined);
  });

  it('既定のモデル帯・道具の配置・許可モードを固定する', async () => {
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: {},
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    // 既定はマネージャー = Opus。
    expect(options.model).toBe('opus');
    expect(MANAGER_MODEL).toBe('opus');
    // preset 一式（append だけを足す形。type/preset はリテラルで固定する）。
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    expect(typeof (options.systemPrompt as { append?: unknown }).append).toBe('string');

    // 作業者層の本体は1個だけ、既定は Sonnet。
    const agentKeys = Object.keys(options.agents ?? {});
    expect(agentKeys).toEqual([WORKER_AGENT_NAME]);
    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as { model?: unknown };
    expect(worker.model).toBe('sonnet');
    expect(WORKER_MODEL).toBe('sonnet');
    // `tools` を持たない（省略 = 親の全ツールを継承。runner.ts のコメント）。
    expect(Object.hasOwn(worker, 'tools')).toBe(false);

    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    // マネージャーには繋ぐ（クローンとは逆）。
    expect(typeof options.canUseTool).toBe('function');
    expect(options.hooks?.PostToolUse).toHaveLength(1);
    expect(options.hooks?.PreCompact).toHaveLength(1);
    // `UserPromptSubmit` は観測専用（`worker_wait`。#129 で入った）。**ここで
    // 固定するのは、これが「渡さなくても動く」種類のフックだからである** —
    // 落ちても機能は壊れず、消えるのは観測だけなので、気づく契機がここにしか
    // 無い（PRD「可観測性」）。
    expect(options.hooks?.UserPromptSubmit).toHaveLength(1);
    // `SubagentStop` も同じ理由の観測専用フック（#357。`runner.ts` の
    // `#onSubagentStop` の doc）。渡した callback がそのまま `Options` へ
    // 載っていること自体が「provider を足す側が黙って落とせない」の保証である。
    expect(options.hooks?.SubagentStop).toHaveLength(1);
    expect(typeof options.hooks?.SubagentStop?.[0]?.hooks?.[0]).toBe('function');
    expect(options.sessionStore).toBeDefined();
    // childUser を渡していないので spawnClaudeCodeProcess は渡らない。
    expect(options.spawnClaudeCodeProcess).toBeUndefined();

    // --- ⭐ 「無いこと」の固定 ---
    expect(options.tools).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();

    // auto-memory は既定で塞ぐ（#1189）。`autoMemoryDirectory` と違い
    // 「Ignored if set in projectSettings」が付いていない `autoMemoryEnabled` を
    // 「flag settings」層（`sdk.d.ts` の `Options.settings`）へ渡す。
    expect(options.settings).toEqual({ autoMemoryEnabled: false });
  });

  it('ALTEROID_MANAGER_AUTO_MEMORY=true を置くと settings を渡さない（SDK の既定へ委ねる。#1189）', async () => {
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: { [MANAGER_AUTO_MEMORY_ENV_KEY]: 'true' },
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    // 塞ぐキー自体を省く（`autoMemoryEnabled: true` を明示するのではない —
    // SDK が既定で開くのに委ねる。claude-provider.ts のコメントに理由がある）。
    expect(options.settings).toBeUndefined();
  });

  it('ALTEROID_MANAGER_AUTO_MEMORY に true/false 以外を置くと落ちる（不正な値を黙って既定へ倒さない）', async () => {
    const { fn } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: { [MANAGER_AUTO_MEMORY_ENV_KEY]: 'yes' },
    });

    await expect(host.start({ managerId: 'mgr-1', request: '走る', cwd: dir })).rejects.toThrow(
      MANAGER_AUTO_MEMORY_ENV_KEY,
    );
  });

  it('systemPrompt.append と agents[WORKER_AGENT_NAME].prompt は、ビルダー関数の戻り値そのものである（#357 の残り1点）', async () => {
    // `prompt.test.ts` の「バックグラウンドの完了を待つときの事実の告知（#357）」は
    // `buildManagerSystemPrompt()` / `buildWorkerPrompt()` の戻り値までしか見ていない
    // ——「その戻り値が SDK へ渡る Options に実際に載るか」という継ぎ目は誰も見ていな
    // かった。ここではその継ぎ目だけを固定する。文言そのものは持たない（コピーすると
    // 片方だけ直したときに腐る）— ビルダーを直接呼んで突き合わせる。
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: {},
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    // runner.ts の #buildOptions が渡す引数と同じ形で呼ぶ（managerId は
    // host.start() に渡した値、workerName は WORKER_AGENT_NAME）。
    const expectedManagerAppend = buildManagerSystemPrompt({
      managerId: 'mgr-1',
      workerName: WORKER_AGENT_NAME,
    });
    expect((options.systemPrompt as { append?: unknown }).append).toBe(expectedManagerAppend);

    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as { prompt?: unknown };
    expect(worker.prompt).toBe(buildWorkerPrompt());
  });

  it('ALTEROID_MANAGER_MODEL / ALTEROID_WORKER_MODEL を置くと差し替わる', async () => {
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: {
        [MANAGER_MODEL_ENV_KEY]: 'sonnet',
        [WORKER_MODEL_ENV_KEY]: 'opus',
      },
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    expect(options.model).toBe('sonnet');
    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as { model?: unknown };
    expect(worker.model).toBe('opus');
  });

  it('childUser を渡すと spawnClaudeCodeProcess が関数として渡る', async () => {
    const { fn, started } = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: fn,
      env: {},
      // uid/gid は実際に spawn するわけではないので実在の値である必要はない
      // （spawnClaudeCodeProcess 自体を呼び出さない。渡る「形」だけを見る）。
      childUser: { uid: 12345, gid: 12345 },
    });

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// C. クローンの蒸留サイドクエリ
// ---------------------------------------------------------------------------

describe('クローンの蒸留サイドクエリへ渡す Options', () => {
  /**
   * `clone-precompact-and-distill-tail.test.ts`（旧 `clone.test.ts`。#1744 で
   * 分割済み）の `firePreCompact` と同じ形。`PreCompact` フックを直接
   * 叩いて `#distillFromTranscript`（別の短命セッション）を実際に走らせる。
   * これが `queryFn` を2回目に呼ぶ呼び出しになり、`calls[1]` に蒸留側の
   * `options` が積まれる。
   */
  async function firePreCompact(main: { options: Options }): Promise<void> {
    const dir = await makeTempDir('alteroid-agent-session-options-distill-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  it('persistSession: false、PostToolUse はあるが PreCompact は無い', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const clone = createClone({ stores, queryFn: fn, env: {}, redeliveryGate: ALWAYS_REDELIVER });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    await firePreCompact(calls[0] as { options: Options });
    await expect.poll(() => calls.length > 1, { timeout: 3000 }).toBe(true);

    const { options } = calls[1] as { options: Options };

    // 走行中のセッションは compaction 中なので、蒸留は別の短命セッションで行う
    // （clone.ts の `#distillFromTranscript` のコメント）。永続化しない。
    expect(options.persistSession).toBe(false);
    // 監査は必要（道具と許可モードを本セッションと揃えた以上、記録も要る）。
    expect(options.hooks?.PostToolUse).toHaveLength(1);
    // 失敗・中断した道具呼び出しも同じ理由で要る（Issue #924）— 蒸留は
    // memory_write を叩く経路なので、そこの失敗が消えると「記憶が書かれ
    // なかった」が静かに落ちる。
    expect(options.hooks?.PostToolUseFailure).toHaveLength(1);
    // PreCompact フックは無い（これは既に PreCompact の中で走っている別セッション
    // なので、自分自身をもう一段 compaction する入口を持たせない）。
    expect(options.hooks?.PreCompact).toBeUndefined();
    // 人間の設定と MCP 連携は本セッションと同じ形で渡す。
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    // `buildCloneDistillOptions` も `managerAutoMemoryEnabled` を受け取らない
    // ので `settings` は載らない（#1189。上の本セッション側と同じ理由）。
    expect(options.settings).toBeUndefined();

    await clone.stop();
  });
});

// ---------------------------------------------------------------------------
// 人間の MCP 連携の登録（#325 段2）
// ---------------------------------------------------------------------------

/**
 * 記憶ストアに置いた登録（`McpServerStore`）が、クローンの本セッションと蒸留の
 * `mcpServers` に自作のインプロセス MCP と並んで渡ること。
 *
 * **自作が必ず勝つ**ことも固定する —— 入口（`parseMcpServers`）は同じ名前を
 * 拒むが、合成の側でも守りを持つ（`cloneMcpServers` の doc）。
 */
describe('人間の MCP 連携の登録をクローンへ渡す（#325 段2）', () => {
  async function firePreCompact(main: { options: Options }): Promise<void> {
    const dir = await makeTempDir('alteroid-agent-session-options-mcp-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  it('本セッションと蒸留の両方に、自作と並べて渡る（蒸留は起こすたびに読み直す）', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    await stores.mcpServers.write({
      github: { command: 'gh-mcp', env: { TOKEN: 'dummy' } },
    });
    const clone = createClone({ stores, queryFn: fn, env: {}, redeliveryGate: ALWAYS_REDELIVER });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const main = calls[0] as { options: Options };
    expect(Object.keys(main.options.mcpServers ?? {}).sort()).toEqual(
      ['github', MCP_SERVER_NAME].sort(),
    );
    expect(main.options.mcpServers?.github).toEqual({ command: 'gh-mcp', env: { TOKEN: 'dummy' } });
    // 自作はインプロセス（`sdk`）のまま。
    expect(main.options.mcpServers?.[MCP_SERVER_NAME]?.type).toBe('sdk');

    // 走行中に差し替えた登録は、次に起こす蒸留から効く（本セッションには届かない —
    // SDK は `mcpServers` を `query()` の起動時に1度だけ受け取る）。
    await stores.mcpServers.write({
      github: { command: 'gh-mcp', env: { TOKEN: 'dummy' } },
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    });
    await firePreCompact(main);
    await expect.poll(() => calls.length > 1, { timeout: 3000 }).toBe(true);
    const distill = calls[1] as { options: Options };
    expect(Object.keys(distill.options.mcpServers ?? {}).sort()).toEqual(
      ['github', MCP_SERVER_NAME, 'remote'].sort(),
    );
    expect(distill.options.mcpServers?.[MCP_SERVER_NAME]?.type).toBe('sdk');

    await clone.stop();
  });

  it('自作と同じ名前の登録が器に紛れ込んでも、自作が勝つ', async () => {
    const own = { type: 'sdk', name: MCP_SERVER_NAME, instance: {} } as never;
    const merged = cloneMcpServers(own, {
      [MCP_SERVER_NAME]: { command: 'impostor' },
      other: { command: 'x' },
    });
    expect(merged[MCP_SERVER_NAME]).toBe(own);
    expect(Object.keys(merged).sort()).toEqual([MCP_SERVER_NAME, 'other'].sort());
    expect(cloneMcpServers(own, undefined)).toEqual({ [MCP_SERVER_NAME]: own });
  });

  /**
   * 壊れた登録1つでクローンが丸ごと起きなくなる形にしない。**そして黙って空で
   * 起きない** —— 日誌に「読めなかった」を残す（`#externalMcpServers` の doc）。
   */
  it('登録が読めなくてもセッションは起き、そのことを日誌に残す', async () => {
    const { fn, calls } = fakeCloneSdk();
    const base = createMemoryStores();
    const stores = {
      ...base,
      mcpServers: {
        read: async () => {
          throw new Error('MCP サーバの登録の形が不正: alteroid: 使えない');
        },
        write: base.mcpServers.write.bind(base.mcpServers),
      },
    };
    const clone = createClone({ stores, queryFn: fn, env: {}, redeliveryGate: ALWAYS_REDELIVER });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const { options } = calls[0] as { options: Options };
    expect(Object.keys(options.mcpServers ?? {})).toEqual([MCP_SERVER_NAME]);
    const entries = await base.journal.list({ types: ['exchange'] });
    expect(
      entries.some(
        (entry) =>
          entry.type === 'exchange' && entry.text.includes('MCP サーバの登録が読めなかった'),
      ),
    ).toBe(true);

    await clone.stop();
  });
});

// ---------------------------------------------------------------------------
// 人間の MCP 連携の登録（#325 段3。マネージャー・作業者）
// ---------------------------------------------------------------------------

/**
 * デーモンが runner へ降ろした登録（`Host#setMcpServers`）が、マネージャーの
 * `Options.mcpServers` に載ること。作業者（`agents`）には書かないこと。
 *
 * **効く時機も固定する** —— 走っているセッションには届かず、次に開くセッション
 * から効く（SDK の `mcpServers` は `query()` の起動時に1度だけ渡る）。
 */
describe('人間の MCP 連携の登録をマネージャーへ渡す（#325 段3）', () => {
  let dir: string;
  let host: RunnerHost | undefined;

  beforeEach(() => {
    dir = makeTempDirSync('alteroid-agent-session-options-mcp3-');
  });

  afterEach(async () => {
    await host?.shutdown().catch(() => undefined);
  });

  const REGISTRATION = {
    github: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'dummy' } },
    remote: { type: 'http' as const, url: 'https://example.invalid/mcp' },
  };

  function makeHost() {
    const sdk = fakeRunnerSdk();
    host = createRunnerHost({
      runnerId: 'runner-primary',
      workspacePath: dir,
      emit: () => undefined,
      queryFn: sdk.fn,
      env: {},
    });
    return { host, started: sdk.started };
  }

  it('置いた登録がマネージャーの mcpServers に載り、作業者の定義には書かない', async () => {
    const { host, started } = makeHost();
    const placed = host.setMcpServers(REGISTRATION);
    expect(placed?.names).toEqual(['github', 'remote']);

    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    const { options } = started[0] as Started;

    expect(options.mcpServers).toEqual(REGISTRATION);
    const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as Record<string, unknown>;
    // **作業者は親の接続を継承する**（`claude-provider.ts` の `agents` の doc）。
    expect(Object.hasOwn(worker, 'mcpServers')).toBe(false);
    expect(Object.hasOwn(worker, 'tools')).toBe(false);
    // `.mcp.json` を読む経路（settingSources）は消していない。
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
  });

  it('置いていなければ mcpServers の欄そのものが無い（段3 以前の Options と同じ）', async () => {
    const { host, started } = makeHost();
    await host.start({ managerId: 'mgr-1', request: '走る', cwd: dir });
    expect(Object.hasOwn((started[0] as Started).options, 'mcpServers')).toBe(false);

    // 空の登録（外した）も同じ。
    host.setMcpServers(REGISTRATION);
    host.setMcpServers({});
    expect(host.mcpServers()).toBeUndefined();
    await host.start({ managerId: 'mgr-2', request: '走る', cwd: dir });
    expect(Object.hasOwn((started[1] as Started).options, 'mcpServers')).toBe(false);
  });

  it('走っているセッションには届かず、次に開くセッションから効く', async () => {
    const { host, started } = makeHost();
    await host.start({ managerId: 'mgr-1', request: '先に走る', cwd: dir });

    host.setMcpServers(REGISTRATION);
    await host.start({ managerId: 'mgr-2', request: '後から走る', cwd: dir });

    expect(Object.hasOwn((started[0] as Started).options, 'mcpServers')).toBe(false);
    expect((started[1] as Started).options.mcpServers).toEqual(REGISTRATION);
  });

  it('形が不正なら投げ、前の登録が残る（文言に値を載せない）', () => {
    const { host } = makeHost();
    const before = host.setMcpServers(REGISTRATION);

    let message = '';
    try {
      host.setMcpServers({ bad: { command: 'x', enviroment: { K: 'SECRET-TYPO' } } });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('MCP サーバの登録の形が不正');
    expect(message).not.toContain('SECRET');
    expect(host.mcpServers()).toEqual(before);

    // alteroid 自身の名前も runner の入口で拒む（デーモンの器と同じ検査を通す）。
    expect(() => host.setMcpServers({ [MCP_SERVER_NAME]: { command: 'x' } })).toThrow();
  });

  it('指紋はキーの順序に依らない（pg の jsonb が並べ替えても「届いていない」に見えない）', () => {
    const { host } = makeHost();
    const a = host.setMcpServers({
      github: { command: 'gh-mcp', env: { B: '2', A: '1' } },
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    });
    const b = host.setMcpServers({
      remote: { url: 'https://example.invalid/mcp', type: 'http' },
      github: { env: { A: '1', B: '2' }, command: 'gh-mcp' },
    });
    expect(a?.sha256).toBe(b?.sha256);
    // 値が変われば指紋も変わる（同じに潰していない）。
    const c = host.setMcpServers({
      github: { command: 'gh-mcp', env: { A: '1', B: '3' } },
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    });
    expect(c?.sha256).not.toBe(a?.sha256);
    // 指紋に値は載っていない。
    expect(JSON.stringify(c)).not.toContain('gh-mcp');
  });
});

// ---------------------------------------------------------------------------
// 記憶ストアの plugin をクローンへ渡す
// ---------------------------------------------------------------------------

describe('記憶ストアの plugin をクローンへ渡す', () => {
  const SHA = 'a'.repeat(40);
  const encoder = new TextEncoder();
  const MANIFEST = JSON.stringify({ name: 'demo', version: '1.0.0', description: 'dummy-content' });

  function pluginInput(name: string, extra: Record<string, unknown> = {}, withHooks = false) {
    return {
      name,
      source: { kind: 'url' as const, url: 'https://example.invalid/repo', sha: SHA },
      files: [
        {
          path: '.claude-plugin/plugin.json',
          executable: false,
          content: encoder.encode(MANIFEST),
        },
        {
          path: 'skills/one/SKILL.md',
          executable: false,
          content: encoder.encode('---\nname: one\ndescription: dummy-content\n---\n# body\n'),
        },
        ...(withHooks
          ? [{ path: 'hooks/hooks.json', executable: false, content: encoder.encode('{}') }]
          : []),
      ],
      installedAt: '2026-10-07T00:00:00.000Z',
      installedBy: 'account-1',
      ...extra,
    };
  }

  async function firePreCompact(main: { options: Options }, root: string): Promise<void> {
    const transcriptPath = join(root, 'transcript.jsonl');
    await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
    const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);
  }

  async function exchangeTexts(stores: ReturnType<typeof createMemoryStores>): Promise<string[]> {
    const entries = await stores.journal.list({ types: ['exchange'] });
    return entries.flatMap((entry) => (entry.type === 'exchange' ? [entry.text] : []));
  }

  it('本セッションと蒸留の options.plugins に展開先と skipMcpDiscovery が載り、scope runner は載らない', async () => {
    const root = await makeTempDir('alteroid-agent-session-options-plugins-');
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    await stores.plugins.put(pluginInput('all-one'));
    await stores.plugins.put(pluginInput('app-one', { scope: 'app', enableMcp: true }));
    await stores.plugins.put(pluginInput('runner-one', { scope: 'runner' }));
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const main = calls[0] as { options: Options };
    expect(main.options.plugins).toEqual([
      { type: 'local', path: join(root, 'plugins', `all-one@${SHA}`), skipMcpDiscovery: true },
      { type: 'local', path: join(root, 'plugins', `app-one@${SHA}`), skipMcpDiscovery: false },
    ]);
    expect(JSON.stringify(main.options.plugins)).not.toContain('runner-one');

    await firePreCompact(main, root);
    await expect.poll(() => calls.length > 1, { timeout: 3000 }).toBe(true);
    const distill = calls[1] as { options: Options };
    expect(distill.options.plugins).toEqual(main.options.plugins);

    await clone.stop();
  });

  it('plugin が無ければ options.plugins の欄ごと無い', async () => {
    const root = await makeTempDir('alteroid-agent-session-options-plugins-none-');
    const { fn, calls } = fakeCloneSdk();
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });
    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);
    expect('plugins' in (calls[0] as { options: Options }).options).toBe(false);
    await clone.stop();
  });

  it('ストアが読めなくてもセッションは起き、段だけを日誌に残す（内容は書かない）', async () => {
    const root = await makeTempDir('alteroid-agent-session-options-plugins-fail-');
    const { fn, calls } = fakeCloneSdk();
    const base = createMemoryStores();
    const stores = {
      ...base,
      plugins: {
        ...base.plugins,
        list: async () => {
          throw new Error('dummy-reason');
        },
      },
    };
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    expect('plugins' in (calls[0] as { options: Options }).options).toBe(false);
    const texts = await exchangeTexts(base);
    expect(texts.some((text) => text.includes('plugin') && text.includes('list'))).toBe(true);

    await clone.stop();
  });

  it('展開しなかったものを plugin 名・相対 path・理由だけで日誌に残す', async () => {
    const root = await makeTempDir('alteroid-agent-session-options-plugins-removed-');
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    await stores.plugins.put(pluginInput('with-hooks', {}, true));
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const texts = await exchangeTexts(stores);
    const line = texts.find((text) => text.includes('hooks/hooks.json'));
    expect(line).toBeDefined();
    expect(line).toContain(`with-hooks@${SHA}`);
    expect(line).not.toContain(root);
    expect(line).not.toContain('example.invalid');

    await clone.stop();
  });

  it('同じ一覧は毎セッション書かず、変わったときだけ書く', async () => {
    const root = await makeTempDir('alteroid-agent-session-options-plugins-digest-');
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    await stores.plugins.put(pluginInput('with-hooks', {}, true));
    const clone = createClone({
      stores,
      queryFn: fn,
      env: {},
      cwd: root,
      redeliveryGate: ALWAYS_REDELIVER,
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);
    await firePreCompact(calls[0] as { options: Options }, root);
    await expect.poll(() => calls.length > 1, { timeout: 3000 }).toBe(true);

    const count = async () =>
      (await exchangeTexts(stores)).filter((text) => text.includes('hooks/hooks.json')).length;
    expect(await count()).toBe(1);

    await stores.plugins.put(pluginInput('another'));
    await firePreCompact(calls[0] as { options: Options }, root);
    await expect.poll(() => calls.length > 2, { timeout: 3000 }).toBe(true);
    expect((await exchangeTexts(stores)).filter((text) => text.includes('another@')).length).toBe(1);

    await clone.stop();
  });
});

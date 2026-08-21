import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLONE_MODEL_ENV_KEY, createClone } from './clone.js';
import { DEFAULT_PERMISSION_MODE } from './permission-mode.js';
import {
  MANAGER_MODEL,
  MANAGER_MODEL_ENV_KEY,
  WORKER_AGENT_NAME,
  WORKER_MODEL,
  WORKER_MODEL_ENV_KEY,
  createRunnerHost,
  type RunnerHost,
} from './runner.js';
import { CLONE_ALLOWED_TOOLS, MCP_SERVER_NAME } from './tools.js';
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
  it('既定のモデル帯・道具の配置・許可モードを固定する', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const clone = createClone({ stores, queryFn: fn, env: {} });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    const { options } = calls[0] as { options: Options };

    // 既定はクローン = Fable。降ろせるのは人間の承認だけである（AGENTS.md 地雷5）。
    expect(options.model).toBe('fable');
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

    await clone.stop();
  });

  it('ALTEROID_CLONE_MODEL を置くとモデル帯が差し替わる', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const clone = createClone({
      stores,
      queryFn: fn,
      env: { [CLONE_MODEL_ENV_KEY]: 'opus' },
    });

    clone.post(humanMessage('やあ'));
    await expect.poll(() => calls.length > 0, { timeout: 3000 }).toBe(true);

    expect((calls[0] as { options: Options }).options.model).toBe('opus');

    await clone.stop();
  });
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
    dir = mkdtempSync(join(tmpdir(), 'alteroid-agent-session-options-'));
  });

  afterEach(async () => {
    await host?.shutdown().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
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
    expect(options.sessionStore).toBeDefined();
    // childUser を渡していないので spawnClaudeCodeProcess は渡らない。
    expect(options.spawnClaudeCodeProcess).toBeUndefined();

    // --- ⭐ 「無いこと」の固定 ---
    expect(options.tools).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();
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
   * `clone.test.ts` の `firePreCompact` と同じ形。`PreCompact` フックを直接
   * 叩いて `#distillFromTranscript`（別の短命セッション）を実際に走らせる。
   * これが `queryFn` を2回目に呼ぶ呼び出しになり、`calls[1]` に蒸留側の
   * `options` が積まれる。
   */
  async function firePreCompact(main: { options: Options }): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'alteroid-agent-session-options-distill-'));
    try {
      const transcriptPath = join(dir, 'transcript.jsonl');
      await writeFile(transcriptPath, '要約に潰される直前の生ログ', 'utf8');
      const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
      if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
      await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
        signal: new AbortController().signal,
      } as never);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('persistSession: false、PostToolUse はあるが PreCompact は無い', async () => {
    const { fn, calls } = fakeCloneSdk();
    const stores = createMemoryStores();
    const clone = createClone({ stores, queryFn: fn, env: {} });

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
    // PreCompact フックは無い（これは既に PreCompact の中で走っている別セッション
    // なので、自分自身をもう一段 compaction する入口を持たせない）。
    expect(options.hooks?.PreCompact).toBeUndefined();
    // 人間の設定と MCP 連携は本セッションと同じ形で渡す。
    expect(options.settingSources).toEqual(['user', 'project', 'local']);

    await clone.stop();
  });
});

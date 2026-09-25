import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  SDKMessage,
  SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import type {
  AgentPreCompactRecord,
  AgentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
  AgentUserPromptSubmitRecord,
} from './agent-hooks.js';
import {
  buildCloneDistillOptions,
  buildCloneSessionOptions,
  buildManagerSessionOptions,
  foldClaudeMessage,
} from './claude-provider.js';
import { DEFAULT_PERMISSION_MODE } from './permission-mode.js';
import { WORKER_AGENT_NAME } from './runner.js';

/**
 * `foldClaudeMessage` —— Claude のメッセージを中立イベントへ写す1本（#486）。
 *
 * ## ここで固定したいこと
 *
 * **「SDK の綴りを読む判断」が全部ここに集まっていること**である。層
 * （`clone.ts` / `runner.ts`）はもうメッセージを読まないので、**読み落としが
 * あればこの1本の中にしか無い。**
 *
 * 特に3つを固定する。
 *
 * 1. **見ないと決めてある種類**（`task_progress` ほか）が0個になること —— 間引き
 *    ではなく判断なので、増減したら気づける形にしておく
 * 2. **無い欄を作り物で埋めないこと** —— provider が名乗らなかったものは
 *    キーごと省き、代用値は層が作る（`agent-events.ts` の doc）
 * 3. **消費は成功した result からしか載らないこと** —— ゼロ埋めが台帳の基準を
 *    下げる（`usage.ts` の `isSuccessResult`）
 *
 * **ここが緑でも層の反応が正しい保証にはならない**（それは `clone.test.ts` /
 * `runner-*.test.ts` の仕事）。
 */

function sdk(fields: Record<string, unknown>): SDKMessage {
  return fields as unknown as SDKMessage;
}

function only(message: SDKMessage): AgentEvent {
  const events = foldClaudeMessage(message);
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe('foldClaudeMessage — system', () => {
  it('init はセッションの開始と実行時の事実になる', () => {
    const event = only(
      sdk({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        model: 'claude-opus-4-1',
        claude_code_version: '2.1.239',
        apiKeySource: 'ANTHROPIC_API_KEY',
        permissionMode: 'acceptEdits',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }],
      }),
    );

    expect(event).toEqual({
      type: 'session_started',
      sessionId: 'sess-1',
      runtime: {
        sessionId: 'sess-1',
        model: 'claude-opus-4-1',
        agentVersion: '2.1.239',
        apiKeySource: 'ANTHROPIC_API_KEY',
        permissionMode: 'acceptEdits',
        mcpServers: [{ name: 'alteroid', status: 'connected' }],
      },
    });
  });

  it('読めない欄は null にする。**`mcp_servers` は `[]` ではなく `null`**（#324）', () => {
    const event = only(sdk({ type: 'system', subtype: 'init', session_id: 'sess-2' }));

    expect(event.type).toBe('session_started');
    expect(event).toMatchObject({
      runtime: {
        model: null,
        agentVersion: null,
        apiKeySource: null,
        permissionMode: null,
        // **「0本と観測した」ではなく「まだ分からない」。**
        mcpServers: null,
      },
    });
  });

  /**
   * `apiKeySource` の許可リスト（#706 の裏側）。
   *
   * `runtimeFactsOf` が読む `SDKSystemMessage.apiKeySource` は SDK 側で9値の
   * union として宣言されているので、`usage-snapshot.ts` の
   * `toAccountApiKeySource`（`apiKeySource` の許可リスト）をそのまま当てられる。
   * ここは **`self_status`（`self.ts` の `describeCloneRuntime`）が読む最初の
   * 入口**なので、ここで畳めば下流（`clone.ts` / `self.ts`）は無改造で済む。
   */
  it('知らない apiKeySource は unrecognized に畳まれ、元の文字は1文字も残らない', () => {
    // 知らない値を通しても、runtime には1文字も現れないことが安全側の歯。**フィクスチャは
    // 鍵に見えない短い文字列にしてある** — 鍵らしい形をリポジトリに増やさないため。
    const secret = 'zz';
    const event = only(
      sdk({ type: 'system', subtype: 'init', session_id: 'sess-4', apiKeySource: secret }),
    );

    expect(event).toMatchObject({ runtime: { apiKeySource: 'unrecognized' } });
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it('知っている9値はそのまま通す（既存の許可リストと同じ集合）', () => {
    const event = only(
      sdk({ type: 'system', subtype: 'init', session_id: 'sess-5', apiKeySource: 'oauth' }),
    );

    expect(event).toMatchObject({ runtime: { apiKeySource: 'oauth' } });
  });

  /**
   * 「欄が無かった」（`null`）と「知らない値だった」（`unrecognized`）は別の観測
   * である。素通しをやめた代償にこの2つを同じ表示へ畳むと、SDK が新しい値を
   * 出し始めたことがこの面から見えなくなる（`accountApiKeySourceSchema` の doc
   * と同じ理由）。
   */
  it('欄が無い（null）と知らない値（unrecognized）は別の表示になる', () => {
    const withoutField = only(sdk({ type: 'system', subtype: 'init', session_id: 'sess-6' }));
    const withUnknown = only(
      sdk({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-7',
        apiKeySource: 'zz',
      }),
    );

    expect(withoutField).toMatchObject({ runtime: { apiKeySource: null } });
    expect(withUnknown).toMatchObject({ runtime: { apiKeySource: 'unrecognized' } });
  });

  it('mcp_servers の中の読めない要素だけを落とす（配列が読めれば 0本 を名乗れる）', () => {
    const event = only(
      sdk({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-3',
        mcp_servers: [{ name: 'alteroid', status: 'connected' }, { name: 42 }, null],
      }),
    );

    expect(event).toMatchObject({
      runtime: { mcpServers: [{ name: 'alteroid', status: 'connected' }] },
    });
  });

  it('permission_denied は走行中の拒否になり、欄はそのまま写される', () => {
    const event = only(
      sdk({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'tu-1',
        tool_input: { command: 'rm -rf /' },
        decision_reason: 'deny 規則',
        decision_reason_type: 'rule',
        message: 'それは実行できない',
        agent_id: 'agent-1',
      }),
    );

    expect(event).toEqual({
      type: 'permission_denied',
      via: 'live',
      denial: {
        tool: 'Bash',
        toolUseId: 'tu-1',
        input: { command: 'rm -rf /' },
        reason: 'deny 規則',
        reasonType: 'rule',
        message: 'それは実行できない',
        agentId: 'agent-1',
      },
    });
  });

  it('無い欄は作り物で埋めずキーごと省く（代用値は層が作る）', () => {
    const event = only(sdk({ type: 'system', subtype: 'permission_denied', tool_use_id: '' }));

    // `tool_use_id: ''` は「取れなかった」と同じ扱いにする（層が代用値を作る）。
    expect(event).toEqual({ type: 'permission_denied', via: 'live', denial: {} });
  });

  it('notification / informational の本文は、上限の文言と分類できたときだけ合図になる', () => {
    const reached = only(
      sdk({
        type: 'system',
        subtype: 'notification',
        text: "You've hit your usage limit · resets at 5pm",
      }),
    );
    expect(reached).toMatchObject({ type: 'usage_notice', notice: { kind: 'reached' } });

    expect(
      foldClaudeMessage(sdk({ type: 'system', subtype: 'notification', text: 'こんにちは' })),
    ).toEqual([]);
    expect(
      foldClaudeMessage(sdk({ type: 'system', subtype: 'informational', content: 42 })),
    ).toEqual([]);
  });

  it('委譲の開閉は数え、id が無ければキーごと省く', () => {
    expect(only(sdk({ type: 'system', subtype: 'task_started', task_id: 't-1' }))).toEqual({
      type: 'delegation_started',
      taskId: 't-1',
    });
    expect(only(sdk({ type: 'system', subtype: 'task_notification', task_id: 't-1' }))).toEqual({
      type: 'delegation_notified',
      taskId: 't-1',
    });
    expect(only(sdk({ type: 'system', subtype: 'task_started' }))).toEqual({
      type: 'delegation_started',
    });
  });

  it('**見ないと決めてある種類は0個になる**（間引きではなく判断である）', () => {
    // **`background_tasks_changed` はここに含めない**（#630 で「見ないと
    // 決めてある」から外れた——読んで `background_tasks` へ畳む。下の
    // `foldClaudeMessage — background_tasks_changed` が別に固定する）。
    for (const subtype of ['task_progress', 'task_updated']) {
      expect(foldClaudeMessage(sdk({ type: 'system', subtype }))).toEqual([]);
    }
    // 知らない subtype も同じく0個（**黙って捨てるのではなく、写す先が無い**）。
    expect(foldClaudeMessage(sdk({ type: 'system', subtype: 'まだ知らない合図' }))).toEqual([]);
  });
});

/**
 * `background_tasks_changed` —— 背景タスクの在り高（level 信号。REPLACE 意味論）。
 *
 * **`task_progress` / `task_updated` の「見ないと決めてある」からは外れたが、
 * 理由（`worker_wait` の区間の開閉には使えない）は変わっていない。** ここで
 * 固定するのは別の問い（「いま起こしっぱなしの背景処理が在るか」）への
 * 読み手であること。
 */
describe('foldClaudeMessage — background_tasks_changed', () => {
  it('非 ambient のタスクだけを畳む（ambient は除く）', () => {
    const event = only(
      sdk({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'bg-1', task_type: 'shell', description: 'pnpm test' },
          { task_id: 'bg-2', task_type: 'skip_transcript', description: '', ambient: true },
        ],
      }),
    );

    expect(event).toEqual({
      type: 'background_tasks',
      tasks: [{ id: 'bg-1', taskType: 'shell' }],
    });
  });

  it('`tasks` が配列でなければ0個を返す（「0本」と名乗らない）', () => {
    expect(foldClaudeMessage(sdk({ type: 'system', subtype: 'background_tasks_changed' }))).toEqual(
      [],
    );
    expect(
      foldClaudeMessage(
        sdk({ type: 'system', subtype: 'background_tasks_changed', tasks: 'not-an-array' }),
      ),
    ).toEqual([]);
  });

  it('`tasks: []`（本当に0本）は、0個ではなく空配列を持つ1件のイベントになる', () => {
    // **「配列が読めた」場合だけが「0本」を名乗れる**（`runtimeFactsOf` と
    // 同じ作法）。配列そのものが無い（上のテスト）場合と区別する。
    const event = only(sdk({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }));
    expect(event).toEqual({ type: 'background_tasks', tasks: [] });
  });

  it('`task_id` が文字列でない要素は落とし、`task_type` が文字列でなければ (不明) を当てる', () => {
    const event = only(
      sdk({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'bg-1' }, // task_type 無し
          { task_id: 42, task_type: 'shell' }, // task_id が文字列でない ⟹ 落とす
          null, // 要素が object でない ⟹ 落とす
        ],
      }),
    );

    expect(event).toEqual({
      type: 'background_tasks',
      tasks: [{ id: 'bg-1', taskType: '(不明)' }],
    });
  });
});

describe('foldClaudeMessage — rate_limit_event / stream_event / user', () => {
  it('枠の事実は読めたときだけ載る', () => {
    const event = only(
      sdk({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
      }),
    );
    expect(event).toMatchObject({ type: 'rate_limit', facts: { status: 'allowed' } });

    expect(foldClaudeMessage(sdk({ type: 'rate_limit_event', rate_limit_info: null }))).toEqual([]);
  });

  it('逐次配信は text の delta だけを写す', () => {
    expect(
      only(
        sdk({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'あ' } },
        }),
      ),
    ).toEqual({ type: 'text_delta', text: 'あ' });

    expect(
      foldClaudeMessage(
        sdk({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'む' } },
        }),
      ),
    ).toEqual([]);
  });

  it('道具の結果が返った user メッセージだけを写す（人間の発言のエコーは写さない）', () => {
    expect(
      only(sdk({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })),
    ).toEqual({ type: 'tool_result' });

    expect(
      foldClaudeMessage(
        sdk({ type: 'user', message: { content: [{ type: 'text', text: 'やって' }] } }),
      ),
    ).toEqual([]);
  });
});

describe('foldClaudeMessage — assistant', () => {
  it('中身は text / tool_use / other の3種へ畳み、順序と数を保つ', () => {
    const event = only(
      sdk({
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'uuid-1',
        message: {
          content: [
            { type: 'text', text: 'まず' },
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'thinking', thinking: '…' },
            { type: 'text', text: 'つぎ' },
          ],
        },
      }),
    );

    expect(event).toEqual({
      type: 'assistant_message',
      parentToolUseId: null,
      id: 'uuid-1',
      blocks: [
        { type: 'text', text: 'まず' },
        { type: 'tool_use', name: 'Bash' },
        { type: 'other' },
        { type: 'text', text: 'つぎ' },
      ],
    });
  });

  it('作業者（委譲の中）の発言は親の道具 id を保って写す（切るのは層の仕事）', () => {
    expect(
      only(
        sdk({
          type: 'assistant',
          parent_tool_use_id: 'tu-parent',
          message: { content: [{ type: 'text', text: '作業者です' }] },
        }),
      ),
    ).toMatchObject({ parentToolUseId: 'tu-parent' });
  });

  it('**「応答ではない」の印は、空でない文字列のときだけ載る**', () => {
    // ここは `sdk-failure.ts` の `assistantFailureOf` へ渡る唯一の材料である
    // （あちらは印そのものを受け取るので、メッセージのどの欄に載るかを知って
    // いるのはこちらだけになった）。
    expect(
      only(sdk({ type: 'assistant', message: { content: [] }, error: 'billing_error' })),
    ).toMatchObject({ errorCode: 'billing_error' });

    for (const error of ['', '   ', 1, {}, null, undefined]) {
      const event = only(sdk({ type: 'assistant', message: { content: [] }, error }));
      expect(event).not.toHaveProperty('errorCode');
    }
  });
});

describe('foldClaudeMessage — result', () => {
  it('成功した result は消費・id・本文を運ぶ', () => {
    const event = only(
      sdk({
        type: 'result',
        subtype: 'success',
        result: 'できた',
        session_id: 'sess-9',
        uuid: 'uuid-9',
        modelUsage: {
          'claude-opus-4-1': {
            inputTokens: 10,
            outputTokens: 20,
            costUSD: 0.5,
            webSearchRequests: 0,
          },
        },
      }),
    );

    expect(event).toMatchObject({
      type: 'turn_ended',
      succeeded: true,
      body: 'できた',
      errorLines: [],
      id: 'uuid-9',
      denials: [],
      usage: { sessionId: 'sess-9' },
    });
    expect(event).not.toHaveProperty('failure');
    expect(event).not.toHaveProperty('outcome');
  });

  it('**失敗した result の消費は載せない**（ゼロ埋めが台帳の基準を下げる）', () => {
    const event = only(
      sdk({
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'sess-9',
        modelUsage: {
          'claude-opus-4-1': { inputTokens: 0, outputTokens: 0, costUSD: 0, webSearchRequests: 0 },
        },
      }),
    );

    expect(event).toMatchObject({ succeeded: false, outcome: 'error_during_execution' });
    expect(event).not.toHaveProperty('usage');
  });

  it('`subtype: success` でも `is_error` が立っていれば失敗の印が載る（台帳側は成功のまま）', () => {
    const event = only(sdk({ type: 'result', subtype: 'success', is_error: true, result: 'あれ' }));

    expect(event).toMatchObject({
      succeeded: true, // 台帳の問い（`usage.ts` の `isSuccessResult`）
      failure: { via: 'result_is_error' }, // 応答の問い（`sdk-failure.ts`）
      body: 'あれ',
    });
    // 終わり方の語は `success` なので載せない（`（結果なしで終了: …）` を作らない）。
    expect(event).not.toHaveProperty('outcome');
  });

  it('authoritative な拒否の記録を、走行中の合図と同じ形へ写す', () => {
    const event = only(
      sdk({
        type: 'result',
        subtype: 'success',
        result: '',
        permission_denials: [
          { tool_name: 'Write', tool_use_id: 'tu-9', tool_input: { a: 1 } },
          null,
        ],
      }),
    );

    expect(event).toMatchObject({
      // **`result` の記録は理由も層も持たない**（欄そのものが無い）。
      denials: [{ tool: 'Write', toolUseId: 'tu-9', input: { a: 1 } }],
      body: '',
    });
  });

  it('知らない種類のメッセージは0個になる', () => {
    expect(foldClaudeMessage(sdk({ type: 'まだ知らない種類' }))).toEqual([]);
  });

  it('`result.usage`（メインループだけの生の消費）は `mainLoopUsage` として運ぶ。**`modelUsage` とは別物**', () => {
    const event = only(
      sdk({
        type: 'result',
        subtype: 'success',
        result: 'できた',
        session_id: 'sess-9',
        modelUsage: {
          'claude-opus-4-1': {
            inputTokens: 10,
            outputTokens: 20,
            costUSD: 0.5,
            webSearchRequests: 0,
          },
        },
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 40,
        },
      }),
    );

    expect(event).toMatchObject({
      usage: {
        mainLoopUsage: {
          inputTokens: 7,
          outputTokens: 3,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 40,
        },
      },
    });
  });

  it('**失敗した result の `result.usage` も載せない**（`modelUsage` と同じ絞り）', () => {
    const event = only(
      sdk({
        type: 'result',
        subtype: 'error_during_execution',
        modelUsage: {
          'claude-opus-4-1': { inputTokens: 0, outputTokens: 0, costUSD: 0, webSearchRequests: 0 },
        },
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    );

    // `modelUsage` が無い＝ `usage` 欄自体が無い（`mainLoopUsage` も道連れで消える）。
    expect(event).not.toHaveProperty('usage');
  });

  it('`result.usage` の欄が読めない形なら `mainLoopUsage` を作り物で埋めない', () => {
    const event = only(
      sdk({
        type: 'result',
        subtype: 'success',
        result: 'できた',
        modelUsage: {
          'claude-opus-4-1': {
            inputTokens: 10,
            outputTokens: 20,
            costUSD: 0.5,
            webSearchRequests: 0,
          },
        },
        usage: { input_tokens: 7 }, // 他の欄が欠けている
      }),
    );

    expect(event.type === 'turn_ended' && event.usage?.mainLoopUsage).toBeUndefined();
  });
});

describe('foldClaudeMessage — compact_boundary', () => {
  it('compaction は trigger / preTokens / postTokens を運ぶ', () => {
    const event = only(
      sdk({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 42_000 },
      }),
    );

    expect(event).toEqual({
      type: 'compaction',
      trigger: 'auto',
      preTokens: 180_000,
      postTokens: 42_000,
    });
  });

  it('`post_tokens` が省かれた回は欄ごと省く（optional なため）', () => {
    const event = only(
      sdk({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 100 },
      }),
    );

    expect(event).toEqual({ type: 'compaction', trigger: 'manual', preTokens: 100 });
    expect(event).not.toHaveProperty('postTokens');
  });

  it('読めない形（`trigger` が2値のどちらでもない・`pre_tokens` が数値でない）は0個になる。作り物を返さない', () => {
    expect(
      foldClaudeMessage(
        sdk({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'それ以外', pre_tokens: 100 },
        }),
      ),
    ).toEqual([]);
    expect(
      foldClaudeMessage(
        sdk({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: '100' },
        }),
      ),
    ).toEqual([]);
    expect(foldClaudeMessage(sdk({ type: 'system', subtype: 'compact_boundary' }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 書き側 —— ツール監査フックの包み直し（#486「中立の口」）
// ---------------------------------------------------------------------------

/**
 * `wrapToolAuditHook` / `wrapToolAuditFailureHook`（`claude-provider.ts` 内の
 * private 関数）を、`buildCloneSessionOptions` / `buildCloneDistillOptions` /
 * `buildManagerSessionOptions` が組み立てる `Options.hooks` 経由で固定する。
 *
 * ## ここで固定したいこと
 *
 * 1. **SDK の `PostToolUse` / `PostToolUseFailure` の生入力が、同じ値のまま
 *    中立の記録（`AgentToolAuditRecord` / `AgentToolAuditFailureRecord`）として
 *    中立のフックへ届くこと**
 * 2. **SDK へ返す値は常に `{ continue: true }` だけであること**（観測専用
 *    フックなので判断を返す余地が無い）
 * 3. **`ManagerSessionOptionsRequest.onPostToolUse` だけは中立化していない**
 *    こと（`runner.ts` 側の判断つき経路があるため。同欄の doc）——渡した
 *    `HookCallback` がそのまま（包み直されずに）使われることを見る
 */

const mcpServer = { type: 'sdk', name: 'test', instance: {} } as unknown as McpServerConfig;
const sessionStore = {} as unknown as SessionStore;
const canUseTool = (async () => ({ behavior: 'allow', updatedInput: {} })) as unknown as CanUseTool;

/** SDK の `HookCallback` を偽の入力で1回呼ぶ。`toolUseID` / `signal` はここでは意味を持たない。 */
async function invokeHook(
  hook: HookCallback | undefined,
  input: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<unknown> {
  if (hook === undefined) throw new Error('hook が登録されていない');
  return hook(input as never, 'tool-use-id', { signal });
}

describe('ツール監査フックの包み直し（#486）', () => {
  it('buildCloneSessionOptions: PostToolUse の生入力を同じ値のまま中立の記録として渡し、{ continue: true } を返す', async () => {
    let captured: AgentToolAuditRecord | undefined;
    const options = buildCloneSessionOptions({
      model: 'fable',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env: {},
      resume: null,
      onPreCompact: () => {},
      onPostToolUse: (record) => {
        captured = record;
      },
      onPostToolUseFailure: () => {},
      onPreToolUse: async () => ({ continue: true }),
    });

    const result = await invokeHook(options.hooks?.PostToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PostToolUse',
      session_id: 's',
      cwd: '/work',
      transcript_path: '/tmp/t.jsonl',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: { output: 'hi' },
      tool_use_id: 'tu-1',
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
      effort: { level: 'high' },
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({
      toolName: 'Bash',
      toolInput: { command: 'echo hi' },
      toolResponse: { output: 'hi' },
      transcriptPath: '/tmp/t.jsonl',
      effortLevel: 'high',
      agentId: 'agent-1',
      agentType: 'general-purpose',
    } satisfies AgentToolAuditRecord);
  });

  it('buildCloneSessionOptions: 読めない・無い欄は作り物を出さずに省く', async () => {
    let captured: AgentToolAuditRecord | undefined;
    const options = buildCloneSessionOptions({
      model: 'fable',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env: {},
      resume: null,
      onPreCompact: () => {},
      onPostToolUse: (record) => {
        captured = record;
      },
      onPostToolUseFailure: () => {},
      onPreToolUse: async () => ({ continue: true }),
    });

    const result = await invokeHook(options.hooks?.PostToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PostToolUse',
      session_id: 's',
      cwd: '/work',
      transcript_path: '/tmp/t.jsonl',
      tool_name: 'Bash',
      tool_use_id: 'tu-1',
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({ toolName: 'Bash', transcriptPath: '/tmp/t.jsonl' });
    expect(captured).not.toHaveProperty('agentId');
    expect(captured).not.toHaveProperty('effortLevel');
  });

  it('buildCloneSessionOptions: PostToolUseFailure の生入力を同じ値のまま中立の記録として渡し、{ continue: true } を返す', async () => {
    let captured: AgentToolAuditFailureRecord | undefined;
    const options = buildCloneSessionOptions({
      model: 'fable',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env: {},
      resume: null,
      onPreCompact: () => {},
      onPostToolUse: () => {},
      onPostToolUseFailure: (record) => {
        captured = record;
      },
      onPreToolUse: async () => ({ continue: true }),
    });

    const result = await invokeHook(options.hooks?.PostToolUseFailure?.[0]?.hooks[0], {
      hook_event_name: 'PostToolUseFailure',
      session_id: 's',
      cwd: '/work',
      transcript_path: '/tmp/t.jsonl',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 999' },
      tool_use_id: 'tu-2',
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
      effort: { level: 'low' },
      error: '中断された',
      is_interrupt: true,
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({
      toolName: 'Bash',
      toolInput: { command: 'sleep 999' },
      transcriptPath: '/tmp/t.jsonl',
      effortLevel: 'low',
      agentId: 'agent-1',
      agentType: 'general-purpose',
      error: '中断された',
      isInterrupt: true,
    } satisfies AgentToolAuditFailureRecord);
  });

  it('buildCloneDistillOptions: PostToolUse / PostToolUseFailure も同じ中立の記録として渡り、{ continue: true } を返す', async () => {
    let capturedUse: AgentToolAuditRecord | undefined;
    let capturedFailure: AgentToolAuditFailureRecord | undefined;
    const options = buildCloneDistillOptions({
      model: 'fable',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env: {},
      onPostToolUse: (record) => {
        capturedUse = record;
      },
      onPostToolUseFailure: (record) => {
        capturedFailure = record;
      },
    });

    const useResult = await invokeHook(options.hooks?.PostToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PostToolUse',
      session_id: 's',
      cwd: '/work',
      tool_name: 'memory_write',
      tool_input: { text: 'メモ' },
      tool_use_id: 'tu-3',
    });
    const failureResult = await invokeHook(options.hooks?.PostToolUseFailure?.[0]?.hooks[0], {
      hook_event_name: 'PostToolUseFailure',
      session_id: 's',
      cwd: '/work',
      tool_name: 'memory_write',
      tool_use_id: 'tu-4',
      error: '失敗した',
    });

    expect(useResult).toEqual({ continue: true });
    expect(failureResult).toEqual({ continue: true });
    expect(capturedUse).toEqual({ toolName: 'memory_write', toolInput: { text: 'メモ' } });
    expect(capturedFailure).toEqual({ toolName: 'memory_write', error: '失敗した' });
  });

  it('buildManagerSessionOptions: PostToolUseFailure は中立の記録として渡り、{ continue: true } を返す', async () => {
    let captured: AgentToolAuditFailureRecord | undefined;
    const options = buildManagerSessionOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      systemPromptAppend: '追記',
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: '作業者のプロンプト',
      workerModel: 'sonnet',
      cwd: '/work',
      env: {},
      sessionStore,
      canUseTool,
      onPostToolUse: async () => ({ continue: true }),
      onPostToolUseFailure: (record) => {
        captured = record;
      },
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: async () => ({ continue: true }),
      onStop: () => {},
      onPreToolUse: async () => ({ continue: true }),
      managerAutoMemoryEnabled: false,
    });

    const result = await invokeHook(options.hooks?.PostToolUseFailure?.[0]?.hooks[0], {
      hook_event_name: 'PostToolUseFailure',
      session_id: 's',
      cwd: '/work',
      tool_name: 'Bash',
      tool_use_id: 'tu-5',
      agent_id: 'agent-2',
      agent_type: 'general-purpose',
      error: '失敗した',
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({
      toolName: 'Bash',
      agentId: 'agent-2',
      agentType: 'general-purpose',
      error: '失敗した',
    });
  });

  it('buildManagerSessionOptions: onPostToolUse は中立化していない —— 渡した HookCallback がそのまま（包み直さずに）使われる', () => {
    const raw: HookCallback = async () => ({ continue: true });
    const options = buildManagerSessionOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      systemPromptAppend: '追記',
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: '作業者のプロンプト',
      workerModel: 'sonnet',
      cwd: '/work',
      env: {},
      sessionStore,
      canUseTool,
      onPostToolUse: raw,
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: async () => ({ continue: true }),
      onStop: () => {},
      onPreToolUse: async () => ({ continue: true }),
      managerAutoMemoryEnabled: false,
    });

    expect(options.hooks?.PostToolUse?.[0]?.hooks[0]).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// 書き側 —— 観測専用フックの包み直し（#486「中立の口」2本目）
// ---------------------------------------------------------------------------

/**
 * `wrapPreCompactHook` / `wrapUserPromptSubmitHook` / `wrapStopHook`
 * （`claude-provider.ts` 内の private 関数）を、`buildCloneSessionOptions` /
 * `buildManagerSessionOptions` が組み立てる `Options.hooks` 経由で固定する。
 *
 * ## ここで固定したいこと
 *
 * 1. **SDK の `PreCompact` / `UserPromptSubmit` / `Stop` の生入力が、同じ値の
 *    まま中立の記録（`AgentPreCompactRecord` / `AgentUserPromptSubmitRecord` /
 *    `AgentStopRecord`）として中立のフックへ届くこと**
 * 2. **SDK へ返す値は常に `{ continue: true }` だけであること**（観測専用
 *    フックなので判断を返す余地が無い）
 * 3. **`PreCompact` は `await` を保ったまま包み直すこと** —— 中立フックの
 *    `Promise` を待ってから `{ continue: true }` を返す（compaction を待たせる
 *    順序を変えない）
 * 4. **`ManagerSessionOptionsRequest.onSubagentStop` だけは中立化していない**
 *    こと（`runner.ts` 側の起こし直し＝判断つき経路があるため）——渡した
 *    `HookCallback` がそのまま（包み直されずに）使われることを見る
 */
describe('観測専用フックの包み直し（#486 中立の口2本目）', () => {
  it('buildCloneSessionOptions: PreCompact の生入力を同じ値のまま中立の記録として渡し、{ continue: true } を返す', async () => {
    let captured: AgentPreCompactRecord | undefined;
    const options = buildCloneSessionOptions({
      model: 'fable',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env: {},
      resume: null,
      onPreCompact: (record) => {
        captured = record;
      },
      onPostToolUse: () => {},
      onPostToolUseFailure: () => {},
      onPreToolUse: async () => ({ continue: true }),
    });

    const signal = new AbortController().signal;
    const result = await invokeHook(
      options.hooks?.PreCompact?.[0]?.hooks[0],
      {
        hook_event_name: 'PreCompact',
        session_id: 'session-1',
        cwd: '/work',
        transcript_path: '/tmp/t.jsonl',
        trigger: 'auto',
        custom_instructions: null,
      },
      signal,
    );

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({
      transcriptPath: '/tmp/t.jsonl',
      sessionId: 'session-1',
      signal,
    } satisfies AgentPreCompactRecord);
  });

  it('buildCloneSessionOptions: PreCompact の読めない・無い欄は作り物を出さずに省く（`signal` は常に渡る）', async () => {
    let captured: AgentPreCompactRecord | undefined;
    const options = buildCloneSessionOptions({
      model: 'fable',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env: {},
      resume: null,
      onPreCompact: (record) => {
        captured = record;
      },
      onPostToolUse: () => {},
      onPostToolUseFailure: () => {},
      onPreToolUse: async () => ({ continue: true }),
    });

    const signal = new AbortController().signal;
    const result = await invokeHook(
      options.hooks?.PreCompact?.[0]?.hooks[0],
      { hook_event_name: 'PreCompact', cwd: '/work', trigger: 'manual', custom_instructions: null },
      signal,
    );

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({ signal });
    expect(captured).not.toHaveProperty('transcriptPath');
    expect(captured).not.toHaveProperty('sessionId');
  });

  it('buildManagerSessionOptions: PreCompact も同じ中立の記録として渡り、{ continue: true } を返す', async () => {
    let captured: AgentPreCompactRecord | undefined;
    const options = buildManagerSessionOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      systemPromptAppend: '追記',
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: '作業者のプロンプト',
      workerModel: 'sonnet',
      cwd: '/work',
      env: {},
      sessionStore,
      canUseTool,
      onPostToolUse: async () => ({ continue: true }),
      onPostToolUseFailure: () => {},
      onPreCompact: (record) => {
        captured = record;
      },
      onUserPromptSubmit: () => {},
      onSubagentStop: async () => ({ continue: true }),
      onStop: () => {},
      onPreToolUse: async () => ({ continue: true }),
      managerAutoMemoryEnabled: false,
    });

    const result = await invokeHook(options.hooks?.PreCompact?.[0]?.hooks[0], {
      hook_event_name: 'PreCompact',
      session_id: 'session-2',
      cwd: '/work',
      transcript_path: '/tmp/manager.jsonl',
      trigger: 'auto',
      custom_instructions: null,
    });

    expect(result).toEqual({ continue: true });
    expect(captured?.transcriptPath).toBe('/tmp/manager.jsonl');
  });

  it('buildManagerSessionOptions: UserPromptSubmit の生入力を同じ値のまま中立の記録として渡し、{ continue: true } を返す', async () => {
    let captured: AgentUserPromptSubmitRecord | undefined;
    const options = buildManagerSessionOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      systemPromptAppend: '追記',
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: '作業者のプロンプト',
      workerModel: 'sonnet',
      cwd: '/work',
      env: {},
      sessionStore,
      canUseTool,
      onPostToolUse: async () => ({ continue: true }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: (record) => {
        captured = record;
      },
      onSubagentStop: async () => ({ continue: true }),
      onStop: () => {},
      onPreToolUse: async () => ({ continue: true }),
      managerAutoMemoryEnabled: false,
    });

    const result = await invokeHook(options.hooks?.UserPromptSubmit?.[0]?.hooks[0], {
      hook_event_name: 'UserPromptSubmit',
      session_id: 's',
      cwd: '/work',
      prompt: 'こんにちは',
      agent_id: 'agent-3',
      source: 'system',
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({
      agentId: 'agent-3',
      source: 'system',
    } satisfies AgentUserPromptSubmitRecord);
  });

  it('buildManagerSessionOptions: UserPromptSubmit の読めない・無い欄は作り物を出さずに省く', async () => {
    let captured: AgentUserPromptSubmitRecord | undefined;
    const options = buildManagerSessionOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      systemPromptAppend: '追記',
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: '作業者のプロンプト',
      workerModel: 'sonnet',
      cwd: '/work',
      env: {},
      sessionStore,
      canUseTool,
      onPostToolUse: async () => ({ continue: true }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: (record) => {
        captured = record;
      },
      onSubagentStop: async () => ({ continue: true }),
      onStop: () => {},
      onPreToolUse: async () => ({ continue: true }),
      managerAutoMemoryEnabled: false,
    });

    const result = await invokeHook(options.hooks?.UserPromptSubmit?.[0]?.hooks[0], {
      hook_event_name: 'UserPromptSubmit',
      session_id: 's',
      cwd: '/work',
      prompt: 'こんにちは',
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({});
    expect(captured).not.toHaveProperty('agentId');
    expect(captured).not.toHaveProperty('source');
  });

  it('buildManagerSessionOptions: Stop の生入力を同じ値のまま中立の記録として渡し、{ continue: true } を返す', async () => {
    let captured: AgentStopRecord | undefined;
    const backgroundTasks = [{ id: 'task-1', type: 'shell', status: 'running', description: 'd' }];
    const sessionCrons = [{ id: 'cron-1', schedule: '0 9 * * 1-5', recurring: true, prompt: 'p' }];
    const options = buildManagerSessionOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      systemPromptAppend: '追記',
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: '作業者のプロンプト',
      workerModel: 'sonnet',
      cwd: '/work',
      env: {},
      sessionStore,
      canUseTool,
      onPostToolUse: async () => ({ continue: true }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: async () => ({ continue: true }),
      onStop: (record) => {
        captured = record;
      },
      onPreToolUse: async () => ({ continue: true }),
      managerAutoMemoryEnabled: false,
    });

    const result = await invokeHook(options.hooks?.Stop?.[0]?.hooks[0], {
      hook_event_name: 'Stop',
      session_id: 's',
      cwd: '/work',
      stop_hook_active: true,
      background_tasks: backgroundTasks,
      session_crons: sessionCrons,
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({
      backgroundTasks,
      sessionCrons,
      stopHookActive: true,
    } satisfies AgentStopRecord);
  });

  it('buildManagerSessionOptions: Stop の読めない・無い欄は作り物を出さずに省く', async () => {
    let captured: AgentStopRecord | undefined;
    const options = buildManagerSessionOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      systemPromptAppend: '追記',
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: '作業者のプロンプト',
      workerModel: 'sonnet',
      cwd: '/work',
      env: {},
      sessionStore,
      canUseTool,
      onPostToolUse: async () => ({ continue: true }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: async () => ({ continue: true }),
      onStop: (record) => {
        captured = record;
      },
      onPreToolUse: async () => ({ continue: true }),
      managerAutoMemoryEnabled: false,
    });

    const result = await invokeHook(options.hooks?.Stop?.[0]?.hooks[0], {
      hook_event_name: 'Stop',
      session_id: 's',
      cwd: '/work',
      // 真偽値でない値は読めない欄として扱う（包み直す前の `runner.ts` の `#onStop` と同じ）
      stop_hook_active: 'yes',
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({});
    expect(captured).not.toHaveProperty('backgroundTasks');
    expect(captured).not.toHaveProperty('sessionCrons');
    expect(captured).not.toHaveProperty('stopHookActive');
  });

  it('buildManagerSessionOptions: onSubagentStop は中立化していない —— 渡した HookCallback がそのまま（包み直さずに）使われる', () => {
    const raw: HookCallback = async () => ({ continue: true });
    const options = buildManagerSessionOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      systemPromptAppend: '追記',
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: '作業者のプロンプト',
      workerModel: 'sonnet',
      cwd: '/work',
      env: {},
      sessionStore,
      canUseTool,
      onPostToolUse: async () => ({ continue: true }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: raw,
      onStop: () => {},
      onPreToolUse: async () => ({ continue: true }),
      managerAutoMemoryEnabled: false,
    });

    expect(options.hooks?.SubagentStop?.[0]?.hooks[0]).toBe(raw);
  });
});

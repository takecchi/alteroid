import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-events.js';
import { foldClaudeMessage } from './claude-provider.js';

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

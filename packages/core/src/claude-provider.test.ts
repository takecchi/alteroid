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
  AgentContextHook,
  AgentContextOutcome,
  AgentPreCompactRecord,
  AgentPreToolDecision,
  AgentPreToolRecord,
  AgentStopRecord,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
  AgentUserPromptSubmitRecord,
} from './agent-hooks.js';
import {
  buildCloneDistillOptions,
  buildCloneSessionOptions,
  buildManagerSessionOptions,
  foldClaudeMessage,
  SUBAGENT_STOP_HOOK_TIMEOUT_SECONDS,
  withNoModelFallbackEnv,
} from './claude-provider.js';
import { DEFAULT_PERMISSION_MODE } from './permission-mode.js';
import { SUBAGENT_BACKGROUND_WAIT_MS } from './runner-subagent-stop-state.js';
import { WORKER_AGENT_NAME } from './runner.js';
import { captureStderr } from './testing.js';

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
        mcpServers: null,
      },
    });
  });

  it('知らない apiKeySource は unrecognized に畳まれ、元の文字は1文字も残らない', () => {
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

  it('task_started の task_type / spawn_depth を taskType / spawnDepth として運ぶ。無ければ省く', () => {
    expect(
      only(
        sdk({
          type: 'system',
          subtype: 'task_started',
          task_id: 't-1',
          task_type: 'local_bash',
        }),
      ),
    ).toEqual({ type: 'delegation_started', taskId: 't-1', taskType: 'local_bash' });

    expect(
      only(
        sdk({
          type: 'system',
          subtype: 'task_started',
          task_id: 't-2',
          task_type: 'local_agent',
          spawn_depth: 1,
        }),
      ),
    ).toEqual({
      type: 'delegation_started',
      taskId: 't-2',
      taskType: 'local_agent',
      spawnDepth: 1,
    });

    expect(
      only(
        sdk({
          type: 'system',
          subtype: 'task_started',
          task_id: 't-3',
          task_type: 42,
          spawn_depth: '1',
        }),
      ),
    ).toEqual({ type: 'delegation_started', taskId: 't-3' });

    expect(only(sdk({ type: 'system', subtype: 'task_started', task_id: 't-4' }))).toEqual({
      type: 'delegation_started',
      taskId: 't-4',
    });
  });

  it('task_notification の status / summary を捨てずに運ぶ（Issue #1373 続き）', () => {
    expect(
      only(
        sdk({
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-1',
          status: 'failed',
          summary: '枠(429)で打ち切られた',
        }),
      ),
    ).toEqual({
      type: 'delegation_notified',
      taskId: 't-1',
      status: 'failed',
      summary: '枠(429)で打ち切られた',
    });

    expect(
      only(
        sdk({
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-2',
          status: 'some_future_status',
        }),
      ),
    ).toEqual({ type: 'delegation_notified', taskId: 't-2', status: 'some_future_status' });

    const longSummary = 'あ'.repeat(1000);
    const cut = only(
      sdk({
        type: 'system',
        subtype: 'task_notification',
        task_id: 't-3',
        status: 'failed',
        summary: longSummary,
      }),
    ) as { summary?: string };
    expect(cut.summary).toBeDefined();
    expect(cut.summary!.length).toBeLessThan(longSummary.length);
    expect(cut.summary).toContain('省略');

    expect(only(sdk({ type: 'system', subtype: 'task_notification', task_id: 't-4' }))).toEqual({
      type: 'delegation_notified',
      taskId: 't-4',
    });
  });

  it('task_notification の output_file を outputFile として写す（task_started には無い欄）', () => {
    expect(
      only(
        sdk({
          type: 'system',
          subtype: 'task_notification',
          task_id: 't-1',
          output_file: '/tmp/out.txt',
        }),
      ),
    ).toEqual({
      type: 'delegation_notified',
      taskId: 't-1',
      outputFile: '/tmp/out.txt',
    });

    expect(
      only(sdk({ type: 'system', subtype: 'task_notification', task_id: 't-2', output_file: 42 })),
    ).toEqual({ type: 'delegation_notified', taskId: 't-2' });

    expect(
      only(
        sdk({
          type: 'system',
          subtype: 'task_started',
          task_id: 't-3',
          output_file: '/tmp/should-not-appear.txt',
        }),
      ),
    ).toEqual({ type: 'delegation_started', taskId: 't-3' });
  });

  it('**見ないと決めてある種類は0個になる**（間引きではなく判断である）', () => {
    for (const subtype of ['task_progress', 'task_updated']) {
      expect(foldClaudeMessage(sdk({ type: 'system', subtype }))).toEqual([]);
    }
    expect(foldClaudeMessage(sdk({ type: 'system', subtype: 'まだ知らない合図' }))).toEqual([]);
  });
});

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
    const event = only(sdk({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }));
    expect(event).toEqual({ type: 'background_tasks', tasks: [] });
  });

  it('`task_id` が文字列でない要素は落とし、`task_type` が文字列でなければ (不明) を当てる', () => {
    const event = only(
      sdk({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          // task_type 無し・task_id が文字列でない・要素が object でない
          { task_id: 'bg-1' },
          { task_id: 42, task_type: 'shell' },
          null,
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
      succeeded: true,
      failure: { via: 'result_is_error' },
      body: 'あれ',
    });
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
        usage: { input_tokens: 7 },
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

describe('foldClaudeMessage — 拒否（model_refusal_no_fallback / model_refusal_fallback）', () => {
  it('再試行せずに終わった拒否は fellBack: false の refusal になる。category・explanation・元のモデルを運ぶ', () => {
    expect(
      only(
        sdk({
          type: 'system',
          subtype: 'model_refusal_no_fallback',
          original_model: 'claude-opus-5-5',
          api_refusal_category: 'cyber',
          api_refusal_explanation: 'flagged',
        }),
      ),
    ).toEqual({
      type: 'refusal',
      category: 'cyber',
      explanation: 'flagged',
      originalModel: 'claude-opus-5-5',
      fellBack: false,
    });
  });

  it('降格して再試行した回は fellBack: true', () => {
    expect(
      only(
        sdk({
          type: 'system',
          subtype: 'model_refusal_fallback',
          original_model: 'claude-opus-5-5',
          fallback_model: 'claude-opus-4-8',
          api_refusal_category: 'bio',
        }),
      ),
    ).toEqual({
      type: 'refusal',
      category: 'bio',
      originalModel: 'claude-opus-5-5',
      fellBack: true,
    });
  });

  it('category が null・欠けていれば null のまま運ぶ（作り物の分類を付けない）', () => {
    expect(
      only(
        sdk({ type: 'system', subtype: 'model_refusal_no_fallback', api_refusal_category: null }),
      ),
    ).toEqual({ type: 'refusal', category: null, fellBack: false });
    expect(only(sdk({ type: 'system', subtype: 'model_refusal_fallback' }))).toEqual({
      type: 'refusal',
      category: null,
      fellBack: true,
    });
  });

  it('形が壊れた欄（文字列でない category・explanation・original_model）は省く。値を作らない', () => {
    expect(
      only(
        sdk({
          type: 'system',
          subtype: 'model_refusal_no_fallback',
          original_model: 5,
          api_refusal_category: 7,
          api_refusal_explanation: { text: 'x' },
        }),
      ),
    ).toEqual({ type: 'refusal', category: null, fellBack: false });
  });

  it('長い explanation は切って運ぶ（切ったと分かる形で）', () => {
    const event = only(
      sdk({
        type: 'system',
        subtype: 'model_refusal_no_fallback',
        api_refusal_explanation: 'x'.repeat(5000),
      }),
    );

    expect(event.type === 'refusal' && (event.explanation ?? '').length).toBeLessThan(1000);
    expect(event.type === 'refusal' && event.explanation).toContain('5,000');
  });
});

const mcpServer = { type: 'sdk', name: 'test', instance: {} } as unknown as McpServerConfig;
const sessionStore = {} as unknown as SessionStore;
const canUseTool = (async () => ({ behavior: 'allow', updatedInput: {} })) as unknown as CanUseTool;

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
      onPreToolUse: () => ({ kind: 'continue' }),
      onSubagentStop: () => {},
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
      toolUseId: 'tu-1',
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
      onPreToolUse: () => ({ kind: 'continue' }),
      onSubagentStop: () => {},
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
    expect(captured).toEqual({
      toolName: 'Bash',
      transcriptPath: '/tmp/t.jsonl',
      toolUseId: 'tu-1',
    });
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
      onPreToolUse: () => ({ kind: 'continue' }),
      onSubagentStop: () => {},
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
      toolUseId: 'tu-2',
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
    expect(capturedUse).toEqual({
      toolName: 'memory_write',
      toolInput: { text: 'メモ' },
      toolUseId: 'tu-3',
    });
    expect(capturedFailure).toEqual({
      toolName: 'memory_write',
      error: '失敗した',
      toolUseId: 'tu-4',
    });
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: (record) => {
        captured = record;
      },
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: () => {},
      onPreToolUse: () => ({ kind: 'continue' }),
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
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
      toolUseId: 'tu-5',
    });
  });
});

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
      onPreToolUse: () => ({ kind: 'continue' }),
      onSubagentStop: () => {},
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
      onPreToolUse: () => ({ kind: 'continue' }),
      onSubagentStop: () => {},
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

  it('buildManagerSessionOptions: SubagentStop の matcher の timeout は、待ちの上限より長い', () => {
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: () => {},
      onPreToolUse: () => ({ kind: 'continue' }),
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
      managerAutoMemoryEnabled: false,
    });

    const timeoutSeconds = options.hooks?.SubagentStop?.[0]?.timeout;
    expect(timeoutSeconds).toBe(SUBAGENT_STOP_HOOK_TIMEOUT_SECONDS);
    if (timeoutSeconds === undefined) throw new Error('SubagentStop の timeout が渡っていない');
    expect(SUBAGENT_BACKGROUND_WAIT_MS).toBeLessThan(timeoutSeconds * 1000);
    expect(timeoutSeconds * 1000 - SUBAGENT_BACKGROUND_WAIT_MS).toBeGreaterThanOrEqual(60_000);
  });

  describe('buildManagerSessionOptions: plugins', () => {
    const request = () => ({
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
      onPostToolUse: () => ({ kind: 'continue' as const }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' as const }),
      onStop: () => {},
      onPreToolUse: () => ({ kind: 'continue' as const }),
      onPermissionDenied: async () => ({ kind: 'no-retry' as const }),
      managerAutoMemoryEnabled: false,
    });

    it('省略・空なら欄ごと無い', () => {
      expect('plugins' in buildManagerSessionOptions(request())).toBe(false);
      expect('plugins' in buildManagerSessionOptions({ ...request(), plugins: [] })).toBe(false);
    });

    it('載るときは type: local と path と skipMcpDiscovery に写り、agents（作業者）へは混ざらない', () => {
      const options = buildManagerSessionOptions({
        ...request(),
        plugins: [
          { path: '/p/one@aaaa', skipMcpDiscovery: true },
          { path: '/p/two@bbbb', skipMcpDiscovery: false },
        ],
      });
      expect(options.plugins).toEqual([
        { type: 'local', path: '/p/one@aaaa', skipMcpDiscovery: true },
        { type: 'local', path: '/p/two@bbbb', skipMcpDiscovery: false },
      ]);
      expect(JSON.stringify(options.agents)).not.toContain('/p/');
      const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as Record<string, unknown>;
      expect(Object.hasOwn(worker, 'skills')).toBe(false);
    });
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: () => {},
      onPreCompact: (record) => {
        captured = record;
      },
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: () => {},
      onPreToolUse: () => ({ kind: 'continue' }),
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: (record) => {
        captured = record;
      },
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: () => {},
      onPreToolUse: () => ({ kind: 'continue' }),
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: (record) => {
        captured = record;
      },
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: () => {},
      onPreToolUse: () => ({ kind: 'continue' }),
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: (record) => {
        captured = record;
      },
      onPreToolUse: () => ({ kind: 'continue' }),
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: (record) => {
        captured = record;
      },
      onPreToolUse: () => ({ kind: 'continue' }),
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
      managerAutoMemoryEnabled: false,
    });

    const result = await invokeHook(options.hooks?.Stop?.[0]?.hooks[0], {
      hook_event_name: 'Stop',
      session_id: 's',
      cwd: '/work',
      stop_hook_active: 'yes',
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({});
    expect(captured).not.toHaveProperty('backgroundTasks');
    expect(captured).not.toHaveProperty('sessionCrons');
    expect(captured).not.toHaveProperty('stopHookActive');
  });
});

describe('PreToolUse の中立の判断の包み直し（#486 中立の口の3本目）', () => {
  it('buildCloneSessionOptions: PreToolUse の生入力を同じ値のまま中立の記録として渡す', async () => {
    let captured: AgentPreToolRecord | undefined;
    const options = buildCloneSessionOptions({
      model: 'fable',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env: {},
      resume: null,
      onPreCompact: () => {},
      onPostToolUse: () => {},
      onPostToolUseFailure: () => {},
      onPreToolUse: (record) => {
        captured = record;
        return { kind: 'continue' };
      },
      onSubagentStop: () => {},
    });

    const result = await invokeHook(options.hooks?.PreToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      cwd: '/work',
      transcript_path: '/tmp/t.jsonl',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_use_id: 'tu-1',
      agent_id: 'agent-1',
      agent_type: 'general-purpose',
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({
      toolName: 'Bash',
      toolInput: { command: 'echo hi' },
      agentId: 'agent-1',
      agentType: 'general-purpose',
      toolUseId: 'tu-1',
    } satisfies AgentPreToolRecord);
  });

  it('buildCloneSessionOptions: 読めない・無い欄は作り物を出さずに省く', async () => {
    let captured: AgentPreToolRecord | undefined;
    const options = buildCloneSessionOptions({
      model: 'fable',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env: {},
      resume: null,
      onPreCompact: () => {},
      onPostToolUse: () => {},
      onPostToolUseFailure: () => {},
      onPreToolUse: (record) => {
        captured = record;
        return { kind: 'continue' };
      },
      onSubagentStop: () => {},
    });

    await invokeHook(options.hooks?.PreToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      cwd: '/work',
      tool_name: 'Bash',
      tool_use_id: 'tu-1',
    });

    expect(captured).toEqual({ toolName: 'Bash', toolUseId: 'tu-1' });
    expect(captured).not.toHaveProperty('agentId');
    expect(captured).not.toHaveProperty('agentType');
  });

  it('buildCloneSessionOptions: allow を返すと、clone.ts の実装と同じ形の hookSpecificOutput になる', async () => {
    const options = buildCloneSessionOptions({
      model: 'fable',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env: {},
      resume: null,
      onPreCompact: () => {},
      onPostToolUse: () => {},
      onPostToolUseFailure: () => {},
      onPreToolUse: () => ({
        kind: 'allow',
        reason: '人間が承認した許可に一致した（Bash(gh release edit:*)）',
      }),
      onSubagentStop: () => {},
    });

    const result = await invokeHook(options.hooks?.PreToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      cwd: '/work',
      tool_name: 'Bash',
      tool_input: { command: 'gh release edit' },
      tool_use_id: 'tu-2',
    });

    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: '人間が承認した許可に一致した（Bash(gh release edit:*)）',
      },
    });
  });

  it('buildManagerSessionOptions: PreToolUse の生入力を同じ値のまま中立の記録として渡す', async () => {
    let captured: AgentPreToolRecord | undefined;
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: () => {},
      onPreToolUse: (record) => {
        captured = record;
        return { kind: 'continue' };
      },
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
      managerAutoMemoryEnabled: false,
    });

    const result = await invokeHook(options.hooks?.PreToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      cwd: '/work',
      tool_name: 'Bash',
      tool_input: { command: 'while true; do sleep 1; done', run_in_background: true },
      tool_use_id: 'tu-3',
      agent_id: 'agent-9',
      agent_type: 'worker',
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({
      toolName: 'Bash',
      toolInput: { command: 'while true; do sleep 1; done', run_in_background: true },
      agentId: 'agent-9',
      agentType: 'worker',
      toolUseId: 'tu-3',
    } satisfies AgentPreToolRecord);
  });

  it('buildManagerSessionOptions: deny を返すと、runner.ts の実装と同じ形の hookSpecificOutput になる', async () => {
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: () => {},
      onPreToolUse: () => ({
        kind: 'deny',
        reason: '無限に待つだけの形（代替: timeout でラップする）',
      }),
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
      managerAutoMemoryEnabled: false,
    });

    const result = await invokeHook(options.hooks?.PreToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      cwd: '/work',
      tool_name: 'Bash',
      tool_input: { command: 'until true; do sleep 1; done' },
      tool_use_id: 'tu-4',
    });

    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '無限に待つだけの形（代替: timeout でラップする）',
      },
    });
  });

  it('buildManagerSessionOptions: ask を返すと、permissionDecision: ask と理由を運ぶ（確認に上がる。#2884）', async () => {
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: () => {},
      onPreToolUse: () => ({
        kind: 'ask',
        reason: '無限に待つだけの形（代替: timeout でラップする）',
      }),
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
      managerAutoMemoryEnabled: false,
    });

    const result = await invokeHook(options.hooks?.PreToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      cwd: '/work',
      tool_name: 'Bash',
      tool_input: { command: 'until true; do sleep 1; done' },
      tool_use_id: 'tu-4a',
    });

    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: '無限に待つだけの形（代替: timeout でラップする）',
      },
    });
  });

  it('未知の kind が渡ったら安全側（{ continue: true }）へ倒し、跡を1本残す（実行時の倒れ先。型では弾かれるはずの値が渡ったときの防御）', async () => {
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
      onPostToolUse: () => ({ kind: 'continue' }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' }),
      onStop: () => {},
      onPreToolUse: () => ({ kind: 'bogus' }) as unknown as AgentPreToolDecision,
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
      managerAutoMemoryEnabled: false,
    });

    let result: unknown;
    const lines = await captureStderr(async () => {
      result = await invokeHook(options.hooks?.PreToolUse?.[0]?.hooks[0], {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        cwd: '/work',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        tool_use_id: 'tu-5',
      });
    });

    expect(result).toEqual({ continue: true });
    expect(lines.some((line) => line.includes('未知の AgentPreToolDecision.kind'))).toBe(true);
  });
});

describe('文脈を返すフックの中立の包み直し（#486 中立の口の4本目）', () => {
  function managerOptions(hooks: {
    onPostToolUse?: AgentContextHook<AgentToolAuditRecord>;
    onSubagentStop?: AgentContextHook<AgentSubagentStopRecord>;
  }) {
    return buildManagerSessionOptions({
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
      onPostToolUse: hooks.onPostToolUse ?? (() => ({ kind: 'continue' })),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: hooks.onSubagentStop ?? (() => ({ kind: 'continue' })),
      onStop: () => {},
      onPreToolUse: () => ({ kind: 'continue' }),
      onPermissionDenied: async () => ({ kind: 'no-retry' }),
      managerAutoMemoryEnabled: false,
    });
  }

  it('PostToolUse: 生入力を同じ値のまま中立の記録として渡し、continue は { continue: true } に写る', async () => {
    let captured: AgentToolAuditRecord | undefined;
    const options = managerOptions({
      onPostToolUse: (record) => {
        captured = record;
        return { kind: 'continue' };
      },
    });

    const result = await invokeHook(options.hooks?.PostToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PostToolUse',
      session_id: 's',
      cwd: '/work',
      transcript_path: '/t.jsonl',
      tool_name: 'Agent',
      tool_input: { prompt: 'p' },
      tool_response: { status: 'completed', agentId: 'agent-1' },
      tool_use_id: 'tu-1',
      agent_id: 'agent-2',
      agent_type: 'general-purpose',
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({
      toolName: 'Agent',
      toolInput: { prompt: 'p' },
      toolResponse: { status: 'completed', agentId: 'agent-1' },
      transcriptPath: '/t.jsonl',
      agentId: 'agent-2',
      agentType: 'general-purpose',
      toolUseId: 'tu-1',
    } satisfies AgentToolAuditRecord);
  });

  it('PostToolUse: addContext は hookEventName PostToolUse の additionalContext に写る（中立化する前と同じ形）', async () => {
    const options = managerOptions({
      onPostToolUse: () => ({ kind: 'addContext', text: '打ち切りの注記' }),
    });

    const result = await invokeHook(options.hooks?.PostToolUse?.[0]?.hooks[0], {
      hook_event_name: 'PostToolUse',
      session_id: 's',
      cwd: '/work',
      tool_name: 'Agent',
      tool_input: {},
      tool_response: {},
      tool_use_id: 'tu-2',
    });

    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '打ち切りの注記' },
    });
  });

  it('SubagentStop: 生入力を同じ値のまま中立の記録として渡す', async () => {
    let captured: AgentSubagentStopRecord | undefined;
    const backgroundTasks = [{ id: 'b1', type: 'local_bash', status: 'running' }];
    const sessionCrons = [{ id: 'c1' }];
    const options = managerOptions({
      onSubagentStop: (record) => {
        captured = record;
        return { kind: 'continue' };
      },
    });

    const result = await invokeHook(options.hooks?.SubagentStop?.[0]?.hooks[0], {
      hook_event_name: 'SubagentStop',
      session_id: 's',
      cwd: '/work',
      transcript_path: '/t.jsonl',
      agent_id: 'agent-3',
      agent_type: 'general-purpose',
      agent_transcript_path: '/a.jsonl',
      stop_hook_active: false,
      background_tasks: backgroundTasks,
      session_crons: sessionCrons,
    });

    expect(result).toEqual({ continue: true });
    expect(captured).toEqual({
      backgroundTasks,
      sessionCrons,
      agentId: 'agent-3',
      agentType: 'general-purpose',
      stopHookActive: false,
    } satisfies AgentSubagentStopRecord);
  });

  it('SubagentStop: 配列でない背景処理・真偽値でない stop_hook_active は、作り物で埋めずに省く（中立化する前の読み方と同じ）', async () => {
    let captured: AgentSubagentStopRecord | undefined;
    const options = managerOptions({
      onSubagentStop: (record) => {
        captured = record;
        return { kind: 'continue' };
      },
    });

    await invokeHook(options.hooks?.SubagentStop?.[0]?.hooks[0], {
      hook_event_name: 'SubagentStop',
      session_id: 's',
      cwd: '/work',
      background_tasks: 'not-an-array',
      session_crons: { not: 'an array' },
      stop_hook_active: 'yes',
    });

    expect(captured).toEqual({});
  });

  it('SubagentStop: addContext は hookEventName SubagentStop の additionalContext に写る（中立化する前と同じ形）', async () => {
    const options = managerOptions({
      onSubagentStop: () => ({ kind: 'addContext', text: '起こし直し' }),
    });

    const result = await invokeHook(options.hooks?.SubagentStop?.[0]?.hooks[0], {
      hook_event_name: 'SubagentStop',
      session_id: 's',
      cwd: '/work',
      agent_id: 'agent-4',
    });

    expect(result).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: '起こし直し' },
    });
  });

  it('未知の kind が渡ったら安全側（{ continue: true }）へ倒し、跡を1本残す（型では弾かれるはずの値が渡ったときの防御）', async () => {
    const options = managerOptions({
      onSubagentStop: () => ({ kind: 'block' }) as unknown as AgentContextOutcome,
    });

    let result: unknown;
    const lines = await captureStderr(async () => {
      result = await invokeHook(options.hooks?.SubagentStop?.[0]?.hooks[0], {
        hook_event_name: 'SubagentStop',
        session_id: 's',
        cwd: '/work',
        agent_id: 'agent-5',
      });
    });

    expect(result).toEqual({ continue: true });
    expect(lines.some((line) => line.includes('未知の AgentContextOutcome.kind'))).toBe(true);
  });
});

describe('plugins を Options.plugins へ写す', () => {
  const sessionBase = {
    model: 'fable',
    permissionMode: DEFAULT_PERMISSION_MODE,
    mcpServer,
    systemPrompt: 'システムプロンプト',
    env: {},
    resume: null,
    onPreCompact: () => {},
    onPostToolUse: () => {},
    onPostToolUseFailure: () => {},
    onPreToolUse: () => ({ kind: 'continue' as const }),
    onSubagentStop: () => {},
  };
  const distillBase = {
    model: 'fable',
    permissionMode: DEFAULT_PERMISSION_MODE,
    mcpServer,
    systemPrompt: 'システムプロンプト',
    env: {},
    onPostToolUse: () => {},
    onPostToolUseFailure: () => {},
  };
  const plugins = [
    { path: '/data/plugins/one@' + 'a'.repeat(40), skipMcpDiscovery: true },
    { path: '/data/plugins/two@' + 'b'.repeat(40), skipMcpDiscovery: false },
  ];
  const expected = [
    { type: 'local', path: plugins[0]?.path, skipMcpDiscovery: true },
    { type: 'local', path: plugins[1]?.path, skipMcpDiscovery: false },
  ];

  it('両 builder が type: local と skipMcpDiscovery を付けて通す', () => {
    expect(buildCloneSessionOptions({ ...sessionBase, plugins }).plugins).toEqual(expected);
    expect(buildCloneDistillOptions({ ...distillBase, plugins }).plugins).toEqual(expected);
  });

  it('省略・空なら欄ごと無い', () => {
    for (const options of [
      buildCloneSessionOptions(sessionBase),
      buildCloneSessionOptions({ ...sessionBase, plugins: [] }),
      buildCloneDistillOptions(distillBase),
      buildCloneDistillOptions({ ...distillBase, plugins: [] }),
    ]) {
      expect('plugins' in options).toBe(false);
    }
  });
});

describe('モデルを黙って古い版へ降ろさせない env（withNoModelFallbackEnv）', () => {
  const cloneOptions = (env: NodeJS.ProcessEnv) =>
    buildCloneSessionOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env,
      resume: null,
      onPreCompact: () => {},
      onPostToolUse: () => {},
      onPostToolUseFailure: () => {},
      onPreToolUse: () => ({ kind: 'continue' }),
      onSubagentStop: () => {},
    });
  const distillOptions = (env: NodeJS.ProcessEnv) =>
    buildCloneDistillOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      mcpServer,
      systemPrompt: 'システムプロンプト',
      env,
      onPostToolUse: () => {},
      onPostToolUseFailure: () => {},
    });
  const managerOptions = (env: NodeJS.ProcessEnv) =>
    buildManagerSessionOptions({
      model: 'opus',
      permissionMode: DEFAULT_PERMISSION_MODE,
      systemPromptAppend: '追記',
      workerAgentName: WORKER_AGENT_NAME,
      workerPrompt: '作業者のプロンプト',
      workerModel: 'sonnet',
      cwd: '/work',
      env,
      sessionStore,
      canUseTool,
      onPostToolUse: () => ({ kind: 'continue' as const }),
      onPostToolUseFailure: () => {},
      onPreCompact: () => {},
      onUserPromptSubmit: () => {},
      onSubagentStop: () => ({ kind: 'continue' as const }),
      onStop: () => {},
      onPreToolUse: () => ({ kind: 'continue' as const }),
      onPermissionDenied: async () => ({ kind: 'no-retry' as const }),
      managerAutoMemoryEnabled: false,
    });
  const builders = [
    ['クローン本体', cloneOptions],
    ['蒸留', distillOptions],
    ['マネージャー（作業者は同じプロセスの env を継ぐ）', managerOptions],
  ] as const;

  it.each(builders)('%s: はしごを降りる降格を止め、渡した env は保つ', (_, build) => {
    const env = build({ CLAUDE_CODE_OAUTH_TOKEN: 'dummy', PATH: '/bin' }).env;
    expect(env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'dummy',
      PATH: '/bin',
      CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    });
  });

  it('アカウントのモデルカタログは止めない（新しい版を先に配る経路でもあるため）', () => {
    expect(Object.hasOwn(withNoModelFallbackEnv({}), 'CLAUDE_CODE_MODEL_CATALOG')).toBe(false);
  });

  it('人間が値を置いていれば上書きしない', () => {
    expect(withNoModelFallbackEnv({ CLAUDE_CODE_NO_MODEL_FALLBACK: '0' })).toEqual({
      CLAUDE_CODE_NO_MODEL_FALLBACK: '0',
    });
  });

  it('空文字・空白だけは「置いていない」と読む（器が `${VAR:-}` で空を渡しても止まる）', () => {
    expect(withNoModelFallbackEnv({ CLAUDE_CODE_NO_MODEL_FALLBACK: '  ' })).toEqual({
      CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    });
  });

  it('渡された env オブジェクトそのものは書き換えない', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin' };
    withNoModelFallbackEnv(env);
    expect(env).toEqual({ PATH: '/bin' });
  });
});

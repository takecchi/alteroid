import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionDeniedHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SDKMessage,
  SessionStore,
  SpawnedProcess,
  SpawnOptions,
  StopHookInput,
  SubagentStopHookInput,
  UserPromptSubmitHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentContentBlock,
  AgentEvent,
  AgentPermissionDenial,
  AgentRuntimeFacts,
  AgentTurnUsage,
} from './agent-events.js';
import type { AgentProvider } from './agent-ports.js';
import type {
  AgentContextHook,
  AgentObservationHook,
  AgentPermissionDeniedHook,
  AgentPermissionDeniedRecord,
  AgentPreCompactRecord,
  AgentPreToolHook,
  AgentPreToolRecord,
  AgentStopRecord,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
  AgentUserPromptSubmitRecord,
} from './agent-hooks.js';
import { noteBackgroundFailure } from './dropped-record.js';
import { excerpt } from './excerpt.js';
import type { PermissionModeName } from './permission-mode.js';
import { SUBAGENT_BACKGROUND_WAIT_MS } from './runner-subagent-stop-state.js';
import { resultErrorLines, resultFailureOf } from './sdk-failure.js';
import { CLONE_ALLOWED_TOOLS, MCP_SERVER_NAME } from './tools.js';
import { classifyUsageNotice, toRateLimitFacts } from './usage-limits.js';
import { toAccountApiKeySource } from './usage-snapshot.js';
import { isSuccessResult, modelUsageOf } from './usage.js';

// 呼び出し側が持つインスタンスの状態・副作用のある前処理をここへ移さない: ここは「渡された値をどこへ置くか」と「届いた値が何を意味するか」だけを知る純関数の集まりに保つため

// 待ちの上限 < この timeout を守る: 超えると SDK は答え無しのまま作業者を畳み、`limit_reached` の経路（`recordCutOff`）を通らず、完了の配達が働かないため
// SDK の既定値に頼らず matcher に明示する: 既定値は未確認のため
export const SUBAGENT_STOP_HOOK_TIMEOUT_SECONDS =
  Math.ceil(SUBAGENT_BACKGROUND_WAIT_MS / 1000) + 120;
export const PRE_COMPACT_HOOK_TIMEOUT_SECONDS = 120;

export const CLAUDE_PROVIDER: AgentProvider = {
  id: 'claude',
  displayName: 'Claude',
  capabilities: {
    permissions: true,
    toolAudit: true,
    compactionHook: true,
    resume: true,
    sessionLog: true,
    subagents: true,
    mcpServers: true,
    childUser: true,
    usage: true,
    partialMessages: true,
  },
};

function toAgentToolAuditRecord(input: unknown): AgentToolAuditRecord {
  const raw = input as Partial<PostToolUseHookInput> | null | undefined;
  return {
    ...(typeof raw?.tool_name === 'string' ? { toolName: raw.tool_name } : {}),
    toolInput: raw?.tool_input,
    toolResponse: raw?.tool_response,
    ...(typeof raw?.transcript_path === 'string' ? { transcriptPath: raw.transcript_path } : {}),
    ...(typeof raw?.effort?.level === 'string' ? { effortLevel: raw.effort.level } : {}),
    ...(typeof raw?.agent_id === 'string' ? { agentId: raw.agent_id } : {}),
    ...(typeof raw?.agent_type === 'string' ? { agentType: raw.agent_type } : {}),
    ...(typeof raw?.tool_use_id === 'string' ? { toolUseId: raw.tool_use_id } : {}),
  };
}

function toAgentToolAuditFailureRecord(input: unknown): AgentToolAuditFailureRecord {
  const raw = input as Partial<PostToolUseFailureHookInput> | null | undefined;
  return {
    ...(typeof raw?.tool_name === 'string' ? { toolName: raw.tool_name } : {}),
    toolInput: raw?.tool_input,
    ...(typeof raw?.transcript_path === 'string' ? { transcriptPath: raw.transcript_path } : {}),
    ...(typeof raw?.effort?.level === 'string' ? { effortLevel: raw.effort.level } : {}),
    ...(typeof raw?.agent_id === 'string' ? { agentId: raw.agent_id } : {}),
    ...(typeof raw?.agent_type === 'string' ? { agentType: raw.agent_type } : {}),
    ...(typeof raw?.error === 'string' ? { error: raw.error } : {}),
    ...(raw?.is_interrupt === undefined ? {} : { isInterrupt: raw.is_interrupt }),
    ...(typeof raw?.tool_use_id === 'string' ? { toolUseId: raw.tool_use_id } : {}),
  };
}

function wrapToolAuditHook(hook: AgentObservationHook<AgentToolAuditRecord>): HookCallback {
  return async (input) => {
    await hook(toAgentToolAuditRecord(input));
    return { continue: true };
  };
}

function wrapToolAuditFailureHook(
  hook: AgentObservationHook<AgentToolAuditFailureRecord>,
): HookCallback {
  return async (input) => {
    await hook(toAgentToolAuditFailureRecord(input));
    return { continue: true };
  };
}

function toAgentPreCompactRecord(
  input: unknown,
  signal: AbortSignal | undefined,
): AgentPreCompactRecord {
  const raw = input as Partial<PreCompactHookInput> | null | undefined;
  return {
    ...(typeof raw?.transcript_path === 'string' ? { transcriptPath: raw.transcript_path } : {}),
    ...(typeof raw?.session_id === 'string' ? { sessionId: raw.session_id } : {}),
    ...(signal === undefined ? {} : { signal }),
  };
}

function toAgentUserPromptSubmitRecord(input: unknown): AgentUserPromptSubmitRecord {
  const raw = input as Partial<UserPromptSubmitHookInput> | null | undefined;
  return {
    ...(typeof raw?.agent_id === 'string' ? { agentId: raw.agent_id } : {}),
    ...(typeof raw?.source === 'string' ? { source: raw.source } : {}),
  };
}

function toAgentStopRecord(input: unknown): AgentStopRecord {
  try {
    const raw = input as Partial<StopHookInput> | null | undefined;
    return {
      ...(Array.isArray(raw?.background_tasks) ? { backgroundTasks: raw.background_tasks } : {}),
      ...(Array.isArray(raw?.session_crons) ? { sessionCrons: raw.session_crons } : {}),
      ...(typeof raw?.stop_hook_active === 'boolean'
        ? { stopHookActive: raw.stop_hook_active }
        : {}),
    };
  } catch (error: unknown) {
    return { readError: error };
  }
}

// `await` を保つ: compaction はこのフックの返り値を待つので、退避・蒸留の完了を待ってから返す意味を変えないため
function wrapPreCompactHook(hook: AgentObservationHook<AgentPreCompactRecord>): HookCallback {
  return async (input, _toolUseId, options) => {
    await hook(toAgentPreCompactRecord(input, options?.signal));
    return { continue: true };
  };
}

function wrapUserPromptSubmitHook(
  hook: AgentObservationHook<AgentUserPromptSubmitRecord>,
): HookCallback {
  return async (input) => {
    await hook(toAgentUserPromptSubmitRecord(input));
    return { continue: true };
  };
}

function wrapStopHook(hook: AgentObservationHook<AgentStopRecord>): HookCallback {
  return async (input) => {
    await hook(toAgentStopRecord(input));
    return { continue: true };
  };
}

function toAgentPreToolRecord(input: unknown): AgentPreToolRecord {
  const raw = input as Partial<PreToolUseHookInput> | null | undefined;
  return {
    ...(typeof raw?.tool_name === 'string' ? { toolName: raw.tool_name } : {}),
    toolInput: raw?.tool_input,
    ...(typeof raw?.agent_id === 'string' ? { agentId: raw.agent_id } : {}),
    ...(typeof raw?.agent_type === 'string' ? { agentType: raw.agent_type } : {}),
    ...(typeof raw?.tool_use_id === 'string' ? { toolUseId: raw.tool_use_id } : {}),
  };
}

// `default` 節で投げない: このフックは SDK のツール実行の経路に載っており、例外を投げるとそのターン全体が壊れるため。安全側（`{ continue: true }`）へ倒し、`noteBackgroundFailure` で跡だけ残す
function wrapPreToolHook(hook: AgentPreToolHook): HookCallback {
  return async (input) => {
    const decision = await hook(toAgentPreToolRecord(input));
    switch (decision.kind) {
      case 'continue':
        // 書き換えは `permissionDecision` を付けずに返す: 確認の流れをそのままにして入力だけを変えるため
        if (decision.rewrite === undefined) return { continue: true };
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: decision.rewrite.input,
            additionalContext: decision.rewrite.note,
          },
        };
      case 'allow':
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: decision.reason,
            ...(decision.rewrite !== undefined
              ? { updatedInput: decision.rewrite.input, additionalContext: decision.rewrite.note }
              : {}),
          },
        };
      case 'ask':
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: decision.reason,
            ...(decision.rewrite !== undefined
              ? { updatedInput: decision.rewrite.input, additionalContext: decision.rewrite.note }
              : {}),
          },
        };
      case 'deny':
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: decision.reason,
          },
        };
      default: {
        const unreachable: never = decision;
        noteBackgroundFailure(
          'PreToolUse の中立な判断の包み直し',
          '',
          new Error(`未知の AgentPreToolDecision.kind が渡った: ${JSON.stringify(unreachable)}`),
        );
        return { continue: true };
      }
    }
  };
}

function toAgentPermissionDeniedRecord(
  input: unknown,
  signal: AbortSignal,
): AgentPermissionDeniedRecord {
  const raw = input as Partial<PermissionDeniedHookInput> | null | undefined;
  return {
    ...(typeof raw?.tool_name === 'string' ? { toolName: raw.tool_name } : {}),
    toolInput: raw?.tool_input,
    ...(typeof raw?.tool_use_id === 'string' ? { toolUseId: raw.tool_use_id } : {}),
    ...(typeof raw?.reason === 'string' ? { reason: raw.reason } : {}),
    ...(typeof raw?.agent_id === 'string' ? { agentId: raw.agent_id } : {}),
    ...(typeof raw?.agent_type === 'string' ? { agentType: raw.agent_type } : {}),
    signal,
  };
}

// `retry: false` を明示せず省く: 「不在」と「明示的な false」を型のうえで区別する必要が今のところ無いため
// `default` 節で投げない: フックの中で例外を投げるとそのターンが壊れるため。安全側（`{ continue: true }`）へ倒し、`noteBackgroundFailure` で跡だけ残す
function wrapPermissionDeniedHook(hook: AgentPermissionDeniedHook): HookCallback {
  return async (input, _toolUseID, options) => {
    const decision = await hook(toAgentPermissionDeniedRecord(input, options.signal));
    switch (decision.kind) {
      case 'retry':
        return {
          continue: true,
          hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true },
        };
      case 'no-retry':
        return { continue: true };
      default: {
        const unreachable: never = decision;
        noteBackgroundFailure(
          'PermissionDenied の中立な判断の包み直し',
          '',
          new Error(
            `未知の AgentPermissionDeniedDecision.kind が渡った: ${JSON.stringify(unreachable)}`,
          ),
        );
        return { continue: true };
      }
    }
  };
}

function toAgentSubagentStopRecord(input: unknown): AgentSubagentStopRecord {
  try {
    const raw = input as Partial<SubagentStopHookInput> | null | undefined;
    return {
      ...(Array.isArray(raw?.background_tasks) ? { backgroundTasks: raw.background_tasks } : {}),
      ...(Array.isArray(raw?.session_crons) ? { sessionCrons: raw.session_crons } : {}),
      ...(typeof raw?.agent_id === 'string' ? { agentId: raw.agent_id } : {}),
      ...(typeof raw?.agent_type === 'string' ? { agentType: raw.agent_type } : {}),
      ...(typeof raw?.stop_hook_active === 'boolean'
        ? { stopHookActive: raw.stop_hook_active }
        : {}),
    };
  } catch (error: unknown) {
    return { readError: error };
  }
}

function wrapSubagentStopObservationHook(
  hook: AgentObservationHook<AgentSubagentStopRecord>,
): HookCallback {
  return async (input) => {
    await hook(toAgentSubagentStopRecord(input));
    return { continue: true };
  };
}

// `default` 節で投げない: このフックはツール実行・作業者継続の経路に載っており、例外を投げるとそのターン・作業者のターンが壊れるため。安全側（`{ continue: true }`）へ倒し、`noteBackgroundFailure` で跡だけ残す
function wrapContextHook<T>(
  hookEventName: 'PostToolUse' | 'SubagentStop',
  hook: AgentContextHook<T>,
  toRecord: (input: unknown) => T,
): HookCallback {
  return async (input) => {
    const outcome = await hook(toRecord(input));
    switch (outcome.kind) {
      case 'continue':
        return { continue: true };
      case 'addContext':
        return {
          continue: true,
          hookSpecificOutput: { hookEventName, additionalContext: outcome.text },
        };
      default: {
        const unreachable: never = outcome;
        noteBackgroundFailure(
          `${hookEventName} の中立な文脈の包み直し`,
          '',
          new Error(`未知の AgentContextOutcome.kind が渡った: ${JSON.stringify(unreachable)}`),
        );
        return { continue: true };
      }
    }
  };
}

// 自作のインプロセス MCP を最後に置いて必ず勝たせる: 入口でも同じ名前を拒むが守りを1枚に寄せず、同じ名前が来ても自分の道具が人間の登録に差し替わらないようにするため
// 本セッションと蒸留で同じ関数を通す: 片方だけ人間の連携が見えると、人格の書き手（蒸留）だけが別の手を持つため
export function cloneMcpServers(
  own: McpServerConfig,
  external: Readonly<Record<string, McpServerConfig>> | undefined,
): Record<string, McpServerConfig> {
  return { ...(external ?? {}), [MCP_SERVER_NAME]: own };
}

export interface ClonePluginRequest {
  path: string;
  skipMcpDiscovery: boolean;
}

/** 空なら欄ごと省く（空配列を渡すと SDK へ「plugin 0本」と明示することになり、既定との差が出る）。 */
function clonePluginOptions(
  plugins: readonly ClonePluginRequest[] | undefined,
): Pick<Options, 'plugins'> {
  if (plugins === undefined || plugins.length === 0) return {};
  return {
    plugins: plugins.map((plugin) => ({
      type: 'local' as const,
      path: plugin.path,
      skipMcpDiscovery: plugin.skipMcpDiscovery,
    })),
  };
}

export interface CloneSessionOptionsRequest {
  model: string;
  permissionMode: PermissionModeName;
  mcpServer: McpServerConfig;
  externalMcpServers?: Readonly<Record<string, McpServerConfig>>;
  /** 展開済みの plugin（`Options.plugins` の `type: 'local'` へ写す）。省略・空なら欄ごと省く。 */
  plugins?: readonly ClonePluginRequest[];
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  resume: string | null;
  sessionStore?: SessionStore;
  onPreCompact: AgentObservationHook<AgentPreCompactRecord>;
  onPostToolUse: AgentObservationHook<AgentToolAuditRecord>;
  onPostToolUseFailure: AgentObservationHook<AgentToolAuditFailureRecord>;
  onPreToolUse: AgentPreToolHook;
  // `buildCloneDistillOptions`（蒸留）には配線しない: 蒸留は `Task` を呼ばない設計で、`SubagentStop` が発火する前提が無いため
  onSubagentStop: AgentObservationHook<AgentSubagentStopRecord>;
}

export function buildCloneSessionOptions(request: CloneSessionOptionsRequest): Options {
  const {
    model,
    permissionMode,
    mcpServer,
    externalMcpServers,
    plugins,
    systemPrompt,
    env,
    cwd,
    resume,
    sessionStore,
    onPreCompact,
    onPostToolUse,
    onPostToolUseFailure,
    onPreToolUse,
    onSubagentStop,
  } = request;

  return {
    model,
    // `tools` を渡さない: 明示リストで絞ると能力の削除になるため
    // [sdk-verbatim Options.allowedTools]
    // To restrict which tools are available, use the `tools` option instead.
    allowedTools: CLONE_ALLOWED_TOOLS,
    // `default` のまま道具を渡さない: このセッションには `canUseTool` が無く、SDK は確認相手が居ないとき `ask` をそのまま拒否で終わらせるため
    // `canUseTool` を繋がない: クローンは長寿命セッション1本で全ターンが直列に通るので、人間の回答を待って止めると止まるのが全部になるため
    permissionMode,
    mcpServers: cloneMcpServers(mcpServer, externalMcpServers),
    ...clonePluginOptions(plugins),
    systemPrompt,
    // `settingSources` を `[]` にしない: 人間が Claude Code で使っている MCP 連携がクローンから1つも見えなくなる（能力の削除）ため
    settingSources: ['user', 'project', 'local'],
    // `skills: 'all'` を明示し、名前を列挙しない: 省くと CLI の既定に委ねて器によって引けるものが変わり、列挙するとスキルが増えたときに追いつかないため
    skills: 'all',
    env,
    includePartialMessages: true,
    ...(cwd === undefined ? {} : { cwd }),
    ...(resume === null ? {} : { resume }),
    ...(sessionStore === undefined ? {} : { sessionStore }),
    hooks: {
      PreToolUse: [
        {
          hooks: [wrapPreToolHook(onPreToolUse)],
        },
      ],
      PreCompact: [
        {
          timeout: PRE_COMPACT_HOOK_TIMEOUT_SECONDS,
          hooks: [wrapPreCompactHook(onPreCompact)],
        },
      ],
      // effort を `PreCompact` で拾わない: `PreCompact` はセッション生涯に対して1本のフックで、`BaseHookInput.effort` はツール実行の文脈で発火するフックにしか付かないため
      PostToolUse: [
        {
          hooks: [wrapToolAuditHook(onPostToolUse)],
        },
      ],
      // `PostToolUse` と `PostToolUseFailure` の片方だけを登録しない: 排他に発火するので両方登録しても二重記録にならず、片方だけだと失敗・中断した道具呼び出しが日誌に1件も残らないため
      PostToolUseFailure: [
        {
          hooks: [wrapToolAuditFailureHook(onPostToolUseFailure)],
        },
      ],
      SubagentStop: [
        {
          hooks: [wrapSubagentStopObservationHook(onSubagentStop)],
        },
      ],
    },
  };
}

export interface CloneDistillOptionsRequest {
  model: string;
  permissionMode: PermissionModeName;
  mcpServer: McpServerConfig;
  externalMcpServers?: Readonly<Record<string, McpServerConfig>>;
  /** 本セッションと同じもの（`CloneSessionOptionsRequest.plugins`）。 */
  plugins?: readonly ClonePluginRequest[];
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onPostToolUse: AgentObservationHook<AgentToolAuditRecord>;
  onPostToolUseFailure: AgentObservationHook<AgentToolAuditFailureRecord>;
}

export function buildCloneDistillOptions(request: CloneDistillOptionsRequest): Options {
  const {
    model,
    permissionMode,
    mcpServer,
    externalMcpServers,
    plugins,
    systemPrompt,
    env,
    cwd,
    onPostToolUse,
    onPostToolUseFailure,
  } = request;

  return {
    model,
    // 本セッションと同じ配置にする: 片方だけ道具や設定が違うと、人格の書き手（蒸留）だけが別の頭になるため
    allowedTools: CLONE_ALLOWED_TOOLS,
    permissionMode,
    mcpServers: cloneMcpServers(mcpServer, externalMcpServers),
    ...clonePluginOptions(plugins),
    systemPrompt,
    settingSources: ['user', 'project', 'local'],
    skills: 'all',
    env,
    persistSession: false,
    ...(cwd === undefined ? {} : { cwd }),
    // 監査も蒸留側に登録する: 記録が片方に無いと「蒸留のターンで何をしたか」がどこにも残らないため
    hooks: {
      PostToolUse: [{ hooks: [wrapToolAuditHook(onPostToolUse)] }],
      // 蒸留の失敗も記録する: 蒸留は `memory_write` を叩く経路で、失敗を記録しないと「記憶が書かれなかった」が静かに落ちるため
      PostToolUseFailure: [{ hooks: [wrapToolAuditFailureHook(onPostToolUseFailure)] }],
    },
  };
}

export interface ManagerSessionOptionsRequest {
  model: string;
  permissionMode: PermissionModeName;
  systemPromptAppend: string;
  workerAgentName: string;
  workerPrompt: string;
  workerModel: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionStore: SessionStore;
  resume?: string;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  canUseTool: CanUseTool;
  // `AgentObservationHook` ではなく `AgentContextHook` に載せる: `runner.ts` の `#onPostToolUse` は打ち切り注記を追加の文脈として返す経路を持ち、`void` しか返せない `AgentObservationHook` には載らないため
  onPostToolUse: AgentContextHook<AgentToolAuditRecord>;
  // 観測フックを optional にしない: 省略できる形にすると、provider を足す側が「渡さない」ことで観測を静かに落とせるため
  onPostToolUseFailure: AgentObservationHook<AgentToolAuditFailureRecord>;
  onPreCompact: AgentObservationHook<AgentPreCompactRecord>;
  onUserPromptSubmit: AgentObservationHook<AgentUserPromptSubmitRecord>;
  // `AgentContextHook` に載せる: `runner.ts` の `#onSubagentStop` は作業者を起こし直す文脈を返す判断を含み、`AgentObservationHook` には載らないため
  onSubagentStop: AgentContextHook<AgentSubagentStopRecord>;
  onStop: AgentObservationHook<AgentStopRecord>;
  // [sdk-verbatim PreModelSwitchHookSpecificOutput]
  // > Same contract as PreToolUse: allow proceeds (skipping the interactive cache-miss confirm), deny cancels the switch, ask asks the user to confirm (a headless session refuses instead)
  onPreToolUse: AgentPreToolHook;
  onPermissionDenied: AgentPermissionDeniedHook;
  // クローン側に同じ引数を持たせない: auto-memory が「書いた本人の次のセッション」に届く前提は、使い捨てのマネージャーと違い、長寿命1本のクローンでは崩れていないため
  managerAutoMemoryEnabled: boolean;
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  /**
   * runner が展開した plugin（`Options.plugins` の `type: 'local'` へ写す）。省略・空なら欄ごと省く。
   * **`agents`（作業者）には何も足さない** — 作業者は親のセッションから受け継ぐ見込みで、
   * `AgentDefinition.skills` は名前の配列しか取れず、列挙すると増えた分に追いつかない。
   */
  plugins?: readonly ClonePluginRequest[];
}

export function buildManagerSessionOptions(request: ManagerSessionOptionsRequest): Options {
  const {
    model,
    permissionMode,
    systemPromptAppend,
    workerAgentName,
    workerPrompt,
    workerModel,
    cwd,
    env,
    sessionStore,
    resume,
    spawnClaudeCodeProcess,
    canUseTool,
    onPostToolUse,
    onPostToolUseFailure,
    onPreCompact,
    onUserPromptSubmit,
    onSubagentStop,
    onStop,
    onPreToolUse,
    onPermissionDenied,
    managerAutoMemoryEnabled,
    mcpServers,
    plugins,
  } = request;

  return {
    model,
    // `tools` と `maxTurns` を渡さない: 明示リストで絞らず、ターン数でも止めないため
    permissionMode,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,
    },
    // 作業者の `mcpServers` を書かない: 省けば親の MCP 接続を継承し、名前で書き足すと継承で届いているものを二重に起こすか、届かない指定を足すかのどちらかになるため
    // [sdk-verbatim AgentDefinition.tools]
    // Array of allowed tool names. If omitted, inherits all tools from parent.
    agents: {
      [workerAgentName]: {
        description:
          'コストと文脈のために切り出した実作業の担い手。実装に限らず、調査・下読み・' +
          '外部サービスの確認・レビューの下読み・相談のたたき台づくりまで任せてよい。' +
          '設計・デザイン・外へ出す文面のように、出力の質そのものが成果の仕事は任せない。',
        prompt: workerPrompt,
        // 省略しない: SDK の既定は親（マネージャー）の継承で、省くとマネージャーを差し替えた人が作業者まで巻き添えで動かすことになるため
        model: workerModel,
      },
    },
    cwd,
    // 記憶ストアの MCP 登録は `.mcp.json` とは別に `mcpServers` で渡す: Railway では `.mcp.json` の置き場が再デプロイで消え、設定だけだとこの層の連携が0本になるため
    settingSources: ['user', 'project', 'local'],
    // 空なら載せない: 登録を置いていない構成の挙動を動かさないため
    ...(mcpServers === undefined || Object.keys(mcpServers).length === 0
      ? {}
      : { mcpServers: { ...mcpServers } }),
    ...clonePluginOptions(plugins),
    // `skills: 'all'` を明示し、名前を列挙しない: 省くと CLI の既定に委ねて器によって引けるものが変わり、列挙するとスキルが増えたときに追いつかないため
    // 上の `agents`（作業者）側には `skills` を書かない: `AgentDefinition.skills` は `'all'` を受けず、名前の配列は明示リストで絞ることになり、preload で作業者の文脈へ先に載って畳んだ意味も消えるため
    skills: 'all',
    env,
    // 生ログはデーモンへ預ける: runner は永続化の器を持たず、記憶ストアの鍵を runner に置かないため
    sessionStore,
    // [sdk-verbatim Options.settings]
    // which has the highest priority among user-controlled settings.
    // [sdk-verbatim Settings.autoMemoryEnabled]
    // Enable auto-memory for this project. When false, Claude will not read from or write to the auto-memory directory.
    // `autoMemoryEnabled` の doc に「Ignored if set in projectSettings」が付いていないことは、SDK を上げるときに目で確かめる: 不在の主張で `check:sdk-quotes` の印では確かめられないため
    ...(managerAutoMemoryEnabled ? {} : { settings: { autoMemoryEnabled: false } }),
    ...(resume === undefined ? {} : { resume }),
    ...(spawnClaudeCodeProcess === undefined ? {} : { spawnClaudeCodeProcess }),
    canUseTool,
    hooks: {
      PreToolUse: [{ hooks: [wrapPreToolHook(onPreToolUse)] }],
      PermissionDenied: [{ hooks: [wrapPermissionDeniedHook(onPermissionDenied)] }],
      PostToolUse: [
        { hooks: [wrapContextHook('PostToolUse', onPostToolUse, toAgentToolAuditRecord)] },
      ],
      // `PostToolUse` と `PostToolUseFailure` の片方だけを登録しない: 失敗・中断した道具呼び出しが日誌に1件も残らなくなるため
      PostToolUseFailure: [{ hooks: [wrapToolAuditFailureHook(onPostToolUseFailure)] }],
      PreCompact: [{ hooks: [wrapPreCompactHook(onPreCompact)] }],
      UserPromptSubmit: [{ hooks: [wrapUserPromptSubmitHook(onUserPromptSubmit)] }],
      SubagentStop: [
        {
          timeout: SUBAGENT_STOP_HOOK_TIMEOUT_SECONDS,
          hooks: [wrapContextHook('SubagentStop', onSubagentStop, toAgentSubagentStopRecord)],
        },
      ],
      Stop: [{ hooks: [wrapStopHook(onStop)] }],
    },
  };
}

// `summary` を無上限で運ばない: 日誌・報告本文・台帳のどれかが無制限の英語文言を抱えることになるため
const TASK_NOTIFICATION_SUMMARY_EXCERPT_LIMIT = 500;

export function foldClaudeMessage(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case 'system':
      return foldSystemMessage(message);

    case 'rate_limit_event': {
      const facts = toRateLimitFacts((message as { rate_limit_info?: unknown }).rate_limit_info);
      return facts === undefined ? [] : [{ type: 'rate_limit', facts }];
    }

    case 'stream_event': {
      const text = textDeltaOf((message as { event?: unknown }).event);
      return text === null ? [] : [{ type: 'text_delta', text }];
    }

    case 'assistant': {
      // 本文を載せず印だけを載せる: 本文の取り出し方は層によって違い、表示と報告の作法の側のため
      const errorCode = (message as { error?: unknown }).error;
      const messageId = (message as { uuid?: unknown }).uuid;
      return [
        {
          type: 'assistant_message',
          parentToolUseId: parentToolUseIdOf(message),
          blocks: contentBlocksOf((message as { message?: unknown }).message),
          ...(typeof messageId === 'string' && messageId.length > 0 ? { id: messageId } : {}),
          ...(typeof errorCode === 'string' && errorCode.trim().length > 0 ? { errorCode } : {}),
        },
      ];
    }

    // `tool_result` を含むときだけにする: 人間の発言のエコーや replay（`SDKUserMessageReplay`）を「考え始めた」と読み違えないため
    case 'user': {
      const returned = contentBlocksRaw((message as { message?: unknown }).message).some(
        (block) => (block as { type?: unknown }).type === 'tool_result',
      );
      return returned ? [{ type: 'tool_result' }] : [];
    }

    case 'result': {
      const sessionId = (message as { session_id?: unknown }).session_id;
      // [sdk-verbatim SDKResultSuccess.modelUsage]
      // crash/startup-error results may carry zeroed usage
      // ゼロを「累積が 0 になった」として通さない: 受け取った側の基準が下がり、次に届いた本物の累積が丸ごと増分になるため
      const models = isSuccessResult(message) ? modelUsageOf(message) : undefined;
      // `result.usage` の写しも成功した result だけで絞る: 失敗した result の zero 埋めを運ぶと存在しない消費を観測したことになるため
      const mainLoopUsage = isSuccessResult(message)
        ? mainLoopUsageOf((message as { usage?: unknown }).usage)
        : undefined;
      const body = (message as { result?: unknown }).result;
      const subtype = (message as { subtype?: unknown }).subtype;
      const id = (message as { uuid?: unknown }).uuid;
      const failure = resultFailureOf(message);
      return [
        {
          type: 'turn_ended',
          succeeded: isSuccessResult(message),
          ...(failure === undefined ? {} : { failure }),
          body: typeof body === 'string' ? body : '',
          ...(typeof subtype === 'string' && subtype !== 'success' ? { outcome: subtype } : {}),
          errorLines: resultErrorLines(message),
          ...(models === undefined
            ? {}
            : {
                usage: {
                  models,
                  ...(typeof sessionId === 'string' ? { sessionId } : {}),
                  ...(mainLoopUsage === undefined ? {} : { mainLoopUsage }),
                },
              }),
          ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
          denials: permissionDenialsOf(message).map(toAgentPermissionDenial),
        },
      ];
    }

    default:
      return [];
  }
}

// `usageTotalsSchema` に形を揃えない: `NonNullableUsage` はコストを持たず、台帳の形に寄せると存在しない値を作ることになるため
// 必須欄のどれかが数値でなければ `undefined`: SDK が版で形を変えたと見て作り物を返さないため
function mainLoopUsageOf(raw: unknown): AgentTurnUsage['mainLoopUsage'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const usage = raw as Record<string, unknown>;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheReadInputTokens = usage.cache_read_input_tokens;
  const cacheCreationInputTokens = usage.cache_creation_input_tokens;
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    typeof cacheReadInputTokens !== 'number' ||
    typeof cacheCreationInputTokens !== 'number'
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens };
}

function foldSystemMessage(message: SDKMessage & { type: 'system' }): AgentEvent[] {
  const subtype = (message as { subtype?: unknown }).subtype;

  if (subtype === 'init') {
    return [
      {
        type: 'session_started',
        sessionId: message.session_id,
        runtime: runtimeFactsOf(message),
      },
    ];
  }

  // 生の合図と `result.permission_denials` の両方を読む: `permissionMode: 'auto'` では `canUseTool` が呼ばれず、この合図を捨てると手が止められたことが誰にも見えないが、合図は best-effort で取りこぼしうるため
  if (subtype === 'permission_denied') {
    return [{ type: 'permission_denied', via: 'live', denial: toAgentPermissionDenial(message) }];
  }

  // 読めない形（`trigger` が2値のどちらでもない・`pre_tokens` が数値でない）は0個にする: SDK が版で形を変えたと見て作り物を返さないため
  if (subtype === 'compact_boundary') {
    const metadata = (message as { compact_metadata?: unknown }).compact_metadata;
    if (typeof metadata !== 'object' || metadata === null) return [];
    const trigger = (metadata as { trigger?: unknown }).trigger;
    const preTokens = (metadata as { pre_tokens?: unknown }).pre_tokens;
    const postTokens = (metadata as { post_tokens?: unknown }).post_tokens;
    if ((trigger !== 'manual' && trigger !== 'auto') || typeof preTokens !== 'number') return [];
    return [
      {
        type: 'compaction',
        trigger,
        preTokens,
        ...(typeof postTokens === 'number' ? { postTokens } : {}),
      },
    ];
  }

  // 委譲の区間は「上限の文言」の総取りより手前で見る: 後ろに置くと `task_started` / `task_notification` がそこで無条件に捨てられて二度と読まれないため
  if (subtype === 'task_started' || subtype === 'task_notification') {
    const taskId = (message as { task_id?: unknown }).task_id;
    if (subtype === 'task_started') {
      // 作業者かどうかの判定をここでしない: 判定は `runner.ts` 側が持ち、この層は SDK の綴りを読むだけのため
      const taskType = (message as { task_type?: unknown }).task_type;
      const spawnDepth = (message as { spawn_depth?: unknown }).spawn_depth;
      return [
        {
          type: 'delegation_started',
          ...(typeof taskId === 'string' ? { taskId } : {}),
          ...(typeof taskType === 'string' ? { taskType } : {}),
          ...(typeof spawnDepth === 'number' ? { spawnDepth } : {}),
        },
      ];
    }
    // `summary` は `excerpt()` で切ってから運ぶ: 作業者の打ち切り文言は英語の生文言で長さが読めないため
    const status = (message as { status?: unknown }).status;
    const summary = (message as { summary?: unknown }).summary;
    // 読めなかった `output_file` は省く: 作り物のパスを主張しないため
    const outputFile = (message as { output_file?: unknown }).output_file;
    return [
      {
        type: 'delegation_notified',
        ...(typeof taskId === 'string' ? { taskId } : {}),
        ...(typeof status === 'string' ? { status } : {}),
        ...(typeof summary === 'string'
          ? { summary: excerpt(summary, TASK_NOTIFICATION_SUMMARY_EXCERPT_LIMIT) }
          : {}),
        ...(typeof outputFile === 'string' ? { outputFile } : {}),
      },
    ];
  }

  // `task_progress` / `task_updated` は見ない: 高頻度の進捗 ping と状態遷移の詳細で、ターンの契機にも区間の開閉にも要らないため
  if (subtype === 'task_progress' || subtype === 'task_updated') {
    return [];
  }

  // `background_tasks_changed` を `worker_wait` の区間の開閉に使わない: level 信号で edge と相関させられず、フォアグラウンドのまま終わる委譲は載らないため
  // `tasks` が配列でなければ0個返す: SDK が版で形を変えたと見て、作り物の「0本」を主張しないため
  if (subtype === 'background_tasks_changed') {
    const tasks = liveBackgroundTasksOf(message);
    return tasks === null ? [] : [{ type: 'background_tasks', tasks }];
  }

  const said =
    subtype === 'notification'
      ? (message as { text?: unknown }).text
      : subtype === 'informational'
        ? (message as { content?: unknown }).content
        : undefined;
  if (typeof said !== 'string') return [];
  const notice = classifyUsageNotice(said);
  return notice === undefined ? [] : [{ type: 'usage_notice', notice }];
}

// `typeof` で検査し、読めない形は `null` のままにする: ここで読み違えて例外を投げるとセッションの起動そのものが壊れ、`mcp_servers` も形が読めなかったときに「0本」と主張する根拠が無いため
// `apiKeySource` を素通しにしない: 許可リスト（`toAccountApiKeySource`）を通さないと `self_status` が生の文字列をそのまま出すため
function runtimeFactsOf(message: SDKMessage): AgentRuntimeFacts {
  const raw = message as unknown as {
    session_id?: unknown;
    model?: unknown;
    claude_code_version?: unknown;
    apiKeySource?: unknown;
    permissionMode?: unknown;
    mcp_servers?: unknown;
  };
  return {
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : null,
    model: typeof raw.model === 'string' ? raw.model : null,
    agentVersion: typeof raw.claude_code_version === 'string' ? raw.claude_code_version : null,
    apiKeySource: toAccountApiKeySource(raw.apiKeySource) ?? null,
    permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : null,
    mcpServers: Array.isArray(raw.mcp_servers)
      ? raw.mcp_servers.filter(
          (entry): entry is { name: string; status: string } =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as { name?: unknown }).name === 'string' &&
            typeof (entry as { status?: unknown }).status === 'string',
        )
      : null,
  };
}

// [sdk-verbatim SDKBackgroundTasksChangedMessage.ambient]
// > True for tasks that are not activity (every skip_transcript task, plus every live-update watcher, requested or auto-started); hosts should exclude them from activity indicators.
// `task_type` が文字列でなければ `'(不明)'` を当てる: 欄自体が壊れていても、要素の存在（背景処理が1件在ること）までは捨てないため
function liveBackgroundTasksOf(raw: unknown): readonly { id: string; taskType: string }[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const tasks = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return null;
  const result: { id: string; taskType: string }[] = [];
  for (const entry of tasks) {
    if (typeof entry !== 'object' || entry === null) continue;
    const taskId = (entry as { task_id?: unknown }).task_id;
    if (typeof taskId !== 'string') continue;
    if ((entry as { ambient?: unknown }).ambient === true) continue;
    const taskType = (entry as { task_type?: unknown }).task_type;
    result.push({ id: taskId, taskType: typeof taskType === 'string' ? taskType : '(不明)' });
  }
  return result;
}

function toAgentPermissionDenial(source: unknown): AgentPermissionDenial {
  const denial = source as {
    tool_name?: unknown;
    tool_use_id?: unknown;
    tool_input?: unknown;
    decision_reason?: unknown;
    decision_reason_type?: unknown;
    message?: unknown;
    agent_id?: unknown;
    agent_type?: unknown;
  } | null;
  return {
    ...(typeof denial?.tool_name === 'string' ? { tool: denial.tool_name } : {}),
    ...(typeof denial?.tool_use_id === 'string' && denial.tool_use_id.length > 0
      ? { toolUseId: denial.tool_use_id }
      : {}),
    ...(denial?.tool_input === undefined ? {} : { input: denial.tool_input }),
    ...(typeof denial?.decision_reason === 'string' ? { reason: denial.decision_reason } : {}),
    ...(typeof denial?.decision_reason_type === 'string'
      ? { reasonType: denial.decision_reason_type }
      : {}),
    ...(typeof denial?.message === 'string' ? { message: denial.message } : {}),
    ...(typeof denial?.agent_id === 'string' ? { agentId: denial.agent_id } : {}),
    ...(typeof denial?.agent_type === 'string' ? { agentType: denial.agent_type } : {}),
  };
}

function permissionDenialsOf(message: SDKMessage): unknown[] {
  const denials = (message as { permission_denials?: unknown }).permission_denials;
  return Array.isArray(denials) ? denials.filter((entry) => entry !== null) : [];
}

function parentToolUseIdOf(message: SDKMessage): string | null {
  const value = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof value === 'string' ? value : null;
}

function textDeltaOf(event: unknown): string | null {
  const candidate = event as { type?: string; delta?: { type?: string; text?: unknown } };
  if (candidate.type !== 'content_block_delta') return null;
  if (candidate.delta?.type !== 'text_delta') return null;
  return typeof candidate.delta.text === 'string' ? candidate.delta.text : null;
}

function contentBlocksRaw(message: unknown): unknown[] {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

// `text` でも `tool_use` でもないものを捨てずに `other` として残す: 数と順序が保たれ、層の側が「読み飛ばした塊が在った」ことを見られるため
function contentBlocksOf(message: unknown): AgentContentBlock[] {
  return contentBlocksRaw(message).map((block): AgentContentBlock => {
    const type = (block as { type?: unknown }).type;
    const text = (block as { text?: unknown }).text;
    if (type === 'text' && typeof text === 'string') return { type: 'text', text };
    const name = (block as { name?: unknown }).name;
    if (type === 'tool_use' && typeof name === 'string') return { type: 'tool_use', name };
    return { type: 'other' };
  });
}

import type { AgentToolAuditFailureRecord, AgentToolAuditRecord } from './agent-hooks.js';
import { CODEX_TOOL_ITEM_TYPES, type CodexThreadItem } from './codex-protocol.js';

/**
 * Codex の道具実行 item（`item/completed`）→ 中立のツール監査の記録（#486 M7 S6）。
 *
 * Claude の経路の `PostToolUse` / `PostToolUseFailure`（`agent-hooks.ts`）と同じ記録に揃える。
 * runner が読むのは `toolName` / `toolInput`（日誌の `tool_use`）と、失敗の `error`（note）。
 *
 * - **作り物を出さない。** item が運ばない欄（`transcriptPath` / `effortLevel` / `agentId` /
 *   `toolUseId` 以外）は省く。`toolUseId` は item の id。
 * - **出力本体（`aggregatedOutput` / `diff` / MCP の `result`）は載せない。** 日誌の `tool_use` は
 *   `tool` と `input` しか持たず、出力は鍵・資格を運びうる。終了コードなど小さな事実だけ `toolResponse` へ。
 * - 文字列は呼び出し側が渡す `redact` で伏せる（API キー・環境変数の値）。
 * - `declined`（承認で断った）は道具が走っていない。拒否はクローンへの確認の経路が持つので、
 *   ここでは記録を作らない（`declined` を返す）。
 */

export type CodexToolAudit =
  | { readonly outcome: 'success'; readonly record: AgentToolAuditRecord }
  | { readonly outcome: 'failure'; readonly record: AgentToolAuditFailureRecord }
  | { readonly outcome: 'declined' };

const TOOL_TYPES: ReadonlySet<string> = new Set(CODEX_TOOL_ITEM_TYPES);

/** 道具の実行を表す item か。 */
export function isCodexToolItem(item: { type: string }): boolean {
  return TOOL_TYPES.has(item.type);
}

type Fields = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 値の中の文字列を `redact` に通す（深さは浅い入力だけを想定。深すぎれば切る）。 */
function redactDeep(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (depth >= 6 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, depth + 1));
  const out: Fields = {};
  for (const [key, v] of Object.entries(value)) out[key] = redactDeep(v, redact, depth + 1);
  return out;
}

interface Shape {
  toolName: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  /** `undefined` なら成功。文字列なら失敗の理由。`'declined'` は走っていない。 */
  failure?: string;
  declined?: boolean;
}

function shapeOf(item: Fields): Shape | undefined {
  const status = str(item['status']);
  switch (item['type']) {
    case 'commandExecution': {
      const exitCode = typeof item['exitCode'] === 'number' ? item['exitCode'] : undefined;
      const input: Fields = {};
      if (str(item['command']) !== undefined) input['command'] = item['command'];
      if (str(item['cwd']) !== undefined) input['cwd'] = item['cwd'];
      const shape: Shape = {
        toolName: 'commandExecution',
        toolInput: input,
        ...(exitCode === undefined ? {} : { toolResponse: { exitCode } }),
      };
      if (status === 'declined') return { ...shape, declined: true };
      if (status === 'failed') {
        return {
          ...shape,
          failure: `コマンドが失敗した${exitCode === undefined ? '' : `（終了コード ${exitCode}）`}`,
        };
      }
      if (exitCode !== undefined && exitCode !== 0) {
        return { ...shape, failure: `コマンドが終了コード ${exitCode} で終わった` };
      }
      return shape;
    }
    case 'fileChange': {
      const changes = Array.isArray(item['changes']) ? (item['changes'] as Fields[]) : [];
      const shape: Shape = {
        toolName: 'fileChange',
        // 差分（diff）は載せない。パスと変更の種類だけ。
        toolInput: {
          changes: changes.map((c) => ({
            ...(str(c['path']) === undefined ? {} : { path: c['path'] }),
            ...(c['kind'] === undefined ? {} : { kind: c['kind'] }),
          })),
        },
      };
      if (status === 'declined') return { ...shape, declined: true };
      if (status === 'failed') return { ...shape, failure: 'ファイルの変更が失敗した' };
      return shape;
    }
    case 'mcpToolCall': {
      const error = item['error'];
      const message =
        typeof error === 'object' && error !== null ? str((error as Fields)['message']) : undefined;
      const shape: Shape = {
        // Claude の MCP 道具の綴り（mcp__<server>__<tool>）に揃える。
        toolName: `mcp__${str(item['server']) ?? 'unknown'}__${str(item['tool']) ?? 'unknown'}`,
        ...(item['arguments'] === undefined ? {} : { toolInput: item['arguments'] }),
      };
      if (status === 'failed' || message !== undefined) {
        return { ...shape, failure: message ?? 'MCP 道具の呼び出しが失敗した' };
      }
      return shape;
    }
    case 'dynamicToolCall': {
      const namespace = str(item['namespace']);
      const shape: Shape = {
        toolName: `${namespace === undefined ? '' : `${namespace}.`}${str(item['tool']) ?? 'unknown'}`,
        ...(item['arguments'] === undefined ? {} : { toolInput: item['arguments'] }),
      };
      if (status === 'failed' || item['success'] === false) {
        return { ...shape, failure: '動的な道具の呼び出しが失敗した' };
      }
      return shape;
    }
    case 'collabAgentToolCall': {
      const shape: Shape = {
        toolName: 'collabAgentToolCall',
        toolInput: {
          ...(str(item['tool']) === undefined ? {} : { tool: item['tool'] }),
          ...(str(item['prompt']) === undefined ? {} : { prompt: item['prompt'] }),
        },
      };
      if (status === 'failed') return { ...shape, failure: 'エージェント間の呼び出しが失敗した' };
      if (status === 'interrupted')
        return { ...shape, failure: 'エージェント間の呼び出しが中断された' };
      return shape;
    }
    case 'webSearch':
      return {
        toolName: 'webSearch',
        toolInput: { ...(str(item['query']) === undefined ? {} : { query: item['query'] }) },
      };
    case 'imageView':
      return {
        toolName: 'imageView',
        toolInput: { ...(str(item['path']) === undefined ? {} : { path: item['path'] }) },
      };
    case 'imageGeneration': {
      const shape: Shape = {
        toolName: 'imageGeneration',
        toolInput: {
          ...(str(item['revisedPrompt']) === undefined
            ? {}
            : { revisedPrompt: item['revisedPrompt'] }),
          // 保存先だけ載せる。`result`（画像の中身）は台帳・日誌を膨らませるので載せない。
          ...(str(item['savedPath']) === undefined ? {} : { savedPath: item['savedPath'] }),
        },
      };
      if (item['failure'] != null || status === 'failed') {
        return { ...shape, failure: '画像の生成が失敗した' };
      }
      return shape;
    }
    case 'sleep':
      return {
        toolName: 'sleep',
        toolInput: {
          ...(typeof item['durationMs'] === 'number' ? { durationMs: item['durationMs'] } : {}),
        },
      };
    case 'functionCallOutput': {
      const namespace = str(item['namespace']);
      return {
        toolName: `${namespace === undefined ? '' : `${namespace}.`}${str(item['name']) ?? 'unknown'}`,
      };
    }
    default:
      return undefined;
  }
}

/** 道具の item でなければ `undefined`。 */
export function toCodexToolAudit(
  item: CodexThreadItem,
  redact: (text: string) => string,
): CodexToolAudit | undefined {
  const shape = shapeOf(item as unknown as Fields);
  if (shape === undefined) return undefined;
  if (shape.declined === true) return { outcome: 'declined' };
  const toolUseId = item.id;
  const toolInput =
    shape.toolInput === undefined ? {} : { toolInput: redactDeep(shape.toolInput, redact) };
  if (shape.failure !== undefined) {
    return {
      outcome: 'failure',
      record: {
        toolName: shape.toolName,
        ...toolInput,
        error: redact(shape.failure),
        toolUseId,
      },
    };
  }
  return {
    outcome: 'success',
    record: {
      toolName: shape.toolName,
      ...toolInput,
      ...(shape.toolResponse === undefined ? {} : { toolResponse: shape.toolResponse }),
      toolUseId,
    },
  };
}

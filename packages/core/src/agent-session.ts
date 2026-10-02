/**
 * マネージャーのセッションを動かす「駆動役」の中立の口（#486 段 S4）。
 *
 * **このファイルは Claude Agent SDK のパッケージを import してはいけない**
 * （型も定数も。番人テストは `agent-session.test.ts`）。SDK の `query()` の署名
 * （`AsyncIterable<SDKUserMessage>` + `Options` + `canUseTool` + control request）は
 * Claude 固有の制御モデルであり、これを共通 IF にすると全 provider にその模倣を
 * 強いる。**境界は1ターンぶんのストリームに引く** —— 入力（ユーザーの言葉）を
 * 流し込み、中立の {@link AgentEvent} の流れを読み、止める。それだけである。
 *
 * ## provider ごとの実装の見込み
 *
 * | 口 | Claude（`claude-manager-driver.ts`） | Codex（`codex app-server`。次の段） |
 * | --- | --- | --- |
 * | `open` | `query({ prompt, options })` | 子プロセス起動（stdio JSON-RPC）→ `thread/start` / `thread/resume` |
 * | `input` | SDK がストリームから引く | 引いたものを `turn/start` で送る（ターンの終わりを待ってから次を引く） |
 * | `events` | `foldClaudeMessage` で畳む | item 単位の通知＋差分を `AgentEvent` へ畳む |
 * | `onPermission` | `canUseTool` → `PermissionResult` | `item/commandExecution/requestApproval` 等の server→client request へ応答 |
 * | `contextUsage` / `sessionModelUsage` | control request | トークン数のみ（取れない欄は欄ごと省く） |
 *
 * 持たない能力は申告して出さない（`agent-ports.ts` の `AgentCapabilities`）。
 */

import type { Readable, Writable } from 'node:stream';

import type { AgentEvent } from './agent-events.js';
import type {
  AgentContextHook,
  AgentObservationHook,
  AgentPermissionDeniedHook,
  AgentPreToolHook,
  AgentStopRecord,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
  AgentPreCompactRecord,
  AgentUserPromptSubmitRecord,
} from './agent-hooks.js';
import type { AgentProviderId } from './agent-ports.js';
import type { McpServers } from './mcp-servers.js';
import type { PermissionModeName } from './permission-mode.js';
import type { UsageTotals } from './usage.js';

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

/** マネージャーへ流す1通のユーザー入力（クローン・人間からの一言）。 */
export interface AgentUserInput {
  readonly text: string;
}

// ---------------------------------------------------------------------------
// 許可確認
// ---------------------------------------------------------------------------

/**
 * provider が「この道具の実行を許してよいか」と聞いてきた1件。
 *
 * `kind` は、人間（＝クローン）の判断が要る種類の分け方である。`question` は
 * 質問への回答そのもの（Claude の `AskUserQuestion`）、`permission` は実行の
 * 許可（Codex なら `item/commandExecution/requestApproval` など）。
 */
export interface AgentPermissionRequest {
  /** provider 側の要求 id。再送で同じ id が来たら同じ結果を返すための鍵。無ければ runner が振る。 */
  readonly requestId: string | undefined;
  readonly kind: 'question' | 'permission';
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  /** provider 側が要求を取り下げたとき（中断）に abort される。 */
  readonly signal: AbortSignal;
}

/** {@link AgentPermissionRequest} への答え。provider の許可型への写しは駆動役の中に閉じる。 */
export type AgentPermissionDecision =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string };

export type AgentPermissionHandler = (
  request: AgentPermissionRequest,
) => Promise<AgentPermissionDecision>;

// ---------------------------------------------------------------------------
// 生ログ・子プロセス
// ---------------------------------------------------------------------------

export interface AgentSessionLogKey {
  readonly projectKey: string;
  readonly sessionId: string;
  readonly subpath?: string;
}

/**
 * セッションの生ログの預け先（runner は永続化の器を持たず、デーモンへ流す）。
 * 項目の中身は provider のもので、runner は読まずに運ぶだけである。
 */
export interface AgentSessionLog {
  append(key: AgentSessionLogKey, entries: unknown[]): Promise<void>;
  load(key: AgentSessionLogKey): Promise<unknown[] | null>;
}

export interface AgentSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/** provider の CLI / サーバを別 UID の子プロセスとして起こした実体。 */
export interface AgentChildProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  readonly pid?: number;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}

/** 何を起こすか（command / args）は駆動役が決め、**誰として起こすか**だけを runner が決める。 */
export type AgentSpawnProcess = (options: AgentSpawnOptions) => AgentChildProcess;

// ---------------------------------------------------------------------------
// 観測
// ---------------------------------------------------------------------------

/** 文脈の使用状況。provider が持たない欄は欄ごと省く。 */
export interface AgentContextUsage {
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  autoCompactThreshold?: number;
  isAutoCompactEnabled: boolean;
  categories?: readonly {
    name: string;
    tokens: number;
    kind: 'used' | 'free' | 'buffer' | 'deferred';
  }[];
  mcpTools?: readonly { tokens: number }[];
  memoryFiles?: readonly { tokens: number }[];
  systemPromptSections?: readonly { tokens: number }[];
}

// ---------------------------------------------------------------------------
// 駆動役
// ---------------------------------------------------------------------------

/** 開いたセッション1本。 */
export interface AgentManagerSession {
  /**
   * 中立イベントを1件ずつ `onEvent` へ渡し、**`onEvent` が返るのを待ってから**次を
   * 読む（背圧）。provider が閉じると resolve、落ちる・`onEvent` が投げると reject。
   * 呼び出しは1セッションにつき1回。
   *
   * 引く形（`AsyncIterable`）ではなくこの形にしてあるのは、async generator の層が
   * 挟まると「1イベントを適用し終えてから次を引くまで」のマイクロタスクの段数が
   * 増え、既存テストの fake が前提にしている競合の窓が動くためである（挙動不変）。
   */
  readEvents(onEvent: (event: AgentEvent) => Promise<void>): Promise<void>;
  /** 止める。既に閉じていても投げない／投げても呼び出し側が飲む。 */
  close(): void;
  /** 文脈の使用状況（best-effort。失敗は reject）。 */
  contextUsage(): Promise<AgentContextUsage>;
  /** 累積のモデル別使用量（best-effort。取れなければ `undefined`）。 */
  sessionModelUsage(): Promise<Record<string, UsageTotals> | undefined>;
}

/** マネージャーのセッションを開くときの材料（provider に依らない語彙だけ）。 */
export interface AgentManagerSessionSpec {
  /** 開き直す前のセッション id。 */
  resume?: string;
  /** ユーザー入力のストリーム。provider が引いたぶんだけ消費される。 */
  input: AsyncIterable<AgentUserInput>;
  model: string;
  permissionMode: PermissionModeName;
  systemPromptAppend: string;
  workerAgentName: string;
  workerPrompt: string;
  workerModel: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  managerAutoMemoryEnabled: boolean;
  mcpServers?: McpServers;
  sessionLog: AgentSessionLog;
  /** 無ければ子プロセスを降ろさない（既定の起こし方）。 */
  spawnProcess?: AgentSpawnProcess;
  onPermission: AgentPermissionHandler;
  onPreToolUse: AgentPreToolHook;
  onPermissionDenied: AgentPermissionDeniedHook;
  onPostToolUse: AgentContextHook<AgentToolAuditRecord>;
  onPostToolUseFailure: AgentObservationHook<AgentToolAuditFailureRecord>;
  onPreCompact: AgentObservationHook<AgentPreCompactRecord>;
  onUserPromptSubmit: AgentObservationHook<AgentUserPromptSubmitRecord>;
  onSubagentStop: AgentContextHook<AgentSubagentStopRecord>;
  onStop: AgentObservationHook<AgentStopRecord>;
}

/** provider ごとの実装。この段では Claude だけ（`claude-manager-driver.ts`）。 */
export interface AgentManagerDriver {
  readonly providerId: AgentProviderId;
  open(spec: AgentManagerSessionSpec): AgentManagerSession;
}

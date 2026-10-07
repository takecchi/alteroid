/**
 * クローンの harness セッションを動かす「駆動役」の中立の口（#486 M7 の前段）。
 *
 * マネージャー側の {@link AgentManagerDriver}（`agent-session.ts`）と対になる。
 * 境界の引き方は同じ — **1ターンぶんのストリームに引く**。入力（ユーザーの言葉）を流し込み、
 * 中立の {@link AgentEvent} の流れを読み、止める。provider ごとの綴り（SDK の
 * `query()`・`Options`・メッセージの畳み込み）は駆動役の中に閉じる。
 *
 * **このファイルは Claude Agent SDK のパッケージを import してはいけない**（型も定数も。
 * 番人テストは `agent-clone-session.test.ts`）。
 *
 * ## 構造だけの切り出しである
 *
 * この口を足した PR は挙動を1つも変えていない（`clone-driver-options.test.ts` が
 * `query()` へ渡る `Options` を切り出し前後で固定している）。**「無駄な間接層だ」と
 * 思って `clone.ts` へ戻さないこと** — 戻すと、クローンを Claude 以外の provider
 * （`codex app-server`）で動かすときに `clone.ts`（約1.3万行）の中の `query()` 呼びを
 * 1つずつ掘り出すことになる。`architecture.md`「境界は2つ要る」の、クローン側の1本目である。
 *
 * ## マネージャーの口と違う点
 *
 * - **許可確認（`onPermission`）が無い。** クローンの許可は `permissionMode` と
 *   `PreToolUse` フックで決まり、`canUseTool` を渡していない。
 * - **道具は {@link AgentCloneTools}。** クローンの道具は自分のプロセスの中の MCP サーバで、
 *   Claude ならそのインスタンスをそのまま SDK へ渡す（`inproc`）。別の provider は
 *   stdio の中継（`stdio`。`clone-tools-transport.ts`）越しにしか呼べない。
 * - **蒸留のサイドクエリは任意の能力（{@link AgentCloneDriver.distill}）。** 持たない駆動役は
 *   申告して出さない。
 */

import type { AgentEvent } from './agent-events.js';
import type {
  AgentObservationHook,
  AgentPreCompactRecord,
  AgentPreToolHook,
  AgentSubagentStopRecord,
  AgentToolAuditFailureRecord,
  AgentToolAuditRecord,
} from './agent-hooks.js';
import type { AgentProviderId } from './agent-ports.js';
import type { AgentContextUsage, AgentSessionLog, AgentUserInput } from './agent-session.js';
import type { McpServers } from './mcp-servers.js';
import type { PermissionModeName } from './permission-mode.js';
import type { UsageTotals } from './usage.js';

/**
 * クローンの道具（記憶・日誌・台帳…を叩く MCP サーバ）を provider へどう渡すか。
 *
 * - `inproc`: 同じプロセスの中の MCP サーバ。`server` は**不透明な持ち手**で、中身を読めるのは
 *   それを作った側と同じ provider の駆動役だけである（Claude はそのまま SDK へ渡す）。
 * - `stdio`: 子プロセスとして起こせる形。Claude 以外の provider はこちらしか取れない。
 */
export type AgentCloneTools =
  | { readonly kind: 'inproc'; readonly server: unknown }
  | {
      readonly kind: 'stdio';
      readonly command: string;
      readonly args: string[];
      readonly env: Record<string, string>;
    };

/** 展開済みの plugin 1つ（provider に依らない語彙。`path` は展開先の絶対パス）。 */
export interface AgentClonePlugin {
  path: string;
  /** 真なら plugin の `.mcp.json` を読ませない。 */
  skipMcpDiscovery: boolean;
}

/** クローンのセッションを開くときの材料（provider に依らない語彙だけ）。 */
export interface AgentCloneSessionSpec {
  /** 開き直す前のセッション id。無ければ `null`。 */
  resume: string | null;
  /** ユーザー入力のストリーム。provider が引いたぶんだけ消費される。 */
  input: AsyncIterable<AgentUserInput>;
  model: string;
  /**
   * `model` を人間が置いたか（`ALTEROID_CLONE_MODEL`）。`model` は置かなくても既定の帯
   * （Claude のエイリアス）が入るので、**Claude 以外の駆動役は、これが真のときだけ `model` を
   * provider へ渡す**（マネージャー側の `AgentManagerSessionSpec.modelPlaced` と同じ）。省略は偽。
   */
  modelPlaced?: boolean;
  permissionMode: PermissionModeName;
  tools: AgentCloneTools;
  /** 人間の MCP 連携の登録（クローンの道具とは別）。 */
  externalMcpServers: McpServers;
  /** 展開済みの plugin。省略・空なら渡さない。Codex の駆動役は渡さない（note を残す）。 */
  plugins?: readonly AgentClonePlugin[];
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * 駆動役が「取れなかった」「渡していない」等を、失敗として数えさせずに残す口（日誌）。
   * 省略時は捨てる。**本文に秘密を載せないこと**（駆動役が伏せてから渡す）。
   */
  onNote?: (text: string) => void;
  /** 生ログの預け先。無ければローカルに置く。 */
  sessionLog?: AgentSessionLog;
  onPreToolUse: AgentPreToolHook;
  onPreCompact: AgentObservationHook<AgentPreCompactRecord>;
  onPostToolUse: AgentObservationHook<AgentToolAuditRecord>;
  onPostToolUseFailure: AgentObservationHook<AgentToolAuditFailureRecord>;
  onSubagentStop: AgentObservationHook<AgentSubagentStopRecord>;
}

/** 開いたクローンのセッション1本。 */
export interface AgentCloneSession {
  /**
   * 中立イベントを1件ずつ `onEvent` へ渡し、**`onEvent` が返るのを待ってから**次を読む（背圧）。
   * provider が閉じると resolve、落ちる・`onEvent` が投げると reject。1セッションにつき1回。
   */
  readEvents(onEvent: (event: AgentEvent) => Promise<void>): Promise<void>;
  /** 走っているターンを止める（セッションは残る）。失敗は reject。戻り値は読まない（provider の応答をそのまま返してよい）。 */
  interrupt(): Promise<unknown>;
  /** 畳む。既に閉じていれば投げるかもしれない（呼び出し側が飲む）。 */
  close(): void;
  /** 文脈の使用状況（best-effort。失敗は reject）。 */
  contextUsage(): Promise<AgentContextUsage>;
  /** 累積のモデル別使用量（best-effort。取れなければ `undefined`）。 */
  sessionModelUsage(): Promise<Record<string, UsageTotals> | undefined>;
}

/** 蒸留のサイドクエリ（本セッションとは別の短命セッション）の材料。 */
export interface AgentCloneDistillSpec {
  prompt: string;
  model: string;
  permissionMode: PermissionModeName;
  tools: AgentCloneTools;
  externalMcpServers: McpServers;
  /** 本セッションと同じもの（`AgentCloneSessionSpec.plugins`）。 */
  plugins?: readonly AgentClonePlugin[];
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onPostToolUse: AgentObservationHook<AgentToolAuditRecord>;
  onPostToolUseFailure: AgentObservationHook<AgentToolAuditFailureRecord>;
}

/** provider ごとの実装。`claude-clone-driver.ts` と `codex-clone-driver.ts`。 */
export interface AgentCloneDriver {
  readonly providerId: AgentProviderId;
  /**
   * クローンの道具をこの経路でしか受け取れない、と言う駆動役が定義する（Codex は別プロセスなので
   * `stdio` の中継越しだけ）。**無ければ `ALTEROID_CLONE_TOOLS_TRANSPORT` に従う**（Claude）。
   */
  readonly requiredToolsTransport?: 'stdio';
  /**
   * `false` なら、この駆動役は文脈の使用状況（`contextUsage()`）を**原理的に出せない**
   * （Codex）。`clone.ts` は毎ターン聞いて毎ターン error 付きの `context_usage` 行を書く代わりに、
   * **最初の1回だけ「取れない」と残し**、以後は聞かない（観測していない扱い）。無ければ従来どおり
   * 毎ターン聞く（Claude）。
   */
  readonly providesContextUsage?: false;
  open(spec: AgentCloneSessionSpec): AgentCloneSession;
  /**
   * 蒸留のサイドクエリを起こし、中立イベントの流れを返す（呼んだ時点で起こす）。
   *
   * **持たない駆動役は定義しない（`undefined`）。** 呼び出し側（`clone.ts`）はこれを見て、
   * 蒸留が使えるかを知る。サイドクエリは本セッションと違い、`result` の消費を
   * `oneshot` で数える別の経路なので、provider の本セッションの口とは分けてある。
   */
  readonly distill?: (spec: AgentCloneDistillSpec) => AsyncIterable<AgentEvent>;
}

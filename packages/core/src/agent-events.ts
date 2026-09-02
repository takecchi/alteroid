/**
 * provider のメッセージを写した先の語彙（読み側の中立化。#486 の47行目）。
 *
 * ## この語彙が要る理由
 *
 * クローンとマネージャーは、**同じ provider のメッセージをそれぞれ別々に読んで
 * いた** — `clone.ts` の `#dispatch` と `runner.ts` の `#dispatch` である。どちらも
 * 「SDK の綴りを見て何が起きたかを決める」判断を持っており、provider を足すと
 * その判断が provider の数だけ分裂する（#486 本文「読み側の中立化が無ければ
 * 2つ目の provider は載らない」）。
 *
 * **だから畳み込みを2段に割る。**
 *
 * | 段 | 何を決めるか | 置き場所 |
 * | --- | --- | --- |
 * | (i) 読み取りの判断 | provider の綴りを見て「何が起きたか」を決める | provider ごとに1本（Claude は `claude-provider.ts` の `foldClaudeMessage`） |
 * | (ii) 起きたことへの反応 | 日誌・台帳・受信箱・画面・ターンの終端 | 層ごと（`clone.ts` / `runner.ts` の `#apply`） |
 *
 * **(ii) を1本にはしない。** 2つの層が畳み込みの中で呼んでいる副作用は
 * 15種あり、名前が重なるのは2種だけである（残り13種は片方にしかない）。
 * 「全 provider 共通の1本」にできるのは (i) であって (ii) ではない。
 *
 * ## この語彙は既存の2語彙を置き換えない
 *
 * `RunnerEvent`（`runner-protocol.ts`）と `ChatStreamEvent`（`schema.ts`）は
 * **出口として据え置く。** どちらも別々の契約面に載っているためである —— 前者は
 * runner とデーモンが別々にデプロイされる窓を跨ぐ層の契約で、後者は
 * `apps/daemon/openapi.json` に8枝が全部インラインで出ている外向きの HTTP 面
 * である。**この語彙へ寄せるとその2つのどちらかが壊れる。** ここは入口
 * （provider から入ってくる側）だけを担い、出口は層がそれぞれ組み立てる。
 *
 * ```
 * provider のメッセージ → [fold] → AgentEvent → [clone.ts  #apply] → ChatStreamEvent ＋ 層固有の副作用
 *                                            → [runner.ts #apply] → RunnerEvent     ＋ 層固有の副作用
 * ```
 *
 * ## ⛔ このファイルは Claude Agent SDK を import してはいけない
 *
 * `agent-ports.ts` と同じ理由である（番人テストは `agent-events.test.ts` に
 * ある）。ここに SDK の型が1つでも漏れると、次の provider を足すときに
 * 「Claude の形に似せて作る」以外の選択肢が無くなる。
 *
 * **ただし「1つも import していない」と言えるのはこのファイル自身についてだけ
 * である。** 下で名指ししている `SdkFailure` / `UsageLimitNotice` /
 * `RateLimitFacts` / `UsageTotals` は zod 由来の中立な形だが、それらを定義して
 * いる `sdk-failure.ts` と `usage-limits.ts` は SDK を import している
 * （前者は型、後者は上限文言の定数）。**型は `import type` なので実行時には何も
 * 引かないが、依存の連鎖としては残っている。**
 */

import type { SdkFailure } from './sdk-failure.js';
import type { RateLimitFacts, UsageLimitNotice } from './usage-limits.js';
import type { UsageTotals } from './usage.js';

/**
 * provider がセッションの頭で名乗った実行時の事実。
 *
 * **読めなかった欄は `null` にする（作り物を出さない）。** 「まだ分からない」と
 * 「そういう値だった」を区別する（`clone.ts` の `#captureInitFacts` の doc、#324）。
 */
export interface AgentRuntimeFacts {
  /** provider 側のセッション id。 */
  sessionId: string | null;
  /** provider が実際に解決したモデル id（宣言した帯ではない）。 */
  model: string | null;
  /** provider の実装の版（Claude では `claude_code_version`）。 */
  agentVersion: string | null;
  /** 資格情報の出どころ（Claude では `apiKeySource`）。 */
  apiKeySource: string | null;
  /** provider が実際に効かせている権限モード。 */
  permissionMode: string | null;
  /** 繋がった MCP サーバ。**読めなければ `null`（`[]` ではない）。** */
  mcpServers: Array<{ name: string; status: string }> | null;
}

/**
 * 確認へ上げずに止められた1件。
 *
 * **欄はすべて任意である。** provider が名乗らなかったものは作り物を出さずに
 * 省く（`runner.ts` / `clone.ts` の `#noteDenial` が既に採っている作法をその
 * まま語彙の側へ持ち上げた形）。**代用値をここで埋めないこと** —— 道具名が
 * 無いときに何と書くか、id が無いときに何で代用するかは層ごとに違う
 * （＝ (ii) の側の判断であって、読み取りの判断ではない）。
 */
export interface AgentPermissionDenial {
  /** 止められた道具の名前。 */
  tool?: string;
  /** その実行の id（二重に記録しないための鍵）。 */
  toolUseId?: string;
  /** 実行しようとした入力。**`via: 'live'` では原理的に付かない。** */
  input?: unknown;
  /** 止めた理由。**`via: 'result'` では必ず欠ける。** */
  reason?: string;
  /** 理由の分類。**`via: 'result'` では必ず欠ける。** */
  reasonType?: string;
  /** モデルへ返した拒否文。**`via: 'result'` では必ず欠ける。** */
  message?: string;
  /**
   * どの層の手だったか。**`via: 'result'` では原理的に存在しない** ——
   * 「本体だった」と決めつけず、取れなかったこととして扱う。
   */
  agentId?: string;
  /** 作業者の型名。**いまのところ provider はこの欄を持たない。** */
  agentType?: string;
}

/** 応答メッセージの中身。**provider の綴りではなく、この3種に畳んである。** */
export type AgentContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string }
  /** text でも tool_use でもない塊（読み飛ばす側が「在った」ことだけ分かる）。 */
  | { type: 'other' };

/** 台帳へ積める、このターンぶんの消費。 */
export interface AgentTurnUsage {
  /** モデル id → 累積（`usage.ts` の `modelUsageOf`）。 */
  models: Record<string, UsageTotals>;
  /** provider がこの結果に添えたセッション id。無ければ省く。 */
  sessionId?: string;
  /**
   * `result.usage`（メインループだけの生の消費。`modelUsage` とは別物）。
   * **台帳には使わない** —— 何のために運ぶか・いつ落としてよいかは
   * `schema.ts` の `turn_usage.mainLoopUsage` の doc に書いた（二重管理を
   * 避けるためここには書き写さない）。読み取れなかった・失敗した result では省く。
   */
  mainLoopUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

/** セッションが開いた。 */
export interface AgentSessionStarted {
  type: 'session_started';
  sessionId: string;
  runtime: AgentRuntimeFacts;
}

/**
 * 確認へ上げずに止められた1件（走行中の合図）。
 *
 * **ターンの終わりに来る authoritative な記録のほうは
 * {@link AgentTurnEnded.denials} に載る。** 別の枝にしていないのは、層が
 * 「消費を積む前に読むか後に読むか」を自分で決めているからである（そこは
 * (ii) の側で、揃えると日誌へ書く順が変わる）。
 */
export interface AgentPermissionDeniedEvent {
  type: 'permission_denied';
  via: 'live';
  denial: AgentPermissionDenial;
}

/** provider が本文として出した上限の合図（`usage-limits.ts` が分類済み）。 */
export interface AgentUsageNoticeEvent {
  type: 'usage_notice';
  notice: UsageLimitNotice;
}

/** 枠の事実（アカウント単位）。**ターンの頭ごとに来る。** */
export interface AgentRateLimitEvent {
  type: 'rate_limit';
  facts: RateLimitFacts;
}

/** 逐次配信の1片。 */
export interface AgentTextDelta {
  type: 'text_delta';
  text: string;
}

/** モデルが何か言った（作業者の発言を含む —— 層が `parentToolUseId` で切る）。 */
export interface AgentAssistantMessage {
  type: 'assistant_message';
  /** 作業者（委譲の中）の発言なら親の道具 id。本体の発言なら `null`。 */
  parentToolUseId: string | null;
  blocks: readonly AgentContentBlock[];
  /** provider がこのメッセージに払った id。無ければ `undefined`（新しく振らない）。 */
  id?: string;
  /**
   * **provider 自身が「これは応答ではない」と付けた印。** 支出上限・枠・認証の
   * 失敗はここへ来る（`sdk-failure.ts`）。本文をどう取り出して添えるかは層が
   * 決めるので、ここには印だけを載せる。
   */
  errorCode?: string;
}

/** 道具の結果が返った ＝ 実行は終わり、モデルが次を考え始めた。 */
export interface AgentToolResult {
  type: 'tool_result';
}

/** 委譲が始まった。 */
export interface AgentDelegationStarted {
  type: 'delegation_started';
  /** provider が名乗った委譲の id。**無ければ省く**（代用値は層が作る）。 */
  taskId?: string;
}

/** 委譲から完了の通知が来た。 */
export interface AgentDelegationNotified {
  type: 'delegation_notified';
  taskId?: string;
}

/**
 * 背景タスクの在り高が変わった（level 信号。**REPLACE 意味論**）。
 *
 * SDK の `SDKBackgroundTasksChangedMessage` の JSDoc から逐語で引く
 * （version 0.3.258 同梱の `sdk.d.ts`。**この番人テスト
 * （`agent-events.test.ts`）自身が SDK パッケージ名の文字列をここへ書く
 * ことを禁じているので、パッケージ名は書かない** — 版番号だけを残す）:
 *
 * > consumers that only need 'is background work running' should replace
 * > their set with each payload rather than pairing edges, so a missed
 * > bookend cannot wedge a stale running indicator
 *
 * **`tasks` は非 ambient のものだけ。** 同じ JSDoc の `ambient` の欄も逐語で
 * 引く: 「True for housekeeping tasks the CLI does not surface as user
 * work … hosts should exclude them from activity indicators.」
 *
 * **この事実が答える問いは、`claude-provider.ts` の `task_progress` /
 * `task_updated` が「見ないと決めてある」と言っている問いとは別である。**
 * あちらは「`worker_wait` の区間の開閉に使えるか」を問い、答えは「使えない」
 * だった（level 信号なので edge と相関させるな・フォアグラウンドのまま
 * 終わる委譲はここに載らない、と SDK 自身が言っている）。**この事実が
 * 答えるのは「いま起こしっぱなしの背景処理が在るか」で、level 信号である
 * ことはこちらの問いには効かない**（REPLACE 意味論をそのまま「いまの
 * 在り高」として使えばよい）。
 */
export interface AgentBackgroundTasksEvent {
  type: 'background_tasks';
  tasks: readonly { id: string; taskType: string }[];
}

/**
 * compaction が1回起きた（`SDKCompactBoundaryMessage.compact_metadata` の
 * 写し）。**ターンの終わり（{@link AgentTurnEnded}）とは別のメッセージとして
 * ターンの途中で届く。** 何のために拾うか・層がどう保持するかは
 * `schema.ts` の `turn_usage.compactions` の doc に書いた（二重管理を避ける
 * ためここには書き写さない）。
 */
export interface AgentCompactionEvent {
  type: 'compaction';
  trigger: 'manual' | 'auto';
  preTokens: number;
  /** **`post_tokens` が省かれた回は無い**（provider 側で optional のため）。 */
  postTokens?: number;
}

/** ターンが終わった。 */
export interface AgentTurnEnded {
  type: 'turn_ended';
  /**
   * **台帳へ通してよい成功か**（`usage.ts` の `isSuccessResult`）。
   * {@link failure} と問いが違うので別の欄にしてある（`sdk-failure.ts` の表）。
   */
  succeeded: boolean;
  /**
   * **応答として扱えない印**（`sdk-failure.ts` の `resultFailureOf`）。
   * `undefined` なら答えとして扱ってよい。
   */
  failure?: SdkFailure;
  /** provider が返した本文そのまま。無ければ空文字。 */
  body: string;
  /**
   * 成功以外で終わったときに provider が名乗った終わり方の語。成功なら
   * `undefined`。**言い換えない** —— 人間が provider の型定義で引ける語のまま残す。
   */
  outcome?: string;
  /** 失敗の行（`sdk-failure.ts` の `resultErrorLines`）。 */
  errorLines: readonly string[];
  /** **{@link succeeded} かつ provider が消費を報告したときだけ在る。** */
  usage?: AgentTurnUsage;
  /** provider がこの結果に払った id。無ければ `undefined`（新しく振らない）。 */
  id?: string;
  /** authoritative な拒否の記録。無ければ空。 */
  denials: readonly AgentPermissionDenial[];
}

/**
 * provider のメッセージ1件を写した中立イベント。
 *
 * **1件が0個以上のイベントになる**（provider が「見ないと決めた」種類は0個、
 * 1件の中に複数の事実が載ることもある）。
 */
export type AgentEvent =
  | AgentSessionStarted
  | AgentPermissionDeniedEvent
  | AgentUsageNoticeEvent
  | AgentRateLimitEvent
  | AgentTextDelta
  | AgentAssistantMessage
  | AgentToolResult
  | AgentDelegationStarted
  | AgentDelegationNotified
  | AgentBackgroundTasksEvent
  | AgentCompactionEvent
  | AgentTurnEnded;

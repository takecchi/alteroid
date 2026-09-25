/**
 * 「中立の口」に向けた最初の一歩（Issue #486）。ツール監査フックの中立の語彙。
 *
 * ## この語彙が要る理由
 *
 * `claude-provider.ts` の3つの Request 型（`CloneSessionOptionsRequest` /
 * `CloneDistillOptionsRequest` / `ManagerSessionOptionsRequest`）は、SDK の
 * `HookCallback` を欄の型としてそのまま持っている。**その欄を埋める関数
 * （`clone.ts` / `runner.ts` のハンドラ）は、SDK の入力（`tool_name` などの
 * snake_case）を直接読んでいる。** これは「provider の形の知識を外へ漏らさ
 * ない」（AGENTS.md「実装の前提」）に反する——次の provider を足すとき、
 * 同じ形のフック入力を持たない provider は、この欄を埋められない。
 *
 * **この PR の範囲は `PostToolUse` / `PostToolUseFailure` の2本だけ**
 * （19個の SDK 型の欄のうち13個が `HookCallback` で、そのうち最大の内訳が
 * この2本の3 Request 型ぶんである）。他のフック（`PreToolUse` /
 * `PreCompact` / `UserPromptSubmit` / `SubagentStop` / `Stop`）は次の PR 群
 * に残す。
 *
 * ## 観測専用のフックだけを対象にする
 *
 * ここに置く2つの記録型は、**判断を返さないフック**の入力を写す。
 * `clone.ts` 側（本セッション・蒸留の両方）の `PostToolUse` /
 * `PostToolUseFailure` ハンドラは、実装を読むと常に `{ continue: true }`
 * だけを返す——観測（日誌へ残す・`effort` や生ログの場所を控える）しか
 * していない。
 *
 * **`runner.ts` 側の `PostToolUse` は対象外である。** `#onPostToolUse` は
 * `#annotateCutOffWorkers` の結果を `hookSpecificOutput.additionalContext`
 * として返す経路を持ち、これは「起きたことをただ記録する」を超えた判断
 * （モデルへ追加の文脈を注ぎ込むかどうか）である。`ManagerSessionOptionsRequest`
 * の `onPostToolUse` 欄は、このため今回は `HookCallback` のまま残す
 * （`claude-provider.ts` の同欄の doc に理由を書いてある）。**`runner.ts` 側の
 * `PostToolUseFailure`（`#onPostToolUseFailure`）は `{ continue: true }` だけ
 * を返すので、こちらは対象に含む。**
 *
 * ## 欄は「いま実際に読まれているもの」だけ
 *
 * 新しい語彙を作らない——`clone.ts` の `#journalToolUse` /
 * `#journalToolUseFailure` / `cloneToolActor` と `runner.ts` の
 * `#onPostToolUseFailure` が実際に読んでいる欄だけを、同じ意味のまま
 * camelCase へ写した。SDK の snake_case な入力からこの形へ写す処理
 * （`toAgentToolAuditRecord` / `toAgentToolAuditFailureRecord`）は
 * `claude-provider.ts` 側に置く——ここは「届いた後の形」だけを知っている。
 *
 * ## ⛔ このファイルは Claude Agent SDK を import してはいけない
 *
 * `agent-events.ts` / `agent-ports.ts` と同じ理由である（番人テストは
 * `agent-hooks.test.ts` にある）。ここに SDK の型が1つでも漏れると、次の
 * provider を足すときに「Claude の形に似せて作る」以外の選択肢が無くなる。
 */

/**
 * `PostToolUse`（道具の実行が成功して返ってきた）1件の中立の記録。
 *
 * **すべて任意である。** provider が名乗らなかった・読めなかった欄は
 * 作り物を出さずに省く（`agent-events.ts` の `AgentPermissionDenial` の doc
 * と同じ作法）。
 */
export interface AgentToolAuditRecord {
  /** 呼ばれた道具の名前。読めなければ省く（`clone.ts` の `UNKNOWN_TOOL_NAME` で代用するのは層の側の仕事）。 */
  toolName?: string;
  /** 道具へ渡した入力。 */
  toolInput?: unknown;
  /** 道具が返した結果（自作ツールの入力検証落ちの検出にも使う）。 */
  toolResponse?: unknown;
  /** provider 側の生ログ（transcript）の置き場所。 */
  transcriptPath?: string;
  /** いまのターンに効いている reasoning effort の水準（`self_status` の材料）。 */
  effortLevel?: string;
  /** 呼び出しが作業者（サブエージェント）からのものだったときの id。本体の呼び出しなら省く。 */
  agentId?: string;
  /** 作業者の型名。**`agentId` が無ければ意味を持たない。** */
  agentType?: string;
}

/**
 * `PostToolUseFailure`（道具の実行が失敗・中断した）1件の中立の記録。
 *
 * **`AgentToolAuditRecord` と欄の意味は揃えてある**（同じ道具呼び出しの
 * 表裏——`PostToolUse` とは排他で発火する。`claude-provider.ts` の
 * `onPostToolUseFailure` の doc）。**`toolResponse` は持たない** — SDK の
 * `PostToolUseFailureHookInput` 自体がこの欄を運ばない（`runner.ts` の
 * `#onPostToolUseFailure` の doc「`#recordBackgroundTaskOwner` を呼ばない
 * 理由」で実測済み）。
 */
export interface AgentToolAuditFailureRecord {
  /** 呼ばれた道具の名前。読めなければ省く。 */
  toolName?: string;
  /** 道具へ渡した入力。 */
  toolInput?: unknown;
  /** provider 側の生ログ（transcript）の置き場所。 */
  transcriptPath?: string;
  /** いまのターンに効いている reasoning effort の水準。 */
  effortLevel?: string;
  /** 呼び出しが作業者（サブエージェント）からのものだったときの id。本体の呼び出しなら省く。 */
  agentId?: string;
  /** 作業者の型名。**`agentId` が無ければ意味を持たない。** */
  agentType?: string;
  /** 失敗の理由（provider が返した自由文）。読めなければ省く。 */
  error?: string;
  /** 中断（キャンセル）によって終わった呼び出しか。省かれていれば「分かっていない」——中断ではないと確定しているのではない（`clone.ts` の `#journalToolUseFailure` の同じ判断）。 */
  isInterrupt?: boolean;
}

/**
 * 観測専用フックの中立の関数型。
 *
 * **判断を返さない。** `void` しか返せないので、この型を欄に持つ Request は
 * 「このフックはモデルの挙動を左右しない」と型で言っている——`PreToolUse`
 * のように `permissionDecision` を返すフックはこの型に載せない
 * （載せてよい条件・載せない理由は上のファイル doc を見よ）。
 */
export type AgentObservationHook<T> = (record: T) => void | Promise<void>;

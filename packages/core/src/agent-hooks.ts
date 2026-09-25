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
 * **1本目の PR（#1527）の範囲は `PostToolUse` / `PostToolUseFailure` の
 * 2本だけだった**（19個の SDK 型の欄のうち13個が `HookCallback` で、その
 * うち最大の内訳がこの2本の3 Request 型ぶんである）。**2本目の PR
 * （#486 中立の口の2本目）では、残りのうち観測専用と確かめられたもの
 * ——`PreCompact`（クローン・マネージャー）/ `UserPromptSubmit` /
 * `Stop`（どちらもマネージャー）——を足した。** `PreToolUse`（判断を返す
 * 唯一のフック）と `runner.ts` 側の `PostToolUse`（下の理由で対象外）は
 * そのとき触っていない。**`SubagentStop` も対象外にした** — 見た目の doc・
 * コメントは「観測専用」と名乗っていたが、`runner.ts` の `#onSubagentStop`
 * の実装を読むと `remaining.length > 0` かつ `shouldWake` が立った回に
 * `hookSpecificOutput.additionalContext` を返し、作業者を実際に起こし直す
 * （PR #594 で観測専用にしたのを、後の PR が判断つきへ戻した——同ファイルの
 * `#onSubagentStop` の doc 内「⚠️ ここは観測専用ではない」が経緯を持つ）。
 * ⟹ **doc やコメントの「観測専用」という自己申告を鵜呑みにせず、実装の
 * 返り値を読んで確かめること。**
 *
 * **この3本目の PR（#486 中立の口の3本目）で `PreToolUse` を足す。**
 * `clone.ts` の `#onPreToolUse`（人間が承認した Bash 許可に一致したら
 * `allow`。Issue #863）と `runner.ts` の `#onPreToolUse`
 * （`bash-wait-guard.ts` が「無限に待つだけの形」と判定したら `deny`。
 * Issue #894）は、どちらも `PostToolUse` 等とは違って**実際に判断を返す**
 * ——`AgentObservationHook`（`void` しか返せない）には載らない。だから
 * 判断を運べる専用の型（{@link AgentPreToolDecision}）を別に起こす。
 * `runner.ts` 側の `PostToolUse`（`#onPostToolUse` の doc）と
 * `SubagentStop`（`#onSubagentStop` の doc）は、このため今回も対象外に
 * 残す——次の PR に送る（#486）。
 *
 * ## 観測専用のフックだけを対象にする（`PreToolUse` を除く）
 *
 * ここに置く記録型のうち、`AgentToolAuditRecord` / `AgentToolAuditFailureRecord` /
 * `AgentPreCompactRecord` / `AgentUserPromptSubmitRecord` / `AgentStopRecord` は
 * **判断を返さないフック**の入力を写す。`clone.ts` 側（本セッション・蒸留の
 * 両方）の `PostToolUse` / `PostToolUseFailure` ハンドラは、実装を読むと常に
 * `{ continue: true }` だけを返す——観測（日誌へ残す・`effort` や生ログの
 * 場所を控える）しかしていない。`clone.ts` / `runner.ts` の `PreCompact`、
 * `runner.ts` の `UserPromptSubmit` / `Stop` も同様に、実装のすべての分岐で
 * `{ continue: true }` だけを返すことを確かめてある。**`AgentPreToolRecord` /
 * `AgentPreToolDecision` はこの限りではない** — 上の「この3本目の PR」の節を
 * 見よ。
 *
 * **`runner.ts` 側の `PostToolUse` は対象外である。** `#onPostToolUse` は
 * `#annotateCutOffWorkers` の結果を `hookSpecificOutput.additionalContext`
 * として返す経路を持ち、これは「起きたことをただ記録する」を超えた判断
 * （モデルへ追加の文脈を注ぎ込むかどうか）である。`ManagerSessionOptionsRequest`
 * の `onPostToolUse` 欄は、このため今回も `HookCallback` のまま残す
 * （`claude-provider.ts` の同欄の doc に理由を書いてある）。**`runner.ts` 側の
 * `PostToolUseFailure`（`#onPostToolUseFailure`）は `{ continue: true }` だけ
 * を返すので、こちらは対象に含む。**
 *
 * ## 欄は「いま実際に読まれているもの」だけ
 *
 * 新しい語彙を作らない——`clone.ts` の `#journalToolUse` /
 * `#journalToolUseFailure` / `cloneToolActor` / `#onPreCompact` /
 * `#onPreToolUse` と `runner.ts` の `#onPostToolUseFailure` / `#onPreCompact` /
 * `#onUserPromptSubmit` / `#onStop` / `#onPreToolUse` が実際に読んでいる欄
 * だけを、同じ意味のまま camelCase へ写した。SDK の snake_case な入力から
 * この形へ写す処理（`toAgentToolAuditRecord` / `toAgentToolAuditFailureRecord` /
 * `toAgentPreCompactRecord` / `toAgentUserPromptSubmitRecord` /
 * `toAgentStopRecord` / `toAgentPreToolRecord`）は `claude-provider.ts` 側に
 * 置く——ここは「届いた後の形」だけを知っている。
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
 * `PreCompact`（生ログを要約に潰す直前）1件の中立の記録。
 *
 * **すべて任意である。** `clone.ts` の `#onPreCompact` と `runner.ts` の
 * `#onPreCompact` の両方が使うが、読む欄は違う——クローン側は3欄すべて、
 * マネージャー側は `transcriptPath` だけを読む（マネージャー側は蒸留を
 * 持たず退避だけなので、`sessionId` も `signal` も要らない）。
 */
export interface AgentPreCompactRecord {
  /** 生ログ（transcript）の置き場所。読めなければ省く。 */
  transcriptPath?: string;
  /** セッションの識別子。読めなければ省く。 */
  sessionId?: string;
  /**
   * 後続処理を打ち切ってよいかの合図。SDK の `HookCallback` が渡す
   * `options.signal` をそのまま運ぶ——`clone.ts` の `#onPreCompact` だけが
   * 読む（蒸留の中断判定。「中断の合図は蒸留にだけ掛かる」）。
   */
  signal?: AbortSignal;
}

/**
 * `UserPromptSubmit`（ターンの開始）1件の中立の記録。マネージャー専用
 * （`worker_wait` の観測口。`runner.ts` の `#onUserPromptSubmit`）。
 */
export interface AgentUserPromptSubmitRecord {
  /** 呼び出しが作業者（サブエージェント）からのものだったときの id。本体のターンなら省く。 */
  agentId?: string;
  /** このプロンプトを起こした主体（`user` / `sdk` / `system` など。provider の自由文字列）。読めなければ省く。 */
  source?: string;
}

/**
 * `Stop`（マネージャー自身のターンが閉じる瞬間）1件の中立の記録
 * （#861 の観測口。`runner.ts` の `#onStop`）。
 */
export interface AgentStopRecord {
  /**
   * 走行中・待機中の背景処理。中身の形は provider ごとに違いうるので
   * `unknown` のまま運ぶ——`runner.ts` 側は各要素をさらに `unknown` として
   * 扱っている（`#stopTaskOwnerKind` / `classifyBackgroundTaskStatus`）。
   * 読めなければ省く。
   */
  backgroundTasks?: unknown[];
  /** このセッションを起こす予約（cron・`/loop`）。読めなければ省く。 */
  sessionCrons?: unknown[];
  /** Stop hook が既に一度発火して継続させた印。読めなければ省く。 */
  stopHookActive?: boolean;
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

/**
 * `PreToolUse`（道具を実行する直前）1件の中立の記録（#486 中立の口の3本目）。
 *
 * **すべて任意である。** 無い欄は作り物を出さずに省く（上の Record 型と
 * 同じ作法）。
 *
 * **欄は「いま実際に読まれているもの」の和集合だけ。** `clone.ts` の
 * `#onPreToolUse`（Issue #863）は `toolName` / `toolInput` だけを読む
 * （`Bash` 以外は素通し、`tool_input.command` が人間の承認した許可の
 * ルールに一致するかだけを見る）。`runner.ts` の `#onPreToolUse`
 * （`bash-wait-guard.ts`、Issue #894）はそれに加えて `agentId` /
 * `agentType` も読む（弾いた主体を note の文面へ書くため）。ここは両方の
 * 和集合を持つ——`toolInput` は `unknown` なので、`bash-wait-guard.ts` が
 * 見る `run_in_background` のような、道具ごとに形が違う欄もここへ写す時点で
 * 潰さない。
 */
export interface AgentPreToolRecord {
  /** 呼ばれようとしている道具の名前。読めなければ省く。 */
  toolName?: string;
  /** 道具へ渡そうとしている入力。 */
  toolInput?: unknown;
  /** 呼び出しが作業者（サブエージェント）からのものだったときの id。本体の呼び出しなら省く。 */
  agentId?: string;
  /** 作業者の型名。**`agentId` が無ければ意味を持たない。** */
  agentType?: string;
}

/**
 * `PreToolUse` が返せる判断。**判断を返す唯一のフック**なので
 * `AgentObservationHook` には載らない（そちらの doc を見よ）。
 *
 * - `continue`: 何も決めない。既存の確認フロー（`permissionMode` / 人間の
 *   確認）へそのまま委ねる——`clone.ts` の `#onPreToolUse`「一致しなければ
 *   何も決めない」と `runner.ts` の `#onPreToolUse`「`Bash` 以外・弾かれ
 *   なかったコマンドは素通し」の両方がここへ落ちる。
 * - `allow`: 確認なしで進めてよい（`clone.ts` の `#onPreToolUse`、人間が
 *   承認した Bash 許可に一致したとき。Issue #863）。
 * - `deny`: 実行そのものを止める（`runner.ts` の `#onPreToolUse`、
 *   `bash-wait-guard.ts` が「無限に待つだけの形」と判定したとき。
 *   Issue #894）。
 *
 * **`ask` は持たない。** いまの実装のどちらも `ask` を一度も返していない
 * ——語彙を先回りして作らない（`agent-events.ts` の `AgentPermissionDenial`
 * と同じ流儀）。要るようになったら、そのときの実装を確かめてから足す。
 */
export type AgentPreToolDecision =
  { kind: 'continue' } | { kind: 'allow'; reason: string } | { kind: 'deny'; reason: string };

/**
 * 判断を返す `PreToolUse` フックの中立の関数型。**`AgentObservationHook` とは
 * 別の型にする** —— あちらは `void` しか返せないので、判断を返すフックは
 * そもそも載らない。
 */
export type AgentPreToolHook = (
  record: AgentPreToolRecord,
) => AgentPreToolDecision | Promise<AgentPreToolDecision>;

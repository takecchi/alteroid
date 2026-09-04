/**
 * マネージャーが「止まっているのか進んでいるのか」の判定を1箇所へ切り出す
 * 純関数（台帳 `028ee442` の指摘）。
 *
 * **背景。** `flushWithheldReports()`（`manager.ts`）が30分待っても次の
 * ターンが来ない委譲の畳んだ報告をまとめて配るとき、その中身は既に日誌に
 * 在る（`journal_read` で辿れる）——だから合図としての価値は「30分、本報告が
 * 1本も無い」という事実そのものにあり、畳んだ本文を再送することではない。
 * それより効くのは「その委譲がいま止まっているのか進んでいるのか」で、
 * `manager_list`（`tools.ts` の `describeTurnEnd` / `describeToolUseStall`）は
 * 既にその判定材料（`turnEndedAt` / `turnEndReason` / `lastReportAt` /
 * `toolUseStallAt` / `toolUseStallPending` / `waiting`）を持っている。
 *
 * **判定のコピーを2つ作らない。** `tools.ts` の2つの `describe*` と
 * `manager.ts` の `flushWithheldReports()` は、同じ「止まっている／進んで
 * いる／判定できない」の判定を必要とする。ここへ切り出した1本をどちらからも
 * 呼ぶことで、片方だけ直った日に静かにずれる形を作らない。
 *
 * **`ManagerSummary` にも `ManagerRecord` にも依存しない。** どちらの型からも
 * 渡せるよう、判定に要る欄だけを持つ構造的な入力型（{@link ManagerActivityInput}）
 * を受ける。呼び出し元は2つ——`tools.ts`（`ManagerSummary` から作る）と
 * `manager.ts`（`ManagerRecord` / `record.job.lastReportAt` から作る）。
 *
 * **新しい I/O は増やさない。** ここは計算だけを行う純関数で、渡された値だけを
 * 見る。呼び出し元がその値をどう手に入れるか（`manager-poller.ts` の60秒周期
 * に相乗りしている）はこのファイルの関知するところではない。
 */

/**
 * {@link classifyManagerActivity} が返す状態。**4つ以上を持つ**——「無い」の
 * 種類を潰さない（依頼者の守る線）。基準は「読み手の次の一手が変わるか」。
 *
 * - `'stalled-turn-end'` — **止まっている（ターン終わり型）。** ターンは
 *   終わっているらしいのに、その後の報告が届いていない（Issue #567 の形）。
 *   次の一手: `manager_report` / `manager_transcript` を見る。起こし直さない。
 * - `'stalled-tool-use'` — **止まっている（道具待ち型）。** 生ログ末尾が
 *   `stop_reason: 'tool_use'` で、対応する `tool_result` が生ログに無く、
 *   かつデーモン側の `waiting` も空（Issue #572 の形）。次の一手:
 *   `manager_transcript` で末尾を読み、`manager_stop` するかどうかを判断する。
 * - `'active'` — **進んでいる／正常な待ち。** 上のどちらでもなく、観測は在る
 *   （ターンは正常に終わって報告済み、または道具の応答待ちだが誰かが
 *   `waiting` で待っている）。次の一手: 何もしない。
 * - `'unknown'` — **判定できない。** 観測そのものが無い（`turnEndReason` も
 *   `toolUseStallPending` も無い＝まだ一度も probe されていない、台帳に
 *   record が無い、など）。**`'active'` へ倒さない**——依頼者が待つか諦める
 *   かを決める分かれ目である。次の一手: 判定材料が揃うまで待つ（急かさない）。
 */
export type ManagerActivityKind = 'stalled-turn-end' | 'stalled-tool-use' | 'active' | 'unknown';

/**
 * `classifyManagerActivity` への入力。
 *
 * **`ManagerSummary` / `ManagerRecord` のどちらにも依存しない構造的な型。**
 * 両方の型がたまたまこれらのフィールド名を持っているので、呼び出し元は
 * 該当する欄をそのまま渡せる（`waitingCount` だけは `waiting.length` を渡す
 * ——`RunnerWaiting` の型そのものは判定に要らないので取り込まない）。
 */
export interface ManagerActivityInput {
  /**
   * `probeTurnEnd`（`manager.ts`）が見つけた行の `stop_reason`。見つけて
   * いなければ `undefined`——「この観測自体が無い」ことの印
   * （`ManagerSummary.turnEndReason` の doc と同じ約束）。
   */
  readonly turnEndReason?: string;
  /** 上と対で運ぶ `timestamp`。行が `timestamp` を持たなければ `undefined`。 */
  readonly turnEndedAt?: string;
  /** デーモンが直近の報告を受け取った時刻（`Job.lastReportAt` の写し）。 */
  readonly lastReportAt?: string;
  /**
   * `probeToolUseStall`（`manager.ts`）が見つけた、応答が見当たらない
   * `tool_use`。0件なら `probeToolUseStall` 自身が `undefined` を返すので、
   * ここも `undefined`——「観測が無い」と「観測して0件だった」を区別しない
   * （区別する必要がない。`PendingToolUse` と同型だが、判定に要らない他の
   * 欄を引き込まないよう構造的な型で受ける）。
   */
  readonly toolUseStallPending?: readonly { readonly id: string; readonly name?: string }[];
  /** いま返事待ちで止まっている件数（`waiting.length`）。 */
  readonly waitingCount: number;
}

/**
 * `describeTurnEnd`（`tools.ts`）が元々持っていた判定をそのまま関数へ切り出した
 * もの。**字面を1バイトも変えない書き換えの土台**——この関数の真偽が変われば
 * `describeTurnEnd` の出力も変わってしまうので、ロジックは移すだけで変えない。
 *
 * - `turnEndedAt` が無い ⟹ 止まっている（**⚠**。「分からないだけで、症状で
 *   ないとは言えない」——既定は「分からない」）
 * - `lastReportAt` が無い ⟹ 止まっている（比較の材料が無い）
 * - どちらかが `Date.parse` できない（`NaN`）⟹ 止まっている（「分からない」を
 *   「症状ではない」へ倒さない）
 * - `turnEndedAt <= lastReportAt`（数値比較）⟹ 止まっていない（正常な待機）
 * - それ以外（`turnEndedAt > lastReportAt`）⟹ 止まっている
 */
function isTurnEndStalled(
  turnEndedAt: string | undefined,
  lastReportAt: string | undefined,
): boolean {
  if (turnEndedAt === undefined) return true;
  if (lastReportAt === undefined) return true;
  const turnEndedAtMs = Date.parse(turnEndedAt);
  const lastReportAtMs = Date.parse(lastReportAt);
  if (Number.isNaN(turnEndedAtMs) || Number.isNaN(lastReportAtMs)) return true;
  return !(turnEndedAtMs <= lastReportAtMs);
}

/**
 * マネージャー1本の「止まっている／進んでいる／判定できない」を判定する
 * 純関数。このファイル冒頭の doc を参照。
 *
 * **切らない・殺さない・止めない。** ここが何を返しても呼び出し元の `status`
 * は動かない——`describeTurnEnd` / `describeToolUseStall` / `flushWithheldReports`
 * のどの doc とも同じ約束を、判定を切り出した後もそのまま引き継ぐ。
 *
 * **2つの探り（ターン終わり型・道具待ち型）は、生ログの同じ末尾行を見て
 * いるので同時には立たない**（`manager.ts` の `probeTurnEnd` / `probeToolUseStall`
 * の doc）。ここではその前提を強制しない——万一両方が入力に立っていたら、
 * ターン終わり型を優先する（`manager.ts` 側の計算順序と同じ順）。
 */
export function classifyManagerActivity(input: ManagerActivityInput): ManagerActivityKind {
  const hasTurnEndObservation = input.turnEndReason !== undefined;
  const pending = input.toolUseStallPending;
  const hasToolUseStallObservation = pending !== undefined && pending.length > 0;

  if (!hasTurnEndObservation && !hasToolUseStallObservation) return 'unknown';

  if (hasTurnEndObservation && isTurnEndStalled(input.turnEndedAt, input.lastReportAt)) {
    return 'stalled-turn-end';
  }

  if (hasToolUseStallObservation && input.waitingCount === 0) {
    return 'stalled-tool-use';
  }

  return 'active';
}

/**
 * `flushWithheldReports()`（`manager.ts`）が配る短い1行。**畳んだ本文の全文
 * ではなく、状態と次の一手だけを言う**——全文は日誌に在る（`journal_read`）。
 *
 * **4状態すべてで必ず非空文字を返す。** かつては `'active'` を空文字（何も
 * 足さない）にしていたが、それだと flush の文面から「判定の行そのものが
 * 無い」ときに2つの意味が生まれてしまう——(a) `'active'` だった（進んで
 * いるので言うことが無い）／(b) 判定の結線が壊れて1行も足されなかった。
 * **この2つが字面で区別できないのは「静かに失敗する形」そのものである**
 * （依頼者の守る線）。だから `'active'` も他の3状態と同じく必ず字を出す
 * ——`tools.ts` の `describeTurnEnd` / `describeToolUseStall`（一覧。`null`
 * で黙る）とは事情が違う。あちらは**全マネージャーを毎回並べる**ので健全な
 * 行を出すと一覧がそのぶん膨らむが、flush の文面は**既に異常（30分、本報告
 * が1本も無い）と分かっている委譲について30分に1回だけ**出るので、1行増える
 * 費用は無視できる。
 *
 * - `'stalled-turn-end'` / `'stalled-tool-use'` ⟹ **⚠** を出す
 * - `'active'` ⟹ **⚠ は付けない**（警告ではない）が、「進んでいる／
 *   止まっている兆候は無い」と読める字を出す
 * - `'unknown'` ⟹ **「判定できない」と分かる文字**を出す。**`'active'`
 *   （止まっている兆候は無い、という積極的な観測）とは字面で区別する**
 *   ——依頼者が「進んでいるので待つ」と「観測が無いので分からない」を
 *   読み違えないため。
 */
export function describeManagerActivityForFlush(kind: ManagerActivityKind): string {
  switch (kind) {
    case 'stalled-turn-end':
      return (
        ' ⚠ この委譲はターンが終わっているらしいのに、報告がまだ届いていない' +
        '（#567 の形）。manager_list で `turnEndedAt` / `turnEndReason` を確かめること。'
      );
    case 'stalled-tool-use':
      return (
        ' ⚠ この委譲は道具の応答待ちのまま、誰もその応答を待っていない' +
        '（#572 の形）。manager_list で `toolUseStallPending` を確かめること。'
      );
    case 'unknown':
      return (
        ' 進んでいるか止まっているかは判定できない（観測がまだ無い）。' +
        '急かさず、次の一覧まで待つこと。'
      );
    case 'active':
      return ' 進んでいる（止まっている兆候は無い）。急かさなくてよい。';
    default: {
      const exhaustive: never = kind;
      throw new Error(`未知の ManagerActivityKind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

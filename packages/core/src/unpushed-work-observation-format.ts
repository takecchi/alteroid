/**
 * 台帳へ残す未 push の観測（`kind: 'observed'`）が「確かめきれなかった」
 * ことを持つとき、それを人が読む1文へ整形する、**唯一の定義元**（Issue
 * #1885）。
 *
 * ## なぜ足すか
 *
 * `runner-protocol.ts` の `unpushedWorkResultSchema` はその場で「確かめ
 * きれなかった」ことを4つの欄（`truncatedAtCount` / `stoppedEarly` /
 * `scratchRootsUnknown` / `unreadableDirCount`）で名乗るが、台帳へ残す形
 * （`schema.ts` の `lastUnpushedWorkObservationSchema` の `kind: 'observed'`）
 * はこれまで `worktrees` しか運ばなかった——保存された観測だけを読む側
 * （器の入れ替え後・枠落ち後）からは「探しきって N 本」と「途中で打ち切
 * った／読めない所があって N 本」の区別が付かなかった。
 *
 * ここはその4欄を**そのまま写した観測**から、読む側（`tools.ts` の
 * `describeUnpushedWorkObservation`・`manager.ts` の `workspaceAfterSwap`
 * 系・Web UI の `manager-detail.tsx`）が共通で使う1文を作る。**判定を
 * 複数箇所で手で合わせない**——このファイルの外に同じ判定を書かない。
 *
 * ## `mask-url.ts` / `job-status-running.ts` と同じ形
 *
 * ブラウザのバンドルへ入る軽い口（`@alteroid/core/unpushed-work-observation-format`。
 * `tsup.config.ts` の `entry` の doc）にするため、**import を1つも持たない。**
 *
 * ## なぜ手で複製した型を使うか（`schema.ts` を import しない）
 *
 * `schema.ts` は `lastUnpushedWorkObservationSchema`（zod）を持ち、zod は
 * 実行時の依存になる——`job-status-running.ts` の同じ doc と同じ理由で、
 * ここから型を取ると zod ごとブラウザバンドルへ入る。構造的に一致する
 * こと（欄が増えたのに揃え忘れたら `typecheck` が落ちること）は `schema.ts`
 * の `_AssertUnpushedWorkObservationIncompletenessMatchesLikeType` が保証
 * する。
 *
 * ## 出さない欄（`unreadableDirSample`）
 *
 * `unreadableDirSample`（`<パス>: <エラーメッセージ>`）は絶対パスを含みうる
 * ので、台帳（`unpushedWorkObservationOf`）の時点で写さない——この型にも
 * 持たせない。読む側は「件数」までしか言えない。
 */
export interface UnpushedWorkObservationIncompletenessLike {
  readonly truncatedAtCount?: number;
  readonly stoppedEarly?: true;
  readonly scratchRootsUnknown?: string;
  readonly unreadableDirCount?: number;
}

/**
 * 4欄のどれかが載っているときだけ、「この観測は探しきっていない」という
 * 1文を返す。**どれも載っていなければ `null`**——これは「探しきった」の
 * 意味にも読めてしまうため、呼び出し元はこの `null` を「新しい主張をしない」
 * （今日までと同じ、何も言わない）側でだけ使うこと。旧い台帳の行（この4欄を
 * 持たない版が書いた行）もここを通ると `null` になるが、それは「探しきった」
 * と言い直しているのではなく、**判定できない**を「何も言わない」という
 * 形で表している——このファイルもその呼び出し元も、`null` を積極的に
 * 「全部だ」とは名乗らない（`AGENTS.md`「取れない軸に0の行を作る」の裏）。
 */
export function describeUnpushedWorkObservationIncompleteness(
  fields: UnpushedWorkObservationIncompletenessLike,
): string | null {
  const reasons: string[] = [];
  if (fields.truncatedAtCount !== undefined) {
    reasons.push(`件数の上限（${fields.truncatedAtCount}）で打ち切った`);
  }
  if (fields.stoppedEarly === true) {
    reasons.push('期限切れで一部を調べる前に打ち切った');
  }
  if (fields.scratchRootsUnknown !== undefined) {
    reasons.push(`/tmp スクラッチの起点を確かめられなかった: ${fields.scratchRootsUnknown}`);
  }
  if (fields.unreadableDirCount !== undefined) {
    reasons.push(
      `子ディレクトリの読み失敗が${fields.unreadableDirCount}件あった（/tmp スクラッチの起点そのものの読み失敗を含む）`,
    );
  }
  if (reasons.length === 0) return null;
  return `この観測は探しきっていない（${reasons.join('・')}）——ここに無い作業ツリーが在りうる。`;
}

/**
 * `lastUnpushedWorkObservation.source` の手で複製した型（`schema.ts` を
 * import しない理由は上と同じ）。**欄が増えたのに揃え忘れたら `typecheck` が
 * 落ちる**——`schema.ts` の `_AssertUnpushedWorkObservationSourceMatchesLikeType`
 * が両向きで保証する。
 */
export type UnpushedWorkObservationSourceLike =
  'stop-refusal' | 'report' | 'tool_use' | 'auto-fold' | 'vacate' | 'stop' | 'closed' | 'shutdown';

/**
 * 観測を残した経路を人間可読な1句にする、`tools.ts`（`manager_list`）と
 * Web UI（`manager-detail.tsx`）の**共通の定義元**（Issue #2457）。
 * **`undefined` は「その経路だ」と見なさない**——この欄を書かなかった版・
 * 呼び出しが在ったことをそのまま名乗る（`unpushedWorkObservationSourceSchema`
 * の doc「無いことは、どれかの経路だと見なさない」と同じ注意）。
 *
 * 知らない値（デーモンの版が新しい）でも投げない——Web UI が描画中に落ちる
 * より、知らないと名乗るほうを取る。
 */
export function describeUnpushedWorkObservationSource(
  source: UnpushedWorkObservationSourceLike | undefined,
): string {
  if (source === undefined) {
    return '経路不明（この欄を書かない版が残した行、または経路を渡さなかった呼び出し）';
  }
  switch (source) {
    case 'stop-refusal':
      return 'manager_stop（running・非force）の断り';
    case 'report':
      return 'ターンが report で終わったとき';
    case 'tool_use':
      return 'Bash で git push か新しい枝を作る操作を検出したとき';
    case 'auto-fold':
      return 'done を自動で畳む前の安全弁（auto-fold）';
    case 'vacate':
      return 'runner を意図して空ける直前（vacate）';
    case 'stop':
      return 'manager_stop（force・done/waiting_human の非force）・人間の停止・自動畳みが止める直前';
    case 'closed':
      return 'runner が closed を出す直前に先取り';
    case 'shutdown':
      return '日常の redeploy で runner が stop する直前に先取り（best-effort）';
    default:
      return `知らない経路 "${String(source)}"（デーモンの版が新しい可能性）`;
  }
}

/**
 * 器を失っていない委譲の「未push観測」の見出しに入れる、観測の出どころの
 * 句（Issue #1266）。**経路の列挙を持たない**——観測自身の `source` を
 * {@link describeUnpushedWorkObservationSource} で言うだけにする（`closed`・
 * `vacate`・`shutdown` が入ってから、決め打ちの列挙は事実と違っていた）。
 * `tools.ts`（`manager_list`）・CLI（`/managers`）・Web UI（`manager-detail.tsx`）
 * の共通の定義元。`source` が無い古い行は経路不明がそのまま出る。
 *
 * `refresher` は「この表示そのものでは更新されない」と名乗る相手の名前
 * （`manager_list` など）。渡さなければ、いまの状態ではないことだけを言う。
 */
export function describeUnpushedWorkObservationProvenance(
  source: UnpushedWorkObservationSourceLike | undefined,
  refresher?: string,
): string {
  const caveat =
    refresher === undefined
      ? 'いまの状態そのものではない'
      : `${refresher} 自身では更新されない。いまの状態ではない`;
  return `最後の1回の経路: ${describeUnpushedWorkObservationSource(source)}。${caveat}`;
}

/**
 * 器の入れ替え（`sessionMissingSince`）で、止まる直前の観測が
 * **届いていない**（`shutdownObservationArrivedAfterSwap !== true`）ときの
 * 断りの1文（Issue #1266 / PR #1777、Web への写しは Issue #2457）。
 * `tools.ts` の `describeUnpushedWorkObservation` と Web UI が同じ文を出す
 * ための唯一の定義元。**「未pushが無かったことを意味しない」を外さないこと**
 * ——届いていないのは「無かった」ではなく「分からない」である。
 */
export const UNPUSHED_WORK_SHUTDOWN_OBSERVATION_NOT_ARRIVED_NOTE =
  '⚠ 未push観測: 器が止まる直前の観測は届いていない' +
  '（best-effort の送信のため。未pushが無かったことを意味しない）。';

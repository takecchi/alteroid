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
    reasons.push(`子ディレクトリの読み失敗が${fields.unreadableDirCount}件あった`);
  }
  if (reasons.length === 0) return null;
  return `この観測は探しきっていない（${reasons.join('・')}）——ここに無い作業ツリーが在りうる。`;
}

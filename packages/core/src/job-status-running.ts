/**
 * ジョブの「実行中」件数を数えるときに使う、唯一の判定（9回目の横断レビュー
 * 指摘。オーナー決定。Issue は無い）。
 *
 * ## 塞いだ穴
 *
 * `apps/web/app/routes/dashboard.tsx` の「稼働中のマネージャー」カードが
 * `m.status === 'running'` を直書きしていた。直書き自体は現状 `main` の
 * `jobStatusSchema`（`schema.ts`）と一致するので今日は壊れないが、**将来
 * 「実行中」を意味する新しい値が足されても、この直書きは黙って無視する**
 * ——`filter` の述語がその値を単に false と扱うだけなので、型検査も通り、
 * 画面も落ちない。件数からその分だけ静かに漏れる。
 *
 * ここへ判定を1箇所へ寄せ、{@link JobStatusLike} を **手で** `jobStatusSchema`
 * の選択肢と揃える——選択肢が増えたのに揃え忘れたら、`schema.ts` の
 * `_AssertJobStatusMatchesRunningLikeType` が `typecheck` を落とす（下の
 * 「なぜ手で複製した型を使うか」を参照）。**その型検査に落ちて初めて、新しい
 * 値を {@link isRunningJobStatus} のどちらの枝へ入れるかを決めることになる**
 * ——決めないと `pnpm typecheck` が赤くなる形なので、決め忘れたまま通ることが
 * 無い。
 *
 * ## `waiting_human` は含めない——「実行中」と「まだ終わっていない」は別の集合
 *
 * `waiting_human` は「マネージャー自身のセッションは生きているが、その委譲
 * （仕事）だけが人間・クローンの返事待ちで止まっている」状態
 * （`jobStatusSchema` の doc）。画面の語彙（`apps/web/app/routes/managers.tsx`
 * の `STATUS`）でも最初から別の言葉を割り当ててある——`running` は「実行中」、
 * `waiting_human` は「人間待ち」。ここへ寄せて「実行中」の集合に含めると、
 * 止まっているだけの委譲まで「動いている」と数えることになり、字面と件数が
 * 食い違う。
 *
 * **「まだ終わっていない」という広い集合が要るなら、それは {@link
 * isManagerInFlight}（`digest.ts`）が持つ別の集合であり、ここには混ぜない**
 * ——あちらは `manager_list` の並び替えや日報が「対応の要る委譲」をまとめて
 * 先に出すために使っていて、`running` と `waiting_human` を意図して同じ扱いに
 * している。**目的が違う2つの集合を1つへ畳むと、片方の面で意味が壊れる。**
 *
 * ## なぜ手で複製した型を使うか（`schema.ts` を import しない）
 *
 * この口は `@alteroid/core/job-status-running` としてブラウザへ出す軽い口
 * （`packages/core/tsup.config.ts` の `entry` の doc）。**実行時の依存を
 * 1つも持たない**——`schema.ts` は zod を import するので、そこから型を取ると
 * zod ごとブラウザバンドルへ入る（`answered-via.ts` と同じ理由。#294 / #306
 * の事故と同じ形）。
 */
export type JobStatusLike = 'running' | 'waiting_human' | 'done' | 'failed' | 'lost' | 'stopped';

/**
 * その値が「実行中」として件数に入るか。
 *
 * **型の網羅性で塞いだうえで、実行時の倒れ先も持つ**（AGENTS.md「型で塞いだ
 * 分岐にも、実行時の倒れ先の歯を足す」）。Web（Vercel）とデーモン
 * （Railway）は別デプロイなので版がずれうる——デーモンが先に新しい値を返し、
 * この画面が読み込んだ版の {@link JobStatusLike}（＝ビルド時点の型定義）が
 * まだ古いという順序が実在しうる（`apps/web/app/routes/managers.tsx` の
 * `ManagerStatusBadge` の doc が同じ順序を issue #1623 として記録している）。
 *
 * **倒れ先は安全側＝「実行中として数える」。** 逆（数えない）を選ぶと、この
 * 関数を作った理由そのもの——新しい値が件数から静かに漏れる——が、型のずれ
 * という別の経路でそのまま再現する。倒れるのは一時的な過大側（知らない値を
 * 実行中に含めすぎる）で、次に Web を再デプロイしてこの型定義が追いつけば
 * 消える。データを1文字も消さない側でもある——`ManagerStatusBadge` の
 * `default` 節と同じ理由で、ここでも未知の値をそのまま握り潰さない。
 */
export function isRunningJobStatus(status: JobStatusLike): boolean {
  switch (status) {
    case 'running':
      return true;
    case 'waiting_human':
    case 'done':
    case 'failed':
    case 'lost':
    case 'stopped':
      return false;
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return true;
    }
  }
}

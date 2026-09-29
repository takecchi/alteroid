import type { ReactNode } from 'react';

import type { ManagerStatus } from '@alteroid/logic';

/**
 * `FailureNote`（`manager-detail.tsx`）と `ManagerFailureNote`（`managers.tsx`）が
 * 同じ意味の文を手書きで複製していたので、終端した委譲（failed / lost /
 * stopped）の第2段落だけをここへ1本化した（Issue #1882、レビュー指摘）。
 *
 * **生きている3値（`running` / `waiting_human` / `done`）はここに無い。**
 * 呼び出し側ごとに文言が違う（詳細は「下の『話しかける』から」と言えるが、
 * 一覧の行にはその「下」が無い）——ここで揃えるのは終端した回の文言だけで、
 * 生きている回は呼び出し側がそれぞれ自分の語調のまま書く（`?? '...'` /
 * `?? (<>...</>)` の形で、この関数が `null` を返した回だけ自分の文言を使う）。
 *
 * ## 「もう続かない」は事実より強かった（レビュー指摘・#1882）
 *
 * 直す前の文言は `stopped` で「原因の有無にかかわらず、このセッションはもう
 * 続かない」、`failed` / `lost` で「原因が解けても、このセッションは自動では
 * 続かない」と言い切っていた。**現物（`send()` / `#resume()` の経路）を読むと、
 * どちらも言い過ぎだと分かる。**
 *
 * 1. **終端した委譲の `ManagerRecord`（in-memory）は `#retire()` が消す。**
 *    `packages/core/src/manager.ts` の `#load()` 関数の doc に逐語である——
 *    「`#retire()` が `this.#records.delete(managerId)` を呼ぶ done/lost/
 *    failed/stopped の委譲がここに当たる」。次に `send()` が同じ managerId を
 *    引くと `#load()` が台帳（persisted `Job`）から**新しい** `ManagerRecord`
 *    を作り直す——`attached: false` で、`stopConfirmedAt` は無い（この欄は
 *    `ManagerRecord` にしか無い in-memory の印で、`Job` には無い。
 *    `packages/core/src/manager-orphan-load-race.test.ts` に「
 *    `ManagerRecord.stopConfirmedAt`（プロセス内だけの印）」と逐語である）。
 * 2. **`#resume()` は `record.job.status` を1文字も見ない。** 見ているのは
 *    `record.stopConfirmedAt`（同ファイルに2箇所、検索:
 *    `grep -Fn -- "record.stopConfirmedAt !== undefined) return"
 *    packages/core/src/manager.ts`）だけ——上の1で消えている回はこの印も
 *    無いので、`send()` は `!attached` の経路（`#resumeOnce` → `#resume`）を
 *    そのまま通り、`sessionId` が残っていれば（`abort()` は `job.sessionId`
 *    自体を消さない）実際に `runner.resume()` を試みる。成功すれば
 *    `record.job.status = 'running'` まで書き換わる——`status` による
 *    足止めはどこにも無い。
 * 3. **Web 自身がこれを既に文書化している。** `manager-detail.tsx` の
 *    `SendMessage` の doc（検索: `grep -Fn -- "送ると引き取り（resume）を試み"
 *    apps/web/app/routes/manager-detail.tsx`）は、繋がっていない相手への
 *    送信ボタンを意図して塞がない理由として「送ると引き取り（resume）を
 *    試み、戻れればそのまま届く」と書いている——`stopped` はまさにこの
 *    「繋がっていないが `sessionId` は在る」側なので、送信欄は塞がれて
 *    いない。
 *
 * ⟹ **「もう続かない」を「セッションは生きているので続く、はここでは
 * 成り立たない」まで弱め、続ける手段（話しかけて resume を試みる）と
 * その手段に保証が無いことを添える。** これは core の `describeUsageStopped`
 * （`packages/core/src/tools.ts`）が終端3値に対して立てている意味の線と同じ
 * ——終端していることと、生きている前提の言い切りがここでは成り立たない
 * ことは言うが、「二度と続けられない」とまでは言わない。
 *
 * **`「セッションは生きているので」` という字面そのものは使わない。** 生きて
 * いる3値の文言（呼び出し側にある）と紛れないようにするための語の選び方
 * であって、意味を変える意図は無い（歯 `manager-detail.test.tsx` /
 * `managers.test.tsx` の `queryByText(/セッションは生きているので/)).toBeNull()`
 * が、終端した回にこの字面が1文字も出ないことを固定している）。
 *
 * **core の値は import できない**（`eslint.config.js` の `@alteroid/core`
 * バレル制限）ので、文言はここで独自に書く。core 側（`describeUsageStopped`）
 * と apps/web 側（ここ）の2箇所に生成元が割れる形は変えていない——
 * 割れていること自体は Issue #1882 が core と Web を別の作業者・別の PR に
 * 割った時点からの前提で、この PR の範囲では閉じられない。
 */
export function terminalFailureNote(status: ManagerStatus): ReactNode | null {
  if (status === 'failed' || status === 'lost') {
    return (
      <>
        <strong className="font-medium">この仕事はもう終わっている</strong>
        。セッションそのものが、
        <strong className="font-medium">依頼者が望まない終わり方で既に終端している</strong>
        。続けたいなら話しかけて resume を試みるしかなく、届く保証は無い。
      </>
    );
  }
  if (status === 'stopped') {
    return (
      <>
        <strong className="font-medium">この仕事はもう終わっている</strong>
        。このセッションは、その後
        <strong className="font-medium">
          人間・クローンが明示的に停止させ、確かめたうえで既に終端している
        </strong>
        。続けたいなら話しかけて resume を試みるしかなく、届く保証は無い。
      </>
    );
  }
  return null;
}

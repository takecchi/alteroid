/**
 * `check-pr-green.mjs` の判定だけを切り出したもの（Issue #933）。
 *
 * ## 何を塞ぐために在るか
 *
 * `AGENTS.md`「静かに失敗する道具」は、同じ sha に draft 由来の古い世代
 * （`skipped`）と ready 後の新しい世代が同居したとき、**世代を並べて新しいほうを
 * 選ぶための信頼できるキーが無い**ことを記録している。実測（PR #932、sha
 * `1e619f43858160fb5d9a6b1895d236e35d4771cf`。Issue #933）:
 *
 * - `started_at` は run をまたぐと逆転する（古い run の `skipped` が新しい run の
 *   `success` より後に `started_at` を持つ）
 * - `id`（check-run の id）も同じ向きに逆転する —— check-run の `id` は
 *   「run が作られた順」ではなく「その check-run（＝ job）が作られた順」に
 *   振られるため、`if:` の評価が遅れた job だけが id でも後ろへ回る
 * - `created_at` で run を1本選ぶ（`check-runs` を経由せず `actions/runs` を見る
 *   場合の素朴な直し）は、**同じ sha に複数の workflow が在ると、走行中の別
 *   workflow を丸ごと落とす**（Issue #933 のコメントの実測。`virchamate` 側の
 *   `Test Backend` / `Guardrail Check` の例）
 *
 * ⟹ **この道具は「同じ sha の check-runs を並べて世代を選ぶ」経路を使わない。**
 * 代わりに `actions/runs?head_sha=<sha>` で実際の run 一覧を取り、
 * **workflow 名ごとに、rerun が絡まなければ `created_at`（同値なら `id`）で
 * 最新の run を選び**（`effectiveTimestamp` / `newerRun` の doc。
 * Issue #1748 / #1761）、**その run 自身の `actions/runs/<id>/jobs` を読む**。
 *
 * ⭐ **15回目の横断レビューで、rerun が絡む比較そのものを時刻で決める形を
 * やめた。** #1748 → #1761 → PR #1778 は「rerun のときだけ鍵を
 * `created_at` → `updated_at` → `run_started_at` と替える」形で3回直った
 * が、そのたびに「rerun がどれだけ待たされるか」という新しい窓を晒す
 * だけだった（`run_started_at` 自体もキューで長く待たされれば遅れる。
 * `scripts/check-pr-green-1778-queued-rerun-open-side.repro.test.ts`）。
 * ⟹ **同じ `name + event` の run のうち、rerun（`run_attempt > 1`）が
 * 絡み、かつ結論（`conclusion`）が食い違うときは、どの時刻を比べても
 * 決めず、`undecidable-rerun-conflict` という第3の状態を返す**
 * （`pickLatestRunPerWorkflow` の `hasRerunConflict` の doc）。**結論が
 * 揃っている場合と rerun が絡まない場合は、これまでどおり時刻で選ぶ**
 * ——#933 / #997 / #1126 の実測はそのまま壊れない。
 *
 * ⭐ **PR #1801 のレビューで、上の `hasRerunConflict` が「全部 completed」を
 * 前提にしているため、rerun が絡み、かつ完了していない run が同じ鍵に
 * 混ざるとまだ時刻の比較へフォールバックし、開く側に倒れる形が見つかった**
 * （未完了の run が丸ごと捨てられ、あとで failure になるはずの run を
 * 見ずに `green` と言ってしまう）。⟹ その場合は「食い違い」ではなく
 * 「保留」（`pending`）を返す（`hasUnresolvedRerunGroup` の doc）。
 *
 * ⚠️ **これで「確定」ではない。** 実測できたのは1 sha・2世代・1 workflow・
 * 4ジョブの標本（#933）と、そこへ rerun が絡んだ1 sha・2世代・1 workflow の
 * 標本（#1748。`check-pr-green.test.ts` のコメント参照）だけである。
 * **`pull_request` と `workflow_dispatch` が混ざる場合はまだ測っていない**
 * （rerun で3世代目が生える場合は #1748 で測った——次項。rerun が絡み
 * 結論が食い違う場合は15回目の横断レビューで測り、上のとおり対処した。
 * rerun が絡み未完了の run が混ざる場合は PR #1801 のレビューで測り、
 * すぐ上のとおり対処した）。
 *
 * ⛔ **同じ workflow 名で `event` が違う run が同じ sha に同居する場合は
 * 実測済みで、`created_at` だけでまとめると赤を見落とす（Issue #1225）。**
 * 実測: sha `3ca63973b7dae66b48b033a962a92e19c7e73e63` に `CI` の run が2本
 * 同居した —— `push` の run `34709221407`（`ci=failure`、06:46:25作成）と、
 * その2分後にできた `schedule` の run `34709324541`（drift 運転で `ci` を
 * 丸ごと skip し `image` だけ走らせる。`ci=skipped`、06:48:26作成）。
 * workflow 名だけでまとめて `created_at` の新しいほうを1本残す旧実装は、
 * 新しい `schedule` の run が古い `push` の run を追い出し、`ci=failure` が
 * 評価から消える（`red` になるはずが `out-of-scope` に化ける）。⟹
 * **まとめる鍵を「名前」だけでなく「名前 ＋ `event`」にする** —— `push` と
 * `schedule` は別の鍵になるので互いを隠さない。#933 が解いた draft/ready の
 * 同居（どちらも `event: pull_request` で同じ鍵）はそのまま解ける。
 */

/**
 * run 自身の「実効の新しさ」を表す時刻を返す（Issue #1748 / #1761）。
 *
 * `run_attempt` が2以上（＝ `gh run rerun` で再実行された run）のときだけ
 * `run_started_at`（その attempt を実際に始めた時刻）を使い、それ以外
 * （`run_attempt` が1、または省略——古い呼び出し元・テストとの互換）は
 * `created_at` を使う。
 *
 * ## なぜ `updated_at` ではないか（Issue #1761、開く側の穴）
 *
 * 最初の直し（#1748）は rerun の鍵に `updated_at` を使っていたが、
 * `updated_at` は**その attempt が完了した時刻**であって、rerun には
 * 時間がかかりうる。rerun の実行中に、rerun とは無関係な**別の run**
 * （本当に新しい世代で、失敗した run）が作られて完了すると、その別
 * run の `created_at` は rerun の `updated_at`（完了時刻）より前になり
 * うる —— つまり「rerun が終わるまでの間に生まれた、本当に新しい世代の
 * 失敗」が `updated_at` に追い越されて評価から消え、`green` と言って
 * しまう（14回目の横断レビュー、`wip/review14-s5` の再現テストが具体形
 * を持つ。`scripts/check-pr-green.test.ts` の「PR #1761 の open-side」
 * を参照）。
 *
 * `run_started_at` はその attempt が**実行を開始した**時刻で、完了を
 * 待たずに決まる——rerun が長引いても動かない。⟹ rerun の鍵を
 * `run_started_at` にすれば、rerun 中に生まれた別の run の `created_at`
 * を rerun 側の完了待ちで追い越すことが構造的に無くなる。
 *
 * ## なぜ分けるか（`run_attempt` で場合分けする理由。#1748 から変えていない）
 *
 * `created_at` は run が最初に作られた時刻のまま固定で、**rerun しても
 * 動かない。** 一方 `run_started_at` は attempt ごとに実行が始まった
 * 時刻を持つ。だから rerun が絡む run では `created_at` は「実効の
 * 新しさ」を失うが、`run_started_at` に乗り換えれば直る。
 *
 * ただし `run_started_at` を**常に**使うと、直上の「その run が実際に
 * ジョブを実行したか」と同じ形の罠を生みうる —— 別の生成（同じ
 * workflow 名・同じ event）が同居する draft→ready のレースでは、
 * `created_at` は run が作られた実測の順序を正しく持つ（下の実測）。
 * `run_attempt` で場合分けすることで、rerun が絡まない大多数の比較は
 * これまでどおり `created_at` のまま（#933 / #997 / #1126 の実測を
 * 壊さない）にし、rerun が絡む比較だけ `run_started_at` に寄せる。
 *
 * ## `run_started_at` が無いとき（開く側に倒れない値へ倒す。#1761）
 *
 * `run.run_started_at` が無い（`null`/`undefined`）場合は `created_at`
 * にフォールバックする。**`created_at` は attempt が始まる前の時刻**
 * （run が作られるのは実行が始まるより前か同時なので、常に
 * `created_at <= run_started_at`）なので、フォールバックした比較は
 * 実際より**古く**見える側にしか倒れない。古く見える分には、他の
 * 本当に新しい run に追い越されるだけで、閉じる側（#1748 の NG）が
 * 再発することはあっても、開く側（誤って `green` と言う）には倒れない
 * ——後者のほうが実害が大きいため、この非対称を選んでいる。
 *
 * ## 実測（Issue #1748、sha `031bf92f62e61fc16eee3570a72c7c87ff6b2d7f`）
 *
 * push 直後に `gh pr ready` を打ったところ、concurrency（`cancel-in-progress:
 * true`）が競り合い、`CI` の run が2本できた:
 *
 * - run `36286928087`（`run_attempt=1`、`created_at=01:54:11Z`、
 *   `conclusion=skipped`。draft と評価された扱いのまま残った）
 * - run `36286927781`（`run_attempt` は1→cancelled→2）。attempt 1 は
 *   `created_at=01:54:10Z`（`36286928087` より**1秒早い**）で `cancelled`。
 *   `gh run rerun` した attempt 2 は `run_started_at=02:02:08Z`（実行が
 *   実際に始まった時刻）で、`updated_at=02:16:15Z`（22分後）に `success`
 *   で完了した。attempt を重ねても run 自身の `created_at`（`01:54:10Z`）
 *   は動かない。
 *
 * ⟹ `created_at` だけで比べると、後から作られた draft 由来の
 * `36286928087`（`01:54:11Z`）が rerun 後の `36286927781`
 * （`created_at` は動かず `01:54:10Z` のまま）より新しく見え、**skipped の
 * ほうを「最新世代」に選んでしまう。** `run_attempt` が2以上の
 * `36286927781` だけ `run_started_at`（`02:02:08Z`）で比べても、
 * `36286928087` の `created_at`（`01:54:11Z`）より後なので、正しく
 * rerun 後の success が選ばれる（`updated_at` だけでなく
 * `run_started_at` でも #1748 の実データは green のままである。
 * 2026-09-27 に `gh api repos/takecchi/alteroid/actions/runs/36286927781`
 * とその `/attempts/1` `/attempts/2` を実際に叩いて確認済み）。
 *
 * ⚠️ **`check-run`（job）の `id` を世代選びの鍵にする案は採らない。**
 * 同じ Issue で確かめたところ、rerun 後の attempt はジョブごとに新しい
 * check-run id を得て、この標本では新しい id が正しく success 側を指した
 * （`108530421811` > `108529330063`）。しかし #933 の実測（sha
 * `1e619f43858160fb5d9a6b1895d236e35d4771cf`）を同じ観点で引き直すと、
 * `base-overlap` という1門だけ check-run id が逆転している
 * （skipped 側の check-run id `103687100128` が、success 側の
 * `103687095766` より**大きい**——`if:` の評価が遅れた job だけ id でも
 * 後ろへ回るという、このファイル冒頭の doc の記述のとおり）。⟹
 * check-run id は rerun の無い draft→ready のレースで既に破綻することが
 * 分かっているので、rerun の場合分けの鍵には使わない。
 *
 * ## ⭐ 15回目の横断レビュー —— この関数（時刻の比較）そのものが、もう
 * rerun が絡む世代選びの最終手段ではなくなった
 *
 * 直上の #1761 の直し（`updated_at` → `run_started_at`）は「開く側の穴を
 * 塞いだ」と主張したが、**縮めただけで塞いではいなかった。**
 * `run_started_at` も「実際に走り始めた時刻」でしかなく、ランナーが
 * 混雑してキューに長く並べば、その分だけ `created_at` から遅れる ——
 * rerun がキューで長く待たされているあいだに、無関係な**別の run**
 * （本当に新しい世代で、結論が違う）が先に作られて先に完了しうる、という
 * #1761 と同じ形の窓を、「rerun の完了を待つ間」から「rerun がキューで
 * 待たされる間」へ**移しただけ**だった（再現は
 * `scripts/check-pr-green-1778-queued-rerun-open-side.repro.test.ts`）。
 *
 * ⟹ **違う時刻（作成・実行開始・完了のどれでも）を比べて、どちらが新しい
 * 世代かを時刻だけで当てにいく形そのものをやめる。** 同じ `name + event`
 * の run のうち、**再実行された run（`run_attempt > 1`）が絡み、かつ
 * 結論（`conclusion`）が食い違うとき**は、この `effectiveTimestamp` /
 * `newerRun` へ進ませず、`pickLatestRunPerWorkflow` の時点で「判定できない」
 * という第3の状態（verdict `undecidable-rerun-conflict`。下の
 * `hasRerunConflict` / `makeRerunConflictMarker` を見よ）へ倒す。
 * **結論が揃っている**（rerun が絡んでも全部 `success` 等）ときは、
 * どちらを選んでも答えは変わらないので、これまでどおりこの関数
 * （rerun のときだけ `run_started_at`、それ以外は `created_at`）で選んで
 * よい —— #933 / #997 / #1126 の実測はそのまま壊れない。**rerun が絡まない**
 * 比較も、これまでどおり `created_at` で選ぶ（この節は rerun が絡み、
 * かつ結論が食い違う場合だけに効く）。
 *
 * ⚠️ **#1748 の実例（sha `031bf92…`。draft 由来の `skipped` と、rerun 後の
 * `success`）は、この方針だと `undecidable-rerun-conflict` になる。**
 * `skipped` と `success` は結論として食い違うと数えるためである。これは
 * 「緑でないのに green と言う」（開く側）よりは安全側だが、「緑だと
 * 確定できるのに判定できないと言う」という閉じる側の再発ではある ——
 * `run_started_at` を選んだ #1761 のときと同じ非対称（開く側より閉じる側
 * に倒れるほうを選ぶ）を、ここでも踏襲している。draft 由来の `skipped` を
 * 「食い違い」に数えない、というより良い線があるかもしれない（例: 同じ
 * 鍵に `success` が1つでもあれば `skipped` は比較に混ぜない）が、**それが
 * 開く側へ倒れないと確かめられていない**ので、ここでは採らない —— 採る
 * かどうかは次にこの doc を読む者（人間）が決める。
 */
function effectiveTimestamp(run) {
  const attempt = run.run_attempt ?? 1;
  const key = attempt > 1 ? (run.run_started_at ?? run.created_at) : run.created_at;
  return Date.parse(key);
}

/**
 * 2つの run のうち新しいほうを返す。
 *
 * 第一キーは `effectiveTimestamp`（rerun のときだけ `run_started_at`、
 * それ以外は `created_at`。上の doc）。同秒で並んだときは `created_at`
 * そのもの、それも同じなら `id`（run 自身の id。job の id ではない）で
 * 決める —— この標本では run の `id` は作成順と一致した
 * （`34743503505` < `34743508004`）。
 */
function newerRun(a, b) {
  const ea = effectiveTimestamp(a);
  const eb = effectiveTimestamp(b);
  if (ea !== eb) return ea > eb ? a : b;
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (ta !== tb) return ta > tb ? a : b;
  return a.id > b.id ? a : b;
}

/**
 * `actions/runs?head_sha=` の `workflow_runs` から、**workflow 名 ＋ `event`**
 * ごとに最新の run を1本選ぶ。**同じ sha に複数 workflow が在っても、鍵ごとに
 * 独立に選ぶので他の workflow を落とさない。** 名前だけでまとめると、同じ
 * 名前で `event` が違う run（`push` と `schedule` 等）が同居したとき、後から
 * 作られたほうが先の run を追い出して隠してしまう（Issue #1225。実例は
 * このファイル冒頭の doc）。`event` を鍵に含めることで、`push` と `schedule`
 * のように互いに設計が違う run 同士は隠し合わない。
 *
 * 一方、#933 が解いた draft→ready の世代交代は、どちらも `event: pull_request`
 * なので鍵が同じになり、これまでどおり `created_at` の新しいほうが選ばれる。
 * `event` が読めない標本（テストの既定値等）は `''` として扱い、同じ名前なら
 * 同じ鍵にまとまる（安全側 —— 知らない event を別物と決めつけて run を余計に
 * 増やさない）。
 *
 * `runs` の各要素は `{ id, name, event, created_at, status, conclusion }` を
 * 持つことを前提にする（`gh api actions/runs` の実フィールドのサブセット。
 * `event` を持たない古い呼び出し元・テストとの互換のため `undefined` も許す）。
 */
/**
 * 渡された sha が「完全な40文字のコミット sha」かを見る純関数。
 *
 * ## なぜこの述語が要るか（Issue #1192 の N5 の具体形）
 *
 * `actions/runs?head_sha=<sha>` は **略記の sha を渡すと、エラーではなく
 * 空の一覧を返す。** ⟹ 呼び出し側からは「この sha に run が1つも無い」と
 * 区別が付かない。実測（2026-09-20、同じコミット `3ca63973b7da…`）:
 *
 * ```
 * 略記   → 判定できなかった —— この sha に workflow run が1つも無い
 * 完全形 → NG —— success ではない job が在る（ci = failure）
 * ```
 *
 * ⟹ ⭐ **赤いコミットが「CI が走っていない」に化ける。** どちらも終了コードは
 * 1（fail-closed）なので緑には化けないが、**読み手は別の結論を引く** ——
 * 実際にこの誤読が起きている（2026-09-20、マネージャー層が「6件とも
 * no-runs」と報告し、完全形で引き直して6件とも `red` だと訂正した）。
 *
 * ⟹ `no-runs` は2つの意味を背負っている ——「本当に run が無い」と
 * 「引けない入力を渡された」である。**後者を別の状態として分ける**のが
 * この述語の役目である（`AGENTS.md`「取れない軸に 0 の行を作らない」/
 * 「『判定できない』という3つ目の状態を持つ」の具体形）。
 *
 * ⚠️ **短縮形を自分で展開しない。** 展開には repo か API への問い合わせが
 * 要り、この関数の外側（ネットワーク層）の仕事になる。ここは**拒む**だけで、
 * 呼び出し側に完全形を要求する。
 *
 * @param {unknown} sha
 * @returns {boolean}
 */
export function isFullCommitSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha);
}

/**
 * 同じ `name + event` の鍵にまとまった run の集合が、「rerun が絡み、かつ
 * 結論が食い違う」ため時刻の比較で世代を選んではいけない標本かを見る
 * （15回目の横断レビュー。`effectiveTimestamp` の doc「⭐ 15回目の横断
 * レビュー」を見よ）。
 *
 * - **2本未満なら食い違いようがない。** false。
 * - **どれか1本でも `status !== 'completed'`（まだ走っている）なら、この
 *   関数の仕事ではない。** false を返し、`pending` の判定（`evaluatePrGreen`）
 *   にまかせる——「未完了」と「食い違い」を混ぜない。
 * - **`run_attempt > 1` の run が1本も無ければ、rerun は絡んでいない。**
 *   false。この場合は「rerun が絡まない場合はこれまでどおり `created_at`」
 *   という既存の約束（#933 / #997 / #1126）をそのまま守る。
 * - **`conclusion` が全部同じなら「食い違い」ではない。** false。rerun が
 *   絡んでも結論が揃っているなら、どちらを選んでも答えは変わらない。
 *
 * 上のどれにも当たらない（2本以上・全部 completed・rerun が絡む・
 * `conclusion` が割れている）ときだけ true。
 *
 * @param {{status:string, run_attempt?:number, conclusion:string|null}[]} sameKeyRuns
 * @returns {boolean}
 */
function hasRerunConflict(sameKeyRuns) {
  if (sameKeyRuns.length < 2) return false;
  if (!sameKeyRuns.every((run) => run.status === 'completed')) return false;
  const hasRerun = sameKeyRuns.some((run) => (run.run_attempt ?? 1) > 1);
  if (!hasRerun) return false;
  const conclusions = new Set(sameKeyRuns.map((run) => run.conclusion));
  return conclusions.size > 1;
}

/**
 * `hasRerunConflict` は `sameKeyRuns.every(status === 'completed')` を前提に
 * 発火する。**全部完了していなければ発火せず、`newerRun` / `effectiveTimestamp`
 * による時刻の比較へフォールバックしていた——ここにも開く側の穴が残る**
 * （PR #1801 のレビューコメントで指摘された）。
 *
 * ## 具体形
 *
 * - run A: rerun（`run_attempt=2`）が待ち行列で長く待たされたあと、
 *   `success` で完了した（`run_started_at` が遅い）。
 * - run B: A の再実行を頼んだ**あと**に作られた、本当に新しい世代の run
 *   （`run_attempt=1`）。**まだ `in_progress`**——あとで `failure` になる
 *   予定だが、その結論はまだ確定していない。
 *
 * `effectiveTimestamp` は A に `run_started_at`（実行開始時刻）を、B に
 * `created_at` を使って比べる。**A の `run_started_at` が B の `created_at`
 * より後なら、`newerRun` は A を「新しい」と選ぶ**——`pickLatestRunPerWorkflow`
 * は同じ鍵につき1本しか残さないので、**B（まだ結論が出ていない、しかも
 * あとで failure になる run）がまるごと捨てられる。** ⟹ B がまだ走って
 * いるのに `green` と言ってしまう。
 *
 * ## なぜ「食い違い」ではなく「保留」か
 *
 * `hasRerunConflict` は「結論（`conclusion`）が食い違う」ことを条件にするが、
 * `conclusion` が確定していない（`status !== 'completed'`）run を混ぜて
 * 比べても、**食い違っているかどうか自体が判定できない**——B が待てば
 * `success` で終わる可能性もまだ残っている（その場合、結論は食い違わない）。
 * 一方 `pending` の既存の意味（`evaluatePrGreen` の doc）は「まだ完了して
 * いない run が在る——待てば決まる」であり、ここの状況にそのまま当てはまる。
 * ⟹ **この関数が発火した鍵は、時刻で選ばず、`sameKeyRuns` のうち
 * 完了していない run をそのまま `pickLatestRunPerWorkflow` の戻り値へ残す**
 * （`makeRerunConflictMarker` のような専用の目印は作らない——`evaluatePrGreen`
 * が最初から持っている `status !== 'completed'` の `pending` 判定が、素の
 * run オブジェクトのままでそのまま拾う）。完了済みの run（A）は、この回の
 * 判定からは落とす——`pending` は最初に返って早期リターンするため、A の
 * jobs を見ても判定には使われない。
 *
 * ## 歯・変異
 *
 * 歯: `scripts/check-pr-green.test.ts`「PR #1801 レビュー: rerun が絡む鍵に
 * 未完了の run が混じると green ではなく pending」。変異: この関数を
 * 常に `false` を返す形に変えると（＝この分岐を外すと）、その歯が
 * green を検出して赤くなる（`mutate.mjs apply`/`restore` で確認）。
 *
 * @param {{status:string, run_attempt?:number}[]} sameKeyRuns
 * @returns {boolean}
 */
function hasUnresolvedRerunGroup(sameKeyRuns) {
  if (sameKeyRuns.length < 2) return false;
  const hasRerun = sameKeyRuns.some((run) => (run.run_attempt ?? 1) > 1);
  if (!hasRerun) return false;
  return sameKeyRuns.some((run) => run.status !== 'completed');
}

/**
 * `hasRerunConflict` が発火した鍵を、`evaluatePrGreen` が読める「run 風」の
 * 目印付きオブジェクトへ畳む。
 *
 * **`id: null`** —— この鍵のどの run の jobs を見るべきかを、この道具は
 * もう決めない、という宣言そのものである。ネットワーク層
 * （`check-pr-green.mjs`）は `rerunConflict` の有無を見て、jobs の問い合わせを
 * 丸ごとスキップする（`id: null` で `actions/runs/null/jobs` を叩かない
 * ための目印でもある）。
 *
 * `rerunConflict` には、食い違っている run 全部の `id` / `run_attempt` /
 * `conclusion` を積む——`evaluatePrGreen` が detail として「何を見れば
 * 決められるか」を出力するために使う。
 *
 * @param {{id:number, name:string, event?:string, run_attempt?:number, conclusion:string|null}[]} sameKeyRuns
 */
function makeRerunConflictMarker(sameKeyRuns) {
  const [{ name, event }] = sameKeyRuns;
  return {
    id: null,
    name,
    event,
    rerunConflict: sameKeyRuns
      .map((run) => ({
        id: run.id,
        run_attempt: run.run_attempt ?? 1,
        conclusion: run.conclusion ?? null,
      }))
      .sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0)),
  };
}

export function pickLatestRunPerWorkflow(runs) {
  const byKey = new Map();
  for (const run of runs) {
    const key = `${run.name}\u0000${run.event ?? ''}`;
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [run]);
    else list.push(run);
  }
  const picked = [];
  for (const sameKeyRuns of byKey.values()) {
    if (hasRerunConflict(sameKeyRuns)) {
      picked.push(makeRerunConflictMarker(sameKeyRuns));
      continue;
    }
    if (hasUnresolvedRerunGroup(sameKeyRuns)) {
      // 時刻では選ばない（`hasUnresolvedRerunGroup` の doc）。完了していない
      // run だけを残し、`evaluatePrGreen` 既存の pending 判定（下）に委ねる。
      // 完了済みの run はこの回の判定には使わないので落とす。
      for (const run of sameKeyRuns) {
        if (run.status !== 'completed') picked.push(run);
      }
      continue;
    }
    picked.push(sameKeyRuns.reduce((a, b) => newerRun(a, b)));
  }
  return picked.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return (a.event ?? '').localeCompare(b.event ?? '');
  });
}

/**
 * `actions/runs?head_sha=` の応答から、判定に含める run を `event` で絞る
 * （Issue #1207 の (3) の自己参照バグの修正）。
 *
 * ## なぜこれが要るか
 *
 * `head_sha` だけで `actions/runs` を引くと、**その sha を名乗るあらゆる
 * event の run が一緒に返る。** `main` の直近コミットに対しては、`push`
 * （`ci.yml`）だけでなく `schedule` / `workflow_dispatch`
 * （`release-prod.yml` 自身・`update-claude-sdk.yml`）や `workflow_run`
 * （`main-ci-alarm.yml`）の run も同じ head_sha を名乗る——`schedule` /
 * `workflow_dispatch` の run は「そのとき指しているデフォルトブランチの
 * 先端」を `head_sha` として持つためである。
 *
 * `record-release-prod-ci.mjs` はこの `judgeSha` を**反映を行っている
 * `release-prod.yml` 自身のジョブの中から**呼ぶ。⟹ 絞らずに呼ぶと、
 * `pickLatestRunPerWorkflow` が拾う「release/prod へ反映」という名前の
 * run の中に**呼び出し元自身の run**が含まれ、その run はまだ
 * `in_progress`（記録 step が動いている真っ最中なので当然完了していない）
 * ——`evaluatePrGreen` の「未完了の run が1本でもあれば `pending`」に
 * 引っかかり、**実行するたびに自分自身を理由に `pending` を返す。**
 * 実測（2026-09-19T21:28:57Z 観測、run `35470533724`、sha
 * `fa9ec3e380fbe9dad8a3d1ad3e6c43c0639d5cb6`）:
 *
 * ```
 * release-prod-ci-record: verdict=pending prod_sha=fa9ec3e3... main_sha=fa9ec3e3... reflect=success
 * check-pr-green(fa9ec3e3...): 保留 —— まだ完了していない run が在る
 *   release/prod へ反映 (run 35470533724) は status=in_progress でまだ終わっていない
 * ```
 *
 * ⟹ 「まだ終わっていない run」は、このログを出している run 自身であり、
 * この形は**毎晩100%再現する**（`release-prod.yml` が走るたびに、自分の
 * run が必ず自分の head_sha に載るため）。
 *
 * ## なぜ「自分の run id だけを除く」では足りないか
 *
 * `GITHUB_RUN_ID` で自分の run 1本だけを弾く案は、**前夜の
 * `workflow_dispatch`（本番をいま確かめたい等で手動起動した反映）が同じ
 * sha に残っている**場合に、自分ではない別の「release/prod へ反映」の run
 * （これも `schedule`/`workflow_dispatch` なので判定に無関係）が判定へ
 * 混ざる穴を残す。**「どの run を除くか」ではなく「そもそもどの event の
 * run を見るか」を絞る**のがこの穴を構造的に塞ぐ唯一の形である。
 *
 * ## なぜ `event=push` に絞るか
 *
 * 判定したいのは「その sha の `main` の CI」であって「その sha に紐づく
 * 全部の run」ではない。`main` への push で実際に起動する workflow は
 * `ci.yml`（`on: push: branches: [main]`）だけであり（他はすべて
 * `pull_request` / `schedule` / `workflow_dispatch` / `workflow_run`）、
 * `event=push` に絞ればこれ以外は構造的に外れる——`release-prod.yml`
 * （schedule/workflow_dispatch）も `main-ci-alarm.yml`（workflow_run）も
 * `update-claude-sdk.yml`（schedule/workflow_dispatch）も、event が
 * 一致しないので最初から候補に入らない。
 *
 * ## 既定は絞らない
 *
 * `events` を渡さない（`undefined` / `null`）呼び出しは**この関数を通っても
 * 1件も落とさない**——`scripts/check-pr-green.mjs` の CLI や他の既存の
 * 呼び出し元の挙動を1ミリも変えないため。絞り込みを使うのは、絞る理由を
 * 持つ呼び出し元（`record-release-prod-ci.mjs`）だけである。
 *
 * @param {{event?: string}[]} runs
 * @param {string[] | undefined | null} events 許可する event の一覧（例: `['push']`）。
 *   省略時は絞らない。
 */
export function filterRunsByEvent(runs, events) {
  if (events === undefined || events === null) return runs;
  const allowed = new Set(events);
  return runs.filter((run) => allowed.has(run.event));
}

/**
 * 選んだ最新 run 群と、それぞれの jobs から、この sha の CI が緑と言えるかを
 * 判定する。**9値で答える**（`green` / `red` / `cancelled` / `out-of-scope` /
 * `skipped` / `undecidable-rerun-conflict` / `pending` / `unmeasurable` /
 * `no-runs`）。2値にすると「まだ走っている」と「実は赤」が同じ側へ丸まる
 * （`AGENTS.md`「静かに失敗する道具」の3値の原則と同じ形）。Issue #1197
 * 以降は非 success をさらに `red` / `cancelled` / `out-of-scope` / `skipped`
 * の4本へ分ける—— `conclusion !== 'success'` の1本判定は、マージ直後の
 * main（push の run。`base-overlap` は pull_request 専用で設計どおり
 * skipped）を「壊した」と読ませていた。15回目の横断レビューで
 * `undecidable-rerun-conflict` を足した（`pickLatestRunPerWorkflow` の
 * `hasRerunConflict` / `makeRerunConflictMarker` の doc を見よ）——rerun
 * が絡み結論が食い違う run を、時刻の比較でどちらかへ選ばずに「判定
 * できない」と言うための第3の状態。PR #1801 のレビューで、rerun が絡む
 * 鍵に未完了の run が混ざる場合（結論そのものがまだ確定していないので
 * 「食い違い」とは呼べない）も見つかり、こちらは新しい verdict を足さず
 * **既存の `pending`** へ倒した（`pickLatestRunPerWorkflow` の
 * `hasUnresolvedRerunGroup` の doc）。
 *
 * @param {{name:string,id:number|null,status?:string,conclusion?:string|null,rerunConflict?:object[]}[]} latestRuns
 *   `pickLatestRunPerWorkflow` の戻り値（`rerunConflict` を持つ要素は
 *   `hasRerunConflict` が発火した鍵——`id` が `null` で `status` を持たない）
 * @param {Record<number, {name:string,status:string,conclusion:string|null}[]>} jobsByRunId
 *   run の id → その run の jobs（`actions/runs/<id>/jobs` の `.jobs`）
 */
export function evaluatePrGreen(latestRuns, jobsByRunId) {
  if (latestRuns.length === 0) {
    return { verdict: 'no-runs', detail: [] };
  }

  // 15回目の横断レビュー: rerun が絡み結論が食い違う鍵は、pending/noJobs の
  // どの判定よりも先に見る——`rerunConflict` を持つ要素は `status` を持たず
  // （`makeRerunConflictMarker`）、下の pending フィルタ（`status !==
  // 'completed'`）に通すと `undefined !== 'completed'` で誤って `pending`
  // に化ける。
  const rerunConflicts = latestRuns.filter((r) => r.rerunConflict !== undefined);
  if (rerunConflicts.length > 0) {
    return {
      verdict: 'undecidable-rerun-conflict',
      detail: rerunConflicts.flatMap((r) => [
        `${r.name}${r.event !== undefined ? `（event=${r.event}）` : ''}: ` +
          '再実行（run_attempt>1）が絡む run 同士で結論が食い違う —— ' +
          'どちらが最新世代かは時刻の比較（created_at / run_started_at / updated_at のどれでも）では決められない',
        ...r.rerunConflict.map(
          (x) => `  run ${x.id}（run_attempt=${x.run_attempt}）= ${x.conclusion ?? '(unknown)'}`,
        ),
        '  確かめるには: gh pr view <PR番号> --json mergeStateStatus と、上に並べた各 run の id・run_attempt・結論を直接見ること',
      ]),
    };
  }

  const pending = latestRuns.filter((r) => r.status !== 'completed');
  if (pending.length > 0) {
    return {
      verdict: 'pending',
      detail: pending.map(
        (r) => `${r.name} (run ${r.id}) は status=${r.status} でまだ終わっていない`,
      ),
    };
  }

  // AGENTS.md「静かに失敗する道具」#2: ジョブを1本も実行していない run の
  // conclusion は、コードについて何も言っていない。
  const noJobs = latestRuns.filter((r) => (jobsByRunId[r.id] ?? []).length === 0);
  if (noJobs.length > 0) {
    return {
      verdict: 'unmeasurable',
      reason: 'no-jobs',
      detail: noJobs.map(
        (r) => `${r.name} (run ${r.id}) は jobs が0件 —— 実際に実行されたか確認できない`,
      ),
    };
  }

  const jobs = latestRuns.flatMap((r) =>
    (jobsByRunId[r.id] ?? []).map((j) => ({ ...j, workflow: r.name, runId: r.id })),
  );

  const toDetail = (list) =>
    list.map(
      (j) => `${j.name}（workflow=${j.workflow}, run=${j.runId}）= ${j.conclusion ?? j.status}`,
    );

  const nonSuccessJobs = jobs.filter((j) => j.conclusion !== 'success');
  if (nonSuccessJobs.length === 0) {
    return {
      verdict: 'green',
      detail: jobs.map((j) => `${j.name}（workflow=${j.workflow}, run=${j.runId}）= success`),
    };
  }

  // Issue #1197: 従来はここで `conclusion !== 'success'` の1本判定に丸め、
  // failure / cancelled / skipped を全部同じ「NG」へ落としていた。それが
  // マージ直後の main（push の run。base-overlap は pull_request 専用なので
  // 設計どおり skipped）を「壊した」と読ませた。ここから先は非 success を
  // 4本の枝へ分ける。**detail にはどの枝でも非 success の job を全部並べる
  // （隠さない）——赤を skip や cancelled の陰に隠さないため。**

  // 1. red —— cancelled でも skipped でもない非 success
  //    （failure / timed_out / action_required / startup_failure / stale 等）
  //    が1本でも在れば、それだけで赤と言い切れる。優先度は最上位——
  //    cancelled や skipped が同居していても red が勝つ。
  const redJobs = nonSuccessJobs.filter(
    (j) => j.conclusion !== 'cancelled' && j.conclusion !== 'skipped',
  );
  if (redJobs.length > 0) {
    return { verdict: 'red', detail: toDetail(nonSuccessJobs) };
  }

  // 2. cancelled —— red が無く、cancelled が1本以上。「赤ではない、走り
  //    切っていない」。skipped が同居していても cancelled を名乗る
  //    （何かが実際に中断されたという情報のほうが強い）。
  const cancelledJobs = nonSuccessJobs.filter((j) => j.conclusion === 'cancelled');
  if (cancelledJobs.length > 0) {
    return { verdict: 'cancelled', detail: toDetail(nonSuccessJobs) };
  }

  // ここから先、nonSuccessJobs は全部 skipped。
  const nonSkippedJobs = jobs.filter((j) => j.conclusion !== 'skipped');
  // `pickLatestRunPerWorkflow` は run オブジェクトをそのまま通す（フィールドを
  // 絞らない）ので、`gh api actions/runs` が返す `event`（"push" /
  // "pull_request" / "schedule" 等）もここでそのまま読める。
  const allEventsKnown = latestRuns.every((r) => r.event !== undefined);
  const anyPullRequestRun = latestRuns.some((r) => r.event === 'pull_request');

  // 3. out-of-scope —— 最新 run のどれもが pull_request イベントではないと
  //    分かっている（event が読めている）とき、pull_request 専用 job の
  //    skip は設計どおりである。この道具は PR 用であり、対象外だと名乗る。
  //    ⚠ 「skip 以外はすべて success」が空虚な主張にならないよう、実行された
  //    （skipped でない）job が1本も無いとき（例: schedule で `ci` が丸ごと
  //    skip される run）は out-of-scope と名乗らず unmeasurable へ落とす。
  if (allEventsKnown && !anyPullRequestRun) {
    if (nonSkippedJobs.length === 0) {
      return { verdict: 'unmeasurable', reason: 'all-skipped', detail: toDetail(nonSuccessJobs) };
    }
    return { verdict: 'out-of-scope', detail: toDetail(nonSuccessJobs) };
  }

  // 4. skipped —— pull_request の run が在る（または event が undefined で
  //    pull_request ではないと判定できない——安全側）。draft 由来の skip の
  //    疑いを含むので、ここは絶対に緑にしない。
  return { verdict: 'skipped', detail: toDetail(nonSuccessJobs) };
}

/**
 * required contexts の宣言（`.github/required-status-checks.json` の
 * `contexts`）に対し、**そもそも job として1本も観測されなかった**門を
 * 列挙する（Issue #1290。2026-09-22 の事故 —— 必須チェックを出す workflow
 * が GitHub 上で `disabled_manually` にされ、その門の check-run が永久に
 * 生成されなくなった。`evaluatePrGreen` は「観測できた job」だけを見て
 * `green` を返すため、生成されなかった門は行として存在せず、判定から
 * 静かに抜け落ちる）。
 *
 * ## これは `evaluatePrGreen` の8値とは別の軸である
 *
 * `evaluatePrGreen` は「pending な run が無い」ことを前提に、非 success を
 * `red`/`cancelled`/`out-of-scope`/`skipped` へ分ける構造を持つ
 * （Issue #1197）。この関数が見ているのはその手前 ——
 * **「required な門の job がそもそも1件も観測されなかった」** という、
 * pending とも non-success とも違う独立した軸である。⟹ `evaluatePrGreen`
 * の switch に9番目の分岐として混ぜ込まない —— 8値の意味論
 * （とくに世代選びの鍵。#1225 / PR #1227）に触れずに済ませるためで
 * あり、#1197 が一度「軸を混ぜて丸める」過ちを犯した経緯を繰り返さない
 * ためでもある。呼び出し側（CLI）が、この関数の結果と
 * `evaluatePrGreen` の結果を**並べて**報告する。
 *
 * ## 不活性にする条件（`status: 'inactive'` を返す）
 *
 * - **`scoped`**（`events` で絞った呼び出し。例:
 *   `record-release-prod-ci.mjs` の `events: ['push']`）—— その絞り込みは
 *   `pull_request` 専用の run を意図的に落とすので、そのまま当てると
 *   `no-attribution-trailers` のような `pull_request` 専用門を「走って
 *   いない」と誤判定する。**これは真の欠落ではない。**
 * - **`crossRepo`**（`--repo` で既定の `takecchi/alteroid` 以外の repo を
 *   指定した呼び出し。INV7）—— `requiredContexts` はこのチェックアウトの
 *   `.github/required-status-checks.json` から読んでいる。**この宣言は
 *   `takecchi/alteroid` の required contexts であって、他の repo の required
 *   contexts ではない。** 他の repo の sha にそのまま当てると、「その repo に
 *   在る門」を「無い」と誤判定する——不活性にするのはその repo に required な
 *   門が何かをこちらが知らないからであって、判定を保留しているわけではない。
 *   **黙って何も言わずに消えると「門が全部在る」（＝ this Issue そのものの
 *   形）と読めるので、不活性である理由を出力で必ず名乗る**（呼び出し側の仕事）。
 * - **`verdict` が `pending`**—— `judgeSha` は `status !== 'completed'`
 *   の run の jobs を問い合わせない（無駄なので）。⟹ jobsByRunId には
 *   「まだ走っている門」と「生成されなかった門」が同じ「観測されて
 *   いない」として現れ、機械的に区別できない。区別できないものを
 *   「無い」と言わない。
 * - **`verdict` が `out-of-scope` / `no-runs` / `unmeasurable`**——
 *   同様に「required な job の集合が確定できた」と言えない状態
 *   （push 専用 sha・run が0本・全 job が skip の合成標本 等）。
 *
 * ## `skipped` は「在る」側（INV4）
 *
 * ここでは `conclusion` を一切見ず、job の `name` の**有無**だけを見る。
 * GitHub は `conclusion: skipped` を required の判定で「満たした」ものと
 * して扱う（逐語は `.github/workflows/ci.yml` の該当行）。`skipped` を
 * 「run が無い」と混同すると、draft 明けの正常系や `base-overlap` のような
 * 条件付き job まで誤検知する。
 *
 * ## 実測での回帰（Issue #1290 のコメント。sha `b217ba51f781a4224a095257b5f1546261b24911`、PR #859、2026-09-11）
 *
 * `no-attribution-trailers` という門がまだ存在しなかった時代の sha。実測
 * （`gh api repos/takecchi/alteroid/actions/runs?head_sha=b217ba51…`）では
 * `CI` の run（`34655158167`）1本だけが最新世代で、jobs は
 * `base-overlap` / `ci` / `image` / `pr-origin` の4本ともすべて `success`
 * ——つまり `evaluatePrGreen` は `green` を返す。だが `requiredContexts` に
 * `no-attribution-trailers` を含めて渡すと、この sha にはその名前の job が
 * 1本も存在しないので `missing: ['no-attribution-trailers']` になる。**この
 * 標本がまさに「required なのに run が1本も無い門」を静かに見逃していた
 * 実例**であり、`check-pr-green.missing-required-gates.test.ts` の
 * 「実測の回帰（PR #859）」がこの標本をそのまま固定している。
 *
 * @param {{
 *   requiredContexts: string[],
 *   verdict: string,
 *   scoped: boolean,
 *   crossRepo: boolean,
 *   latestRuns: {id:number}[],
 *   jobsByRunId: Record<number, {name:string}[]>,
 * }} input
 * @returns {{status:'inactive', reason:string} | {status:'checked', missing:string[]}}
 */
export function findMissingRequiredGates({
  requiredContexts,
  verdict,
  scoped,
  crossRepo,
  latestRuns,
  jobsByRunId,
}) {
  if (scoped) {
    return {
      status: 'inactive',
      reason:
        'events で絞った呼び出し（例: record-release-prod-ci.mjs の events:["push"]）のため判定しない',
    };
  }

  if (crossRepo) {
    return {
      status: 'inactive',
      reason:
        '--repo が既定（takecchi/alteroid）以外のため判定しない —— required contexts の宣言はこの repo のものであり、他の repo には当てられない',
    };
  }

  // 15回目の横断レビュー: `undecidable-rerun-conflict` も「required な job の
  // 集合が確定できた」と言えない状態に加える——`makeRerunConflictMarker` は
  // `id: null` を持ち jobs を取りに行かないので、その鍵の required な門は
  // 実際には走っていたとしても `observedNames` に載らない。載せないまま
  // ここへ進むと「required なのに run が無い」と誤って名指しする。
  const INACTIVE_VERDICTS = new Set([
    'pending',
    'out-of-scope',
    'no-runs',
    'unmeasurable',
    'undecidable-rerun-conflict',
  ]);
  if (INACTIVE_VERDICTS.has(verdict)) {
    return { status: 'inactive', reason: `verdict=${verdict} のため判定しない` };
  }

  const observedNames = new Set(
    latestRuns.flatMap((run) => (jobsByRunId[run.id] ?? []).map((job) => job.name)),
  );
  const missing = requiredContexts.filter((name) => !observedNames.has(name));
  return { status: 'checked', missing };
}

/**
 * `evaluatePrGreen` 自身の判定を、**単独の判定としては読めない従属節**へ
 * 畳む（`findMissingRequiredGates` が発火したときだけ使う内部ヘルパー）。
 *
 * ## なぜこれが要るか（INV6）
 *
 * `formatVerdict` がそのまま出す `check-pr-green(sha): OK —— …` は、**道具名
 * で始まり `OK`/`NG` で終わる、単独の判定として読める行**である。required
 * な門が欠けている（`findMissingRequiredGates` が発火した）ときにこの行を
 * そのまま並べて出すと、**1行目で NG と言った直後に2行目で `OK` と言う
 * 出力になる。** `OK` で grep する読み手（人間にもエージェントにも実在する）
 * は、この2行目だけを見て緑だと誤読する——exit code が 1 であることは、
 * この誤読を防がない（テキストを読む経路には exit code が乗らない）。
 * ⟹ **単独の判定として読めない形にする**——道具名のプレフィックスを外し、
 * 「欠落があるため、この結果だけでは緑の根拠にならない」という前提を
 * 文の中に埋め込む。
 */
function subordinateEvaluateClause(result) {
  switch (result.verdict) {
    case 'green':
      return (
        '（参考: この欠落とは別に、観測できた門はすべて success だった —— ' +
        'ただし上の欠落がある以上、これは緑の根拠にならない）'
      );
    case 'red':
      return '（加えて、観測できた門にも success ではない job が在り、それだけでも緑ではない）';
    case 'cancelled':
      return '（加えて、観測できた門に中断された job が在り、走り切っていない）';
    case 'skipped':
      return '（加えて、観測できた門に draft 由来の疑いが在る skip が残っている）';
    default:
      // findMissingRequiredGates は pending/out-of-scope/no-runs/unmeasurable
      // では常に inactive を返すため、ここに来ることは無いはずだが、
      // 未知の verdict を黙って握り潰さない（AGENTS.md「静かに失敗する道具」）。
      return `（evaluatePrGreen 側の判定: ${result.verdict}）`;
  }
}

/**
 * `findMissingRequiredGates` が `checked` かつ `missing` を1件以上返したときの
 * 警告文を作る。**1行目で欠けている門を名指しする**（`AGENTS.md`「静かに
 * 失敗する道具」）。
 *
 * ⚠️ **この検査が見ているのは `.github/required-status-checks.json` の
 * 宣言であって、branch protection そのものではない。** 宣言と実際の
 * protection がずれていないかは `pnpm check:required-status-checks` が見る
 * （別の道具。ここでは突き合わせない）。
 *
 * `result`（`evaluatePrGreen` の戻り値）を渡すと、その判定を**従属節として**
 * 追記する——`formatVerdict(sha, result)` をそのまま並べない（INV6。上の
 * `subordinateEvaluateClause` の doc を見よ）。`result` を渡さない呼び出しは
 * 欠落の警告だけを返す。
 */
export function formatMissingRequiredGates(sha, missingNames, result) {
  const lines = [
    `check-pr-green(${sha}): NG —— required（.github/required-status-checks.json の宣言。branch protection そのものではない）なのに run が1本も無い門: ${missingNames.join(', ')}`,
    '宣言と実際の branch protection がずれていないかは pnpm check:required-status-checks が見る（ここでは突き合わせない）',
  ];
  if (result !== undefined && result !== null) {
    lines.push(subordinateEvaluateClause(result));
    lines.push(...result.detail);
  }
  return lines.join('\n  ');
}

/**
 * 判定を、人が読んで次の一手が決まる文へ畳む。
 */
export function formatVerdict(sha, result) {
  const header = `check-pr-green(${sha}):`;
  switch (result.verdict) {
    case 'no-runs':
      return `${header} 判定できなかった —— この sha に workflow run が1つも無い`;
    case 'pending':
      return [`${header} 保留 —— まだ完了していない run が在る`, ...result.detail].join('\n  ');
    case 'unmeasurable': {
      const reasonText =
        result.reason === 'all-skipped'
          ? 'job がすべて skipped で、success だったと言える job が1本も無い'
          : 'jobs が0件の run が在り、実行されたか確認できない';
      return [`${header} 判定できなかった —— ${reasonText}`, ...result.detail].join('\n  ');
    }
    case 'red':
      return [`${header} NG —— success ではない job が在る`, ...result.detail].join('\n  ');
    case 'cancelled':
      return [
        `${header} 判定できなかった —— 中断された job が在る（赤ではない。走り切っていない）`,
        ...result.detail,
      ].join('\n  ');
    case 'out-of-scope':
      return [
        `${header} 対象外 —— この道具は PR 用である。対象 sha は PR の run を持たない（event=push 等）。pull_request 専用の job は設計どおり skip される。skip 以外の job はすべて success だった`,
        ...result.detail,
      ].join('\n  ');
    case 'skipped':
      return [
        `${header} NG —— skipped の job が在る（draft 由来の skip の疑いがある。緑と数えない）`,
        ...result.detail,
      ].join('\n  ');
    case 'undecidable-rerun-conflict':
      return [
        `${header} 判定できなかった —— 再実行(run_attempt>1)が絡む run 同士で結論が食い違い、どちらが最新世代かを時刻の比較では決められない`,
        ...result.detail,
      ].join('\n  ');
    case 'green':
      return [`${header} OK —— 最新世代の job がすべて success`, ...result.detail].join('\n  ');
    default:
      return `${header} 未知の verdict: ${result.verdict}`;
  }
}

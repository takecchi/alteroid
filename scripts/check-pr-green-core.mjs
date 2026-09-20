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
 * **workflow 名ごとに `created_at`（同値なら `id`）で最新の run を選び**、
 * **その run 自身の `actions/runs/<id>/jobs` を読む**。
 *
 * ⚠️ **これで「確定」ではない。** 実測できたのは1 sha・2世代・1 workflow・
 * 4ジョブの標本だけである（`check-pr-green.test.ts` のコメント参照）。
 * 再実行（`rerun`）で3世代目が生える場合、`pull_request` と
 * `workflow_dispatch` が混ざる場合は測っていない。
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
 * 2つの run のうち新しいほうを返す。
 *
 * `created_at` を第一キーにする —— `actions/runs` 応答が返す `created_at` は
 * GitHub が run を作った実測の時刻で、`check-runs` の `started_at`（job が
 * 実際に走り出した時刻。`if:` で後段になった job ほど遅れる）とは別物である。
 * 同秒で並んだときだけ `id`（run 自身の id。job の id ではない）で決める —
 * この標本では run の `id` は作成順と一致した（`34743503505` <
 * `34743508004`）。
 */
function newerRun(a, b) {
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

export function pickLatestRunPerWorkflow(runs) {
  const byKey = new Map();
  for (const run of runs) {
    const key = `${run.name}\u0000${run.event ?? ''}`;
    const prev = byKey.get(key);
    byKey.set(key, prev === undefined ? run : newerRun(prev, run));
  }
  return [...byKey.values()].sort((a, b) => {
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
 * 判定する。**8値で答える**（`green` / `red` / `cancelled` / `out-of-scope` /
 * `skipped` / `pending` / `unmeasurable` / `no-runs`）。2値にすると「まだ
 * 走っている」と「実は赤」が同じ側へ丸まる（`AGENTS.md`「静かに失敗する道具」
 * の3値の原則と同じ形）。Issue #1197 以降は非 success をさらに
 * `red` / `cancelled` / `out-of-scope` / `skipped` の4本へ分ける——
 * `conclusion !== 'success'` の1本判定は、マージ直後の main（push の run。
 * `base-overlap` は pull_request 専用で設計どおり skipped）を「壊した」と
 * 読ませていた。
 *
 * @param {{name:string,id:number,status:string,conclusion:string|null}[]} latestRuns
 *   `pickLatestRunPerWorkflow` の戻り値
 * @param {Record<number, {name:string,status:string,conclusion:string|null}[]>} jobsByRunId
 *   run の id → その run の jobs（`actions/runs/<id>/jobs` の `.jobs`）
 */
export function evaluatePrGreen(latestRuns, jobsByRunId) {
  if (latestRuns.length === 0) {
    return { verdict: 'no-runs', detail: [] };
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
    case 'green':
      return [`${header} OK —— 最新世代の job がすべて success`, ...result.detail].join('\n  ');
    default:
      return `${header} 未知の verdict: ${result.verdict}`;
  }
}

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
 * 4ジョブの標本だけである（`check-pr-green.test.ts` のコメント参照）。同じ
 * workflow 名で `workflow_dispatch` と `pull_request` が混ざる場合、
 * 再実行（`rerun`）で3世代目が生える場合は測っていない。
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
 * `actions/runs?head_sha=` の `workflow_runs` から、workflow 名ごとに最新の
 * run を1本選ぶ。**同じ sha に複数 workflow が在っても、名前ごとに独立に選ぶ
 * ので他の workflow を落とさない。**
 *
 * `runs` の各要素は `{ id, name, created_at, status, conclusion }` を持つ
 * ことを前提にする（`gh api actions/runs` の実フィールドのサブセット）。
 */
export function pickLatestRunPerWorkflow(runs) {
  const byName = new Map();
  for (const run of runs) {
    const prev = byName.get(run.name);
    byName.set(run.name, prev === undefined ? run : newerRun(prev, run));
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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

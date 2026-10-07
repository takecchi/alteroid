// check-runs を並べて世代を選ばず、`actions/runs?head_sha=` の run 一覧から選ぶ: check-run の `id` と `started_at` は run をまたぐと逆転するため。
// rerun が絡み結論が食い違うときは時刻で決めず `undecidable-rerun-conflict` を返す: どの時刻を比べても、rerun の待ち時間という新しい窓を晒すだけだったため。
// まとめる鍵は名前だけでなく名前と `event`: 名前だけだと `schedule` の run が古い `push` の run を追い出して赤を隠すため。

// rerun のときだけ `run_started_at`、それ以外は `created_at` を鍵にする: `created_at` は rerun しても動かず、`run_started_at` を常に使うと draft→ready のレースで順序を失うため。
// `updated_at` を鍵にしない: rerun の完了を待つあいだに生まれた本当に新しい世代の失敗を追い越して `green` と言ってしまうため。
// `run_started_at` が無いときは `created_at` にフォールバックする: 古く見える側にしか倒れず、開く側（誤って `green`）には倒れないため。
// check-run の `id` を世代選びの鍵にしない: `if:` の評価が遅れた job だけ id が後ろへ回り、rerun の無い draft→ready のレースで既に逆転するため。
function effectiveTimestamp(run) {
  const attempt = run.run_attempt ?? 1;
  const key = attempt > 1 ? (run.run_started_at ?? run.created_at) : run.created_at;
  return Date.parse(key);
}

function newerRun(a, b) {
  const ea = effectiveTimestamp(a);
  const eb = effectiveTimestamp(b);
  if (ea !== eb) return ea > eb ? a : b;
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (ta !== tb) return ta > tb ? a : b;
  return a.id > b.id ? a : b;
}

// 略記の sha を自分で展開せず拒む: `actions/runs?head_sha=` は略記だとエラーではなく空の一覧を返し、赤いコミットが「run が無い」に化けるため。展開は API への問い合わせが要りネットワーク層の仕事。
export function isFullCommitSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha);
}

// jobs が取れなかった run・jobs が0件の run は「1本も走っていない」とみなさない: 「取れない」を「無い」と読むと開く側へ倒れ、`unmeasurable` に落ちるべき標本を消すため。
function hasNoJobsRan(run, jobsByRunId) {
  const jobs = jobsByRunId[run.id];
  if (jobs === undefined || jobs.length === 0) return false;
  return jobs.every((job) => job.conclusion === 'skipped');
}

// ジョブが1本も走っていない run は、走って完了した run が同じ鍵に在るときだけ外す: 全部が走っていない run なら比較材料が何も残らないため。
// 「走っていない」は run の `conclusion` ではなく jobs 全件で判定する: 一部のジョブだけが走った run を取り違える余地が残るため。
function excludeNoJobsRanRuns(sameKeyRuns, jobsByRunId) {
  const hasRanCompletedRun = sameKeyRuns.some(
    (run) =>
      run.status === 'completed' &&
      jobsByRunId[run.id] !== undefined &&
      jobsByRunId[run.id].length > 0 &&
      !hasNoJobsRan(run, jobsByRunId),
  );
  if (!hasRanCompletedRun) return sameKeyRuns;
  return sameKeyRuns.filter((run) => !hasNoJobsRan(run, jobsByRunId));
}

function hasRerunConflict(sameKeyRuns) {
  if (sameKeyRuns.length < 2) return false;
  if (!sameKeyRuns.every((run) => run.status === 'completed')) return false;
  const hasRerun = sameKeyRuns.some((run) => (run.run_attempt ?? 1) > 1);
  if (!hasRerun) return false;
  const conclusions = new Set(sameKeyRuns.map((run) => run.conclusion));
  return conclusions.size > 1;
}

// rerun が絡み未完了の run が混ざる鍵は時刻で選ばず `pending` に倒す: 時刻で選ぶと、まだ走っている新しい世代が捨てられて `green` と言ってしまうため。
function hasUnresolvedRerunGroup(sameKeyRuns) {
  if (sameKeyRuns.length < 2) return false;
  const hasRerun = sameKeyRuns.some((run) => (run.run_attempt ?? 1) > 1);
  if (!hasRerun) return false;
  return sameKeyRuns.some((run) => run.status !== 'completed');
}

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

export function pickLatestRunPerWorkflow(runs, jobsByRunId = {}) {
  const byKey = new Map();
  for (const run of runs) {
    const key = `${run.name}\u0000${run.event ?? ''}`;
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [run]);
    else list.push(run);
  }
  const picked = [];
  for (const sameKeyRunsRaw of byKey.values()) {
    const sameKeyRuns = excludeNoJobsRanRuns(sameKeyRunsRaw, jobsByRunId);
    if (hasRerunConflict(sameKeyRuns)) {
      picked.push(makeRerunConflictMarker(sameKeyRuns));
      continue;
    }
    if (hasUnresolvedRerunGroup(sameKeyRuns)) {
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

// 自分の run id だけを除かず event で絞る: 前夜の `workflow_dispatch` の run が同じ sha に残っていると、別の run が判定に混ざる穴が残るため。
export function filterRunsByEvent(runs, events) {
  if (events === undefined || events === null) return runs;
  const allowed = new Set(events);
  return runs.filter((run) => allowed.has(run.event));
}

// `conclusion !== 'success'` の1本判定にしない: マージ直後の main（`base-overlap` は pull_request 専用で skipped）を「壊した」と読ませるため。
export function evaluatePrGreen(latestRuns, jobsByRunId) {
  if (latestRuns.length === 0) {
    return { verdict: 'no-runs', detail: [] };
  }

  // `rerunConflict` を持つ要素は pending/noJobs のどの判定よりも先に見る: `status` を持たず、pending フィルタに通すと誤って `pending` に化けるため。
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

  // detail にはどの枝でも非 success の job を全部並べる: 赤を skip や cancelled の陰に隠さないため。

  const redJobs = nonSuccessJobs.filter(
    (j) => j.conclusion !== 'cancelled' && j.conclusion !== 'skipped',
  );
  if (redJobs.length > 0) {
    return { verdict: 'red', detail: toDetail(nonSuccessJobs) };
  }

  const cancelledJobs = nonSuccessJobs.filter((j) => j.conclusion === 'cancelled');
  if (cancelledJobs.length > 0) {
    return { verdict: 'cancelled', detail: toDetail(nonSuccessJobs) };
  }

  const nonSkippedJobs = jobs.filter((j) => j.conclusion !== 'skipped');
  const allEventsKnown = latestRuns.every((r) => r.event !== undefined);
  const anyPullRequestRun = latestRuns.some((r) => r.event === 'pull_request');

  // 実行された job が1本も無いときは out-of-scope と名乗らず unmeasurable へ落とす: 「skip 以外はすべて success」が空虚な主張になるため。
  if (allEventsKnown && !anyPullRequestRun) {
    if (nonSkippedJobs.length === 0) {
      return { verdict: 'unmeasurable', reason: 'all-skipped', detail: toDetail(nonSuccessJobs) };
    }
    return { verdict: 'out-of-scope', detail: toDetail(nonSuccessJobs) };
  }

  // ここは緑にしない: draft 由来の skip の疑いを含むため。
  return { verdict: 'skipped', detail: toDetail(nonSuccessJobs) };
}

// `evaluatePrGreen` の switch に混ぜず別の軸にする: 世代選びの意味論に触れずに済ませ、軸を混ぜて丸める過ちを繰り返さないため。
// `conclusion` を見ず job の `name` の有無だけを見る: `skipped` を「run が無い」と混同すると、条件付き job まで誤検知するため。
// 他の repo の sha（`crossRepo`）や pending は不活性にする: 宣言は `takecchi/alteroid` の required contexts で、まだ走っている門と生成されなかった門を区別できないため。
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

  // `undecidable-rerun-conflict` も不活性にする: jobs を取りに行かないので、走っていた門を「run が無い」と誤って名指しするため。
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

// 道具名で始まる OK/NG の単独の行にしない: NG の直後に OK が並ぶと、OK で grep する読み手が緑と誤読するため。
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
      // 未知の verdict を黙って握り潰さない。
      return `（evaluatePrGreen 側の判定: ${result.verdict}）`;
  }
}

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

/**
 * `check-required-gate-workflows.mjs` の判定だけを切り出したもの
 * （`check-required-status-checks-core.mjs` と同じ分け方・同じ理由 —— 本物の
 * GitHub API を叩かずに、合成した応答で判定だけを確かめられるようにする）。
 *
 * ## 何を塞ぐために在るか（Issue #1290）
 *
 * 2026-09-22、`.github/workflows/pr-title.yml` が GitHub 上で `disabled_manually`
 * にされた。この workflow は required contexts の1本 `pr-title-type` を出して
 * いたが、無効化されると**その門の check-run は二度と生成されない**——required は
 * 「赤い」のではなく「一覧に永久に現れない」状態になり、open な PR 5本が理由も
 * 見せずに `BLOCKED` のまま静かに詰まった。
 *
 * required の門が満たされるまでの鎖は3本の環から成る:
 *
 * 1. **protection（実設定）↔ `.github/required-status-checks.json`（宣言）** ——
 *    `pnpm check:required-status-checks` が突き合わせる。**既に在る。**
 * 2. **宣言の context ↔ `.github/workflows/` 配下の実在のジョブ名** ——
 *    `scripts/ci-draft-gating.test.ts`「固定その4」が offline で固定している。
 *    **既に在る。**
 * 3. **そのジョブを載せている workflow が GitHub 上で `active` か** —— 🔴 これが
 *    無かった。**ここがこのファイルである。**
 *
 * 2本の環（1・2）だけでは、workflow がジョブ名を保ったまま丸ごと無効化される
 * 事故を検知できない——宣言も `ci.yml` 側のジョブ定義も1文字も変わらないので、
 * どちらの門も緑のままである。
 *
 * ## ⚠️ 見ているのは「宣言」であって protection ではない
 *
 * ここが読むのは `.github/required-status-checks.json` の宣言だけである。**その
 * 宣言自体が実際のブランチ保護（required contexts）と一致しているかは、この
 * 検査の仕事ではない。** あちらは `pnpm check:required-status-checks` が担う。
 * ⟹ 2本合わさって初めて「required の門は宣言どおり存在し、かつ生きている」まで
 * 言える。片方だけでは鎖は閉じない。
 *
 * ## なぜ1本の検査にまとめないのか（権限の境界）
 *
 * - **protection の読み出しは administration 相当の権限が要り、GitHub Actions の
 *   `permissions:` には指定できるスコープが無い**（実測 2026-09-11、公式の
 *   workflow syntax から取得した全16個に administration は無い。詳細は
 *   `check-required-status-checks-core.mjs` の doc）。⟹ **あちらは CI に配線
 *   できない**（`pnpm test` の中でも `STEPS` でも呼べない。`check-scripts-wired.
 *   test.ts` の免除表に理由が在る）。
 * - **こちらが読むのは `gh api repos/…/actions/workflows` で、要る権限は
 *   `actions: read` だけである。** これは GitHub Actions の `permissions:` に
 *   指定できる（`workflow_run` を読む `release-prod.yml` が同じスコープを既に
 *   使っている）。⟹ **こちらは CI に配線できる。だから分けている。** 1本に
 *   まとめると、まとめた側全体が administration 権限を要求することになり、
 *   結局どちらも CI に配線できなくなる。
 *
 * ## 4値で答える。「読めなかった」を緑へ倒さない
 *
 * 全体の verdict は `ok` / `disabled` / `orphan` / `unreadable` の4つである。
 *
 * - **`ok`** —— required な全 context に対応する workflow が `active`。
 * - **`disabled`** —— `active` でない workflow が在る（🔴 #1290 の本丸）。
 * - **`orphan`** —— context に対応するジョブが `.github/workflows/` のどこにも
 *   無い、同じジョブ名が複数の workflow に在り決められない、または対応する
 *   workflow ファイルが GitHub の workflow 一覧に載っていない。**最後のケースは
 *   「無効化されて消えた」と「まだ GitHub がこの workflow を知らない（この枝で
 *   新規に足したばかり）」の両方でありうる**——`formatResult` はその両方の
 *   可能性を出力に明記する。
 * - **`unreadable`** —— `gh api` が読めなかった。**`ok` へ丸めない。** 丸めると
 *   「権限が無くて読めていない」が「無効化されていない」として出力から消える
 *   （`check-required-status-checks-core.mjs` の同じ条項と同じ理由）。
 *
 * **どれを主要因として報告するかの優先順位は `unreadable` > `disabled` >
 * `orphan` > `ok` である。** `unreadable` は他のどの判定もできていない状態
 * なので最優先——`gh api` が失敗した回に「対応するジョブが無い」と言うのは、
 * 読めなかった事実を別の嘘で覆うことになる。`disabled` を `orphan` より
 * 優先するのは、`disabled` のほうが確度の高い実害（#1290 の実物そのもの）
 * だからである。
 *
 * ## どちらが正かは決めない
 *
 * `disabled` / `orphan` のとき、直すべきなのが宣言の側か workflow の側かは
 * この検査には分からない。事実（どの context・どの workflow ファイル・どの
 * state）を並べるだけで、判断は人間がする。
 */

/**
 * required context 名 → その context を出すジョブが定義されている workflow
 * ファイル名の配列、を突き合わせて `disabled` / `orphan` / `ok` を判定する。
 *
 * `workflowStates` が `null`（読めなかった）のときは、全体を `unreadable` に
 * する——個々の context について `orphan` や `ok` を名乗らない。
 *
 * @param {object} input
 * @param {string[]} input.declaredContexts `.github/required-status-checks.json` の `contexts`
 * @param {Record<string, string[]>} input.jobToWorkflowFiles ジョブ名 → 定義されている workflow ファイル名の配列（`workflow-scan-core.mjs` の `buildJobToWorkflowFiles` から作る）
 * @param {{ path: string, state: string }[] | null} input.workflowStates `gh api repos/…/actions/workflows` の `workflows[]` から `path` と `state` だけ取り出した配列。読めなければ `null`
 */
export function evaluateRequiredGateWorkflows({
  declaredContexts,
  jobToWorkflowFiles,
  workflowStates,
}) {
  const declared = [...declaredContexts].sort();

  if (workflowStates === null) {
    return { verdict: 'unreadable', declared, details: [] };
  }

  const stateByPath = new Map(workflowStates.map((w) => [w.path, w.state]));

  const details = declared.map((context) => {
    const files = jobToWorkflowFiles[context] ?? [];

    if (files.length === 0) {
      return {
        context,
        verdict: 'orphan',
        reason: 'このジョブ名を持つ workflow が .github/workflows/ のどこにも無い',
      };
    }

    if (files.length > 1) {
      return {
        context,
        verdict: 'orphan',
        workflowFiles: files,
        reason: `同じジョブ名が複数の workflow に在り、どちらを指すか決められない: ${files.join(' / ')}`,
      };
    }

    const workflowFile = files[0];

    if (!stateByPath.has(workflowFile)) {
      return {
        context,
        verdict: 'orphan',
        workflowFile,
        reason: `workflow ファイル "${workflowFile}" が GitHub の workflow 一覧に無い`,
      };
    }

    const state = stateByPath.get(workflowFile);
    if (state !== 'active') {
      return {
        context,
        verdict: 'disabled',
        workflowFile,
        state,
        reason: `state が "${state}" で active ではない`,
      };
    }

    return { context, verdict: 'ok', workflowFile, state };
  });

  const verdict = details.some((d) => d.verdict === 'disabled')
    ? 'disabled'
    : details.some((d) => d.verdict === 'orphan')
      ? 'orphan'
      : 'ok';

  return { verdict, declared, details };
}

/**
 * 判定結果を、人が読んで次の一手が決まる文へ畳む。
 *
 * **1行目で必ず何が起きたかを名乗る**（`AGENTS.md`「静かに失敗する道具」）。
 * **「宣言であって protection ではない」を毎回の非 ok 出力に書く** —— この
 * 検査だけを見て「required の状態は全部確認した」と早合点しないようにする。
 */
export function formatResult(result) {
  if (result.verdict === 'ok') {
    return (
      `check-required-gate-workflows: OK — required な全 context の workflow が active ` +
      `(${result.declared.join(' / ')})`
    );
  }

  if (result.verdict === 'unreadable') {
    return [
      'check-required-gate-workflows: 判定できなかった — workflow の一覧（gh api repos/…/actions/workflows）を読めなかった。',
      '【赤の意味】これは「無効化されていない」ではない。**読めていない**。',
      `宣言（.github/required-status-checks.json）だけは読めている: ${result.declared.join(' / ')}`,
      'これは宣言（.github/required-status-checks.json）を見ているだけで、実際のブランチ保護と',
      '一致しているかは別の道具（pnpm check:required-status-checks）の仕事である。',
      '手元で確かめるなら: gh api repos/takecchi/alteroid/actions/workflows',
    ].join('\n');
  }

  const headline =
    result.verdict === 'disabled'
      ? 'check-required-gate-workflows: NG — required な門を出す workflow が無効化されている（Issue #1290）。'
      : 'check-required-gate-workflows: NG — required context に対応する workflow が特定できない。';

  const lines = [
    headline,
    '【赤の意味】これは宣言（.github/required-status-checks.json）を見ているだけで、実際の',
    '  ブランチ保護（required contexts）と一致しているかは別の道具（pnpm check:required-status-checks）の',
    '  仕事である。2本合わさって初めて「required の門は宣言どおり存在し、かつ生きている」まで言える。',
  ];

  for (const detail of result.details) {
    if (detail.verdict === 'ok') continue;
    const location = detail.workflowFile
      ? ` (workflow=${detail.workflowFile}${detail.state ? `, state=${detail.state}` : ''})`
      : detail.workflowFiles
        ? ` (workflows=${detail.workflowFiles.join(' / ')})`
        : '';
    lines.push(`  context "${detail.context}": ${detail.verdict} — ${detail.reason}${location}`);
  }

  if (result.details.some((d) => d.verdict === 'orphan')) {
    lines.push(
      '  ⚠ orphan は2通りでありうる —— (1) 無効化されて workflow ファイルごと消えた ' +
        '(2) このブランチで workflow を新規に足したばかりで、GitHub がまだこの workflow を ' +
        '知らない（まだこの枝が対象ではない・push されていない）。後者ならこの検査の結果は ' +
        'このブランチの外（main にマージされて GitHub が認識した後）でしか正しく確かめられない。',
    );
  }

  lines.push(
    '  宣言を直すなら .github/required-status-checks.json の contexts と observedAt を、',
    '  workflow を直すなら GitHub 上で該当 workflow を再度有効化すること' +
      '（このスクリプトは1バイトも書き換えない）。',
  );

  return lines.join('\n');
}

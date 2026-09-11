/**
 * `check-required-status-checks.mjs` の判定だけを切り出したもの
 * （`check-web-css-comment-classnames-core.mjs` と同じ分け方・同じ理由 —— 本物の
 * GitHub API を叩かずに、合成した応答で突き合わせだけを確かめられるようにする）。
 *
 * ## 何を塞ぐために在るか（#836）
 *
 * `scripts/ci-draft-gating.test.ts` は required contexts を宣言として持ち、それが
 * `ci.yml` の実在のジョブ名に対応していることを固定している。**`ci.yml` 側には
 * 正しく当たるが、ブランチ保護の側には誰も当たっていなかった。**
 *
 * ⟹ protection の required contexts を変えると、**あの歯は緑のまま守っている対象
 * だけが変わる。** 「いま一致している」ことは、ずれない理由にならない。**機構は
 * 動いているのに、ずれたことを観測する口が無い**——これは「止められたことが
 * 見えない」（#830）と同じ形である。
 *
 * ## なぜ `pnpm test` の中で突き合わせないのか
 *
 * 2つとも、宣言ではなく実測で分かったことである。
 *
 * 1. **`pnpm test` は手元でも CI でも走り、手元は offline でありうる。** 単体試験の
 *    中からネットワークを叩くと、落ちたときに「ずれている」と「繋がらなかった」が
 *    同じ赤になる。
 * 2. **CI の既定の `GITHUB_TOKEN` には、この API を読む権限を付けられない。**
 *    ブランチ保護の読み出しは administration 相当の権限を要求するが、GitHub Actions
 *    の `permissions:` に指定できるスコープに `administration` は無い（実測
 *    2026-09-11、公式の workflow syntax から取得した全16個は `actions` /
 *    `artifact-metadata` / `attestations` / `checks` / `code-quality` / `contents` /
 *    `deployments` / `discussions` / `id-token` / `issues` / `packages` / `pages` /
 *    `pull-requests` / `security-events` / `statuses` / `vulnerability-alerts`）。
 *
 * ⟹ **だから判定と取得を分ける。** 取得（ネットワークとトークン）は CLI 側、
 * 判定はここ。判定は純関数なので、合成した応答で負の対照まで撃てる。
 *
 * ## 3値で答える。「読めなかった」を緑へ倒さない
 *
 * この検査の結果は `match` / `drift` / `unreadable` の3つである。**`unreadable` を
 * `match` へ丸めないこと** —— 丸めると「権限が無くて読めていない」が「ずれて
 * いない」として出力から消える（AGENTS.md「取れない軸に 0 の行を作る」／
 * 「判定できないを『消してよい』へ倒さない」と同じ向き）。
 *
 * ## どちらが正かは決めない
 *
 * ずれていたとき、直すべきなのが宣言の側か protection の側かは**この検査には
 * 分からない**。歯は「ずれている」とだけ言い、どちらを直すかは人間が決める。
 * だから {@link formatComparison} は両側の値を並べて出すだけで、片方を「正しい
 * 側」として名指ししない。
 */

/**
 * ブランチ保護の応答から required な context 名を取り出す。
 *
 * **`contexts` と `checks` の両方を見る。** GitHub は同じものを2つの欄で返し、
 * `contexts` は後方互換のために残っている側である（実測 2026-09-11 の応答は
 * `contexts: ["ci","image"]` と `checks: [{context:"ci",...},{context:"image",...}]`
 * の両方を持っていた）。**片方だけ読むと、もう片方だけが動いた回を取り逃す**ので、
 * 食い違いそのものも結果に載せる。
 *
 * 欄が無い／形が違うときは `null` を返す（＝読めなかった）。**空配列を返さない**
 * —— 空配列は「required が1つも無い」という別の事実であって、それを「読めな
 * かった」と同じ値にすると2つが混ざる。
 */
export function contextsFromProtection(protection) {
  if (protection === null || typeof protection !== 'object') return null;
  const required = protection.required_status_checks;
  if (required === null || typeof required !== 'object') return null;

  const fromContexts = Array.isArray(required.contexts)
    ? required.contexts.filter((name) => typeof name === 'string')
    : null;
  const fromChecks = Array.isArray(required.checks)
    ? required.checks
        .map((check) => (check === null || typeof check !== 'object' ? null : check.context))
        .filter((name) => typeof name === 'string')
    : null;

  if (fromContexts === null && fromChecks === null) return null;

  // どちらか片方しか無ければそれを使う。両方在れば `checks` を採り、食い違いは
  // 別に報告する（`checks` が新しい側の欄である）。
  const primary = fromChecks ?? fromContexts;
  const disagreement =
    fromContexts !== null && fromChecks !== null && !sameSet(fromContexts, fromChecks)
      ? { contexts: [...fromContexts].sort(), checks: [...fromChecks].sort() }
      : null;

  return { names: [...primary].sort(), disagreement };
}

function sameSet(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/**
 * 宣言（`.github/required-status-checks.json` の `contexts`）と、protection から
 * 取り出した実値を突き合わせる。
 *
 * `live` が `null`（読めなかった）のときは `verdict: 'unreadable'` を返す。
 */
export function compareRequiredStatusChecks(declared, live) {
  const declaredSorted = [...declared].sort();
  if (live === null) {
    return { verdict: 'unreadable', declared: declaredSorted };
  }

  const liveNames = live.names;
  const missing = declaredSorted.filter((name) => !liveNames.includes(name));
  const extra = liveNames.filter((name) => !declaredSorted.includes(name));
  const drifted = missing.length > 0 || extra.length > 0 || live.disagreement !== null;

  return {
    verdict: drifted ? 'drift' : 'match',
    declared: declaredSorted,
    live: liveNames,
    missing,
    extra,
    disagreement: live.disagreement,
  };
}

/**
 * 突き合わせの結果を、人が読んで次の一手が決まる文へ畳む。
 *
 * **赤の意味を文そのものに書く。** ずれたときに読む人が最初に知りたいのは
 * 「どちらを直すのか」で、それはこの検査には決められない——だから「どちらかを
 * 決める必要がある」と明示する（`manager.ts` の `DENIED_ESCALATE_AT` の doc と
 * 同じ作法で、次に触る人が理由ごと受け取れるようにする）。
 */
export function formatComparison(result) {
  if (result.verdict === 'match') {
    return (
      `check-required-status-checks: OK — 宣言と protection が一致 ` +
      `(${result.declared.join(' / ')})`
    );
  }

  if (result.verdict === 'unreadable') {
    return (
      'check-required-status-checks: 判定できなかった — ブランチ保護を読めなかった。\n' +
      '【赤の意味】これは「ずれていない」ではない。**読めていない**。\n' +
      'ブランチ保護の読み出しは administration 相当の権限を要求し、GitHub Actions の\n' +
      '既定の GITHUB_TOKEN には付けられない（`permissions:` に administration は無い）。\n' +
      `宣言の側だけは読めている: ${result.declared.join(' / ')}\n` +
      '手元で確かめるなら: gh api repos/takecchi/alteroid/branches/main/protection'
    );
  }

  const lines = [
    'check-required-status-checks: NG — 宣言と protection がずれている。',
    '【赤の意味】**どちらが正しいかは、この検査には決められない。**',
    '  宣言（.github/required-status-checks.json）が古いのかもしれないし、',
    '  protection の側が意図せず変わったのかもしれない。**どちらを直すかを人間が決めること。**',
    `  宣言: ${result.declared.join(' / ') || '（空）'}`,
    `  protection: ${result.live.join(' / ') || '（空）'}`,
  ];
  if (result.missing.length > 0) {
    lines.push(`  宣言に在って protection に無い: ${result.missing.join(' / ')}`);
  }
  if (result.extra.length > 0) {
    lines.push(`  protection に在って宣言に無い: ${result.extra.join(' / ')}`);
  }
  if (result.disagreement !== null) {
    lines.push(
      '  ⚠ protection の応答の中で contexts と checks が食い違っている' +
        `（contexts: ${result.disagreement.contexts.join(' / ')} / ` +
        `checks: ${result.disagreement.checks.join(' / ')}）。` +
        'GitHub 側で片方だけが動いた形なので、宣言を直す前にそちらを見ること。',
    );
  }
  lines.push(
    '  宣言を直すなら .github/required-status-checks.json の contexts と observedAt を、',
    '  protection を直すならリポジトリの設定を（このスクリプトは1バイトも書き換えない）。',
  );
  return lines.join('\n');
}

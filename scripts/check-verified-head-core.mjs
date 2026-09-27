/**
 * `pnpm check:verified-head [<rev>]` の判定だけを切り出したもの
 * （Issue #1763・#1192 の N7）。
 *
 * **判定ロジックはここに置く。** `check-verified-head.mjs` は「呼んで、出力して、
 * 終了コードを決める」だけの薄い層にする（`check-required-status-checks.mjs` と
 * 同じ分け方）。
 *
 * ## 何を確かめる道具か
 *
 * `pnpm verify` が全部通ると、`scripts/verify.mjs` はそのときの作業ツリーの
 * 中身を tree の sha として `.git/alteroid-verify.json` の `tree` に記録する
 * （一時 index に `git add -A` して `git write-tree` したもの。
 * `verify-core.mjs` の `writeTreeFor`）。この道具は、その `tree` と
 * `<rev>^{tree}`（既定 `HEAD`）を比べる。
 *
 * **一致すれば「この commit の中身は、`pnpm verify` が全部通ったツリーそのもの
 * である」と言える。** 不一致なら、検証の後に何かが変わっている——commit した
 * ファイルの中身の変化だけでなく、**検証が通った時点で未追跡のまま commit
 * しなかったファイル**も、tree の比較には現れる（`writeTreeFor` は
 * `git add -A` で未追跡分も拾うが、commit しなければ `<rev>^{tree}` には
 * 現れないため、両者の tree が食い違う）。
 *
 * ## なぜ `HEAD` の生の sha ではなく tree を比べるのか
 *
 * `verify-core.mjs` の `fingerprint` は `HEAD` の sha を畳んでいる
 * （`feed('HEAD', …)`）。ふつうの順序は「直す → `pnpm verify` → commit →
 * push」なので、commit した瞬間に `HEAD` が動き、**`fingerprint` をそのまま
 * この判定へ転用すると、正しい順序で作業しても毎回「未検証」になる
 * （偽陽性しか出ない）。** tree の sha は commit を作っても変わらない
 * （commit は既存の tree に親・作者・日時を付けるだけのこともある）ので、
 * ここでは tree だけを比べる。
 *
 * ## 3値である（2値にしない。`AGENTS.md`「『判定できない』という3つ目の状態を持つ」）
 *
 * - **`match`** —— 一致。この commit の中身は検証済みのツリーそのもの
 * - **`mismatch`** —— 不一致。`git diff-tree -r --name-status` の出力を添える
 * - **`undecidable`** —— 判定できない（記録が無い・古い形式で `tree` を
 *   持たない・`<rev>` が tree として引けない）。**「一致」へは倒さない**
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * @param {{ repo: string, rev: string, recordPath: string | null }} input
 * @returns {object} 判定結果（`verdict` が `'match' | 'mismatch' | 'undecidable'`）
 */
export function compareVerifiedHead({ repo, rev, recordPath }) {
  if (recordPath === null || recordPath === undefined) {
    return { verdict: 'undecidable', reason: 'no-record-path' };
  }
  if (!existsSync(recordPath)) {
    return { verdict: 'undecidable', reason: 'no-record', recordPath };
  }

  let saved;
  try {
    saved = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (error) {
    return {
      verdict: 'undecidable',
      reason: 'broken-record',
      recordPath,
      error: String(error),
    };
  }

  // **旧形式（`tree` を持たない記録）も同じ側へ倒す。** `decideSkip` が旧形式の
  // `day` を欠いた記録を「走る」へ倒すのと同じ安全側の向き——`tree` が無い
  // 記録を「一致」にも「不一致」にも読めない。
  if (typeof saved.tree !== 'string' || saved.tree.trim() === '') {
    return { verdict: 'undecidable', reason: 'no-tree-in-record', recordPath };
  }

  // `<rev>` を tree として解決する。`<rev>` そのものが引けない（存在しない
  // ブランチ名・タイプミス等）場合も含めて、ここで拾う。
  const revParse = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (revParse.status !== 0) {
    return {
      verdict: 'undecidable',
      reason: 'unresolvable-rev',
      rev,
      stderr: (revParse.stderr ?? '').trim(),
    };
  }
  const actualTree = revParse.stdout.trim();

  if (actualTree === saved.tree) {
    return { verdict: 'match', tree: actualTree, recordedAt: saved.at ?? null };
  }

  // **不一致のときは、どのファイルが検証の後に変わったかを見せる。**
  // `diff-tree` 自身が失敗すること（記録した tree の object が既に無い等）も
  // ありうるが、その場合でも sha の不一致そのものは動かないので `mismatch`
  // のまま返し、`diffError` にその理由を添える（「判定できない」へは戻さない
  // ——文字列としての不一致は既に確定している）。
  const diff = spawnSync('git', ['diff-tree', '-r', '--name-status', saved.tree, actualTree], {
    cwd: repo,
    encoding: 'utf8',
  });

  return {
    verdict: 'mismatch',
    recordedTree: saved.tree,
    actualTree,
    recordedAt: saved.at ?? null,
    diff: diff.status === 0 ? diff.stdout : null,
    diffError: diff.status === 0 ? null : (diff.stderr ?? '').trim(),
  };
}

/** `reason` を人が読める1文へ変換する（`undecidable` のときだけ使う）。 */
function undecidableReasonText(result) {
  switch (result.reason) {
    case 'no-record-path':
      return '記録の置き場（.git ディレクトリ）を取れなかった';
    case 'no-record':
      return `記録（${result.recordPath}）が無い —— pnpm verify を一度も通していない`;
    case 'broken-record':
      return `記録（${result.recordPath}）を読めない: ${result.error}`;
    case 'no-tree-in-record':
      return `記録（${result.recordPath}）が古い形式で tree を持たない —— pnpm verify を通し直すこと`;
    case 'unresolvable-rev':
      return `<rev>（${result.rev}）を tree として解決できない: ${result.stderr}`;
    default:
      return result.reason;
  }
}

/** 判定結果を、そのまま出力してよい1つの文字列へ整形する。 */
export function formatVerdict(rev, result) {
  if (result.verdict === 'match') {
    return (
      `check-verified-head(${rev}): 一致 —— この commit の中身は、` +
      `pnpm verify が全部通ったツリーそのものである（tree=${result.tree.slice(0, 12)}` +
      (result.recordedAt === null ? '' : `, 検証時刻=${result.recordedAt}`) +
      '）'
    );
  }

  if (result.verdict === 'mismatch') {
    const header =
      `check-verified-head(${rev}): 不一致 —— pnpm verify を通した後にツリーが変わっている` +
      `（記録=${result.recordedTree.slice(0, 12)}, いま=${result.actualTree.slice(0, 12)}` +
      (result.recordedAt === null ? '' : `, 検証時刻=${result.recordedAt}`) +
      '）';
    if (result.diff !== null && result.diff.trim() !== '') {
      return header + '\n' + result.diff.trimEnd();
    }
    if (result.diffError !== null && result.diffError !== '') {
      return header + '\n  git diff-tree を実行できなかった: ' + result.diffError;
    }
    return header;
  }

  return `check-verified-head(${rev}): 判定できない —— ${undecidableReasonText(result)}`;
}

// `HEAD` の生の sha ではなく tree を比べる: commit した瞬間に `HEAD` が動き、`fingerprint` を転用すると正しい順序で作業しても毎回「未検証」になるため。
// `undecidable` を「一致」へ倒さない: 記録が無い・古い形式・`<rev>` が引けない場合を、検証済みと読ませないため。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

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

  if (typeof saved.tree !== 'string' || saved.tree.trim() === '') {
    return { verdict: 'undecidable', reason: 'no-tree-in-record', recordPath };
  }

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

  // `diff-tree` が失敗しても `mismatch` のまま返し、`diffError` に理由を添える: sha の不一致は既に確定しているため。
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

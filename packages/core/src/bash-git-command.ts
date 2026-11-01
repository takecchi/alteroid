/**
 * シェル構文は解析しない（`inspectBashCommand` のような分類器にしない）。誤検出
 * （`echo 'git push しました'`）は許容する: 起こすのは読み取りだけの `#observeUnpushedWorkOnce`
 * で余分に1回観測するだけ、見逃すと報告より前に落ちた委譲の枝名が台帳に残らない。
 * `&&` や `;` で連結されたコマンドの中も拾う。
 */
export function bashCommandLooksLikeGitPush(command: string): boolean {
  return /\bgit\s+push\b/.test(command);
}

/**
 * `bashCommandLooksLikeGitPush` と同じ考え方（分類器にせず、見逃しを避ける）。
 * 完全ではない: `git branch -c` / `-m` や `-qb` のような結合短縮フラグは拾わない。
 * `git worktree add` は置き場所によらず観測を呼ぶが、`findGitDirs` は `job.cwd` から下方向にしか
 * 潜らないので、cwd の外（兄弟ディレクトリ）に置いた作業ツリーは観測に載らない。
 */
export function bashCommandLooksLikeGitBranchCreate(command: string): boolean {
  return (
    /\bgit\s+checkout\s+-[bB]\b/.test(command) ||
    /\bgit\s+switch\s+-[cC]\b/.test(command) ||
    /\bgit\s+worktree\s+add\b/.test(command) ||
    /\bgit\s+branch\s+(?!-)\S/.test(command)
  );
}

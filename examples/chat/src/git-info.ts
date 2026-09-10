import { execFileSync } from "node:child_process";

/**
 * `git rev-parse HEAD` を試みる（PR「retrieval を CI に載せる」で足す機械可読 JSON の
 * `commit` 欄のため）。
 *
 * **取れなければ `null` を返す。推測で埋めない。**——CI のチェックアウトが浅い
 * （`fetch-depth` の設定次第で `.git` 自体が縮退することがある）・`git` バイナリが
 * 無い・そもそも作業ツリーが git 管理下にない、といった状況はすべて起こり得るが、
 * どの場合も「分からない」を `null` 以外の値で埋めない（AGENTS.md「確かめていないことは
 * 確かめていないと書く」の、値そのものへの適用）。
 *
 * ⚠ **`git`(1) の出力形式に依存する薄いラッパである。**フォーマットを変えたら
 * （例: `--short` を足す）呼び出し側の期待も一緒に見直すこと。
 */
export function tryGitRevParseHead(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // `git rev-parse HEAD` は通常 40桁の16進文字列を返す。それ以外が返るのは
    // 想定していない壊れ方であり、そのまま `commit` 欄に出すと本物のコミットハッシュと
    // 見分けが付かなくなる——**形が合わないものは null に倒す。**
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

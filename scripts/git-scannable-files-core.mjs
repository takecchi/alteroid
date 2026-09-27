/**
 * 「repo 全体を走査する検査」が対象を集めるときの、共通の一覧関数（Issue #1817）。
 *
 * ## 背景
 *
 * `git ls-files`（引数無し、または `-z` だけ）は**追跡済みファイルだけ**を返す。
 * この repo には、`git ls-files` で対象を集めて repo 全体の字面・散文を検査する
 * 歯が複数あった（`scripts/agents-md-references.test.ts` の `listTrackedFiles`、
 * `scripts/check-tracked-nul-bytes.mjs` など）。どれも同じ理由で同じ穴を持つ:
 *
 * 1. 開発者がファイルを新規作成する（まだ `git add` していない＝未追跡）
 * 2. 手元で `pnpm verify` を回す ⟹ 対象に入っていないので、その新規ファイルは
 *    一切検査されない ⟹ **緑**
 * 3. `git add` して commit・push する ⟹ CI がその commit の tree を検査する。
 *    もう追跡済みなので、こんどは対象に入る ⟹ 新規ファイルに検査語があれば
 *    ここで初めて **赤**
 *
 * 実測（PR #1808、Issue #1817 本文）: 新規ファイルを1本足しただけで、手元の
 * `pnpm verify` は緑のまま、push 後の CI の `scripts/agents-md-references.test.ts`
 * が4件赤くなった。
 *
 * ## 直し方
 *
 * 対象を `git ls-files -co --exclude-standard`（cached + others、ただし
 * `.gitignore` 等で無視されたものは除く）に揃える。これは
 * `scripts/verify-core.mjs` の `fingerprint` が使っている集合と同じであり
 * （`fingerprint` の doc 「`fingerprint` は `git ls-files -co --exclude-standard`
 * が挙げる全ファイル」）、**「これから commit されようとしているツリー」に
 * いちばん近い集合である**——`.gitignore` 済みの一時ファイル・作業用ログ等は
 * 引き続き対象に入らない。
 *
 * ## この関数が守っていないこと
 *
 * - **追跡済みで `.gitignore` にも一致するファイル**（force-add 後に無視
 *   パターンが追加された等）は、`-co --exclude-standard` の `-c` 側がそのまま
 *   拾う（ignore 規則は追跡済みには効かない）ので、ここでは変わらない。
 *   これは別の Issue（#1785、`writeTreeFor` 側の話）の対象であり、ここでは
 *   触れない。
 * - **シンボリックリンクの重複**（例: `CLAUDE.md` → `AGENTS.md`）は畳まない。
 *   `check-sdk-quotes-core.mjs` のように重複排除が要る呼び出し元は、自前で
 *   モード情報（`git ls-files -s` 等）や `fs.lstatSync` を足すこと。
 */

import { execFileSync } from 'node:child_process';

/**
 * @param {object} [options]
 * @param {string} [options.cwd] - リポジトリの根。省略時は `process.cwd()`。
 * @param {readonly string[]} [options.pathspec] - `--` の後に渡す絞り込み
 *   （例: `['.claude']` で `.claude/**` だけに絞る）。
 * @returns {string[]} リポジトリ相対パスの配列（空文字列は除く）。
 */
export function listGitScannableFiles(options = {}) {
  const { cwd, pathspec } = options;
  const args = ['ls-files', '-co', '--exclude-standard', '-z'];
  if (pathspec && pathspec.length > 0) {
    args.push('--', ...pathspec);
  }
  const out = execFileSync('git', args, {
    cwd,
    maxBuffer: 1024 * 1024 * 64,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0);
}

#!/usr/bin/env node
/**
 * `main` へ入ったコミットのメッセージに attribution トレーラが無いかを見る門
 * （Issue #1314）。
 *
 * **判定は `check-main-commit-trailers-core.mjs` が持つ。** なぜこの門が要るか・
 * 何を見ないか・3値で答える理由は、そちらの冒頭 doc に在る。ここは git を叩いて
 * コミットメッセージを集め、結果を出力し、終了コードを決めるだけである。
 *
 * ## 🔴 push の payload の `commits[]` を使わない
 *
 * GitHub の push イベントの payload は `commits[]` を持ち、各要素が `message` を
 * 持つ。**それを使わない。** payload の配列は**件数に上限があり、超えた分は黙って
 * 落ちる**——`AGENTS.md`「静かに失敗する道具」の族であり、`gh pr list --limit N`
 * が N 超を黙って切り捨てるのと同じ形である（実測で踏まれている）。
 * ⟹ **git で `before..after` を引く。**
 *
 * ## 🔴 checkout を浅くしないこと
 *
 * `actions/checkout` の既定は `fetch-depth: 1` である。**浅い clone では
 * `before..after` が解けない**（`before` のオブジェクトが手元に無い）。
 * ⟹ workflow 側で `fetch-depth: 0` を明示する。**浅いまま「0本だった」へ倒すと、
 * 見ていないのに緑という、いちばん危ない外し方になる。**
 * ⟹ ここでは git が失敗したら `unreadable`（赤）へ倒す。
 *
 * ## 入力
 *
 * | 引数 | 環境変数 | 意味 |
 * |---|---|---|
 * | `--before` | `MAIN_COMMIT_TRAILERS_BEFORE` | push 前の `main` の先端 |
 * | `--after` | `MAIN_COMMIT_TRAILERS_AFTER` | push 後の `main` の先端 |
 *
 * 終了コード: `0` = 印が無い / `1` = 印が在る、または判定できない。
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

import {
  evaluateMainCommitTrailers,
  evaluatePushRange,
  formatMainCommitVerdict,
} from './check-main-commit-trailers-core.mjs';

/** `--name value` と `--name=value` の両方を読む。 */
function readArg(argv, name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

/**
 * `before..after` のコミットを集める。**読めなかったら `null` を返す**
 * （0本と区別する。`AGENTS.md`「静かに失敗する道具」）。
 *
 * レコード区切りに `\x1e`、フィールド区切りに `\x00` を使う。**改行は区切りに
 * 使えない**——コミット本文の中に普通に在る。
 */
function collectCommits(before, after) {
  try {
    const out = execFileSync(
      'git',
      ['log', '--format=%H%x00%s%x00%B%x1e', '--no-color', `${before}..${after}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return out
      .split('\x1e')
      .map((chunk) => chunk.replace(/^\n+/, ''))
      .filter((chunk) => chunk.length > 0)
      .map((chunk) => {
        const [oid, headline, message] = chunk.split('\x00');
        return { oid, headline, message };
      });
  } catch {
    return null;
  }
}

function out(text) {
  process.stdout.write(text + '\n');
}

function err(text) {
  process.stderr.write(text + '\n');
}

function main() {
  const argv = process.argv.slice(2);
  const before = readArg(argv, 'before') ?? process.env.MAIN_COMMIT_TRAILERS_BEFORE;
  const after = readArg(argv, 'after') ?? process.env.MAIN_COMMIT_TRAILERS_AFTER;

  const range = evaluatePushRange({ before, after });
  if (!range.usable) {
    err(`check-main-commit-trailers: 判定できない — ${range.reason}（赤へ倒す）`);
    process.exitCode = 1;
    return;
  }

  const commits = collectCommits(before, after);
  const result = evaluateMainCommitTrailers({ commits });
  const text = formatMainCommitVerdict(result);

  if (result.verdict === 'clean') {
    out(text);
    return;
  }
  err(text);
  process.exitCode = 1;
}

main();

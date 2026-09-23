/**
 * `main` へ入ったコミットのメッセージに attribution トレーラが無いかを見る述語
 * （Issue #1314）。
 *
 * ## 何を塞ぐために在るか
 *
 * **`no-attribution-trailers` は required な門で、緑を返す。それでも `main` の
 * 履歴にトレーラが入る。** 門が見落としているのではない——**門が検査した物と、
 * `main` に載った物が別物である。**
 *
 * 機序: `no-attribution-trailers.yml` の trigger は `pull_request` 1本だけで
 * （逐語は `grep -Fn -- 'ここでは `pull_request` しか起きない' .github/workflows/no-attribution-trailers.yml`）、
 * 見ているのは **squash される前のコミット列と PR 本文**である。`main` に載るのは
 * **squash された1個**であり、**それはマージした瞬間に初めて存在する。**
 * ⟹ `pull_request` の run は、原理的にそれを見ることができない。
 *
 * **実害（実測、Issue #1314 本文）**: PR #1305 の squash コミットの末尾に
 * `Co-authored-by: github-actions[bot] …` が入った。**PR 本文にはトレーラが
 * 1文字も無く**（実測 0件）、**その PR のコミットの author が `github-actions[bot]`
 * だった**——GitHub の squash は squash 対象のコミットの author を
 * `Co-authored-by:` として自動で足す。⟹ **担い手も PR 本文も関与していない。**
 * 同じ日に author が人間名義の PR を squash したときはトレーラが付かなかった
 * （逆向きの対照）。⟹ **効いているのは「コミットの author が bot か」である。**
 *
 * ⚠️ **Issue #1020 が塞いだのは別の経路である。** あちらは「squash マージは
 * PR 本文をコミットメッセージへ写す」——**本文に在れば入る**。今回は本文に無い。
 * ⟹ あちらの門を通っても、この経路は残る。
 *
 * ## この門が見る範囲——**「これから」だけ**
 *
 * **1回の push が持ち込んだコミットだけを見る。** 既に `main` に在る分は対象外で
 * ある——`AGENTS.md`「リポジトリの約束」が「**既に付いている分は履歴として残す。
 * 履歴を書き換えない。決めたのは『これから付けない』であって、『1本も付いて
 * いない状態が正しい』ではない**」と定めているのに従う。
 * ⟹ **除外は都合ではなく、既に降りている決定の射程である**（既存の
 * `check-no-attribution-trailers-core.mjs` も同じ理由で「これから」しか塞がない）。
 *
 * ## repo のファイルを走査しない（#785 と同じ族）
 *
 * この門のテストは fixture として `Co-authored-by:` の逐語を持つ。**repo 全体を
 * 走査する形で書くと、その fixture 自身を「見つかった」と誤検出する自己参照に
 * なる。** だからここが読むのは**渡されたコミットメッセージだけ**である。
 *
 * ## 判定は3値（`AGENTS.md`「静かに失敗する道具」）
 *
 * 2値にすると、判定できない場合がどちらかへ黙って倒れる。だから
 * `clean`（読めた上での不在）／`found`（見つかった）／`unreadable`（読めなかった）
 * の3値で答える。**倒す先は赤である**——`found` と `unreadable` はどちらも赤。
 *
 * ## 印は複製しない
 *
 * 検査する印の一覧と一致の仕方（**大小文字を区別しない**理由を含む）は
 * `check-no-attribution-trailers-core.mjs` が持っている。ここは**それを読むだけ**で、
 * 自分の表を持たない（`AGENTS.md` の反重複規律。印が増えたとき片方だけ古くなる
 * 形を作らない）。
 *
 * **行頭（`^\s*`）に絞る規則（#1349）も、この import 経由でそのまま共有される。**
 * `no-attribution-trailers`（PR 側の門）で「文中で触れているだけ」として緑を通った
 * 本文が squash で `main` に載っても、ここが別の基準で赤くすることはない——両者は
 * `findAttributionMarkers` という同じ関数・同じ正規表現を見ているので、ずれない。
 */

import { findAttributionMarkers } from './check-no-attribution-trailers-core.mjs';

/**
 * push が持ち込んだコミットを判定する。
 *
 * ⚠️ **`commits` が `null` なら `unreadable` である。**「コミットが0本だった」と
 * 「コミットを読めなかった」を同じ値で表さない——前者は `[]`、後者は `null`。
 * ⟹ 読めなかったほうは赤へ倒れる。
 *
 * ⭐ **`commits` が `[]`（空）のときは `clean` である。** push が1本も新しい
 * コミットを持ち込まないことは実在する（tag だけの push、既に在る sha への
 * force-push）。**それは異常ではない。**
 *
 * @param {{ commits: Array<{ oid?: string, message?: string, headline?: string }> | null }} input
 * @returns {{ verdict: 'clean' | 'found' | 'unreadable', findings: Array<{ source: string, markers: string[] }> }}
 */
export function evaluateMainCommitTrailers({ commits }) {
  if (commits === null || commits === undefined) {
    return { verdict: 'unreadable', findings: [] };
  }

  const findings = [];
  for (const commit of commits) {
    if (commit === null || commit === undefined || typeof commit.message !== 'string') {
      return { verdict: 'unreadable', findings: [] };
    }
    const markers = findAttributionMarkers(commit.message);
    if (markers.length === 0) continue;
    const oidShort =
      typeof commit.oid === 'string' && commit.oid.length > 0
        ? commit.oid.slice(0, 7)
        : '(sha不明)';
    const headline =
      typeof commit.headline === 'string' && commit.headline.length > 0
        ? ` "${commit.headline}"`
        : '';
    findings.push({ source: `commit ${oidShort}${headline}`, markers });
  }

  return { verdict: findings.length > 0 ? 'found' : 'clean', findings };
}

/**
 * push の範囲（`before` / `after`）が使える形かを見る。
 *
 * 🔴 **`before` が全ゼロのとき、範囲は出せない。** GitHub は枝の作成や、履歴を
 * 持たない push で `0000000…` を渡す。**そこで「変更なし」へ倒すと、いちばん
 * 危ない外し方（見ていないのに緑）になる。** ⟹ `usable: false` を返し、呼ぶ側が
 * 赤へ倒す。
 *
 * @param {{ before?: string, after?: string }} input
 * @returns {{ usable: boolean, reason: string | null }}
 */
export function evaluatePushRange({ before, after }) {
  const zero = /^0{7,40}$/;
  if (typeof before !== 'string' || before.length === 0) {
    return { usable: false, reason: 'push の before が渡っていない' };
  }
  if (typeof after !== 'string' || after.length === 0) {
    return { usable: false, reason: 'push の after が渡っていない' };
  }
  if (zero.test(before)) {
    return { usable: false, reason: 'push の before が全ゼロ（範囲を出せない）' };
  }
  if (zero.test(after)) {
    return { usable: false, reason: 'push の after が全ゼロ（枝の削除）' };
  }
  return { usable: true, reason: null };
}

/**
 * 人が読む形へ落とす。
 *
 * @param {{ verdict: string, findings: Array<{ source: string, markers: string[] }> }} result
 * @returns {string}
 */
export function formatMainCommitVerdict(result) {
  if (result.verdict === 'unreadable') {
    return 'check-main-commit-trailers: 判定できない — push が持ち込んだコミットを読めなかった（赤へ倒す）';
  }
  if (result.verdict === 'clean') {
    return 'check-main-commit-trailers: OK — push が持ち込んだコミットに印は無い';
  }
  const lines = result.findings.map((f) => `  - ${f.source}: ${f.markers.join(' / ')}`);
  return [
    'check-main-commit-trailers: 見つかった — main へ入ったコミットに印が在る',
    ...lines,
    '',
    '⛔ 履歴を書き換えて直さないこと（AGENTS.md「既に付いている分は履歴として残す」）。',
    '⟹ この赤は「入った」ことを知らせるためのものである。何を変えるかは Issue #1314 で決める。',
  ].join('\n');
}

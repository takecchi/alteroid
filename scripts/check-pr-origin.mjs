#!/usr/bin/env node
/**
 * PR / Issue の本文に「出所の刻印」（`<!-- alteroid-origin: ... -->`）が
 * 揃っているかを見る（`pnpm check:pr-origin`）。
 *
 * **判定は `check-pr-origin-core.mjs` の doc が正本。** このファイルには置かない。
 * ここは `PR_BODY` / `PR_CREATED_AT` 環境変数を読み、`decideGateVerdict` を呼び、
 * 終了コードを決めるだけの薄い層（`check-base-overlap.mjs` の CLI の作法を
 * 真似ている）。`legacy`（門より前に作られた PR を赤くしない扱い）の条件は
 * `check-pr-origin-core.mjs` の doc「`legacy`（門より前に作られた PR）」を見よ。
 *
 * ## なぜ `PR_BODY` / `PR_CREATED_AT` を環境変数で受け、引数やシェルの補間で受けないか
 *
 * **PR 本文も作成時刻も外部入力である。** GitHub 上で誰でも編集できる文字列を、
 * ワークフローの `run:` の中へ `${{ github.event.pull_request.body }}` の
 * ような形で直接展開すると、本文の中身がそのままシェルスクリプトの一部として
 * 解釈される——本文に埋め込んだコマンドが CI のシェルで実行される、という
 * スクリプトインジェクションの経路になる（GitHub Actions の既知の落とし穴。
 * 対策は「信頼できない入力は `env:` を経由して渡し、シェルの外側で変数展開する」
 * ことで、`env:` に積んだ値は環境変数としてプロセスに渡るだけでシェルの構文と
 * しては解釈されない）。**だからこの CLI はどちらも `process.env` からしか
 * 読まない** —— コマンドライン引数や `--body="$PR_BODY"` のような形を口にしない。
 * `PR_CREATED_AT` 自体は GitHub が発行する日時文字列で本文ほど自由度は無いが、
 * 同じワークフローの同じ `run:` に混ぜて書けば結局同じ経路になるので、
 * 揃えて `env:` を通す。
 *
 * ## 落ちたときに完全な形の刻印を出力しない理由
 *
 * オーナー自身が `gh pr create --body` で PR を出すことも実際に在る——その
 * 経路では PR テンプレートが拾われないので刻印が付かず、**オーナーが自分の
 * PR でこの門の赤を踏む。** それでも門は弱めない（赤いままにする）。
 *
 * **だからこそ、赤を踏んだ人がそのまま無思考でコピーできるものを出力に
 * 置かない。** もし失敗時の出力に値まで埋めた完全な刻印
 * （`<!-- alteroid-origin: human -->` など）を書くと、赤を踏んだマネージャーが
 * それをそのまま PR 本文へ貼り、**自分の仕事をオーナーのものとして刻む**
 * 経路ができる——しかもこれは静かに起きる（貼った本人は「言われたとおりに
 * 直した」つもりで、実際には受け入れ基準3（「出所が分からない」と「出所が
 * 無い」の区別）を自分の手で壊している。⟹ **出力から無思考でコピーしても、
 * 貼れば必ず赤くなるもの（値の位置を埋めない `<値>` のような穴あきの形）
 * だけを見せる。**
 */

import process from 'node:process';

import { decideGateVerdict } from './check-pr-origin-core.mjs';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

const OK_VERDICTS = new Set(['manager', 'clone', 'human']);

function main() {
  const body = process.env.PR_BODY;
  const createdAt = process.env.PR_CREATED_AT;
  const result = decideGateVerdict({ body, createdAt });

  if (result.verdict === 'legacy') {
    log('check-pr-origin: OK（legacy）— この PR は門より前に作られたので、出所は引けない。');
    return;
  }

  if (OK_VERDICTS.has(result.verdict)) {
    const detail = result.verdict === 'manager' ? `（managerId: ${result.managerId}）` : '';
    log(`check-pr-origin: OK — verdict=${result.verdict}${detail}`);
    return;
  }

  const foundValues = result.values ?? [];
  logError(`check-pr-origin: NG — verdict=${result.verdict}`);
  logError(
    foundValues.length === 0
      ? '  見つかった刻印: 0個'
      : `  見つかった刻印の値: ${JSON.stringify(foundValues)}`,
  );
  if (result.verdict === 'invalid') {
    logError(`  値が語彙のどれでもない: ${JSON.stringify(result.value)}`);
  }
  if (result.verdict === 'conflict') {
    logError('  複数の刻印が食い違う値を持っている。');
  }
  logError('');
  logError('  置く形（値の位置は埋めない。埋めて貼ると必ず誤った出所を刻むことになる）:');
  logError('    <!-- alteroid-origin: <値> -->');
  logError('');
  logError('  <値> に入れてよいもの（それぞれ誰のものかと対で書く）:');
  logError('    - `mgr-...`（あなたが走っているセッションの識別子）= その委譲');
  logError('    - `clone`                                           = クローン自身');
  logError('    - `human`                                           = 人間が直接作った');
  logError('  直し方: PR 本文を編集して上の1行を足せば直る。');
  process.exitCode = 1;
}

main();

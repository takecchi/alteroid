#!/usr/bin/env node
/**
 * `apps/web` のビルド生成物（`apps/web/build/client/assets/*.js`）の
 * バイト数が、閾値を超えていないかを見る。
 *
 * ## なぜ要るか
 *
 * `/commitments` ルートのチャンクが 1,198,608 B に膨れて本番で一度も開けなく
 * なった事故が実際に起きている
 * （https://github.com/takecchi/alteroid/issues/335 、原因は `@alteroid/core`
 * からの**値** import — サーバ専用のドメイン層ごとブラウザバンドルへ引き込んだ）。
 *
 * この事故に対しては既に2本の歯が在る。
 *
 * 1. `eslint.config.js` の `@typescript-eslint/no-restricted-imports` —
 *    `@alteroid/core` からの値 import を禁じる。**入口**を塞ぐ歯
 * 2. `scripts/check-web-bundle-node-traces.mjs` — 生成物に Node 専用の痕跡
 *    （`createRequire` / `node:` 指定子 / `process.cwd` / `Bun.`）が無いかを見る。
 *    経路を問わず**原因**（サーバ専用コードの混入）を捕まえる歯
 *
 * **この2本はどちらも「事故の原因（サーバ専用コードの混入）」を見る歯である。**
 * サーバ専用コードが混ざっていなくても、依存を1つ増やす・巨大なライブラリを
 * うっかり全部 import する・コード分割の境界を崩す、といった**別の原因**で
 * チャンクが膨らむことはありうる。そのときはどちらの歯も鳴らない。
 * この検査は原因を問わず**大きさそのもの**を見るので、原因が何であっても
 * 「大きすぎる」という結果だけは必ず捕まえる。
 *
 * ## 閾値をどう決めたか
 *
 * `main` の先端 `36460a5` を `pnpm build` して実測した値
 * （2026-08-27 観測、`apps/web/build/client/assets/*.js` の生バイト数、37ファイル）:
 *
 * | 測ったもの                                   |     実測 |
 * | --------------------------------------------- | -------: |
 * | 単一チャンクの最大（`entry.client-*.js`）     | 182,550 B |
 * | 2番目（`markdown-*.js`）                       | 156,790 B |
 * | 3番目（`jsx-runtime-*.js`）                    | 130,062 B |
 * | ルートのチャンクの最大（`journal-*.js`）       |  17,113 B |
 * | `commitments-*.js`                             |  10,143 B |
 * | `schedule-*.js`                                |   9,023 B |
 * | **client JS 合計（37ファイル）**               | **742,654 B** |
 *
 * 閾値は2本立てた。
 *
 * - `SINGLE_CHUNK_MAX_BYTES = 262_144`（256 KiB）
 * - `TOTAL_MAX_BYTES = 1_048_576`（1 MiB）
 *
 * **なぜこの2つの数字か。**
 *
 * - どちらも現状の実測の約1.4倍（262,144 / 182,550 = 1.44、
 *   1,048,576 / 742,654 = 1.41）。**余白を1.4倍に取ったのは、正常な機能追加を
 *   鳴らさないためである** — 直近の実例として #496 と #512（`/schedule` と
 *   `/commitments` の編集UI）が合計 +9,380 B、つまり合計の 1.3% しか増やして
 *   いない。**同じ規模の追加が32回入って、ようやく総量の予算に当たる。**
 * - **事故の側は桁で外れる。** #335 の 1,198,608 B は単一チャンクの予算の
 *   4.57倍、当時の総量（約 1,925,153 B）は総量の予算の 1.84倍。
 *   **同じ事故がもう一度起きれば、必ず鳴る。**
 * - **2本立てにしたのは、事故の形が「1ルートだけが桁違いに膨らむ」だった
 *   からである。** 総量だけを見る歯にすると、小さいチャンクが多数ある構成
 *   では1本の暴走が総量に埋もれうる。逆に単一チャンクだけを見ると、全体が
 *   じわじわ増える形を取り逃す。
 * - **キリのよい2の冪にしたのは、次に上げる人が「なぜ 287,000 なのか」を
 *   考えずに済むようにするためである。**
 *
 * ## 落ちたときに出すもの（要件の中心）
 *
 * 「予算超過」だけを出すと、次の人は原因を見ずに閾値を上げて通してしまう。
 * だから落ちたときは必ず次を出す。
 *
 * 1. 予算を超えたチャンクの名前・バイト数・予算からの超過分（B と %）
 * 2. 全チャンクを大きい順に並べた一覧（上位10件以上）
 * 3. 総量と、総量の予算に対する使用率
 * 4. 次に何をすべきかの1行 — 「閾値を上げる前に、増えた原因を特定すること」と
 *    https://github.com/takecchi/alteroid/issues/335 への参照
 *
 * 通ったときも必ず1行出す（`AGENTS.md`「静かに失敗する道具」— 出ていなければ
 * 走っていないと読める）。そのとき使用率も出す。「OK」だけだと、予算の 99% を
 * 使っていても緑に見える。
 *
 * ## この歯の弱さ（1つだけ書くと、それが弱さの全部だと読まれる）
 *
 * - **バイト数しか見ない。** 実行時のコスト（パース・評価の時間）・初回描画・
 *   TTI を1ミリも見ない。軽いが遅いコードは、この歯を素通りする
 * - **絶対値の天井であって、増分ではない。** 5 KB のチャンクが 15 KB へ3倍に
 *   なっても鳴らない。捕まえるのは破局であって、じわじわの肥大ではない
 * - **ディスク上の非圧縮のバイト数を見ている。** 実際に配られるのは
 *   gzip / brotli の後なので、バイト数を増やさずに圧縮率だけを悪くする変更は
 *   見えない
 * - **どのチャンクがどのルートのものかを知らない。** 全チャンクに同じ天井を
 *   当てているので、正当に大きい共有チャンクと、膨らんだルートのチャンクを
 *   区別しない
 * - **JS しか見ない。** CSS・画像・フォントは対象外
 * - **予算は人が手で上げる。** 上げるのが妥当かどうかを、この歯自身は判定
 *   できない
 *
 * ## `check-web-bundle-node-traces.mjs` との違い
 *
 * あちらは「事故の原因（サーバ専用コードの混入）」を経路を問わず見る。
 * こちらは「事故の結果（大きさそのもの）」を原因を問わず見る。**3本目の歯を
 * 足したのは、原因側の2本がどちらも同じ種類の原因（サーバ専用コードの混入）
 * にしか反応しないからである。**
 *
 * ## 判定ロジックの置き場所
 *
 * 閾値の定義と判定は `check-web-bundle-size-core.mjs` に切り出してある
 * （`check-web-bundle-node-traces-core.mjs` と同じ分け方）。このファイルは
 * 「読んで、渡して、終了コードを決める」だけ。
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  judgeBundleSize,
  SINGLE_CHUNK_MAX_BYTES,
  TOTAL_MAX_BYTES,
} from './check-web-bundle-size-core.mjs';

const ASSETS_DIR = join(import.meta.dirname, '..', 'apps', 'web', 'build', 'client', 'assets');
const ISSUE_URL = 'https://github.com/takecchi/alteroid/issues/335';

function listJsFiles(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && path.endsWith('.js'));
}

// `console` に頼らない（`check-web-bundle-node-traces.mjs` と同じ理由 —
// この repo の script はどれも `process.std{out,err}.write` へ寄せてある）。
function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function formatBytes(n) {
  return n.toLocaleString('en-US') + ' B';
}

function formatPercent(n) {
  return Math.round(n) + '%';
}

function basename(path) {
  return path.split('/').pop();
}

function main() {
  let paths;
  try {
    paths = listJsFiles(ASSETS_DIR);
  } catch (error) {
    logError(
      `check-web-bundle-size: ${ASSETS_DIR} を読めない（先に \`pnpm build\` を走らせたか）: ${error}`,
    );
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError(`check-web-bundle-size: ${ASSETS_DIR} に .js が1つも無い（build が壊れていないか）`);
    process.exitCode = 1;
    return;
  }

  const files = paths.map((path) => ({ path: basename(path), bytes: statSync(path).size }));
  const result = judgeBundleSize(files);

  if (!result.ok) {
    logError(`check-web-bundle-size: NG — チャンクのサイズ予算を超えた`);

    if (result.oversized.length > 0) {
      logError('');
      logError(`単一チャンクの予算（${formatBytes(SINGLE_CHUNK_MAX_BYTES)}）を超えたチャンク:`);
      for (const hit of result.oversized) {
        logError(
          `  ${hit.path} : ${formatBytes(hit.bytes)}（超過 ${formatBytes(hit.overBytes)} / ` +
            `${formatPercent(hit.overPercent)}）`,
        );
      }
    }

    logError('');
    logError(
      `全チャンク（大きい順、上位${Math.min(10, result.sorted.length)}件 / 全${result.sorted.length}件）:`,
    );
    for (const file of result.sorted.slice(0, 10)) {
      logError(`  ${formatBytes(file.bytes).padStart(12)}  ${file.path}`);
    }

    logError('');
    logError(
      `合計 ${formatBytes(result.totalBytes)} / 予算 ${formatBytes(TOTAL_MAX_BYTES)}` +
        `（${formatPercent(result.totalBudgetUsedPercent)}）${result.totalOver ? ' — 超過' : ''}`,
    );

    logError('');
    logError(`次にすること: 閾値を上げる前に、増えた原因を特定すること（${ISSUE_URL}）`);

    process.exitCode = 1;
    return;
  }

  // **必ず1行出す**（AGENTS.md「静かに失敗する道具」— 出ていなければ走っていないと読める）。
  // **使用率も出す**（「OK」だけだと、予算の99%を使っていても緑に見える）。
  log(
    `check-web-bundle-size: OK — ${files.length}ファイル / 最大 ${formatBytes(result.maxChunk.bytes)}` +
      `（予算の ${formatPercent(result.singleBudgetUsedPercent)}）/ ` +
      `合計 ${formatBytes(result.totalBytes)}（予算の ${formatPercent(result.totalBudgetUsedPercent)}）`,
  );
}

main();

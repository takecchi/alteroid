#!/usr/bin/env node
/**
 * `apps/web` のビルド生成物（`apps/web/build/client/assets/*.js`）に、
 * Node 専用のランタイムの痕跡が入っていないことを見る。
 *
 * ## なぜ要るか
 *
 * `commitments.tsx` が `@alteroid/core`（`export * from './schema.js'` に加えて
 * `usage-snapshot.js` / `usage-probe.js` などサーバ専用のドメイン層を丸ごと
 * 再エクスポートしているバレル）から**値**を import した事故（#294 / #306）で、
 * ブラウザ向けのチャンクに Node 専用のコードが混入し、実際に本番で開けなく
 * なった（実測: `commitments` ルートのチャンクを評価すると
 * `TypeError: (0 , E.createRequire) is not a function` が
 * **モジュール評価の時点で**投げられた。`E` は `node:module` のブラウザ用
 * シムで、実体を持たない）。
 *
 * `eslint.config.js` の `@typescript-eslint/no-restricted-imports`
 * （`@alteroid/core` の値 import を禁じるルール）が同じ事故の**入口**を塞ぐが、
 * **経路を `@alteroid/core` に固定した歯である。** 別の依存から同じ形（サーバ
 * 専用コードの巻き込み）が起きたら、あちらは鳴らない。この検査は経路を問わず
 * **結果側**（生成物そのもの）を見るので、原因が何であっても捕まえる。
 *
 * **2つの歯は役割が違うので、どちらか一方に絞らない。**
 * - lint（入口）: 原因の場所をピンポイントで示せる。ただし `@alteroid/core`
 *   以外からの混入は検知しない
 * - この検査（結果）: 原因を問わず検知するが、落ちたときに「どの import が
 *   原因か」は自分で辿る必要がある
 *
 * ## 検査語をどう決めたか
 *
 * **「直した後の生成物に対して0件であること」を先に確かめてから決めた**
 * （2026-08-23、`pnpm build` 後の `apps/web/build/client/assets/` を全件
 * 走査）。候補のうち、以下は**0件にならなかったので検査語から外した**:
 *
 * - **`node:`（そのままの部分一致）**: `entry.client-*.js` に
 *   `{node:n,offset:...}` という、DOM 操作のオブジェクトリテラルの
 *   プロパティ名としての `node:` が実在し、誤検知した。**`node:` で始まる
 *   import 指定子は必ず引用符に囲まれる**（`"node:buffer"` のように）ので、
 *   引用符を含めた形（`NODE_SPECIFIER`、`check-web-bundle-node-traces-core.mjs`）
 *   に変えて誤検知を消した。**この誤検知そのものを
 *   `check-web-bundle-node-traces.test.ts` の回帰テストに固定してある**
 * - **`process.env`**: 依頼元からも「markdown チャンクなど正当なコードに
 *   `process.env` 相当の文字列が含まれることがある」と指摘があった。実際に
 *   確かめてはいないが、`process.cwd` より誤検知の芽が大きいと判断し、
 *   最初から候補に入れていない
 *
 * 残した4つ（`createRequire` / 引用符付き `node:` 指定子 / `process.cwd` /
 * `Bun.`）は、直した後の生成物で実測 0件、かつ直す前の生成物（バグを含む
 * `commitments` チャンク）では実際に検出できることを確かめている
 * （PR 本文に生の出力がある）。
 *
 * ## この検査が言えること・言えないこと
 *
 * - **言えること**: 上の4つの文字列パターンが、いま `apps/web` がブラウザへ
 *   出す生成物に1つも無い
 * - **言えないこと**: Node 専用コードの混入を漏れなく検出すること。この4つは
 *   今回実際に踏んだ事故の実測から選んだものであって、Node 専用コードの
 *   網羅的な指紋ではない。**新しい形の混入（例: `fs.readFileSync` の生呼び出し）
 *   はこの検査をすり抜けうる**
 *
 * ## 判定ロジックの置き場所
 *
 * パターン定義と走査そのものは `check-web-bundle-node-traces-core.mjs` に
 * 切り出してある（`verify.mjs` / `verify-core.mjs` と同じ分け方 — 理由は
 * そちらの doc）。このファイルは「読んで、渡して、終了コードを決める」だけ。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { findNodeTraceHits, PATTERNS } from './check-web-bundle-node-traces-core.mjs';

const ASSETS_DIR = join(import.meta.dirname, '..', 'apps', 'web', 'build', 'client', 'assets');

function listJsFiles(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && path.endsWith('.js'));
}

// `console` に頼らない（`scripts/verify.mjs` と同じ理由 — この repo の script は
// グローバルへ暗黙で頼らず、`node:process` を明示 import する形で揃えてある。
// `console` はグローバルなので `no-undef` を通すには `node:console` が要るが、
// 既存 script はどれも `process.std{out,err}.write` へ寄せているのでそれに倣う）。
function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function main() {
  let paths;
  try {
    paths = listJsFiles(ASSETS_DIR);
  } catch (error) {
    logError(
      `check-web-bundle-node-traces: ${ASSETS_DIR} を読めない（先に \`pnpm build\` を走らせたか）: ${error}`,
    );
    process.exitCode = 1;
    return;
  }

  if (paths.length === 0) {
    logError(
      `check-web-bundle-node-traces: ${ASSETS_DIR} に .js が1つも無い（build が壊れていないか）`,
    );
    process.exitCode = 1;
    return;
  }

  const files = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
  const hits = findNodeTraceHits(files);

  if (hits.length > 0) {
    logError(`check-web-bundle-node-traces: NG — ${hits.length}件のNode専用の痕跡が見つかった:`);
    for (const hit of hits) {
      logError(`  ${hit.path} : ${hit.pattern}`);
      logError(`    …${hit.snippet}…`);
    }
    process.exitCode = 1;
    return;
  }

  // **必ず1行出す**（AGENTS.md「静かに失敗する道具」— 出ていなければ走っていないと読める）。
  log(
    `check-web-bundle-node-traces: OK — ${files.length}ファイル / ${PATTERNS.length}パターンとも0件`,
  );
}

main();

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Web UI を成すソース。画面（`apps/web`）と、画面から切り出した3つのパッケージ
 * （`packages/ui` 見た目 / `packages/logic` 純ロジック / `packages/swr` 通信の層）。
 *
 * **切り出したパッケージも同じ規則の下に置く。** どれも同じブラウザバンドルへ入るので、
 * 下の2つ（hooks の規則・`@alteroid/core` の値の import 禁止）が守ろうとしているものは
 * ファイルが `apps/web` の外へ移っても変わらない。ここを `apps/web` だけにしておくと、
 * 移した先で同じ事故（#294 / #306）が素通りする。
 */
const WEB_UI_DIRS = ['apps/web', 'packages/ui', 'packages/logic', 'packages/swr'];
const WEB_UI_FILES = WEB_UI_DIRS.map((dir) => `${dir}/**/*.{ts,tsx}`);
const WEB_UI_TEST_FILES = WEB_UI_DIRS.map((dir) => `${dir}/**/*.test.{ts,tsx}`);

/** `@alteroid/core` 本体からの値の import を禁じる1件（理由は下の設定の doc）。 */
const CORE_VALUE_IMPORT_BAN = {
  name: '@alteroid/core',
  message:
    '@alteroid/core はサーバ専用のドメイン層を丸ごと再エクスポートしている（index.ts）。' +
    '値の import はブラウザバンドルへそれを引き込む（#294 / #306 の事故）。型なら import type、' +
    '値が要るなら @alteroid/core/usage・@alteroid/core/revision のような軽い口を使うか、' +
    'ファイル内へ値を複製すること。',
  allowTypeImports: true,
};

/**
 * 画面から切り出した3つのパッケージの**依存の向き**。
 *
 * - `packages/logic`（純ロジック）は React も SWR も、ほかの2つも知らない
 * - `packages/ui`（見た目）は API を知らない（通信の層も、生成 spec の型も）
 * - `packages/swr`（通信の層）は見た目を知らない
 *
 * **向きを決めておくのは、分けた理由そのものだからである。** 見た目を差し替える
 * 変更が通信の層を巻き込まない・ロジックを描画せずに試せる、はどちらも逆向きの
 * import が1本入った瞬間に崩れ、しかも型検査もテストも緑のまま崩れる。
 */
const WEB_UI_LAYERS = [
  {
    dir: 'packages/logic',
    forbidden: ['react', 'react-dom', 'swr', '@alteroid/ui', '@alteroid/swr'],
    why: '@alteroid/logic は React・SWR・ほかの Web UI パッケージを知らない層である（描画せずに試せることが分けた理由）。',
  },
  {
    dir: 'packages/ui',
    forbidden: ['swr', '@alteroid/swr', '@alteroid/logic', '@alteroid/api-client'],
    why: '@alteroid/ui は API を知らない見た目の層である。データは props で受け取ること。',
  },
  {
    dir: 'packages/swr',
    forbidden: ['@alteroid/ui'],
    why: '@alteroid/swr は見た目を知らない通信の層である。',
  },
];

/**
 * 1つの層の禁止を、テストとそれ以外の2つの設定に展開する。
 *
 * **2つに分けるのは、同じ規則名を後の設定で書くと前の設定の選択肢が丸ごと
 * 置き換わるからである**（flat config は規則ごとに後勝ち）。テスト以外には
 * `CORE_VALUE_IMPORT_BAN` を併せて載せ直さないと、この層の設定が下の
 * `WEB_UI_FILES` の禁止を黙って消す。テストは `@alteroid/core` の値を使ってよい
 * （バンドルに入らない。下の doc）ので、層の禁止だけを載せる。
 */
function layerImportRules({ dir, forbidden, why }) {
  const layerPaths = forbidden.map((name) => ({ name, message: why }));
  const layerPatterns = [
    {
      group: forbidden.filter((name) => name.startsWith('@alteroid/')).map((name) => `${name}/*`),
      message: why,
    },
  ].filter((pattern) => pattern.group.length > 0);
  const rule = (paths) => ({
    '@typescript-eslint/no-restricted-imports': ['error', { paths, patterns: layerPatterns }],
  });
  return [
    {
      files: [`${dir}/**/*.{ts,tsx}`],
      ignores: [`${dir}/**/*.test.{ts,tsx}`],
      rules: rule([CORE_VALUE_IMPORT_BAN, ...layerPaths]),
    },
    {
      files: [`${dir}/**/*.test.{ts,tsx}`],
      rules: rule(layerPaths),
    },
  ];
}

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/*.d.ts',
      // apps/web の生成物。`build/` は react-router の出力、`.react-router/` は typegen。
      '**/build/',
      '**/.react-router/',
      // 正典を焼き込んだ写し（packages/core/scripts/write-canon.mjs が作る）
      'packages/core/src/generated/',
      // 担い手・作業者が作業ツリーの中に置く使い捨てのログ・メモ・下書き（.gitignore /
      // .prettierignore と同じ。#1819 は git と prettier からだけ外していたので、
      // `.scratch/` に `.ts` を置くと `pnpm lint` が落ちた。3つが揃っていることは
      // `scripts/scratch-ignore-alignment.test.ts` が測る）。
      '**/.scratch/',
      // .gitignore が外している、ほかの共有の置き場（#1830 の後の横断レビュー）。`workspace/` は
      // マネージャー・作業者が対象のリポジトリを clone する場所（compose.yaml）、`coverage/` は
      // html のレポートの JS、`.pnpm-store/` は依存の実体、`.mutation-testing/` は変異の控え。
      // どれも、中身次第で `pnpm lint` を落とす。
      'workspace/',
      '**/coverage/',
      '.pnpm-store/',
      '.mutation-testing/',
      '.idea/',
      '.vscode/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  /**
   * hooks の規則は Web UI（`WEB_UI_FILES`）だけに掛ける。
   *
   * **これは様式の統一ではなくバグ検出である** — 依存配列の取りこぼしは
   * 「古い値をつかんだまま動き続ける」形で出るので、目視では見つからない。
   * 日誌の SSE 購読（`use-journal-live.ts`）のように張りっぱなしにするものが
   * あるほど効く。
   */
  {
    files: WEB_UI_FILES,
    extends: [reactHooks.configs.flat.recommended],
  },
  /**
   * Web UI（`WEB_UI_FILES`）のソースから `@alteroid/core`（バレル export）を**値**として
   * import することを禁じる。
   *
   * **なぜ要るか — #294 / #306 で実際にこれが本番を落とした。**
   * `packages/core/src/index.ts` は `export * from './schema.js'` に加えて
   * `usage-snapshot.js` / `usage-probe.js` などサーバ専用のドメイン層を丸ごと
   * 再エクスポートしている。`apps/web/app/routes/commitments.tsx` が
   * `commitmentClosedBySchema` / `textMarkupSchema` を値として import した
   * ところ、そのサーバ専用コードごとブラウザバンドルへ入り、`commitments`
   * ルートのチャンクが 1.2MB（他ルートの約80倍）に膨らんだうえ、
   * `node:module` の `createRequire` 呼び出しがブラウザでのモジュール評価
   * 時点で例外を投げて、そのルートが本番で一度も開けなくなった。**型検査は
   * これを検出しない** — `import type` は build で消えるので通ってしまい、
   * 壊れているかどうかはバンドルを実際に評価するまで分からない。この lint
   * が、次に同じ1行が書かれた瞬間に赤くする歯である。
   *
   * **`allowTypeImports: true` で型だけの import は通す** — 型は build で
   * 消えるのでバンドルサイズに影響しない。値が要る場合は、この画面が既に
   * 使っている「ブラウザへ出す軽い口」（`@alteroid/core/usage` /
   * `@alteroid/core/revision`。`packages/core/src/revision.ts` の doc）を
   * 使うか、`apps/web/app/routes/commitments.tsx` の
   * `isKnownCommitmentClosedBy` のように値をそのファイル内へ複製する
   * （複製する理由はそちらの doc コメントを見よ）。
   *
   * **`*.test.{ts,tsx}` は対象外。** テストファイルはルーティングされず
   * ブラウザバンドルに入らないので、このルールが守ろうとしているバンドル
   * サイズ・実行時評価には無関係である（`apps/web/app/routes/journal.test.tsx`
   * の `JOURNAL_ENTRY_TYPES` はこの理由で許容されている）。
   */
  {
    files: WEB_UI_FILES,
    ignores: WEB_UI_TEST_FILES,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [CORE_VALUE_IMPORT_BAN],
        },
      ],
    },
  },
  ...WEB_UI_LAYERS.flatMap(layerImportRules),
  prettier,
);

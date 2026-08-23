import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  /**
   * hooks の規則は apps/web だけに掛ける。
   *
   * **これは様式の統一ではなくバグ検出である** — 依存配列の取りこぼしは
   * 「古い値をつかんだまま動き続ける」形で出るので、目視では見つからない。
   * 日誌の SSE 購読（`use-journal-live.ts`）のように張りっぱなしにするものが
   * あるほど効く。
   */
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  /**
   * `apps/web` のソースから `@alteroid/core`（バレル export）を**値**として
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
    files: ['apps/web/**/*.{ts,tsx}'],
    ignores: ['apps/web/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@alteroid/core',
              message:
                '@alteroid/core はサーバ専用のドメイン層を丸ごと再エクスポートしている（index.ts）。' +
                '値の import はブラウザバンドルへそれを引き込む（#294 / #306 の事故）。型なら import type、' +
                '値が要るなら @alteroid/core/usage・@alteroid/core/revision のような軽い口を使うか、' +
                'ファイル内へ値を複製すること。',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  prettier,
);

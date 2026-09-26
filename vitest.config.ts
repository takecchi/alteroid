import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // apps/web だけが使う別名。**アプリ側の vite.config.ts は tsconfig の paths から
      // 解いている**が、ここ（リポジトリ共通の vitest）はそれを読まないので同じ対応を置く。
      // 他のワークスペースは `~/` を使わないので、共通に置いても衝突しない。
      '~': fileURLToPath(new URL('./apps/web/app', import.meta.url)),
    },
  },
  test: {
    /**
     * **テストが本物の stdout へ書いたら落とす歯**（#314）。中身と理由は
     * `vitest.setup.ts` に在る。ここに `setupFiles` を置くのはこれが最初で、
     * 置き場所は根の vitest 設定しか無い（下の `include` のとおり
     * テストは複数のワークスペースと `railway/` `scripts/` `.github/scripts/` に
     * 散っていて、共通の足場を置ける場所が他に無いため）。
     */
    setupFiles: ['./vitest.setup.ts'],
    /**
     * **vitest 5 で既定が `true` に変わったものを、4 の既定（`false`）に戻して固定する**（#1574）。
     * `true` だと各テストの前に全モックの呼び出し履歴が消えるので、import 時や
     * `beforeAll`、それより前のテストで起きた呼び出しを `not.toHaveBeenCalled()` が
     * 見なくなる。**呼ばれてはいけない呼び出しがテストの始まる前に起きる形の回帰は、
     * 赤から緑へ黙って変わる。** 上げた時点の CI はどちらの値でも緑だったので、この差は
     * CI には現れない。`true` へ移すなら、`not.toHaveBeenCalled` 系を数え直してから
     * 別の変更として入れること。
     */
    clearMocks: false,
    include: [
      // root 直下に置く共通の足場（`vitest.tmpdir.ts` など、#1436 案B）自身の
      // 単体テスト。`*` は `/` を跨がないので、他の階層向けの `*.test.ts` とは
      // 衝突しない（`packages/*/src/**/*.test.ts` 等はここには当たらない）。
      '*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      // apps/web は react-router の作法で `app/` に置く（`src/` ではない）。
      // 画面を描いて試すものだけ `.tsx`（各ファイルの先頭で jsdom を指定する）。
      'apps/*/app/**/*.test.{ts,tsx}',
      // railway/ はパッケージではないが、置く変数の割り振り（役ごとにどの鍵が渡るか）は
      // 静かにずれても動作が正常に見えるので、ここで固定する
      'railway/**/*.test.ts',
      // .github/scripts/ も同じ理由。本物の push が絡むスクリプトは手で確かめにくいので、
      // ローカルの bare リポジトリで振る舞いを固定する
      '.github/scripts/**/*.test.ts',
      // scripts/ も同じ理由。`pnpm verify` の「無料で返す」判定は、間違えると
      // **検証を一度も走らせないまま緑を名乗る**ので、ここで固定する
      'scripts/**/*.test.ts',
      // docker/ も同じ理由（#865）。`docker/gh` は release-prod の起動を止める門を
      // 持つシェルスクリプトで、静かにずれても Dockerfile の COPY は落ちないので
      // ここで固定する。
      'docker/**/*.test.ts',
    ],
  },
});

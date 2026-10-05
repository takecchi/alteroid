import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * **`--maxWorkers` を渡さなかったときの worker 数の上限**（#2905）。
 *
 * vitest の既定は `availableParallelism() - 1`（`run` のとき。vitest 5.0.2 の
 * `getDefaultThreadsCount`）である。共有の runner の器では（#2905 の調査時の観測）`availableParallelism()` が
 * 32 なので既定は 31 になり、jsdom で画面を描く Web UI のテストが 31 本同時に走る。
 * **器には他の担当のビルドやテストも載っている**（load average が CPU 数を超える）ので、
 * CPU を取り合って非同期の表示の待ちが既定の上限（`findBy` の1秒・テストの5秒）に届き、
 * **落ちるテストが回ごとに変わる**（個々のテストの不具合ではない）。`--maxWorkers=4` で
 * 全件通った（#2905 の観測）。全スイートが `write EPIPE` で集計行を出さずに死ぬ形
 * （`.claude/skills/this-container/SKILL.md`）も、同じ既定から起きる。
 *
 * **CI の並列度は変わらない。** GitHub の `ubuntu-latest`（公開リポジトリ）は 4 vCPU なので
 * 既定はもともと 3 で、この上限を下回る。上限が効くのは、6 CPU 以上の器で `--maxWorkers` を
 * 渡さずに回したときだけである。
 *
 * **`--maxWorkers=<n>` を渡せば、そちらが優先される**（CLI の指定は設定より強い）。
 * 空いている器で速く回したいなら、上げて渡せばよい。
 */
export const MAX_WORKERS_CAP = 4;

/** vitest 自身の既定（`run` のとき）を `MAX_WORKERS_CAP` で頭打ちにした値。 */
export function defaultMaxWorkers(parallelism: number = availableParallelism()): number {
  return Math.min(MAX_WORKERS_CAP, Math.max(parallelism - 1, 1));
}

export default defineConfig({
  resolve: {
    alias: {
      // apps/web だけが使う別名。**アプリ側の vite.config.ts は tsconfig の paths から
      // 解いている**が、ここ（リポジトリ共通の vitest）はそれを読まないので同じ対応を置く。
      // 他のワークスペースは `~/` を使わないので、共通に置いても衝突しない。
      '~': fileURLToPath(new URL('./apps/web/app', import.meta.url)),
      // `packages/ui` の中の shadcn の部品が使う別名（`packages/ui/components.json` の
      // aliases。`shadcn add` が吐く形のまま）。**`packages/ui` の外は `@/` を使わない**
      // （`eslint.config.js` が止める）ので、共通に置いても衝突しない。
      '@': fileURLToPath(new URL('./packages/ui/src', import.meta.url)),
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
    /** 上限の値と理由は `MAX_WORKERS_CAP` の doc（#2905）。 */
    maxWorkers: defaultMaxWorkers(),
    include: [
      // root 直下に置く共通の足場（`vitest.tmpdir.ts` など、#1436 案B）自身の
      // 単体テスト。`*` は `/` を跨がないので、他の階層向けの `*.test.ts` とは
      // 衝突しない（`packages/*/src/**/*.test.ts` 等はここには当たらない）。
      '*.test.ts',
      'packages/*/src/**/*.test.ts',
      // Web UI の部品と通信の層（`packages/ui` / `packages/swr`）は描いて試すものを
      // `.tsx` で持つ（apps/web の `app/` と同じく、各ファイルの先頭で jsdom を指定する）。
      'packages/*/src/**/*.test.tsx',
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
      // docker/ も同じ理由（#865）。`docker/gh` は鍵の読み場所を挟むシェルスクリプトで、
      // 静かにずれても Dockerfile の COPY は落ちないのでここで固定する。
      'docker/**/*.test.ts',
    ],
  },
});

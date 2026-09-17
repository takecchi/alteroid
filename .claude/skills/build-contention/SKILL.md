---
name: build-contention
description: 同じ作業ツリーで pnpm build が2本重なって壊れたとき、あるいは build の資源を外から絞りたいときに読む。tsup の clean が2箇所に在って .js と .d.ts の不在窓が桁で違う機構、TS7016 / ERR_MODULE_NOT_FOUND / vite manifest ENOENT / SIGABRT という4つの顔、--workspace-concurrency=1 では塞げない理由、ピークスレッド数の実測表と PNPM_CONFIG_WORKSPACE_CONCURRENCY / RAYON_NUM_THREADS / ROLLDOWN_WORKER_THREADS、pnpm build -- <フラグ> が各パッケージの引数になって react-router build を落とすこと。
---

# 同じツリーで `pnpm build` が重なる（と、build の資源を絞る口）

<!-- AGENTS.md から移設（2026-09-17）。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

- **同一の作業ツリーで `pnpm build` が2本走ると、互いの `dist` を消し合う。** `pnpm test` の混雑（直上）とは別の落ち方で、**混んでいるかどうかではなく、同じツリーで2本目が走っているかで決まる。** 顔は依存する側の dts の `TS7016`（`Could not find a declaration file for module …`）である。**⚠️ エラー本文の助言（`@types/…` を入れろ / `declare module` を書け）を真に受けないこと — 依存の宣言不足ではない。** 以下すべて実測（2026-08-23 観測、`main` = `139f03b`、`/tmp` の専用ツリー、`nproc` と cgroup クォータが一致した器、pids は 29〜608/1000 を推移）
  - **機構は `tsup` の clean が2箇所に在ることである。** 全パッケージ（7/7）の `tsup.config.ts` が `clean: true` で、`tsup@8.5.1` の clean は**消す対象が互いに素な2つ**に分かれ、**同一プロセス内で並行に走る**（`tsup/dist/index.js:1703` の `await Promise.all([dtsTask(), mainTasks()])`）
    - **本体側**（`tsup/dist/index.js:1588-1596`。`buildAll` の冒頭、esbuild より前、`await` 付き）: `await removeFiles(["**/*", ...extraPatterns], options.outDir)`。`dts` が有効なら `extraPatterns.unshift("!**/*.d.{ts,cts,mts}")` するので、**`.js` を消して `.d.ts` は除外する**
    - **dts の worker 側**（`tsup/dist/rollup.js:6803-6809`。rollup プラグイン `tsup:clean` の `buildStart`）: `await removeFiles(["**/*.d.{ts,mts,cts}"], options.outDir)`。**`.d.ts` しか消さない**
  - **ファイルが消えている窓を直接測った**（`packages/core` を1回 build しながら 5ms 間隔で存在を監視）:

    ```
         0ms index.js   -> EXISTS
         0ms index.d.ts -> EXISTS
      1951ms index.js   -> GONE       ← 本体側の clean
      2040ms index.js   -> EXISTS     ← esbuild の書き込み
      3536ms index.d.ts -> GONE       ← dts worker の clean
      5912ms index.d.ts -> EXISTS     ← dts の書き込み
    ```

    **`dist/index.js` の不在窓が 89ms、`dist/index.d.ts` の不在窓が 2,376ms（約27倍）。** ⟹ 別プロセスが同じツリーで build すると、**その clean が自分の読む `dist` を消す。** 窓が桁で違うので、踏むのはほぼ `.d.ts` の側である。**この2つの数は1つの器での1回の実測であって、規範ではない**（器も `tsup` の版も変われば変わる。固定した数として読まないこと）

  - **1本だけなら落ちない。同じツリーへ2本目を重ねると落ちる**（**「回数」は試行数、「落ちた」はそのうち落ちた数。どちらも実測**）:

    | 条件                                                        | 回数 | 落ちた                  |
    | ----------------------------------------------------------- | ---- | ----------------------- |
    | clean から `pnpm build`（既定並列度）                       | 5    | 0                       |
    | clean から `pnpm -r --workspace-concurrency=16 build`       | 5    | 0                       |
    | clean から `pnpm -r --workspace-concurrency=1 build`        | 5    | 0                       |
    | `pnpm --filter <1パッケージ> build` 単独（`dist` 削除後）   | 10   | 0                       |
    | **同一ツリーで `pnpm build` 2本、stagger 2/4/6/8/10 秒**    | 5組  | **2組（TS7016）**       |
    | **同一ツリーで `pnpm build` ＋ `core` の build を40回連打** | 3回  | **3回（TS7016）**       |
    | 同一ツリーで `pnpm build` 2本（stagger 0秒）                | 5組  | 2組（**別の顔**。下記） |

    逐語（stagger 2秒。**`at Worker.<anonymous> (…/tsup/dist/index.js:1545:26)` の行番号は #204 の報告と同一**）:

    ```
    apps/daemon build: CLI Cleaning output folder
    apps/daemon build: ESM dist/index.js              57.22 KB
    apps/daemon build: ESM ⚡️ Build success in 39ms
    apps/daemon build: DTS Build start
    apps/daemon build: src/storage.ts(222,60): error TS7016: Could not find a declaration file for module '@alteroid/storage-pg'. '…/packages/storage-pg/dist/index.js' implicitly has an 'any' type.
    apps/daemon build: Error: error occurred in dts build
    apps/daemon build:     at Worker.<anonymous> (…/tsup/dist/index.js:1545:26)
    ```

  - **⚠️ `--workspace-concurrency=1` では塞げない。** 直列化はプロセス内の順序しか制御せず、**別プロセスの clean を止めない**（上の表の `=1` の5回が通っているのは単独実行だからである）。**「直列にすれば直る」で塞ぎに行かないこと** — 直らないうえに遅くなる
  - **⚠️ 塞ぎ方はここには無い。** 上に在るのは機構と観測だけである。**塞ぐなら「同じツリーで2本目を走らせない」側**（所有権。「作業者へ切り出す」）で、`pnpm` のフラグでは塞げない
- **同じ形の顔が4つある。** どれも「同じツリーで build が重なった」の別の出方でありうるが、**同型だと確かめてはいない**
  1. **`TS7016`**（`.d.ts` の不在窓 2,376ms を踏む）。**再現した**（上の表）
  2. **`ERR_MODULE_NOT_FOUND`**（`.js` の不在窓 89ms を踏む）。**⚠️ 機構は在るが再現していない** — 単独パッケージ build の同時実行を計160回走らせて0件。**「たぶん落ちる」ではなく「160回で0回」が観測である**
  3. **`apps/web build: Error: ENOENT: no such file or directory, open '…/apps/web/build/client/.vite/manifest.json'`** — stagger 0 の素直な2本同時では、TS7016 より先にこれが出た（5組中2組）
  4. **`SIGABRT`（exit 134）** — **⚠️ これは今回の実測ではなく既存の記録である。** `scripts/verify.mjs` の `run(step)` の doc に在る（逐語は `grep -Fn -- '直接打つと通るのに、この口から呼ぶと落ちる' scripts/verify.mjs`）
- **build の資源はほぼ `apps/web` が使う。** プロセスの観測は `ps | grep` を使わず（他人を撃つ形。上の項目）、**自分が起こした pid から `/proc/<pid>/task/*/children` を辿った**（2026-08-23 実測）
  - `pnpm build`（フル・既定並列度）のピークは子孫7プロセス・**合計129スレッド**で、うち `@react-router/dev` の**1プロセスが103スレッド**である
  - `pnpm -r` の既定並列度は `min(4, os.availableParallelism())` = 4 だが、**依存グラフのせいで実効の同時実行数は最大3**だった（各パッケージで2秒待つプローブを `pnpm -r exec` で走らせて数えた）。**⟹ `--workspace-concurrency` を下げても効きは小さい**
  - **`ThreadPoolBuildError`（#254）を出す主体は `apps/web` である。** 文字列 `ThreadPoolBuildError` は `@rolldown/binding-linux-x64-gnu@1.2.3` のネイティブ `.node` の中に在り、rayon の error enum である（周辺に `PoisonError` / `GlobalPoolAlreadyInitialized` / `CurrentThreadAlreadyInPool`）。経路は `apps/web` の `react-router build` → vite 8.2.1 → rolldown 1.2.3 で、**tsup / esbuild ではない**（esbuild は Go なので、そちらの顔は `runtime: failed to create new OS thread` / `EAGAIN` の側になる）
- **build の資源を外から絞る口は既に在る。⚠️ どれも既定ではない — 既定は変えていないので、要る人が渡す**
  - **`pnpm` の並列度: `PNPM_CONFIG_WORKSPACE_CONCURRENCY` / `pnpm_config_workspace_concurrency`。** `NPM_CONFIG_*` / `npm_config_*` は読まない（実測: `pnpm config get workspace-concurrency` が `undefined` のまま）。**大文字なら全部大文字、小文字なら全部小文字でなければ無視される**（`pnpm` の `config/reader/lib/env.js` の `isUpperSnakeCase` / `isLowerSnakeCase`。混在は効かない）。**root の `pnpm build`（入れ子の `pnpm -r build`）にも継承される**（実測: 付けると reporter の接頭辞 `packages/core build$` が消え、所要も 20s → 26s に変わった）
  - **`apps/web` のスレッド数: `RAYON_NUM_THREADS` / `ROLLDOWN_WORKER_THREADS`。** `apps/web` 単独 build のピークスレッド数の実測（**この器での1回の実測であって、規範ではない。器が違えば違う。全ケース exit 0**）:

    | 環境変数                                             | ピークスレッド数    |
    | ---------------------------------------------------- | ------------------- |
    | なし                                                 | 116                 |
    | `TOKIO_WORKER_THREADS=2`                             | 116（**効かない**） |
    | `UV_THREADPOOL_SIZE=2`                               | 112                 |
    | `ROLLDOWN_WORKER_THREADS=2`                          | 94                  |
    | `RAYON_NUM_THREADS=2`                                | 56                  |
    | `RAYON_NUM_THREADS=2` ＋ `ROLLDOWN_WORKER_THREADS=2` | **34**              |

  - **⚠️ `pnpm build -- <フラグ>` の形は使わないこと。** フラグは各パッケージの build スクリプトの引数になる。実測:

    ```
    $ pnpm build -- --workspace-concurrency=1
    packages/core build$ node ./scripts/write-canon.mjs && tsup -- --workspace-concurrency=1
    apps/web build$ react-router build -- --workspace-concurrency=1
    apps/web build: Error: Could not find a root route module in the app directory as "app/root.tsx"
    ```

    **`tsup` は黙って無視するが、`react-router build` は `--` を位置引数のルートディレクトリと解釈して落ちる。** そして並列度は既定のままである。**渡すなら環境変数である**（`pnpm verify` から渡す口は `scripts/verify.mjs` の `--workspace-concurrency`）

  - **⚠️ 既定を下げないこと。下げれば全員が遅くなる。そして「スレッド数を減らせば資源枯渇が防げる」は確認していない。** この器では #254 の症状（`EAGAIN` / `ThreadPoolBuildError`）を**一度も再現できなかった**（`taskset -c 0,1` で3回、`--workspace-concurrency=16` で5回、6本同時 build を6回）。**この器は `nproc` と cgroup クォータが一致していて、#254 が記録した器（`nproc` がクォータの1.5倍、pids 545/1000、loadavg がクォータとほぼ同じ）とは条件が違う。** 上の表が測ったのは**スレッド数だけ**であって、落ちにくさではない

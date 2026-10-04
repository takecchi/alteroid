import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as tsupBuild, type Options as TsupOptions } from 'tsup';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

/**
 * Issue #1917: `clone-tool-relay-integration.test.ts` と
 * `agent-session-options.test.ts` の stdio e2e 歯が、本物の
 * `packages/core/dist/clone-tool-relay-child.js` を spawn していた（#1908 と
 * 同じ系統。子プロセスの歯2本が並行する `pnpm build` と競合し、古い `dist` に
 * 緑を出しうる）。
 *
 * ## #1908 の直し方（`child-src.test-support.ts`）が使えない理由
 *
 * こちらの歯が測りたいのは、**成果物そのもの**（tsup／esbuild が実際に束ねた
 * `.js`）である。`clone-tool-relay-protocol.ts` の doc のとおり、tsup が
 * `clone-tool-relay-child.ts` を共有チャンクへ括り出すと `invokedDirectly()`
 * が永久に偽になり、中継が起動しなくなる——この回帰は `src` を型剥がしで
 * 直接読む形（`--experimental-strip-types`）では**原理的に**再現しない
 * （束ねる工程そのものを経由しないため）。
 *
 * ## だから、テスト専用の一時ディレクトリへ同じ entry 一式・同じ設定で build する（案A）
 *
 * `packages/core/tsup.config.ts` の `default export`（`defineConfig` は恒等
 * 関数なので、これは実質そのままの `Options`）を読み、**`entry` を1つも削らず
 * そのまま使う**——一部の entry だけを build すると、共有チャンクへの括り出し
 * （他の entry と共有する定数がどれだけあるかに依存する）が再現されない。
 * `outDir` だけをこの関数が作る一時ディレクトリへ差し替え、`dts` は落とす
 * （型定義はこの歯が測りたいものではなく、`dts: true` は tsup の所要時間の
 * 大半を占める——実測は呼び出し側の PR 本文）。それ以外（`format` /
 * `clean` / `sourcemap` / `esbuildOptions` の charset 設定）は1文字も変えない。
 *
 * **entry は絶対パスへ変換してから渡す。** `tsup.config.ts` の `entry` は
 * （`pnpm --filter @alteroid/core build` を想定した）`packages/core` 相対の
 * パスなので、`process.cwd()` が `packages/core` でない文脈（vitest はふつう
 * リポジトリの根から起動する）から呼ぶと解決先がずれる。ここでは
 * `import.meta.url` から `packages/core` の絶対パスを取り、
 * `process.cwd()` に一切依存しない形にしてある。
 *
 * ## build 自体は `tsup.build()` を直接呼ぶ（CLI を spawn しない）
 *
 * `build({ ...config, config: false, ... })` は、tsup 自身の設定ファイル探索
 * （`process.cwd()` 基準）を経由せず、渡したオブジェクトだけを使う
 * （`tsup` の `build()` は `config: false` のとき `configData` を素通しし、
 * `optionsOverride` がそのまま最終の `options` になる——`node_modules/tsup`
 * の実装で確認済み）。子プロセスを spawn しないので、失敗時のスタックが
 * そのままテストの失敗として出る。
 *
 * ## 呼び出し側の責務
 *
 * **一時ディレクトリの片付けは呼ばない**——`makeTempDirSync` を経由して
 * いるので、`vitest.setup.ts` の `afterAll` がテストファイルの終わりに
 * まとめて消す（`vitest.tmpdir.ts` の doc）。
 */
export async function buildCloneToolRelayChildDistForTesting(
  tempDirPrefix: string,
): Promise<string> {
  return join(await buildCoreDistForTesting(tempDirPrefix), 'clone-tool-relay-child.js');
}

/**
 * 上と同じ build で、**全 entry の成果物**を一時ディレクトリへ出し、そのディレクトリを返す
 * （`index.js` も入る。#2732: 束ねた後のモジュール評価順でしか起きない起動不能を測るため）。
 */
export async function buildCoreDistForTesting(tempDirPrefix: string): Promise<string> {
  const coreDir = fileURLToPath(new URL('..', import.meta.url));
  const configModule = (await import(new URL('../tsup.config.ts', import.meta.url).href)) as {
    default: TsupOptions & { entry: readonly string[] };
  };
  const config = configModule.default;

  const outDir = makeTempDirSync(tempDirPrefix);

  await tsupBuild({
    ...config,
    config: false,
    entry: config.entry.map((entry) => join(coreDir, entry)),
    tsconfig: join(coreDir, 'tsconfig.json'),
    outDir,
    dts: false,
    silent: true,
  });

  return outDir;
}

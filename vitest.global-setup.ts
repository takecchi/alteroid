import {
  readVitestOwnTmpDir,
  safeRemoveVitestTmpDir,
  sweepStaleVitestTmpDirs,
} from './vitest.tmpdir-sweep.js';

/**
 * 全 vitest 起動に効く globalSetup（#3039）。理由と条件は `vitest.tmpdir-sweep.ts`。
 * `vitest.workspace-config.ts` は root の `test` を spread するので、各ワークスペースの
 * 設定にも継がれる。
 *
 * vitest 5.0.2 は `os.tmpdir()/<nanoid 21 文字>/` を作って消し忘れる。
 * 内部 API（`project.vitest._tmpDir`）を使うので、取れなければ何も消さず stderr に 1 行出す。
 */
export default function setup(project: unknown): () => void {
  const own = readVitestOwnTmpDir(project);
  if (own === undefined) {
    process.stderr.write(
      'vitest.global-setup: vitest の _tmpDir を取れなかった（内部 API が変わった可能性）。' +
        '何も消さない（#3039）\n',
    );
    return () => {};
  }
  sweepStaleVitestTmpDirs(own);
  return () => {
    safeRemoveVitestTmpDir(own);
  };
}

import {
  readVitestOwnTmpDir,
  safeRemoveVitestTmpDir,
  sweepStaleVitestTmpDirs,
} from './vitest.tmpdir-sweep.js';

// 内部 API（`project.vitest._tmpDir`）が取れなければ何も消さず stderr に 1 行出す: vitest 5.0.2 が `os.tmpdir()` に作って消し忘れるディレクトリを、内部 API を使って消しているため。
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

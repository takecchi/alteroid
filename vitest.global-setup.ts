import { tmpdir } from 'node:os';

import { enterPrivateTmpdir } from './vitest.private-tmpdir.js';
import {
  readVitestOwnTmpDir,
  safeRemoveVitestTmpDir,
  sweepStaleVitestTmpDirs,
} from './vitest.tmpdir-sweep.js';

// 内部 API（`project.vitest._tmpDir`）が取れなければ何も消さず stderr に 1 行出す: vitest 5.0.2 が `os.tmpdir()` に作って消し忘れるディレクトリを、内部 API を使って消しているため。
export default function setup(project: unknown): () => void {
  // 本物の基点は付け替えの前に控える: vitest 自身の dir は本物の tmpdir の直下に在り、付け替えた後の `tmpdir()` を基点にすると消す判定が外れるため。
  const base = tmpdir();
  const own = readVitestOwnTmpDir(project);
  if (own === undefined) {
    process.stderr.write(
      'vitest.global-setup: vitest の _tmpDir を取れなかった（内部 API が変わった可能性）。' +
        '何も消さない（#3039）\n',
    );
  } else {
    sweepStaleVitestTmpDirs(own, { root: base });
  }
  // worker は global setup の後に起きるので、付け替えた `TMPDIR` を受け継ぐ（#5136）
  const privateTmpdir = enterPrivateTmpdir(process.env, base);
  return () => {
    privateTmpdir.leave();
    if (own !== undefined) safeRemoveVitestTmpDir(own, { base });
  };
}

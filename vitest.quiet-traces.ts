import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, beforeEach, expect } from 'vitest';

import {
  setDefaultStderrSinkForTesting,
  writeStderrSync,
} from './packages/core/src/dropped-record.js';

// packages/core の跡の行（`alteroid: …記録できませんでした` 等）を、試験ごとに溜め、落ちた試験の分だけ本物の標準エラーへ吐き出す（#5001）。
// 跡は `fs.writeSync(2, …)` で書かれ、vitest が拾えず `--silent` でも止まらないので、通った試験の分が数百行も出て、落ちた試験の名前と理由が出力の中で切れて見えなくなっていた。
// 消さずに溜める: 落ちた試験では、どの記録が書けなかったかが理由を追う手がかりになるため。
// 跡の帳面（`rememberTrace`）には今どおり積まれる（書き先の手前で積むため）。`captureStderr` で跡を観測する試験は、今どおり自分の書き先へ差し替えて、終われば下の溜める書き先へ戻る。
let traces: string[] = [];
const keep = (line: string): void => {
  traces.push(line);
};

setDefaultStderrSinkForTesting(keep);

const repoRoot = dirname(fileURLToPath(import.meta.url));
const coreDist = join(repoRoot, 'packages', 'core', 'dist', 'index.js');

// core を dist から読むパッケージ（runner・cli・daemon・storage-* など）の試験では、上の差し替えは src のモジュールにしか掛からず届かない。
// そこで dist の core の書き先も同じ溜める書き先へ差し替える。同じファイルを読むので、試験が `@alteroid/core` として読んだものと同じモジュールになる。
// 掛けるのは、core 以外のパッケージで、`@alteroid/core` に依存し、jsdom の環境でない試験のファイルだけ:
// dist の入口は大きく（数 MB）、試験のファイルごとに読み直されるので、core 自身の試験や、軽い入口しか使わない web の試験で読むと重いだけで益が無いため。
// dist が無い（build していない）ときは何もしない。届かなくても今どおり書かれるだけで、壊れはしない。
export function needsDistSink(filepath: string | undefined): boolean {
  if (filepath === undefined || typeof window !== 'undefined') return false;
  const parts = relative(repoRoot, filepath).split(sep);
  const packageDir = parts.length >= 2 ? join(repoRoot, parts[0] ?? '', parts[1] ?? '') : '';
  if (packageDir === '' || packageDir === join(repoRoot, 'packages', 'core')) return false;
  if (packageDir === join(repoRoot, 'apps', 'web')) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return (
      manifest.dependencies?.['@alteroid/core'] !== undefined ||
      manifest.devDependencies?.['@alteroid/core'] !== undefined
    );
  } catch {
    return false;
  }
}

beforeAll(async () => {
  // 試験のファイルの場所は `expect.getState().testPath` から取る（vitest 5 の `beforeAll` は第1引数に準備の値を渡す）
  const filepath = expect.getState().testPath;
  if (!needsDistSink(filepath) || !existsSync(coreDist)) return;
  const core = (await import(pathToFileURL(coreDist).href)) as {
    setDefaultStderrSinkForTesting?: (sink: ((line: string) => void) | null) => void;
  };
  // 古い dist（この口が無い版）では何もしない
  core.setDefaultStderrSinkForTesting?.(keep);
});

// 消すのは試験の頭だけにする（`afterEach` で消さない）: `onTestFailed` は `afterEach` の後に呼ばれるので、先に消すと落ちた試験の跡が失われるため。
// 試験の外（読み込み・`beforeAll`）で書かれた跡は、次の試験の頭で捨てる。
beforeEach(({ onTestFailed }) => {
  traces = [];
  onTestFailed(() => {
    for (const line of traces) writeStderrSync(line);
    traces = [];
  });
});

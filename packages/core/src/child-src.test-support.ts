import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const loader = join(here, 'child-src-loader.test-support.ts');

export interface ChildSrcFailure {
  code?: number;
  stderr?: string;
}

// 同じプロセスで検査しない: 投げ直した先は未処理の拒否になり、vitest 自身の unhandled error の歯に引っかかるため
// dist ではなく src を直接読ませる: 並行する `pnpm build` の tsup clean が dist を一瞬消す窓と競合し、build せずに回すと古い dist に対して緑が出るため
export async function runChildAgainstSrc(
  lines: readonly string[],
): Promise<ChildSrcFailure | null> {
  const child = lines.join('\n');
  return run(
    process.execPath,
    ['--experimental-strip-types', `--import=${loader}`, '--input-type=module', '-e', child],
    // 親の process.env を丸ごと継がせない: 子は絶対パスの execPath と loader だけを使うため。PATH だけは node 自身が内部で使う可能性への保険で残す
    { env: { PATH: process.env.PATH ?? '' } },
  ).then(
    () => null,
    (error: unknown) => error as ChildSrcFailure,
  );
}

export function siblingSrcPath(testFileUrl: string, name: string): string {
  return join(dirname(fileURLToPath(testFileUrl)), name);
}

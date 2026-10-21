import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// テストの実行ごとに `os.tmpdir()` を専用の dir へ向ける（#5136）: 根を渡さないテストが器の本物の `/tmp/alteroid-*`（runner の出し箱・退避先）を先に作り、root の runner がそれを他人の持ち物として断るため（#5134）。
// テストごとに根を渡させない: 「渡せば効くが忘れれば器を汚す」形は、次に足されるテストで再発するため。
export const PRIVATE_TMPDIR_PREFIX = 'alteroid-test-tmp-';

export interface PrivateTmpdir {
  readonly dir: string;
  /** `TMPDIR` を元へ戻し、作った dir を消す。 */
  leave(): void;
}

export function enterPrivateTmpdir(
  env: NodeJS.ProcessEnv = process.env,
  base: string = tmpdir(),
): PrivateTmpdir {
  const dir = mkdtempSync(join(base, PRIVATE_TMPDIR_PREFIX));
  const had = Object.prototype.hasOwnProperty.call(env, 'TMPDIR');
  const previous = env.TMPDIR;
  env.TMPDIR = dir;
  return {
    dir,
    leave: () => {
      if (had) env.TMPDIR = previous;
      else delete env.TMPDIR;
      // 自分が作った名前の形のときだけ消す: 消す先を取り違えて上位へ広げないため
      if (
        resolve(dirname(dir)) === resolve(base) &&
        basename(dir).startsWith(PRIVATE_TMPDIR_PREFIX)
      ) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

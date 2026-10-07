import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 直接 `mkdtemp` / `mkdtempSync` を呼ぶ代わりに `makeTempDir` / `makeTempDirSync` を呼ぶ: 作ったパスは `vitest.setup.ts` の `afterAll` がテストファイルの最後に掃除する。
// 掃除は `afterEach` ではなくテストファイルの最後（`afterAll`）に行う: `beforeAll` やトップレベルの `beforeEach` で1つ作り複数の `it` が読む形があり、`afterEach` で消すと2本目以降が読もうとした時点でもう無いため。単位はファイル。
// 失敗を調べるために `ALTEROID_KEEP_TEST_TMPDIRS=1` で掃除だけをスキップするときも、記録は空にする: 同じファイルを再度読んでも二重に残さないため。残したパスは stdout ではなく stderr で報告する: 本物の stdout へ書くと `vitest.setup.ts` の歯に落ちるため。
// 子プロセスが自分で作る一時ディレクトリは対象外: ここが記録できるのは、このテストファイルのプロセス自身が `makeTempDir` / `makeTempDirSync` で作ったパスだけ。

const KEEP_ENV_VAR = 'ALTEROID_KEEP_TEST_TMPDIRS';

let createdThisFile: string[] = [];

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdThisFile.push(dir);
  return dir;
}

export function makeTempDirSync(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdThisFile.push(dir);
  return dir;
}

// 呼ばれる場所は `vitest.setup.ts` の1箇所だけにする: 各テストファイルが自分でも呼べる形にすると、「呼べば効くが呼び忘れれば何も起きない」ものが増えるだけのため。
export async function drainCreatedTempDirsForCurrentFile(): Promise<{
  dirs: readonly string[];
  kept: boolean;
}> {
  const dirs = createdThisFile;
  createdThisFile = [];
  const kept = process.env[KEEP_ENV_VAR] === '1';
  if (kept) {
    if (dirs.length > 0) {
      process.stderr.write(
        `vitest.tmpdir: ${KEEP_ENV_VAR}=1 のため ${dirs.length} 件を消さずに残した:\n` +
          dirs.map((d) => `  ${d}`).join('\n') +
          '\n',
      );
    }
    return { dirs, kept: true };
  }
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  return { dirs, kept: false };
}

export function peekCreatedTempDirsForTesting(): readonly string[] {
  return createdThisFile;
}

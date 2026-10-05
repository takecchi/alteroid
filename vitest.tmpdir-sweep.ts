import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * vitest 5.0.2 が `os.tmpdir()` 直下に作って**消し忘れる**ディレクトリの後始末（#3039）。
 *
 * ## 何が起きているか
 * vitest は forks pool のとき、変換済みモジュールを worker へ渡すために
 * `join(tmpdir(), nanoid())/<環境名>/<sha1(モジュールid)>` へ書く
 * （`vitest/dist/chunks/index.*.js` の `class Vitest` の `_tmpDir`、
 * `ModuleFetcher.fetch`）。nanoid は既定 21 文字、環境名は `client` / `ssr`。
 * 消す処理（`TestProject.clearTmpDir`）が rm するのは**プロジェクト自身の別の
 * `tmpDir`** で、`Vitest._tmpDir` を消す箇所は無い。⟹ 正常終了でも毎回 1 個残り、
 * kill された回も当然残る。`vitest.tmpdir.ts`（#1436）は `makeTempDir` 経由の
 * パスしか見ないので、この経路は対象外である。
 *
 * ## ここでやること（`vitest.global-setup.ts` が呼ぶ）
 * 1. 終了時（teardown）に自分の `Vitest._tmpDir` を消す。
 * 2. 開始時に、殺された回の取り残しを**厳しい条件を全部満たしたものだけ**消す。
 *
 * **黙って広く消さない。** どちらも条件を外れたら何も消さない。
 */

/** vitest の nanoid（既定 21 文字、alphabet は `[A-Za-z0-9_-]`）。 */
export const VITEST_TMPDIR_NAME = /^[A-Za-z0-9_-]{21}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ENV_NAMES: ReadonlySet<string> = new Set(['client', 'ssr']);

/**
 * 並行して走る他人の vitest の現役ディレクトリを消さないための線。
 * vitest 1 回がこれより長く走ることは無い、という判断（#3039）。
 */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface SweepStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mtimeMs: number;
}

/** 注入できる fs（テスト用）。`lstat` は symlink を辿らないこと。 */
export interface SweepFs {
  lstat(path: string): SweepStat;
  readdir(path: string): string[];
}

export const realSweepFs: SweepFs = {
  lstat: (p) => lstatSync(p),
  readdir: (p) => readdirSync(p),
};

/**
 * `dir` が「vitest が作って消し忘れた、もう使われていないディレクトリ」と
 * 言い切れるか。**次をすべて満たすときだけ true**（純粋: 消さない）。
 * - 名前が `^[A-Za-z0-9_-]{21}$`
 * - symlink ではなくディレクトリ
 * - 中身が `client` / `ssr`（1 つ以上）のディレクトリだけ。他のエントリが 1 つでもあれば false
 * - その下がすべて 40 桁 16 進名の通常ファイル（symlink・ディレクトリは false）
 * - トップと各サブディレクトリの mtime が `maxAgeMs` より古い
 */
export function isStaleVitestTmpDir(
  dir: string,
  fs: SweepFs,
  nowMs: number,
  maxAgeMs: number = STALE_AFTER_MS,
): boolean {
  if (!VITEST_TMPDIR_NAME.test(basename(dir))) return false;
  const isOld = (s: SweepStat) => nowMs - s.mtimeMs > maxAgeMs;

  const top = fs.lstat(dir);
  if (top.isSymbolicLink() || !top.isDirectory() || !isOld(top)) return false;

  const entries = fs.readdir(dir);
  if (entries.length === 0) return false;
  for (const name of entries) {
    if (!ENV_NAMES.has(name)) return false;
    const sub = fs.lstat(join(dir, name));
    if (sub.isSymbolicLink() || !sub.isDirectory() || !isOld(sub)) return false;
    for (const file of fs.readdir(join(dir, name))) {
      if (!HEX40.test(file)) return false;
      const st = fs.lstat(join(dir, name, file));
      if (st.isSymbolicLink() || !st.isFile()) return false;
    }
  }
  return true;
}

/** `p` が `os.tmpdir()` 直下の 21 文字名か。 */
export function isDirectChildOfTmpdirWithVitestName(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    VITEST_TMPDIR_NAME.test(basename(p)) &&
    resolve(dirname(p)) === resolve(tmpdir())
  );
}

/**
 * 取り残しを消す。`own` は自分の `_tmpDir`（除く）。消したパスを返す。
 * 1 件の失敗（他人が同時に消した等）は握って次へ進む。
 */
export function sweepStaleVitestTmpDirs(
  own: string | undefined,
  options: { root?: string; fs?: SweepFs; nowMs?: number; maxAgeMs?: number } = {},
): string[] {
  const root = options.root ?? tmpdir();
  const fs = options.fs ?? realSweepFs;
  const nowMs = options.nowMs ?? Date.now();
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdir(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    const dir = join(root, name);
    if (own !== undefined && resolve(dir) === resolve(own)) continue;
    try {
      if (!isStaleVitestTmpDir(dir, fs, nowMs, options.maxAgeMs)) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // 判定中に消えた・権限が無い、など。広げて消さずに次へ。
    }
  }
  return removed;
}

/**
 * vitest 本体が作った `Vitest._tmpDir`（内部 API）を取り出す。
 * 取れない・形が違うときは undefined（呼び出し側は何も消さず stderr に 1 行出す）。
 */
export function readVitestOwnTmpDir(project: unknown): string | undefined {
  const v = (project as { vitest?: { _tmpDir?: unknown } } | null | undefined)?.vitest?._tmpDir;
  return isDirectChildOfTmpdirWithVitestName(v) ? v : undefined;
}

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

// vitest 5.0.2 が `os.tmpdir()` 直下に作って消し忘れる21文字名のディレクトリを消す: `Vitest._tmpDir` を消す箇所が vitest に無く、`vitest.tmpdir.ts` は `makeTempDir` 経由のパスしか見ないため。
// 黙って広く消さない: 開始時の取り残しの回収も、厳しい条件を全部満たしたものだけを消し、外れたら何も消さない。
export const VITEST_TMPDIR_NAME = /^[A-Za-z0-9_-]{21}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const ENV_NAMES: ReadonlySet<string> = new Set(['client', 'ssr']);

// 並行して走る他人の vitest の現役ディレクトリを消さないための線: vitest 1 回がこれより長く走ることは無い、という判断。
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface SweepStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  mtimeMs: number;
}

export interface SweepFs {
  lstat(path: string): SweepStat;
  readdir(path: string): string[];
}

export const realSweepFs: SweepFs = {
  lstat: (p) => lstatSync(p),
  readdir: (p) => readdirSync(p),
};

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

export function isDirectChildOfTmpdirWithVitestName(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    VITEST_TMPDIR_NAME.test(basename(p)) &&
    resolve(dirname(p)) === resolve(tmpdir())
  );
}

export type RmFn = (path: string) => void;

const realRm: RmFn = (p) => rmSync(p, { recursive: true, force: true });

// 消す直前に基点・直下・名前を再確認し、満たさなければ何も消さず stderr に 1 行出す: `TMPDIR` が空・相対・`/` のとき、`/` や上位へ広がらないため。
export function safeRemoveVitestTmpDir(
  target: unknown,
  options: { base?: string; rm?: RmFn } = {},
): boolean {
  const base = options.base ?? tmpdir();
  const rm = options.rm ?? realRm;
  const refuse = (why: string): false => {
    process.stderr.write(
      `vitest.tmpdir-sweep: 消さなかった（${why}）: ${String(target)}（#3039）\n`,
    );
    return false;
  };
  if (typeof base !== 'string' || base === '' || !isAbsolute(base)) {
    return refuse('基点が空・未設定・相対パス');
  }
  const resolvedBase = resolve(base);
  if (resolvedBase === resolve('/')) return refuse('基点が /');
  if (typeof target !== 'string' || target === '') return refuse('対象が文字列でない');
  const resolvedTarget = resolve(target);
  if (dirname(resolvedTarget) !== resolvedBase) return refuse('対象が基点の直下でない');
  if (!VITEST_TMPDIR_NAME.test(basename(resolvedTarget)))
    return refuse('名前が 21 文字規則に当たらない');
  try {
    rm(resolvedTarget);
  } catch {
    return false;
  }
  return true;
}

export function sweepStaleVitestTmpDirs(
  own: string | undefined,
  options: { root?: string; fs?: SweepFs; nowMs?: number; maxAgeMs?: number; rm?: RmFn } = {},
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
      if (safeRemoveVitestTmpDir(dir, { base: root, rm: options.rm })) removed.push(dir);
    } catch {
      // 判定中に消えた・権限が無いなどの失敗は、広げて消さずに次へ進む。
    }
  }
  return removed;
}

export function readVitestOwnTmpDir(project: unknown): string | undefined {
  const v = (project as { vitest?: { _tmpDir?: unknown } } | null | undefined)?.vitest?._tmpDir;
  return isDirectChildOfTmpdirWithVitestName(v) ? v : undefined;
}

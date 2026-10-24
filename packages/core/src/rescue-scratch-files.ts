import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { RunnerRescueSkipped } from './runner-protocol.js';

/**
 * 担当の作業場（`/tmp/mgr-<id の頭>-*`）のうち、git の作業ツリーの外のファイルを列挙する（#5255）。
 * 作業ツリーの中は `git ls-files --others` が拾う（今の経路）ので、ここでは降りない: 二重に預けないため。
 * 名前の一覧を返すだけで、中身の扱い（上限・秘密・所有者・安定の判定）は `stashUntrackedFiles` に任せる。
 */

export const SCRATCH_FILES_LIMIT = 2000;
export const SCRATCH_DEPTH_LIMIT = 12;

/** 依存と生成物の置き場。ファイル名でも同じ名前は除く。 */
export const SCRATCH_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.pnpm-store',
  '.cache',
  '.venv',
  '__pycache__',
  'target',
  '.next',
  '.turbo',
]);

export interface ScratchDirEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

// readdir を差し替え可能にする: 件数・深さの上限と symlink を、実ファイルを大量に作らず再現するため
export type ScratchReaddirFn = (dir: string) => Promise<readonly ScratchDirEntry[]>;

const defaultReaddir: ScratchReaddirFn = (dir) => readdir(dir, { withFileTypes: true });

export interface ScratchListing {
  /** 置き場の根からの相対の名前（区切りは OS のもの）。 */
  readonly names: string[];
  /** 預けなかった分の知らせ（`stashUntrackedFiles` の `skipped` と同じ形）。 */
  readonly skipped: RunnerRescueSkipped[];
  /** 置き場の根が git の作業ツリーそのもの。今の経路だけで扱うので、何も列挙していない。 */
  readonly isWorktree: boolean;
}

export async function listScratchFiles(
  root: string,
  options: {
    readonly readdirFn?: ScratchReaddirFn;
    readonly maxFiles?: number;
    readonly maxDepth?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ScratchListing> {
  const readdirFn = options.readdirFn ?? defaultReaddir;
  const maxFiles = options.maxFiles ?? SCRATCH_FILES_LIMIT;
  const maxDepth = options.maxDepth ?? SCRATCH_DEPTH_LIMIT;
  const names: string[] = [];
  let truncated = false;
  let depthLimitedDirs = 0;
  let isWorktree = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated || options.signal?.aborted === true) return;
    let entries: readonly ScratchDirEntry[];
    try {
      entries = await readdirFn(dir);
    } catch {
      return;
    }
    // `.git` は dir でもファイル（`git worktree add` の gitfile）でも、作業ツリーの根の印
    if (entries.some((entry) => entry.name === '.git')) {
      if (dir === root) isWorktree = true;
      return;
    }
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of sorted) {
      if (SCRATCH_EXCLUDED_NAMES.has(entry.name)) continue;
      // symlink は辿らない（名前にも入れない）: 置き場の外を指して、外のファイルを預かりに引き込まないため
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        subdirs.push(entry.name);
        continue;
      }
      if (!entry.isFile()) continue;
      if (names.length >= maxFiles) {
        truncated = true;
        return;
      }
      names.push(path.relative(root, path.join(dir, entry.name)));
    }
    for (const name of subdirs) {
      if (truncated) return;
      if (depth >= maxDepth) {
        depthLimitedDirs += 1;
        continue;
      }
      await walk(path.join(dir, name), depth + 1);
    }
  }

  await walk(root, 0);
  const skipped: RunnerRescueSkipped[] = [];
  if (truncated) {
    skipped.push({
      path: '(省略)',
      reason: `cycle-budget（1つの置き場で列挙するファイルの上限 ${String(maxFiles)} 件。以降は列挙していない）`,
    });
  }
  if (depthLimitedDirs > 0) {
    skipped.push({
      path: '(省略)',
      reason: `cycle-budget（列挙する深さの上限 ${String(maxDepth)}。それより深いディレクトリ ${String(depthLimitedDirs)} 件の中は列挙していない）`,
    });
  }
  return { names, skipped, isWorktree };
}

import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { CLONE_MCP_CONFIG_DIR_PREFIX } from './clone-mcp-config-file.js';
import { reasonOf } from './dropped-record.js';
import {
  RUNNER_MCP_CONFIG_SWEEP_MIN_AGE_MS,
  type RunnerMcpConfigSweepResult,
} from './runner-mcp-config-sweep.js';

// runner の掃きと同じ下限（5 分）を共有する: 起こす側が mkdtemp してから生きた集合へ入れるまでの隙間が同じ形のため。
// 別の値にすると片方だけ競合の窓が開くので、定数ごと揃える
export const CLONE_MCP_CONFIG_SWEEP_MIN_AGE_MS = RUNNER_MCP_CONFIG_SWEEP_MIN_AGE_MS;

export type CloneMcpConfigSweepResult = RunnerMcpConfigSweepResult;

export interface CloneMcpConfigSweepOptions {
  tmpRoot: string;
  // このプロセスが作っていて、まだ remove していないディレクトリ（絶対パス）
  liveDirs: ReadonlySet<string>;
  now: number;
  minAgeMs?: number;
  ownPid: number;
  isPidAlive?: (pid: number) => boolean;
  rmFn?: (target: string) => Promise<void>;
}

// 投げなければ生きている、ESRCH は居ない。EPERM は居るが権限が無いだけなので生きている扱い（消さない側へ倒す）
export function isPidAliveBySignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// `alteroid-clone-mcp-<pid>-XXXXXX`。旧版の `alteroid-clone-mcp-XXXXXX` は数字の直後に `-` が無いので読めない（持ち主不明）。
// pid 0 は `kill(0, 0)` が自分のプロセスグループへの送信になり「生きている」を返すため、読めない側へ倒す
function pidOfName(name: string): number | undefined {
  const match = new RegExp(`^${CLONE_MCP_CONFIG_DIR_PREFIX}(\\d+)-`).exec(name);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid >= 1 ? pid : undefined;
}

export async function sweepCloneMcpConfigDirs(
  options: CloneMcpConfigSweepOptions,
): Promise<CloneMcpConfigSweepResult> {
  const result: CloneMcpConfigSweepResult = { removed: [], failed: [] };
  const minAgeMs = options.minAgeMs ?? CLONE_MCP_CONFIG_SWEEP_MIN_AGE_MS;
  const isPidAlive = options.isPidAlive ?? isPidAliveBySignal;
  const removeFn = options.rmFn ?? ((target) => rm(target, { recursive: true, force: true }));
  let names: string[];
  try {
    names = await readdir(options.tmpRoot);
  } catch (error) {
    result.scanError = `${options.tmpRoot} を読めなかった: ${reasonOf(error)}`;
    return result;
  }
  for (const name of names) {
    if (!name.startsWith(CLONE_MCP_CONFIG_DIR_PREFIX)) continue;
    const target = path.join(options.tmpRoot, name);
    try {
      const pid = pidOfName(name);
      if (pid === options.ownPid && options.liveDirs.has(target)) continue;
      if (pid !== undefined && pid !== options.ownPid && isPidAlive(pid)) continue;
      const info = await lstat(target);
      // symlink は辿らない: 付け替えられた先をデーモンの権限で再帰削除しないため
      if (!info.isDirectory()) continue;
      if (options.now - info.mtimeMs < minAgeMs) continue;
      await removeFn(target);
      result.removed.push(name);
    } catch (error) {
      result.failed.push({ name, reason: reasonOf(error) });
    }
  }
  return result;
}

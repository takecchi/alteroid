import { CLONE_MCP_CONFIG_DIR_PREFIX } from './clone-mcp-config-file.js';
import {
  RUNNER_MCP_CONFIG_SWEEP_MIN_AGE_MS,
  type RunnerMcpConfigSweepResult,
  sweepMcpConfigDirs,
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

export function sweepCloneMcpConfigDirs(
  options: CloneMcpConfigSweepOptions,
): Promise<CloneMcpConfigSweepResult> {
  const isPidAlive = options.isPidAlive ?? isPidAliveBySignal;
  return sweepMcpConfigDirs({
    ...options,
    prefix: CLONE_MCP_CONFIG_DIR_PREFIX,
    keep: (name, target) => {
      const pid = pidOfName(name);
      if (pid === options.ownPid && options.liveDirs.has(target)) return true;
      return pid !== undefined && pid !== options.ownPid && isPidAlive(pid);
    },
  });
}

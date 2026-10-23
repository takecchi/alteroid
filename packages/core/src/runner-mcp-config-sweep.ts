import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { reasonOf } from './dropped-record.js';

// CLI（`apps/cli/src/mcp.ts`）の一時ディレクトリは `alteroid-mcp-`。同じ接頭辞にすると掃きがそれを巻き込むため、runner 専用の名前にする
export const RUNNER_MCP_CONFIG_DIR_PREFIX = 'alteroid-runner-mcp-config-';

// 5 分: 起こす側は mkdtemp してからファイルを書き、生きた集合へ入れるまでに隙間があり、掃きがその間に当たっても消さないため。
// 長くしすぎると落ちた runner の資格入りファイルが残る時間が延びるので、競合を避けられる最小の桁に留める
export const RUNNER_MCP_CONFIG_SWEEP_MIN_AGE_MS = 5 * 60_000;

export interface RunnerMcpConfigSweepOptions {
  tmpRoot: string;
  // 今の runner が起こしていて、まだ終わっていない委譲のディレクトリ（絶対パス）
  liveDirs: ReadonlySet<string>;
  now: number;
  minAgeMs?: number;
  rmFn?: (target: string) => Promise<void>;
}

export interface RunnerMcpConfigSweepResult {
  removed: string[];
  failed: { name: string; reason: string }[];
  scanError?: string;
}

export async function sweepRunnerMcpConfigDirs(
  options: RunnerMcpConfigSweepOptions,
): Promise<RunnerMcpConfigSweepResult> {
  const result: RunnerMcpConfigSweepResult = { removed: [], failed: [] };
  const minAgeMs = options.minAgeMs ?? RUNNER_MCP_CONFIG_SWEEP_MIN_AGE_MS;
  const removeFn = options.rmFn ?? ((target) => rm(target, { recursive: true, force: true }));
  let names: string[];
  try {
    names = await readdir(options.tmpRoot);
  } catch (error) {
    result.scanError = `${options.tmpRoot} を読めなかった: ${reasonOf(error)}`;
    return result;
  }
  for (const name of names) {
    if (!name.startsWith(RUNNER_MCP_CONFIG_DIR_PREFIX)) continue;
    const target = path.join(options.tmpRoot, name);
    if (options.liveDirs.has(target)) continue;
    try {
      const info = await lstat(target);
      // symlink は辿らない: 付け替えられた先を runner の権限（root）で再帰削除しないため
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

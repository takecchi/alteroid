import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';

import type { RunnerExecutionResources } from './runner-protocol.js';

/**
 * `os` モジュールで代用しない: `os` が答えるのは器の外（ホスト）の値で、器がどれだけ
 * 絞られていても同じ数を返す（実測でメモリは 32GB の器に対し 346GB と10.8倍ずれた）。
 * 同じホストに並んだ runner が全部同じ数を名乗り、資源で選べなくなる。
 * CPU 数は器の絞り方によって cgroup とホストが偶然一致するので、試験はメモリで押さえる。
 *
 * `source: 'os'` を名乗るのは cgroup に上限が無いときだけ。
 *
 * pids は cgroup が読めなければ `os` へ倒れず欄ごと出さない:
 * 「ホストの pids 上限」に相当する概念が無いため。
 */
export const CGROUP_ROOT = '/sys/fs/cgroup';

export interface ExecutionResourcesOptions {
  cgroupRoot?: string;
  procCgroupPath?: string;
  /** 上限の無い器でだけ使う値なので、設定項目として外へ出さない。 */
  host?: { cores: number; totalBytes: number; freeBytes: number };
}

export async function readExecutionResources(
  options: ExecutionResourcesOptions = {},
): Promise<RunnerExecutionResources> {
  const host = options.host ?? {
    cores: cpus().length,
    totalBytes: totalmem(),
    freeBytes: freemem(),
  };
  const dirs = await cgroupDirs(options.cgroupRoot ?? CGROUP_ROOT, options.procCgroupPath);
  const [cpuMax, memoryMax, memoryCurrent, memoryStat, pidsCurrent, pidsMax] = await Promise.all([
    readFirst(dirs, 'cpu.max'),
    readFirst(dirs, 'memory.max'),
    readFirst(dirs, 'memory.current'),
    readFirst(dirs, 'memory.stat'),
    readFirst(dirs, 'pids.current'),
    readFirst(dirs, 'pids.max'),
  ]);
  const cpu = cpuOf(cpuMax, host);
  const memory = memoryOf(memoryMax, memoryCurrent, memoryStat, host);
  const pids = pidsOf(pidsCurrent, pidsMax);
  return {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
    ...(pids === undefined ? {} : { pids }),
  };
}

// 2箇所を見る: 名前空間が分かれていない器では根に `memory.max` が無く、根だけ見ると黙って「報告しない器」に落ちる。
async function cgroupDirs(root: string, procCgroupPath?: string): Promise<readonly string[]> {
  const own = (await readText(procCgroupPath ?? '/proc/self/cgroup'))
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('0::'))
    ?.slice('0::'.length);
  if (own === undefined || own === '' || own === '/') return [root];
  return [join(root, own), root];
}

async function readFirst(dirs: readonly string[], name: string): Promise<string | undefined> {
  for (const dir of dirs) {
    const text = await readText(join(dir, name));
    if (text !== undefined) return text;
  }
  return undefined;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

function cpuOf(raw: string | undefined, host: { cores: number }): RunnerExecutionResources['cpu'] {
  const [quota, period] = (raw ?? '').split(/\s+/);
  const cores = Number(quota) / Number(period);
  if (Number.isFinite(cores) && cores > 0) return { cores, source: 'cgroup' };
  return host.cores > 0 ? { cores: host.cores, source: 'os' } : undefined;
}

// `max` が数として読めなければ、`current` が読めていても欄ごと出さない: 現在値だけでは何に対する値か言えない。
function pidsOf(
  current: string | undefined,
  max: string | undefined,
): RunnerExecutionResources['pids'] {
  const maxValue = Number(max);
  const currentValue = Number(current);
  if (!Number.isSafeInteger(maxValue) || maxValue <= 0) return undefined;
  if (!Number.isFinite(currentValue) || currentValue < 0) return undefined;
  return { current: currentValue, max: maxValue };
}

function memoryOf(
  max: string | undefined,
  current: string | undefined,
  stat: string | undefined,
  host: { totalBytes: number; freeBytes: number },
): RunnerExecutionResources['memory'] {
  const limitBytes = Number(max);
  const usedRaw = Number(current);
  const limited = Number.isSafeInteger(limitBytes) && limitBytes > 0;
  if (limited && Number.isFinite(usedRaw) && usedRaw >= 0) {
    // 読み捨てできるページキャッシュは引く: 引かないと `git clone` 1回で器が「使用中」に見え、宛先から外れる。
    const reclaimable = statValueOf(stat, 'inactive_file') ?? 0;
    return { limitBytes, usedBytes: Math.max(0, usedRaw - reclaimable), source: 'cgroup' };
  }
  if (host.totalBytes > 0) {
    return {
      limitBytes: host.totalBytes,
      usedBytes: Math.max(0, host.totalBytes - host.freeBytes),
      source: 'os',
    };
  }
  return undefined;
}

function statValueOf(stat: string | undefined, key: string): number | undefined {
  const line = stat?.split('\n').find((entry) => entry.startsWith(`${key} `));
  if (line === undefined) return undefined;
  const value = Number(line.slice(key.length + 1).trim());
  return Number.isFinite(value) ? value : undefined;
}

// 生の累計値（差分は `cgroup-events.ts` が作る）。フォールバック先は無く、読めない欄は省略する（2欄は独立して省略され得る）。
export interface CgroupEventCounters {
  pidsMax?: number;
  oomKill?: number;
}

export async function readCgroupEventCounters(
  options: ExecutionResourcesOptions = {},
): Promise<CgroupEventCounters> {
  const dirs = await cgroupDirs(options.cgroupRoot ?? CGROUP_ROOT, options.procCgroupPath);
  const [pidsEvents, memoryEvents] = await Promise.all([
    readFirst(dirs, 'pids.events'),
    readFirst(dirs, 'memory.events'),
  ]);
  const pidsMax = eventCounterOf(pidsEvents, 'max');
  const oomKill = eventCounterOf(memoryEvents, 'oom_kill');
  return {
    ...(pidsMax === undefined ? {} : { pidsMax }),
    ...(oomKill === undefined ? {} : { oomKill }),
  };
}

function eventCounterOf(text: string | undefined, key: string): number | undefined {
  const line = text?.split('\n').find((entry) => entry.startsWith(`${key} `));
  if (line === undefined) return undefined;
  const value = Number(line.slice(key.length + 1).trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

import { readFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';

import type { RunnerCapacity } from './runner-protocol.js';

/**
 * 器の資源を測る（roadmap M5 — 配置の材料）。
 *
 * **これは上限ではなく実測である。** 「同時に何本まで」を決めるための数ではなく、
 * 新しい委譲をどの器へ置くかを選ぶための材料である。この2つを混同した瞬間に
 * 能力の制限になる（north_star 禁止2 / roadmap M5 の地雷）。
 *
 * コンテナでは `os.totalmem()` も `os.cpus()` も**ホストの量**を返し、cgroup の
 * 上限を見ない。そのままだと 512MB に絞られた器も 64GB の器も同じ「余裕あり」に
 * 見えて、配置が実態から外れる。だから cgroup v2 の値があればそちらを優先する。
 */
export interface CapacityIo {
  cpuCount(): number;
  load1m(): number;
  totalMemoryBytes(): number;
  freeMemoryBytes(): number;
  uptimeSeconds(): number;
  /** cgroup のファイルを読む。無い・読めないなら null（判断はしない）。 */
  readText(path: string): string | null;
}

const CGROUP_MEMORY_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_MEMORY_CURRENT = '/sys/fs/cgroup/memory.current';
const CGROUP_CPU_MAX = '/sys/fs/cgroup/cpu.max';

const defaultIo: CapacityIo = {
  cpuCount: () => cpus().length,
  load1m: () => loadavg()[0] ?? 0,
  totalMemoryBytes: () => totalmem(),
  freeMemoryBytes: () => freemem(),
  uptimeSeconds: () => uptime(),
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
};

function positiveNumber(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * cgroup v2 の CPU 割り当て（`cpu.max` は `<quota> <period>` か `max <period>`）。
 *
 * 端数を丸めない。0.5 コアの器を 1 コアと見ると、そこへ寄せた委譲が実際には
 * 走り切らない。
 */
function cgroupCpuCount(io: CapacityIo): number | null {
  const raw = io.readText(CGROUP_CPU_MAX);
  if (raw === null) return null;
  const [quota, period] = raw.trim().split(/\s+/);
  if (quota === undefined || quota === 'max') return null;
  const quotaValue = positiveNumber(quota);
  const periodValue = positiveNumber(period ?? '100000');
  if (quotaValue === null || periodValue === null) return null;
  return quotaValue / periodValue;
}

/** cgroup v2 のメモリ（`memory.max` が `max` なら上限なし＝ホストの量を使う）。 */
function cgroupMemory(io: CapacityIo): { total: number; free: number } | null {
  const max = positiveNumber(io.readText(CGROUP_MEMORY_MAX));
  if (max === null) return null;
  const current = positiveNumber(io.readText(CGROUP_MEMORY_CURRENT)) ?? 0;
  return { total: max, free: Math.max(0, max - current) };
}

/**
 * いまの資源を1枚の報告にする。
 *
 * `activeManagers` は**いま抱えている本数**であって定員ではない。詰まっていても
 * 報告するだけで、置けるかどうかを runner が決めることはない（決めるのは配置側で
 * あり、そこでも上限として使わない）。
 */
export function measureCapacity(
  activeManagers: number,
  overrides: Partial<CapacityIo> = {},
): RunnerCapacity {
  const io: CapacityIo = { ...defaultIo, ...overrides };
  const memory = cgroupMemory(io);
  const total = memory?.total ?? io.totalMemoryBytes();
  const free = memory?.free ?? io.freeMemoryBytes();

  return {
    cpuCount: Math.max(cgroupCpuCount(io) ?? io.cpuCount(), 0.1),
    load1m: Math.max(io.load1m(), 0),
    totalMemoryBytes: Math.max(total, 0),
    freeMemoryBytes: Math.max(Math.min(free, total), 0),
    activeManagers,
    uptimeSeconds: Math.max(io.uptimeSeconds(), 0),
  };
}

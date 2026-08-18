import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';

import type { RunnerExecutionResources } from './runner-protocol.js';

/**
 * 実行環境の資源を読む（roadmap M5 PR3「cgroup v2 で実行環境の資源を読む」）。
 *
 * **`os` モジュールで代用しないこと。** `os` が答えるのは器の外（ホスト）の値で、
 * 器がどれだけ絞られていても同じ数を返す。実測（runner の器の中・2026-08-19）:
 *
 * ```
 * $ cat /sys/fs/cgroup/memory.max            # 32000000000     (32GB)
 * $ node -e 'console.log(os.totalmem())'     # 346488946688    (346GB — ホスト)
 * $ cat /sys/fs/cgroup/cpu.max               # 3200000 100000  (= 32 コア)
 * $ node -e 'console.log(os.cpus().length)'  # 48              (ホスト)
 * ```
 *
 * メモリは **10.8倍** ずれる。`os` を読むと、同じホストに並んだ runner が全部同じ
 * 数を名乗るので、資源で選んでいるつもりで登録順に選んでいるのと変わらなくなる。
 * **CPU 数だけで確かめると気づけないことがある** — 器の絞り方によっては cgroup と
 * ホストの数が偶然一致するので、値が合っているせいで違和感が出ない。だから
 * `runner-resources.test.ts` はメモリで押さえてある。
 *
 * `os.freemem()` も同じ理由でホストの空きである。ここが `source: 'os'` を名乗るのは
 * **cgroup に上限が無いときだけ**で、そのときはホストの値が本当にこの器の使える量で
 * ある。どちらを読めたかを黙って混ぜないために `source` を残す。
 */
export const CGROUP_ROOT = '/sys/fs/cgroup';

export interface ExecutionResourcesOptions {
  /** cgroup v2 のマウント先。**主にテスト用で、既定はコードに固定である。** */
  cgroupRoot?: string;
  /** 自分がどの cgroup に居るかが書いてある場所。主にテスト用。 */
  procCgroupPath?: string;
  /**
   * ホスト（`os`）の値。**主にテスト用。**
   *
   * 上限の無い器でだけ使う値なので、ここを設定項目として外へ出さない。
   */
  host?: { cores: number; totalBytes: number; freeBytes: number };
}

/** いまの器の資源。**読めなかった材料は名乗らない**（嘘の報告を作らない）。 */
export async function readExecutionResources(
  options: ExecutionResourcesOptions = {},
): Promise<RunnerExecutionResources> {
  const host = options.host ?? {
    cores: cpus().length,
    totalBytes: totalmem(),
    freeBytes: freemem(),
  };
  const dirs = await cgroupDirs(options.cgroupRoot ?? CGROUP_ROOT, options.procCgroupPath);
  const [cpuMax, memoryMax, memoryCurrent, memoryStat] = await Promise.all([
    readFirst(dirs, 'cpu.max'),
    readFirst(dirs, 'memory.max'),
    readFirst(dirs, 'memory.current'),
    readFirst(dirs, 'memory.stat'),
  ]);
  const cpu = cpuOf(cpuMax, host);
  const memory = memoryOf(memoryMax, memoryCurrent, memoryStat, host);
  return {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memory === undefined ? {} : { memory }),
  };
}

/**
 * cgroup のファイルがある場所。**2箇所を見る。**
 *
 * 器の cgroup 名前空間が分かれていれば `/sys/fs/cgroup` がそのまま自分の階層で、
 * `/proc/self/cgroup` は `0::/` を返す。分かれていない器では自分の位置が
 * `0::/docker/…` のように書いてあり、**根っこには `memory.max` が無い**
 * （v2 の root cgroup は制限を持たない）。片方しか見ないと、後者の器で資源を
 * 読めず、その器が黙って「報告しない器」に落ちる。
 */
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

/** `cpu.max` は `"<quota> <period>"`。上限の無い器は quota が `max` である。 */
function cpuOf(raw: string | undefined, host: { cores: number }): RunnerExecutionResources['cpu'] {
  const [quota, period] = (raw ?? '').split(/\s+/);
  const cores = Number(quota) / Number(period);
  if (Number.isFinite(cores) && cores > 0) return { cores, source: 'cgroup' };
  return host.cores > 0 ? { cores: host.cores, source: 'os' } : undefined;
}

function memoryOf(
  max: string | undefined,
  current: string | undefined,
  stat: string | undefined,
  host: { totalBytes: number; freeBytes: number },
): RunnerExecutionResources['memory'] {
  const limitBytes = Number(max);
  const usedRaw = Number(current);
  // 「上限なし」は v2 では `max` だが、桁で表す器もある。**数として読めても上限では
  // ない** — ホストのメモリを超える上限は上限ではないので、`os` として名乗る。
  const limited = Number.isSafeInteger(limitBytes) && limitBytes > 0;
  if (limited && Number.isFinite(usedRaw) && usedRaw >= 0) {
    // **読み捨てできるページキャッシュは引く。** `memory.current` はファイル
    // キャッシュを含むので、引かないと `git clone` を1回した器が「使用中」に見え、
    // 何もしていない器が宛先から外れる。
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

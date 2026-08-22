import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readExecutionResources } from './runner-resources.js';

/**
 * 実行環境の資源の読み方（M5 / PR3「cgroup v2 で読む」）。
 *
 * **ここはメモリで押さえてある。** CPU 数だけで確かめると、器の絞り方によっては
 * cgroup とホストの数が偶然一致し、`os` モジュールを読む実装でも「正しく見える」
 * ことがある（値が合っているので違和感が出ない）。メモリは桁が違うので誤魔化せない —
 * 実測した runner の器では cgroup が 32GB、`os.totalmem()` が 346GB で **10.8倍**
 * 離れていた。
 */

/** 実測値（runner の器の中・2026-08-19）。**ホストの値と混ぜないための対照である。** */
const HOST = { cores: 48, totalBytes: 346_488_946_688, freeBytes: 165_950_504_960 };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'alteroid-cgroup-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** cgroup v2 の器を偽装する（実測した書式そのまま）。 */
function place(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
}

const CGROUP_FILES = {
  'cpu.max': '3200000 100000\n',
  'memory.max': '32000000000\n',
  'memory.current': '1047240704\n',
  'memory.stat': 'file 288514048\ninactive_file 182104064\nactive_file 106409984\n',
};

async function read(procCgroup?: string) {
  return readExecutionResources({
    cgroupRoot: root,
    procCgroupPath: procCgroup ?? join(root, 'proc-cgroup'),
    host: HOST,
  });
}

describe('実行環境の資源', () => {
  it('cgroup の上限を読む。**ホスト（os）の値を読まない**', async () => {
    place(root, CGROUP_FILES);
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const resources = await read();

    expect(resources.memory?.source).toBe('cgroup');
    expect(resources.memory?.limitBytes).toBe(32_000_000_000);
    // **ここが押さえどころである。** `os.totalmem()` を読む実装はこの器で 346GB を
    // 名乗り、同じホストに並んだ runner が全部同じ数を報告する。
    expect(resources.memory?.limitBytes).not.toBe(HOST.totalBytes);

    expect(resources.cpu?.source).toBe('cgroup');
    // `3200000 / 100000` = 32 コア。ホストは 48 コアである。
    expect(resources.cpu?.cores).toBe(32);
    expect(resources.cpu?.cores).not.toBe(HOST.cores);
  });

  it('使用量から読み捨てできるページキャッシュを引く', async () => {
    place(root, CGROUP_FILES);
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const resources = await read();

    // `memory.current`（1047240704）から `inactive_file`（182104064）を引いた分。
    // 引かないと、`git clone` を1回した器が「使用中」に見えて宛先から外れる。
    expect(resources.memory?.usedBytes).toBe(1_047_240_704 - 182_104_064);
  });

  it('上限の無い器では os の値を名乗る（どちらを読めたかを黙って混ぜない）', async () => {
    place(root, { ...CGROUP_FILES, 'cpu.max': 'max 100000\n', 'memory.max': 'max\n' });
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const resources = await read();

    // 上限が無いなら、ホストの値が本当にこの器の使える量である。**ただしそう言う。**
    expect(resources.memory?.source).toBe('os');
    expect(resources.memory?.limitBytes).toBe(HOST.totalBytes);
    expect(resources.memory?.usedBytes).toBe(HOST.totalBytes - HOST.freeBytes);
    expect(resources.cpu?.source).toBe('os');
    expect(resources.cpu?.cores).toBe(HOST.cores);
  });

  it('「上限なし」を桁で表す器でも、それを上限として名乗らない', async () => {
    // v1 の頃の書式。数として読めるので、素直に読むとホストより大きい上限を
    // 「cgroup の上限」として報告してしまう。
    place(root, { ...CGROUP_FILES, 'memory.max': '9223372036854771712\n' });
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const resources = await read();

    expect(resources.memory?.source).toBe('os');
    expect(resources.memory?.limitBytes).toBe(HOST.totalBytes);
  });

  it('cgroup が無い器でも黙らない（os の値で答える）', async () => {
    const resources = await readExecutionResources({
      cgroupRoot: join(root, 'no-such-cgroup'),
      procCgroupPath: join(root, 'no-such-proc'),
      host: HOST,
    });

    // **報告しないのではなく、読めたものを読めた出典で答える。** ここで何も
    // 返さないと、cgroup を持たない器が配置の材料を1つも持てなくなる。
    expect(resources.memory?.source).toBe('os');
    expect(resources.cpu?.source).toBe('os');
  });

  it('cgroup 名前空間が分かれていない器では、自分の階層を読む', async () => {
    // ホストの階層がそのまま見えている器。根っこ（v2 の root cgroup）には上限が
    // 無いので、`/proc/self/cgroup` の位置を辿らないと資源を1つも読めない。
    place(join(root, 'docker', 'abc123'), CGROUP_FILES);
    writeFileSync(join(root, 'proc-cgroup'), '0::/docker/abc123\n');

    const resources = await read();

    expect(resources.memory?.source).toBe('cgroup');
    expect(resources.memory?.limitBytes).toBe(32_000_000_000);
    expect(resources.cpu?.cores).toBe(32);
  });
});

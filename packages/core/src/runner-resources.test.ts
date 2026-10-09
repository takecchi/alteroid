import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { readCgroupEventCounters, readExecutionResources } from './runner-resources.js';

/** CPU 数だけで確かめない: cgroup とホストの数が偶然一致すると `os` を読む実装でも通る。メモリは桁が違うので誤魔化せない。 */
const HOST = { cores: 48, totalBytes: 346_488_946_688, freeBytes: 165_950_504_960 };

let root: string;

beforeEach(() => {
  root = makeTempDirSync('alteroid-cgroup-');
});

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
    expect(resources.memory?.limitBytes).not.toBe(HOST.totalBytes);

    expect(resources.cpu?.source).toBe('cgroup');
    expect(resources.cpu?.cores).toBe(32);
    expect(resources.cpu?.cores).not.toBe(HOST.cores);
  });

  it('使用量から読み捨てできるページキャッシュを引く', async () => {
    place(root, CGROUP_FILES);
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const resources = await read();

    expect(resources.memory?.usedBytes).toBe(1_047_240_704 - 182_104_064);
  });

  it('上限の無い器では os の値を名乗る（どちらを読めたかを黙って混ぜない）', async () => {
    place(root, { ...CGROUP_FILES, 'cpu.max': 'max 100000\n', 'memory.max': 'max\n' });
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const resources = await read();

    expect(resources.memory?.source).toBe('os');
    expect(resources.memory?.limitBytes).toBe(HOST.totalBytes);
    expect(resources.memory?.usedBytes).toBe(HOST.totalBytes - HOST.freeBytes);
    expect(resources.cpu?.source).toBe('os');
    expect(resources.cpu?.cores).toBe(HOST.cores);
  });

  it('「上限なし」を桁で表す器でも、それを上限として名乗らない', async () => {
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

    expect(resources.memory?.source).toBe('os');
    expect(resources.cpu?.source).toBe('os');
  });

  it('cgroup 名前空間が分かれていない器では、自分の階層を読む', async () => {
    place(join(root, 'docker', 'abc123'), CGROUP_FILES);
    writeFileSync(join(root, 'proc-cgroup'), '0::/docker/abc123\n');

    const resources = await read();

    expect(resources.memory?.source).toBe('cgroup');
    expect(resources.memory?.limitBytes).toBe(32_000_000_000);
    expect(resources.cpu?.cores).toBe(32);
  });
});

describe('pids（プロセス数）', () => {
  it('cgroup の pids.current / pids.max を読む', async () => {
    place(root, { ...CGROUP_FILES, 'pids.current': '872\n', 'pids.max': '1000\n' });
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const resources = await read();

    expect(resources.pids).toEqual({ current: 872, max: 1000 });
  });

  it('上限の無い器（pids.max が `max`）では、cpu/memory が os へ倒れても pids だけ欄ごと出ない', async () => {
    place(root, { ...CGROUP_FILES, 'pids.current': '872\n', 'pids.max': 'max\n' });
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const resources = await read();

    expect(resources.memory?.source).toBe('cgroup');
    expect(resources.cpu?.source).toBe('cgroup');
    expect(resources.pids).toBeUndefined();
  });

  it('pids.current が読めなければ、pids.max だけがあっても欄ごと出さない', async () => {
    place(root, { ...CGROUP_FILES, 'pids.max': '1000\n' });
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const resources = await read();

    expect(resources.pids).toBeUndefined();
  });

  it('cgroup 自体が無い器では、cpu/memory は os の値で答えるが pids は出ない', async () => {
    const resources = await readExecutionResources({
      cgroupRoot: join(root, 'no-such-cgroup'),
      procCgroupPath: join(root, 'no-such-proc'),
      host: HOST,
    });

    expect(resources.cpu?.source).toBe('os');
    expect(resources.memory?.source).toBe('os');
    expect(resources.pids).toBeUndefined();
  });
});

describe('cgroup イベント（pids.events / memory.events。#1517）', () => {
  async function readEvents(procCgroup?: string) {
    return readCgroupEventCounters({
      cgroupRoot: root,
      procCgroupPath: procCgroup ?? join(root, 'proc-cgroup'),
    });
  }

  it('pids.events の max と memory.events の oom_kill を読む', async () => {
    place(root, {
      ...CGROUP_FILES,
      'pids.events': 'max 3\nmax 0\n',
      'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 2\noom_group_kill 0\n',
    });
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const counters = await readEvents();

    expect(counters).toEqual({ pidsMax: 3, oomKill: 2 });
  });

  it('両方 0（何も起きていない）でも、0 として読む——欠落と混ぜない', async () => {
    place(root, {
      ...CGROUP_FILES,
      'pids.events': 'max 0\n',
      'memory.events': 'oom_kill 0\n',
    });
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const counters = await readEvents();

    expect(counters).toEqual({ pidsMax: 0, oomKill: 0 });
  });

  it('片方のファイルが無くても、もう片方は独立して読める（コントローラを選んで有効化できるため）', async () => {
    place(root, { ...CGROUP_FILES, 'pids.events': 'max 5\n' });
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const counters = await readEvents();

    expect(counters).toEqual({ pidsMax: 5 });
    expect(Object.hasOwn(counters, 'oomKill')).toBe(false);
  });

  it('読めない・パースできないなら、その欄は出さない（0 と混ぜない）', async () => {
    place(root, { ...CGROUP_FILES, 'pids.events': 'max notanumber\n' });
    writeFileSync(join(root, 'proc-cgroup'), '0::/\n');

    const counters = await readEvents();

    expect(Object.hasOwn(counters, 'pidsMax')).toBe(false);
  });

  it('cgroup 自体が無い器では、両方の欄が出ない（os 相当の代替が無い）', async () => {
    const counters = await readCgroupEventCounters({
      cgroupRoot: join(root, 'no-such-cgroup'),
      procCgroupPath: join(root, 'no-such-proc'),
    });

    expect(counters).toEqual({});
  });
});

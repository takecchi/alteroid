import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { stat } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runnerExecutionResourcesSchema } from '@alteroid/core';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { RECLAIM_ENV_KEY, reclaimScanOf, withTerminatedReclaimSessions } from './index.js';
import {
  startReclaimSweep,
  TaskBreakdownReader,
  type ReclaimReapOptions,
  type ReclaimSessionView,
} from './tasks.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

// 実物の `/proc` を読まない: 走らせる器によって値が変わり、固定できないため。

let root: string;

beforeEach(() => {
  root = makeTempDirSync('alteroid-proc-');
});

function statLine(
  pid: number,
  comm: string,
  state: string,
  numThreads: number,
  starttime: number,
  ppid = 1,
  sid = 1,
): string {
  const fields: Array<string | number> = [
    state,
    ppid,
    1,
    sid,
    0,
    -1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    20,
    0,
    numThreads,
    0,
    starttime,
  ];
  return `${pid} (${comm}) ${fields.join(' ')}\n`;
}

function placeProcess(
  procRoot: string,
  pid: number,
  comm: string,
  state: string,
  numThreads: number,
  starttime: number,
  ppid = 1,
  sid = 1,
): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), statLine(pid, comm, state, numThreads, starttime, ppid, sid));
}

function placeUptime(procRoot: string, uptimeSeconds: number): void {
  writeFileSync(join(procRoot, 'uptime'), `${uptimeSeconds} ${uptimeSeconds * 0.9}\n`);
}

describe('TaskBreakdownReader（#315 の可視化。/proc を state 別に集計する）', () => {
  it('生存プロセスとゾンビを分けて数える（threads は num_threads の合計）', async () => {
    placeProcess(root, 100, 'node', 'S', 5, 0);
    placeProcess(root, 200, 'esbuild', 'Z', 1, 0);
    placeProcess(root, 201, 'sh', 'Z', 1, 0);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.threads).toBe(7);
    expect(result?.processes).toBe(3);
    expect(result?.zombies).toBe(2);
  });

  it('comm に空白と ) を含むゾンビでも、最後の ") " で正しく切って comm を取り出す', async () => {
    placeProcess(root, 300, 'sh (weird) name', 'Z', 1, 0);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.zombies).toBe(1);
    expect(result?.zombieCommands).toEqual([{ command: 'sh (weird) name', count: 1 }]);
  });

  it('ゾンビが0本なら zombieCommands と oldestZombieSeconds が欄ごと出ない', async () => {
    placeProcess(root, 100, 'node', 'S', 3, 0);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.zombies).toBe(0);
    expect(result?.zombieCommands).toBeUndefined();
    expect(result?.oldestZombieSeconds).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, 'zombieCommands')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'oldestZombieSeconds')).toBe(false);
  });

  it('ゾンビの comm が8件を超えたら、超えた分を「その他」へまとめる（切り捨てない）', async () => {
    let pid = 400;
    const commands = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    for (const [index, command] of commands.entries()) {
      const count = commands.length - index;
      for (let n = 0; n < count; n += 1) {
        placeProcess(root, pid, command, 'Z', 1, 0);
        pid += 1;
      }
    }
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.zombieCommands).toHaveLength(9);
    const other = result?.zombieCommands?.find((entry) => entry.command === 'その他');
    expect(other?.count).toBe(2 + 1);
    for (const command of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(result?.zombieCommands?.some((entry) => entry.command === command)).toBe(true);
    }
  });

  it('いちばん古いゾンビの年齢を uptime と starttime から計算する', async () => {
    placeProcess(root, 500, 'esbuild', 'Z', 1, 100_000);
    placeProcess(root, 501, 'node', 'Z', 1, 140_000);
    placeUptime(root, 1500);

    const reader = new TaskBreakdownReader({ procRoot: root, clockTicksPerSecond: 100 });
    const result = await reader.read();

    expect(result?.oldestZombieSeconds).toBe(500);
  });

  it('uptime が読めなければ oldestZombieSeconds だけ省き、他の欄は出す', async () => {
    placeProcess(root, 600, 'esbuild', 'Z', 1, 0);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.zombies).toBe(1);
    expect(result?.zombieCommands).toEqual([{ command: 'esbuild', count: 1 }]);
    expect(result?.oldestZombieSeconds).toBeUndefined();
  });

  it('stat が無い（消えた）pid ディレクトリは黙って飛ばす', async () => {
    placeProcess(root, 700, 'node', 'S', 4, 0);
    mkdirSync(join(root, '701'));
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.processes).toBe(1);
    expect(result?.threads).toBe(4);
  });

  it('数字でないエントリ（self 等）を pid として数えない', async () => {
    placeProcess(root, 800, 'node', 'S', 2, 0);
    mkdirSync(join(root, 'self'));
    writeFileSync(join(root, 'self', 'stat'), statLine(800, 'node', 'S', 2, 0));
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.processes).toBe(1);
  });

  it('/proc が無い環境では undefined を返す（欄ごと出さない）', async () => {
    const reader = new TaskBreakdownReader({ procRoot: join(root, 'no-such-proc') });

    const result = await reader.read();

    expect(result).toBeUndefined();
  });

  it('TTL の内側では走査し直さず、TTL を超えたら走査し直す', async () => {
    let now = 0;
    placeProcess(root, 900, 'node', 'S', 1, 0);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, ttlMs: 1000, now: () => now });

    const first = await reader.read();
    expect(first?.processes).toBe(1);

    placeProcess(root, 901, 'node', 'S', 1, 0);
    now = 500;
    const second = await reader.read();
    expect(second?.processes).toBe(1);

    now = 1500;
    const third = await reader.read();
    expect(third?.processes).toBe(2);
  });
});

describe('走査は1本だけ走る（走査中の要求は相乗りする）', () => {
  const OWN_UID = process.getuid?.() ?? 0;

  // 走査を途中で止めておくための口: 所有 UID の読みを、外から開けるまで返さない。
  function gatedOwnerUid() {
    const calls: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const ownerUidOf = async (_procRoot: string, pid: string): Promise<number | undefined> => {
      calls.push(pid);
      await gate;
      return OWN_UID;
    };
    return { calls, ownerUidOf, open: () => open() };
  }

  it('走査中に届いた read() は、新しく走査せず、走っている走査の結果を受け取る', async () => {
    placeProcess(root, 700, 'node', 'S', 2, 0);
    placeUptime(root, 1000);
    const gated = gatedOwnerUid();
    const reader = new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
      ownerUidOf: gated.ownerUidOf,
    });

    const first = reader.read();
    const second = reader.read();
    await vi.waitFor(() => expect(gated.calls.length).toBeGreaterThan(0));
    gated.open();
    const [a, b] = await Promise.all([first, second]);

    expect(gated.calls).toEqual(['700']);
    expect(b).toBe(a);
    expect(a?.processes).toBe(1);
  });

  it('回収の掃除（sweepIfStale）も、走っている走査に相乗りする', async () => {
    placeProcess(root, 710, 'node', 'S', 1, 0);
    placeUptime(root, 1000);
    const gated = gatedOwnerUid();
    const reader = new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
      ownerUidOf: gated.ownerUidOf,
    });

    const read = reader.read();
    const sweep = reader.sweepIfStale(0);
    await vi.waitFor(() => expect(gated.calls.length).toBeGreaterThan(0));
    gated.open();
    await Promise.all([read, sweep]);

    expect(gated.calls).toEqual(['710']);
  });

  it('走査が終わった後の、TTL を過ぎた read() は走査し直す（相乗りは走っている間だけ）', async () => {
    let now = 0;
    placeProcess(root, 720, 'node', 'S', 1, 0);
    placeUptime(root, 1000);
    const reader = new TaskBreakdownReader({ procRoot: root, ttlMs: 1000, now: () => now });

    expect((await reader.read())?.processes).toBe(1);
    placeProcess(root, 721, 'node', 'S', 1, 0);
    now = 1500;
    expect((await reader.read())?.processes).toBe(2);
  });

  it('走査が失敗しても次の read() は詰まらない（走っている走査の印を残さない）', async () => {
    placeProcess(root, 730, 'node', 'S', 1, 0);
    placeUptime(root, 1000);
    let fail = true;
    // 所有 UID の読みの失敗は走査の中で「読めなかった」に数えられて走査は通るので、走査そのものを落とすには委譲の pid の集合の読みを投げさせる。
    const reader = new TaskBreakdownReader({
      procRoot: root,
      ttlMs: 0,
      ownerUidOf: () => Promise.resolve(OWN_UID),
      reclaim: {
        childUid: OWN_UID,
        sessions: {
          liveSessionPidsOf: () => {
            if (fail) throw new Error('帳面が読めない');
            return new Set();
          },
          knownTerminatedSessionPidsOf: () => new Set(),
        },
      },
    });

    await expect(reader.read()).rejects.toThrow('帳面が読めない');
    fail = false;
    expect((await reader.read())?.processes).toBe(1);
  });
});

describe('孤児プロセス木の観測（#315 段0。数えるだけで撃たない）', () => {
  const OWN_UID = process.getuid?.() ?? 0;

  let cgroupRoot: string;

  beforeEach(() => {
    cgroupRoot = makeTempDirSync('alteroid-cgroup-');
  });

  function placeCgroupPids(current: string, max: string): { procCgroupPath: string } {
    writeFileSync(join(cgroupRoot, 'pids.current'), `${current}\n`);
    writeFileSync(join(cgroupRoot, 'pids.max'), `${max}\n`);
    const procCgroupPath = join(cgroupRoot, 'self-cgroup');
    writeFileSync(procCgroupPath, '0::/\n');
    return { procCgroupPath };
  }

  it('切ってあれば reclaim は欄ごと出ない（0 の行を作らない）', async () => {
    placeProcess(root, 100, 'node', 'S', 3, 0, 1);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.reclaim).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, 'reclaim')).toBe(false);
  });

  it('孤児ルートの部分木を丸ごと数える（ルートに繋がらないものは数えない）', async () => {
    placeProcess(root, 10, 'pnpm', 'S', 3, 0, 1);
    placeProcess(root, 11, 'node', 'S', 5, 0, 10);
    placeProcess(root, 12, 'esbuild', 'S', 2, 0, 11);
    placeProcess(root, 20, 'node', 'S', 7, 0, 999);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(3);
    expect(result?.reclaim?.candidateThreads).toBe(3 + 5 + 2);
    expect(result?.processes).toBe(4);
    expect(result?.threads).toBe(3 + 5 + 2 + 7);
  });

  it('root が所有する ppid=1 は孤児ルートにしない（その下の生きたセッションを候補に数えない）', async () => {
    placeProcess(root, 6, 'node', 'S', 11, 0, 1);
    placeProcess(root, 32, 'claude', 'S', 18, 0, 6);
    placeProcess(root, 40, 'pnpm', 'S', 4, 0, 1);
    placeProcess(root, 41, 'node', 'S', 6, 0, 40);
    placeUptime(root, 1000);

    const childUid = OWN_UID + 1;
    const reader = new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid },
      ownerUidOf: (_procRoot, pid) => Promise.resolve(pid === '6' ? 0 : childUid),
    });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(2);
    expect(result?.reclaim?.candidateThreads).toBe(4 + 6);
  });

  it('所有 UID が降ろした UID と一致しなければ候補は0本', async () => {
    placeProcess(root, 50, 'pnpm', 'S', 3, 0, 1);
    placeProcess(root, 51, 'node', 'S', 5, 0, 50);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID + 1 },
    });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(0);
    expect(result?.reclaim?.candidateThreads).toBe(0);
  });

  it('D と Z は候補に数えないが、その下の子は数える（通り抜ける）', async () => {
    placeProcess(root, 60, 'dd', 'D', 1, 0, 1);
    placeProcess(root, 61, 'node', 'S', 4, 0, 60);
    placeProcess(root, 62, 'sh', 'Z', 1, 0, 1);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(1);
    expect(result?.reclaim?.candidateThreads).toBe(4);
    expect(result?.zombies).toBe(1);
  });

  it('いちばん古い候補の年齢を uptime と starttime から出す', async () => {
    placeProcess(root, 70, 'pnpm', 'S', 1, 100_000, 1);
    placeProcess(root, 71, 'node', 'S', 1, 140_000, 1);
    placeUptime(root, 1500);

    const reader = new TaskBreakdownReader({
      procRoot: root,
      clockTicksPerSecond: 100,
      reclaim: { childUid: OWN_UID },
    });
    const result = await reader.read();

    expect(result?.reclaim?.oldestAgeSec).toBe(500);
  });

  it('候補が0本なら oldestAgeSec は欄ごと出ない（candidates は 0 のまま出す）', async () => {
    placeProcess(root, 80, 'node', 'S', 3, 0, 999);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(0);
    expect(result?.reclaim?.oldestAgeSec).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'oldestAgeSec')).toBe(false);
  });

  describe('木の構造（#1334。roots / largestTreeCandidates / singletonTrees）', () => {
    it('ルート1本＋子N本の木は roots=1 / largestTreeCandidates=N+1 / singletonTrees=0', async () => {
      placeProcess(root, 10, 'pnpm', 'S', 3, 0, 1);
      placeProcess(root, 11, 'node', 'S', 5, 0, 10);
      placeProcess(root, 12, 'esbuild', 'S', 2, 0, 10);
      placeProcess(root, 13, 'sh', 'S', 1, 0, 11);
      placeUptime(root, 1000);

      const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(4);
      expect(result?.reclaim?.roots).toBe(1);
      expect(result?.reclaim?.largestTreeCandidates).toBe(4);
      expect(result?.reclaim?.singletonTrees).toBe(0);
    });

    it('単独のルート3本は roots=3 / largestTreeCandidates=1 / singletonTrees=3', async () => {
      placeProcess(root, 20, 'a', 'S', 1, 0, 1);
      placeProcess(root, 21, 'b', 'S', 1, 0, 1);
      placeProcess(root, 22, 'c', 'S', 1, 0, 1);
      placeUptime(root, 1000);

      const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(3);
      expect(result?.reclaim?.roots).toBe(3);
      expect(result?.reclaim?.largestTreeCandidates).toBe(1);
      expect(result?.reclaim?.singletonTrees).toBe(3);
    });

    it('混在（大きい木1本＋単独2本）は roots=3 / largestTreeCandidates=木の本数 / singletonTrees=2', async () => {
      placeProcess(root, 30, 'pnpm', 'S', 1, 0, 1);
      placeProcess(root, 31, 'node', 'S', 1, 0, 30);
      placeProcess(root, 32, 'node', 'S', 1, 0, 30);
      placeProcess(root, 33, 'node', 'S', 1, 0, 30);
      placeProcess(root, 34, 'node', 'S', 1, 0, 30);
      placeProcess(root, 35, 'node', 'S', 1, 0, 30);
      placeProcess(root, 40, 'a', 'S', 1, 0, 1);
      placeProcess(root, 41, 'b', 'S', 1, 0, 1);
      placeUptime(root, 1000);

      const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(8);
      expect(result?.reclaim?.roots).toBe(3);
      expect(result?.reclaim?.largestTreeCandidates).toBe(6);
      expect(result?.reclaim?.singletonTrees).toBe(2);
    });

    it('ルート自身が D で子も居ない木は、roots には数えるが候補・largestTreeCandidates・singletonTrees には効かない', async () => {
      placeProcess(root, 60, 'dd', 'D', 1, 0, 1);
      placeUptime(root, 1000);

      const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(0);
      expect(result?.reclaim?.roots).toBe(1);
      expect(result?.reclaim?.largestTreeCandidates).toBe(0);
      expect(result?.reclaim?.singletonTrees).toBe(0);
    });
  });

  describe('齢の分布（#1334。medianAgeSec / ageBuckets）', () => {
    it('偶数本の中央値は中間2つの平均を Math.floor し、ageBuckets の合計は candidates と一致する（裾も最後のバケツへ入る）', async () => {
      const uptime = 40_000;
      const ticks = 100;
      const ages = [10, 50, 100, 700, 5000, 30_000];
      ages.forEach((age, index) => {
        const starttime = (uptime - age) * ticks;
        placeProcess(root, 500 + index, 'pnpm', 'S', 1, starttime, 1);
      });
      placeUptime(root, uptime);

      const reader = new TaskBreakdownReader({
        procRoot: root,
        clockTicksPerSecond: ticks,
        reclaim: { childUid: OWN_UID },
      });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(6);
      expect(result?.reclaim?.medianAgeSec).toBe(400);
      expect(result?.reclaim?.ageBuckets).toEqual([
        { upToSec: 60, count: 2 },
        { upToSec: 600, count: 1 },
        { upToSec: 3600, count: 1 },
        { upToSec: 21600, count: 1 },
        { count: 1 },
      ]);
      const total = result?.reclaim?.ageBuckets?.reduce((sum, bucket) => sum + bucket.count, 0);
      expect(total).toBe(result?.reclaim?.candidates);
    });

    it('奇数本の中央値はソート後の中間の値そのもの', async () => {
      const uptime = 1000;
      const ticks = 100;
      const ages = [10, 50, 100];
      ages.forEach((age, index) => {
        const starttime = (uptime - age) * ticks;
        placeProcess(root, 600 + index, 'pnpm', 'S', 1, starttime, 1);
      });
      placeUptime(root, uptime);

      const reader = new TaskBreakdownReader({
        procRoot: root,
        clockTicksPerSecond: ticks,
        reclaim: { childUid: OWN_UID },
      });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(3);
      expect(result?.reclaim?.medianAgeSec).toBe(50);
    });

    it('候補0本のとき medianAgeSec / ageBuckets が欄ごと出ない（0 や [] を出さない）', async () => {
      placeProcess(root, 700, 'node', 'S', 3, 0, 999);
      placeUptime(root, 1000);

      const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(0);
      expect(result?.reclaim?.medianAgeSec).toBeUndefined();
      expect(result?.reclaim?.ageBuckets).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'medianAgeSec')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'ageBuckets')).toBe(false);
    });

    it('uptime が読めなければ medianAgeSec / ageBuckets / oldestAgeSec が全部欄ごと出ない', async () => {
      placeProcess(root, 710, 'pnpm', 'S', 1, 0, 1);

      const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(1);
      expect(result?.reclaim?.oldestAgeSec).toBeUndefined();
      expect(result?.reclaim?.medianAgeSec).toBeUndefined();
      expect(result?.reclaim?.ageBuckets).toBeUndefined();
    });
  });

  it('🔴 孤児候補の comm は出力に一切含まれない（ゾンビの comm が出る経路は生きている）', async () => {
    placeProcess(root, 800, 'zombie-visible-cmd', 'Z', 1, 0, 1);
    placeProcess(root, 801, 'orphan-secret-cmd', 'S', 3, 0, 1);
    placeProcess(root, 802, 'orphan-secret-cmd', 'S', 2, 0, 801);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBeGreaterThanOrEqual(1);
    expect(result?.zombies).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('zombie-visible-cmd');

    expect(serialized).not.toContain('orphan-secret-cmd');
  });

  it('段0 は撃たない: 候補が実在する器を走査しても process.kill を1度も呼ばない', async () => {
    placeProcess(root, 90, 'pnpm', 'S', 3, 0, 1);
    placeProcess(root, 91, 'node', 'S', 5, 0, 90);
    placeUptime(root, 1000);

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(2);
      expect(kill).not.toHaveBeenCalled();

      expect(result?.reclaim?.mode).toBe('observe');
      expect(result?.reclaim?.signalled).toBe(0);
      expect(result?.reclaim?.killed).toBe(0);
      expect(result?.reclaim?.freedThreads).toBe(0);
    } finally {
      kill.mockRestore();
    }
  });

  it('signalled / killed / freedThreads は 0 でも欄として在る', async () => {
    placeProcess(root, 95, 'node', 'S', 1, 0, 999);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
    const result = await reader.read();

    expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'signalled')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'killed')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'freedThreads')).toBe(true);
  });

  it('pidsAtScan に走査時点の pids.current / pids.max を出す', async () => {
    placeProcess(root, 110, 'pnpm', 'S', 1, 0, 1);
    placeUptime(root, 1000);
    const { procCgroupPath } = placeCgroupPids('42', '1000');

    const reader = new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
      cgroupRoot,
      procCgroupPath,
    });
    const result = await reader.read();

    expect(result?.reclaim?.pidsAtScan).toEqual({ current: 42, max: 1000 });
  });

  it('pids.max が数として読めなければ pidsAtScan は欄ごと出ない', async () => {
    placeProcess(root, 120, 'pnpm', 'S', 1, 0, 1);
    placeUptime(root, 1000);
    const { procCgroupPath } = placeCgroupPids('42', 'max');

    const reader = new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
      cgroupRoot,
      procCgroupPath,
    });
    const result = await reader.read();

    expect(result?.reclaim?.pidsAtScan).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'pidsAtScan')).toBe(false);
  });

  // `EISDIR` で偽装する: `stat` をディレクトリにすると `readFile` が `ENOENT` ではないエラーで落ち、「消えた」と「読めなかった」を実ファイルで作り分けられるため。
  it('読めなかったものが1件でもあれば reclaim を欄ごと出さない（candidates 0 と書かない）', async () => {
    placeProcess(root, 150, 'pnpm', 'S', 3, 0, 1);
    placeUptime(root, 1000);

    const before = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
    }).read();
    expect(before?.reclaim?.candidates).toBe(1);

    mkdirSync(join(root, '151', 'stat'), { recursive: true });

    const after = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
    }).read();

    expect(after?.reclaim).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(after, 'reclaim')).toBe(false);
    expect(after?.processes).toBe(1);
  });

  it('走査中に消えた（ENOENT）だけなら reclaim は出し続ける（消えるのは正常なので）', async () => {
    placeProcess(root, 160, 'pnpm', 'S', 3, 0, 1);
    mkdirSync(join(root, '161'));
    placeUptime(root, 1000);

    const result = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
    }).read();

    expect(result?.reclaim?.candidates).toBe(1);
  });

  it('差し替え口を渡さなければ、本番経路が実物の fs.stat を呼ぶ', async () => {
    placeProcess(root, 170, 'pnpm', 'S', 3, 0, 1);
    placeUptime(root, 1000);
    vi.mocked(stat).mockClear();

    const result = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
    }).read();

    expect(result?.reclaim?.candidates).toBe(1);
    expect(vi.mocked(stat).mock.calls.some(([target]) => target === join(root, '170'))).toBe(true);
  });

  it('lastRunAt は走査した時刻で、TTL のメモを返す間は動かない', async () => {
    let now = 1_000;
    placeProcess(root, 130, 'pnpm', 'S', 1, 0, 1);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
      ttlMs: 1000,
      now: () => now,
    });

    const first = await reader.read();
    expect(first?.reclaim?.lastRunAt).toBe(1_000);

    now = 1_500;
    const second = await reader.read();
    expect(second?.reclaim?.lastRunAt).toBe(1_000);

    now = 2_500;
    const third = await reader.read();
    expect(third?.reclaim?.lastRunAt).toBe(2_500);
  });
});

describe('孤児プロセス木の回収（#1334 段1。reclaim.reap を渡したときだけ撃つ）', () => {
  const OWN_UID = process.getuid?.() ?? 0;

  function fakeKillFn(): {
    fn: (pid: number, signal: NodeJS.Signals) => void;
    calls: Array<{ pid: number; signal: NodeJS.Signals }>;
  } {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    return { fn: (pid, signal) => calls.push({ pid, signal }), calls };
  }

  it('runner がいま把握している委譲が0本なら、sid が不明でも撃ってよい（属す先が無いので確定で孤児）', async () => {
    placeProcess(root, 200, 'pnpm', 'S', 3, 0, 1, 999);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set(),
          knownTerminatedSessionPidsOf: () => new Set(),
          anyTrackedDelegationsOf: () => false,
        },
      },
    });
    const result = await reader.read();

    expect(result?.reclaim?.mode).toBe('reclaim');
    expect(result?.reclaim?.signalled).toBe(1);
    expect(calls).toEqual([{ pid: 200, signal: 'SIGTERM' }]);
  });

  it('生きているプロセスが0本でも、runner が委譲を把握していれば撃たない（liveSessionPids の大きさでは分岐1を判定しない）', async () => {
    placeProcess(root, 201, 'pnpm', 'S', 3, 0, 1, 999);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set(),
          knownTerminatedSessionPidsOf: () => new Set(),
          anyTrackedDelegationsOf: () => true,
        },
      },
    });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(1);
    expect(result?.reclaim?.signalled).toBe(0);
    expect(calls).toEqual([]);
  });

  it('anyTrackedDelegationsOf を省略した既定は true（安全側）——分岐1を無条件には発火させない', async () => {
    placeProcess(root, 202, 'pnpm', 'S', 3, 0, 1, 999);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set(),
          knownTerminatedSessionPidsOf: () => new Set(),
        },
      },
    });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(1);
    expect(result?.reclaim?.signalled).toBe(0);
    expect(calls).toEqual([]);
  });

  it('sid が生きている委譲のものと一致するなら撃たない（setsid で抜けた孫が生きた委譲の下に居る形）', async () => {
    placeProcess(root, 210, 'pnpm', 'S', 3, 0, 1, 555);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set([555]),
          knownTerminatedSessionPidsOf: () => new Set(),
        },
      },
    });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(1);
    expect(result?.reclaim?.signalled).toBe(0);
    expect(calls).toEqual([]);
  });

  it('sid が終端済みと分かっている委譲のものと一致するなら撃つ', async () => {
    placeProcess(root, 220, 'pnpm', 'S', 3, 0, 1, 777);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set([999]),
          knownTerminatedSessionPidsOf: () => new Set([777]),
        },
      },
    });
    const result = await reader.read();

    expect(result?.reclaim?.signalled).toBe(1);
    expect(calls).toEqual([{ pid: 220, signal: 'SIGTERM' }]);
  });

  it('sid がどの委譲のものでもない（setsid で抜けた等）なら撃たない（保守的に hold）', async () => {
    placeProcess(root, 230, 'pnpm', 'S', 3, 0, 1, 4242);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set([999]),
          knownTerminatedSessionPidsOf: () => new Set([777]),
        },
      },
    });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(1);
    expect(result?.reclaim?.signalled).toBe(0);
    expect(calls).toEqual([]);
  });

  it('撃ってよいかは候補ごとに独立して決める（親と子でsidが違えば判定も違う）', async () => {
    placeProcess(root, 240, 'pnpm', 'S', 1, 0, 1, 777);
    placeProcess(root, 241, 'node', 'S', 1, 0, 240, 555);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set([555]),
          knownTerminatedSessionPidsOf: () => new Set([777]),
        },
      },
    });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(2);
    expect(result?.reclaim?.signalled).toBe(1);
    expect(calls).toEqual([{ pid: 240, signal: 'SIGTERM' }]);
  });

  it('猶予を過ぎてもまだ発砲対象のままなら SIGKILL へ昇格する。過ぎる前は昇格しない', async () => {
    placeProcess(root, 250, 'pnpm', 'S', 2, 0, 1, 999);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();
    let now = 0;

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      ttlMs: 0,
      now: () => now,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set(),
          knownTerminatedSessionPidsOf: () => new Set(),
          anyTrackedDelegationsOf: () => false,
          graceMs: 10_000,
        },
      },
    });

    const first = await reader.read();
    expect(first?.reclaim?.signalled).toBe(1);
    expect(first?.reclaim?.killed).toBe(0);

    now = 5_000;
    const second = await reader.read();
    expect(second?.reclaim?.signalled).toBe(0);
    expect(second?.reclaim?.killed).toBe(0);

    now = 10_500;
    const third = await reader.read();
    expect(third?.reclaim?.signalled).toBe(0);
    expect(third?.reclaim?.killed).toBe(1);

    expect(calls).toEqual([
      { pid: 250, signal: 'SIGTERM' },
      { pid: 250, signal: 'SIGKILL' },
    ]);
  });

  it('消えたプロセスの num_threads を freedThreads へ足す（自然死・撃って消えたを区別しない）', async () => {
    placeProcess(root, 260, 'pnpm', 'S', 6, 0, 1, 999);
    placeUptime(root, 1000);
    const { fn: killFn } = fakeKillFn();
    let now = 0;

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      ttlMs: 0,
      now: () => now,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set(),
          knownTerminatedSessionPidsOf: () => new Set(),
          anyTrackedDelegationsOf: () => false,
        },
      },
    });

    const first = await reader.read();
    expect(first?.reclaim?.signalled).toBe(1);
    expect(first?.reclaim?.freedThreads).toBe(0);

    rmSync(join(root, '260'), { recursive: true, force: true });
    now = 1_000;
    const second = await reader.read();
    expect(second?.reclaim?.freedThreads).toBe(6);
    expect(second?.reclaim?.candidates).toBe(0);

    now = 2_000;
    const third = await reader.read();
    expect(third?.reclaim?.freedThreads).toBe(0);
  });

  it('猶予を過ぎても、その回にもう発砲対象でなければ SIGKILL へ昇格しない（pid 再利用等の保険）', async () => {
    placeProcess(root, 270, 'pnpm', 'S', 2, 0, 1, 999);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();
    let now = 0;

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      ttlMs: 0,
      now: () => now,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set(),
          knownTerminatedSessionPidsOf: () => new Set(),
          anyTrackedDelegationsOf: () => false,
          graceMs: 10_000,
        },
      },
    });

    const first = await reader.read();
    expect(first?.reclaim?.signalled).toBe(1);

    placeProcess(root, 270, 'pnpm', 'Z', 1, 0, 1, 999);
    now = 10_500;
    const second = await reader.read();

    expect(second?.reclaim?.killed).toBe(0);
    expect(calls).toEqual([{ pid: 270, signal: 'SIGTERM' }]);
  });

  describe('pid が別のプロセスへ使い回されたとき（#1544。帳は pid と starttime の組で引く）', () => {
    function reapingReader(now: () => number) {
      const { fn: killFn, calls } = fakeKillFn();
      const reader = new TaskBreakdownReader({
        procRoot: root,
        killFn,
        ttlMs: 0,
        now,
        reclaim: {
          childUid: OWN_UID,
          reap: {
            liveSessionPidsOf: () => new Set(),
            knownTerminatedSessionPidsOf: () => new Set(),
            anyTrackedDelegationsOf: () => false,
            graceMs: 10_000,
          },
        },
      });
      return { reader, calls };
    }

    it('P の猶予を過ぎてから Q を見ても、Q は SIGTERM から始まり、いきなり SIGKILL されない', async () => {
      placeProcess(root, 500, 'old-process-P', 'S', 2, 100, 1, 999);
      placeUptime(root, 1000);
      let now = 0;
      const { reader, calls } = reapingReader(() => now);

      const first = await reader.read();
      expect(first?.reclaim?.signalled).toBe(1);

      placeProcess(root, 500, 'new-unrelated-process-Q', 'S', 3, 5000, 1, 999);
      now = 10_500;
      const second = await reader.read();

      expect(second?.reclaim?.signalled).toBe(1);
      expect(second?.reclaim?.killed).toBe(0);
      expect(second?.reclaim?.freedThreads).toBe(2);

      now = 21_000;
      const third = await reader.read();
      expect(third?.reclaim?.killed).toBe(1);

      expect(calls).toEqual([
        { pid: 500, signal: 'SIGTERM' },
        { pid: 500, signal: 'SIGTERM' },
        { pid: 500, signal: 'SIGKILL' },
      ]);
    });

    it('P の猶予の内側で Q に替わっても、Q は見過ごされずに SIGTERM を受ける', async () => {
      placeProcess(root, 500, 'old-process-P', 'S', 2, 100, 1, 999);
      placeUptime(root, 1000);
      let now = 0;
      const { reader, calls } = reapingReader(() => now);

      await reader.read();

      placeProcess(root, 500, 'new-unrelated-process-Q', 'S', 3, 5000, 1, 999);
      now = 1_000;
      const second = await reader.read();

      expect(second?.reclaim?.signalled).toBe(1);
      expect(calls).toEqual([
        { pid: 500, signal: 'SIGTERM' },
        { pid: 500, signal: 'SIGTERM' },
      ]);
    });
  });

  it('reap を渡していなければ mode は observe のまま、reap があれば候補0本でも reclaim を名乗る', async () => {
    placeProcess(root, 280, 'node', 'S', 1, 0, 999);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({
      procRoot: root,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set(),
          knownTerminatedSessionPidsOf: () => new Set(),
        },
      },
    });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(0);
    expect(result?.reclaim?.mode).toBe('reclaim');
  });

  it('🔴 発砲対象になった孤児候補の comm も、reap 有効時に出力へ一切含まれない', async () => {
    placeProcess(root, 800, 'zombie-visible-cmd', 'Z', 1, 0, 1);
    placeProcess(root, 801, 'orphan-secret-cmd', 'S', 3, 0, 1, 999);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn: () => undefined,
      reclaim: {
        childUid: OWN_UID,
        reap: {
          liveSessionPidsOf: () => new Set(),
          knownTerminatedSessionPidsOf: () => new Set(),
          anyTrackedDelegationsOf: () => false,
        },
      },
    });
    const result = await reader.read();

    expect(result?.reclaim?.signalled).toBe(1);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('zombie-visible-cmd');
    expect(serialized).not.toContain('orphan-secret-cmd');
  });

  describe('pid 使い回しの守り（分岐4だけに効く。レビュー指摘・#1334）', () => {
    it('sid が終端済みでも、同じ pid のプロセス（セッションの長）がいま実在するなら撃たない', async () => {
      placeProcess(root, 777, 'setsid-reused-pid', 'S', 1, 0, 999, 777);
      placeProcess(root, 300, 'orphaned-under-reused-pid', 'S', 2, 0, 1, 777);
      placeUptime(root, 1000);
      const { fn: killFn, calls } = fakeKillFn();

      const reader = new TaskBreakdownReader({
        procRoot: root,
        killFn,
        reclaim: {
          childUid: OWN_UID,
          reap: {
            liveSessionPidsOf: () => new Set([999]),
            knownTerminatedSessionPidsOf: () => new Set([777]),
          },
        },
      });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(1);
      expect(result?.reclaim?.signalled).toBe(0);
      expect(calls).toEqual([]);
    });

    it('候補自身が session leader（pid === sid）のときも、pid 使い回しの守りで撃たない', async () => {
      placeProcess(root, 777, 'self-orphaned-leader', 'S', 3, 0, 1, 777);
      placeUptime(root, 1000);
      const { fn: killFn, calls } = fakeKillFn();

      const reader = new TaskBreakdownReader({
        procRoot: root,
        killFn,
        reclaim: {
          childUid: OWN_UID,
          reap: {
            liveSessionPidsOf: () => new Set([999]),
            knownTerminatedSessionPidsOf: () => new Set([777]),
          },
        },
      });
      const result = await reader.read();

      expect(result?.reclaim?.candidates).toBe(1);
      expect(result?.reclaim?.signalled).toBe(0);
      expect(calls).toEqual([]);
    });

    it('分岐1（委譲0本）には守りを適用しない——session leader が実在しても撃つ', async () => {
      placeProcess(root, 777, 'setsid-nohup-leftover', 'S', 3, 0, 1, 777);
      placeUptime(root, 1000);
      const { fn: killFn, calls } = fakeKillFn();

      const reader = new TaskBreakdownReader({
        procRoot: root,
        killFn,
        reclaim: {
          childUid: OWN_UID,
          reap: {
            liveSessionPidsOf: () => new Set(),
            knownTerminatedSessionPidsOf: () => new Set(),
            anyTrackedDelegationsOf: () => false,
          },
        },
      });
      const result = await reader.read();

      expect(result?.reclaim?.signalled).toBe(1);
      expect(calls).toEqual([{ pid: 777, signal: 'SIGTERM' }]);
    });
  });
});

describe('撃たれなかった木の内訳（#2352。#2626 で observe も終端した委譲の木は撃つ）', () => {
  const OWN_UID = process.getuid?.() ?? 0;

  function fakeKillFn(): {
    fn: (pid: number, signal: NodeJS.Signals) => void;
    calls: Array<{ pid: number; signal: NodeJS.Signals }>;
  } {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    return { fn: (pid, signal) => calls.push({ pid, signal }), calls };
  }

  function placeLayout(): void {
    placeProcess(root, 300, 'a', 'S', 1, 0, 1, 555);
    placeProcess(root, 301, 'a', 'S', 1, 0, 1, 4242);
    placeProcess(root, 302, 'a', 'S', 1, 0, 1, -1);
    placeProcess(root, 303, 'a', 'S', 1, 0, 1, 777);
    placeProcess(root, 304, 'a', 'S', 1, 0, 1, 778);
    placeProcess(root, 501, 'a', 'S', 1, 0, 999, 555);
    placeProcess(root, 400, 'a', 'S', 1, 0, 501, 777);
    placeProcess(root, 778, 'a', 'S', 1, 0, 999, 778);
    placeUptime(root, 1000);
  }

  const view = {
    liveSessionPidsOf: () => new Set([555]),
    knownTerminatedSessionPidsOf: () => new Set([777, 778]),
    anyTrackedDelegationsOf: () => true,
  };

  const expectedHeld = { sidUnknown: 1, sidLive: 1, sidLeaderPresent: 1, sidUnrecognised: 1 };
  const expectedOutside = {
    total: 3,
    parentInScan: 1,
    bySid: { wouldFire: 1, sidUnknown: 0, sidLive: 1, sidLeaderPresent: 1, sidUnrecognised: 0 },
  };

  it('観測の出力は core の runner-protocol の schema を通り、notFired が落ちずに残る', async () => {
    placeLayout();
    const result = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID, sessions: view },
    }).read();
    const schema = runnerExecutionResourcesSchema.shape.tasks.unwrap().shape.reclaim.unwrap();
    const parsed = schema.parse(result?.reclaim);
    expect(parsed.notFired).toEqual(result?.reclaim?.notFired);
  });

  it('observe + sessions: 理由別に数える。撃つのは終端した委譲の木（303）だけで、素性の分からない孤児は撃たない', async () => {
    placeLayout();
    const { fn: killFn, calls } = fakeKillFn();
    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: { childUid: OWN_UID, sessions: view },
    });
    const result = await reader.read();

    expect(result?.reclaim?.mode).toBe('observe');
    expect(result?.reclaim?.candidates).toBe(5);
    expect(result?.reclaim?.signalled).toBe(1);
    expect(calls).toEqual([{ pid: 303, signal: 'SIGTERM' }]);
    expect(result?.reclaim?.notFired).toEqual({
      outsideRoots: expectedOutside,
      held: expectedHeld,
      observeOnly: 0,
    });
  });

  it('reclaim + reap: 同じ配置で撃つのは fire 判定の1本だけ。内訳は observe と一致し、observeOnly は出ない', async () => {
    placeLayout();
    const { fn: killFn, calls } = fakeKillFn();
    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: { childUid: OWN_UID, reap: view },
    });
    const result = await reader.read();

    expect(result?.reclaim?.mode).toBe('reclaim');
    expect(result?.reclaim?.candidates).toBe(5);
    expect(result?.reclaim?.signalled).toBe(1);
    expect(calls).toEqual([{ pid: 303, signal: 'SIGTERM' }]);
    expect(result?.reclaim?.notFired?.held).toEqual(expectedHeld);
    expect(result?.reclaim?.notFired?.outsideRoots).toEqual(expectedOutside);
    expect(Object.prototype.hasOwnProperty.call(result?.reclaim?.notFired, 'observeOnly')).toBe(
      false,
    );
  });

  it('sessions を渡す前後で、reap 側の発砲（pid と signal）が変わらない', async () => {
    placeLayout();
    const without = fakeKillFn();
    await new TaskBreakdownReader({
      procRoot: root,
      killFn: without.fn,
      reclaim: { childUid: OWN_UID, reap: view },
    }).read();
    const withSessions = fakeKillFn();
    await new TaskBreakdownReader({
      procRoot: root,
      killFn: withSessions.fn,
      reclaim: {
        childUid: OWN_UID,
        reap: view,
        sessions: {
          liveSessionPidsOf: () => new Set(),
          knownTerminatedSessionPidsOf: () => new Set([555, 4242, 999]),
          anyTrackedDelegationsOf: () => false,
        },
      },
    }).read();
    expect(withSessions.calls).toEqual(without.calls);
    expect(withSessions.calls).toEqual([{ pid: 303, signal: 'SIGTERM' }]);
  });

  it('委譲が0本(anyTracked=false)なら全部 fire 判定: observe は held が全部0。終端した委譲の木（303）は撃ち、残り4本は observeOnly', async () => {
    placeLayout();
    const { fn: killFn, calls } = fakeKillFn();
    const result = await new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: { childUid: OWN_UID, sessions: { ...view, anyTrackedDelegationsOf: () => false } },
    }).read();
    expect(calls).toEqual([{ pid: 303, signal: 'SIGTERM' }]);
    expect(result?.reclaim?.notFired?.held).toEqual({
      sidUnknown: 0,
      sidLive: 0,
      sidLeaderPresent: 0,
      sidUnrecognised: 0,
    });
    expect(result?.reclaim?.notFired?.observeOnly).toBe(4);
    expect(result?.reclaim?.notFired?.outsideRoots.bySid?.wouldFire).toBe(3);
  });

  it('判定材料が無い observe は、理由別を欄ごと出さない（0の行を作らない）。孤児ルート外の本数は走査だけで出る', async () => {
    placeLayout();
    const result = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
    }).read();
    const notFired = result?.reclaim?.notFired;
    expect(notFired?.outsideRoots).toEqual({ total: 3, parentInScan: 1 });
    expect(Object.prototype.hasOwnProperty.call(notFired, 'held')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(notFired, 'observeOnly')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(notFired?.outsideRoots, 'bySid')).toBe(false);
  });

  it('D / Z の孤児ルート外プロセスと、降ろす UID 以外は outsideRoots に数えない', async () => {
    placeProcess(root, 600, 'a', 'Z', 1, 0, 999, 1);
    placeProcess(root, 601, 'a', 'D', 1, 0, 999, 1);
    placeUptime(root, 1000);
    const result = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
    }).read();
    expect(result?.reclaim?.notFired?.outsideRoots).toEqual({ total: 0, parentInScan: 0 });
    const other = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID + 1 },
    }).read();
    expect(other?.reclaim?.notFired?.outsideRoots.total).toBe(0);
  });
});

describe('既定の構え（observe）が終端した委譲の木を畳む（#2626）', () => {
  const OWN_UID = process.getuid?.() ?? 0;

  function fakeKillFn(): {
    fn: (pid: number, signal: NodeJS.Signals) => void;
    calls: Array<{ pid: number; signal: NodeJS.Signals }>;
  } {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    return { fn: (pid, signal) => calls.push({ pid, signal }), calls };
  }

  function sessionsOf(
    overrides: Partial<{
      live: number[];
      terminated: number[];
      any: boolean;
      graceMs: number;
    }> = {},
  ): ReclaimSessionView {
    return {
      liveSessionPidsOf: () => new Set(overrides.live ?? [555]),
      knownTerminatedSessionPidsOf: () => new Set(overrides.terminated ?? [777]),
      anyTrackedDelegationsOf: () => overrides.any ?? true,
      ...(overrides.graceMs === undefined ? {} : { graceMs: overrides.graceMs }),
    };
  }

  it('終端した委譲の sid の木は、observe（reap 無し）でも撃つ。mode は observe のまま', async () => {
    placeProcess(root, 240, 'a', 'S', 1, 0, 1, 777);
    placeProcess(root, 241, 'a', 'S', 1, 0, 240, 777);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();
    const result = await new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: { childUid: OWN_UID, sessions: sessionsOf() },
    }).read();

    expect(result?.reclaim?.mode).toBe('observe');
    expect(result?.reclaim?.signalled).toBe(2);
    expect(calls).toEqual([
      { pid: 240, signal: 'SIGTERM' },
      { pid: 241, signal: 'SIGTERM' },
    ]);
    expect(result?.reclaim?.notFired?.observeOnly).toBe(0);
  });

  it('分岐1の形（委譲が0本・sid はどこにも属さない）は observe では撃たない。reclaim（reap）なら撃つ', async () => {
    placeProcess(root, 200, 'a', 'S', 1, 0, 1, 999);
    placeUptime(root, 1000);
    const view = sessionsOf({ any: false, live: [], terminated: [] });

    const observe = fakeKillFn();
    const observed = await new TaskBreakdownReader({
      procRoot: root,
      killFn: observe.fn,
      reclaim: { childUid: OWN_UID, sessions: view },
    }).read();
    expect(observe.calls).toEqual([]);
    expect(observed?.reclaim?.signalled).toBe(0);
    expect(observed?.reclaim?.notFired?.observeOnly).toBe(1);

    const reclaim = fakeKillFn();
    const reclaimed = await new TaskBreakdownReader({
      procRoot: root,
      killFn: reclaim.fn,
      reclaim: { childUid: OWN_UID, reap: view },
    }).read();
    expect(reclaim.calls).toEqual([{ pid: 200, signal: 'SIGTERM' }]);
    expect(reclaimed?.reclaim?.mode).toBe('reclaim');
  });

  it('生きた委譲の sid の木は撃たない（親が終端した委譲の木でも、子が生きた委譲の sid なら撃たない）', async () => {
    placeProcess(root, 260, 'a', 'S', 1, 0, 1, 555);
    placeProcess(root, 261, 'a', 'S', 1, 0, 1, 777);
    placeProcess(root, 262, 'a', 'S', 1, 0, 261, 555);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();
    const result = await new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: { childUid: OWN_UID, sessions: sessionsOf() },
    }).read();

    expect(calls).toEqual([{ pid: 261, signal: 'SIGTERM' }]);
    expect(result?.reclaim?.notFired?.held?.sidLive).toBe(2);
  });

  it('setsid で抜けた子孫（sid が認識できない）は、終端した委譲の木の下に居れば継いで撃つ。生きた委譲の sid は継がない', async () => {
    placeProcess(root, 250, 'a', 'S', 1, 0, 1, 777);
    placeProcess(root, 251, 'a', 'S', 1, 0, 250, 888);
    placeProcess(root, 252, 'a', 'S', 1, 0, 251, 888);
    placeProcess(root, 253, 'a', 'S', 1, 0, 250, 555);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();
    const result = await new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: { childUid: OWN_UID, sessions: sessionsOf() },
    }).read();

    expect(calls.map((call) => call.pid).sort()).toEqual([250, 251, 252]);
    expect(result?.reclaim?.notFired?.held?.sidLive).toBe(1);
  });

  it('継ぐのは「終端した委譲」の帰属だけ。認識できない sid の木の下の子孫は撃たない（素性不明のまま）', async () => {
    placeProcess(root, 270, 'a', 'S', 1, 0, 1, 4242);
    placeProcess(root, 271, 'a', 'S', 1, 0, 270, 4243);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();
    await new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: { childUid: OWN_UID, sessions: sessionsOf() },
    }).read();
    expect(calls).toEqual([]);
  });

  it('継ぐ先の sid の長が走査に実在するなら撃たない（pid 使い回しの守りは継ぐ形にも掛かる）', async () => {
    placeProcess(root, 280, 'a', 'S', 1, 0, 1, 777);
    placeProcess(root, 281, 'a', 'S', 1, 0, 280, 888);
    placeProcess(root, 777, 'a', 'S', 1, 0, 999, 777);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();
    await new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: { childUid: OWN_UID, sessions: sessionsOf() },
    }).read();
    expect(calls).toEqual([]);
  });

  describe('帳（親が先に死んで、setsid の子孫が孤児ルートになった形）', () => {
    function placeLiveTree(): void {
      placeProcess(root, 100, 'a', 'S', 1, 5, 50, 100);
      placeProcess(root, 101, 'a', 'S', 1, 6, 100, 100);
      placeProcess(root, 102, 'a', 'S', 1, 7, 101, 102);
      placeUptime(root, 1000);
    }
    function killParents(): void {
      rmSync(join(root, '100'), { recursive: true });
      rmSync(join(root, '101'), { recursive: true });
      placeProcess(root, 102, 'a', 'S', 1, 7, 1, 102);
    }

    it('生きた委譲の木だった間に覚えた帰属先が終端したら、孤児になった子孫を撃つ', async () => {
      placeLiveTree();
      const { fn: killFn, calls } = fakeKillFn();
      let live = [100];
      let terminated: number[] = [];
      const reader = new TaskBreakdownReader({
        procRoot: root,
        killFn,
        ttlMs: 0,
        reclaim: {
          childUid: OWN_UID,
          sessions: {
            liveSessionPidsOf: () => new Set(live),
            knownTerminatedSessionPidsOf: () => new Set(terminated),
            anyTrackedDelegationsOf: () => true,
          },
        },
      });

      expect((await reader.read())?.reclaim?.signalled).toBe(0);
      expect(calls).toEqual([]);

      live = [];
      terminated = [100];
      killParents();
      const second = await reader.read();
      expect(calls).toEqual([{ pid: 102, signal: 'SIGTERM' }]);
      expect(second?.reclaim?.signalled).toBe(1);
    });

    it('帳が無ければ（走査を跨いで覚えていなければ）撃たない——帳が効いている対照', async () => {
      placeLiveTree();
      killParents();
      const { fn: killFn, calls } = fakeKillFn();
      const result = await new TaskBreakdownReader({
        procRoot: root,
        killFn,
        reclaim: { childUid: OWN_UID, sessions: sessionsOf({ live: [], terminated: [100] }) },
      }).read();
      expect(calls).toEqual([]);
      expect(result?.reclaim?.notFired?.held?.sidUnrecognised).toBe(1);
    });

    it('帰属先がまだ生きた委譲なら撃たない。pid が使い回されて starttime が違えば帳を引かない', async () => {
      placeLiveTree();
      const { fn: killFn, calls } = fakeKillFn();
      let live = [100];
      let terminated: number[] = [];
      const reader = new TaskBreakdownReader({
        procRoot: root,
        killFn,
        ttlMs: 0,
        reclaim: {
          childUid: OWN_UID,
          sessions: {
            liveSessionPidsOf: () => new Set(live),
            knownTerminatedSessionPidsOf: () => new Set(terminated),
            anyTrackedDelegationsOf: () => true,
          },
        },
      });
      await reader.read();

      rmSync(join(root, '101'), { recursive: true });
      placeProcess(root, 102, 'a', 'S', 1, 7, 1, 102);
      await reader.read();
      expect(calls).toEqual([]);

      live = [];
      terminated = [100];
      rmSync(join(root, '100'), { recursive: true });
      placeProcess(root, 102, 'a', 'S', 1, 99, 1, 102);
      await reader.read();
      expect(calls).toEqual([]);
    });
  });

  it('猶予（graceMs）を過ぎてもまだ居れば SIGKILL へ昇格する（observe でも同じ手順）', async () => {
    placeProcess(root, 290, 'a', 'S', 1, 0, 1, 777);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();
    let nowMs = 1_000_000;
    const reader = new TaskBreakdownReader({
      procRoot: root,
      killFn,
      ttlMs: 0,
      now: () => nowMs,
      reclaim: { childUid: OWN_UID, sessions: sessionsOf({ graceMs: 5_000 }) },
    });
    await reader.read();
    nowMs += 4_999;
    await reader.read();
    expect(calls).toEqual([{ pid: 290, signal: 'SIGTERM' }]);
    nowMs += 1;
    const result = await reader.read();
    expect(calls).toEqual([
      { pid: 290, signal: 'SIGTERM' },
      { pid: 290, signal: 'SIGKILL' },
    ]);
    expect(result?.reclaim?.killed).toBe(1);
  });

  it('観測そのものを切った構え（reclaim 欄なし）と、sessions の無い構えは撃たない', async () => {
    placeProcess(root, 295, 'a', 'S', 1, 0, 1, 777);
    placeUptime(root, 1000);
    const { fn: killFn, calls } = fakeKillFn();
    const result = await new TaskBreakdownReader({
      procRoot: root,
      killFn,
      reclaim: { childUid: OWN_UID },
    }).read();
    expect(calls).toEqual([]);
    expect(result?.reclaim?.signalled).toBe(0);
    await new TaskBreakdownReader({ procRoot: root, killFn }).read();
    expect(calls).toEqual([]);
  });
});

describe('既定の構え（未設定 ⟹ reclaim）でも、走っている委譲の木は撃たない（#1853）', () => {
  const OWN_UID = process.getuid?.() ?? 0;
  const CHILD = { uid: OWN_UID, gid: OWN_UID };

  function fakeKillFn(): {
    fn: (pid: number, signal: NodeJS.Signals) => void;
    calls: Array<{ pid: number; signal: NodeJS.Signals }>;
  } {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    return { fn: (pid, signal) => calls.push({ pid, signal }), calls };
  }

  function placeLiveDelegationTree(): void {
    placeProcess(root, 555, 'claude', 'S', 10, 0, 50, 555);
    placeProcess(root, 556, 'node', 'S', 4, 0, 555, 555);
    placeProcess(root, 570, 'pnpm', 'S', 3, 0, 1, 555);
    placeProcess(root, 571, 'chrome', 'S', 7, 0, 570, 571);
    placeProcess(root, 580, 'server', 'S', 2, 0, 1, 580);
    placeUptime(root, 1000);
  }

  function reapOf(delegationRunning: boolean): ReclaimReapOptions {
    return {
      liveSessionPidsOf: () => new Set(delegationRunning ? [555] : []),
      knownTerminatedSessionPidsOf: () => new Set(),
      anyTrackedDelegationsOf: () => delegationRunning,
    };
  }

  async function scanWith(env: NodeJS.ProcessEnv, delegationRunning: boolean) {
    const reap = reapOf(delegationRunning);
    const { fn: killFn, calls } = fakeKillFn();
    const reclaim = withTerminatedReclaimSessions(reclaimScanOf(env, CHILD, reap), reap);
    const result = await new TaskBreakdownReader({
      procRoot: root,
      killFn,
      ...(reclaim === undefined ? {} : { reclaim }),
    }).read();
    return { result, calls };
  }

  it('未設定（既定 reclaim）: 委譲が走っていれば、その木も setsid で抜けた長時間のジョブも撃たない', async () => {
    placeLiveDelegationTree();
    const { result, calls } = await scanWith({}, true);

    expect(result?.reclaim?.mode).toBe('reclaim');
    expect(result?.reclaim?.candidates).toBe(3);
    expect(result?.reclaim?.signalled).toBe(0);
    expect(calls).toEqual([]);
  });

  it('陰性対照: 同じ配置で委譲が0本になれば、既定は素性の分からない孤児を sid を問わず撃つ', async () => {
    placeLiveDelegationTree();
    const { result, calls } = await scanWith({}, false);

    expect(result?.reclaim?.mode).toBe('reclaim');
    expect(result?.reclaim?.signalled).toBe(3);
    expect(calls.map((call) => call.pid).sort((a, b) => a - b)).toEqual([570, 571, 580]);
    expect(calls.every((call) => call.signal === 'SIGTERM')).toBe(true);
    expect(calls.some((call) => call.pid === 555 || call.pid === 556)).toBe(false);
  });

  it('陰性対照: observe を明示すれば、委譲が0本でも素性の分からない孤児は撃たない（明示した値に従う）', async () => {
    placeLiveDelegationTree();
    const { result, calls } = await scanWith({ [RECLAIM_ENV_KEY]: 'observe' }, false);

    expect(result?.reclaim?.mode).toBe('observe');
    expect(result?.reclaim?.signalled).toBe(0);
    expect(calls).toEqual([]);
  });

  it('off を明示すれば観測ごと止まり、撃たない', async () => {
    placeLiveDelegationTree();
    const { result, calls } = await scanWith({ [RECLAIM_ENV_KEY]: 'off' }, false);

    expect(result?.reclaim).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('デーモンが居ない間も回収する（#2352。/health を叩かなくても走査が起きる）', () => {
  const OWN_UID = process.getuid?.() ?? 0;
  const SWEEP_MS = 10_000;

  // `/health`（read）は1度も呼ばない: 呼ぶと、タイマー無しでも緑になる穴が開くため。
  function setup(): {
    calls: Array<{ pid: number; signal: NodeJS.Signals }>;
    reader: TaskBreakdownReader;
    clock: { now: number };
    tick: () => Promise<void>;
    stop: () => void;
    cleared: () => number;
  } {
    placeProcess(root, 240, 'a', 'S', 1, 0, 1, 777);
    placeUptime(root, 1000);
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const clock = { now: 1_000_000 };
    const reader = new TaskBreakdownReader({
      procRoot: root,
      now: () => clock.now,
      killFn: (pid, signal) => calls.push({ pid, signal }),
      reclaim: {
        childUid: OWN_UID,
        sessions: {
          liveSessionPidsOf: () => new Set([555]),
          knownTerminatedSessionPidsOf: () => new Set([777]),
          anyTrackedDelegationsOf: () => true,
        },
      },
    });
    let timerCallback: (() => void) | undefined;
    let pending: Promise<void> = Promise.resolve();
    let cleared = 0;
    const stop = startReclaimSweep(
      {
        sweepIfStale: (maxAgeMs) => {
          pending = reader.sweepIfStale(maxAgeMs);
          return pending;
        },
      },
      {
        setIntervalFn: (callback, ms) => {
          expect(ms).toBe(SWEEP_MS);
          timerCallback = callback;
          return { unref: () => undefined };
        },
        clearIntervalFn: () => {
          cleared += 1;
          timerCallback = undefined;
        },
      },
    );
    return {
      calls,
      reader,
      clock,
      stop,
      cleared: () => cleared,
      tick: async () => {
        timerCallback?.();
        await pending;
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    };
  }

  it('終端した委譲の孤児木へ、タイマーだけで SIGTERM が届き、猶予を過ぎた次の回で SIGKILL が届く', async () => {
    const { calls, clock, tick } = setup();

    await tick();
    expect(calls).toEqual([{ pid: 240, signal: 'SIGTERM' }]);

    clock.now += SWEEP_MS;
    await tick();
    expect(calls).toEqual([
      { pid: 240, signal: 'SIGTERM' },
      { pid: 240, signal: 'SIGKILL' },
    ]);
  });

  it('直前に read() が走っていれば（cache が新しければ）走査しない。/proc も読み直さない', async () => {
    const { calls, reader, clock } = setup();
    await reader.read();
    expect(calls).toEqual([{ pid: 240, signal: 'SIGTERM' }]);

    placeProcess(root, 300, 'b', 'S', 1, 0, 1, 777);
    clock.now += SWEEP_MS - 1;
    await reader.sweepIfStale(SWEEP_MS);
    expect(calls).toEqual([{ pid: 240, signal: 'SIGTERM' }]);

    clock.now += 1;
    await reader.sweepIfStale(SWEEP_MS);
    expect(calls.map((call) => `${call.pid}:${call.signal}`).sort()).toEqual([
      '240:SIGKILL',
      '240:SIGTERM',
      '300:SIGTERM',
    ]);
  });

  it('停止関数を呼んだ後は走査されない', async () => {
    const { calls, clock, tick, stop, cleared } = setup();
    await tick();
    expect(calls).toHaveLength(1);

    stop();
    expect(cleared()).toBe(1);
    clock.now += SWEEP_MS;
    await tick();
    expect(calls).toHaveLength(1);
  });

  it('走査が失敗しても握り（unhandled rejection にしない）、前の回が終わるまでは重ねて走らせない', async () => {
    let timerCallback: (() => void) | undefined;
    let release: (() => void) | undefined;
    let started = 0;
    startReclaimSweep(
      {
        sweepIfStale: () => {
          started += 1;
          return new Promise<void>((_resolve, reject) => {
            release = () => reject(new Error('scan failed'));
          });
        },
      },
      { setIntervalFn: (callback) => ((timerCallback = callback), { unref: () => undefined }) },
    );

    timerCallback?.();
    timerCallback?.();
    expect(started).toBe(1);

    release?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    timerCallback?.();
    expect(started).toBe(2);
  });
});

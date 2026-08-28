import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TaskBreakdownReader } from './tasks.js';

/**
 * タスクの state 別内訳（#315 の可視化）。**実物の `/proc` は読まない** ——
 * 走らせる器によって値が変わるので固定できない（`runner-resources.test.ts`
 * が cgroup を偽装しているのと同じ理由）。ここでは一時ディレクトリに `/proc`
 * を丸ごと偽装する。
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'alteroid-proc-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * `/proc/<pid>/stat` の1行を組み立てる。**フォーマットは実物どおり** ——
 * comm を括弧で囲み、そのあとに state から始まる残りのフィールドを空白区切りで
 * 並べる。`fields` は「comm を切り落とした後」の配列で、テストが直接
 * 触るのは state(0) / num_threads(17) / starttime(19) だけである
 * （`tasks.ts` の `readStat` の doc の索引と同じ）。
 */
function statLine(
  pid: number,
  comm: string,
  state: string,
  numThreads: number,
  starttime: number,
): string {
  const fields: Array<string | number> = [
    state, // [0] state (3列目)
    1, // [1] ppid (4列目)
    1, // [2] pgrp
    1, // [3] session
    0, // [4] tty_nr
    -1, // [5] tpgid
    0, // [6] flags
    0, // [7] minflt
    0, // [8] cminflt
    0, // [9] majflt
    0, // [10] cmajflt
    0, // [11] utime
    0, // [12] stime
    0, // [13] cutime
    0, // [14] cstime
    20, // [15] priority
    0, // [16] nice
    numThreads, // [17] num_threads (20列目)
    0, // [18] itrealvalue
    starttime, // [19] starttime (22列目)
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
): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), statLine(pid, comm, state, numThreads, starttime));
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

    expect(result?.threads).toBe(7); // 5(node) + 1(esbuild zombie) + 1(sh zombie)
    expect(result?.processes).toBe(3);
    expect(result?.zombies).toBe(2);
  });

  /**
   * **フォーマットの罠。** `comm` が空白と `)` を含む場合、素朴な空白分割では
   * 壊れる。最後の `) ` で切ってから残りを空白分割していることを、この
   * ケースで固定する。
   */
  it('comm に空白と ) を含むゾンビでも、最後の ") " で正しく切って comm を取り出す', async () => {
    placeProcess(root, 300, 'sh (weird) name', 'Z', 1, 0);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.zombies).toBe(1);
    expect(result?.zombieCommands).toEqual([{ command: 'sh (weird) name', count: 1 }]);
  });

  /** ゾンビが0本のとき、`zombieCommands` / `oldestZombieSeconds` は欄ごと省く。 */
  it('ゾンビが0本なら zombieCommands と oldestZombieSeconds が欄ごと出ない', async () => {
    placeProcess(root, 100, 'node', 'S', 3, 0);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.zombies).toBe(0);
    expect(result?.zombieCommands).toBeUndefined();
    expect(result?.oldestZombieSeconds).toBeUndefined();
    // **0 の行を作らない**——欄自体が `result` のキーに存在しないことまで確かめる。
    expect(Object.prototype.hasOwnProperty.call(result, 'zombieCommands')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'oldestZombieSeconds')).toBe(false);
  });

  /**
   * 上位8件を超えたら、超えた分を黙って切り捨てず「その他」へまとめる
   * （AGENTS.md「一覧の上限を件数だけで決める」と同じ理由）。
   */
  it('ゾンビの comm が8件を超えたら、超えた分を「その他」へまとめる（切り捨てない）', async () => {
    let pid = 400;
    // 8種の comm を数の多い順に1件ずつ差をつけて配置し、9件目・10件目は少数にする。
    const commands = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    for (const [index, command] of commands.entries()) {
      const count = commands.length - index; // a=10, b=9, ..., j=1
      for (let n = 0; n < count; n += 1) {
        placeProcess(root, pid, command, 'Z', 1, 0);
        pid += 1;
      }
    }
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.zombieCommands).toHaveLength(9); // 上位8件 + 「その他」1行
    const other = result?.zombieCommands?.find((entry) => entry.command === 'その他');
    // 9件目(i=2) + 10件目(j=1) がまとめられる。
    expect(other?.count).toBe(2 + 1);
    // 上位8件（a〜h）は個別のまま残っている（黙って切り捨てていない）。
    for (const command of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(result?.zombieCommands?.some((entry) => entry.command === command)).toBe(true);
    }
  });

  /** 年齢 = uptime − starttime/clockTicks。clockTicksPerSecond をテストから固定できる。 */
  it('いちばん古いゾンビの年齢を uptime と starttime から計算する', async () => {
    // clockTicksPerSecond=100 のとき、starttime=100000 tick = 1000秒。
    // uptime=1500秒なら年齢は500秒。
    placeProcess(root, 500, 'esbuild', 'Z', 1, 100_000);
    placeProcess(root, 501, 'node', 'Z', 1, 140_000); // より新しいゾンビ（年齢短い）
    placeUptime(root, 1500);

    const reader = new TaskBreakdownReader({ procRoot: root, clockTicksPerSecond: 100 });
    const result = await reader.read();

    // 「いちばん古い」= starttime がいちばん小さいもの（pid 500）。
    expect(result?.oldestZombieSeconds).toBe(500);
  });

  /** `/proc/uptime` が読めなければ、年齢は測れないので欄ごと省く（他の欄は出す）。 */
  it('uptime が読めなければ oldestZombieSeconds だけ省き、他の欄は出す', async () => {
    placeProcess(root, 600, 'esbuild', 'Z', 1, 0);
    // `placeUptime` を呼ばない = /proc/uptime が無い。

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.zombies).toBe(1);
    expect(result?.zombieCommands).toEqual([{ command: 'esbuild', count: 1 }]);
    expect(result?.oldestZombieSeconds).toBeUndefined();
  });

  /** 読めない `/proc/<pid>/stat`（走査中に消えた想定）は黙って飛ばす。 */
  it('stat が無い（消えた）pid ディレクトリは黙って飛ばす', async () => {
    placeProcess(root, 700, 'node', 'S', 4, 0);
    mkdirSync(join(root, '701')); // stat を置かない = 読めない
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.processes).toBe(1);
    expect(result?.threads).toBe(4);
  });

  /** pid でないエントリ（`self` 等）は数えない。 */
  it('数字でないエントリ（self 等）を pid として数えない', async () => {
    placeProcess(root, 800, 'node', 'S', 2, 0);
    mkdirSync(join(root, 'self'));
    writeFileSync(join(root, 'self', 'stat'), statLine(800, 'node', 'S', 2, 0));
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root });
    const result = await reader.read();

    expect(result?.processes).toBe(1);
  });

  /** `/proc` 自体が読めない環境（macOS のローカル開発）では `undefined` を返す。 */
  it('/proc が無い環境では undefined を返す（欄ごと出さない）', async () => {
    const reader = new TaskBreakdownReader({ procRoot: join(root, 'no-such-proc') });

    const result = await reader.read();

    expect(result).toBeUndefined();
  });

  /**
   * **TTL のメモが効く。** 短い TTL の内側では走査し直さず、超えたら走査し直す
   * ——`now` を注入して固定する（実時間に依存させない）。
   */
  it('TTL の内側では走査し直さず、TTL を超えたら走査し直す', async () => {
    let now = 0;
    placeProcess(root, 900, 'node', 'S', 1, 0);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, ttlMs: 1000, now: () => now });

    const first = await reader.read();
    expect(first?.processes).toBe(1);

    // TTL の内側で /proc の中身が変わっても、メモが返る（走査し直さない）。
    placeProcess(root, 901, 'node', 'S', 1, 0);
    now = 500;
    const second = await reader.read();
    expect(second?.processes).toBe(1); // まだ古い値のまま

    // TTL を超えたら走査し直す。
    now = 1500;
    const third = await reader.read();
    expect(third?.processes).toBe(2);
  });
});

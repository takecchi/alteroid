import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stat } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskBreakdownReader } from './tasks.js';

/**
 * **本番経路が実物の `fs` を触っていることを測るために、`stat` だけ包む。**
 * 中身は本物（`importOriginal`）をそのまま呼ぶので、振る舞いは1つも変わらない ——
 * 変えるのは「呼ばれたか」を見られるようにすることだけである。
 *
 * ⚠️ **これは `TaskBreakdownOptions.ownerUidOf`（テスト用の差し替え口）が本番経路で
 * 使われていないことを固定するために要る。** 差し替え口は「フィクスチャが実装間の差を
 * 先回りして揃える」危険を持つので、**既定のままなら実物を触る**ことを別に押さえる。
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

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
  ppid = 1,
): string {
  const fields: Array<string | number> = [
    state, // [0] state (3列目)
    ppid, // [1] ppid (4列目)
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
  ppid = 1,
): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), statLine(pid, comm, state, numThreads, starttime, ppid));
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

/**
 * 孤児プロセス木の観測（#315 段0）。
 *
 * **この段は1本も撃たない。** だから固定するのは2つ —— **数え方が合っていること**と、
 * **撃つ経路がそもそも無いこと**である。後者は `grep` ではなく振る舞いで見る
 * （`process.kill` を差し替えて、1度も呼ばれないことを確かめる）。
 *
 * **偽装した `/proc` の所有 UID は、全部このテストを走らせている UID である。**
 * 特権が無ければ `chown` できないので、UID が混ざった器を作るときだけ
 * `ownerUidOf` を差し替える（`TaskBreakdownOptions.ownerUidOf` の doc）。
 */
describe('孤児プロセス木の観測（#315 段0。数えるだけで撃たない）', () => {
  /** このテストを走らせている UID。偽装した `/proc` の中身は全部これが所有する。 */
  const OWN_UID = process.getuid?.() ?? 0;

  let cgroupRoot: string;

  beforeEach(() => {
    cgroupRoot = mkdtempSync(join(tmpdir(), 'alteroid-cgroup-'));
  });

  afterEach(() => {
    rmSync(cgroupRoot, { recursive: true, force: true });
  });

  /** cgroup の pids を偽装する。`procCgroupPath` は `0::/`（＝根がそのまま自分の階層）。 */
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

  /**
   * 孤児ルート（`ppid == 1` かつ降ろした UID が所有）の**部分木を丸ごと**数える。
   * 部分木で取るのは、子孫が親と違うディレクトリで働いていても
   * **作業ディレクトリを読まずに拾える**ようにするためである。
   */
  it('孤児ルートの部分木を丸ごと数える（ルートに繋がらないものは数えない）', async () => {
    placeProcess(root, 10, 'pnpm', 'S', 3, 0, 1); // 孤児ルート
    placeProcess(root, 11, 'node', 'S', 5, 0, 10); // その子
    placeProcess(root, 12, 'esbuild', 'S', 2, 0, 11); // その孫
    placeProcess(root, 20, 'node', 'S', 7, 0, 999); // 親が居る（＝孤児ルートに繋がらない）
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(3);
    expect(result?.reclaim?.candidateThreads).toBe(3 + 5 + 2);
    // 器の合計のほうは、孤児かどうかに関係なく全部を数え続ける。
    expect(result?.processes).toBe(4);
    expect(result?.threads).toBe(3 + 5 + 2 + 7);
  });

  /**
   * ⭐ **いちばん撃ってはいけないものを撃たない。** 器の常設物（root が所有する
   * `ppid == 1` のプロセス）を孤児ルートにしてしまうと、**その下で走っている生きた
   * セッションまで候補に入る。** 所有 UID が一致するものだけを種にすることで塞ぐ。
   */
  it('root が所有する ppid=1 は孤児ルートにしない（その下の生きたセッションを候補に数えない）', async () => {
    placeProcess(root, 6, 'node', 'S', 11, 0, 1); // runner 本体（root 所有）
    placeProcess(root, 32, 'claude', 'S', 18, 0, 6); // 生きたセッション（降ろした UID 所有）
    placeProcess(root, 40, 'pnpm', 'S', 4, 0, 1); // 本物の孤児ルート
    placeProcess(root, 41, 'node', 'S', 6, 0, 40); // その子
    placeUptime(root, 1000);

    const childUid = OWN_UID + 1; // 「降ろした UID」を、root(0) とも自分とも別の値にする
    const reader = new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid },
      ownerUidOf: (_procRoot, pid) => Promise.resolve(pid === '6' ? 0 : childUid),
    });
    const result = await reader.read();

    // 40 と 41 だけ。**32（生きたセッション）は、所有 UID が一致していても入らない**
    // —— 種になれるのは `ppid == 1` かつ所有 UID が一致するものだけだからである。
    expect(result?.reclaim?.candidates).toBe(2);
    expect(result?.reclaim?.candidateThreads).toBe(4 + 6);
  });

  /** 所有 UID がどれも一致しなければ、候補は0本（種が1つも立たない）。 */
  it('所有 UID が降ろした UID と一致しなければ候補は0本', async () => {
    placeProcess(root, 50, 'pnpm', 'S', 3, 0, 1);
    placeProcess(root, 51, 'node', 'S', 5, 0, 50);
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID + 1 }, // 偽装した /proc は全部 OWN_UID が所有している
    });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(0);
    expect(result?.reclaim?.candidateThreads).toBe(0);
  });

  /**
   * `D`（シグナルが届かない）と `Z`（tini の領分）は数えない。**ただし辿るのはやめない**
   * —— 撃てない親の下に撃てる子が居ることがある。
   */
  it('D と Z は候補に数えないが、その下の子は数える（通り抜ける）', async () => {
    placeProcess(root, 60, 'dd', 'D', 1, 0, 1); // 孤児ルートだが D
    placeProcess(root, 61, 'node', 'S', 4, 0, 60); // その子（数える）
    placeProcess(root, 62, 'sh', 'Z', 1, 0, 1); // 孤児ルートだが Z
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(1);
    expect(result?.reclaim?.candidateThreads).toBe(4);
    expect(result?.zombies).toBe(1); // ゾンビ側の数え方は変わっていない
  });

  /** 年齢 = uptime − starttime/clockTicks。いちばん古い（starttime が最小の）候補で出す。 */
  it('いちばん古い候補の年齢を uptime と starttime から出す', async () => {
    placeProcess(root, 70, 'pnpm', 'S', 1, 100_000, 1); // 100000 tick = 1000秒 → 年齢500秒
    placeProcess(root, 71, 'node', 'S', 1, 140_000, 1); // より新しい
    placeUptime(root, 1500);

    const reader = new TaskBreakdownReader({
      procRoot: root,
      clockTicksPerSecond: 100,
      reclaim: { childUid: OWN_UID },
    });
    const result = await reader.read();

    expect(result?.reclaim?.oldestAgeSec).toBe(500);
  });

  /** 候補が0本なら「いちばん古いもの」が存在しない。**0秒の行を作らない。** */
  it('候補が0本なら oldestAgeSec は欄ごと出ない（candidates は 0 のまま出す）', async () => {
    placeProcess(root, 80, 'node', 'S', 3, 0, 999); // 親が居る＝孤児ではない
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
    const result = await reader.read();

    expect(result?.reclaim?.candidates).toBe(0);
    expect(result?.reclaim?.oldestAgeSec).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'oldestAgeSec')).toBe(false);
  });

  /**
   * ⭐ **段0 は撃たない。** `grep` で「`process.kill` と書いていない」ことを見るのでは
   * 足りない（間接に呼ぶ経路を見落とす）。**候補が実在する器を実際に走査させて、
   * `process.kill` が1度も呼ばれないことを見る。**
   */
  it('段0 は撃たない: 候補が実在する器を走査しても process.kill を1度も呼ばない', async () => {
    placeProcess(root, 90, 'pnpm', 'S', 3, 0, 1);
    placeProcess(root, 91, 'node', 'S', 5, 0, 90);
    placeUptime(root, 1000);

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
      const result = await reader.read();

      // **撃つ機会が実在したことを先に固定する** —— 候補が0本なら、呼ばれないのは
      // 当たり前で、この歯は何も測っていないことになる。
      expect(result?.reclaim?.candidates).toBe(2);
      expect(kill).not.toHaveBeenCalled();

      // 撃っていないことは、名乗りの側でも一致していること。
      expect(result?.reclaim?.mode).toBe('observe');
      expect(result?.reclaim?.signalled).toBe(0);
      expect(result?.reclaim?.killed).toBe(0);
      expect(result?.reclaim?.freedThreads).toBe(0);
    } finally {
      kill.mockRestore();
    }
  });

  /** 撃った本数の欄は、0本でも**欄ごと省かない**（段1 で欄が生えたように見せないため）。 */
  it('signalled / killed / freedThreads は 0 でも欄として在る', async () => {
    placeProcess(root, 95, 'node', 'S', 1, 0, 999); // 候補0本の器でも欄は在る
    placeUptime(root, 1000);

    const reader = new TaskBreakdownReader({ procRoot: root, reclaim: { childUid: OWN_UID } });
    const result = await reader.read();

    expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'signalled')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'killed')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result?.reclaim, 'freedThreads')).toBe(true);
  });

  /** 走査したのと同じ瞬間の pids を、cgroup から同期で読む。 */
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

  /**
   * `pids.max` が `max`（上限なし）の器では、**現在値だけを出しても「何に対しての
   * 現在値か」が言えない。** `runner-resources.ts` の `pidsOf` と同じ判定で欄ごと省く。
   */
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

  /**
   * ⭐ **「0本だった」と「数えられなかった」を分ける。**
   *
   * pids が枯れた器では `/proc/<pid>/stat` が開けないことがある。**そこを黙って
   * 飛ばして数えると「孤児は居ない」という嘘になる。** だから読めなかったものが
   * 1件でもあれば、`reclaim` を**欄ごと出さない**（`candidates: 0` と書かない）。
   *
   * 偽装には `EISDIR` を使う —— `stat` をディレクトリにすると `readFile` が
   * `ENOENT` **ではない**エラーで落ちるので、「消えた」と「読めなかった」を
   * 実ファイルで作り分けられる。
   */
  it('読めなかったものが1件でもあれば reclaim を欄ごと出さない（candidates 0 と書かない）', async () => {
    placeProcess(root, 150, 'pnpm', 'S', 3, 0, 1);
    placeUptime(root, 1000);

    // 対照: 壊れたものが無ければ、候補1本として出る。
    const before = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
    }).read();
    expect(before?.reclaim?.candidates).toBe(1);

    // `/proc/151/stat` を「読めない」形にする（ディレクトリ ⟹ EISDIR。ENOENT ではない）。
    mkdirSync(join(root, '151', 'stat'), { recursive: true });

    const after = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
    }).read();

    expect(after?.reclaim).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(after, 'reclaim')).toBe(false);
    // **この規律が効くのは reclaim だけである** —— 他の欄はこれまでどおり出す。
    expect(after?.processes).toBe(1);
  });

  /**
   * ⚠️ **対照。** 走査中にプロセスが消える（`ENOENT`）のは**正常**なので、これで
   * 欄を落としてはいけない。落としてしまうと、混んだ器では `reclaim` が永久に
   * 出なくなる（＝観測が死ぬ）。
   */
  it('走査中に消えた（ENOENT）だけなら reclaim は出し続ける（消えるのは正常なので）', async () => {
    placeProcess(root, 160, 'pnpm', 'S', 3, 0, 1);
    mkdirSync(join(root, '161')); // stat を置かない ⟹ ENOENT
    placeUptime(root, 1000);

    const result = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
    }).read();

    expect(result?.reclaim?.candidates).toBe(1);
  });

  /**
   * ⭐ **差し替え口（`ownerUidOf`）は、本番経路では使われていない。**
   *
   * テスト用の差し替え口は「フィクスチャが実装間の差を先回りして揃える」危険を持つ。
   * **だから「渡さなければ実物の `fs` を触る」ことを、値ではなく呼び出しで測る**
   * —— 値だけを見ると、正しい値を返す偽物と区別が付かない。
   */
  it('差し替え口を渡さなければ、本番経路が実物の fs.stat を呼ぶ', async () => {
    placeProcess(root, 170, 'pnpm', 'S', 3, 0, 1);
    placeUptime(root, 1000);
    vi.mocked(stat).mockClear();

    const result = await new TaskBreakdownReader({
      procRoot: root,
      reclaim: { childUid: OWN_UID },
    }).read();

    // 候補が実在したこと（＝所有 UID を読む機会が在ったこと）を先に固定する。
    expect(result?.reclaim?.candidates).toBe(1);
    expect(vi.mocked(stat).mock.calls.some(([target]) => target === join(root, '170'))).toBe(true);
  });

  /** `lastRunAt` は「走査した時刻」である。**TTL のメモを返した回も、メモを取った時刻のまま。** */
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

    now = 1_500; // TTL の内側 → メモが返る
    const second = await reader.read();
    expect(second?.reclaim?.lastRunAt).toBe(1_000);

    now = 2_500; // TTL を超えた → 走査し直す
    const third = await reader.read();
    expect(third?.reclaim?.lastRunAt).toBe(2_500);
  });
});

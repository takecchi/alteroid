import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * この器（cgroup）が抱えるタスクの state 別内訳（#315「器の pids の合計が
 * どこからも見えない」の実装側。案1が出した「器の合計しか見えない」を埋める）。
 *
 * `/proc` を走査して集計する。ここで数える `threads` は
 * `readExecutionResources`（`packages/core/src/runner-resources.ts`）が cgroup
 * から読む `pids.current` と**同じ軸**（プロセス＋スレッドの総数）だが、
 * **厳密に一致するとは限らない** —— 測る主体（この走査そのもの）が走査中に
 * 増減するため、1〜数本ずれる（`packages/core/src/runner-protocol.ts` の
 * `tasks` の doc に転記してある）。
 *
 * **⚠️ 生きているプロセスの素性は一切含めない。** 出力に載るのは数と、
 * ゾンビの `comm`（コマンド名）だけである —— 他のマネージャーの仕事がここから
 * 覗ける形にしない。だから `cmdline` / `cwd` / `environ` は絶対に読まない
 * （読むのは `stat` と `uptime` だけ）。
 */
export interface TaskBreakdown {
  /** Σ num_threads。cgroup の pids.current と同じ軸で数えたもの。 */
  threads: number;
  /** `/proc/<pid>` の数（スレッドではなくプロセス）。 */
  processes: number;
  /** State=Z のプロセス数。ゾンビは常に1スレッドなので、そのままスレッド数でもある。 */
  zombies: number;
  /**
   * ゾンビの comm 別の内訳。多い順。**ゾンビだけ** —— 生存プロセスの素性は
   * 1バイトも含めない。上位 {@link ZOMBIE_COMMAND_LIMIT} 件までで、超えた分は
   * 黙って切り捨てず {@link ZOMBIE_COMMAND_OTHER_LABEL} へまとめる
   * （AGENTS.md「一覧の上限を件数だけで決める」と同じ理由 —— 黙って切り捨てない）。
   * ゾンビが1本も無ければ欄ごと省く。
   */
  zombieCommands?: Array<{ command: string; count: number }>;
  /**
   * いちばん古いゾンビの年齢（秒）。ゾンビが0本なら欄ごと省く
   * （AGENTS.md「取れない軸に0の行を作る」——0本のときの0秒は「取れた0」では
   * なく「そもそも対象が無い」なので、値そのものを作らない）。
   */
  oldestZombieSeconds?: number;
}

export interface TaskBreakdownOptions {
  /** `/proc` のマウント先。**主にテスト用で、既定はコードに固定である。** */
  procRoot?: string;
  /**
   * USER_HZ（1秒あたりの clock tick 数）。`/proc/<pid>/stat` の `starttime`
   * （22列目）はこの単位の tick 数で書かれる。**Linux/glibc では慣行的に100
   * 固定**（`sysconf(_SC_CLK_TCK)` がカーネルの実際の `HZ` 設定に関わらず
   * ユーザ空間へ返す値が、ほぼ全ての実運用環境で100に正規化されている）。
   * 既定は100だが、テストから固定できるように引数で差し替え可能にする。
   */
  clockTicksPerSecond?: number;
  /**
   * 1回の走査結果を保持する時間（ms）。既定 {@link DEFAULT_TTL_MS}。
   *
   * **`/health` は heartbeat の経路にあり、頻繁に叩かれる。** `/proc` の全走査は
   * O(pids) で、この器が数百〜千のタスクを抱えていると軽くない —— 毎回律儀に
   * 数え直すと heartbeat そのものを遅くする。短い TTL のメモを1つ持てば、
   * 同じ瞬間に何度呼ばれても実際の走査は1回で済む。テストから固定できるように
   * 引数で差し替え可能にする。
   */
  ttlMs?: number;
  /** いまの時刻（ms epoch）。**主にテスト用**（TTL が効くことを固定して確かめる）。 */
  now?: () => number;
}

const DEFAULT_CLOCK_TICKS_PER_SECOND = 100;
const DEFAULT_TTL_MS = 1000;

/** ゾンビの comm 別内訳を出す上限件数。超えた分は {@link ZOMBIE_COMMAND_OTHER_LABEL} へまとめる。 */
const ZOMBIE_COMMAND_LIMIT = 8;
const ZOMBIE_COMMAND_OTHER_LABEL = 'その他';

/**
 * `/proc` を走査してタスクの内訳を測るリーダー。**短い TTL のメモを1つ持つ**
 * （{@link TaskBreakdownOptions.ttlMs} の doc）。`apps/runner/src/app.ts` は
 * このインスタンスを1つだけ作り、`/health` のたびに {@link read} を呼ぶ。
 */
export class TaskBreakdownReader {
  readonly #root: string;
  readonly #clockTicksPerSecond: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #cache: { at: number; value: TaskBreakdown | undefined } | undefined;

  constructor(options: TaskBreakdownOptions = {}) {
    this.#root = options.procRoot ?? '/proc';
    this.#clockTicksPerSecond = options.clockTicksPerSecond ?? DEFAULT_CLOCK_TICKS_PER_SECOND;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * いまのタスクの内訳。**`/proc` が読めない環境（macOS のローカル開発など）
   * では `undefined` を返す**（欄ごと出さない。`readExecutionResources` が
   * pids について書いている「倒れ先が無いものは名乗らない」と同じ作法）。
   */
  async read(): Promise<TaskBreakdown | undefined> {
    const now = this.#now();
    if (this.#cache !== undefined && now - this.#cache.at < this.#ttlMs) {
      return this.#cache.value;
    }
    const value = await scanTasks(this.#root, this.#clockTicksPerSecond);
    this.#cache = { at: now, value };
    return value;
  }
}

/** `/proc` を1回だけ走査する。**メモは持たない** —— それは {@link TaskBreakdownReader} の役目。 */
async function scanTasks(
  root: string,
  clockTicksPerSecond: number,
): Promise<TaskBreakdown | undefined> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // `/proc` 自体が無い環境（macOS のローカル開発）。倒れ先が無いので名乗らない。
    return undefined;
  }

  const uptimeSeconds = await readUptimeSeconds(root);

  let threads = 0;
  let processes = 0;
  let zombies = 0;
  const zombieCommandCounts = new Map<string, number>();
  // 「いちばん古い」= starttime（起動からの経過 tick 数）がいちばん小さいもの。
  let oldestZombieStarttime: number | undefined;

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue; // `self` / `uptime` 等、pid でないものを飛ばす
    const parsed = await readStat(root, entry);
    if (parsed === undefined) continue; // 読めなければ黙って飛ばす（走査中に消えるのは正常）

    processes += 1;
    threads += parsed.numThreads;

    if (parsed.state === 'Z') {
      zombies += 1;
      zombieCommandCounts.set(parsed.comm, (zombieCommandCounts.get(parsed.comm) ?? 0) + 1);
      if (oldestZombieStarttime === undefined || parsed.starttime < oldestZombieStarttime) {
        oldestZombieStarttime = parsed.starttime;
      }
    }
  }

  const result: TaskBreakdown = { threads, processes, zombies };

  if (zombieCommandCounts.size > 0) {
    result.zombieCommands = topZombieCommands(zombieCommandCounts);
  }

  if (oldestZombieStarttime !== undefined && uptimeSeconds !== undefined) {
    const ageSeconds = Math.floor(uptimeSeconds - oldestZombieStarttime / clockTicksPerSecond);
    if (Number.isFinite(ageSeconds)) {
      result.oldestZombieSeconds = Math.max(0, ageSeconds);
    }
  }

  return result;
}

/** `/proc/uptime` の1つ目のフィールド（起動からの経過秒数）。読めなければ `undefined`。 */
async function readUptimeSeconds(root: string): Promise<number | undefined> {
  try {
    const raw = await readFile(join(root, 'uptime'), 'utf8');
    const value = Number(raw.trim().split(/\s+/)[0]);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `/proc/<pid>/stat` を1件読む。**`cmdline` / `cwd` / `environ` は絶対に読まない**
 * （生きているプロセスの素性を出力に含めないため。ファイル doc を参照）。
 *
 * **フォーマットの罠。** 2列目 `comm` は括弧で囲まれ、中に空白や `)` を含みうる
 * （例: `(sh (weird) name)`）。だから先頭からの素朴な空白分割はできない ——
 * **必ず最後の `) ` で切ってから残りを空白分割する。**
 */
async function readStat(
  root: string,
  pid: string,
): Promise<{ comm: string; state: string; numThreads: number; starttime: number } | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(root, pid, 'stat'), 'utf8');
  } catch {
    return undefined; // 走査中に消えるのは正常。黙って飛ばす。
  }
  const openIdx = raw.indexOf('(');
  const closeIdx = raw.lastIndexOf(') ');
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) return undefined;
  const comm = raw.slice(openIdx + 1, closeIdx);
  const rest = raw
    .slice(closeIdx + 2)
    .trimEnd()
    .split(/\s+/);
  // 切った後の配列: [0]=state(3列目) [1]=ppid(4列目) … [17]=num_threads(20列目)
  // … [19]=starttime(22列目)。
  const state = rest[0];
  const numThreads = Number(rest[17]);
  const starttime = Number(rest[19]);
  if (state === undefined || state.length === 0) return undefined;
  if (!Number.isFinite(numThreads) || numThreads <= 0) return undefined;
  if (!Number.isFinite(starttime) || starttime < 0) return undefined;
  return { comm, state, numThreads, starttime };
}

/** 多い順。上限を超えた分は {@link ZOMBIE_COMMAND_OTHER_LABEL} へまとめる（黙って切り捨てない）。 */
function topZombieCommands(counts: Map<string, number>): Array<{ command: string; count: number }> {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length <= ZOMBIE_COMMAND_LIMIT) {
    return sorted.map(([command, count]) => ({ command, count }));
  }
  const top = sorted.slice(0, ZOMBIE_COMMAND_LIMIT);
  const restCount = sorted.slice(ZOMBIE_COMMAND_LIMIT).reduce((sum, [, count]) => sum + count, 0);
  return [
    ...top.map(([command, count]) => ({ command, count })),
    { command: ZOMBIE_COMMAND_OTHER_LABEL, count: restCount },
  ];
}

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CGROUP_ROOT } from '@alteroid/core';

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
 *
 * **孤児の回収（#315 段0）を足したが、この約束は1文字も緩めていない。**
 * 回収の候補を数えるのに使う材料は `stat`（`ppid` / `state` / `num_threads` /
 * `starttime`）と、**`/proc/<pid>` ディレクトリそのものの所有 UID** だけである
 * （{@link ReclaimObservation} の doc）。所有 UID は `statSync` が返す
 * ディレクトリの属性であって、プロセスの素性が書かれたファイル
 * （`cmdline` / `cwd` / `environ`）ではない —— **そのどれも開いていない。**
 *
 * **走査が「読めなかった」で欠けたときは、回収の欄を出さない**
 * （{@link TaskBreakdown.reclaim} の doc）。
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
  /**
   * 孤児プロセス木の回収（#315 段0）。**切ってあるか、降ろす UID が
   * 分かっていなければ欄ごと出ない**（{@link ReclaimScanOptions}）。
   *
   * **⚠️ 走査が「読めなかった」で欠けたときも、欄ごと出ない。**「0本だった」と
   * 「数えられなかった」は別のことである —— pids が枯れた器では
   * `/proc/<pid>/stat` が `EAGAIN` で開けないことがあり、**そこを黙って飛ばして
   * 数えると「孤児は居ない」という嘘になる。** だから `ENOENT`（走査中に消えた。
   * これは正常）とそれ以外を分け、**それ以外が1件でもあればこの欄を出さない**
   * （{@link VANISHED_ERROR_CODES}）。
   *
   * ⚠️ **この規律が効くのはこの欄だけである。** 同じ走査から出る
   * {@link TaskBreakdown.threads} / {@link TaskBreakdown.processes} は、読めなかった
   * ぶんを飛ばしたまま数を名乗る（この機能より前からの振る舞い）。**揃えるかどうかは
   * まだ決めていない** —— 揃えると、前からある欄が新しく消えるようになる。
   */
  reclaim?: ReclaimObservation;
}

/**
 * 回収の動作段階。
 *
 * **いまここに在るのは段0（観測のみ）だけで、`'observe'` 以外は1度も出ない**
 * （{@link RECLAIM_MODE}）。それでも型に `'reclaim'` を先に置いてあるのは、
 * 段1 を載せた runner と、まだ古い版のデーモンが同時に居る窓を作らないためである
 * （AGENTS.md「Web UI とデーモンのように別デプロイなら版がずれる」——runner が
 * 先に新しい値を返し、受け取る側の型定義がまだ古い、という順序が実在する）。
 * **受け取る側を先に広げ、出す側を後から広げる。**
 */
export type ReclaimMode = 'observe' | 'reclaim';

/**
 * 孤児プロセス木の観測（#315 段0）。**この段は1本も撃たない —— 数えるだけである。**
 *
 * **何を候補と呼ぶか。** `ppid == 1`（親が既に居らず tini へ里子に出ている）かつ
 * **`/proc/<pid>` の所有 UID が、子プロセスを降ろす UID と一致する**もの
 * （＝ alteroid がこの器で起こしたものの残骸）を「孤児ルート」とし、
 * **その部分木を丸ごと**候補にする。部分木で取るのは、孤児ルートの子孫が
 * 親と違うディレクトリで働いていることがあるからで、**親子関係だけで拾えば
 * 作業ディレクトリを読まずに済む。**
 *
 * **⚠️ 名前・コマンド・パスで選ばない。** 選別の材料は所有 UID と親子関係だけである。
 * これは上のファイル doc の約束（素性を読まない）と、AGENTS.md「パターンで
 * プロセスを選ぶ操作は使わないこと」の**両方が同じ設計を指している**ためで、
 * どちらか一方のための妥協ではない。
 *
 * **⚠️ この判定は「終わった仕事の残骸」と「生きた委譲が切り離した、CPU をほとんど
 * 使わない孫」を区別しない。** `ppid == 1` になった時点で親が誰だったかは辿れず、
 * 辿るには `cwd` か `environ` を読むしかない（＝上の約束を破る）。**だからこの段は
 * 数えるだけで、撃つかどうかの判断はここに無い。**
 */
export interface ReclaimObservation {
  /** いまの段階。**段0 では常に `'observe'`**（{@link ReclaimMode} の doc）。 */
  mode: ReclaimMode;
  /** 候補のプロセス数。 */
  candidates: number;
  /** 候補の num_threads の合計。**`pids.current` と同じ軸**なので、返せる量の見積りになる。 */
  candidateThreads: number;
  /**
   * いちばん古い候補の年齢（秒）。**候補が0本なら欄ごと省く**
   * （`oldestZombieSeconds` と同じ理由 —— 0本のときの0秒は「取れた0」ではない）。
   * `/proc/uptime` が読めないときも省く。
   */
  oldestAgeSec?: number;
  /**
   * SIGTERM を送った本数。**段0 では常に 0 である**（送出の経路が1つも無い。
   * `apps/runner/src/tasks.test.ts` の「段0 は撃たない」がそれを振る舞いで固定する）。
   *
   * **0でも欄を省かないのは、段1 で欄が生えたように見せないためである。**
   * 「前は無かった欄が増えた」と読まれると、段0 の観測と段1 の観測が別物に見える。
   */
  signalled: number;
  /** SIGKILL を送った本数。**段0 では常に 0**（{@link ReclaimObservation.signalled} と同じ理由で欄は置く）。 */
  killed: number;
  /** 回収で返ったスレッド数。**段0 では常に 0**（{@link ReclaimObservation.signalled} と同じ理由で欄は置く）。 */
  freedThreads: number;
  /** この観測を取った時刻（epoch ms）。**TTL のメモを返したときは、メモを取った時刻である。** */
  lastRunAt: number;
  /**
   * **走査したのと同じ瞬間の** `pids.current` / `pids.max`。
   *
   * `resources.pids`（`readExecutionResources`）とは別に、ここでもう一度読んでいる。
   * **理由は時刻を揃えるためである** —— あちらは `/health` の中で別に読まれるので、
   * 「候補が何本居たとき pids がいくつだったか」を1組で言えない。
   *
   * ⚠️ **そのために `cgroupDirs` / `readText` を `runner-resources.ts` から
   * 約15行複製している**（住所: `packages/core/src/runner-resources.ts` の
   * `cgroupDirs` と `readText`）。**複製であることを承知で置いてある** —— 畳むなら
   * core 側に口を作る話になるので、別の変更として扱う。
   *
   * 読めなければ欄ごと省く（`pids.max` が `max`＝上限なしの器を含む。判定は
   * `runner-resources.ts` の `pidsOf` と同じ形にしてある）。
   */
  pidsAtScan?: { current: number; max: number };
}

/** 回収の観測を有効にする設定。**渡さなければ観測そのものが動かない**（＝切ってある）。 */
export interface ReclaimScanOptions {
  /**
   * 子プロセスを降ろす UID（`ALTEROID_RUNNER_CHILD_UID`）。
   *
   * **これが分からない器では観測しない。** 降ろす UID が無い器では、器の常設物と
   * alteroid が起こしたものを所有 UID で分けられず、候補が「この器に居る `ppid == 1`
   * のプロセス全部」になってしまう。取れない軸に数を作らない（AGENTS.md）。
   */
  childUid: number;
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
  /**
   * 孤児プロセス木の観測（#315 段0）。**省略すると {@link TaskBreakdown.reclaim} が
   * 欄ごと出ない。** 切る口はここ1つで、`apps/runner/src/index.ts` の
   * `reclaimScanOf` が環境変数から組み立てる。
   */
  reclaim?: ReclaimScanOptions;
  /** cgroup v2 のマウント先。**主にテスト用で、既定はコードに固定である。** */
  cgroupRoot?: string;
  /** 自分がどの cgroup に居るかが書いてある場所。主にテスト用。 */
  procCgroupPath?: string;
  /**
   * `/proc/<pid>` の所有 UID の読み方。既定は {@link readOwnerUid}（実際に `statSync` する）。
   *
   * **主にテスト用**（`now` と同じ理由）。一時ディレクトリへ偽装した `/proc` は
   * 全部テスト実行者が所有するので、**「器の常設物（root が所有）と alteroid の子
   * （降ろした UID が所有）が混ざっている器」を実物のファイルでは作れない** ——
   * 特権が無ければ `chown` できないからである。**いちばん撃ってはいけないもの
   * （root の `ppid == 1` の下に居る、生きたセッション）を候補に数えないことを
   * 固定するには、ここを差し替えるしかない。**
   */
  ownerUidOf?: (procRoot: string, pid: string) => Promise<number | undefined>;
}

const DEFAULT_CLOCK_TICKS_PER_SECOND = 100;
const DEFAULT_TTL_MS = 1000;
const DEFAULT_PROC_CGROUP_PATH = '/proc/self/cgroup';

/** ゾンビの comm 別内訳を出す上限件数。超えた分は {@link ZOMBIE_COMMAND_OTHER_LABEL} へまとめる。 */
const ZOMBIE_COMMAND_LIMIT = 8;
const ZOMBIE_COMMAND_OTHER_LABEL = 'その他';

/**
 * この版が名乗る段階。**段0 は観測しかしないので `'observe'` に固定である。**
 * 定数にしてあるのは1箇所で済ませるためではなく、**段0 のうちはここが動かないことを
 * テストで固定するため**である。
 */
const RECLAIM_MODE: ReclaimMode = 'observe';

/** 里子の引き取り手（init）の pid。`ppid` がこれなら、元の親はもう居ない。 */
const INIT_PID = 1;

/**
 * 回収の候補から外す state。
 *
 * - `D`（uninterruptible sleep）: シグナルが届かない。撃てないものを候補に数えると、
 *   段1 で「送ったのに減らない」が候補の数え方の問題として現れて切り分けを潰す
 * - `Z`（ゾンビ）: tini の領分である（`docker/alteroid-runner` が pid 1 に tini を
 *   据えている理由そのもの）。ここで二重に数えない
 */
const RECLAIM_EXCLUDED_STATES = new Set(['D', 'Z']);

/**
 * `/proc` を走査してタスクの内訳を測るリーダー。**短い TTL のメモを1つ持つ**
 * （{@link TaskBreakdownOptions.ttlMs} の doc）。`apps/runner/src/app.ts` は
 * このインスタンスを1つだけ作り、`/health` のたびに {@link TaskBreakdownReader.read} を呼ぶ。
 */
export class TaskBreakdownReader {
  readonly #root: string;
  readonly #clockTicksPerSecond: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #reclaim: ReclaimScanOptions | undefined;
  readonly #cgroupRoot: string;
  readonly #procCgroupPath: string;
  readonly #ownerUidOf: (procRoot: string, pid: string) => Promise<number | undefined>;
  #cache: { at: number; value: TaskBreakdown | undefined } | undefined;

  constructor(options: TaskBreakdownOptions = {}) {
    this.#root = options.procRoot ?? '/proc';
    this.#clockTicksPerSecond = options.clockTicksPerSecond ?? DEFAULT_CLOCK_TICKS_PER_SECOND;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#reclaim = options.reclaim;
    this.#cgroupRoot = options.cgroupRoot ?? CGROUP_ROOT;
    this.#procCgroupPath = options.procCgroupPath ?? DEFAULT_PROC_CGROUP_PATH;
    this.#ownerUidOf = options.ownerUidOf ?? readOwnerUid;
  }

  /**
   * いまのタスクの内訳。**`/proc` が読めない環境（macOS のローカル開発など）
   * では `undefined` を返す**（欄ごと出さない。`readExecutionResources` が
   * pids について書いている「倒れ先が無いものは名乗らない」と同じ作法）。
   *
   * **中身は非同期 I/O のままにしてある**（`node:fs/promises`）。同期
   * （`readdirSync` 等）にすれば「新しいタスクを1本も要求しない」形にはできるが、
   * **代償が重い** —— 走査は O(pids) なので、pids が枯れた器では `/health` が
   * 丸ごと長時間止まる。**`/health` は生存確認の口である。** 止まった器は
   * 「黙った器」として `lost` / `unreachable` へ倒れるので、**「pids が枯れた器」が
   * 「消えた器」に化ける。**
   *
   * **非同期なら、枯渇時は走査そのものが失敗する。** そしてそれは
   * {@link TaskBreakdown.reclaim} を欄ごと落とすので、**「0本だった」と
   * 「数えられなかった」が読む側で分かれる。** 同期にすると、その区別のほうが消える。
   *
   * ⚠️ **「同期のほうが枯渇に強い」は推論であって実測ではない**（libuv の
   * スレッドプールが遅延生成される性質からの外挿）。**実測でそう分かったときに
   * 変える** —— 推論だけで、区別できる形を捨てない。
   */
  async read(): Promise<TaskBreakdown | undefined> {
    const now = this.#now();
    if (this.#cache !== undefined && now - this.#cache.at < this.#ttlMs) {
      return this.#cache.value;
    }
    const value = await scanTasks(this.#root, this.#clockTicksPerSecond, now, this.#reclaim, {
      cgroupRoot: this.#cgroupRoot,
      procCgroupPath: this.#procCgroupPath,
      ownerUidOf: this.#ownerUidOf,
    });
    this.#cache = { at: now, value };
    return value;
  }
}

/** 走査の途中で持つ1プロセスぶんの値。**素性は1つも持たない**（`comm` はゾンビのときだけ使う）。 */
interface ScannedProcess {
  pid: number;
  ppid: number;
  state: string;
  numThreads: number;
  starttime: number;
  /** `/proc/<pid>` ディレクトリの所有 UID。回収の観測が切ってあるときは読まない（`undefined`）。 */
  ownerUid: number | undefined;
}

/**
 * 走査中に起きても「異常ではない」エラー。**走査しているあいだにプロセスが消えるのは
 * 正常である**（`/proc/<pid>` は生き死にのたびに現れて消える）。
 *
 * **これ以外のエラーは「読めなかった」として扱う** —— pids が枯れた器で
 * `EAGAIN` / `EMFILE` が返るのがその形で、**黙って飛ばすと「孤児は居ない」という
 * 嘘になる**（{@link TaskBreakdown.reclaim} の doc）。
 */
const VANISHED_ERROR_CODES = new Set(['ENOENT', 'ESRCH']);

/** 走査が「読めなかった」で欠けたかどうか。**1件でも欠けたら回収の欄を出さない。** */
interface ScanHealth {
  degraded: boolean;
}

/** `ENOENT` 等（走査中に消えた）なら true。**それ以外は「読めなかった」である。** */
function isVanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && VANISHED_ERROR_CODES.has(code);
}

/** `/proc` を1回だけ走査する。**メモは持たない** —— それは {@link TaskBreakdownReader} の役目。 */
async function scanTasks(
  root: string,
  clockTicksPerSecond: number,
  nowMs: number,
  reclaim: ReclaimScanOptions | undefined,
  cgroup: {
    cgroupRoot: string;
    procCgroupPath: string;
    ownerUidOf: (procRoot: string, pid: string) => Promise<number | undefined>;
  },
): Promise<TaskBreakdown | undefined> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // `/proc` 自体が無い環境（macOS のローカル開発）。倒れ先が無いので名乗らない。
    return undefined;
  }

  const health: ScanHealth = { degraded: false };
  const uptimeSeconds = await readUptimeSeconds(root);

  let threads = 0;
  let processes = 0;
  let zombies = 0;
  const zombieCommandCounts = new Map<string, number>();
  // 「いちばん古い」= starttime（起動からの経過 tick 数）がいちばん小さいもの。
  let oldestZombieStarttime: number | undefined;
  const scanned: ScannedProcess[] = [];

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue; // `self` / `uptime` 等、pid でないものを飛ばす
    const parsed = await readStat(root, entry, health);
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

    if (reclaim !== undefined) {
      scanned.push({
        pid: Number(entry),
        ppid: parsed.ppid,
        state: parsed.state,
        numThreads: parsed.numThreads,
        starttime: parsed.starttime,
        ownerUid: await ownerUidOrDegraded(cgroup.ownerUidOf, root, entry, health),
      });
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

  // **「0本だった」と「数えられなかった」を分ける。** 1件でも読めなかったなら、
  // 数は名乗らない（{@link TaskBreakdown.reclaim} の doc）。
  if (reclaim !== undefined && !health.degraded) {
    result.reclaim = await observeReclaim(
      scanned,
      reclaim,
      clockTicksPerSecond,
      uptimeSeconds,
      nowMs,
      cgroup,
    );
  }

  return result;
}

/**
 * 所有 UID を読む。**投げたら「読めなかった」として数える** —— ここで握り潰して
 * `undefined` にすると、候補から静かに漏れて「孤児は居ない」に化ける
 * （{@link TaskBreakdown.reclaim} の doc）。
 */
async function ownerUidOrDegraded(
  ownerUidOf: (procRoot: string, pid: string) => Promise<number | undefined>,
  root: string,
  pid: string,
  health: ScanHealth,
): Promise<number | undefined> {
  try {
    return await ownerUidOf(root, pid);
  } catch (error) {
    if (!isVanished(error)) health.degraded = true;
    return undefined;
  }
}

/**
 * 孤児プロセス木を数える（#315 段0）。**シグナルは1本も送らない。**
 *
 * この関数は `process.kill` を参照しない。**それを `grep` ではなく振る舞いで
 * 固定してある** —— `tasks.test.ts` の「段0 は撃たない」が、候補が実在する器を
 * 走査させたうえで `process.kill` が1度も呼ばれないことを見る。
 */
async function observeReclaim(
  scanned: readonly ScannedProcess[],
  reclaim: ReclaimScanOptions,
  clockTicksPerSecond: number,
  uptimeSeconds: number | undefined,
  nowMs: number,
  cgroup: { cgroupRoot: string; procCgroupPath: string },
): Promise<ReclaimObservation> {
  const children = new Map<number, ScannedProcess[]>();
  for (const entry of scanned) {
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }

  // 孤児ルート: 親が既に居らず（`ppid == 1`）、かつ降ろす UID が所有しているもの。
  // **root が所有する `ppid == 1` のプロセス（runner 自身など）を種にしない** ——
  // 種にすると、その部分木に居る**生きたセッション**まで候補に入る。
  const roots = scanned.filter(
    (entry) =>
      entry.ppid === INIT_PID && entry.ownerUid === reclaim.childUid && entry.pid !== INIT_PID,
  );

  let candidates = 0;
  let candidateThreads = 0;
  let oldestStarttime: number | undefined;

  // 部分木を辿る。**除外 state のプロセスも「通り抜ける」** —— 撃てない親の下に
  // 撃てる子が居ることがあるので、数えないだけで辿るのはやめない。
  const visited = new Set<number>();
  const queue = [...roots];
  for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) {
    if (visited.has(entry.pid)) continue; // 壊れた `/proc` が輪を作っても回り続けない
    visited.add(entry.pid);

    if (entry.ownerUid === reclaim.childUid && !RECLAIM_EXCLUDED_STATES.has(entry.state)) {
      candidates += 1;
      candidateThreads += entry.numThreads;
      if (oldestStarttime === undefined || entry.starttime < oldestStarttime) {
        oldestStarttime = entry.starttime;
      }
    }

    for (const child of children.get(entry.pid) ?? []) {
      if (child.pid !== entry.pid) queue.push(child);
    }
  }

  const observation: ReclaimObservation = {
    mode: RECLAIM_MODE,
    candidates,
    candidateThreads,
    // 段0 には撃つ経路が無い。**0 を書くのは「取れない軸に0を作る」ではない** ——
    // 「撃てる段に居て、0本撃った」ではなく「この段は撃たないと名乗っている」ことを、
    // `mode` と組で読む欄である。
    signalled: 0,
    killed: 0,
    freedThreads: 0,
    lastRunAt: nowMs,
  };

  if (oldestStarttime !== undefined && uptimeSeconds !== undefined) {
    const ageSeconds = Math.floor(uptimeSeconds - oldestStarttime / clockTicksPerSecond);
    if (Number.isFinite(ageSeconds)) observation.oldestAgeSec = Math.max(0, ageSeconds);
  }

  const pids = await readPidsAtScan(cgroup.cgroupRoot, cgroup.procCgroupPath);
  if (pids !== undefined) observation.pidsAtScan = pids;

  return observation;
}

/**
 * `/proc/<pid>` ディレクトリの所有 UID。**これが本番の経路である**
 * （{@link TaskBreakdownOptions.ownerUidOf} の既定）。
 *
 * **これは「プロセスの素性」ではない。** 読んでいるのはディレクトリの inode 属性で、
 * `cmdline` / `cwd` / `environ` はどれも開いていない（ファイル doc の約束）。
 *
 * **ここでは握り潰さない。** 消えた（`ENOENT`）のか読めなかった（`EAGAIN` 等）のかを
 * 分けるのは呼び出し側（`ownerUidOrDegraded`）の仕事で、ここで `catch` すると
 * その区別が生まれる前に消える。
 */
async function readOwnerUid(root: string, pid: string): Promise<number | undefined> {
  return (await stat(join(root, pid))).uid;
}

/**
 * 走査したのと同じ瞬間の `pids.current` / `pids.max`。
 *
 * **`runner-resources.ts` の `readExecutionResources` を呼ばずに、ここで小さく
 * 読み直している。** 理由は {@link ReclaimObservation.pidsAtScan} の doc に在る
 * （時刻を揃えること・同期で読むこと）。判定（`max` が数として読めなければ欄ごと
 * 省く）は向こうの `pidsOf` と同じ形にしてある。
 */
async function readPidsAtScan(
  cgroupRoot: string,
  procCgroupPath: string,
): Promise<{ current: number; max: number } | undefined> {
  const dirs = await cgroupDirs(cgroupRoot, procCgroupPath);
  const currentValue = Number(await readFirstText(dirs, 'pids.current'));
  const maxValue = Number(await readFirstText(dirs, 'pids.max'));
  if (!Number.isSafeInteger(maxValue) || maxValue <= 0) return undefined;
  if (!Number.isFinite(currentValue) || currentValue < 0) return undefined;
  return { current: currentValue, max: maxValue };
}

/**
 * cgroup のファイルがある場所。**2箇所を見る**（`runner-resources.ts` の
 * `cgroupDirs` と同じ理由 —— 器の cgroup 名前空間が分かれているかで在り処が変わる）。
 */
async function cgroupDirs(root: string, procCgroupPath: string): Promise<readonly string[]> {
  const own = (await readText(procCgroupPath))
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('0::'))
    ?.slice('0::'.length);
  if (own === undefined || own === '' || own === '/') return [root];
  return [join(root, own), root];
}

async function readFirstText(dirs: readonly string[], name: string): Promise<string | undefined> {
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

/** `/proc/uptime` の1つ目のフィールド（起動からの経過秒数）。読めなければ `undefined`。 */
async function readUptimeSeconds(root: string): Promise<number | undefined> {
  const raw = await readText(join(root, 'uptime'));
  if (raw === undefined) return undefined;
  const value = Number(raw.split(/\s+/)[0]);
  return Number.isFinite(value) ? value : undefined;
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
  health: ScanHealth,
): Promise<
  { comm: string; state: string; ppid: number; numThreads: number; starttime: number } | undefined
> {
  let raw: string;
  try {
    raw = (await readFile(join(root, pid, 'stat'), 'utf8')).trim();
  } catch (error) {
    // **走査中に消えた（ENOENT）のは正常。それ以外は「読めなかった」である。**
    if (!isVanished(error)) health.degraded = true;
    return undefined;
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
  const ppid = Number(rest[1]);
  const numThreads = Number(rest[17]);
  const starttime = Number(rest[19]);
  if (state === undefined || state.length === 0) return undefined;
  if (!Number.isFinite(ppid) || ppid < 0) return undefined;
  if (!Number.isFinite(numThreads) || numThreads <= 0) return undefined;
  if (!Number.isFinite(starttime) || starttime < 0) return undefined;
  return { comm, state, ppid, numThreads, starttime };
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

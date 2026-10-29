import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CGROUP_ROOT } from '@alteroid/core';

// 生きているプロセスの素性は含めない: 他のマネージャーの仕事が覗ける形にしないため。`cmdline` / `cwd` / `environ` は読まず、`stat` と `uptime` と所有 UID だけを使う。
interface TaskBreakdown {
  threads: number;
  processes: number;
  zombies: number;
  zombieCommands?: Array<{ command: string; count: number }>;
  oldestZombieSeconds?: number;
  // 走査が「読めなかった」で欠けたときは欄ごと出さない: 「0本だった」と「数えられなかった」を分けるため。
  reclaim?: ReclaimObservation;
}

type ReclaimMode = 'observe' | 'reclaim';

// 名前・コマンド・パスで候補を選ばない: 素性を読まない約束と、パターンでプロセスを選ばない規約の両方に反するため。
interface ReclaimObservation {
  mode: ReclaimMode;
  // 委譲の CLI の引き取り手（#4494）。`null` は探したが無かった。起動ログにしか出ないと、クローンから効いているかを確かめられないため。
  subreaper?: { command: string | null };
  candidates: number;
  candidateThreads: number;
  roots: number;
  largestTreeCandidates: number;
  singletonTrees: number;
  // 起動からの齢であって、孤児になってからの齢ではない: `ppid` が 1 へ移った時刻は `/proc` に無いため。
  oldestAgeSec?: number;
  medianAgeSec?: number;
  ageBuckets?: Array<{ upToSec?: number; count: number }>;
  signalled: number;
  killed: number;
  freedThreads: number;
  lastRunAt: number;
  // `/health` とは別に読み直す: 走査と同じ瞬間の値で、候補数と対にするため。
  pidsAtScan?: { current: number; max: number };
  notFired: ReclaimNotFired;
}

export interface ReclaimScanOptions {
  // 降ろす UID が分からない器では観測しない: 常設物と alteroid の子を所有 UID で分けられず、候補が `ppid == 1` の全部になるため。
  childUid: number;
  // `reclaim` は撃つ。`observe` は、委譲が0本のときの全員（`fireNoDelegations`）を撃たずに `observeOnly` へ数える。
  mode: ReclaimMode;
  view: ReclaimSessionView;
  // 起動時に決まった委譲の引き取り手（`delegationSubreaperOf`）。`null` は探したが無かった。省略は「観測に載せない」。
  delegationSubreaper?: string | null;
}

export interface ReclaimSessionView {
  // 値ではなく関数で受ける: `TaskBreakdownReader` は1度だけ構築されて走り続け、値だと起動時点の空集合に固定されるため。
  // 材料を欄ごとの関数にしない: 欄ごとに呼ぶと別々の時点で計算し直され、境目の時刻をまたぐと同じ pid が2つの欄に入りうるため。1回の走査では頭で1回だけ呼ぶ。
  snapshot: () => ReclaimSessionSnapshot;
}

export interface ReclaimSessionSnapshot {
  live: ReadonlySet<number>;
  // runner プロセスを跨いで持ち越さない: 作り直し直後の古い孤児は「記憶に無い」側に落とし、撃たないため。
  knownTerminated: ReadonlySet<number>;
  // 持ち主が名簿に居るので `knownTerminated` に入れていない CLI の pid。観測の内訳にだけ使い、撃つ判定には渡さない。
  ownerListed: ReadonlySet<number>;
  // `knownTerminated` の部分集合（#5162）: 鍵の付け替えの畳みで背景処理を畳んだだけで、持ち主はまだ名簿に居る（または戻り待ち）委譲の pid。
  // 引き取り手（tini）を挟む構成では、この sid の木のうち CLI の枝だけを撃つ。空なら絞らない（木を丸ごと撃つ）。
  abandonedOwnerListed: ReadonlySet<number>;
  // `live` の大きさで代用しない: `childUser` 無しの構成では常に空集合で、生きた委譲があっても分岐1が撃ってしまうため。
  anyTrackedDelegations: boolean;
}

interface ReclaimHeldCounts {
  sidUnknown: number;
  sidLive: number;
  sidLeaderPresent: number;
  sidUnrecognised: number;
}

// 合計は `sidUnrecognised` と一致する。数えるだけで、撃つ判定には使わない（#5157）。
interface UnrecognisedOwnerSplit {
  ownerLive: number;
  ownerListed: number;
  ownerUnknown: number;
}

interface ReclaimNotFired {
  outsideRoots: {
    total: number;
    parentInScan: number;
    bySid?: ReclaimHeldCounts & { wouldFire: number; unrecognisedBy?: UnrecognisedOwnerSplit };
  };
  held?: ReclaimHeldCounts & { unrecognisedBy?: UnrecognisedOwnerSplit };
  observeOnly?: number;
}

interface TaskBreakdownOptions {
  procRoot?: string;
  clockTicksPerSecond?: number;
  // `/proc` の全走査は O(pids) で、`/health` は頻繁に叩かれる: 毎回数え直すと heartbeat を遅くするためメモを持つ。
  ttlMs?: number;
  now?: () => number;
  reclaim?: ReclaimScanOptions;
  cgroupRoot?: string;
  procCgroupPath?: string;
  ownerUidOf?: (procRoot: string, pid: string) => Promise<number | undefined>;
  killFn?: (pid: number, signal: NodeJS.Signals) => void;
}

const DEFAULT_CLOCK_TICKS_PER_SECOND = 100;
const DEFAULT_TTL_MS = 1000;
const DEFAULT_PROC_CGROUP_PATH = '/proc/self/cgroup';

const ZOMBIE_COMMAND_LIMIT = 8;
const ZOMBIE_COMMAND_OTHER_LABEL = 'その他';

const DEFAULT_REAP_GRACE_MS = 10_000;

const INIT_PID = 1;

// `D` は候補にしない: シグナルが届かず、段1で「送ったのに減らない」が数え方の問題に見えるため。
// `Z` は候補にしない: tini の領分で、二重に数えるため。
const RECLAIM_EXCLUDED_STATES = new Set(['D', 'Z']);

const RECLAIM_AGE_BUCKET_BOUNDARIES_SEC = [60, 600, 3600, 21600] as const;

export class TaskBreakdownReader {
  readonly #root: string;
  readonly #clockTicksPerSecond: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #reclaim: ReclaimScanOptions | undefined;
  readonly #cgroupRoot: string;
  readonly #procCgroupPath: string;
  readonly #ownerUidOf: (procRoot: string, pid: string) => Promise<number | undefined>;
  readonly #killFn: (pid: number, signal: NodeJS.Signals) => void;
  #cache: { at: number; value: TaskBreakdown | undefined } | undefined;
  // 走っている走査に相乗りさせる: `/health`（名乗りの確認・配置の資源の問い）と回収の掃除は別々に来るので、走査が遅い器ほど
  // 走査中に次の要求が届き、O(pids) の走査が並んで器をさらに重くする。並んだ走査は回収の帳面（`#reaper` / `#lineage`）も並行に書き換え、
  // 古い写しで始めた走査が後から終わると、新しい走査が書いた系譜を古い系譜で上書きする（#4454 の仮説3の調べで見つけた）。
  #inflight: Promise<TaskBreakdown | undefined> | undefined;
  readonly #reaper = new Map<number, ReaperEntry>();
  readonly #lineage = new Map<number, LineageEntry>();
  readonly #branches = new Map<number, BranchEntry>();

  constructor(options: TaskBreakdownOptions = {}) {
    this.#root = options.procRoot ?? '/proc';
    this.#clockTicksPerSecond = options.clockTicksPerSecond ?? DEFAULT_CLOCK_TICKS_PER_SECOND;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#reclaim = options.reclaim;
    this.#cgroupRoot = options.cgroupRoot ?? CGROUP_ROOT;
    this.#procCgroupPath = options.procCgroupPath ?? DEFAULT_PROC_CGROUP_PATH;
    this.#ownerUidOf = options.ownerUidOf ?? readOwnerUid;
    this.#killFn = options.killFn ?? ((pid, signal) => process.kill(pid, signal));
  }

  // 同期 I/O（`readdirSync` 等）にしない: 走査は O(pids) で、pids が枯れた器では `/health` が長時間止まり「消えた器」に化け、reclaim の欠落で「0本」と「数えられなかった」を分ける区別も消えるため。
  async read(): Promise<TaskBreakdown | undefined> {
    const now = this.#now();
    if (this.#cache !== undefined && now - this.#cache.at < this.#ttlMs) {
      return this.#cache.value;
    }
    return this.#scan(now);
  }

  // `read()` に任せない: ttl が `maxAgeMs` より長いと、古いのに走査されず回収が止まるため。
  async sweepIfStale(maxAgeMs: number): Promise<void> {
    const now = this.#now();
    if (this.#cache !== undefined && now - this.#cache.at < maxAgeMs) return;
    await this.#scan(now);
  }

  // 走っている走査があれば、新しく始めずにその結果を返す。返す値はその走査を始めた時点の写しで、`ttlMs` より古いことがある
  // （走査そのものが `ttlMs` より長くかかる器でだけ起きる。そういう器で走査を重ねるほうが、写しの古さより害が大きい）。
  #scan(now: number): Promise<TaskBreakdown | undefined> {
    if (this.#inflight !== undefined) return this.#inflight;
    const inflight = this.#scanOnce(now).finally(() => {
      if (this.#inflight === inflight) this.#inflight = undefined;
    });
    this.#inflight = inflight;
    return inflight;
  }

  async #scanOnce(now: number): Promise<TaskBreakdown | undefined> {
    const value = await scanTasks(this.#root, this.#clockTicksPerSecond, now, this.#reclaim, {
      cgroupRoot: this.#cgroupRoot,
      procCgroupPath: this.#procCgroupPath,
      ownerUidOf: this.#ownerUidOf,
      killFn: this.#killFn,
      reaper: this.#reaper,
      lineage: this.#lineage,
      branches: this.#branches,
    });
    this.#cache = { at: now, value };
    return value;
  }
}

// デーモンの heartbeat（`HEARTBEAT_INTERVAL_MS`）と同じ間隔にする: 揃えておけば、デーモンが居ない間の掃除の遅れを heartbeat と同じ尺で読めるため。
const RECLAIM_SWEEP_INTERVAL_MS = 10_000;

interface ReclaimSweepOptions {
  setIntervalFn?: (callback: () => void, ms: number) => { unref?: () => unknown };
  clearIntervalFn?: (handle: { unref?: () => unknown }) => void;
}

// `/health` だけに走査を任せない: デーモンが居ない間は誰も叩かず、畳んだ木が撃たれないまま残るため。
export function startReclaimSweep(
  reader: Pick<TaskBreakdownReader, 'sweepIfStale'>,
  options: ReclaimSweepOptions = {},
): () => void {
  const intervalMs = RECLAIM_SWEEP_INTERVAL_MS;
  const setIntervalFn: NonNullable<ReclaimSweepOptions['setIntervalFn']> =
    options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalFn: NonNullable<ReclaimSweepOptions['clearIntervalFn']> =
    options.clearIntervalFn ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let running = false;
  const handle = setIntervalFn(() => {
    // 重ねて走らせない: 走査は O(pids) で、遅い器では前の回が終わる前に次が来るため。
    if (running) return;
    running = true;
    // 失敗は握る: 次の回で取り戻せるが、unhandled rejection はランナーごと落とすため。
    void reader
      .sweepIfStale(intervalMs)
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  handle.unref?.();
  return () => clearIntervalFn(handle);
}

interface ScannedProcess {
  pid: number;
  ppid: number;
  state: string;
  numThreads: number;
  starttime: number;
  sid: number | undefined;
  ownerUid: number | undefined;
}

// これ以外のエラーは「読めなかった」として扱う: `EAGAIN` / `EMFILE` を黙って飛ばすと「孤児は居ない」という嘘になるため。
const VANISHED_ERROR_CODES = new Set(['ENOENT', 'ESRCH']);

interface ScanHealth {
  degraded: boolean;
}

function isVanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && VANISHED_ERROR_CODES.has(code);
}

async function scanTasks(
  root: string,
  clockTicksPerSecond: number,
  nowMs: number,
  reclaim: ReclaimScanOptions | undefined,
  deps: {
    cgroupRoot: string;
    procCgroupPath: string;
    ownerUidOf: (procRoot: string, pid: string) => Promise<number | undefined>;
    killFn: (pid: number, signal: NodeJS.Signals) => void;
    reaper: Map<number, ReaperEntry>;
    lineage: Map<number, LineageEntry>;
    branches: Map<number, BranchEntry>;
  },
): Promise<TaskBreakdown | undefined> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return undefined;
  }

  const health: ScanHealth = { degraded: false };
  const uptimeSeconds = await readUptimeSeconds(root);

  let threads = 0;
  let processes = 0;
  let zombies = 0;
  const zombieCommandCounts = new Map<string, number>();
  let oldestZombieStarttime: number | undefined;
  const scanned: ScannedProcess[] = [];

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const parsed = await readStat(root, entry, health);
    if (parsed === undefined) continue;

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
        sid: parsed.sid,
        ownerUid: await ownerUidOrDegraded(deps.ownerUidOf, root, entry, health),
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

  if (reclaim !== undefined && !health.degraded) {
    result.reclaim = await observeReclaim(
      scanned,
      reclaim,
      clockTicksPerSecond,
      uptimeSeconds,
      nowMs,
      deps,
    );
  }

  return result;
}

// 投げたら「読めなかった」として数える: 握り潰して `undefined` にすると、候補から静かに漏れて「孤児は居ない」に化けるため。
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

function childrenByPpidOf(scanned: readonly ScannedProcess[]): Map<number, ScannedProcess[]> {
  const children = new Map<number, ScannedProcess[]>();
  for (const entry of scanned) {
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }
  return children;
}

async function observeReclaim(
  scanned: readonly ScannedProcess[],
  reclaim: ReclaimScanOptions,
  clockTicksPerSecond: number,
  uptimeSeconds: number | undefined,
  nowMs: number,
  deps: {
    cgroupRoot: string;
    procCgroupPath: string;
    killFn: (pid: number, signal: NodeJS.Signals) => void;
    reaper: Map<number, ReaperEntry>;
    lineage: Map<number, LineageEntry>;
    branches: Map<number, BranchEntry>;
  },
): Promise<ReclaimObservation> {
  const children = childrenByPpidOf(scanned);

  // root が所有する `ppid == 1` のプロセス（runner 自身など）を種にしない: その部分木に居る生きたセッションまで候補に入るため。
  const roots = scanned.filter(
    (entry) =>
      entry.ppid === INIT_PID && entry.ownerUid === reclaim.childUid && entry.pid !== INIT_PID,
  );

  // 判定材料は1回だけ取る: BFS の途中で値が動くと、同じ回の中で判定がぶれるため。
  const { view, mode } = reclaim;
  const snapshot = view.snapshot();
  const liveSessionPids = snapshot.live;
  const knownTerminatedSessionPids = snapshot.knownTerminated;
  const anyTrackedDelegations = snapshot.anyTrackedDelegations;
  // sid と同じ pid が走査に実在するなら撃たない: pid が使い回されて別の委譲の配下が新しいセッションを開いたか、本人がまだ生きているため。
  const scannedPids = new Set(scanned.map((entry) => entry.pid));

  const attributions = attributeSids(
    scanned,
    liveSessionPids,
    knownTerminatedSessionPids,
    deps.lineage,
  );
  deps.lineage.clear();
  for (const entry of scanned) {
    const attribution = attributions.get(entry.pid);
    if (attribution === undefined || attribution.source === 'own') continue;
    deps.lineage.set(entry.pid, { starttime: entry.starttime, sid: attribution.sid });
  }
  // 枝は引き取り手（tini）を挟む構成でだけ付ける: 挟まない構成では追跡している pid が CLI そのもので、直の子に枝の区別が無いため。
  const ownerListedSessionPids = snapshot.ownerListed;
  const abandonedOwnerListedSessionPids = snapshot.abandonedOwnerListed;
  const tiniInUse = typeof reclaim.delegationSubreaper === 'string';
  const branches = tiniInUse
    ? attributeBranches(
        scanned,
        new Set([...liveSessionPids, ...knownTerminatedSessionPids, ...ownerListedSessionPids]),
        deps.branches,
      )
    : new Map<number, Branch>();
  deps.branches.clear();
  for (const entry of scanned) {
    const branch = branches.get(entry.pid);
    if (branch !== undefined) deps.branches.set(entry.pid, { starttime: entry.starttime, branch });
  }
  const narrowToCliBranch: CliBranchNarrowing | undefined =
    tiniInUse && abandonedOwnerListedSessionPids.size > 0
      ? {
          sids: abandonedOwnerListedSessionPids,
          branchOf: (pid) => deps.branches.get(pid)?.branch,
        }
      : undefined;
  const verdictOf = (entry: ScannedProcess): ReapVerdict =>
    reapVerdictOf(
      entry,
      attributions.get(entry.pid),
      liveSessionPids,
      knownTerminatedSessionPids,
      anyTrackedDelegations,
      scannedPids,
      narrowToCliBranch,
    );
  const firesVerdict = (verdict: ReapVerdict): boolean =>
    verdict === 'fireNoDelegations' ? mode === 'reclaim' : isFireVerdict(verdict);
  const heldUnrecognisedBy = emptyUnrecognisedSplit();
  const outsideUnrecognisedBy = emptyUnrecognisedSplit();
  // 撃たずに残した abandonTree の木の引き取られた枝も「持ち主が名簿に居るので守っている」に数える（#5162）
  const ownerListedForSplit = new Set([
    ...ownerListedSessionPids,
    ...abandonedOwnerListedSessionPids,
  ]);
  const noteUnrecognised = (split: UnrecognisedOwnerSplit, entry: ScannedProcess) => {
    split[
      unrecognisedOwnerKindOf(
        entry,
        attributions.get(entry.pid),
        liveSessionPids,
        ownerListedForSplit,
      )
    ] += 1;
  };

  let candidates = 0;
  let candidateThreads = 0;
  let oldestStarttime: number | undefined;
  let largestTreeCandidates = 0;
  let singletonTrees = 0;
  const candidateStarttimes: number[] = [];
  const fireCandidates: Array<{ pid: number; starttime: number; numThreads: number }> = [];
  const held = emptyHeldCounts();
  let observeOnly = 0;

  // 除外 state のプロセスも通り抜ける: 撃てない親の下に撃てる子が居ることがあるため。
  const visited = new Set<number>();
  for (const root of roots) {
    let treeCandidates = 0;
    const queue = [root];
    for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) {
      if (visited.has(entry.pid)) continue;
      visited.add(entry.pid);

      if (entry.ownerUid === reclaim.childUid && !RECLAIM_EXCLUDED_STATES.has(entry.state)) {
        candidates += 1;
        candidateThreads += entry.numThreads;
        treeCandidates += 1;
        candidateStarttimes.push(entry.starttime);
        if (oldestStarttime === undefined || entry.starttime < oldestStarttime) {
          oldestStarttime = entry.starttime;
        }

        const verdict = verdictOf(entry);
        if (isFireVerdict(verdict)) {
          if (firesVerdict(verdict)) {
            fireCandidates.push({
              pid: entry.pid,
              starttime: entry.starttime,
              numThreads: entry.numThreads,
            });
          } else {
            observeOnly += 1;
          }
        } else {
          held[verdict] += 1;
          if (verdict === 'sidUnrecognised') noteUnrecognised(heldUnrecognisedBy, entry);
        }
      }

      for (const child of children.get(entry.pid) ?? []) {
        if (child.pid !== entry.pid) queue.push(child);
      }
    }

    if (treeCandidates > largestTreeCandidates) largestTreeCandidates = treeCandidates;
    if (treeCandidates === 1) singletonTrees += 1;
  }

  const outsideRoots = { total: 0, parentInScan: 0 };
  const outsideBySid = { ...emptyHeldCounts(), wouldFire: 0 };
  for (const entry of scanned) {
    if (visited.has(entry.pid)) continue;
    if (entry.pid === INIT_PID) continue;
    if (entry.ownerUid !== reclaim.childUid || RECLAIM_EXCLUDED_STATES.has(entry.state)) continue;
    outsideRoots.total += 1;
    if (scannedPids.has(entry.ppid)) outsideRoots.parentInScan += 1;
    const verdict = verdictOf(entry);
    if (isFireVerdict(verdict)) outsideBySid.wouldFire += 1;
    else {
      outsideBySid[verdict] += 1;
      if (verdict === 'sidUnrecognised') noteUnrecognised(outsideUnrecognisedBy, entry);
    }
  }

  const stillPresentStarttimes = new Map(scanned.map((entry) => [entry.pid, entry.starttime]));
  const fired = reconcileReaper(
    deps.reaper,
    fireCandidates,
    stillPresentStarttimes,
    nowMs,
    deps.killFn,
  );

  const observation: ReclaimObservation = {
    mode,
    ...(reclaim.delegationSubreaper === undefined
      ? {}
      : { subreaper: { command: reclaim.delegationSubreaper } }),
    candidates,
    candidateThreads,
    roots: roots.length,
    largestTreeCandidates,
    singletonTrees,
    signalled: fired.signalled,
    killed: fired.killed,
    freedThreads: fired.freedThreads,
    lastRunAt: nowMs,
    notFired: {
      outsideRoots: {
        ...outsideRoots,
        bySid: { ...outsideBySid, unrecognisedBy: outsideUnrecognisedBy },
      },
      held: { ...held, unrecognisedBy: heldUnrecognisedBy },
      ...(mode === 'observe' ? { observeOnly } : {}),
    },
  };

  if (oldestStarttime !== undefined && uptimeSeconds !== undefined) {
    const ageSeconds = Math.floor(uptimeSeconds - oldestStarttime / clockTicksPerSecond);
    if (Number.isFinite(ageSeconds)) observation.oldestAgeSec = Math.max(0, ageSeconds);
  }

  if (candidateStarttimes.length > 0 && uptimeSeconds !== undefined) {
    const ages = candidateStarttimes.map((starttime) =>
      Math.max(0, Math.floor(uptimeSeconds - starttime / clockTicksPerSecond)),
    );
    observation.medianAgeSec = medianAgeOf(ages);
    observation.ageBuckets = bucketAges(ages);
  }

  const pids = await readPidsAtScan(deps.cgroupRoot, deps.procCgroupPath);
  if (pids !== undefined) observation.pidsAtScan = pids;

  return observation;
}

// 分岐1（委譲が0本）には pid 使い回しの守りを適用しない: 生きた委譲が無く使い回しの危険が無い上、`setsid nohup` で孤立したサーバの残骸が永久に残るため。
// 分岐1は `liveSessionPids` の大きさで判定しない: `ReclaimSessionSnapshot.anyTrackedDelegations` の理由と同じ。
// 終端した委譲の sid が走査に居ない回は、呼び手（`reapVerdictOf`）が先に返す。ここへ来て `knownTerminated` に入っている sid は、走査に居るもの（`sidLeaderPresent`）だけである。
function reapVerdictFor(
  sid: number | undefined,
  liveSessionPids: ReadonlySet<number>,
  knownTerminatedSessionPids: ReadonlySet<number>,
  anyTrackedDelegations: boolean,
): 'fireNoDelegations' | keyof ReclaimHeldCounts {
  if (!anyTrackedDelegations) return 'fireNoDelegations';
  if (sid === undefined) return 'sidUnknown';
  if (liveSessionPids.has(sid)) return 'sidLive';
  if (knownTerminatedSessionPids.has(sid)) return 'sidLeaderPresent';
  return 'sidUnrecognised';
}

type ReapVerdict =
  'fireNoDelegations' | 'fireTerminated' | 'fireInherited' | 'fireLedger' | keyof ReclaimHeldCounts;

function isFireVerdict(
  verdict: ReapVerdict,
): verdict is 'fireNoDelegations' | 'fireTerminated' | 'fireInherited' | 'fireLedger' {
  return verdict.startsWith('fire');
}

interface SidAttribution {
  sid: number;
  source: 'own' | 'tree' | 'ledger';
}

// pid と starttime の組で1つのプロセスを指す: pid が別のプロセスへ使い回されても引かないため。
interface LineageEntry {
  starttime: number;
  sid: number;
}

function attributeSids(
  scanned: readonly ScannedProcess[],
  liveSessionPids: ReadonlySet<number>,
  knownTerminatedSessionPids: ReadonlySet<number>,
  lineage: ReadonlyMap<number, LineageEntry>,
): Map<number, SidAttribution> {
  const byPid = new Map(scanned.map((entry) => [entry.pid, entry]));
  const result = new Map<number, SidAttribution>();
  const settled = new Set<number>();

  const ownOf = (entry: ScannedProcess): SidAttribution | undefined =>
    entry.sid !== undefined &&
    (liveSessionPids.has(entry.sid) || knownTerminatedSessionPids.has(entry.sid))
      ? { sid: entry.sid, source: 'own' }
      : undefined;
  const ledgerOf = (entry: ScannedProcess): SidAttribution | undefined => {
    const row = lineage.get(entry.pid);
    return row !== undefined && row.starttime === entry.starttime
      ? { sid: row.sid, source: 'ledger' }
      : undefined;
  };

  for (const start of scanned) {
    if (settled.has(start.pid)) continue;
    const chain: ScannedProcess[] = [];
    const onChain = new Set<number>();
    let top: ScannedProcess | undefined = start;
    while (top !== undefined && !settled.has(top.pid) && !onChain.has(top.pid)) {
      chain.push(top);
      onChain.add(top.pid);
      const parent: ScannedProcess | undefined = byPid.get(top.ppid);
      top = parent !== undefined && parent.pid !== top.pid ? parent : undefined;
    }
    let above: SidAttribution | undefined =
      top !== undefined && settled.has(top.pid) ? result.get(top.pid) : undefined;
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const entry = chain[i] as ScannedProcess;
      const attribution =
        ownOf(entry) ??
        (above === undefined ? undefined : ({ sid: above.sid, source: 'tree' } as const)) ??
        ledgerOf(entry);
      if (attribution !== undefined) result.set(entry.pid, attribution);
      settled.add(entry.pid);
      above = attribution;
    }
  }
  return result;
}

// 引き取り手（tini）を挟む構成で、追跡している pid（tini）の木の中の子孫がどちらの枝に居たか（#5162）。
//  cli: tini の直の子のうち starttime がいちばん古いもの（tini が起こした CLI）と、その子孫。背景の Bash とその子。
//  adopted: tini の直の子のうち CLI ではないもの（親が先に終わって tini に引き取られた、切り離されたサーバー。`pg_ctl` の postmaster・`setsid -f` など）と、その子孫。
type Branch = 'cli' | 'adopted';

// pid と starttime の組で引く: pid が別のプロセスへ使い回されても引かないため。
interface BranchEntry {
  starttime: number;
  branch: Branch;
}

// 鍵の付け替えの畳み（`abandonTree`）で捨てた委譲の sid は、持ち主が名簿に居る間 CLI の枝だけを撃つ。
// 引き取られた枝と、枝の分からない子孫は撃たずに守る。理由は2つ:
//  - #5044 が撃ちたいのは畳んだ背景処理で、担当が自分で切り離して起こした長生きのサーバーではない
//  - `pg_ctl` の postmaster が、鍵の入れ替えのたびに撃たれていた（#5162）
// 手放すもの: 最後の走査より後に生まれて台帳に無い背景処理は、枝が分からないので撃たない。
// 木の丸ごとを撃つ従来の形（持ち主が名簿から消えた後・failed / lost・tini を挟まない構成）はこの絞りに掛からない。
interface CliBranchNarrowing {
  sids: ReadonlySet<number>;
  branchOf: (pid: number) => Branch | undefined;
}

function isOutsideCliBranch(
  entry: ScannedProcess,
  firingSid: number,
  narrowing: CliBranchNarrowing | undefined,
): boolean {
  return (
    narrowing !== undefined &&
    narrowing.sids.has(firingSid) &&
    narrowing.branchOf(entry.pid) !== 'cli'
  );
}

// 追跡している pid が走査に居る間だけ、その直の子から枝を決める。tini は CLI が終われば終わるので、撃つ回には居ない: 台帳（前の走査の枝）を引き継ぐ。
// 台帳の `adopted` は外さない: `pg_ctl` の postmaster は引き取られる直前まで CLI の枝の子（pg_ctl の子）に見えるため。
function attributeBranches(
  scanned: readonly ScannedProcess[],
  trackedPids: ReadonlySet<number>,
  ledger: ReadonlyMap<number, BranchEntry>,
): Map<number, Branch> {
  const byPid = new Map(scanned.map((entry) => [entry.pid, entry]));
  const childrenByPpid = childrenByPpidOf(scanned);
  const cliChildOf = new Map<number, number>();
  for (const pid of trackedPids) {
    const oldest = (childrenByPpid.get(pid) ?? [])
      .filter((child) => child.pid !== pid)
      .sort((a, b) => a.starttime - b.starttime || a.pid - b.pid)[0];
    if (oldest !== undefined) cliChildOf.set(pid, oldest.pid);
  }

  const result = new Map<number, Branch | undefined>();
  const visiting = new Set<number>();
  const ledgerBranchOf = (entry: ScannedProcess): Branch | undefined => {
    const row = ledger.get(entry.pid);
    return row !== undefined && row.starttime === entry.starttime ? row.branch : undefined;
  };
  const branchOf = (entry: ScannedProcess): Branch | undefined => {
    if (result.has(entry.pid)) return result.get(entry.pid);
    if (visiting.has(entry.pid)) return undefined;
    visiting.add(entry.pid);
    const parent = entry.ppid === entry.pid ? undefined : byPid.get(entry.ppid);
    const recorded = ledgerBranchOf(entry);
    let branch: Branch | undefined;
    if (parent !== undefined && trackedPids.has(parent.pid)) {
      branch =
        cliChildOf.get(parent.pid) === entry.pid && recorded !== 'adopted' ? 'cli' : 'adopted';
    } else {
      const parentBranch = parent === undefined ? undefined : branchOf(parent);
      branch =
        parentBranch === 'adopted' || recorded === 'adopted'
          ? 'adopted'
          : (parentBranch ?? recorded);
    }
    visiting.delete(entry.pid);
    result.set(entry.pid, branch);
    return branch;
  };

  const branches = new Map<number, Branch>();
  for (const entry of scanned) {
    const branch = branchOf(entry);
    if (branch !== undefined) branches.set(entry.pid, branch);
  }
  return branches;
}

// 終端した委譲の判定を分岐1より先に置く: 委譲が0本になった後ほど、終わった委譲の木が残りやすいため。
// 帰属を継ぐのは自分の sid が認識できないときだけ: 生きた委譲のもの・読めないものは継がない。
function reapVerdictOf(
  entry: ScannedProcess,
  attribution: SidAttribution | undefined,
  liveSessionPids: ReadonlySet<number>,
  knownTerminatedSessionPids: ReadonlySet<number>,
  anyTrackedDelegations: boolean,
  scannedPids: ReadonlySet<number>,
  narrowToCliBranch: CliBranchNarrowing | undefined,
): ReapVerdict {
  const { sid } = entry;
  if (sid !== undefined && !liveSessionPids.has(sid)) {
    if (knownTerminatedSessionPids.has(sid)) {
      if (!scannedPids.has(sid)) {
        return isOutsideCliBranch(entry, sid, narrowToCliBranch)
          ? 'sidUnrecognised'
          : 'fireTerminated';
      }
    } else if (
      attribution !== undefined &&
      attribution.source !== 'own' &&
      knownTerminatedSessionPids.has(attribution.sid) &&
      !liveSessionPids.has(attribution.sid) &&
      !scannedPids.has(attribution.sid)
    ) {
      if (isOutsideCliBranch(entry, attribution.sid, narrowToCliBranch)) return 'sidUnrecognised';
      return attribution.source === 'ledger' ? 'fireLedger' : 'fireInherited';
    }
  }
  return reapVerdictFor(sid, liveSessionPids, knownTerminatedSessionPids, anyTrackedDelegations);
}

function emptyUnrecognisedSplit(): UnrecognisedOwnerSplit {
  return { ownerLive: 0, ownerListed: 0, ownerUnknown: 0 };
}

// 数えるためだけの分類で、`reapVerdictOf` には渡さない（判定を変えない）。
// 辿る sid は `reapVerdictOf` が帰属を継ぐときと同じ（自分の sid と、先祖・台帳から継いだ sid）。live を名簿より先に見る。
function unrecognisedOwnerKindOf(
  entry: ScannedProcess,
  attribution: SidAttribution | undefined,
  liveSessionPids: ReadonlySet<number>,
  ownerListedSessionPids: ReadonlySet<number>,
): keyof UnrecognisedOwnerSplit {
  const sids = [entry.sid, attribution?.sid].filter((sid): sid is number => sid !== undefined);
  if (sids.some((sid) => liveSessionPids.has(sid))) return 'ownerLive';
  if (sids.some((sid) => ownerListedSessionPids.has(sid))) return 'ownerListed';
  return 'ownerUnknown';
}

function emptyHeldCounts(): ReclaimHeldCounts {
  return { sidUnknown: 0, sidLive: 0, sidLeaderPresent: 0, sidUnrecognised: 0 };
}

interface ReaperEntry {
  // pid だけでは同じプロセスと決まらない: starttime が違えば、pid が使い回された別のプロセスとみなす。
  starttime: number;
  sigtermAt: number;
  sigkillAt: number | undefined;
  numThreads: number;
}

// 手順の順序を入れ替えない: 先に「居ない」エントリを片付けないと、同じ回に「消えた」と「まだ発砲していない」が両立する pid が生まれるため。
function reconcileReaper(
  reaper: Map<number, ReaperEntry>,
  fireCandidates: readonly { pid: number; starttime: number; numThreads: number }[],
  stillPresentStarttimes: ReadonlyMap<number, number>,
  nowMs: number,
  killFn: (pid: number, signal: NodeJS.Signals) => void,
): { signalled: number; killed: number; freedThreads: number } {
  let freedThreads = 0;
  for (const [pid, entry] of [...reaper.entries()]) {
    if (stillPresentStarttimes.get(pid) === entry.starttime) continue;
    freedThreads += entry.numThreads;
    reaper.delete(pid);
  }

  let signalled = 0;
  for (const candidate of fireCandidates) {
    if (reaper.has(candidate.pid)) continue;
    try {
      killFn(candidate.pid, 'SIGTERM');
    } catch {
      continue;
    }
    reaper.set(candidate.pid, {
      starttime: candidate.starttime,
      sigtermAt: nowMs,
      sigkillAt: undefined,
      numThreads: candidate.numThreads,
    });
    signalled += 1;
  }

  let killed = 0;
  const fireByPid = new Map(fireCandidates.map((candidate) => [candidate.pid, candidate]));
  for (const [pid, entry] of reaper) {
    if (entry.sigkillAt !== undefined) continue;
    if (nowMs - entry.sigtermAt < DEFAULT_REAP_GRACE_MS) continue;
    if (fireByPid.get(pid)?.starttime !== entry.starttime) continue;
    try {
      killFn(pid, 'SIGKILL');
    } catch {
      continue;
    }
    entry.sigkillAt = nowMs;
    killed += 1;
  }

  return { signalled, killed, freedThreads };
}

function medianAgeOf(ages: readonly number[]): number {
  const sorted = [...ages].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted.at(mid) ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted.at(mid - 1) ?? 0;
  return Math.floor((lower + upper) / 2);
}

function bucketAges(ages: readonly number[]): Array<{ upToSec?: number; count: number }> {
  const buckets = RECLAIM_AGE_BUCKET_BOUNDARIES_SEC.map((upToSec) => ({ upToSec, count: 0 }));
  const tail: { upToSec?: number; count: number } = { count: 0 };
  for (const age of ages) {
    const bucket = buckets.find((candidate) => age < candidate.upToSec);
    if (bucket !== undefined) bucket.count += 1;
    else tail.count += 1;
  }
  return [...buckets, tail];
}

// ここで `catch` しない: 消えた（`ENOENT`）と読めなかった（`EAGAIN` 等）の区別は呼び出し側が付けるため。
async function readOwnerUid(root: string, pid: string): Promise<number | undefined> {
  return (await stat(join(root, pid))).uid;
}

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

async function readUptimeSeconds(root: string): Promise<number | undefined> {
  const raw = await readText(join(root, 'uptime'));
  if (raw === undefined) return undefined;
  const value = Number(raw.split(/\s+/)[0]);
  return Number.isFinite(value) ? value : undefined;
}

// 最後の `) ` で切ってから空白分割する: `comm` は括弧で囲まれ、中に空白や `)` を含みうるため。
async function readStat(
  root: string,
  pid: string,
  health: ScanHealth,
): Promise<
  | {
      comm: string;
      state: string;
      ppid: number;
      numThreads: number;
      starttime: number;
      sid: number | undefined;
    }
  | undefined
> {
  let raw: string;
  try {
    raw = (await readFile(join(root, pid, 'stat'), 'utf8')).trim();
  } catch (error) {
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
  const state = rest[0];
  const ppid = Number(rest[1]);
  const sidRaw = Number(rest[3]);
  const numThreads = Number(rest[17]);
  const starttime = Number(rest[19]);
  if (state === undefined || state.length === 0) return undefined;
  if (!Number.isFinite(ppid) || ppid < 0) return undefined;
  if (!Number.isFinite(numThreads) || numThreads <= 0) return undefined;
  if (!Number.isFinite(starttime) || starttime < 0) return undefined;
  // sid が壊れていてもレコード全体は捨てない: 数え上げは sid に依存せず、撃つ判定だけが `undefined` を「不明」として扱うため。
  const sid = Number.isFinite(sidRaw) && sidRaw >= 0 ? sidRaw : undefined;
  return { comm, state, ppid, numThreads, starttime, sid };
}

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

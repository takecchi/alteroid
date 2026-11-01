import { noteDroppedRecord } from './dropped-record.js';
import { notePhase } from './loop-stall.js';
import type { ManagerRecord } from './manager.js';
import {
  pruneRescueLedger,
  rescueRemovalDue,
  rescueStashRemovalDue,
  syncTerminalMark,
} from './rescue-cleanup.js';
import type { RunnerClient } from './runner-protocol.js';
import type {
  Job,
  JournalEntryInput,
  LastRescue,
  RescueRemoval,
  RescueRemovalFailureKind,
  RescueRemovalReason,
  RescueWorktree,
} from './schema.js';
import type { Stores } from './store.js';

/** 台帳の全委譲を読むので毎分は撃たない。 */
const RESCUE_SWEEP_INTERVAL_MS = 10 * 60_000;
/** HTTP の期限 60 秒の内側。 */
const RESCUE_DELETE_DEADLINE_MS = 55_000;
const RESCUE_SWEEP_MAX_DELETES = 20;
const RESCUE_SWEEP_BUDGET_MS = 5 * 60_000;
const RESCUE_REMOVAL_REASON_JOURNAL: Record<RescueRemovalReason, string> = {
  landed: '内容がもう origin の枝に入っているため',
  done: '委譲が done のまま猶予（7日）を過ぎたため',
  failed: '委譲が failed のまま猶予（14日）を過ぎたため',
  stopped: '委譲が stopped のまま猶予（14日）を過ぎたため',
};

export interface RescueSweeperDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  stores: Pick<Stores, 'jobs' | 'attachments'>;
  now: () => number;
  nowIso: () => string;
  stopped: () => boolean;
  /** `Pool#journal` を束ねたもの。 */
  journal: (entry: JournalEntryInput) => Promise<void>;
  /** `Pool#persist` を束ねたもの。 */
  persist: (record: ManagerRecord) => Promise<void>;
  /** `Pool#runnerOf` を束ねたもの。async の皮で包まない（await の回数・順を変えない）。 */
  runnerOf: (record: ManagerRecord) => Promise<RunnerClient | null>;
  /** `Pool#runnersOrEmpty` を束ねたもの。同じく async の皮で包まない。 */
  runnersOrEmpty: () => Promise<RunnerClient[]>;
}

/**
 * 退避 ref（`refs/alteroid-rescue/…`）と預かりの添付の後始末（掃除の側）。台帳（`Job.lastRescue`・`Job.rescueStash`）は
 * `ManagerRecord` の像と台帳の両方に在り、取り込みの側（`Pool#acceptRescueFiles`）と共有するのでここでは持たない。
 * 持つのは周回の重なりを防ぐ旗と前回の時刻だけ。
 */
export class RescueSweeper {
  readonly #deps: RescueSweeperDeps;
  #sweeping = false;
  #sweptAt: number | undefined;

  constructor(deps: RescueSweeperDeps) {
    this.#deps = deps;
  }

  async sweep(): Promise<void> {
    if (this.#deps.stopped() || this.#sweeping) return;
    const startedAt = this.#deps.now();
    if (this.#sweptAt !== undefined && startedAt - this.#sweptAt < RESCUE_SWEEP_INTERVAL_MS) {
      return;
    }
    this.#sweeping = true;
    try {
      let jobs: Job[];
      try {
        jobs = await this.#deps.stores.jobs.listJobs();
      } catch (error) {
        noteDroppedRecord('退避 ref の後始末', '台帳を読めなかった', error);
        return;
      }
      this.#sweptAt = startedAt;
      // 後始末の前後に印を打つ（#4485）: 退避 ref を消していた日に印の無い停止が出たので、止めていたのがこの周回かを分けるため
      notePhase(`rescue-sweep:start:${String(jobs.length)}`);
      // 1回あたりの上限（本数と時間）。GitHub 障害の初回などで削除が溜まっていても、
      // 残りは次の回へ回す。
      const budget = {
        deletesLeft: RESCUE_SWEEP_MAX_DELETES,
        until: startedAt + RESCUE_SWEEP_BUDGET_MS,
      };
      for (const job of jobs) {
        if (this.#deps.stopped() || budget.deletesLeft <= 0 || this.#deps.now() >= budget.until) {
          break;
        }
        if (job.lastRescue === undefined) continue;
        try {
          await this.#sweepOf(job.id, job, budget);
        } catch (error) {
          noteDroppedRecord('退避 ref の後始末', `managerId=${job.id}`, error);
        }
      }
    } finally {
      this.#sweeping = false;
      notePhase('rescue-sweep:done');
    }
  }

  async #sweepOf(
    managerId: string,
    listed: Job,
    budget: { deletesLeft: number; until: number },
  ): Promise<void> {
    // 生きた像が在るなら、そちらが正（書き戻しで台帳を上書きされないため）。
    const record = this.#deps.records.get(managerId);
    const job = record?.job ?? listed;
    let rescue = job.lastRescue;
    if (rescue === undefined) return;
    // 終端を初めて見た時刻を台帳に残す（猶予の起点。`rescue-cleanup.ts`）。変わらなければ書かない。
    const nowIso = this.#deps.nowIso();
    const marked = syncTerminalMark(job.status, rescue, nowIso);
    if (marked !== null) {
      const wrote = await this.#updateLedger(
        managerId,
        (current) => syncTerminalMark(job.status, current, nowIso),
        false,
        rescue,
      );
      if (!wrote) return;
      rescue = marked;
    }
    await this.#sweepStashOf(managerId, job, rescue);
    const now = this.#deps.now();
    for (const tree of rescue.worktrees) {
      if (this.#deps.stopped() || budget.deletesLeft <= 0 || this.#deps.now() >= budget.until) {
        return;
      }
      const reason = rescueRemovalDue(job.status, rescue, tree, now);
      const pushed = tree.pushed;
      if (reason === undefined || pushed === undefined) continue;
      budget.deletesLeft -= 1;
      const outcome = await this.#deleteRefVia(job, pushed);
      const at = this.#deps.nowIso();
      const attempts = outcome.ok
        ? undefined
        : (pushed.removal?.failureKind === undefined ? 0 : (pushed.removal.attempts ?? 1)) + 1;
      const removal: RescueRemoval = outcome.ok
        ? { at, reason }
        : {
            at,
            reason,
            failureKind: outcome.kind,
            ...(attempts === undefined ? {} : { attempts }),
          };
      const applied = await this.#updateLedger(managerId, (current) => {
        const index = current.worktrees.findIndex(
          (w) =>
            w.relativePath === tree.relativePath &&
            w.pushed?.commit === pushed.commit &&
            w.pushed.ref === pushed.ref,
        );
        const target = current.worktrees[index];
        if (index < 0 || target?.pushed === undefined) return null;
        const worktrees = [...current.worktrees];
        worktrees[index] = { ...target, pushed: { ...target.pushed, removal } };
        return { ...current, worktrees };
      });
      if (!applied) continue;
      // 日誌。消した回は必ず。消せなかった回は初回と分類が変わった回だけ（再試行のたびに積まない）。
      if (outcome.ok) {
        await this.#deps.journal({
          type: 'decision',
          decision: `退避 ref ${pushed.ref} を origin から消した（${RESCUE_REMOVAL_REASON_JOURNAL[reason]}）。`,
          grounds:
            `作業ツリー ${tree.relativePath}、退避 commit ${pushed.commit.slice(0, 8)}。` +
            (outcome.alreadyGone ? '消そうとしたときには既に無かった。' : '') +
            '台帳の pushed は残し、消した時刻と理由を removal に付けた。',
          routine: true,
        });
      } else if (pushed.removal?.failureKind !== outcome.kind) {
        await this.#deps.journal({
          type: 'decision',
          decision: `退避 ref ${pushed.ref} を消せなかった（${outcome.kind}）。`,
          grounds:
            `理由の分類のみ記録（${RESCUE_REMOVAL_REASON_JOURNAL[reason]}ので消そうとした）。` +
            '間隔を空けて再試行する。台帳の pushed.removal に回数が残る。',
        });
      }
    }
    // 台帳から、もう要らない作業ツリーの項目を落とす（C3）。**先に同期で評価し、変わるときだけ
    // 書く**（変わらない委譲へ10分ごとに UPDATE を打たない）。
    await this.#updateLedger(
      managerId,
      (current) => {
        const pruned = pruneRescueLedger(job.status, current, this.#deps.now());
        // 預かりが残る間は、猶予の起点（`lastRescue`）を欄ごと外さない
        // 像に居ない（`#retire` 済み）委譲は台帳から読んだ `job` で見る: 像だけを見ると、外した後に猶予の起点が消えて預かりが掃除されなくなるため
        if (
          pruned === undefined &&
          ((this.#deps.records.get(managerId)?.job ?? job).rescueStash ?? []).length > 0
        ) {
          return { ...current, worktrees: [] };
        }
        return pruned;
      },
      true,
      job.lastRescue,
    );
  }

  /** 預かりの添付を消し、欄を空にする。消せなかった添付は台帳に残し、次の周回で再試行する。 */
  async #sweepStashOf(managerId: string, job: Job, rescue: LastRescue): Promise<void> {
    const stash = job.rescueStash;
    if (stash === undefined || stash.length === 0) return;
    if (!rescueStashRemovalDue(job.status, rescue, this.#deps.now())) return;
    const removed = new Set<string>();
    for (const entry of stash) {
      try {
        await this.#deps.stores.attachments.remove(entry.attachmentId);
        removed.add(entry.attachmentId);
      } catch (error) {
        noteDroppedRecord('預かりの添付の削除', `managerId=${managerId}`, error);
      }
    }
    if (removed.size === 0) return;
    const apply = (current: Job): Job => {
      const left = (current.rescueStash ?? []).filter((e) => !removed.has(e.attachmentId));
      const next = { ...current };
      if (left.length === 0) delete next.rescueStash;
      else next.rescueStash = left;
      return next;
    };
    const record = this.#deps.records.get(managerId);
    if (record !== undefined) {
      record.job = apply(record.job);
      await this.#deps.persist(record);
    } else {
      await this.#deps.stores.jobs.updateJob(managerId, apply);
    }
    await this.#deps.journal({
      type: 'decision',
      decision: `預かっていた未追跡のファイル ${String(removed.size)} 件を消した（委譲が ${job.status} のまま猶予を過ぎた）。`,
      grounds: '退避 ref と同じ猶予（done 7日・failed/stopped 14日・lost は時間で消さない）。',
      routine: true,
    });
  }

  /**
   * 台帳の `lastRescue` を書き換える。`mutate` は同期で、`null` は「変えない」、
   * `undefined` は「欄ごと外す」（`allowRemove` のときだけ）。変えたら `true`。
   * 生きた像（`records`）が在るならそちらを書いて `persist`、無ければ台帳を
   * 排他区間の中で読み直して書く（`updateJob`）。
   */
  async #updateLedger(
    managerId: string,
    mutate: (current: LastRescue) => LastRescue | undefined | null,
    allowRemove = false,
    snapshot?: LastRescue,
  ): Promise<boolean> {
    const record = this.#deps.records.get(managerId);
    if (record !== undefined) {
      const current = record.job.lastRescue;
      if (current === undefined) return false;
      const next = mutate(current);
      if (next === null || (next === undefined && !allowRemove)) return false;
      if (next === undefined) delete record.job.lastRescue;
      else record.job.lastRescue = next;
      await this.#deps.persist(record);
      return true;
    }
    // 手元の像で「変わらない」と分かるなら、台帳を開かない（行ロック・キャッシュ無効化を避ける）。
    if (snapshot !== undefined) {
      const probe = mutate(snapshot);
      if (probe === null || (probe === undefined && !allowRemove)) return false;
    }
    let changed = false;
    await this.#deps.stores.jobs.updateJob(managerId, (current) => {
      if (current.lastRescue === undefined) return current;
      const next = mutate(current.lastRescue);
      if (next === null || (next === undefined && !allowRemove)) return current;
      changed = true;
      if (next !== undefined) return { ...current, lastRescue: next };
      const rest = { ...current };
      delete rest.lastRescue;
      return rest;
    });
    return changed;
  }

  /**
   * runner の `deleteRescueRef` で撃つ。宛先は委譲の runner、無ければ（器が入れ替わった・
   * 古い）名簿に開いている別の runner——資格は器ごとに降りているので、どれも消せる。
   * **口を持たない・答えない・投げる runner に「消した」を書かせない**（`failed` へ倒す）。
   */
  async #deleteRefVia(
    job: Job,
    pushed: NonNullable<RescueWorktree['pushed']>,
  ): Promise<{ ok: true; alreadyGone: boolean } | { ok: false; kind: RescueRemovalFailureKind }> {
    if (pushed.remote === undefined) return { ok: false, kind: 'no-remote' };
    const primary = await this.#deps.runnerOf({ job, waiting: [], attached: false });
    const open = await this.#deps.runnersOrEmpty();
    const seen = new Set<string>();
    const candidates = [primary, ...open].filter((candidate): candidate is RunnerClient => {
      if (candidate === null || candidate.deleteRescueRef === undefined) return false;
      if (seen.has(candidate.runnerId)) return false;
      seen.add(candidate.runnerId);
      return true;
    });
    if (candidates.length === 0) return { ok: false, kind: 'no-runner' };
    // 旧 runner が混在するとき（口が 404 → `other`）は次の runner へ進む。`auth` / `moved` /
    // `network` / `timeout` は他の runner でも同じ結果になるか、別の runner が消してはいけない
    // もの（lease）なので、そこで止める。
    let last: RescueRemovalFailureKind = 'no-runner';
    for (const runner of candidates) {
      try {
        const result = await runner.deleteRescueRef?.(
          { remote: pushed.remote, ref: pushed.ref, commit: pushed.commit },
          { signal: AbortSignal.timeout(RESCUE_DELETE_DEADLINE_MS) },
        );
        if (result === undefined) continue;
        if (result.outcome === 'removed') return { ok: true, alreadyGone: result.alreadyGone };
        last = result.kind;
        if (result.kind !== 'other') break;
      } catch {
        last = 'other';
      }
    }
    return { ok: false, kind: last };
  }
}

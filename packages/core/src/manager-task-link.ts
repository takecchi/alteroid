import { noteDroppedRecord, noteUnreadableRecord } from './dropped-record.js';
import { isAwaitingBackgroundHold } from './job-awaiting-background.js';
import type { Job, JobStatus, JournalEntryInput, TaskStatus } from './schema.js';
import type { Stores } from './store.js';
import { isTaskClosed, taskStatusForJob } from './task.js';
import { TASK_FOLLOW_GRACE_MS } from './task-follow-grace.js';

/**
 * `ManagerTaskLink` が `Pool` から借りるもの。**どれも読む関数**: 構築の途中で作るため、`this.#stores` などを値で受けると
 * 構築の順序に縛られる（`clone-task-intake.ts` の `CloneTaskIntakePorts` と同じ形）。
 * 口の戻りは Promise を直に返す（`(entry) => this.#journal(entry)`）: 間に `async` の関数を挟むと `await` の段が増え、呼び元の評価の時機が動く。
 */
export interface ManagerTaskLinkPorts {
  /** `Pool` の `#stores`（委譲の `getJob`・`listJobs` と、task の `get`・`list`・`setStatus` だけ読む） */
  stores(): {
    readonly jobs: Pick<Stores['jobs'], 'getJob' | 'listJobs'>;
    readonly tasks: Pick<Stores['tasks'], 'get' | 'list' | 'setStatus'>;
  };
  /** `Pool` の `#journal` */
  journal(entry: JournalEntryInput): Promise<void>;
  /** `Pool` の `#now`（器の時計を直に読まない。時計を渡せないと猶予の試験が書けない） */
  now(): number;
  /** `Pool` の `#nowIso` */
  nowIso(): string;
}

/** `Pool` の `ManagerRecord` のうち、ここが読み書きする部分（`job` だけ）。 */
export interface LinkedRecord {
  readonly job: Job;
}

/**
 * 委譲（`Job`）の状態を、結び付いた task（`Job.taskId`）へ写す協力者（#5469 P3）。`Pool` から切り出した（動きは変えていない）。
 * 状態は持たない: 台帳（`jobs`）と task ストアを読んで決める。呼び元は `Pool#persist`（`readBefore`・`stampEndedAt`・`sync`）、
 * `Pool#restore`・公開の `repairStrandedTasks()`（`repairStranded`）。
 * メソッドは元と同じ `async`／同期のまま移した（呼び元の `await` の段を増やさない）。
 * `readBefore` だけは `async` にせず Promise を直に返す: 元は `#persist` の中の `await getJob().then(...)` で、間に `async` の関数を挟むと段が増える。
 */
export class ManagerTaskLink {
  readonly #ports: ManagerTaskLinkPorts;

  constructor(ports: ManagerTaskLinkPorts) {
    this.#ports = ports;
  }

  /**
   * task へ写すのに、書く前の台帳の状態が要る（結び付いた委譲だけ読む。呼び元が `taskId` の有無を見て呼ぶ）。読めなければ `undefined`。
   * 背景処理の完了待ちで閉じた `done`（保留の上限の内）は、台帳の上では `running` の続きとして読む: 保留中の委譲が終端へ入る書き込み
   * （背景待ちでない報告・`closed`）で task を倒し、`running` へ動く書き込みでは task を動かさない。
   */
  readBefore(record: LinkedRecord, linkedTaskId: string): Promise<JobStatus | null | undefined> {
    return this.#ports
      .stores()
      .jobs.getJob(record.job.id)
      .then(
        (stored) =>
          stored === null
            ? null
            : isAwaitingBackgroundHold(stored, this.#ports.now())
              ? 'running'
              : stored.status,
        (error: unknown) => {
          // 読めないと task の同期と endedAt を見送る。起動時の直しも endedAt が無いと見送るので、跡が無いと後から追えない
          noteUnreadableRecord(
            '委譲の書く前の状態',
            `job id=${record.job.id} task=${linkedTaskId} status=${record.job.status}。task の同期と endedAt を見送った`,
            error,
          );
          return undefined;
        },
      );
  }

  /** 終端へ入った時刻を1回だけ書く（起動時の直しの基準。終わった後の書き込みでは進めない）。動き出したら消す。読めなかった回（`before` が `undefined`）は触れない。 */
  stampEndedAt(record: LinkedRecord, before: JobStatus | null | undefined): void {
    if (record.job.taskId !== undefined && before !== undefined) {
      const wasActive = before !== null && taskStatusForJob(before) === 'waiting';
      // 背景待ちの保留中の `done` は終端へ入ったと数えない: `endedAt` を書くと、見回りが保留を無視して task を倒す
      if (
        taskStatusForJob(record.job.status) === 'waiting' ||
        isAwaitingBackgroundHold(record.job, this.#ports.now())
      ) {
        if (!wasActive) delete record.job.endedAt;
      } else if (before === null || wasActive) {
        record.job.endedAt = this.#ports.nowIso();
      }
    }
  }

  /**
   * 委譲の状態を、結び付いた task（`Job.taskId`）へ写す（#5469 P3）。**状態を持たない規則**で、台帳に書く前の委譲の状態（`before`）と task の今の状態だけで決める:
   * - 動き出す（台帳に無かった／終わっていた委譲が `running` へ入る: 起こした直後・resume）: 閉じていない task を `waiting` にする
   * - 終わる（動いていた／台帳に無かった委譲が failed / lost / stopped / closed(done)＝セッションが畳まれた へ入る）: `waiting` の task だけを即時に `needs_decision` にする。クローンが `queued` へ戻した task や、閉じた task には触れない
   * - 報告由来の done（ターンの終わり。`sessionClosed` が偽）: task を動かさない（`endedAt` は `stampEndedAt` が書く）。idle・背景待ち・完了を区別できず、即時に倒すと
   *   `manager_send` のたびに `waiting` と `needs_decision` を往復するため。猶予（`TASK_FOLLOW_GRACE_MS`）を過ぎて静かなままなら `repairStranded`（見回り）が倒す
   * 動いている最中の書き込み（報告・確認要求など）と、終わった後の書き込みでは何もしない。クローンが動かした task を、委譲の次の書き込みで戻さないため。
   * 書き込みの1本の口（`Pool#persist`）に置く: 委譲の状態を変える経路は多く、個別に呼ぶと1つ漏れた経路の task だけが動かない。
   * best-effort: task が書けなくても委譲と台帳は止めない。失敗は日誌へ残し、終わった委譲に結び付いたまま `waiting` の task は
   * 次の起動で `repairStranded` が直す。
   * `before` が `undefined` のとき（直前の状態を読めなかった）は動き出しの側を見送る: 読めないまま task を `waiting` に戻すと、クローンの動かした状態を潰しうる。
   */
  async sync(
    record: LinkedRecord,
    before: JobStatus | null | undefined,
    sessionClosed: boolean,
  ): Promise<void> {
    const taskId = record.job.taskId;
    if (taskId === undefined) return;
    const target = taskStatusForJob(record.job.status);
    if (target === 'waiting') {
      const entering =
        before === null || (before !== undefined && taskStatusForJob(before) !== 'waiting');
      if (!entering) return;
    } else {
      // 終わる側も、動いていた（または台帳に無かった）委譲が終端へ入る書き込みだけで動かす。終わった後の書き込み
      // （2度目の報告・restore の引き取り・預かりの掃除など）では、クローンが置いた `waiting` を倒さない。読めなかった回は見送る
      const ending =
        before === null || (before !== undefined && taskStatusForJob(before) === 'waiting');
      if (!ending) return;
      // 報告由来の `done` は task を倒さず、猶予を過ぎた見回りに任せる。背景処理の完了待ちで閉じた `done`（委譲がまだ生きている。
      // runner が自分で起き直し、台帳は知らない）もここに含まれる。保留の上限（6 時間）は見回りの側（`isAwaitingBackgroundHold`）が持つ
      if (record.job.status === 'done' && !sessionClosed) return;
    }
    try {
      const task = await this.#ports.stores().tasks.get(taskId);
      // 閉じた task は動かさない（`planTaskTransition` も拒むが、日誌を汚さない）。見つからない task は、書けない相手なので追わない
      if (task === null || isTaskClosed(task.status)) return;
      if (target === 'needs_decision') {
        if (task.status !== 'waiting') return;
        // 同じ task に走っている別の委譲が台帳に居れば動かさない: resume で、終わった委譲が同じ task の別の委譲と同時に走ることがある
        // （入口の断りは `manager_start` だけで、`manager_send` や枠の自動の起こし直しは止めない）
        const others = await this.#ports.stores().jobs.listJobs();
        if (
          others.some(
            (job) =>
              job.id !== record.job.id &&
              job.taskId === taskId &&
              taskStatusForJob(job.status) === 'waiting',
          )
        ) {
          return;
        }
      }
      await this.#moveTask(taskId, target, record.job.id, `委譲が ${record.job.status}`);
    } catch (error) {
      noteDroppedRecord(
        'task の状態の追従',
        `job id=${record.job.id} task=${taskId} status=${record.job.status}`,
        error,
      );
      await this.#ports.journal({
        type: 'decision',
        decision: `[${record.job.id}] task ${taskId} の状態を委譲（${record.job.status}）に合わせられなかった`,
        grounds:
          '委譲は止めない。終わった委譲に結び付いたまま waiting の task は、次の起動で needs_decision へ直す（#5469 P3）',
      });
    }
  }

  /** task を `by: 'daemon'` で動かし、動いたときだけ遷移を日誌へ残す。投げるのは task ストアの失敗だけ。 */
  async #moveTask(taskId: string, to: TaskStatus, jobId: string, why: string): Promise<void> {
    const result = await this.#ports.stores().tasks.setStatus(taskId, to, {
      by: 'daemon',
      at: this.#ports.nowIso(),
    });
    if (result.kind !== 'changed') return;
    await this.#ports.journal({
      type: 'decision',
      target: { kind: 'task', id: taskId },
      decision: `[${jobId}] task ${taskId} を ${result.before.status} から ${to} にした（${why}）`,
      grounds: '委譲の状態に結び付いた task を追わせる（#5469 P3）',
    });
  }

  /**
   * 終わった委譲にしか結び付いていないのに `waiting` のままの task を `needs_decision` へ直す（#5469 P3）。
   * 終端の同期に失敗した、または同期の前にデーモンが落ちた task が戻れなくなるのを防ぐ。さらに、報告由来の `done`（ターンの終わり）で
   * `sync` が見送った task を、猶予を過ぎてから倒す本体でもある。`Pool#restore()` が呼ばれるたび（起動のほか、takeOver・トークンの回復）と、
   * 見回りの 8 段目（`repairStrandedTasks()`。60 秒ごと）から走るので、何度走っても同じ結果になるよう書いてある。
   * 猶予（`TASK_FOLLOW_GRACE_MS`）: 最後に終端へ入った委譲が `done` なら、その `endedAt` から猶予を過ぎるまで直さない
   * （`manager_send` が間に合えば `running` へ戻って task は動かない）。`failed`・`lost`・`stopped` は猶予 0。
   * `done` の中の `closed(done)`（セッションが畳まれた）は台帳の上で報告由来と見分けられないので、ここでは猶予を掛ける: 即時に倒すのは
   * `sync` の側で済んでいて、ここへ来るのは同期が落ちた回だけ（猶予のぶん遅れて直るだけで、害は無い）。
   * 走っている委譲が1本でも結び付いていれば直さない。結び付いた委譲のうち最後に終端へ入ったもの（`Job.endedAt` が最も新しい）より後に
   * task が更新されていれば、クローンが置いた `waiting`（`task_set_status`）なので直さない。
   * `updatedAt` は使わない: 終わった後の書き込みでも進むので、基準にすると呼ばれるたびに判定が狂う。
   * 背景処理の完了待ちで閉じた `done`（`Job.awaitingBackgroundSince` が立っていて、上限 `AWAITING_BACKGROUND_HOLD_LIMIT_MS` の内）が1本でも結び付いていれば、走っている委譲と同じく直さない。
   * 結び付いた終端の委譲に `endedAt` が無い・読めない行が1つでもある task は、並び順によらず見送る（クローンの置いた状態を潰す側へ倒さない）。
   * 読めない・書けないときは見送って stderr に残す（次に呼ばれたときにもう一度見る）。
   */
  async repairStranded(): Promise<void> {
    try {
      const active = new Set<string>();
      const skip = new Set<string>();
      const lastFinished = new Map<string, { id: string; at: number; graceMs: number }>();
      const nowMs = this.#ports.now();
      for (const job of await this.#ports.stores().jobs.listJobs()) {
        if (job.taskId === undefined) continue;
        if (taskStatusForJob(job.status) === 'waiting' || isAwaitingBackgroundHold(job, nowMs)) {
          active.add(job.taskId);
          continue;
        }
        // 背景待ちの保留に入った `done` は `endedAt` を書かない。上限を過ぎて保留が切れた行は、印の時刻を終端の時刻として読む
        const endedAt = job.endedAt ?? job.awaitingBackgroundSince;
        const at = endedAt === undefined ? Number.NaN : Date.parse(endedAt);
        if (Number.isNaN(at)) {
          skip.add(job.taskId);
          continue;
        }
        const graceMs = job.status === 'done' ? TASK_FOLLOW_GRACE_MS : 0;
        const seen = lastFinished.get(job.taskId);
        // 終端の時刻が同じなら猶予の短い側を採る（即時の終端を、同時刻の `done` の猶予に待たせない）
        if (seen === undefined || at > seen.at) {
          lastFinished.set(job.taskId, { id: job.id, at, graceMs });
        }
      }
      if (lastFinished.size === 0) return;
      for (const task of (await this.#ports.stores().tasks.list()).entries) {
        const last = lastFinished.get(task.id);
        if (last === undefined || skip.has(task.id) || active.has(task.id)) continue;
        if (task.status !== 'waiting') continue;
        if (nowMs - last.at < last.graceMs) continue;
        const taskAt = Date.parse(task.updatedAt);
        if (Number.isNaN(taskAt) || taskAt > last.at) continue;
        await this.#moveTask(
          task.id,
          'needs_decision',
          last.id,
          '終わった委譲に結び付いたまま waiting だった（見回り・起動時の直し）',
        );
      }
    } catch (error) {
      noteDroppedRecord('終わった委譲の task の直し', '', error);
    }
  }
}

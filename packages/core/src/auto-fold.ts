import { noteDroppedRecord, reasonOf } from './dropped-record.js';
import type {
  AutoFoldOutcome,
  ManagerAbortResult,
  ManagerStopActor,
  ManagerSummary,
} from './manager.js';
import {
  classifyAutoFoldUnpushedWorkProbe,
  describeAutoFoldUnpushedWorkProbe,
  evaluateAutoFoldUnpushedWork,
  isPidsUnderPressure,
} from './manager-auto-fold.js';
import { classifyManagerActivity } from './manager-activity.js';
import { isManagerFoldCandidate } from './manager-fold-candidate.js';
import { RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL } from './runner-protocol.js';
import type { RunnerRegistry } from './runner-protocol.js';
import type { Job, JournalEntryInput } from './schema.js';
import type { ManagerUnpushedWork } from './unpushed-work-observation.js';

/** 実測の根拠は無い（「大きく、無限ではない」だけ）。 */
const AUTO_FOLD_SKIP_JOURNAL_TRACKING_LIMIT = 500;

/**
 * 周回の見回り（60 秒ごと）から呼ばれる自動の畳みを間引く間隔（#5157）。
 * 毎分見ない理由は2つ: (1) 自動の畳みは「手が空いて6時間」の担当しか畳まないので、毎分見ても畳める担当はほぼ増えない。
 * (2) 各 runner へ資源を問い合わせる往復（最大 5 秒 × 台数）を毎分払いたくない。
 */
const AUTO_FOLD_PERIODIC_INTERVAL_MS = 30 * 60_000;

/**
 * **FIFO であって LRU ではない**（既存の鍵への再 `set` は挿入順を動かさない）。
 * `runner-subagent-stop-state.ts` の同名の関数とは共有しない: 同じ形の枝刈りが独立して複数在ってよい。
 */
function pruneOldestEntries<V>(map: Map<string, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

type PidsReading = { readonly current: number; readonly max: number };

export interface AutoFoldDeps {
  runners: RunnerRegistry;
  now: () => number;
  stopped: () => boolean;
  /** 畳まない担当（起こし直す担当・預かりのある担当）。呼ぶたびに読み直す: 起こし直しの前の await で増減するため。 */
  retainedIds: () => Iterable<string>;
  runnerHasCapability: (runnerId: string, capability: string) => boolean;
  findJob: (managerId: string) => Promise<Job | undefined>;
  runnerIdOf: (managerId: string) => Promise<string | undefined>;
  list: () => Promise<ManagerSummary[]>;
  /** 未 push の観測。呼び出し元（`Pool`）が `source: 'auto-fold'` と期限の signal を付ける。 */
  observeUnpushedWork: (managerId: string) => Promise<ManagerUnpushedWork>;
  abort: (managerId: string, reason: string, by: ManagerStopActor) => Promise<ManagerAbortResult>;
  journal: (entry: JournalEntryInput) => Promise<void>;
}

/**
 * 器の資源（pids）が逼迫したとき、done の委譲を自動で畳む実行側。判定は `manager-auto-fold.ts`（判定だけで実行しない）が持つ。
 * 日誌・畳み（`abort`）・未 push の観測は `Pool` の機能なので口で受ける。
 */
export class AutoFold {
  readonly #deps: AutoFoldDeps;
  /**
   * `JournalFoldWindow`（時間窓）は使わない: 契機の間隔に保証が無く、時間窓に意味のある長さを与えられない。
   * **`Job.updatedAt` ではなく `lastReportAt` を使う**: 安全弁自身が呼ぶ `unpushedWork()` → `#persist()` が
   * `updatedAt` を進めるので、2回目の評価で必ず「変わった」と誤判定する。
   */
  readonly #skipJournalWritten = new Map<
    string,
    { readonly lastReportAt: string | undefined; readonly reasonKey: string }
  >();
  /**
   * `runnerId` 単位にしない: 同じ runner 上の別の候補まで待たせ、無関係な委譲の畳みが遅れる。
   * 重なった回は黙って飛ばし（`'skipped-concurrent'`）、日誌は積まない: 状態が読めないのではなく他方が判定中なだけで、
   * 「畳まない側へ倒す」理由には数えない。
   * `#foldOne` の「競合の再確認」は判定から `abort()` までの間しか見ておらず、並行する2実行は塞げない。
   */
  readonly #inFlight = new Set<string>();
  #periodicRunning = false;
  #periodicAt: number | undefined;

  constructor(deps: AutoFoldDeps) {
    this.#deps = deps;
  }

  /** `#retire()` から: 終えた担当の見送りの控えを残さない。 */
  forget(managerId: string): void {
    this.#skipJournalWritten.delete(managerId);
  }

  /**
   * 自動の畳み（idle な委譲を畳んで pids を空ける）を掛ける逼迫か（#5113）。
   * 瞬間値の割合（{@link isPidsUnderPressure}）だけでは足りない: 委譲の作業は山で pids を使うので、瞬間値は低くても山で fork が断られる。
   * 2026-10-20 の runner-primary は 443/1000（44%）なのに、fork の拒否 31〜68 回で3本が落ち、割合の門（80%）を一度も越えずに畳みが動かなかった。
   * 窓の内側に fork の拒否・EAGAIN の印（`pidsSaturationOf`）があれば、瞬間値によらず逼迫として扱う。
   */
  #runnerUnderPidsPressure(runnerId: string, pids: PidsReading): boolean {
    if (isPidsUnderPressure(pids)) return true;
    return this.#deps.runners.pidsSaturationOf?.(runnerId, pids) !== undefined;
  }

  /**
   * 逼迫していなければ `managers` を1回も読まず `undefined` を返す。`undefined`（見ていない）と `[]`（見たが0件）を区別する。
   * 呼び出し元（`runners()` と `onPlacementPressure`）の判定・実行はここ1つで共有し、2つに増やさない。
   */
  async foldIdleOnRunnerIfUnderPressure(
    runnerId: string,
    pids: PidsReading,
    managers: readonly ManagerSummary[],
  ): Promise<AutoFoldOutcome[] | undefined> {
    if (!this.#runnerUnderPidsPressure(runnerId, pids)) return undefined;

    const now = new Date(this.#deps.now());
    const capabilityConfirmed = this.#deps.runnerHasCapability(
      runnerId,
      RUNNER_CAPABILITY_AWAITING_BACKGROUND_SIGNAL,
    );
    const outcomes: AutoFoldOutcome[] = [];
    for (const manager of managers) {
      if (manager.runnerId !== runnerId) continue;
      const isCandidate = isManagerFoldCandidate(
        {
          status: manager.status,
          hasAwaitingBackgroundSignal: manager.awaitingBackground !== undefined,
          awaitingBackgroundSignalVersionConfirmed: capabilityConfirmed,
          hasHeldMessages: manager.heldMessages !== undefined,
          // `managerActivityInputOf`（`tools.ts`）と同じ field 選択を import せずここでも行う: 循環 import を避けるため。
          activityKind: classifyManagerActivity({
            turnEndReason: manager.turnEndReason,
            turnEndedAt: manager.turnEndedAt,
            lastReportAt: manager.lastReportAt,
            toolUseStallPending: manager.toolUseStallPending,
            waitingCount: manager.waiting.length,
          }),
          lastTurnEndedAt: manager.updatedAt,
        },
        now,
      );
      if (!isCandidate) continue;
      outcomes.push(await this.#foldOne(manager.managerId, runnerId, pids, manager.lastReportAt));
    }
    return outcomes;
  }

  /**
   * 0. **同じ委譲の二重実行の壁。** 2つの契機（`runner_list resources:true` /
   *    `manager_start` の自動配置）が同じ委譲を同時に候補として拾うと、
   *    ここが並行に2回走りうる——1の「競合の再確認」は判定してからここに
   *    来るまでの窓しか見ておらず、**同時に2つの実行が両方ともその窓を
   *    通り抜ける**形までは塞がない。だから最初（どの `await` より前）に
   *    `#inFlight` を確認・設置する（`#inFlight` の doc）。
   *    既に入っていれば `'skipped-concurrent'` で即座に戻り、日誌には残さない
   *    ——「判定できない」ではなく「他方が処理中」なので、未pushの安全弁と
   *    同じ理由の見送りには数えない。
   * 1. **競合の再確認。** 候補と判定してからここに来るまでの間（同じ呼び出し
   *    内の他の委譲の await を挟む）に、誰か・何かが先にこの委譲へ触れて
   *    `status` が `done` でなくなっているかもしれない。読み直して違って
   *    いたら、安全側に倒して何もしない（`'raced'`）。
   * 2. **未 push の安全弁**（`evaluateAutoFoldUnpushedWork`）。`'blocked'` なら
   *    畳まず、日誌に見送った理由を残す。**ただし同じ委譲・同じ理由の見送りを
   *    繰り返し書かない**（`candidateLastReportAt` の doc）。
   *
   * @param candidateLastReportAt 呼び出し元（段⑤の候補判定）が読んだ時点の
   *   `ManagerSummary.lastReportAt`。**`fresh.updatedAt`（`Job.updatedAt`）
   *   ではなくこちらを「委譲が新しいターンを回したか」の鍵にする。** 理由は
   *   実測——`unpushedWork()` は呼ぶたびに `#recordUnpushedWorkObservation` →
   *   `#persist()` を経由し、`#persist()` は無条件に `record.job.updatedAt` を
   *   「いま」へ進める（`#persist` の doc）。**この安全弁自身がすぐ下で
   *   `unpushedWork()` を呼ぶので、`Job.updatedAt` は「新しいターンを回したか」
   *   ではなく「直前にこの安全弁を評価したか」を表してしまい、鍵として使うと
   *   毎回「変わった」と誤判定して重複除去が機能しない**（実測: 同じ委譲へ
   *   `runners({resources:true})` を続けて2回呼ぶだけで `Job.updatedAt` が
   *   動き、かつ経過時間の起点も一緒に動くので段⑤の候補判定自体が2回目には
   *   落ちる——`manager.test.ts` の変異観測で見つかった）。**`lastReportAt`
   *   は `case 'report'`（本物の新しいターン）でしか書き換わらない**
   *   （書き込み箇所は1つだけ。`grep -Fn -- 'record.job.lastReportAt = new Date' packages/core/src/manager.ts`）
   *   ので、この安全弁の実行そのものには汚染されない。
   */
  async #foldOne(
    managerId: string,
    runnerId: string,
    pids: PidsReading,
    candidateLastReportAt: string | undefined,
  ): Promise<AutoFoldOutcome> {
    const pidsNote = `pids ${String(pids.current)}/${String(pids.max)}`;

    // 鍵の確認と設置の間に `await` を挟まない: 挟むと二重実行の壁にならない。
    if (this.#inFlight.has(managerId)) {
      return {
        managerId,
        runnerId,
        outcome: 'skipped-concurrent',
        detail:
          'この委譲は、もう一方の契機（runner_list resources:true / manager_start の自動配置 / 周回の見回り）が' +
          '同時に処理中だったので、この回は見送った（二重に abort() を呼ばないため。' +
          '判定できなかったわけではない）。',
      };
    }
    this.#inFlight.add(managerId);
    try {
      const fresh = await this.#deps.findJob(managerId);
      if (fresh === undefined || fresh.status !== 'done') {
        return {
          managerId,
          runnerId,
          outcome: 'raced',
          detail: `候補と判定した後、実際に畳む前に状態を読み直したら done ではなくなっていた（${
            fresh === undefined ? '台帳から消えている' : `いまは ${fresh.status}`
          }）。安全側に倒して何もしなかった。`,
        };
      }

      const unpushed = await this.#deps
        .observeUnpushedWork(managerId)
        .catch((error: unknown): ManagerUnpushedWork => ({
          kind: 'unavailable',
          reason: `確かめようとして例外が飛んだ: ${reasonOf(error)}`,
        }));
      const verdict = evaluateAutoFoldUnpushedWork(unpushed);
      if (verdict !== 'clear') {
        const reason = describeAutoFoldUnpushedWorkProbe(unpushed);
        // 同じ委譲・同じ理由の見送りを日誌へ積み続けない。鍵に表示用の `reason` 本文は使わない: 文言だけ直っても別の理由と誤読するため。
        const reasonKey = classifyAutoFoldUnpushedWorkProbe(unpushed);
        const memoKey = { lastReportAt: candidateLastReportAt, reasonKey };
        const previous = this.#skipJournalWritten.get(managerId);
        const unchanged =
          previous !== undefined &&
          previous.lastReportAt === memoKey.lastReportAt &&
          previous.reasonKey === memoKey.reasonKey;
        if (!unchanged) {
          await this.#deps.journal({
            type: 'decision',
            decision:
              `[auto-fold-skip] ${managerId} は pids 逼迫（runner=${runnerId}、${pidsNote}）で` +
              `畳む候補だったが、畳まなかった: ${reason}。`,
            grounds: 'デーモンの自動畳み（Issue #1394 段④⑥）: 未pushの安全弁が clear ではなかった',
          });
          this.#skipJournalWritten.set(managerId, memoKey);
          pruneOldestEntries(this.#skipJournalWritten, AUTO_FOLD_SKIP_JOURNAL_TRACKING_LIMIT);
        }
        return {
          managerId,
          runnerId,
          outcome: 'blocked-unpushed-work',
          detail: reason,
        };
      }

      await this.#deps.journal({
        type: 'decision',
        decision:
          `[auto-fold] ${managerId} を pids 逼迫（runner=${runnerId}、${pidsNote}）を理由に自動で畳む` +
          '（手が空いている・背景処理待ちの印なし・未pushの作業なし、のすべてを満たした）。',
        grounds:
          'デーモンの自動畳み（Issue #1394 段④⑥⑦）: pids の逼迫（上限の80%以上か、窓の内に fork の拒否・EAGAIN の印。#5113）・' +
          '段⑤の畳む候補の5条件・未push安全弁のすべてを満たした',
      });

      const result = await this.#deps.abort(
        managerId,
        `pids 逼迫（${pidsNote}）を受けてデーモンが自動で畳んだ`,
        'auto-fold',
      );
      return {
        managerId,
        runnerId,
        outcome:
          result.outcome === 'stopped'
            ? 'folded'
            : result.outcome === 'not_stopped'
              ? 'not-stopped'
              : 'unknown',
        detail: result.detail,
      };
    } finally {
      this.#inFlight.delete(managerId);
    }
  }

  /**
   * 門をここでも先に通す: 逼迫していない大半の回で `list()` の読み取りを払わないため。
   * 戻り値を待たない: 配置（`#place`）の応答を畳み終わるまで待たせないため。再試行はしない。
   */
  onPlacementPressure(runnerId: string, pids: PidsReading): void {
    if (!this.#runnerUnderPidsPressure(runnerId, pids)) return;
    void this.#deps
      .list()
      .then((managers) => this.foldIdleOnRunnerIfUnderPressure(runnerId, pids, managers))
      .catch((error: unknown) => {
        void this.#deps.journal({
          type: 'decision',
          decision:
            `[auto-fold-skip] runner=${runnerId} の配置契機（manager_start の自動配置）で` +
            `畳み処理そのものが例外で落ち、判定できなかった: ${reasonOf(error)}`,
          grounds:
            'デーモンの自動畳み（Issue #1394 の2つ目の契機。manager_start の配置経由）: ' +
            '例外により判定不能（判定できないときは畳まない側へ倒す）',
        });
      });
  }

  async underPressure(): Promise<void> {
    if (this.#deps.stopped() || this.#periodicRunning) return;
    const startedAt = this.#deps.now();
    if (
      this.#periodicAt !== undefined &&
      startedAt - this.#periodicAt < AUTO_FOLD_PERIODIC_INTERVAL_MS
    ) {
      return;
    }
    this.#periodicRunning = true;
    this.#periodicAt = startedAt;
    try {
      const open = await this.#deps.runners.list().catch((error: unknown) => {
        noteDroppedRecord('周回の自動の畳み', 'runner の一覧を読めなかった', error);
        return [];
      });
      // 逼迫した器が見つかるまで台帳を読まない: 逼迫していない大半の回で `list()` を払わないため。
      let managers: readonly ManagerSummary[] | undefined;
      for (const runner of open) {
        if (this.#deps.stopped()) return;
        const runnerId = runner.runnerId;
        try {
          const resources = await runner.resources?.({ signal: AbortSignal.timeout(5_000) });
          const pids = resources?.pids;
          if (pids === undefined) continue;
          if (!this.#runnerUnderPidsPressure(runnerId, pids)) continue;
          managers ??= await this.#deps.list();
          const outcomes = await this.foldIdleOnRunnerIfUnderPressure(runnerId, pids, managers);
          if (outcomes === undefined || outcomes.length === 0) continue;
          await this.#deps.journal({
            type: 'decision',
            decision:
              `[auto-fold] 周回の見回りで、pids が逼迫した runner=${runnerId}` +
              `（pids ${String(pids.current)}/${String(pids.max)}）の畳む候補を見た: ` +
              `畳んだ ${String(outcomes.filter((o) => o.outcome === 'folded').length)} 本・候補 ${String(outcomes.length)} 本`,
            grounds:
              'runner_list・配置・鍵の回転のどの契機も来ない間に器が飽和しても畳めるようにする（#5157）。' +
              '条件は他の契機と同じ（手が空いて6時間・背景処理待ちの印なし・未 push の作業なし）',
            routine: true,
          });
        } catch (error) {
          noteDroppedRecord('周回の自動の畳み', `runner=${runnerId}`, error);
        }
      }
    } finally {
      this.#periodicRunning = false;
    }
  }

  /**
   * 鍵の回転で起こし直す前に、起こし直す先の器が pids で飽和していれば（窓の内に fork の拒否・EAGAIN の印）、その器の畳む候補を先に畳んで空ける（#5113）。
   * 起こし直しは配置を通らず元の器へ戻るので、空けないと飽和した器へ一斉に戻ってまた fork が断られる
   * （2026-10-20 の runner-primary は委譲 143 本・fork の拒否 31〜68 回で3本が落ちた）。
   * 畳むのは自動の畳みと同じ候補だけ（手が空いて6時間・背景処理待ちの印なし・未 push の作業なし）で、起こし直す担当と預かりのある担当は渡さない。
   * 起こす本数は絞らない（north_star 禁止2）。失敗しても起こし直しは止めない。
   */
  async beforeWakes(wakeIds: readonly string[]): Promise<void> {
    const runnerIds = new Set<string>();
    for (const managerId of wakeIds) {
      // 像に無い（failed・lost で外れた）担当も台帳まで降りて器を引く: 起こし直す担当の多くはそれ
      const runnerId = await this.#deps.runnerIdOf(managerId).catch(() => undefined);
      if (runnerId !== undefined && this.#deps.runners.pidsSaturationOf?.(runnerId) !== undefined) {
        runnerIds.add(runnerId);
      }
    }
    if (runnerIds.size === 0) return;
    const keep = new Set([...wakeIds, ...this.#deps.retainedIds()]);
    try {
      const managers = (await this.#deps.list()).filter((manager) => !keep.has(manager.managerId));
      for (const runnerId of runnerIds) {
        if (this.#deps.stopped()) return;
        const runner = await this.#deps.runners.get(runnerId);
        const resources = await runner?.resources?.({ signal: AbortSignal.timeout(5_000) });
        if (resources?.pids === undefined) continue;
        const outcomes = await this.foldIdleOnRunnerIfUnderPressure(
          runnerId,
          resources.pids,
          managers,
        );
        await this.#deps.journal({
          type: 'decision',
          decision:
            `[auto-fold] 鍵の回転で起こし直す前に、pids が飽和した runner=${runnerId}` +
            `（pids ${String(resources.pids.current)}/${String(resources.pids.max)}）の畳む候補を見た: ` +
            `畳んだ ${String((outcomes ?? []).filter((o) => o.outcome === 'folded').length)} 本・候補 ${String((outcomes ?? []).length)} 本`,
          grounds:
            '起こし直しは配置を通らず元の器へ戻るので、飽和した器を先に空ける（#5113）。' +
            '起こし直す担当・預かりのある担当は畳まない',
          routine: true,
        });
      }
    } catch (error) {
      noteDroppedRecord('起こし直しの前の自動の畳み', `runners=${[...runnerIds].join(',')}`, error);
    }
  }
}

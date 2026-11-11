import { noteResumeAfterStopFoldFailed, reasonOf } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX, EXCHANGE_KIND_RECOVERY_PREFIX } from './exchange-kind.js';
import {
  LEASE_TTL_MS,
  describeAmbiguousSighting,
  describeVerdict,
  grantLease,
  mayClaim,
  touchLease,
  type LeaseSighting,
} from './lease.js';
import type { LeaseRefusalKind, ManagerRecord, ResumeOutcome } from './manager.js';
import { judgeClaimAgainst } from './runner-roster.js';
import {
  listRunnerManagers,
  RunnerHttpError,
  type RunnerAttachment,
  type RunnerClient,
  type RunnerRegistry,
} from './runner-protocol.js';
import type { JournalEntryInput } from './schema.js';
import type { SessionLoaders } from './session-loaders.js';
import type { Stores } from './store.js';
import {
  workspaceAfterRelocation,
  workspaceLocatorFrom,
  type WorkspacePolicy,
} from './workspace-policy.js';

interface ManagerResumeDeps {
  stores: Pick<Stores, 'jobs' | 'sessionStore'>;
  runners: Pick<RunnerRegistry, 'entries'>;
  sessionLoaders: SessionLoaders;
  /** `Pool#restored`（`RestoredWindows`）の `begin` / `end` を、呼ぶ時点で引く形で束ねたもの。 */
  restored: {
    begin: (managerId: string, runnerId: string) => void;
    end: (managerId: string) => void;
  };
  /** `Pool#workspace` を、呼ぶ時点で引く形で束ねたもの。 */
  workspace: () => WorkspacePolicy;
  now: () => number;
  journal: (entry: JournalEntryInput) => Promise<void>;
  /** `Pool#journalExchange` を `bind` したもの（`async` にしない: `await` / `void` の呼び出し側のタイミングを変えない）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  postReport: (managerId: string, text: string) => void;
  assignToken: (
    record: ManagerRecord,
    prior: string | undefined,
    container: string | undefined,
  ) => Promise<{ value: string } | undefined>;
  rememberTokenIdentity: (managerId: string) => void;
  noteRunnerSessionSince: (record: ManagerRecord) => void;
  sighting: (runnerId: string) => LeaseSighting;
  confirmStoppedAndReleaseLease: (
    record: ManagerRecord,
    runner: RunnerClient,
    managerId: string,
  ) => Promise<{
    outcome: 'stopped' | 'not_stopped' | 'unknown';
    stopError: unknown;
    sessionGone: boolean | undefined;
  }>;
  persist: (record: ManagerRecord) => Promise<void>;
  /** 欄は `Pool` が持つ（`stop()` が `clear`、`#confirmLost` などが `add` / `has` する）。ここが触るのは `delete` だけ。 */
  unresumable: Pick<Set<string>, 'delete'>;
}

/**
 * 1本の委譲を1台の runner へ戻す resume の核（`resumeOnce` → `#resume` → 段の各メソッド）と、それが持つ欄。
 * `resuming`・`resumedCount` は参照で `Pool` が他の協力者（`HeldMessages`・`StaleTokenFold`）へ渡す。
 * `Pool` の他の欄・メソッドは `deps` で受け、呼ぶ時点で引く（構築の時点で未初期化の欄を触らない）。
 */
export class ManagerResume {
  readonly resuming = new Set<string>();
  /**
   * 委譲ごとの、resume が通った回数（`#resume` が `resumed` を返した回。#5207）。鍵の付け替えの畳み（`StaleTokenFold`。参照で渡してある）が、
   * 判断を始めてから畳む直前までの間に、別の経路が起こし直していないかを見るためだけに使う。数そのものに意味は無い。
   * **`#retire()` で消さない**: 判断の最中に担当が畳まれて数が 0 に戻ると、起こし直しが無かったのに「数が変わった」と読んで判定が変わる。
   * 1件は数1つで、増えるのは resume が通った委譲1本につき1件。
   */
  readonly resumedCount = new Map<string, number>();
  /**
   * 生きていた旧プロセスへ流しただけの resume の印。`send()` の返す文と、`#tokenIdentities` を書かない理由（凍った鍵）に対応する。
   * `#retire()` で消さない: 畳んだ委譲への次の `send()` が同じ旧プロセスへ流れたとき、返す文が変わる。消えるのは resume で新しい SDK を起こした回と指紋で確かめた回。
   */
  readonly #resumedIntoLiveProcess = new Set<string>();
  /**
   * `record.leaseRefusal`（ジョブ単位）ではなく `runnerId` 単位で持つ: 併存の検出は `#claimForResume` と、
   * `record` に触れずに抜ける `#reattach` の早期検出の2箇所にあり、後者が見つけた併存は `#claimForResume` に届かず
   * 「解けた」を言う機会が無いまま残る。1つの状態にすれば、どちらの経路でも「入った」「解けた」が1回ずつ出る。
   * 「解けた」を出さないと、併存が続いているのか解けたのか、受信箱の沈黙からは区別できない。
   */
  readonly #ambiguousRunnersNotified = new Set<string>();
  readonly #stores: ManagerResumeDeps['stores'];
  readonly #runners: ManagerResumeDeps['runners'];
  readonly #sessionLoaders: ManagerResumeDeps['sessionLoaders'];
  readonly #restored: ManagerResumeDeps['restored'];
  readonly #workspace: ManagerResumeDeps['workspace'];
  readonly #now: ManagerResumeDeps['now'];
  readonly #journal: ManagerResumeDeps['journal'];
  // 接頭辞（EXCHANGE_KIND_*_PREFIX）は呼び出し箇所の text に字面で置く（exchange-kind-coverage.test.ts が第2引数を走査する）。
  readonly #journalExchange: ManagerResumeDeps['journalExchange'];
  readonly #postReport: ManagerResumeDeps['postReport'];
  readonly #assignToken: ManagerResumeDeps['assignToken'];
  readonly #rememberTokenIdentity: ManagerResumeDeps['rememberTokenIdentity'];
  readonly #noteRunnerSessionSince: ManagerResumeDeps['noteRunnerSessionSince'];
  readonly #sighting: ManagerResumeDeps['sighting'];
  readonly #confirmStoppedAndReleaseLease: ManagerResumeDeps['confirmStoppedAndReleaseLease'];
  readonly #persist: ManagerResumeDeps['persist'];
  readonly #unresumable: ManagerResumeDeps['unresumable'];

  constructor(deps: ManagerResumeDeps) {
    this.#stores = deps.stores;
    this.#runners = deps.runners;
    this.#sessionLoaders = deps.sessionLoaders;
    this.#restored = deps.restored;
    this.#workspace = deps.workspace;
    this.#now = deps.now;
    this.#journal = deps.journal;
    this.#journalExchange = deps.journalExchange;
    this.#postReport = deps.postReport;
    this.#assignToken = deps.assignToken;
    this.#rememberTokenIdentity = deps.rememberTokenIdentity;
    this.#noteRunnerSessionSince = deps.noteRunnerSessionSince;
    this.#sighting = deps.sighting;
    this.#confirmStoppedAndReleaseLease = deps.confirmStoppedAndReleaseLease;
    this.#persist = deps.persist;
    this.#unresumable = deps.unresumable;
  }

  /** `send()` が、指紋で確かめられた回に旧プロセスへ流しただけの印を下ろすための口。 */
  forgetResumedIntoLiveProcess(managerId: string): void {
    this.#resumedIntoLiveProcess.delete(managerId);
  }

  /** `send()` が、旧プロセスへ流しただけの回かを読むための口。 */
  hasResumedIntoLiveProcess(managerId: string): boolean {
    return this.#resumedIntoLiveProcess.has(managerId);
  }

  /** `#reattach` の早期検出が、併存を通知済みかを読むための口。 */
  hasNotifiedAmbiguous(runnerId: string): boolean {
    return this.#ambiguousRunnersNotified.has(runnerId);
  }

  /** 確かめてから立てるまでに `await` を挟まない: 挟むと別の契機が同じ判断をし、同じ仕事が二重に走って同じコミットや PR が二度出る。 */
  async resumeOnce(
    record: ManagerRecord,
    runner: RunnerClient,
    message: string | undefined,
    attachments?: RunnerAttachment[],
    onClaimed?: () => void,
  ): Promise<ResumeOutcome> {
    const id = record.job.id;
    // 理由は真偽値ではなく返り値（`ResumeOutcome`）で運ぶ: 呼び手が残っていた断りから推測して「待てば通る」と誤って言うため。
    if (this.resuming.has(id)) return 'busy';
    this.resuming.add(id);
    try {
      return await this.#resume(record, runner, message, attachments, onClaimed);
    } finally {
      this.resuming.delete(id);
    }
  }

  /**
   * 文面を2箇所に散らさない: `describeAmbiguousSighting` が持っており、別の説明を書くと「別の問題が2つ在る」と誤解される。足すのは「新しく起こし直すな」という行動の指示だけ。
   * `jobIds` が空なら見送り、通知済みにもしない: 通知先が無く、次にジョブが分かった機会にもう一度試せるようにする。
   */
  noteAmbiguousSighting(runnerId: string, duplicates: number, jobIds: readonly string[]): void {
    if (this.#ambiguousRunnersNotified.has(runnerId)) return;
    const managerId = jobIds[0];
    if (managerId === undefined) return;
    this.#ambiguousRunnersNotified.add(runnerId);
    // 日誌は呼び出し元に委ねない: どちらの呼び出し元も `#post` の前に `#journal` していないので、経路によらず「知らせた」の跡を必ず1本残す。
    void this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_FAILURE_PREFIX}[${managerId}] ${describeAmbiguousSighting(runnerId, duplicates)}`,
    );
    this.#postReport(
      managerId,
      `${describeAmbiguousSighting(runnerId, duplicates)} ` +
        '**新しく起こし直さないこと** — 起こし直すと同じ仕事が2本になりえます。',
    );
  }

  /**
   * `jobIds` が空のときは通知済みの状態を消さない: 「解けた」と言える相手が無いまま消すと、後でジョブが見つかったときに「解けた」を言う機会が失われる。
   */
  noteAmbiguousResolved(runnerId: string, jobIds: readonly string[]): void {
    if (!this.#ambiguousRunnersNotified.has(runnerId)) return;
    const managerId = jobIds[0];
    if (managerId === undefined) return;
    this.#ambiguousRunnersNotified.delete(runnerId);
    // 日誌は呼び出し元に委ねない: どちらの呼び出し元も `#post` の前に `#journal` していないので、経路によらず「知らせた」の跡を必ず1本残す。
    void this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}[${managerId}] runnerId=${runnerId} の併存は解けました（宛先が一意に戻りました）。`,
    );
    this.#postReport(
      managerId,
      `runnerId=${runnerId} の併存は解けました（宛先が一意に戻りました）。以後は自動で引き取ります。`,
    );
  }

  /**
   * 関門を契機（`restore` / `hello` / `manager_send`）ごとに置かない: 足し忘れた契機だけが素通しになり、二重実行が起きるまで見えない。`#resume` は3つとも通る。
   * 断っても回数で諦めない: 持ち主が握っている間だけの話で待てば通る。諦めると、台帳では走っているのに誰も走っていない仕事が残る。
   */
  async #claimForResume(record: ManagerRecord, runner: RunnerClient): Promise<boolean> {
    const now = this.#now();
    const verdict = judgeClaimAgainst(
      this.#runners.entries(),
      record.job.lease,
      runner.runnerId,
      now,
    );

    if (!mayClaim(verdict)) {
      // 未知の判定が増えて落ちてきても `ambiguous`（時間では解けない側）に倒す: `mayClaim` の「名指ししなかった判定は断る」と同じ安全側。
      const kind: LeaseRefusalKind = verdict.kind === 'held' ? 'held' : 'ambiguous';
      record.leaseRefusal = {
        detail: describeVerdict(verdict),
        kind,
        ...(verdict.kind === 'held' ? { claimableAt: verdict.claimableAt } : {}),
      };
      if (kind === 'ambiguous') {
        const duplicates = verdict.kind === 'ambiguous' ? verdict.duplicates : 0;
        this.noteAmbiguousSighting(runner.runnerId, duplicates, [record.job.id]);
      }
      return false;
    }
    // delete する前に「直前が併存だったか」を見る: 後だと `#noteAmbiguousResolved` が「解けた」を出す機会を失う。
    if (record.leaseRefusal?.kind === 'ambiguous') {
      this.noteAmbiguousResolved(runner.runnerId, [record.job.id]);
    }
    delete record.leaseRefusal;

    // 世代を進めない: 台帳の世代が runner の持つ世代より新しくなり、次の命令が拒まれる。
    if (verdict.kind === 'same-holder') {
      record.job.lease = touchLease(verdict.lease, now);
      return true;
    }

    const sighting = this.#sighting(runner.runnerId);
    const next = grantLease({
      previous: record.job.lease,
      runnerId: runner.runnerId,
      ...(sighting.instanceId === undefined ? {} : { instanceId: sighting.instanceId }),
      now,
      ttlMs: LEASE_TTL_MS,
    });

    // `#persist` の best-effort に乗せない: 書けないまま走らせると、次の引き取りが「記録が無い＝誰も握っていない」と読んで同じ委譲を無条件で奪える。
    const before = record.job.lease;
    const beforeUpdatedAt = record.job.updatedAt;
    record.job.lease = next;
    try {
      record.job.updatedAt = new Date(now).toISOString();
      await this.#stores.jobs.putJob(record.job);
    } catch (error) {
      // `updatedAt` も戻す: 貸し出しだけ戻すと、次に書けた回の台帳が「この時刻に何かを書いた」と言うのに中身が伴わない。
      record.job.lease = before;
      record.job.updatedAt = beforeUpdatedAt;
      record.leaseRefusal = {
        detail: `貸し出しを台帳へ書けなかったので引き取らない（書けないまま走らせると、次の契機が同じ委譲を無条件で奪える）: ${reasonOf(error)}`,
        // `ambiguous` にしない: `ALTEROID_RUNNER_ID` は正しく、落ちたのは台帳への書き込みだけ。
        kind: 'persist-failed',
      };
      return false;
    }

    // 奪った回も根拠つきで残す: `drained`（畳んだという約束が根拠）と `undecidable`（判定材料なし）は「奪っていない」とは言えない。
    await this.#journal({
      type: 'decision',
      decision:
        `[${record.job.id}] 引き取った（貸し出しを世代 ${next.fence} で貸し直した` +
        `${next.instanceId === undefined ? '。応えているプロセスは未名乗り' : ` / instanceId=${next.instanceId}`}）`,
      grounds: describeVerdict(verdict),
    });
    return true;
  }

  /** `onClaimed` は貸し出しの関門を通った直後に1回だけ呼ぶ（断られた回・関門より前に断った回は呼ばない）。 */
  async #resume(
    record: ManagerRecord,
    runner: RunnerClient,
    message: string | undefined,
    attachments?: RunnerAttachment[],
    onClaimed?: () => void,
  ): Promise<ResumeOutcome> {
    const { sessionId, cwd, request, projectKey } = record.job;
    if (sessionId === undefined) return 'no-session';

    // `#claimForResume` / `SessionLoaders#loadSession` より前に断る: 後段（貸し出し・生ログ取得）が空振りする前に分かる条件。
    if (cwd === undefined && !runner.workspacePathKnown) return 'workspace-path-unknown';

    if (!(await this.#claimForResume(record, runner))) return 'held-by-lease';
    onClaimed?.();

    // runner のディスクに生ログが残っている前提を置かない: 器は作り直される。
    const material = await this.#sessionLoaders.loadSession(projectKey, sessionId);

    // 引けなかったものを「無い」として進めない: 材料無しで resume すると `resume_failed` の `recovered: false` が `lost` に確定し、一時的に DB が読めなかっただけで委譲が恒久に終端する。
    if (material.kind === 'unreadable') return 'unreadable';

    const { subagents, peers } =
      material.kind === 'loaded' && projectKey !== undefined
        ? await this.#loadResumeCompanions(record.job.id, projectKey, sessionId)
        : { subagents: [], peers: [] };

    // チェックポイント1: `#claimForResume` の後・`runner.resume()` の直前に置く。前に置くと確認から呼び出しまでの窓が開くだけで得が無く、呼ぶ前に見送れる回は実 I/O を減らす。
    if (record.stopConfirmedAt !== undefined) return 'stopped-meanwhile';

    // 応答の `cwd` と比べる基準は `record.job.cwd`（`undefined` のことがある）ではなくこの値。
    const requestedCwd = cwd ?? runner.workspacePath;
    const resumed = await this.#issueResume(record, runner, {
      sessionId,
      requestedCwd,
      request,
      message,
      attachments,
      material,
      subagents,
      peers,
    });
    this.#noteResumedCwd(record, runner, resumed, requestedCwd);

    // チェックポイント2: ここで `record.attached` などを書くと、止めたつもりの委譲が「走っているはず」を名乗ったまま誰にも追われなくなる。
    // `record.job.status` は書かない（`abort()` が `'stopped'` を書いて `#persist()` 済み）。畳み直せなかったときは、台帳は「止めた」なのに runner にセッションが生き残る最も危ない不一致なので黙らない。
    if (record.stopConfirmedAt !== undefined) {
      await this.#settleStoppedAfterResume(record, runner);
      return 'stopped-meanwhile';
    }

    this.#recordResumed(record, runner, resumed, material, projectKey);
    return 'resumed';
  }

  /** `#resume` の段: 主の記録が戻る回に、作業者（subagents）と peer の記録を引く（呼び元が条件を見てから呼ぶ）。 */
  async #loadResumeCompanions(
    managerId: string,
    projectKey: string,
    sessionId: string,
  ): Promise<{
    subagents: Awaited<ReturnType<SessionLoaders['loadSubagents']>>;
    peers: Awaited<ReturnType<SessionLoaders['loadPeers']>>;
  }> {
    // 主の記録が戻る回だけ作業者の分も戻す: 主が無い回に作業者だけ戻しても、続ける会話が無い
    const subagents = await this.#sessionLoaders.loadSubagents(managerId, projectKey, sessionId);
    // peer（Codex）の記録も同じ条件で戻す: 主が無ければ、peer の続きを頼む担当の会話そのものが無い
    const peers = await this.#sessionLoaders.loadPeers(managerId, projectKey, sessionId);
    return { subagents, peers };
  }

  /** `#resume` の段: 世代を下ろして `#restored.begin` を立て、`runner.resume()` を出す（応答が返らない失敗は一覧で確かめ、居なければ `#restored.end` して投げる）。 */
  async #issueResume(
    record: ManagerRecord,
    runner: RunnerClient,
    args: {
      sessionId: string;
      requestedCwd: string;
      request: string | undefined;
      message: string | undefined;
      attachments: RunnerAttachment[] | undefined;
      material: Awaited<ReturnType<SessionLoaders['loadSession']>>;
      subagents: Awaited<ReturnType<SessionLoaders['loadSubagents']>>;
      peers: Awaited<ReturnType<SessionLoaders['loadPeers']>>;
    },
  ): Promise<Partial<Awaited<ReturnType<RunnerClient['resume']>>>> {
    const { sessionId, requestedCwd, request, message, attachments, material, subagents, peers } =
      args;
    // 出す直前に追っている世代を下ろす: 応答が返るまで（失敗して返らなければその後も）世代の判定はしない。
    delete record.sessionGeneration;
    // 応答より前に立てる: 新しいセッションの出来事は resume の応答より先に届きうる（`manager-report-before-resume-response.test.ts`）。
    this.#restored.begin(record.job.id, runner.runnerId);
    // 前の鍵が通るかぎり替えない（作業の途中で鍵を替えない）。生きたセッションへ合流する回は runner がこの欄を見ない（鍵は起動時に凍る）
    const assigned = await this.#assignToken(
      record,
      record.job.tokenAssignment?.tokenId,
      runner.runnerId,
    );
    // 応答が返らず一覧で引き取った回（下の `resumed = {}`）だけは、runner が開いた値を持たない
    let resumed: Partial<Awaited<ReturnType<RunnerClient['resume']>>>;
    try {
      resumed = await runner.resume({
        managerId: record.job.id,
        sessionId,
        ...(assigned === undefined ? {} : { agentToken: { value: assigned.value } }),
        cwd: requestedCwd,
        request: request ?? record.job.summary,
        ...(message === undefined ? {} : { message }),
        ...(message === undefined || attachments === undefined || attachments.length === 0
          ? {}
          : { attachments }),
        ...(material.kind === 'loaded' ? { entries: material.entries } : {}),
        ...(subagents.length === 0 ? {} : { subagents }),
        ...(peers.length === 0 ? {} : { peers }),
        ...(record.job.lease === undefined
          ? {}
          : { lease: { fence: record.job.lease.fence, ttlMs: record.job.lease.ttlMs } }),
      });
    } catch (error) {
      // 応答の無い失敗（期限切れ・接続の断）は「効かなかった」と決めず、runner の一覧で確かめる（#4715）: runner は受け取って
      // セッションを起こしたのに応答だけが返らないことがあり、効かなかった側へ倒すと、生きているセッションを引き取らないまま
      // その出来事を「移った後の古い runner」として捨て続けるため。runner が答えた失敗（`RunnerHttpError`）は確かめずにそのまま投げる
      const alive =
        error instanceof RunnerHttpError
          ? false
          : await listRunnerManagers(runner)
              .then(
                (listing) =>
                  listing.states.some((state) => state.managerId === record.job.id) ||
                  listing.unreadableIds.includes(record.job.id),
              )
              .catch(() => false);
      if (!alive) {
        this.#restored.end(record.job.id);
        throw error;
      }
      // 世代は分からないので持たない（応答が運ぶもの）: 世代の判定は「不明」として出来事を受ける
      resumed = {};
      await this.#journal({
        type: 'decision',
        decision: `[${record.job.id}] resume の応答が返らなかったが、${runner.runnerId} にセッションが居るので、resume は効いたとして引き取った`,
        grounds: `resume の失敗: ${reasonOf(error)}。${runner.runnerId} の一覧にこの委譲が居た`,
      });
    }
    return resumed;
  }

  /** `#resume` の段（同期）: 応答の `cwd` が頼んだ値と違えば、台帳の `cwd` と locator を直して `cwdSwapNotice` を立てる。 */
  #noteResumedCwd(
    record: ManagerRecord,
    runner: RunnerClient,
    resumed: Partial<Awaited<ReturnType<RunnerClient['resume']>>>,
    requestedCwd: string,
  ): void {
    // 応答が返らず引き取った回（`resumed.cwd` が無い）は何もしない: 「未確認」を `requestedCwd` で埋めると、倒れていた回まで「頼んだとおり開けた」と嘘をつく。
    // 倒れたかは応答後にしか分からず、resume 前に組む「移送の一言」へ混ぜられないので `cwdSwapNotice` で伝える。前回の通知は持ち越さない。
    record.cwdSwapNotice = undefined;
    if (resumed.cwd !== undefined && resumed.cwd !== requestedCwd) {
      record.job.cwd = resumed.cwd;
      record.job.workspace = workspaceLocatorFrom(this.#workspace(), runner.runnerId, resumed.cwd);
      record.cwdSwapNotice = { requested: requestedCwd, actual: resumed.cwd };
    }
  }

  /** `#resume` の段: resume の後で止められていた委譲を畳み直す（呼び元が `stopConfirmedAt` を見てから呼ぶ）。 */
  async #settleStoppedAfterResume(record: ManagerRecord, runner: RunnerClient): Promise<void> {
    this.#restored.end(record.job.id);
    const { outcome: foldOutcome } = await this.#confirmStoppedAndReleaseLease(
      record,
      runner,
      record.job.id,
    );
    if (foldOutcome === 'stopped') {
      await this.#persist(record);
    } else {
      noteResumeAfterStopFoldFailed(record.job.id, foldOutcome);
    }
  }

  /** `#resume` の段（同期）: 受理された resume を台帳と pool の欄へ写す。await が無い並びなので途中で切らない。 */
  #recordResumed(
    record: ManagerRecord,
    runner: RunnerClient,
    resumed: Partial<Awaited<ReturnType<RunnerClient['resume']>>>,
    material: Awaited<ReturnType<SessionLoaders['loadSession']>>,
    projectKey: string | undefined,
  ): void {
    record.attached = true;
    const previousRunnerId = record.job.runnerId;
    record.job.runnerId = runner.runnerId;
    // cwd が倒れた回だけ locator を作り直さない: 倒れなかった移送で `runnerId` が元の器を指したまま残る。
    if (previousRunnerId !== undefined && previousRunnerId !== runner.runnerId) {
      record.job.workspace = workspaceAfterRelocation(record.job.workspace, runner.runnerId);
    }
    this.#noteRunnerSessionSince(record);
    if (resumed.sessionGeneration !== undefined && resumed.sessionGeneration.length > 0) {
      record.sessionGeneration = resumed.sessionGeneration;
    }
    // 名簿を引き直さない: 写すのは関門（`#claimForResume`）が判定した相手。理由は `Job.sessionInstanceId` の doc。
    // これより前の枝ではこの欄が動かない: 貸し出しだけが新しい器へ進んで告げる1行が届かなかった回に、次の `send()` がもう一度告げられる。
    const placed = record.job.lease?.instanceId;
    if (placed !== undefined) record.job.sessionInstanceId = placed;
    // 生きていた旧プロセスへ流しただけの回は身元を覚えない: 旧プロセスの env は凍っているので、いまの世代を書くと古い鍵のまま走っているのに `manager_list` の ⚠ が消える（偽の一致）。
    // resume で起こし直した回は覚える: 抜けると `observedBy` が無く世代の照合が素通しになり、消費のトークン帰属も持てない。
    if (resumed.reusedLiveSession === true) {
      this.#resumedIntoLiveProcess.add(record.job.id);
    } else {
      this.#resumedIntoLiveProcess.delete(record.job.id);
      this.#rememberTokenIdentity(record.job.id);
    }
    // 生きていた旧プロセスへ流しただけの回は立てない: 会話はそのプロセスが持っている。
    // 預け先が在って引けた結果が空だった回だけ立てる: 預け先の無い構成（fs）や鍵（projectKey）の無い古い行では、`absent` は「無いと確かめた」ではない。
    record.resumedWithoutLog =
      this.#stores.sessionStore !== undefined &&
      projectKey !== undefined &&
      material.kind === 'absent' &&
      resumed.reusedLiveSession !== true;
    this.#unresumable.delete(record.job.id);
    this.resumedCount.set(record.job.id, (this.resumedCount.get(record.job.id) ?? 0) + 1);
  }
}

import { reasonOf } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX, EXCHANGE_KIND_RECOVERY_PREFIX } from './exchange-kind.js';
import { isManagerInFlight } from './job-status-running.js';
import { describeAmbiguousSighting, releaseLease, type LeaseSighting } from './lease.js';
import type { ManagerRecord, ResumeOutcome } from './manager.js';
import {
  cwdSwapNoticeClause,
  leaseRefusalDecision,
  restartNudge,
  resumeFallbackBody,
  unresumableNotice,
  type RestartCause,
} from './manager-notices.js';
import type { ManagerRescueStash } from './manager-rescue-stash.js';
import type { ManagerResume } from './manager-resume.js';
import type { PushLedger } from './push-ledger.js';
import type { RestoredWindows } from './restored-windows.js';
import type { ResumeEventWindows } from './resume-event-windows.js';
import {
  isFencedRunnerError,
  isRetryableRunnerError,
  isRunnerSpecificRefusal,
  listRunnerManagers,
  type RunnerClient,
  type RunnerRegistry,
} from './runner-protocol.js';
import type { Job, JournalEntryInput } from './schema.js';
import type { SynthesizedNoticeWindows } from './synthesized-notice-windows.js';
import { workspaceLocatorFrom, type WorkspacePolicy } from './workspace-policy.js';

/** **能力の上限ではなく、混雑を作らないための間隔である。** 頭打ちは、器が長く戻らないときに秒間何度も叩かないため。 */
const REATTACH_RETRY_BASE_MS = 1_000;
const REATTACH_RETRY_MAX_MS = 30_000;

/**
 * `busy` を予約に載せっぱなしにすると、別の契機の resume が延々と続く間、梯子が回り続ける。
 * 数えは **runner 単位の梯子を借りるがジョブ単位** なので、同じ runner の別の委譲の `busy` が梯子を延命しない。
 */
const REATTACH_BUSY_MAX_RETRIES = 5;

interface ManagerReattachDeps {
  runners: Pick<RunnerRegistry, 'get' | 'entries'>;
  /** `Pool#pushLedger`（`pushEnvironmentTo` / `settleRetry` だけを使う）。 */
  pushLedger: Pick<PushLedger, 'pushEnvironmentTo' | 'settleRetry'>;
  /** resume の核（`ManagerResume`）。先に構築してある物を渡す。 */
  resumeCore: Pick<
    ManagerResume,
    | 'resuming'
    | 'resumeOnce'
    | 'hasNotifiedAmbiguous'
    | 'noteAmbiguousSighting'
    | 'noteAmbiguousResolved'
  >;
  resumeWindows: Pick<ResumeEventWindows, 'openRelocation' | 'openSameRunner' | 'close'>;
  restored: Pick<RestoredWindows, 'notify'>;
  rescueStash: Pick<ManagerRescueStash, 'note'>;
  /** `Pool#records` と同じ参照（像の写し）。 */
  records: Map<string, ManagerRecord>;
  /** 欄は `Pool` が持つ（`stop()` が `clear`、`#handleResumeFailed` が `add` する）。同じ参照を `ManagerResume` へも渡している。 */
  unresumable: Set<string>;
  /** `Pool#workspace` を、呼ぶ時点で引く形で束ねたもの。 */
  workspace: () => WorkspacePolicy;
  /** `Pool#stopped` を、呼ぶ時点で引く形で束ねたもの。 */
  stopped: () => boolean;
  /** `Pool#restoring` を、呼ぶ時点で引く形で束ねたもの（起動時の引き取りの旗。無ければ `null`）。 */
  restoring: () => Promise<void> | null;
  now: () => number;
  nowIso: () => string;
  journal: (entry: JournalEntryInput) => Promise<void>;
  /** `Pool#journalExchange` を `bind` したもの（`async` にしない: `await` / `void` の呼び出し側のタイミングを変えない）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  persist: (record: ManagerRecord) => Promise<void>;
  sighting: (runnerId: string) => LeaseSighting;
  shouldRelocateFrom: (runnerId: string) => boolean;
  listJobsOrNote: (skipped: string) => Promise<Job[] | null>;
  latestJobOf: (managerId: string) => Promise<Job | null>;
  withdrawWaiting: (record: ManagerRecord, reason: string) => void;
  refuseFenced: (jobId: string, error: unknown, stopped: string, what: string) => Promise<void>;
  retire: (managerId: string) => void;
  queueSynthesizedNotice: (...args: Parameters<SynthesizedNoticeWindows['queue']>) => void;
}

/**
 * runner の名乗り（`hello`）・入れ替わり・移送のあとの、取り直しの梯子（`reattach` → `#reattachOne` → 結果ごとの後始末）と、それが持つ欄。
 * `Pool` の他の欄・メソッドは `deps` で受け、呼ぶ時点で引く（構築の時点で未初期化の欄を触らない）。
 * `unresumable`・`records` は `Pool` が持つ欄の参照を渡されている。
 */
export class ManagerReattach {
  readonly #reattaching = new Set<string>();
  /**
   * `#connections` とは別に持つ: `#reattach` が直接書き換えると、`#connectTo` 自身の失敗時の後始末
   * （`this.#connections.delete(runner)`）が誰の Promise かを見ずに消し、新しく置いた分を古い接続の失敗が巻き添えで消しうる。
   */
  readonly #reattachPushes = new Map<string, Promise<void>>();
  /** **捨てずに、終わってからもう一度回す。** */
  readonly #reattachAgain = new Set<string>();
  readonly #reattachTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #reattachDelays = new Map<string, number>();
  readonly #reattachBusyRetries = new Map<string, number>();
  /**
   * 永続化しない: 試すのを止める印ではなく（断った runner も `hello` のたびに試される）、
   * 再起動後に候補を1巡し直すのは妥当で、無限には試さない。
   */
  readonly #relocationRefusals = new Map<string, Set<string>>();
  readonly #runners: ManagerReattachDeps['runners'];
  readonly #pushLedger: ManagerReattachDeps['pushLedger'];
  readonly #resumeCore: ManagerReattachDeps['resumeCore'];
  readonly #resumeWindows: ManagerReattachDeps['resumeWindows'];
  readonly #restored: ManagerReattachDeps['restored'];
  readonly #rescueStash: ManagerReattachDeps['rescueStash'];
  readonly #records: ManagerReattachDeps['records'];
  readonly #unresumable: ManagerReattachDeps['unresumable'];
  readonly #workspace: ManagerReattachDeps['workspace'];
  readonly #stopped: ManagerReattachDeps['stopped'];
  readonly #restoring: ManagerReattachDeps['restoring'];
  readonly #now: ManagerReattachDeps['now'];
  readonly #nowIso: ManagerReattachDeps['nowIso'];
  readonly #journal: ManagerReattachDeps['journal'];
  // 接頭辞（EXCHANGE_KIND_*_PREFIX）は呼び出し箇所の text に字面で置く（exchange-kind-coverage.test.ts が第2引数を走査する）。
  readonly #journalExchange: ManagerReattachDeps['journalExchange'];
  readonly #persist: ManagerReattachDeps['persist'];
  readonly #sighting: ManagerReattachDeps['sighting'];
  readonly #shouldRelocateFrom: ManagerReattachDeps['shouldRelocateFrom'];
  readonly #listJobsOrNote: ManagerReattachDeps['listJobsOrNote'];
  readonly #latestJobOf: ManagerReattachDeps['latestJobOf'];
  readonly #withdrawWaiting: ManagerReattachDeps['withdrawWaiting'];
  readonly #refuseFenced: ManagerReattachDeps['refuseFenced'];
  readonly #retire: ManagerReattachDeps['retire'];
  readonly #queueSynthesizedNotice: ManagerReattachDeps['queueSynthesizedNotice'];

  constructor(deps: ManagerReattachDeps) {
    this.#runners = deps.runners;
    this.#pushLedger = deps.pushLedger;
    this.#resumeCore = deps.resumeCore;
    this.#resumeWindows = deps.resumeWindows;
    this.#restored = deps.restored;
    this.#rescueStash = deps.rescueStash;
    this.#records = deps.records;
    this.#unresumable = deps.unresumable;
    this.#workspace = deps.workspace;
    this.#stopped = deps.stopped;
    this.#restoring = deps.restoring;
    this.#now = deps.now;
    this.#nowIso = deps.nowIso;
    this.#journal = deps.journal;
    this.#journalExchange = deps.journalExchange;
    this.#persist = deps.persist;
    this.#sighting = deps.sighting;
    this.#shouldRelocateFrom = deps.shouldRelocateFrom;
    this.#listJobsOrNote = deps.listJobsOrNote;
    this.#latestJobOf = deps.latestJobOf;
    this.#withdrawWaiting = deps.withdrawWaiting;
    this.#refuseFenced = deps.refuseFenced;
    this.#retire = deps.retire;
    this.#queueSynthesizedNotice = deps.queueSynthesizedNotice;
  }

  /** `#connectTo`・`PushLedger` が、取り直しの前の鍵の降ろし直しが走っているかを読むための口。 */
  pendingPush(runnerId: string): Promise<void> | undefined {
    return this.#reattachPushes.get(runnerId);
  }

  /** `stop()` が、予約の timer を止めて控えを空にするための口（`clear` の位置・順は `stop()` が決める）。 */
  clearTimers(): void {
    for (const timer of this.#reattachTimers.values()) clearTimeout(timer);
    this.#reattachTimers.clear();
  }

  /** `stop()` が、梯子の間隔と busy の数えを空にするための口。 */
  clearBackoff(): void {
    this.#reattachDelays.clear();
    this.#reattachBusyRetries.clear();
  }

  /** `#retire()` が、busy の取り直しの数えを消すための口。 */
  forgetBusyRetries(managerId: string): void {
    this.#reattachBusyRetries.delete(managerId);
  }

  /**
   * 引き取りの契機をデーモンの起動時だけにしない: runner の器だけが入れ替わると、台帳は `running` のまま runner の中にセッションは無く、クローンが `manager_send` するまで永久に止まる。
   * 生死は台帳ではなく runner に聞く。
   */
  async reattach(runnerId: string, viaLadder = false): Promise<void> {
    if (this.#stopped()) return;
    // 重なった名乗りを捨てない: 処理中に器が入れ替わった場合、return するだけだとその入れ替えが誰にも見られないまま終わる。
    if (this.#reattaching.has(runnerId)) {
      this.#reattachAgain.add(runnerId);
      return;
    }
    this.#reattaching.add(runnerId);
    let retry = false;
    try {
      // 起動時の引き取りと重ならせない: 両方が同じ `list()` を見てから動くと、同じ仕事を二本起こす。
      await this.#restoring();
      if (this.#stopped()) return;

      // 名簿を引けなかったのは一時障害だが、居ないと答えられたのは別: その runner は戻ってこないので挑み直しても同じ答えしか返らない。
      const runner = await this.#runners.get(runnerId).catch(() => {
        retry = true;
        return null;
      });
      if (runner === null) return;

      // 併存は関門より前に確かめる: `this.#runners.get` は同名の行が2つ以上あっても黙って一方を返すので、関門（`#claimForResume`）に着く前にプロファイルの配布（`#pushSetting`。日誌の文言には旧名の `#pushProfile` が残る）と `runner.list()` が誤解決した相手へ走ってしまう。関門は複製せず、進んでよい状態かを覗くだけ。
      // この断りは `held` と違って時間で解けないので「遷移のときだけ書く」dedup（`refusedBefore`）には乗せない: 初回だけ言うと、見逃した後・デーモン再起動後は永久に見えなくなる。
      const sighting = this.#sighting(runnerId);
      if (sighting.duplicates !== undefined && sighting.duplicates > 1) {
        // 梯子を予約する: 残さないと、解けた後に取り直す契機は `hello` しか無く、来なければ委譲は `running` のまま誰にも拾われない。時間で解けるとは限らないので間隔は上限に固定する。`viaLadder` の回は併存の日誌・知らせを出し直さない: 梯子が回るたびに積まれる。
        retry = true;
        this.#reattachDelays.set(runnerId, REATTACH_RETRY_MAX_MS);
        await this.#refuseAmbiguousRunner(runnerId, sighting.duplicates, viaLadder);
        return;
      }
      if (this.#resumeCore.hasNotifiedAmbiguous(runnerId)) {
        await this.#noteAmbiguousResolvedFor(runnerId);
      }

      // 取り直しの前に環境を整える: 走り出してから降ろすと、その仕事の最初のコマンドだけが古い環境で走る。降ろし切るまで委譲にも待たせる。
      // `#connections` は触らず別の窓口（`#reattachPushes`）に置く: `#connectTo` の失敗時の後始末が誰の Promise かを見ずに消すため、上書きすると古い接続の失敗がこの降ろし直しを巻き添えで消しうる。
      await this.#pushEnvironmentBeforeReattach(runner, runnerId);

      // 台帳を先に、runner を後に読む: 逆にすると、隙間で起こされた委譲が「runner に居ないのに台帳には居る」と見えて、走り出したばかりの仕事を死んだものとして起こし直す。読めなかった回は予約して挑み直すが、黙らない。
      const jobs = await this.#listJobsOrNote(
        `runnerId=${runnerId} の取り直しを進めなかった（居ない委譲を起こすことも、居る委譲を死んだと読むこともしていない。予約して挑み直す）`,
      );
      if (jobs === null) retry = true;
      if (jobs === null || this.#stopped()) return;

      // 聞けなかったときは何もしない。応答が無いことを「セッションが無い」と読むと、生きている仕事を二重に起こす。ただし黙って引き下がらず予約する: SSE が安定していれば次の名乗りは来ないので、帰ると生死確認の段階に恒久停止が残る。
      const listing = await listRunnerManagers(runner).catch(() => {
        retry = true;
        return null;
      });
      if (listing === null || this.#stopped()) return;
      // 状態を読めなかった委譲も「居る」側に数える: 居ないと読むと、まだ走っているものを resume し、待っていた確認まで捨てる。
      const alive = new Set([
        ...listing.states.map((state) => state.managerId),
        ...listing.unreadableIds,
      ]);

      for (const job of jobs) {
        if (alive.has(job.id)) {
          this.#reattachBusyRetries.delete(job.id);
          const livingState = listing.states.find((state) => state.managerId === job.id);
          if (
            livingState !== undefined &&
            job.runnerId !== undefined &&
            job.runnerId !== runnerId &&
            this.#shouldRelocateFrom(job.runnerId)
          ) {
            await this.#alignToTarget(job, runner, livingState);
          }
          continue;
        }
        if (this.#stopped()) continue;
        // 宛先が書かれていない古いジョブは触らない: どの runner の器が入れ替わったのかを決められない（起動時の `restore` が `runner_id` を書く）。
        if (job.runnerId === undefined) continue;
        const relocating = job.runnerId !== runnerId;
        // 移送してよいのは記録された宛先が `lost` または `vacating` のときだけ: `unreachable`（まだ開けていない）は抱えている仕事が無く、名簿に行が無い（＝確かめられていない）ときは移送しない。
        if (relocating && !this.#shouldRelocateFrom(job.runnerId)) continue;

        // 一度「挑み直さない」と決めたものは自動では二度と触らない: 抜かすと、同じ runner の別ジョブの予約のたびに無意味な resume と同じ通知が繰り返される。
        if (this.#unresumable.has(job.id)) continue;

        if (await this.#reattachOne(job, runner, runnerId, relocating)) retry = true;
      }
    } catch {
      // 想定外で転んでもデーモンごと落とさず、黙って終わらない: 「もう挑まない」に倒すと、走行中だった仕事が誰にも拾われないまま `running` で残る。
      retry = true;
    } finally {
      this.#reattaching.delete(runnerId);
      if (!retry) this.#reattachDelays.delete(runnerId);
      // 走っている間に届いた名乗りは予約より即時を優先する。
      if (this.#reattachAgain.delete(runnerId) && !this.#stopped()) void this.reattach(runnerId);
      else if (retry && !this.#stopped()) this.scheduleReattach(runnerId);
    }
  }

  /**
   * 併存（同じ runnerId を名乗る器が2台以上）を検出した回の断り: 日誌と受信箱へ知らせ、移送先の候補として数えていたジョブへ見送りを流す。
   * `viaLadder` の回は流すだけで、日誌・知らせは出し直さない。
   */
  async #refuseAmbiguousRunner(
    runnerId: string,
    duplicates: number,
    viaLadder: boolean,
  ): Promise<void> {
    if (viaLadder) {
      await this.#refuseRelocationsBeforeGate(runnerId, duplicates);
      return;
    }
    await this.#journal({
      type: 'decision',
      decision: `runnerId=${runnerId} の取り直しを見送った（併存を関門より前で検出。#pushProfile と runner.list() は誤解決した相手へ走らせていない）`,
      grounds: describeAmbiguousSighting(runnerId, duplicates),
    });
    // 受信箱にもここで知らせる: `#claimForResume` 側の通知だけに任せると、併存を検出する経路（`hello`）がここで折り返され続け、クローンへ一度も届かない。dedup は `#ambiguousRunnersNotified` を共有するので二重には出ない。
    // ジョブの一覧は store から引く: `this.#records`（プロセス内の像）はまだこのジョブを持っていないことがある。
    // 一覧を読めなかった回を「紐づく委譲が無い」とみなさない: `#noteAmbiguousSighting` を呼ばなければ通知済みにもならず、次の `hello` で再挑戦できる。見送ったことは日誌に残す。
    const listed = await this.#listJobsOrNote(
      `runnerId=${runnerId} の併存の通知を見送った（通知済みにはしていない。次の hello で再挑戦する）`,
    );
    if (listed !== null) {
      const jobIds = listed.filter((job) => job.runnerId === runnerId).map((job) => job.id);
      this.#resumeCore.noteAmbiguousSighting(runnerId, duplicates, jobIds);
    }
    // この runner を移送先の候補として数えていたジョブには、見送りを断りとして流す: runner 単位の `return` なので、ジョブのループには届かない。
    await this.#refuseRelocationsBeforeGate(runnerId, duplicates);
  }

  /** 併存が解けた回の通知: 台帳の一覧を読めなかった回は言わず、通知済みの印を残す。 */
  async #noteAmbiguousResolvedFor(runnerId: string): Promise<void> {
    // 読めなかった回は「解けた」を言わず通知済みのまま残し、次に読めた回に言う。
    const listed = await this.#listJobsOrNote(
      `runnerId=${runnerId} の併存が解けた通知を見送った（通知済みの印は残している。次に読めた回に言う）`,
    );
    if (listed !== null) {
      this.#resumeCore.noteAmbiguousResolved(
        runnerId,
        listed.filter((job) => job.runnerId === runnerId).map((job) => job.id),
      );
    }
  }

  /** 取り直しの前に鍵・プロファイルを降ろし直す: 降ろし切るまで委譲（`#connectTo`）にも待たせる。 */
  async #pushEnvironmentBeforeReattach(runner: RunnerClient, runnerId: string): Promise<void> {
    const push = (async () => {
      // 繋ぎ直してきた runner は器ごと入れ替わっていることがあり、置いた鍵とプロファイルは消えているので降ろし直す。
      // 鍵を先に降ろす（#4841）: 並びは `#pushSpecs` の表の順。認証トークンも降ろし忘れない（`#pushEnvironmentTo` の注記）。
      await this.#pushLedger.pushEnvironmentTo(runner);
      this.#pushLedger.settleRetry(runnerId);
    })();
    this.#reattachPushes.set(runnerId, push);
    try {
      await push;
    } finally {
      // 自分が置いたものだけを消す: 後から来た再実行が新しく置いた分を消さない。
      if (this.#reattachPushes.get(runnerId) === push) {
        this.#reattachPushes.delete(runnerId);
      }
    }
  }

  /**
   * 1本の委譲を取り直す（`#reattach` のループの1周ぶん）: 像の読み直し・resume・結果ごとの後始末まで。
   * 戻り値は「挑み直しを予約するか」。`continue` で次の委譲へ進んでいた所は `return` で返す。
   */
  async #reattachOne(
    job: Job,
    runner: RunnerClient,
    runnerId: string,
    relocating: boolean,
  ): Promise<boolean> {
    let retry = false;
    // 古い写し（ループ先頭の `job`）の宛先で像へ書かない: `#reattaching` は runner ごとの直列化なので、待っている間に別の runner の取り直しが移送を終えていると、移送先で健全に走る像へ `attached = false`・`waiting = []` と「resume に失敗した」観測を書いてしまう。判定は読み直しの後・像への最初の書き込みの前に置く。自分の runner の委譲（`!relocating`）は宛先が変わらないので飛ばさない。
    const fresh =
      this.#records.get(job.id) === undefined ? ((await this.#latestJobOf(job.id)) ?? job) : job;
    // 読み直しの `await` の間に像が載ることもあるので、読んだ後にもう一度 `#records` を見る。
    const known = this.#records.get(job.id);
    if ((known?.job.runnerId ?? fresh.runnerId) !== job.runnerId) return false;

    // 移送のときは、像を「器にセッションが無い」側へ倒すのを貸し出しの関門を通った後まで待つ（下の `markMissing`）。
    // 関門で断られるのは持ち主がまだ握っているときで、名簿が器を一時的に `lost` と誤判定しただけのこともある。先に倒すと、断られた後も
    // 待っていた確認（`waiting`）が消えたまま戻らず、回答が届かなくなる。`attached = false` も残り、次の `manager_send` が生きたセッションへ resume を撃ち直す（#4454）。
    if (known && !relocating) known.attached = false;

    // 印は resume を挑む直前に置き、戻れたときに消す: `#resumeOnce` が投げる回も「戻れなかった」側へ落ち、この節を抜けて印が立っている ⟺ resume が成功しなかった、が成り立つ。
    const missingAt = this.#nowIso();

    // 手を動かしている最中だったものだけ戻す: `done` は死ではなく待機で、起こすと開いたままの窓を勝手に閉じる。判定より前に `#records` へ載せない: 終わった仕事まで `live: true` で見せ、話しかけると必ず失敗する相手が生まれる。
    // 古い写し（ループ先頭の `job`）で判定しない: 待っている間に `abort()` が `stopped` を書いて `#retire` していると、`stopped` を `running` で上書きして起こし直す。`known` が無いときは読み直した `fresh` で判定し、record も同じ行から作る。
    const current = this.#records.get(job.id) ?? known;
    const status = current?.job.status ?? fresh.status;
    if (!isManagerInFlight(status)) return false;

    const record = current ?? { job: { ...fresh }, waiting: [], attached: false };
    this.#records.set(job.id, record);
    const markMissing = (): void => {
      record.attached = false;
      // 待っていた確認を持ち越さない: 新しい器はその request_id を知らず、残すと以後の `manager_send` が死んだ確認への回答として横取りされ、誰からも届かないマネージャーになる。
      this.#withdrawWaiting(record, '器が入れ替わり、新しい器はこの確認を知らない');
      record.sessionMissingSince ??= missingAt;
      // 由来を上書きする（格上げ）: ここを抜けて印が残っている ⟺ resume でも入り直せなかった。
      record.sessionMissingKind = 'resume-failed';
    };
    if (!relocating) markMissing();

    // 1本が戻せなくても残りを道連れにしない。移送の窓はどの抜け方でも必ず1回閉じる（`ResumeEventWindows#close`）。
    try {
      const cause: RestartCause = relocating ? 'relocated' : 'runner';
      const message = restartNudge(
        status,
        cause,
        record.job.workspace,
        record.job.lastUnpushedWorkObservation,
        record.job.lastRescue,
        this.#rescueStash.note(record.job.rescueStash, runnerId),
      );
      const refusedBefore = record.leaseRefusal !== undefined;
      // 別の契機が resume 中なら窓は持たない: そちらの窓を壊さない。同じ runner への復帰は `closed` だけを預ける別の窓を持つ。
      const ownsWindow = !this.#resumeCore.resuming.has(job.id);
      if (ownsWindow) {
        if (relocating) this.#resumeWindows.openRelocation(job.id, runnerId);
        else this.#resumeWindows.openSameRunner(job.id, runnerId);
      }
      let outcome: ResumeOutcome | undefined;
      // 受理された回は台帳を `running` へ戻して persist した後に閉じる: 移送先自身の出来事（closed(failed) や ask）を処理し直した結果を、後から `running` で上書きしないため。受理されなかった回と投げた回は `moved` を立てずに、下の分岐より先に閉じる。
      try {
        outcome = await this.#resumeCore.resumeOnce(
          record,
          runner,
          message,
          undefined,
          relocating ? markMissing : undefined,
        );
        if (outcome === 'resumed') {
          // `#resumeOnce` から戻った直後、他の await を挟む前に読む（`#restoreJobs` と同じ理由）。
          const swapNotice = cwdSwapNoticeClause(record);
          // 受理と「戻れた」を取り違えない。
          if (record.job.status === 'lost') return false;
          await this.#settleResumedReattach(
            job,
            record,
            runner,
            relocating,
            cause,
            message,
            swapNotice,
          );
        }
      } finally {
        if (ownsWindow) await this.#resumeWindows.close(job.id, outcome === 'resumed');
      }
      // 引けなかっただけなら `continue` で済ませず予約して挑み直す: 次の名乗り（`hello`）は SSE が繋がったときにしか来ず、永久に来ないことがある。
      if (outcome === 'busy') {
        // 別の契機が resume 中でそちらが失敗すると誰も取り直さないので梯子に載せるが、委譲ごとに `REATTACH_BUSY_MAX_RETRIES` 回で打ち切る: 相手の resume が終わらない限り毎回 busy に当たる。打ち切った委譲は `retry` を立てず、梯子を延命しない。
        const tried = this.#reattachBusyRetries.get(job.id) ?? 0;
        if (tried < REATTACH_BUSY_MAX_RETRIES) {
          this.#reattachBusyRetries.set(job.id, tried + 1);
          retry = true;
        } else {
          this.#reattachBusyRetries.delete(job.id);
          await this.#journal({
            type: 'decision',
            decision: `[${job.id}] 取り直しの予約を止めた（別の契機の resume が ${REATTACH_BUSY_MAX_RETRIES} 回の挑み直しを通じて終わらなかった）`,
            grounds:
              'busy が続いたので、この委譲についての梯子の予約を打ち切った。次の名乗り（hello）か、相手の resume の結果に任せる',
          });
        }
        return retry;
      }
      this.#reattachBusyRetries.delete(job.id);
      if (outcome === 'unreadable') {
        retry = true;
        return retry;
      }
      if (outcome === 'held-by-lease') {
        retry = true;
        // 待っていることを日誌に残す: 書かないと「待っている」と「忘れている」が記録から区別できない。遷移のときだけ書く: 梯子は最大30秒間隔で挑み直すので、毎回書くと同じ行が積まれ、日誌を読む側で本当に1回だけ起きたことが埋もれる。
        if (!refusedBefore) {
          await this.#journal({
            type: 'decision',
            decision: leaseRefusalDecision(job.id, record.leaseRefusal),
            grounds: record.leaseRefusal?.detail ?? '（根拠を取れなかった）',
          });
        }
        return retry;
      }
      if (relocating && outcome === 'no-session') {
        // 移送のときの `no-session` はその場で lost に確定する: セッションが無いのは委譲の側の事実で、候補を回しても変わらない。
        await this.#settleRelocationNoSession(job, record, runnerId);
        return false;
      }
      if (relocating && outcome === 'workspace-path-unknown') {
        // 貸し出しは返さない: この回では貸していず、`record.job.lease` がこの候補を指していても以前の回が貸したもので、セッションが起きていないと確かめられないものは返さない。
        await this.#settleRelocationWorkspaceUnknown(job, record, runnerId);
        return false;
      }
    } catch (error) {
      // 投げる前に立てた予約（`held-by-lease` の日誌の書き込みが投げた回など）は落とさない: 切り出す前は `retry` が `#reattach` の変数で、catch でも残っていた。
      const retryAfterError = await this.#classifyReattachError(
        error,
        record,
        job.id,
        runnerId,
        relocating,
      );
      return retry || retryAfterError;
    }
    return retry;
  }

  /** resume が受理され、戻れたと確かめた後の後始末: 古い観測の消去・台帳への書き戻し・一言・日誌・知らせ。 */
  async #settleResumedReattach(
    job: Job,
    record: ManagerRecord,
    runner: RunnerClient,
    relocating: boolean,
    cause: RestartCause,
    message: string,
    swapNotice: string | undefined,
  ): Promise<void> {
    // 戻れたので古い観測は捨てる: 残すと「いま話しかけられない」と読める欄が話しかけられる相手に付いたままになる。由来も片方だけ残さない。
    record.sessionMissingSince = undefined;
    // 由来も一緒に消す: 片方だけ残さない。
    record.sessionMissingKind = undefined;
    // 応答より先に届いた確認（`waiting`）があれば `waiting_human` を保つ（`#send` の同じ書き込みと同じ理由）。
    record.job.status = record.waiting.length > 0 ? 'waiting_human' : 'running';
    this.#relocationRefusals.delete(job.id);
    await this.#persist(record);
    // `runner.send()` の失敗は無視する: 本体の resume は成功しており、この一言が届かなくても致命ではない。
    if (swapNotice !== undefined) {
      await runner.send(job.id, swapNotice).catch(() => undefined);
    }
    await this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}[${job.id}] （${relocating ? '別の器への移送' : 'runner 入れ替え'}後の再開）${message}` +
        (swapNotice === undefined ? '' : ` ${swapNotice}`),
    );
    this.#restored.notify(record, 'resumed', cause);
  }

  /** 移送のときの `no-session` の後始末: セッションが無いのは委譲の側の事実なので、その場で lost に確定する。 */
  async #settleRelocationNoSession(
    job: Job,
    record: ManagerRecord,
    runnerId: string,
  ): Promise<void> {
    const reason = new Error(
      'no-session: 委譲が session_id を持っておらず、どの runner でも開き直せない（移送の候補を回しても変わらないので、その場で確定した）',
    );
    await this.#journal({
      type: 'decision',
      decision: `[${job.id}] 移送先 ${runnerId} へ移せない（セッションが無い）。候補を回さず、戻せなかったものとして確定する`,
      grounds: reasonOf(reason),
    });
    await this.confirmLost(record, reason);
  }

  /** 移送のときの `workspace-path-unknown` の後始末: 断りを数え、上限なら lost に確定し、そうでなければ貸し出しを返さなかったことを日誌に残す。 */
  async #settleRelocationWorkspaceUnknown(
    job: Job,
    record: ManagerRecord,
    runnerId: string,
  ): Promise<void> {
    const reason = new Error(
      `workspace-path-unknown: 移送先 ${runnerId} は cwd を記録しておらず、runner からも workspacePath を聞けていない`,
    );
    if (await this.#noteRelocationRefusal(record, runnerId, reason)) {
      await this.confirmLost(record, reason);
    } else if (
      record.job.lease?.runnerId === runnerId &&
      record.job.lease.releasedAt === undefined
    ) {
      await this.#journal({
        type: 'decision',
        decision: `[${job.id}] 移送先 ${runnerId} に貸した貸し出しは返していない（以前の回の貸し出しで、セッションが起きていないと確かめられない）`,
        grounds: reasonOf(reason),
      });
    }
  }

  /**
   * 取り直しで投げられた失敗の仕分け: 世代で拒まれたら止める・一時的なら予約する・移送先1台の断りなら見送る・それ以外は lost に確定する。
   * 戻り値は「挑み直しを予約するか」。
   */
  async #classifyReattachError(
    error: unknown,
    record: ManagerRecord,
    jobId: string,
    runnerId: string,
    relocating: boolean,
  ): Promise<boolean> {
    let retry = false;
    this.#reattachBusyRetries.delete(jobId);
    // 一時的にこけたときは自分で予約する: `hello` は SSE が繋がったときにしか来ず、ストリームが安定していれば永久に来ないので、台帳が `running` のまま誰も走っていない仕事が残る。
    if (isFencedRunnerError(error)) {
      // 世代で拒まれた（409）は「戻せなかった」ではない: `lost` にして像から外すと、クローンが新しく起こし直し、fencing の失敗経路から二重実行へ到達する。状態は動かさず挑み直さない（同じ世代で投げ直しても同じ答え）が、台帳の書き込み失敗か別のデーモンの存在を人間が知る必要があるので必ず知らせる。
      await this.#refuseFenced(jobId, error, '取り直しを止めた', '取り直し');
    } else if (isRetryableRunnerError(error)) retry = true;
    else if (
      relocating &&
      isRunnerSpecificRefusal(error) &&
      !(await this.#noteRelocationRefusal(record, runnerId, error))
    ) {
      // 移送先1台の断りは委譲の運命ではない: lost に確定せず `#unresumable` も立てず、この移送先だけ見送る。ほかの候補が引き取れる。
      // この移送先へ貸した貸し出しは返す: 残すとほかの候補の関門が `held` で断り、TTL が切れるまで移れない。4xx は命令を受け取らなかったという答えで、セッションは起きていない（起きていれば 2xx）。
      if (record.job.lease?.runnerId === runnerId && record.job.lease.releasedAt === undefined) {
        record.job.lease = releaseLease(record.job.lease, this.#now());
        await this.#persist(record);
        // 黙って返さない: この契機だけは持ち主自身の `closed` ではなく 4xx の答えに拠っている。
        await this.#journal({
          type: 'decision',
          decision: `[${jobId}] 移送先 ${runnerId} に貸した貸し出しを返した（resume を 4xx で断られ、そこではセッションが起きていない）`,
          grounds: reasonOf(error),
        });
      }
    } else {
      await this.confirmLost(record, error);
    }
    return retry;
  }

  /** 回数で打ち切らない: 残るのは「台帳では走っているのに誰も走っていない仕事」で、この経路が直そうとしている状態そのもの。 */
  scheduleReattach(runnerId: string): void {
    if (this.#reattachTimers.has(runnerId)) return;
    const delay = this.#reattachDelays.get(runnerId) ?? REATTACH_RETRY_BASE_MS;
    this.#reattachDelays.set(runnerId, Math.min(delay * 2, REATTACH_RETRY_MAX_MS));
    const timer = setTimeout(() => {
      this.#reattachTimers.delete(runnerId);
      if (!this.#stopped()) void this.reattach(runnerId, true);
    }, delay);
    timer.unref?.();
    this.#reattachTimers.set(runnerId, timer);
  }

  /** 文面は `unresumableNotice`（`manager-notices.ts`）。ここは日誌と合流窓へ積む副作用だけを持つ。 */
  notifyUnresumable(
    record: ManagerRecord,
    error: unknown,
    cause: 'runner' | 'session' = 'runner',
  ): void {
    const { job } = record;
    const { journal, notice } = unresumableNotice(job, error, cause);
    // 日誌は呼び出し元に委ねない: 経路ごとに呼び出し元の事前の書き込みが違い、「日誌に無い＝この経路を通っていない」を判別器にするには、経路によらず必ず1本書く必要がある。
    void this.#journalExchange('outbound', `${EXCHANGE_KIND_FAILURE_PREFIX}[${job.id}] ${journal}`);
    // 即配らず合流窓へ積む: 委譲が器と一緒に失われた族は `resume_fallback` / `resume_failed` / `closed_failed` の3通で構成され、「一枠落ち一合図」に揃える。
    this.#queueSynthesizedNotice(job.id, 'resume_failed', notice);
  }

  /** 成功として黙らせない: 続きは前のセッションそのものではなく、知らないクローンは「前に渡した細かい指示は効いている」前提で次を積んでしまう。 */
  notifyResumeFallback(record: ManagerRecord, sessionId: string, reason: string): void {
    const { job } = record;
    const body = resumeFallbackBody(job, sessionId, reason);
    // 日誌は呼び出し元にも合流窓の flush にも委ねない: 呼び出し元は理由までしか書かず、flush の1行は内訳（族と通数）だけで、ここで組み立てた拡張文言はどこにも残らない。
    void this.#journalExchange(
      'outbound',
      `${EXCHANGE_KIND_RECOVERY_PREFIX}[${job.id}] （生ログから作り直して続けた）${body}`,
    );
    // 上の `#journal` と同じ `body` を渡す: 同じ文字列を2回組み立てると片方だけ直る事故が起きる。
    this.#queueSynthesizedNotice(job.id, 'resume_fallback', body);
  }

  /**
   * 止めた後は状態を動かさない: `record` は呼び出し側が取った時点の写しで、その後に `abort()` が `stopped` を書いていることがある。冒頭で最新を読み、`stopped` なら日誌にだけ残して戻る。
   * `#retire` も呼ばない: `abort()` が同じ呼びの中で済ませる。
   */
  async confirmLost(record: ManagerRecord, error: unknown): Promise<void> {
    this.#reattachBusyRetries.delete(record.job.id);
    const { job } = record;
    const latest = this.#records.get(job.id)?.job ?? (await this.#latestJobOf(job.id)) ?? job;
    if (latest.status === 'stopped' || job.status === 'stopped') {
      await this.#journal({
        type: 'decision',
        decision: `[${job.id}] 戻せなかったとして確定するのを見送った（止めた後は状態を動かさない。台帳は stopped のまま）`,
        grounds: `確定しようとした理由: ${reasonOf(error)}`,
      });
      return;
    }
    this.#relocationRefusals.delete(job.id);
    // ジョブ側に覚える: runner 単位の `retry` では、同じ runner の別ジョブの予約のたびに巻き込まれる。台帳にも書く: 記憶は器と一緒に消えるが諦めた事実は消えない。
    this.#unresumable.add(job.id);
    record.job.status = 'lost';
    this.#records.set(job.id, record);
    await this.#persist(record);
    this.notifyUnresumable(record, error);
    this.#retire(job.id);
  }

  /** 台帳が読めない回は何もしない: `#listJobsOrNote` が日誌に残し、次の `hello` で再び届く。 */
  async #refuseRelocationsBeforeGate(runnerId: string, duplicates: number): Promise<void> {
    const listed = await this.#listJobsOrNote(
      `runnerId=${runnerId} の併存による移送の見送りを控えられなかった（次の hello で再挑戦する）`,
    );
    if (listed === null) return;
    for (const job of listed) {
      if (this.#stopped()) return;
      if (job.runnerId === undefined || job.runnerId === runnerId) continue;
      if (!isManagerInFlight(job.status)) continue;
      if (this.#unresumable.has(job.id) || !this.#shouldRelocateFrom(job.runnerId)) continue;
      const known = this.#records.get(job.id);
      // 古い写し（ループ先頭の `job`）で確定しない: この間に `abort()` が `stopped` を書いていることがあるので、確定の直前に読み直した行から作る。
      const fresh = known === undefined ? ((await this.#latestJobOf(job.id)) ?? job) : job;
      const record = known ?? { job: { ...fresh }, waiting: [], attached: false };
      const reason = new Error(
        `runnerId=${runnerId} が併存している（${duplicates} 件）ので、移送先として取り直しを見送った`,
      );
      if (await this.#noteRelocationRefusal(record, runnerId, reason)) {
        record.attached = false;
        this.#withdrawWaiting(record, '器を失い、移送先でも引き取れなかった');
        await this.confirmLost(record, reason);
      }
    }
  }

  /**
   * まだ断っていない候補が1台でも居れば確定しない（偽）: その候補の `#reattach` が引き取る。全員が断った回に限り真を返すので無限には試さず、残りを判定できない（名簿に居ない）回は「居ない」側に倒す。
   * 偽のときは残りの候補へ取り直しを予約する: 並行に起こされた候補が `busy` で抜けていた回の拾い直し。
   */
  async #noteRelocationRefusal(
    record: ManagerRecord,
    refusedBy: string,
    error: unknown,
  ): Promise<boolean> {
    const id = record.job.id;
    const refused = this.#relocationRefusals.get(id) ?? new Set<string>();
    // 既に控えにある runner の断りは判断の日誌を書き直さない: 併存の見送りが梯子で繰り返し届いても、同じ (委譲, runner) の断りを積まない。
    const alreadyRefused = refused.has(refusedBy);
    refused.add(refusedBy);
    this.#relocationRefusals.set(id, refused);
    const origin = record.job.runnerId;
    const remaining = new Set(
      this.#runners
        .entries()
        .filter((entry) => entry.runnerId !== undefined && entry.runnerId !== origin)
        .filter((entry) => entry.state === 'connected')
        .map((entry) => entry.runnerId as string)
        .filter((candidate) => !refused.has(candidate)),
    );
    const exhausted = remaining.size === 0;
    if (!alreadyRefused) {
      await this.#journal({
        type: 'decision',
        decision:
          `[${id}] 移送先 ${refusedBy} が resume を断った（その runner の都合として扱う）。` +
          (exhausted
            ? '残りの候補が無いので、戻せなかったものとして確定する'
            : `ほかの候補（${[...remaining].join(', ')}）へ移すのを試す`),
        grounds: reasonOf(error),
      });
    }
    // 残りの候補へ予約する: 並行に起こされた候補の `#reattach` は、この移送先が resume 中だと `busy` で黙って抜けており、予約しないと次の名乗りまで誰にも試されない。
    for (const candidate of remaining) this.scheduleReattach(candidate);
    return exhausted;
  }

  /** runner が実際に開いているセッションの値へ台帳の宛先・cwd・workspace・sessionId を揃える（起動時の引き取りと、移送先に既に居た委譲の取り直しが共有する）。 */
  placementOn(
    runner: RunnerClient,
    state: Awaited<ReturnType<RunnerClient['list']>>[number],
  ): Pick<Job, 'runnerId' | 'cwd' | 'workspace' | 'sessionId'> {
    return {
      runnerId: runner.runnerId,
      cwd: state.cwd,
      workspace: workspaceLocatorFrom(this.#workspace(), runner.runnerId, state.cwd),
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    };
  }

  /**
   * 移送先の一覧に既に居る委譲の台帳を移送先へ揃える: 揃えないと台帳は元の runner を指したままで、移送先から届く出来事が「移った後の古い runner」として捨てられる。
   * 止めた・戻せなかった後は動かさない。像が別の宛先へ移っていたら（古い写し）触らない。
   */
  async #alignToTarget(
    job: Job,
    runner: RunnerClient,
    state: Awaited<ReturnType<RunnerClient['list']>>[number],
  ): Promise<void> {
    const known = this.#records.get(job.id);
    const current = known?.job ?? (await this.#latestJobOf(job.id)) ?? job;
    const again = this.#records.get(job.id);
    if (
      current.runnerId !== job.runnerId ||
      (again?.job.runnerId ?? job.runnerId) !== job.runnerId
    ) {
      return;
    }
    if (current.status === 'stopped' || current.status === 'lost') return;
    const attached = state.status === 'running' || state.status === 'waiting_human';
    const record: ManagerRecord = again ?? {
      job: { ...current },
      waiting: state.waiting,
      attached,
    };
    Object.assign(record.job, this.placementOn(runner, state));
    record.attached = attached;
    this.#records.set(job.id, record);
    await this.#persist(record);
  }
}

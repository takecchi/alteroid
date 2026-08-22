import { randomUUID } from 'node:crypto';

import { parseCron } from './cron.js';
import { isWrittenDailyReport } from './schema.js';
import type { InboxEvent, SchedulePhase, ScheduleSpec, ScheduledRequest } from './schema.js';
import type { JournalStore, ScheduleStore } from './store.js';

/**
 * スケジューラ — 時間起点のジョブ（PRD「自律」の起点②）。
 *
 * 仕事の起点は人間に限らない。ここが人間の不在を埋める側の入口であり、
 * 発火は必ず**クローンの受信箱**へ積む。受信箱を迂回して直接ターンを起こすと、
 * 走行中のターンを踏み潰す（clone.ts の「ターンの起動口は受信箱ただ1つ」）。
 *
 * ここは能力の削除を持ち込みたくなる場所でもある。**実行回数の上限や
 * 「連続で N 回までしか起こさない」といった抑止を置かないこと**（AGENTS.md 地雷2）。
 * 間隔は方針であり設定で開けられるが、走り続ける前提そのものは動かさない。
 */

/** 定期ジョブ1件。次の発火時刻と、そのとき受信箱へ積むイベントだけを知っている。 */
export interface ScheduleEntry {
  /** 一意の名前。人間が `/schedule` や HTTP から手で起こすときの識別子でもある。 */
  kind: string;
  /** 人間向けの説明。 */
  description: string;
  /** `after` より後の最初の発火時刻。 */
  nextAt(after: Date): Date;
  /** 発火時に受信箱へ積むイベント。 */
  event(at: Date): InboxEvent;
  /**
   * 落ちていた間に過ぎた予定を、起き直したときに1回だけ拾うか（省略時は拾う）。
   *
   * **`daily_report` だけが `false` である。** あちらの拾い直しは
   * `missingDailyReportDates`（このファイルの末尾。`apps/daemon/src/index.ts` が起動時に
   * 呼ぶ）が既に持っていて、**日誌に記録がある日だけ**を対象にしている。ここでも拾うと
   * 拾い直しの経路が2つになり、同じ日の日報が二重に立つ。
   *
   * **これは「起こさない」の設定ではない。** 過ぎていた分を今すぐ拾うかどうかだけで、
   * 次の予定は変わらない（回数を絞る類の抑止ではない — AGENTS.md 地雷2）。
   */
  catchUpMissed?: boolean;
}

export interface ScheduleStatus {
  kind: string;
  description: string;
  /** 次の発火時刻（ISO 8601）。 */
  nextAt: string;
  /** 定期の依頼として仕込まれたものだけ（既定の日報・発意には無い）。 */
  request?: string;
  /** 前回この kind で発火した時刻。 */
  lastRunAt?: string;
  /**
   * 仕込まれた時刻。**`request` と同じく、仕込まれたものだけが持つ。**
   *
   * **既定の日報・発意 tick には無い。それは「分からない」ではなく「無い」で
   * ある** — あれはコードに書かれた既定であって、誰かがいつか作ったレコード
   * ではないので、**作成という出来事そのものが存在しない。**
   *
   * だからここに `unknown` を入れないこと。`unknown`（記憶の `createdAt` が
   * 使っている形）は「**在るはずだが根拠が無い**」を表す値で、入れれば
   * **探しに行く人が出る。**
   *
   * **表示の側では「無い」と読める形にすること**（黙って行が短くなるだけに
   * しない。取れないことが出力から消えるのと同じ形になる）。
   */
  createdAt?: string;
  /** 最後に仕込み直された時刻。`createdAt` と同じく、仕込まれたものだけが持つ。 */
  updatedAt?: string;
}

export interface Scheduler {
  /** 時計を動かし始める。 */
  start(): void;
  stop(): void;
  /** 何が仕込まれていて、次はいつ起きるか（可観測性）。 */
  list(): ScheduleStatus[];
  /**
   * 定期ジョブを今すぐ起こす。定期の予定はずらさない（予定に代えて割り込むのでは
   * なく、余分に1回起こす）。知らない kind なら false。
   */
  run(kind: string): boolean;
  /** 期限が来たものを起こす。内部タイマーとテストの共通経路。 */
  tick(now?: Date): string[];
  /**
   * 永続化された「定期の依頼」を読み直して、仕込みを合わせる。
   *
   * **クローンや人間が依頼を足す経路をここへ通す。** スケジューラへ直接 add する
   * 口を作ると、器（ストア）と仕込み（メモリ）の二重管理になり、デーモンを
   * 再起動した瞬間に依頼が消える。真実はストア側だけに置く。
   */
  refresh(): Promise<void>;
  /**
   * 位相の保存が終わるまで待つ。
   *
   * `tick()` / `run()` は同期だが、既定の仕込みの位相はストアへ書く（＝非同期）。
   * **この seam が無いと「位相が保存されたか」をテストから確かめられない**
   * （テストが書けない構造は、テストが無いのと同じである）。挙動は変えないので、
   * 呼ばなくても時計は同じように回る。
   */
  settled(): Promise<void>;
}

export interface SchedulerOptions {
  /** 既定で仕込むもの（日報・発意）。設定で外せるが、依頼で置き換わるものではない。 */
  entries: ScheduleEntry[];
  /** 受信箱へ積む口。 */
  post: (event: InboxEvent) => void;
  /** 主にテスト用。 */
  now?: () => Date;
  /**
   * 継続中の依頼の置き場。渡さなければ既定の定期ジョブだけが回る
   * （`refresh()` は何もしない）。**既定の仕込みの位相もここに置く**ので、渡さない
   * 構成では位相が引き継がれない（＝再起動のたびに `now + 周期` へ戻る）。
   */
  schedules?: ScheduleStore;
  /**
   * 位相を読めなかった・保存できなかったことを外へ出す口。
   *
   * **黙って落とさない。** 落ちても時計は止まらず、影響は「その回をもう一度起こす／
   * 位相を1周期ぶん引き継げない」だけだが、出さないと `putPhase` が永久に失敗して
   * いても誰も気づかない（`grep -c` の 0 が2つの意味を持つのと同じ形）。
   * 省略時は stderr へ出す — **何もしない既定を置くと、渡し忘れた呼び出し側が
   * 静かに失敗する道具に戻る。**
   */
  onError?: (message: string) => void;
}

/**
 * 見張りの間隔の上限。
 *
 * 次の発火が半日先でも、待ち方は最大この間隔で刻む。長い `setTimeout` 1本に
 * 賭けると、蓋を閉じたノートを開いた後や時計が飛んだ後に予定が黙って腐る
 * （常駐は自律の前提なので、そこで止まるのは要件違反になる）。
 */
const MAX_SLEEP_MS = 60_000;

/**
 * 錨（前回それで動いた時刻）から数えた次の予定。**現在時刻を基準にしない。**
 *
 * - 過ぎているなら「いま」（落ちていた間に取りこぼした分を**1回だけ**拾う。
 *   溜まった回数ぶん撃たない）
 * - まだなら本来の予定。ただし `nextAt(now)` より後ろにはしない — 時計のずれや
 *   人為的に未来の日付が入った場合に永久に沈黙しないため（黙って止まるより遅れて
 *   起きる方がよい）
 *
 * **継続中の依頼（`#firstDue`）と既定の仕込み（`#seedBase`）で同じ算術を使うために
 * 切り出してある。** 2箇所に書くと片方だけ直され、「依頼では拾えるのに既定では
 * 拾えない」が戻る（それがこの関数が生まれた原因の欠陥である）。
 *
 * 拾うかどうかの判断（`catchUpMissed`）は entry 側が持つ。
 */
function dueFromSeed(entry: ScheduleEntry, seed: Date, now: Date): Date {
  const fromSeed = entry.nextAt(seed);
  if (fromSeed.getTime() <= now.getTime()) {
    // 拾い直しを別の経路が持っている場合（日報）は、ここでは撃たない。
    return entry.catchUpMissed === false ? entry.nextAt(now) : now;
  }
  return new Date(Math.min(fromSeed.getTime(), entry.nextAt(now).getTime()));
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  return new TimerScheduler(options);
}

class TimerScheduler implements Scheduler {
  /** 既定の仕込み（日報・発意）。 */
  readonly #base: ScheduleEntry[];
  /** 継続中の依頼から作った仕込み。ストアを読み直すたびに合わせ直す。 */
  readonly #requests = new Map<
    string,
    { entry: ScheduleEntry; spec: string; plan: ScheduledRequest }
  >();
  readonly #post: (event: InboxEvent) => void;
  readonly #now: () => Date;
  readonly #store: ScheduleStore | undefined;
  readonly #due = new Map<string, number>();

  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  /** 走行中の読み直し。重ねずに直列に流すための鎖。 */
  #refreshing: Promise<void> | null = null;
  /**
   * この器で配り直した「未完了の発火」の時刻（kind ごと）。
   *
   * 同じ回を配り直すのは1度だけにする。完了できないまま残っているなら、次の器が
   * 引き取るのが正しい（同じ発火を刻みごとに配り続けると、受け取る側から見て
   * 二重の仕事になる）。
   */
  readonly #redelivered = new Map<string, string>();
  readonly #onError: (message: string) => void;
  /**
   * 既定の仕込みの位相（ストアから読んだもの＋この器で進めた分）。
   *
   * 継続中の依頼はここに載せない（あちらの位相は `#requests` の `plan` が持つ）。
   */
  readonly #phases = new Map<string, SchedulePhase>();
  /**
   * 位相をストアから読み終えた既定の仕込み。**2度読まない。**
   *
   * `#reconcile()` はタイマーの刻みごとに走る（`#refreshQuietly`）。毎回読み直すと、
   * **その刻みで進めた `#due` を古い位相で巻き戻す** ＝ 同じ回を刻みごとに撃ち続ける。
   * 読めなかったときは印を付けないので、次の刻みでもう一度試す（瞬断で位相を
   * 永久に捨てない）。
   */
  readonly #seeded = new Set<string>();
  /** 位相の書き込み。**直列**に流す（同じ kind の前後関係が入れ替わらないように）。 */
  #writes: Promise<void> = Promise.resolve();

  constructor({ entries, post, now, schedules, onError }: SchedulerOptions) {
    this.#base = entries;
    this.#post = post;
    this.#now = now ?? (() => new Date());
    this.#store = schedules;
    this.#onError =
      onError ??
      ((message): void => {
        process.stderr.write(`alteroid: ${message}\n`);
      });
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    const now = this.#now();
    for (const entry of this.#entries()) {
      if (!this.#due.has(entry.kind)) this.#due.set(entry.kind, entry.nextAt(now).getTime());
    }
    this.#arm();
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  list(): ScheduleStatus[] {
    const now = this.#now();
    return this.#entries().map((entry) => {
      const plan = this.#requests.get(entry.kind)?.plan;
      // 既定の仕込みの前回時刻は位相が持つ（依頼のものは `plan` 側）。**ここが
      // 空のままだと、再起動のたびに「まだ一度も動いていない」に見える。**
      const lastRunAt = plan?.lastRunAt ?? this.#phases.get(entry.kind)?.lastRunAt;
      return {
        kind: entry.kind,
        description: entry.description,
        nextAt: new Date(this.#due.get(entry.kind) ?? entry.nextAt(now).getTime()).toISOString(),
        ...(plan === undefined
          ? {}
          : { request: plan.request, createdAt: plan.createdAt, updatedAt: plan.updatedAt }),
        ...(lastRunAt === undefined ? {} : { lastRunAt }),
      };
    });
  }

  run(kind: string): boolean {
    const entry = this.#entries().find((candidate) => candidate.kind === kind);
    if (!entry) return false;
    const now = this.#now();
    const event = entry.event(now);
    // 手で起こした1回は観測用の時刻だけ動かす（定期の予定の基準は動かさない）。
    this.#recordPhase(entry, now, 'manual');
    // **手で起こしたことを運ぶ。** 予定をずらさないのはここのメモリ上だけでは足りず、
    // 受け取った側が「定期の予定の基準」を手動実行の時刻へ動かさないことまで要る
    // （動かすと、次にデーモンを作り直した瞬間に位相がずれる）。
    this.#post(event.type === 'timer' ? { ...event, cause: 'manual' } : event);
    return true;
  }

  /**
   * 保存中の書き込みが終わるまで待つ。
   *
   * **1本待てば足りる。** `#recordPhase` は `await` を挟まずに `#writes` を差し替える
   * ので、`tick()` / `run()` から戻った時点で、その回の書き込みは既に鎖の末尾に
   * 入っている。
   *
   * 「増えなくなるまで待つ」ループも書いてみたが、**変異試験で歯が無いことを確かめた**
   * （ループを `await this.#writes` 1行へ潰しても57本すべて通った）。テストが届かない
   * 分岐を残すと、次に読む者がそこに意味を推測することになるので置かない。
   */
  async settled(): Promise<void> {
    await this.#writes;
  }

  /**
   * 読み直しは**直列**にする。
   *
   * タイマーの刻みと、人間が API から足した／外した直後の読み直しは必ず重なりうる。
   * 並行に走らせると、先に読み始めた側が古い一覧で `#requests` を上書きし、
   * 外したはずの依頼が復活する（＝外したと言われた依頼がもう一度起きる）。
   */
  refresh(): Promise<void> {
    const run = (this.#refreshing ?? Promise.resolve()).then(() => this.#reconcile());
    this.#refreshing = run.catch(() => undefined);
    return run;
  }

  async #reconcile(): Promise<void> {
    if (this.#store === undefined) return;
    // 既定の仕込みの位相を先に引き継ぐ（依頼の読み込みが落ちても位相は入る）。
    await this.#seedBase();
    const plans = await this.#store.list();
    const now = this.#now();
    const seen = new Set<string>();

    for (const plan of plans) {
      // 既定の仕込みと同じ名前は乗っ取らせない（日報を「定期の依頼」で潰せてしまう）
      if (this.#base.some((entry) => entry.kind === plan.kind)) continue;
      seen.add(plan.kind);
      const spec = JSON.stringify(plan.spec);
      const existing = this.#requests.get(plan.kind);
      // 終わった発火の記録は捨てる（次に未完了が出たらまた配り直せるように）
      if (plan.pendingRun === undefined) this.#redelivered.delete(plan.kind);
      if (existing?.spec === spec) {
        // 周期が同じなら次の予定はずらさない。lastRunAt だけ新しくする
        existing.plan = plan;
        continue;
      }
      const entry = scheduledRequestEntry(plan);
      this.#requests.set(plan.kind, { entry, spec, plan });
      this.#due.set(plan.kind, this.#firstDue(entry, plan, now).getTime());
    }

    for (const kind of [...this.#requests.keys()]) {
      if (seen.has(kind)) continue;
      this.#requests.delete(kind);
      this.#due.delete(kind);
      this.#redelivered.delete(kind);
    }

    // 仕込みが増えたなら、次の見張りをその予定に合わせ直す
    this.#arm();
  }

  /**
   * 依頼自身の時間軸で次の予定を決める。**現在時刻を基準にしない。**
   *
   * 予定は「前回動いた時刻（無ければ仕込んだ時刻）から数えた次」である。ここを
   * `now` から数え直すと2つ壊れる。
   *
   * 1. **`every` が再起動のたびに後ろへずれる。** 08:00 に仕込んだ60分ごとの依頼は
   *    09:00 が初回だが、08:30 に起き直した瞬間に 09:30 へ動く。周期より短い間隔で
   *    再起動していれば**一度も発火しない**（`/run` で `lastRunAt` が付いた後も同じ）
   * 2. 手で起こしても「定期の予定はずらさない」という `run()` の約束が崩れる
   *
   * 逆に、その予定が既に過ぎているなら落ちていた間に取りこぼしているので、いま
   * 起こす。日報の後追い（`missingDailyReportDates`）と同じ考え方で、**1回だけ**拾う
   * （溜まった回数ぶん撃たない）。
   */
  #firstDue(entry: ScheduleEntry, plan: ScheduledRequest, now: Date): Date {
    // **引き受けたまま終わっていない発火があるなら、まずそれを配り直す。**
    // claim の直後に器が落ちると、モデルには何も届いていないのに印だけが残る。
    // ここで拾わないと、日次なら翌日・週次なら翌週までその回が消える。
    if (plan.pendingRun !== undefined) return now;

    // 基準は**定期の予定で動いた時刻**。`lastRunAt`（手で起こした分も動く）を使うと、
    // 人間が余分に1回起こすたびに位相が動く（`run()` は予定をずらさない契約である）。
    const seed = new Date(plan.lastScheduledRunAt ?? plan.createdAt);
    if (Number.isNaN(seed.getTime())) return entry.nextAt(now);

    return dueFromSeed(entry, seed, now);
  }

  /**
   * 既定の仕込み（日報・発意 tick）の位相を、器を作り直しても引き継ぐ。
   *
   * `start()` は既定の仕込みへ `now + 周期` を置くだけなので、これが無いと
   * **再起動のたびに位相が捨てられる**（周期より短い間隔で器が入れ替わっていれば
   * 一度も発火しない）。継続中の依頼について `#firstDue` が塞いでいる穴と同じもので、
   * 既定の2件だけがストアに何も持っていなかったために残っていた。
   *
   * **1度読んだら読み直さない。** 理由は `#seeded` に書いてある。
   */
  async #seedBase(): Promise<void> {
    const store = this.#store;
    if (store === undefined) return;
    for (const entry of this.#base) {
      if (this.#seeded.has(entry.kind)) continue;
      let phase: SchedulePhase | null;
      try {
        phase = await store.getPhase(entry.kind);
      } catch (error) {
        // 印を付けないので次の刻みでもう一度試す。**黙って諦めない。**
        this.#onError(
          `定期ジョブ ${entry.kind} の位相を読めなかった（次の刻みで読み直す）: ${String(error)}`,
        );
        continue;
      }
      this.#seeded.add(entry.kind);
      if (phase === null) continue;
      this.#phases.set(entry.kind, phase);
      // 一度も定期で動いていないなら、位相は無いのと同じ（`start()` に任せる）。
      if (phase.lastScheduledRunAt === undefined) continue;
      const seed = new Date(phase.lastScheduledRunAt);
      if (Number.isNaN(seed.getTime())) continue;
      this.#due.set(entry.kind, dueFromSeed(entry, seed, this.#now()).getTime());
    }
  }

  /**
   * 既定の仕込みの位相を進める。**継続中の依頼には触らない**（あちらの位相は
   * `claimRun` / `completeRun` がストア側で持っている）。
   *
   * `cause === 'manual'` では `lastScheduledRunAt` を動かさない（`run()` の
   * 「定期の予定はずらさない」契約。混ぜると手動実行のたびに位相が動く）。
   *
   * **依頼側より弱いことを承知で発火の瞬間に進める。** 既定の仕込みには引き受けの印
   * （`pendingRun`）が無いので、「引き受けたが終わっていない」を表せない。したがって
   * 発火の直後に器が落ちると、**その1回は配り直されない**（1回少ない側へ倒れる）。
   * ここを「完了時に進める」へ変えると、逆に完了を記録できないまま落ちた回が刻みごとに
   * 撃たれ続ける（受け取る側から見て二重の仕事になる）。**強い側に見せないこと。**
   */
  #recordPhase(entry: ScheduleEntry, at: Date, cause: 'schedule' | 'manual'): void {
    const store = this.#store;
    if (store === undefined) return;
    if (!this.#base.some((base) => base.kind === entry.kind)) return;

    const stamp = at.toISOString();
    const carried = this.#phases.get(entry.kind)?.lastScheduledRunAt;
    const scheduled = cause === 'schedule' ? stamp : carried;
    const phase: SchedulePhase = {
      kind: entry.kind,
      lastRunAt: stamp,
      ...(scheduled === undefined ? {} : { lastScheduledRunAt: scheduled }),
    };
    this.#phases.set(entry.kind, phase);
    this.#writes = this.#writes.then(async () => {
      try {
        await store.putPhase(phase);
      } catch (error) {
        this.#onError(
          `定期ジョブ ${entry.kind} の位相を保存できなかった（この回を次の起動でもう一度起こす側に倒れる）: ${String(error)}`,
        );
      }
    });
  }

  #entries(): ScheduleEntry[] {
    return [...this.#base, ...[...this.#requests.values()].map((held) => held.entry)];
  }

  tick(now: Date = this.#now()): string[] {
    const fired: string[] = [];
    for (const entry of this.#entries()) {
      const due = this.#due.get(entry.kind);
      if (due === undefined || due > now.getTime()) continue;

      // 引き受けたまま終わっていない発火は、**元の発火として**配り直す。
      const resume = this.#resumable(entry.kind);
      if (resume !== undefined) {
        // 同じ回を何度も配り直さない（次の器が引き取る。**これは回数制限ではなく、
        // 同じ発火を二重に配らないための識別である** — AGENTS.md 地雷2）。
        this.#redelivered.set(entry.kind, resume.at);
        // **配り直す発火の同一性と、次の定期予定の時間軸は別物である。**
        // 次の予定は定期の時間軸（基準＝定期で動いた時刻、無ければ仕込んだ時刻）から
        // 数える。配り直した発火の時刻から数えると、手で起こした1回が予定を動かし
        // （`manual` の pending で位相がずれる）、長く止まっていた場合は過去の時刻が
        // 次回になって直後に余分な発火が続く。
        // 次の予定は依頼の格子の上で決まる（`nextAt` が錨から数えるので、配り直した
        // 発火の時刻や現在時刻で位相が動かない）。過去を残さないので余分な発火も続かない。
        this.#due.set(entry.kind, entry.nextAt(now).getTime());
        fired.push(entry.kind);
        const event = entry.event(now);
        this.#post(
          event.type === 'timer' ? { ...event, at: resume.at, cause: resume.cause } : event,
        );
        continue;
      }

      // 次の予定を先に決める。イベント投入で例外が出ても、同じ発火を
      // 取りこぼしなく繰り返し続ける（＝暴走する）ことがないように。
      this.#due.set(entry.kind, entry.nextAt(now).getTime());
      fired.push(entry.kind);
      // 位相も post の前に進める（`#due` と同じ理由）。既定の仕込みだけが対象で、
      // 失敗しても時計は止まらない（`#recordPhase` に倒れる向きを書いてある）。
      this.#recordPhase(entry, now, 'schedule');
      this.#post(entry.event(now));
    }
    return fired;
  }

  /**
   * 配り直すべき「引き受けたまま終わっていない発火」があるか。
   *
   * **元の時刻と理由をそのまま返す。** ここで現在時刻に置き換えると、完了時に
   * 記録される基準が復旧時刻になって位相がずれ、手動実行が定期の予定を動かす。
   */
  #resumable(kind: string): { at: string; cause: 'schedule' | 'manual' } | undefined {
    const pending = this.#requests.get(kind)?.plan.pendingRun;
    if (pending === undefined) return undefined;
    return this.#redelivered.get(kind) === pending.at ? undefined : pending;
  }

  #arm(): void {
    if (!this.#started) return;
    if (this.#timer !== null) clearTimeout(this.#timer);

    const now = this.#now().getTime();
    const next = Math.min(...[...this.#due.values()], now + MAX_SLEEP_MS);
    const delay = Math.min(Math.max(next - now, 0), MAX_SLEEP_MS);

    this.#timer = setTimeout(() => {
      this.#timer = null;
      void (async () => {
        try {
          // 依頼が増減していればこの刻みで拾う。仕込みの真実はストア側にしか無い
          // ので、ここを通らないと「足したのに起きない」が起きる。
          await this.#refreshQuietly();
          // **待っている間に止められていたら、もう起こさない。** ここを見ないと
          // シャットダウン中（クローンが最後の蒸留をしている間）に新しいターンが
          // 走り、マネージャーまで起きうる。
          if (!this.#started) return;
          this.tick();
        } finally {
          this.#arm();
        }
      })();
    }, delay);
  }

  /**
   * 記憶の器の瞬断で時計を止めない。
   *
   * 読めなかったときに既に仕込んである予定を捨てないこと（捨てると、DB が
   * 一瞬揺れただけで継続中の依頼が黙って消える）。
   */
  async #refreshQuietly(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      // 次の刻みで読み直す
    }
  }
}

// ---------------------------------------------------------------------------
// 定期ジョブの実例
// ---------------------------------------------------------------------------

export interface TimeOfDay {
  hour: number;
  minute: number;
}

/** `HH:MM` を読む。読めなければ null（呼び出し側が既定値へ落とす）。 */
export function parseTimeOfDay(value: string): TimeOfDay | null {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!matched) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** ローカル時刻での `YYYY-MM-DD`。日報の対象日は人間の一日に合わせる。 */
export function localDate(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, '0');
  const day = `${at.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** ローカル時刻でのその日の 00:00。 */
export function startOfLocalDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), 0, 0, 0, 0);
}

/**
 * `YYYY-MM-DD` のローカル1日ぶんの範囲。読めない・存在しない日付なら null。
 *
 * **形だけ見て通してはいけない。** `Date` は `2026-02-31` や `0000-00-00` を黙って
 * 別の日に繰り上げ／繰り下げるので、そのまま日報の対象日や検索範囲に使うと、
 * 書いた日と読める日がずれる（人間が読もうとして読めない = 可観測性のバグ）。
 */
export function localDayRange(date: string): { since: Date; until: Date } | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]) - 1;
  const day = Number(matched[3]);
  const since = new Date(year, month, day, 0, 0, 0, 0);
  // 繰り上がっていれば、その日付は存在しない
  if (localDate(since) !== date) return null;
  return { since, until: new Date(year, month, day + 1, 0, 0, 0, 0) };
}

function atTimeOnDay(day: Date, time: TimeOfDay): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute, 0, 0);
}

/** 日報の発火イベント。対象日を運ぶのはここ1箇所に寄せる（後追いの生成でも同じ形）。 */
export function dailyReportEvent(target: string, at: Date = new Date()): InboxEvent {
  return {
    type: 'timer',
    id: randomUUID(),
    at: at.toISOString(),
    kind: DAILY_REPORT_KIND,
    target,
  };
}

export const DAILY_REPORT_KIND = 'daily_report';

/**
 * 日報 — 時間起点ジョブの最初の実例（PRD「可観測性」）。
 *
 * 1日の終わりに、その日を締める。締め時刻に発火し、対象日は**発火時刻の
 * ローカル日付**である。
 */
export function dailyReportEntry(options: { at: TimeOfDay }): ScheduleEntry {
  const { at } = options;
  const label = `${`${at.hour}`.padStart(2, '0')}:${`${at.minute}`.padStart(2, '0')}`;

  return {
    kind: DAILY_REPORT_KIND,
    description: `毎日 ${label}（ローカル時刻）にその日の日報をまとめる`,
    // **拾い直しはここではやらない。** 締め時刻を過ぎた日の後追いは
    // `missingDailyReportDates` が持っていて、**日誌に記録がある日だけ**を対象に
    // している（動いていなかった日に空の日報を積まないため）。両方で拾うと同じ日の
    // 日報が二重に立つ ＝ 人間が読む唯一の層が汚れる。
    catchUpMissed: false,
    nextAt(after) {
      const today = atTimeOnDay(after, at);
      if (today.getTime() > after.getTime()) return today;
      const tomorrow = new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1);
      return atTimeOnDay(tomorrow, at);
    },
    event(firedAt) {
      return dailyReportEvent(localDate(firedAt), firedAt);
    },
  };
}

export const SELF_INITIATIVE_KIND = 'self_initiative';

/**
 * クローンの発意 — 起点④（PRD「自律」）。
 *
 * これが無いものは自律とは呼ばない。「何もしない」という結論も含めて、
 * 次にやることを決めるのはクローンであって、ここではない。
 */
export function selfInitiativeEntry(options: { everyMinutes: number }): ScheduleEntry {
  const { everyMinutes } = options;
  const interval = Math.max(1, Math.floor(everyMinutes)) * 60_000;

  return {
    kind: SELF_INITIATIVE_KIND,
    description: `${Math.max(1, Math.floor(everyMinutes))} 分ごとに、記憶にある目的から次にやることを決める`,
    nextAt(after) {
      return new Date(after.getTime() + interval);
    },
    event(firedAt) {
      return {
        type: 'self_initiative',
        id: randomUUID(),
        at: firedAt.toISOString(),
        reason: '定期 tick: 記憶にある目的から次にやることを決める',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 継続中の依頼（クローンと人間が後から仕込む時間起点）
// ---------------------------------------------------------------------------

/** 既定の仕込みの名前。依頼で乗っ取らせない。 */
export const RESERVED_SCHEDULE_KINDS: readonly string[] = [DAILY_REPORT_KIND, SELF_INITIATIVE_KIND];

/** 読めない指定を落とす先（沈黙させないため）。 */
const MIDNIGHT: TimeOfDay = { hour: 0, minute: 0 };

/** 人間が `/schedule` で読む周期の言い方。 */
export function describeScheduleSpec(spec: ScheduleSpec): string {
  if (spec.type === 'daily') {
    const time = parseTimeOfDay(spec.at);
    const label =
      time === null
        ? spec.at
        : `${`${time.hour}`.padStart(2, '0')}:${`${time.minute}`.padStart(2, '0')}`;
    return `毎日 ${label}（ローカル時刻）`;
  }
  if (spec.type === 'cron') {
    // 読めない式は保存できないが、人間が手でストアを直すことはある。**黙って
    // 別の時刻で走らせない** — 一覧で壊れていることが分かるようにする。
    return parseCron(spec.expression) === null
      ? `cron: ${spec.expression}（読めないので毎日 00:00 に起こす）`
      : `cron: ${spec.expression}（ローカル時刻）`;
  }
  return `${spec.minutes} 分ごと`;
}

/**
 * 継続中の依頼1件を仕込みに変える。
 *
 * **依頼の本文をイベントに載せない。** 受信箱に載せた瞬間に、それは発火した時点の
 * 写しになる（人間が依頼を書き換えても古い本文で走る）。運ぶのは `kind` だけで、
 * 本文はクローンが処理する瞬間にストアから読む。
 */
export function scheduledRequestEntry(plan: ScheduledRequest): ScheduleEntry {
  const description = `${describeScheduleSpec(plan.spec)}: ${plan.request.replace(/\s+/g, ' ').trim()}`;

  const spec = plan.spec;

  /**
   * 読めない指定で沈黙させないための最後の砦。
   *
   * 保存の時点で弾いているので通常は来ないが、人間がストアを手で直すことはある。
   * **黙って止まるより、毎日 00:00 に起こして一覧で壊れていると見せる**
   * （`describeScheduleSpec` がその旨を書く）。
   */
  const dailyAt = (after: Date, at: TimeOfDay): Date => {
    const today = atTimeOnDay(after, at);
    if (today.getTime() > after.getTime()) return today;
    const tomorrow = new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1);
    return atTimeOnDay(tomorrow, at);
  };

  /**
   * 「N 分ごと」の格子は**仕込んだ時刻に錨を打つ**。
   *
   * `after + N分` にすると、格子が呼ばれた時刻に依存して毎回動く。落ちて起き直した
   * ときや手で1回起こしたときに位相がずれるのは、そこが原因だった。錨から数えれば、
   * どれだけ止まっていても次の予定は必ず元の系列（錨 + N分の倍数）の上に載る。
   *
   * **除算で直接求める。** 1回ずつ辿って上限で諦める形にすると、長く止まったときだけ
   * 現在時刻基準へ落ちて同じ穴が開く（1分ごとなら2週間の停止で到達する）。
   *
   * 錨より前を尋ねられたら（時計のずれ・未来の日付の手編集）錨を待たずに `after + N分`
   * を返す。**黙って何年も沈黙するより遅れて起きる方がよい。**
   */
  const anchor = new Date(plan.createdAt);
  const everyAfter = (after: Date, minutes: number): Date => {
    const interval = Math.max(1, Math.floor(minutes)) * 60_000;
    const base = anchor.getTime();
    if (Number.isNaN(base) || after.getTime() < base) {
      return new Date(after.getTime() + interval);
    }
    const steps = Math.floor((after.getTime() - base) / interval) + 1;
    return new Date(base + steps * interval);
  };

  const nextAt = (after: Date): Date => {
    if (spec.type === 'daily') {
      return dailyAt(after, parseTimeOfDay(spec.at) ?? { hour: 0, minute: 0 });
    }
    if (spec.type === 'cron') {
      // cron はカレンダー上の絶対系列なので、`nextAfter(now)` 自体が系列の上にある
      return parseCron(spec.expression)?.nextAfter(after) ?? dailyAt(after, MIDNIGHT);
    }
    return everyAfter(after, spec.minutes);
  };

  return {
    kind: plan.kind,
    description,
    nextAt,
    event(firedAt) {
      return {
        type: 'timer',
        id: randomUUID(),
        at: firedAt.toISOString(),
        kind: plan.kind,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 取りこぼした日報の後追い
// ---------------------------------------------------------------------------

export interface MissingDailyReportsInput {
  journal: JournalStore;
  /** 締め時刻。この時刻を過ぎた日だけが「締められる日」である。 */
  at: TimeOfDay;
  now: Date;
  /** 何日前まで遡って探すか。 */
  lookbackDays: number;
}

/**
 * 日報が無いまま過ぎた日を探す（古い順）。
 *
 * デーモンが締め時刻に動いていなければ、その日の日報は誰も作らない。「日報が毎日
 * 生成される」は受け入れ基準なので、起動時にここで拾い直す。
 *
 * **日誌に何も無い日は対象にしない。** 動いていなかった日に空の日報を積むのは、
 * 人間が読む唯一の層をノイズで埋めることにしかならない。
 *
 * **「書けなかった」の印が付いた行（`unavailable`）は日報として数えない。**
 * 数えると、ターンが失敗して印だけが残った日が以後この後追いの対象から永久に
 * 外れる ＝ その日の本物の日報は二度と書かれない（`schema.ts` の
 * `isWrittenDailyReport` の doc に経緯）。
 */
export async function missingDailyReportDates({
  journal,
  at,
  now,
  lookbackDays,
}: MissingDailyReportsInput): Promise<string[]> {
  const days = Math.max(0, Math.floor(lookbackDays));
  if (days === 0) return [];

  const oldest = startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
  const entries = await journal.list({ since: oldest.toISOString() });

  const reported = new Set<string>();
  const active = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'daily_report') {
      // 印の行は「まだ書けていない」ので数えない。**`continue` は残す** —
      // 日報の行そのものは「その日に活動があった」証拠には使わない（活動は
      // 失敗を記録した日誌の行が持っている）。
      if (isWrittenDailyReport(entry)) reported.add(entry.date);
      continue;
    }
    active.add(localDate(new Date(entry.at)));
  }

  const missing: string[] = [];
  for (let back = days; back >= 0; back -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    // 締め時刻を迎えていない日はまだ締められない（今日は大抵ここで外れる）
    if (atTimeOnDay(day, at).getTime() > now.getTime()) continue;
    const date = localDate(day);
    if (reported.has(date) || !active.has(date)) continue;
    missing.push(date);
  }
  return missing;
}

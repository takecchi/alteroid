import { noteWithheldReportsDiscarded } from './dropped-record.js';
import { excerptLine } from './excerpt.js';
import type { ManagerAwaitingBackground, ManagerRecord } from './manager.js';
import {
  classifyManagerActivity,
  describeManagerActivityForFlush,
  type ManagerActivityInput,
} from './manager-activity.js';
import type { Job } from './schema.js';
import {
  WITHHELD_REPORT_EXCERPT,
  WITHHELD_REPORT_LISTING_BUDGET,
  WITHHELD_REPORT_LISTING_BUDGET_BEFORE_SAVING,
  describeBackgroundWaitElapsed,
  renderWithheldExcerpts,
  trimWithheldExcerpts,
  withheldReportOverdue,
} from './withheld-reports.js';

/**
 * 正はこのプロセス内の在庫で、書き換えるたびに台帳（`Job.withheldReports`）へ写す（`WithheldReportsStore#set`）。
 * 写さないとデーモンの再起動（夜の反映）で件数も冒頭も消え、配る前だった報告がクローンに一度も届かない（#4626）。
 * `restore()` が台帳の写しから組み直す。全文は `case 'report'` が積む前に書く日誌の `exchange` に在る。
 */
export type WithheldReportMemory = NonNullable<Job['withheldReports']>;

// 欄の意味は型の正（`schema.ts` の `jobSchema.withheldReports`）とここで二重に持たない。各欄の約束:
// - `count`: 次の本物の報告・`flush()`・`closed` で配って0へ戻る。
// - `lastAt`: `flush()` の期限判定はここを見る。
// - `excerpts`: エピソード中に畳んだ報告の冒頭（古い順）。**最後の1本だけを持たない**: 上書きすると、マージの報告のような重要な本文が後続の畳んだ報告で消える。
//   `'flush'` で配った分は `count` と一緒に空へ戻す。積むときに配るときと同じ予算の内へ詰める（`trimWithheldExcerpts`）。
// - `taskCount`: **`count`（積んだ報告の本数）とは別物で、1つに畳まない。** 前者は配り直しの話、後者は待ち時間の話で、読み手の次の一手が違う。
// - `flushedAt`: 経過時間の出所にしない（いつから待っているかは `firstAt` だけが持つ）。`withhold` はこの欄を持ち越す: 持ち越さないと印が消えて「エピソードにつき1本だけ」が壊れる。

export interface WithheldReportsStoreDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  persist: (record: ManagerRecord) => Promise<void>;
  now: () => number;
  nowIso: () => string;
  /** `Pool` が組み立ての後ろで決める値なので、読むときに引く。 */
  tokenSavingExcerpt: () => boolean;
  withheldReportFlushMs: () => number;
  /** 期限を過ぎた在庫を配る。`Pool#emit` の `'report'` ・`'flush'` の形。 */
  emitFlush: (managerId: string, text: string) => void;
}

/**
 * 握り潰した「背景処理の完了待ちで畳んだ報告」の在庫（{@link WithheldReportMemory}）と、窓へ運ぶ途中の在庫。
 * `Pool#deliver` が次に配る `text` の末尾へ1行足して空にする: 日誌は引きに行かないと気づけず、
 * 握り潰しすぎて本物の報告を消していないかをクローンが確かめる手段が要る。
 *
 * 2つの Map は `TurnEndWatch`（`reports`）と `QuotaStopWindows`（`carriedToWindow`）へ同じ参照で渡す。別の Map を作らないこと。
 * メソッドは全部同期で、`await` を持たない（`Pool#deliver` の中で順を崩さないため）。
 */
export class WithheldReportsStore {
  /** 在庫。`#set` だけが書く（台帳の写しを書き忘れる経路を作らないため）。 */
  readonly reports = new Map<string, WithheldReportMemory>();
  /**
   * `closed` が合流窓へ積んだとき、`Pool#retire()` に消される前に移した `reports` の在庫。
   * 窓の flush の `Pool#deliver` が末尾へ運んで消す（運ぶ先が窓なので、在庫のままでは `retire()` で失われる）。委譲1本につき高々1件。
   */
  readonly carriedToWindow = new Map<string, WithheldReportMemory>();
  readonly #records: WithheldReportsStoreDeps['records'];
  readonly #persist: WithheldReportsStoreDeps['persist'];
  readonly #now: () => number;
  readonly #nowIso: () => string;
  readonly #tokenSavingExcerpt: () => boolean;
  readonly #withheldReportFlushMs: () => number;
  readonly #emitFlush: WithheldReportsStoreDeps['emitFlush'];

  constructor(deps: WithheldReportsStoreDeps) {
    this.#records = deps.records;
    this.#persist = deps.persist;
    this.#now = deps.now;
    this.#nowIso = deps.nowIso;
    this.#tokenSavingExcerpt = deps.tokenSavingExcerpt;
    this.#withheldReportFlushMs = deps.withheldReportFlushMs;
    this.#emitFlush = deps.emitFlush;
  }

  get(managerId: string): WithheldReportMemory | undefined {
    return this.reports.get(managerId);
  }

  has(managerId: string): boolean {
    return this.reports.has(managerId);
  }

  /**
   * エピソードにつき1本だけ配る: 在庫ごと `delete` すると周期のたびに同じ合図が立ち直るため。
   * 配らない回も畳まない（次の本物の報告か `case 'closed'` で件数ごと配る）。
   * 判定が変わったときの立て直しや、基準を `lastAt` から `firstAt` へ変えることはしない:
   * 変化は `manager_list` で読め、後者は別の面の話のため。
   */
  flush(): void {
    const now = this.#now();
    for (const [managerId, memory] of [...this.reports.entries()]) {
      try {
        if (memory.flushedAt !== undefined) continue;
        if (memory.count === 0) continue;
        if (!withheldReportOverdue(memory.lastAt, now, this.#withheldReportFlushMs())) continue;
        const activity = classifyManagerActivity(
          this.#activityInputOfRecord(this.#records.get(managerId)),
        );
        this.#emitFlush(
          managerId,
          `[${managerId}] 背景処理の完了待ちで畳んだ報告が、次のターンの完了を` +
            `${String(Math.round(this.#withheldReportFlushMs() / 60_000))}分待っても届かなかった。` +
            'まとめて配る。' +
            describeBackgroundWaitElapsed(memory.firstAt, now) +
            describeManagerActivityForFlush(activity),
        );
      } catch {
        // 1件の失敗で残りを止めない。
      }
    }
  }

  /** `record` が無いときは「観測が無い」として渡す: `'unknown'` に落ち、`'active'`（進んでいる）へは倒れない。 */
  #activityInputOfRecord(record: ManagerRecord | undefined): ManagerActivityInput {
    if (record === undefined) return { waitingCount: 0 };
    return {
      turnEndReason: record.turnEndReason,
      turnEndedAt: record.turnEndedAt,
      lastReportAt: record.job.lastReportAt,
      toolUseStallPending: record.toolUseStallPending,
      waitingCount: record.waiting.length,
    };
  }

  // 引き取った委譲の台帳の写しから、畳んだ報告の在庫を組み直す（#4626）。プロセス内に既に在る在庫は上書きしない: そちらが新しい
  rebuildFromLedger(): void {
    for (const [managerId, record] of this.#records) {
      const copy = record.job.withheldReports;
      if (copy === undefined || this.reports.has(managerId)) continue;
      this.reports.set(managerId, copy);
    }
  }

  // `new Date()` を直接使わず `this.#now()` を使う: `lastAt` は `flush()` が `this.#now()` との差分で期限を判定する材料で、時計が違うと注入したテストで期限判定を検査できない。
  withhold(
    managerId: string,
    text: string,
    awaitingBackground: { count: number; breakdown: string },
  ): void {
    const now = this.#nowIso();
    const existing = this.reports.get(managerId);
    this.#set(managerId, {
      count: (existing?.count ?? 0) + 1,
      firstAt: existing?.firstAt ?? now,
      lastAt: now,
      excerpts: trimWithheldExcerpts(
        [
          ...(existing?.excerpts ?? []),
          { at: now, line: excerptLine(text, WITHHELD_REPORT_EXCERPT) },
        ],
        this.#listingBudget(),
      ),
      breakdown: awaitingBackground.breakdown,
      // 在り高は足さず上書きする: `awaitingBackground.count` は runner がその回に見た在り高で増分ではなく、足すと二重に数える。
      taskCount: awaitingBackground.count,
      // `flushedAt` は持ち越す: オブジェクトを作り直すので、落とすと `flush()` の「エピソードにつき1本だけ」が壊れる。
      ...(existing?.flushedAt === undefined ? {} : { flushedAt: existing.flushedAt }),
    });
  }

  #listingBudget(): number {
    return this.#tokenSavingExcerpt()
      ? WITHHELD_REPORT_LISTING_BUDGET
      : WITHHELD_REPORT_LISTING_BUDGET_BEFORE_SAVING;
  }

  // 在庫を書き換えるのはここだけにする: 台帳の写し（`Job.withheldReports`）を書き忘れる経路を作らないため（#4626）
  // 書き込みを待たない: 呼び手（`Pool#deliver` など）は同期で、台帳が書けなくても配る・畳むは止めない（`persist` が失敗の跡を残す）
  #set(managerId: string, memory: WithheldReportMemory | undefined): void {
    if (memory === undefined) this.reports.delete(managerId);
    else this.reports.set(managerId, memory);
    const record = this.#records.get(managerId);
    if (record === undefined) return;
    if (memory === undefined) {
      if (record.job.withheldReports === undefined) return;
      delete record.job.withheldReports;
    } else {
      record.job.withheldReports = memory;
    }
    void this.#persist(record);
  }

  // `WithheldReportMemory` をそのまま外へ出さない: `lastText` は報告の本文そのもので、一覧に全文を載せない（`listing-and-detail`）。
  // 読むだけで在庫は動かさない: 一覧を開いて握り潰しが配られると、`manager_list` のたびに受信箱が動く。
  awaitingBackgroundOf(managerId: string): ManagerAwaitingBackground | undefined {
    const withheld = this.reports.get(managerId);
    if (withheld === undefined) return undefined;
    return {
      tasks: withheld.taskCount,
      withheldReports: withheld.count,
      breakdown: withheld.breakdown,
      since: withheld.firstAt,
    };
  }

  /**
   * 配る `text` の末尾へ足す1行を付けて返し、在庫を配った状態へ進める。`appended` は足したかどうか（足したら、呼び手は畳んでよい印を外す）。
   * 同期のまま保つ（`Pool#deliver` の中で「持ち越し → 登録 → 取り出し → 流す」の順を崩さない）。
   */
  takeForDelivery(
    managerId: string,
    text: string,
    withheldSuffixDetail: 'full' | 'flush',
  ): { text: string; appended: boolean } {
    // 窓へ移した在庫（`closed` が積んだ分）は、この配りで運んで消す。普通の在庫が在れば（窓の後に積み直されることは無いが）そちらを先にする。
    const carried = this.carriedToWindow.get(managerId);
    if (carried !== undefined && this.reports.get(managerId) === undefined) {
      this.#set(managerId, carried);
    }
    this.carriedToWindow.delete(managerId);
    const withheld = this.reports.get(managerId);
    if (withheld === undefined) return { text, appended: false };
    // `'flush'` は在庫を `delete` しない: `firstAt` が失われ、次に積んだ回が新しいエピソードとして数え直され、`flush()` が何度でも合図を立て直せてしまう。
    if (withheldSuffixDetail === 'flush') {
      this.#set(managerId, {
        ...withheld,
        count: 0,
        // 配った分の冒頭は空へ: 次に配るときに同じ行を重ねない（flush 後に積んだ分だけが次の一覧に入る）。
        excerpts: [],
        flushedAt: this.#nowIso(),
      });
    } else {
      this.#set(managerId, undefined);
    }
    // `count === 0` のときは足さない: フラッシュ直後は在庫が `count: 0` で残っており、足すと「0 本配っていない」という嘘の1行が出る。
    if (withheld.count === 0) return { text, appended: false };
    // `'flush'` でも抜粋を付ける: 件数だけだと、マージの報告のような本文がクローンから見えないまま日誌にだけ残る。
    // 「少し前・少し後」と書く: 日誌の `exchange` は在庫を積む（`firstAt` / `lastAt`）より前に書かれ、`until` は含まないため、端の時刻そのままだと両端の報告を外す。
    return {
      text:
        `${text}\n\n（この間に、背景処理の完了待ちで畳んだターンの報告を ` +
        `${String(withheld.count)} 本配っていない（最初 ${withheld.firstAt} / ` +
        `最後 ${withheld.lastAt}）。全文は日誌に在る（\`journal_read q=${managerId}\` ` +
        `since=最初の少し前 until=最後の少し後）。\n` +
        `畳んだ報告の冒頭（古い順）:\n${renderWithheldExcerpts(withheld.excerpts, withheld.count, this.#listingBudget())}\n）`,
      appended: true,
    };
  }

  /**
   * `closed` が合流窓へ積むとき、在庫は `Pool#retire()` が消すので、窓の flush（`takeForDelivery`）が運べるよう先に移す。
   * 移した分は `retire()` の「握り潰したまま終わった」の stderr にも出ない（配るので捨てていない）。
   */
  carryToWindow(managerId: string, memory: WithheldReportMemory): void {
    this.carriedToWindow.set(managerId, memory);
    this.#set(managerId, undefined);
  }

  /**
   * `abort` が止めた旨の知らせへ足す文（無ければ空）。`retire()` が在庫を消すので、読むのは必ずその前。
   * 中身（`lastText`）は載せない（R4）: 「止めた後は受信箱へ回さない」を覆さず、「積みが在った」事実の告知だけにする。
   */
  stoppedNote(managerId: string): string {
    const withheld = this.reports.get(managerId);
    // `count > 0` を条件にする: フラッシュ済みの在庫が残っていると、`withheld !== undefined` だけでは「報告を 0 本抱えたまま止まった」という嘘の1行が出る。
    if (withheld === undefined || withheld.count === 0) return '';
    return (
      ` このマネージャーは、背景処理の完了待ちで畳んだ報告を ${String(withheld.count)} ` +
      `本抱えたまま止まった（最初 ${withheld.firstAt} / 最後 ${withheld.lastAt}）。` +
      'もう配られない（R4「止めた後は受信箱へ回さない」）。全文は日誌に在る（`journal_read`）。'
    );
  }

  /**
   * 担当を外す（`Pool#retire`）。像（`records`）を外す前に呼ぶこと:
   * 台帳の写しは像から引いて下ろすので、外した後は引けず、終えた委譲の台帳に古い在庫が残って次の `restore()` が組み直す。
   */
  retire(managerId: string): void {
    const retiringRecord = this.#records.get(managerId);
    if (retiringRecord?.job.withheldReports !== undefined) {
      delete retiringRecord.job.withheldReports;
      void this.#persist(retiringRecord);
    }
    // 握り潰した報告を静かに畳んでよい理由は、全文が日誌の `type: 'exchange'` に残っているから（`decision` 側は冒頭抜粋だけ）。
    // 受信箱へ流して起こすのは `abort()` の「止めた後は回さない」を覆すので流さず、握り潰したまま終わった事実だけを stderr へ残す。
    // 呼び出し元で分岐させずここに置く: どの呼び出し元でも同じ1行が漏れなく残る。
    const withheldBeforeDelete = this.reports.get(managerId);
    if (withheldBeforeDelete !== undefined && withheldBeforeDelete.count > 0) {
      noteWithheldReportsDiscarded(
        managerId,
        withheldBeforeDelete.count,
        withheldBeforeDelete.firstAt,
        withheldBeforeDelete.lastAt,
      );
    }
    this.reports.delete(managerId);
  }
}

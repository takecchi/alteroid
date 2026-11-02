import { randomUUID } from 'node:crypto';
import { EXCHANGE_KIND_GAUGE_PREFIX, EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import type { ManagerReportFiles } from './manager-outbox-fetch.js';
import { allSessionWindow, quotaStopWindowKeyOf, type QuotaMark } from './quota-stop-notice.js';
import type { QuotaStopWindows } from './quota-stop-windows.js';
import type { InboxEvent, JobStatus, TextMarkup } from './schema.js';
import {
  FOLD_WHEN_BACK_SYNTHESIZED_LABELS,
  isCrossWindowStreakEligible,
  mergeSynthesizedNoticeFragments,
  synthesizedNoticeArrivalIntervals,
  synthesizedNoticeSignature,
  type FoldWhenBack,
  type SynthesizedNoticeLabel,
  type SynthesizedNoticeStreak,
  type SynthesizedNoticeWindow,
} from './synthesized-notice.js';
import type { WithheldReportsStore } from './withheld-reports-store.js';

export interface SynthesizedNoticeWindowsDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  /** 抱えているトークン（`Pool#tokenIdentities`）。積む時点で読む。 */
  tokenIdentities: ReadonlyMap<string, { tokenId: string }>;
  /** 後継を起こしている最中の担当（`Pool#supersedePending`）。 */
  supersedePending: ReadonlyMap<string, symbol>;
  /** 枠の窓。束を窓へ入れるか・窓を開けるかの判定と記録だけを使う。 */
  quotaWindows: Pick<QuotaStopWindows, 'isOpen' | 'isOpenedByOther' | 'join' | 'noteOpener'>;
  /** 在庫から窓へ運ぶ文の組み立て（`WithheldReportsStore#takeForDelivery`）。 */
  takeWithheldForDelivery: WithheldReportsStore['takeForDelivery'];
  post: (event: InboxEvent) => void;
  /** `Pool#statusAtDelivery`（`#records` に無ければ `{}`）。 */
  statusAtDelivery: (managerId: string) => { statusAtDelivery: JobStatus } | Record<string, never>;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  now: () => number;
  nowIso: () => string;
  /** 担当ごとの窓の長さ。 */
  windowMs: number;
}

/**
 * 機構が合成した知らせの、担当ごとの短い合流窓と、窓をまたいで同文を畳む連（streak）。
 * 在庫（`WithheldReportsStore`）とは別物: あちらは時間の上限まで保持する在庫、こちらは短い窓だけ保持して必ず1本にまとめて配る。
 * 窓の処理はすべて同期のまま保つ（`emit` の「全部 flush してから配る」が非同期だと、本題の配りが先に走って順序が崩れる）。
 */
export class SynthesizedNoticeWindows {
  readonly #windows = new Map<string, SynthesizedNoticeWindow>();
  /**
   * 窓をまたいで同文を畳むための、もう配った束の署名。
   * 窓が閉じても消えず、別の `manager_message` を配った時点で消える（`#deliver`）。
   * 委譲1本につき1件で、終端すれば `forget` が外すので上限が要らない。タイマーは持たない。
   */
  readonly #streaks = new Map<string, SynthesizedNoticeStreak>();
  readonly #deps: SynthesizedNoticeWindowsDeps;
  readonly #journalExchange: SynthesizedNoticeWindowsDeps['journalExchange'];

  constructor(deps: SynthesizedNoticeWindowsDeps) {
    this.#deps = deps;
    this.#journalExchange = deps.journalExchange;
  }

  /** 担当の窓が開いているか。 */
  hasWindow(managerId: string): boolean {
    return this.#windows.has(managerId);
  }

  /** 担当の窓に積んである、その族の断片の枠の印（無ければ `undefined`）。 */
  quotaOfFragment(managerId: string, label: SynthesizedNoticeLabel): QuotaMark | undefined {
    return this.#windows.get(managerId)?.fragments.find((fragment) => fragment.label === label)
      ?.quota;
  }

  /** 連だけを消す。窓は残す（積んだ知らせは後で必ず配る）。 */
  forget(managerId: string): void {
    this.#streaks.delete(managerId);
  }

  // 順序は並べ替えない（`docs/architecture.md`）: 畳めない出来事が来たら、先に合成した知らせの積みを全部配り切ってから本題を配る。
  // `#flushFor` はここを経由せず直接 `#deliver` を呼ぶ: 経由すると、窓が閉じて配る1回が新しい出来事として全 managerId の積みを二重に flush する。
  emit(
    managerId: string,
    kind: 'report' | 'question' | 'permission',
    text: string,
    requestId?: string,
    markup?: TextMarkup,
    withheldSuffixDetail: 'full' | 'flush' = 'full',
    foldedTurn = false,
    reportFiles?: ManagerReportFiles,
    foldWhenBack?: FoldWhenBack,
  ): void {
    this.flushAll();
    this.#deliver(
      managerId,
      kind,
      text,
      requestId,
      markup,
      withheldSuffixDetail,
      false,
      foldedTurn,
      reportFiles,
      undefined,
      foldWhenBack,
    );
  }

  #deliver(
    managerId: string,
    kind: 'report' | 'question' | 'permission',
    text: string,
    requestId?: string,
    markup?: TextMarkup,
    withheldSuffixDetail: 'full' | 'flush' = 'full',
    synthesized = false,
    foldedTurn = false,
    reportFiles?: ManagerReportFiles,
    quotaStop?: { readonly sessionWindow: boolean },
    foldWhenBack?: FoldWhenBack,
  ): void {
    // 握り潰した報告の件数を日誌だけに残さず、配る `text` の末尾にも足す（`WithheldReportsStore#takeForDelivery`）。同期のまま、`post` より前。
    const withheldStep = this.#deps.takeWithheldForDelivery(managerId, text, withheldSuffixDetail);
    let outgoing = withheldStep.text;
    // 畳んでよい印も同じ回に外す（#5048）: 足した中身（畳んだ報告・配らなかった知らせの件数）まで、担当が戻ったことを理由に消さないため
    let foldable = withheldStep.appended ? undefined : foldWhenBack;
    // 何を配ったかに関わらず帳面を消す: 次に同じ本文の知らせが来たら、また1件目として配る（`#flushFor` だけは直後に新しい署名で `set` し直す）。
    const streak = this.#streaks.get(managerId);
    this.#streaks.delete(managerId);
    if (streak !== undefined && streak.suppressed > 0) {
      foldable = undefined;
      outgoing =
        `${outgoing}\n\n（この間に、直前と同じ本文の「機構が合成した知らせ」を ` +
        `${String(streak.suppressed)} 束（通数 ${String(streak.suppressedArrived)} 件）配っていない` +
        `（最初 ${streak.firstAt ?? '不明'} / 最後 ${streak.lastAt ?? '不明'}）。` +
        `**1件目は配ってあり、配らなかったのは2件目以降の完全な重複だけである。**` +
        `全文は日誌に在る（\`journal_read\`）。）`;
    }
    this.#deps.post({
      type: 'manager_message',
      id: randomUUID(),
      at: this.#deps.nowIso(),
      managerId,
      kind,
      text: outgoing,
      ...(requestId === undefined ? {} : { requestId }),
      // 取れない軸に値を作らない: `markup` が `undefined` のときはキーごと書かない。
      ...(markup === undefined ? {} : { markup }),
      ...this.#deps.statusAtDelivery(managerId),
      ...(synthesized ? { synthesized: true as const } : {}),
      ...(foldedTurn ? { foldedTurn: true as const } : {}),
      ...(quotaStop === undefined ? {} : { quotaStop: true as const }),
      ...(quotaStop?.sessionWindow === true ? { quotaSessionWindow: true as const } : {}),
      // 添付を運ぶ報告には付けない: 添付は畳むと受け取られないため
      ...(foldable === undefined || reportFiles !== undefined ? {} : { foldWhenBack: foldable }),
      ...(reportFiles === undefined || reportFiles.attachments.length === 0
        ? {}
        : { attachments: reportFiles.attachments }),
      ...(reportFiles === undefined || reportFiles.rejected.length === 0
        ? {}
        : { rejectedAttachments: reportFiles.rejected }),
    });
  }

  // 畳む判定は「機構が合成した印」と「窓の中」の積: 印だけで畳むと、数十秒離れて届いた別の束まで巻き込む。
  // 同じ束か別の出来事か外から決められないときは畳まない: 畳めなければクローンのターンが焼けるだけで情報は消えず、畳み間違いのほうが重い。
  // 窓のタイマーは延長しない: 届き続ける限り閉じなくなり、後から必ず配られる保証が崩れる（north_star 禁止2）。
  // 族も本文も同一の2度目は数を増やすだけ、本文が違えば別の出来事として積みを flush する: 内容の違う2件を1件に潰すとクローンから「2件目が来なかった」と区別が付かない。
  // `quota` は呼び手が付ける（構造化された値か既存の分類から）。ここで本文から判定し直さない: 印の無い断片が1つでも混ざる束は担当ごとに配る側へ倒れる。
  queue(
    managerId: string,
    label: SynthesizedNoticeLabel,
    text: string,
    quotaMark?: QuotaMark,
  ): void {
    // 抱えているトークンは積む時点で読む: 畳まれた委譲の分も `tokenIdentities` には残る（`Pool#retire` は消さない）ので、畳んだ後に届いた束も同じ窓の鍵になる。
    const heldTokenId = this.#deps.tokenIdentities.get(managerId)?.tokenId;
    const quota =
      quotaMark === undefined || heldTokenId === undefined
        ? quotaMark
        : { ...quotaMark, tokenKey: heldTokenId };
    const arrivedAt = this.#deps.now();
    const existing = this.#windows.get(managerId);
    if (existing !== undefined) {
      // 本文の比較は正規化も切り詰めもしない: 1バイトでも違えば別のことを言っている側へ倒す。
      const duplicate = existing.fragments.find(
        (fragment) => fragment.label === label && fragment.text === text,
      );
      if (duplicate !== undefined) {
        duplicate.count += 1;
        existing.arrivedAt.push(arrivedAt);
        return;
      }
      if (existing.fragments.some((fragment) => fragment.label === label)) {
        this.#flushFor(managerId);
      } else {
        existing.fragments.push({
          label,
          text,
          count: 1,
          ...(quota === undefined ? {} : { quota }),
        });
        existing.arrivedAt.push(arrivedAt);
        return;
      }
    }
    const timer = setTimeout(() => {
      this.#flushFor(managerId);
    }, this.#deps.windowMs);
    timer.unref?.();
    this.#windows.set(managerId, {
      fragments: [{ label, text, count: 1, ...(quota === undefined ? {} : { quota }) }],
      timer,
      arrivedAt: [arrivedAt],
    });
  }

  // `emit` を経由せず直接 `#deliver` を呼ぶ: 経由すると窓を1本閉じるたびに他の managerId の窓まで早期に閉じる。
  // 同期のまま保つ（日誌は待たない）: `emit` の「全部 flush してから配る」が非同期だと、本題の `#deliver` が先に走って順序が崩れる。
  #flushFor(managerId: string): void {
    const entry = this.#windows.get(managerId);
    if (entry === undefined) return;
    this.#windows.delete(managerId);
    clearTimeout(entry.timer);
    const { text, breakdown, arrived } = mergeSynthesizedNoticeFragments(entry.fragments);

    // 合流しなかった窓（`undefined`）は行を書かない: 取れない軸に 0 の行を作らない。
    const arrivalIntervals = synthesizedNoticeArrivalIntervals(entry.arrivedAt);
    if (arrivalIntervals !== undefined) {
      void this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_GAUGE_PREFIX}[${managerId}] 合流窓に続けて畳まれた合図は ` +
          `${String(arrivalIntervals.count)} 件、間隔は最大 ${String(arrivalIntervals.maxIntervalMs)}ms・` +
          `最小 ${String(arrivalIntervals.minIntervalMs)}ms だった` +
          `（窓の長さ ${String(this.#deps.windowMs)}ms）。`,
      );
    }

    // 全断片に枠の印が付いた束だけが対象。1つでも印の無い断片が混ざれば今どおり担当ごとに配る（畳み間違いのほうが重い）。
    // 窓が開いていて、窓を開けた担当とは別の担当なら、担当ごとには配らず窓へ貯める（配っていないので、下の streak は立てない・読まない）。
    // 窓が無い／窓を開けた担当自身なら、下で今までどおり担当ごとに配る（1本目はすぐ）。窓の開閉と一覧の材料だけここで記録する。
    if (entry.fragments.every((fragment) => fragment.quota !== undefined)) {
      const windowKey = quotaStopWindowKeyOf(entry.fragments);
      if (this.#deps.quotaWindows.isOpenedByOther(windowKey, managerId)) {
        this.#deps.quotaWindows.join(windowKey, managerId, entry, breakdown, arrived);
        return;
      }
    }

    // 「同文なら常に捨てる」にしない: 1件目まで消えて黙らせる側になる（連鎖は配ったあとの `set` で初めて立つ）。
    // 対象は `turn_failed` 単独の束だけ: `rate_limit` / `usage_notice` は専用の状態ベースの判定を経ており、文字列一致を重ねると誤って握りつぶす。
    const signature = synthesizedNoticeSignature(entry.fragments);
    const eligible = isCrossWindowStreakEligible(entry.fragments);
    const streak = this.#streaks.get(managerId);
    const suppressed = eligible && streak !== undefined && streak.signature === signature;
    // 窓を開けるのは配る束だけ: 連鎖で握りつぶす束で窓を開けると、一覧がその担当を「最初の1本。担当への報告としては先に届けてある」と言うのに、
    // この回の知らせは担当へ届いていない。開いている窓の2本目（窓を開けた担当自身）は、握りつぶしても一覧の通数には数える。
    if (entry.fragments.every((fragment) => fragment.quota !== undefined)) {
      const windowKey = quotaStopWindowKeyOf(entry.fragments);
      if (!suppressed || this.#deps.quotaWindows.isOpen(windowKey)) {
        this.#deps.quotaWindows.noteOpener(windowKey, managerId, entry, arrived);
      }
    }
    if (suppressed && streak !== undefined) {
      const at = this.#deps.nowIso();
      streak.suppressed += 1;
      streak.suppressedArrived += arrived;
      streak.firstAt ??= at;
      streak.lastAt = at;
      void this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 直前に配ったものと同文の知らせ（内訳: ${breakdown}）が ` +
          `${String(arrived)} 件届いたので、受信箱へは回さず数だけ残した` +
          `（この連鎖で ${String(streak.suppressed)} 束目 / 通数 ${String(streak.suppressedArrived)} 件）。`,
      );
      return;
    }
    // 本文の文言ではなく `label` で判定する。
    const foldedTurn = entry.fragments.some((fragment) => fragment.label === 'turn_failed');
    // `#deliver` より先に `set` しない: `#deliver` は直前の連鎖の件数を末尾に運んでから帳面を消すので、先に上書きすると「配らなかった件数」が届かず消える。
    const quotaStop = entry.fragments.every((fragment) => fragment.quota !== undefined)
      ? { sessionWindow: allSessionWindow(entry.fragments) }
      : undefined;
    // `supersededBy` が在る／後継を起こしている最中の担当は、窓の間に後継がつながった回（クローンが手を打つ余地が在る）。
    const noSuccessor =
      this.#deps.records.get(managerId)?.job.supersededBy === undefined &&
      !this.#deps.supersedePending.has(managerId);
    // 担当が戻っていればクローンが畳んでよい束（#5048）: 起こし直し（後継が居ない回だけ）・背景処理を畳んだ起こし直し・セッションの落ちだけでできた束。
    // 枠の印の付いた断片が1つでも混ざる束は付けない（#4499 の判定に任せる。週の上限で落ちた知らせを消さないため）。後継が居る起こし直しは、どちらかを止める判断が要るので付けない
    const foldWhenBack =
      entry.fragments.every(
        (fragment) =>
          fragment.quota === undefined && FOLD_WHEN_BACK_SYNTHESIZED_LABELS.has(fragment.label),
      ) &&
      (noSuccessor || entry.fragments.every((fragment) => fragment.label !== 'usage_rewoken'))
        ? {}
        : undefined;
    this.#deliver(
      managerId,
      'report',
      text,
      undefined,
      undefined,
      'full',
      true,
      foldedTurn,
      undefined,
      quotaStop,
      foldWhenBack,
    );
    // 対象外の束では新しい連鎖を立てない: 次に同じ族が来ても握りつぶす先が無く、記憶を持つだけ無駄。
    if (eligible) {
      this.#streaks.set(managerId, {
        signature,
        suppressed: 0,
        suppressedArrived: 0,
      });
    }
    // 消えてよいのはクローンを起こすことだけで、記録ではない: 個々の知らせは積んだ時点で既に日誌に書かれており、ここで足すのは「まとめた」1行だけ。
    void this.#journalExchange(
      'inbound',
      `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] 機構が合成した知らせを ${String(arrived)} 件、` +
        `1件にまとめて配った（内訳: ${breakdown}）。`,
    );
  }

  /** 開いている窓を全部、同期で閉じて配る（開いた順）。 */
  flushAll(): void {
    for (const managerId of [...this.#windows.keys()]) {
      this.#flushFor(managerId);
    }
  }
}

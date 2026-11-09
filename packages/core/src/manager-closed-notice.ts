import { EXCHANGE_KIND_DECISION_PREFIX } from './exchange-kind.js';
import { laterIso } from './later-iso.js';
import type { ManagerRecord } from './manager.js';
import { composePeerCloseNotices } from './manager-notices.js';
import type { RunnerEvent } from './runner-protocol.js';
import type { SynthesizedNoticeWindows } from './synthesized-notice-windows.js';
import type { WithheldReportsStore } from './withheld-reports-store.js';

type ClosedEvent = Extract<RunnerEvent, { type: 'closed' }>;

/**
 * - `'seen'` — `closed(done)` は報告の後の idle の終わりで、知らせない
 * - `'none'` — 一度も受け取っていない。報告無しで終わった
 * - `'unknown'` — 判定できない。**知らせる側へ倒す**（黙って無音へ倒さない）。
 *   (1) `Job.runnerSessionSince` が無い（この欄を書く前の古い行）——`lastReportAt` が在っても、いまのセッションのものとは言えない
 *   (2) どちらかが日時として読めない（`jobSchema.lastReportAt` は `z.string()` で、形を保証していない）
 *
 * 同じセッションの中で report の後に別のターンが始まり、そのターンだけが report 無しで閉じた回も拾うため、
 * `Job.turnStartedAt` との遅いほうを境にする。
 */
function reportSeenInSession(
  lastReportAt: string | undefined,
  runnerSessionSince: string | undefined,
  turnStartedAt?: string | undefined,
): 'seen' | 'none' | 'unknown' {
  if (lastReportAt === undefined) return 'none';
  // セッションの始まりとターンの始まりの遅いほうを境にする: 同じセッションの2ターン目が report 無しで閉じた回を、1ターン目の report で「受け取った」と読まないため。
  const since = laterIso(runnerSessionSince, turnStartedAt);
  if (since === undefined) return 'unknown';
  const reportMs = Date.parse(lastReportAt);
  const sinceMs = Date.parse(since);
  if (Number.isNaN(reportMs) || Number.isNaN(sinceMs)) return 'unknown';
  return reportMs >= sinceMs ? 'seen' : 'none';
}

/**
 * `Pool` が口として渡すもの。
 * `withheld`・`synthesized` は `Pool` が持つ在庫・合流窓の参照そのもの（コピーしない。ここでは `get` / `carryToWindow` / `hasWindow` / `quotaOfFragment` だけを使う）。
 * 関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。`emit`・`queueSynthesizedNotice` は同期のまま渡す。
 */
interface ManagerClosedNoticePorts {
  /** `Pool#persist`（台帳へ書く）。 */
  persist: (record: ManagerRecord) => Promise<void>;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  /** `Pool#emit`（合成した知らせの窓を経由して受信箱へ積む。同期）。 */
  emit: (...args: Parameters<SynthesizedNoticeWindows['emit']>) => void;
  /** `Pool#queueSynthesizedNotice`（担当ごとの合流窓へ積む。同期）。 */
  queueSynthesizedNotice: (...args: Parameters<SynthesizedNoticeWindows['queue']>) => void;
  /** 畳んだ報告の在庫（`Pool#withheld`）の参照。 */
  withheld: Pick<WithheldReportsStore, 'get' | 'carryToWindow'>;
  /** 合成した知らせの合流窓（`Pool#synthesized`）の参照。 */
  synthesized: Pick<SynthesizedNoticeWindows, 'hasWindow' | 'quotaOfFragment'>;
}

/**
 * `closed` の段3（`Pool#closeJob`）が呼ぶ、クローンへの知らせの 3 本（peer の閉じの知らせ・report 無しの `done` の知らせ・畳んでいた報告の在庫の配り）を受け持つ側。
 * `Pool` の `#noticePeerCloseAtEnd`・`#noticeSilentDone`・`#flushWithheldAtClose` から切り出した。振る舞いは変えていない。
 * `#closeJob` の呼び元（`await` の有無・順序・`if` の形）は `Pool` に残す。`noticePeerCloseAtEnd`・`flushWithheldAtClose` は同期のまま保つ（`await` を足すと完了の周回が増える）。
 * 自前の欄は `peerCloseReportedAt` だけ（`Pool` の `#peerCloseReportedAt` から移した。この 3 本の中でしか使われていない）。
 */
export class ManagerClosedNotice {
  /**
   * `closed(failed / lost)` でクローンへ知らせた peer の閉じの知らせの `at`（担当ごと）。同じ知らせを閉じのたびに重ねて出さないための印。
   * 台帳の `pendingPeerCloseNotice` は担当が起こされるまで残すので、これで「知らせ済み」を分ける（プロセス内だけ: 閉じは再起動を跨いで届き直さない）。
   */
  readonly #peerCloseReportedAt = new Map<string, string>();
  readonly #persist: ManagerClosedNoticePorts['persist'];
  readonly #journalExchange: ManagerClosedNoticePorts['journalExchange'];
  readonly #emit: ManagerClosedNoticePorts['emit'];
  readonly #queueSynthesizedNotice: ManagerClosedNoticePorts['queueSynthesizedNotice'];
  readonly #withheld: ManagerClosedNoticePorts['withheld'];
  readonly #synthesized: ManagerClosedNoticePorts['synthesized'];

  constructor(ports: ManagerClosedNoticePorts) {
    this.#persist = ports.persist;
    this.#journalExchange = ports.journalExchange;
    this.#emit = ports.emit;
    this.#queueSynthesizedNotice = ports.queueSynthesizedNotice;
    this.#withheld = ports.withheld;
    this.#synthesized = ports.synthesized;
  }

  // `closed` の段3-4: 担当が終端で終わったとき、台帳に残る peer の閉じの知らせをクローンへも知らせる。同期のまま保つ。
  noticePeerCloseAtEnd(record: ManagerRecord, event: ClosedEvent): void {
    // 担当が終端で終わったとき、台帳に残る peer の閉じの知らせをクローンへも知らせる: `parked_peers_closed(failed)` は `closed` より前に届き、その時点の job はまだ running なので台帳へ積まれる。以後起こされないと誰にも届かない。
    // 台帳の知らせは消さない（あとで起こし直されれば担当の先頭にも添う。宛先が違うので二重にならない）。同じ知らせは1回だけ（`#peerCloseReportedAt`）。
    const pendingPeerClose = record.job.pendingPeerCloseNotice;
    if (
      (event.status === 'failed' || event.status === 'lost') &&
      pendingPeerClose !== undefined &&
      this.#peerCloseReportedAt.get(event.managerId) !== pendingPeerClose.at
    ) {
      this.#peerCloseReportedAt.set(event.managerId, pendingPeerClose.at);
      this.#emit(
        event.managerId,
        'report',
        `[${event.managerId}] ${composePeerCloseNotices(pendingPeerClose)}`,
      );
    }
  }

  // `closed` の段3-5: report が無いまま届いた `closed(done)` をクローンへ知らせる（呼び元が `done` かつ在庫無しのときだけ呼ぶ）。
  async noticeSilentDone(record: ManagerRecord, event: ClosedEvent): Promise<void> {
    const seen = reportSeenInSession(
      record.job.lastReportAt,
      record.job.runnerSessionSince,
      record.job.turnStartedAt,
    );
    // 同じセッションについては1回だけ: 印はターンの始まりを含めた境の時刻で、新しいセッションやターンでは値が変わり知らせ直せる（`Job.silentDoneNotifiedFor`）。
    const sessionKey = laterIso(record.job.runnerSessionSince, record.job.turnStartedAt) ?? '';
    const alreadyNotified = record.job.silentDoneNotifiedFor === sessionKey;
    if (seen !== 'seen' && alreadyNotified) {
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] report 無しの closed(done)。` +
          `同じセッション（${sessionKey === '' ? '開始時刻は不明' : sessionKey}）については知らせ済みなので重ねて知らせない: ` +
          event.reason,
      );
    } else if (seen !== 'seen') {
      const body = [
        `この委譲 ${event.managerId} は、report を出さないまま終わった（closed の status=done。台帳の状態は done）。`,
        '**成果が出ているとは限らない** — 成果が実際に出ているか' +
          '（PR・コミット・送信済みのメール・登録済みの予定・投稿先など）を確かめること。' +
          '確かめるまで「終わった」とも「終わっていない」とも言わない。',
        ...(seen === 'unknown'
          ? [
              'このセッションで report を受け取ったかは判定できなかった（この欄を書く前の古い行などで' +
                '比較する時刻が無い）ため、念のため知らせている。',
            ]
          : []),
        `closed の reason: ${event.reason}`,
      ].join('\n');
      await this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_DECISION_PREFIX}[${event.managerId}] report 無しの closed(done)` +
          `（${seen === 'none' ? 'report は一度も受け取っていない' : '判定できないので知らせる側へ倒した'}）。` +
          `クローンへ知らせる: ${body}`,
      );
      // 印を先に台帳へ書く（`lateDoneNotifiedAt` と同じ）。
      record.job.silentDoneNotifiedFor = sessionKey;
      await this.#persist(record);
      this.#queueSynthesizedNotice(event.managerId, 'closed_done_silent', body);
    }
  }

  // `closed` の段3-6: 畳んでいた報告の在庫が在れば、像を外す前に配る（合流窓が開いていれば窓へ積む）。同期のまま保つ。
  flushWithheldAtClose(event: ClosedEvent): void {
    // 積みが在れば `#retire()` の前に配る: 握り潰した報告は「後で必ず配る」約束で、この委譲はもう走らないので次の本物の報告が上書きする経路は来ない。`#emit()` が積みを見つけて末尾へ足すので、ここは「畳まれた」事実だけを書く。
    const withheldAtClose = this.#withheld.get(event.managerId);
    if (withheldAtClose !== undefined) {
      const closedNote =
        `[${event.managerId}] この委譲は終わった（status=${event.status}）。` +
        '背景処理の完了待ちで畳んでいた報告をまとめて配る。';
      if (this.#synthesized.hasWindow(event.managerId)) {
        // 担当の合流窓が開いている（同じ落ち方の `turn_failed` / `closed_failed` が居る）ときは、`#emit()` せず窓へ積んで1通にする: `#emit()` は全窓を閉じて先に断片だけを配るので、この1通が別に届く。窓は開けない・延ばさない（開いていなければ下の `#emit()` で今までどおりすぐ配る）。
        // 在庫は `#retire()` が消すので、窓の flush（`#deliver`）が運べるよう先に移す。移した分は `#retire()` の「握り潰したまま終わった」の stderr にも出ない（配るので捨てていない）。枠の印（`quota`）は下で `closed_failed` から受け継ぐ（枠で落ちた回だけ）。印の無い回は付けず、印の無い断片が混ざった束は担当ごとに配られる。
        this.#withheld.carryToWindow(event.managerId, withheldAtClose);
        // 枠で落ちた回（同じ `closed` で積んだ `closed_failed` に枠の印がある）だけ、その印（トークンの鍵ごと）を受け継ぐ: 束が「枠だけ」のままになり、プール窓の一覧に入る。印の無い回は付けない。
        const inheritedQuota = this.#synthesized.quotaOfFragment(event.managerId, 'closed_failed');
        this.#queueSynthesizedNotice(
          event.managerId,
          'closed_withheld_flush',
          closedNote,
          inheritedQuota,
        );
      } else {
        this.#emit(event.managerId, 'report', closedNote);
      }
    }
  }
}

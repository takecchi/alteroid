import { decodeDenialKey, DENIAL_REPLY_ROUTE } from './denial-key.js';
import { noteDroppedRecord } from './dropped-record.js';
import { laterIso } from './later-iso.js';
import type { ManagerRecord } from './manager.js';
import { codeSpan } from './markdown-span.js';
import { ONE_SHOT_ALLOW_TTL_MS } from './runner.js';

/**
 * 知らせ直しは拒否1件につき1回だけ。遅延は `ONE_SHOT_ALLOW_TTL_MS`（1回だけの許可の寿命と同じ桁）。かつてあった30分後の2回目は外した:
 * 無音の通知（`SilenceWatch`。`permission_denied` も進捗に数え、無音30分で1通）と同じ時刻に2通届くため。
 * ここが数えるのは新設した通知の回数であって、道具の実行回数でもターン数でもない（暴走を機械的に止めるものではない）。
 */
const DENIAL_RENOTIFY_DELAY_MS = ONE_SHOT_ALLOW_TTL_MS;

interface DenialRenotifierDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  now: () => number;
  stopped: () => boolean;
  /** `Pool#emit(managerId, 'report', text)` を束ねたもの。 */
  emitReport: (managerId: string, text: string) => void;
}

/**
 * 止まったままの拒否を、間を空けてクローンへ知らせ直す（issue #1105 C）。帳面（`deniedRenotify`・`lastDenialRenotify`）は
 * `ManagerRecord` の欄で、拒否を覚える側（`Pool#handleEvent`）・確認の突き合わせ（`#choosePending`）と共有するのでここでは持たない。
 */
export class DenialRenotifier {
  readonly #records: DenialRenotifierDeps['records'];
  readonly #now: DenialRenotifierDeps['now'];
  readonly #stopped: DenialRenotifierDeps['stopped'];
  readonly #emitReport: DenialRenotifierDeps['emitReport'];

  constructor(deps: DenialRenotifierDeps) {
    this.#records = deps.records;
    this.#now = deps.now;
    this.#stopped = deps.stopped;
    this.#emitReport = deps.emitReport;
  }

  renotifyStalled(): void {
    if (this.#stopped()) return;
    const now = this.#now();
    for (const [managerId, record] of [...this.#records]) {
      if (this.#stopped()) break;
      // `waiting_human` を丸ごと弾かない: 無関係な未決の確認が1件あるだけで無関係な拒否まで巻き添えになるため、判定は拒否1件ごとに行う。
      const deniedLastAt = record.deniedLastAt;
      if (deniedLastAt === undefined || deniedLastAt.size === 0) continue;
      for (const [key, deniedAt] of [...deniedLastAt]) {
        try {
          this.#renotifyOne(managerId, record, key, deniedAt, now);
        } catch (error) {
          noteDroppedRecord('止まった拒否の知らせ直し', `managerId=${managerId}・鍵=${key}`, error);
        }
      }
    }
  }

  #renotifyOne(
    managerId: string,
    record: ManagerRecord,
    key: string,
    deniedAt: string,
    now: number,
  ): void {
    const deniedAtMs = Date.parse(deniedAt);
    // 読めない時刻は症状として扱わない（判定できないという3つ目の状態）。
    if (Number.isNaN(deniedAtMs)) return;

    // `job.status === 'waiting_human'` を代理指標にしない: この拒否自身の `requestId` を持つ未決の確認があるときだけ見送る。無関係な確認が未決でも知らせ直しを止める理由にならない。
    const ownRequestId = record.deniedLastRequestId?.get(key);
    if (
      ownRequestId !== undefined &&
      record.waiting.some((item) => item.requestId === ownRequestId)
    ) {
      return;
    }

    const progressedAt = laterIso(record.job.lastReportAt, record.lastToolSettledAt);
    if (progressedAt !== undefined && progressedAt > deniedAt) {
      record.deniedRenotify?.delete(key);
      return;
    }

    // 同じ鍵に新しい拒否が来ていたら古いエピソードの帳面は使わない: 新しい拒否は新しい注意に値する。
    if (record.deniedRenotify?.get(key) === deniedAt) return; // 出し済みで黙っている

    if (now < deniedAtMs + DENIAL_RENOTIFY_DELAY_MS) return; // まだ時間に達していない

    (record.deniedRenotify ??= new Map()).set(key, deniedAt);
    // 実際に配る直前に更新する: `#choosePending` が読むのは届いた知らせ直しであって、知らせ直そうとした事実ではない。
    record.lastDenialRenotify = { at: new Date(now).toISOString(), key };

    const { tool, actor } = decodeDenialKey(key);
    const actorLabel =
      actor === 'manager' ? 'マネージャー自身' : actor === 'worker' ? '作業者' : 'どちらの層か不明';
    const reason = record.deniedLastReason?.get(key);
    const elapsedMinutes = Math.round((now - deniedAtMs) / 60_000);

    this.#emitReport(
      managerId,
      `[${managerId}] ${codeSpan(tool)} の拒否（${actorLabel}）から${String(elapsedMinutes)}分、` +
        '動きが無い（知らせ直し。issue #1105 C）。' +
        (reason?.inputHead === undefined
          ? ''
          : `\n拒否より前に見た入力の先頭（伏せ字・最大160字）: ${codeSpan(reason.inputHead)}`) +
        DENIAL_REPLY_ROUTE +
        '\n全件は日誌に残っている（`journal_read` で辿れる）。',
    );
  }
}

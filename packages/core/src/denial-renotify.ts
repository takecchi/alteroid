import { decodeDenialKey, DENIAL_REPLY_ROUTE } from './denial-key.js';
import { noteDroppedRecord } from './dropped-record.js';
import { EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import { laterIso } from './later-iso.js';
import type { ManagerRecord } from './manager.js';
import { codeSpan } from './markdown-span.js';
import { ONE_SHOT_ALLOW_TTL_MS } from './runner.js';
import { WITHHELD_REPORT_FLUSH_MS } from './withheld-reports.js';

/**
 * **配列の長さがそのまま知らせ直しの上限回数（2回）を兼ねる。**
 * 1回目は `ONE_SHOT_ALLOW_TTL_MS`（1回だけの許可の寿命と同じ桁）、2回目は `WITHHELD_REPORT_FLUSH_MS` と同じ値だが、
 * 参照で結びつけない: 別の関心事の期限なので、あちらの env を差し替えてもこちらは動かさない。
 * ここが数えるのは新設した通知の回数であって、道具の実行回数でもターン数でもない（暴走を機械的に止めるものではない）。
 */
const DENIAL_RENOTIFY_DELAYS_MS: readonly number[] = [
  ONE_SHOT_ALLOW_TTL_MS,
  WITHHELD_REPORT_FLUSH_MS,
];

export interface DenialRenotifierDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  now: () => number;
  stopped: () => boolean;
  /** `Pool#emit(managerId, 'report', text)` を束ねたもの。 */
  emitReport: (managerId: string, text: string) => void;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
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
  readonly #journalExchange: DenialRenotifierDeps['journalExchange'];

  constructor(deps: DenialRenotifierDeps) {
    this.#records = deps.records;
    this.#now = deps.now;
    this.#stopped = deps.stopped;
    this.#emitReport = deps.emitReport;
    this.#journalExchange = deps.journalExchange;
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
    const existing = record.deniedRenotify?.get(key);
    const stage = existing?.deniedAt === deniedAt ? existing.stage : 0;
    const delayMs = DENIAL_RENOTIFY_DELAYS_MS[stage];
    if (delayMs === undefined) return; // 出し切って黙っている（stage が上限に達した）

    const dueAt = deniedAtMs + delayMs;
    if (now < dueAt) return; // まだこの段の時間に達していない

    const nextStage = stage + 1;
    (record.deniedRenotify ??= new Map()).set(key, { deniedAt, stage: nextStage });
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
        `動きが無い（知らせ直し ${String(nextStage)}/${String(DENIAL_RENOTIFY_DELAYS_MS.length)} 回目。` +
        'issue #1105 C）。' +
        (reason?.inputHead === undefined
          ? ''
          : `\n拒否より前に見た入力の先頭（伏せ字・最大160字）: ${codeSpan(reason.inputHead)}`) +
        DENIAL_REPLY_ROUTE +
        '\n全件は日誌に残っている（`journal_read` で辿れる）。',
    );

    if (nextStage === DENIAL_RENOTIFY_DELAYS_MS.length) {
      void this.#journalExchange(
        'inbound',
        `${EXCHANGE_KIND_THINNING_PREFIX}[${managerId}] ${tool} の拒否（${actorLabel}）の知らせ直しを` +
          `${String(nextStage)}回とも出したので、これ以上は黙る（issue #1105 C）。`,
      );
    }
  }
}

import type { ManagerRecord, ManagerTranscript } from './manager.js';
import type { Job, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { RUNNER_CAPABILITY_TRANSCRIPT_TAIL, type RunnerClient } from './runner-protocol.js';
import { probeToolUseStall, probeTurnEnd, TURN_END_PROBE_CHARS } from './turn-end-probe.js';

/**
 * **費用の門であって判定の閾値ではない。** ここで弾かれても「症状ではない」とは言えず（まだ引いていないだけ）、
 * 通っても「症状である」とは言わない（`probeTurnEnd` が改めて計算する）。
 */
const TURN_END_PROBE_QUIET_MS = 10 * 60_000;

const TURN_END_PROBE_BACKOFF_MS = 60_000;

/** 旗が立っている相手のほうを長くする: 生ログの末尾が動かない限り助言は変わらない。 */
const TURN_END_PROBE_BACKOFF_FLAGGED_MS = 5 * 60_000;

export interface TurnEndWatchDeps {
  /** 走査の起点。`Pool` の像（`#records`）そのもの。 */
  records: ReadonlyMap<string, ManagerRecord>;
  /** 背景処理の完了待ちで畳んだ報告の件数だけ読む（`Pool#withheldReports` そのもの）。 */
  withheldReports: ReadonlyMap<string, { count: number }>;
  /** 呼ぶたびに読む（構築時に控えない）。 */
  stores: Pick<Stores, 'sessionTranscriptTail' | 'archive'>;
  now: () => number;
  journal: (entry: JournalEntryInput) => Promise<void>;
  /** クローンへ `report` を1通配る。 */
  emitReport: (managerId: string, text: string) => void;
  runnerOf: (record: ManagerRecord) => Promise<RunnerClient | null>;
  runnerHasCapability: (runnerId: string, capability: string) => boolean;
}

/**
 * 見回りの turn-end（ターンが終わったのに報告が来ない担当を、生ログの末尾で見つけて扱う）と、生ログの末尾の観測。
 * 見回りに使う3つの帳面（間引きの時刻・拾い直し済みのターンの終わり・末尾の段の日誌の印）を持つ。
 * 像と預かりの件数は `Pool` のものを読むだけで、書くのは判定の結果の欄（`ManagerRecord#turnEnd*` など）だけ。
 */
export class TurnEndWatch {
  readonly #deps: TurnEndWatchDeps;
  /**
   * 費用の門のバックオフにしか使わない: ここに載ったこと自体は「症状である」を意味しない。
   * `forget()` が消す: 畳んだ担当は見回りの対象（`running`）から外れ、起こし直すと台帳の `updatedAt` が進んで静けさの門（10分）を
   * 通り直すので、消しても次の見回りの間隔（バックオフは最大5分）は変わらない。
   */
  readonly #probedAt = new Map<string, number>();
  /** 届かなかった報告を生ログから拾って配ったターンの終わり（`turnEndedAt`）を委譲ごとに覚える（#5195）: 同じターンの終わりを見回りのたびに配らない。担当を外しても消さない（起こし直した後に同じ行を配り直さないため） */
  readonly #undeliveredRecovered = new Map<string, string>();
  /**
   * 見回りの末尾の段（#5160）を日誌へ書いた印（種類と委譲）。プロセス内だけ。
   * `forget()` で消さない: 「委譲・種類ごとにプロセスにつき1回」が日誌の約束で、畳んだ委譲を起こし直した後に同じ段へ入っても書き直さない。
   * 1件は短い文字列で、増えるのは段に入った委譲1本につき高々2件。
   */
  readonly #tailJournaled = new Set<string>();

  constructor(deps: TurnEndWatchDeps) {
    this.#deps = deps;
  }

  /** 畳んだ担当の間引きの時刻を消す（`Pool#retire`）。拾い直し済みの印と日誌の印は消さない。 */
  forget(managerId: string): void {
    this.#probedAt.delete(managerId);
  }

  /**
   * 対象の門は費用の門であって判定の門ではない: 絞られた側を「症状ではない」とは言わない。
   * 1件の失敗でループを止めない。
   */
  async probe(): Promise<void> {
    const now = this.#deps.now();
    for (const record of this.#deps.records.values()) {
      try {
        if (record.job.status !== 'running') continue;
        const updatedAt = Date.parse(record.job.updatedAt);
        if (!Number.isNaN(updatedAt) && now - updatedAt < TURN_END_PROBE_QUIET_MS) continue;

        const managerId = record.job.id;
        const lastProbedAt = this.#probedAt.get(managerId);
        const backoffMs =
          record.turnEndedAt === undefined
            ? TURN_END_PROBE_BACKOFF_MS
            : TURN_END_PROBE_BACKOFF_FLAGGED_MS;
        if (lastProbedAt !== undefined && now - lastProbedAt < backoffMs) continue;

        this.#probedAt.set(managerId, now);
        await this.#probeOf(record);
        this.#settleReportCheckAfterRestore(record);
        await this.#recoverUndelivered(record, now);
      } catch {
        // 1件の失敗で残りを止めない。古い助言が残るのは「揮発してよい」側の代償。
      }
    }
  }

  /**
   * 2つの探りの間で調停を書かない: 同じ行を見て両方が同時に立つことは無く、それぞれが自分の欄だけを見る。
   * 読めない・解析できないときは欄を `undefined` に戻す: 分からないものを症状に化けさせない。
   */
  async #probeOf(record: ManagerRecord): Promise<void> {
    // `removed` / `missing` は「探る本文が無い」として扱う: tombstone の事実を助言に反映する意味は無い。
    let transcript: string | null;
    try {
      transcript = await this.#probeTranscriptOf(record);
    } catch {
      transcript = null;
    }
    if (transcript === null || transcript.length === 0) {
      delete record.turnEndedAt;
      delete record.turnEndReason;
      delete record.turnEndTail;
      delete record.toolUseStallAt;
      delete record.toolUseStallPending;
      return;
    }

    const probe = probeTurnEnd(transcript);
    if (probe === undefined) {
      delete record.turnEndedAt;
      delete record.turnEndReason;
      delete record.turnEndTail;
    } else {
      if (probe.timestamp === undefined) {
        delete record.turnEndedAt;
      } else {
        record.turnEndedAt = probe.timestamp;
      }
      record.turnEndReason = probe.stopReason;
      record.turnEndTail = probe.tail;
    }

    const stall = probeToolUseStall(transcript);
    if (stall === undefined) {
      delete record.toolUseStallAt;
      delete record.toolUseStallPending;
      return;
    }
    if (stall.timestamp === undefined) {
      delete record.toolUseStallAt;
    } else {
      record.toolUseStallAt = stall.timestamp;
    }
    record.toolUseStallPending = stall.pending;
  }

  /**
   * 再起動の引き取りの後の1回目の見回りで、ターンの終わりが最後に届いた報告より新しければ、末尾の発言を添えてクローンへ1通配る（#4644）。
   *
   * 前のデーモンが `report` を受け取ったまま処理し終えずに落ちると（OOM・SIGKILL・停止の締切超え）、作り直したデーモンには
   * 二度と届かず、担当は報告を出して待っているのにクローンは知らないまま止まる。普通の停止は `stop()` が処理中を待ち切るので、ここへは来ない。
   * 引き取りの直後には比べない: runner がまだ送っていなかった `report` は、つなぎ直した後に普通に届くため。待つのは見回りの静けさの門
   * （`TURN_END_PROBE_QUIET_MS`）に任せる。引き取りは台帳を書き直す（`updatedAt` が進む）ので、1回目の見回りはその10分後になり、
   * 届く分は届き終えている。前の報告の添付の取り寄せ（報告の門）でそれより長く待たされた回だけは、同じ報告を拾い直しとしても配りうる（二重で済み、落とすよりよい）。
   * 戻るのは報告の末尾だけで、添付は結ばれない（runner の一覧も生ログも、取り寄せる添付の目録を持たないため）。
   */
  #settleReportCheckAfterRestore(record: ManagerRecord): void {
    if (record.reportCheckAfterRestore !== true) return;
    delete record.reportCheckAfterRestore;
    const managerId = record.job.id;
    // 背景処理の完了待ちで畳んだ報告は、まとめ配り（`flushWithheldReports`）が配る
    if ((this.#deps.withheldReports.get(managerId)?.count ?? 0) > 0) return;
    if (record.turnEndedAt === undefined || record.turnEndTail === undefined) return;
    const turnEndedAt = Date.parse(record.turnEndedAt);
    if (Number.isNaN(turnEndedAt)) return;
    const lastReportAt = record.job.lastReportAt;
    if (lastReportAt !== undefined) {
      const reportedAt = Date.parse(lastReportAt);
      if (Number.isNaN(reportedAt) || turnEndedAt <= reportedAt) return;
    }
    // 同じターンの終わりを、届かなかった報告の拾い直し（#5195）がもう一度配らないように覚える
    this.#undeliveredRecovered.set(managerId, record.turnEndedAt);
    this.#deps.emitReport(
      managerId,
      [
        `[${managerId}] デーモンが落ちたあと（再起動の後）に、生ログから拾い直した報告。` +
          '前のデーモンがこの報告を受け取ったまま配り終えずに落ちた可能性がある。',
        `ターンの終わり: ${record.turnEndedAt} / 最後に届いた報告: ${lastReportAt ?? '（無い）'}`,
        '添付があっても結ばれていない。全文は manager_report / manager_transcript で読める。',
        '',
        `末尾の発言:\n${record.turnEndTail}`,
      ].join('\n'),
    );
  }

  /**
   * `end_turn` で終わったターンの報告が、終わりから `TURN_END_PROBE_QUIET_MS` たっても届かず、台帳が `running` のままなら、
   * 生ログの末尾を添えてクローンへ1通配る（#5195）。再起動をまたがない回の受け皿で、`#settleReportCheckAfterRestore` と対になる。
   *
   * 枠で落ちて起こし直された担当で、ターンは `end_turn` で終わったのに `report` が台帳にも受信箱にも届かないことが同じ日に2回あった。
   * 落ちた場所（runner が出さなかったのか、デーモンが捨てたのか）はまだ突き止めていないので、原因の側ではなく届かなかったことの側で拾う。
   * `manager_list` の ⚠ だけでは、クローンが一覧を開くまで誰も気づかない。
   * ターンの終わりの直後には配らない: 報告はふつう数秒で届き、添付の取り寄せ（`OUTBOX_FETCH_TOTAL_TIMEOUT_MS`）を待っても十分に収まる。
   * 早く配ると、届く途中の報告と二重になる。
   * `end_turn` に限る: `stop_sequence`（枠の壁）は失敗の報告として別に届く（#567）。
   */
  async #recoverUndelivered(record: ManagerRecord, now: number): Promise<void> {
    const managerId = record.job.id;
    if (record.job.status !== 'running') return;
    if (record.turnEndReason !== 'end_turn') return;
    if (record.turnEndedAt === undefined || record.turnEndTail === undefined) return;
    // 背景処理の完了待ちで畳んだ報告は、まとめ配り（`flushWithheldReports`）が配る
    if ((this.#deps.withheldReports.get(managerId)?.count ?? 0) > 0) return;
    if (this.#undeliveredRecovered.get(managerId) === record.turnEndedAt) return;
    const turnEndedAt = Date.parse(record.turnEndedAt);
    if (Number.isNaN(turnEndedAt)) return;
    if (now - turnEndedAt < TURN_END_PROBE_QUIET_MS) return;
    const lastReportAt = record.job.lastReportAt;
    if (lastReportAt !== undefined) {
      const reportedAt = Date.parse(lastReportAt);
      if (Number.isNaN(reportedAt) || turnEndedAt <= reportedAt) return;
    }
    this.#undeliveredRecovered.set(managerId, record.turnEndedAt);
    const waitedMinutes = Math.floor((now - turnEndedAt) / 60_000);
    // 落ちた場所を後から辿れるよう、追っている世代と runner を残す（#5195 は原因が分かっていない）
    await this.#deps.journal({
      type: 'decision',
      decision: `[${managerId}] end_turn で終わったターンの報告が ${String(waitedMinutes)} 分届かないので、生ログの末尾から拾ってクローンへ配る（#5195）`,
      grounds:
        `turnEndedAt=${record.turnEndedAt} lastReportAt=${lastReportAt ?? '（無い）'} ` +
        `status=${record.job.status} runnerId=${record.job.runnerId ?? '（不明）'} ` +
        `sessionGeneration=${record.sessionGeneration ?? '（不明）'}`,
    });
    this.#deps.emitReport(
      managerId,
      [
        `[${managerId}] ターンは ${record.turnEndedAt} に end_turn で終わったが、報告が ${String(waitedMinutes)} 分たっても届いていないので、生ログの末尾から拾って配る。` +
          '担当は報告したつもりで待っている。',
        `最後に届いた報告: ${lastReportAt ?? '（無い）'}`,
        '添付があっても結ばれていない。全文は manager_report / manager_transcript で読める。',
        '',
        `末尾の発言:\n${record.turnEndTail}`,
      ].join('\n'),
    );
  }

  /**
   * 見回りの判定に渡す生ログ。判定（`probeTurnEnd` / `probeToolUseStall`）は末尾の `TURN_END_PROBE_CHARS` 文字しか読まないので、末尾だけを取る（#4628）。
   * `transcript()` を使わない: あちらは人間・クローンが全文を読む口で、runner の全文・退避の全文・預かりの全件の直列化をデーモンのループの上で行い、60秒ごとに静かな委譲の本数ぶん回すとループを塞ぐ（#4485）。
   * 上限に同じ数を渡す: `readTail` は本文が長ければ上限を厳密に上回る量を返す契約で、判定はその先頭の欠けた1行を捨てる。
   * runner の全文には落ちない（#5160）。`transcript-tail` を名乗る runner だけ末尾の口で取り、名乗らなければ退避へ進む。
   */
  async #probeTranscriptOf(record: ManagerRecord): Promise<string | null> {
    const result = await this.transcriptTailOf(record.job, record, TURN_END_PROBE_CHARS);
    return result.kind === 'body' ? result.body : null;
  }

  /**
   * 生ログの末尾だけを取る。`transcript()`（全文）と同じ3段を、末尾を読む口で回す（#4628 / #4638）:
   * pg の生ログの預かりの末尾 → runner の末尾の口（`transcript-tail`。#5160）→ 退避の末尾（`archive.readTail`）。
   * 返す量は `readTail` と同じ契約（本文が `maxChars` より長ければ、それを厳密に上回る量）。読み手は先頭の欠けた1行を捨てる。
   * 預かりを全件読む `SessionLoaders#fromSessionStore` には落ちない: 1段目が同じ預かりの末尾を読むため。
   */
  async transcriptTailOf(
    job: Job,
    record: ManagerRecord | undefined,
    maxChars: number,
  ): Promise<ManagerTranscript> {
    const stores = this.#deps.stores;
    const sessionTail = stores.sessionTranscriptTail;
    if (sessionTail !== undefined && job.projectKey !== undefined && job.sessionId !== undefined) {
      const tail = await sessionTail.readTail(
        { projectKey: job.projectKey, sessionId: job.sessionId },
        maxChars,
      );
      if (tail !== null && tail.length > 0) return { kind: 'body', body: tail };
    }
    let tailWithheld = false;
    if (record !== undefined) {
      const runner = await this.#deps.runnerOf(record);
      if (runner !== null) {
        // 末尾の口を名乗らない runner には `transcript()`（全文）へ落ちない: 全文を文字へ直すだけでループを塞ぐため（#5160）
        const tailOf = runner.transcriptTail?.bind(runner);
        const claimsTail =
          tailOf !== undefined &&
          this.#deps.runnerHasCapability(runner.runnerId, RUNNER_CAPABILITY_TRANSCRIPT_TAIL);
        await this.#journalTranscriptTailStage(job.id, runner.runnerId, claimsTail);
        if (claimsTail) {
          const live = await tailOf(job.id, maxChars).catch(() => null);
          if (live !== null && live.length > 0) {
            return {
              kind: 'body',
              body: live.length > maxChars ? live.slice(-(maxChars + 1)) : live,
            };
          }
        } else {
          tailWithheld = true;
        }
      }
    }
    let removed: { archiveId: string; removedAt: string; bytes: number } | undefined;
    for (const id of [...(job.archiveIds ?? [])].reverse()) {
      const result = await stores.archive.readTail(id, maxChars);
      if (result.kind === 'body') return { kind: 'body', body: result.body, archiveId: id };
      if (result.kind === 'removed' && removed === undefined) {
        removed = { archiveId: id, removedAt: result.removedAt, bytes: result.bytes };
      }
    }
    if (removed !== undefined) return { kind: 'removed', ...removed };
    return tailWithheld
      ? {
          kind: 'unreadable',
          detail:
            'runner が末尾の口（transcript-tail）を名乗っていないので、全文は取らずに読まなかった（退避にも本文が無い）',
        }
      : { kind: 'missing' };
  }

  /**
   * 2の段に入ったことを、委譲ごと・種類ごとにデーモンのプロセスにつき1回だけ日誌へ書く（#5160）。60秒ごとの見回りで書き続けない。
   * 前例は `#journalRescueSkips`（`decision`・プロセス内だけの記憶で重ねて書かない）。
   * 本番でこの段に入る委譲があるかを、日誌（`journal_read`）から確かめるための計器。
   */
  async #journalTranscriptTailStage(
    managerId: string,
    runnerId: string,
    claimsTail: boolean,
  ): Promise<void> {
    const key = `${claimsTail ? 'taken' : 'withheld'}\0${managerId}`;
    if (this.#tailJournaled.has(key)) return;
    this.#tailJournaled.add(key);
    await this.#deps.journal({
      type: 'decision',
      decision: claimsTail
        ? `見回りが、生ログの末尾を pg の預かりに見つけられず、runner の末尾の口から取った（委譲 ${managerId}・runner ${runnerId}）`
        : `見回りが、生ログの末尾を pg の預かりに見つけられず、runner が末尾の口（transcript-tail）を名乗っていないので、全文は取らずに読めないとした（委譲 ${managerId}・runner ${runnerId}）`,
      grounds:
        '#5160。pg の預かりの末尾が無いか空のときだけ、この段に入る。' +
        '同じ委譲・同じ種類は、デーモンのプロセスにつき1回だけ書く。',
    });
  }
}

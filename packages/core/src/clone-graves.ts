import { readFile } from 'node:fs/promises';

import { describeArchiveContinuityForJournal } from './archive-continuity.js';
import { describeArchiveRemovedBytesUnit } from './archive-removed-bytes.js';
import type { ReopenArchive } from './clone-distill-memory-state.js';
import {
  DISTILL_TRANSCRIPT_TAIL_CHARS,
  readTranscriptTail,
  tailOf,
} from './clone-transcript-tail.js';
import { noteDroppedRecord, reasonOf } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX, EXCHANGE_KIND_RECOVERY_PREFIX } from './exchange-kind.js';
import { MAX_PENDING_GRAVES } from './grave-queue.js';
import { notePhase } from './loop-stall.js';
import type { JournalEntryInput } from './schema.js';
import type { LostSessionGrave, Stores, TranscriptGrave } from './store.js';
import { redactImagesInTranscriptYielding } from './transcript-image-redaction.js';

/**
 * 起動時の拾い直しで、同じ墓標の蒸留が続けて失敗しても日誌へ書く回数の上限（#4752）。
 * 上限を超えた後は成功するまで、その墓標の「拾い直す」「失敗した」の行と蒸留の入力（`pre_compact_distill`）の行を書かない: 枠以外の理由で失敗し続けると、起動のたびに同じ行（入力は生ログの末尾まるごと）が積もるため。
 * 数えるのは日誌だけで、蒸留を試みること自体と印は止めない（勝手に区間を捨てないため）。
 */
const GRAVE_DISTILL_FAILURE_JOURNAL_LIMIT = 3;

/**
 * `Clone` が協力者へ渡す口。
 * 口の戻りは Promise を直に返す（`() => this.#journal(entry)`）: 間に `async` の関数を挟むと `await` の段が増え、
 * 起動直後のストア呼び出しの順（`clone-startup-store-call-order.test.ts`）と、日誌・蒸留の呼び出しの時機が動く。
 */
export interface CloneGravePorts {
  /** `Clone` の `#stores`。構築の途中でこの協力者を作るので、値ではなく読む関数にする（`#stores` は constructor の中で入る） */
  stores(): Pick<Stores, 'archive' | 'sessions' | 'sessionTranscriptTail'>;
  /** `Clone` の `#journal` */
  journal(entry: JournalEntryInput): Promise<void>;
  /** `Clone` の `#distillFromTranscript`（道具・記憶・env・使用量を束ねる重い本体なので `Clone` に残る） */
  distill(
    transcriptTail: string,
    options?: {
      journalInput?: boolean;
      onQuotaFailure?: (tokenKey: string | undefined) => void;
    },
  ): Promise<void>;
  /** `Clone` の `#distillMemory.transcriptPath` */
  transcriptPath(): string | null;
  /** `Clone` の `#sdkSession.sdkSessionId` */
  sdkSessionId(): string | null;
  /** `Clone` の `#sdkSession.stopped` */
  isStopped(): boolean;
  /** `Clone` の `#delivery.inbox.closed` */
  isInboxClosed(): boolean;
  /** `Clone` の `#currentTokenKey`（`#distillFromTranscript` も使うので `Clone` に残る） */
  currentTokenKey(): string | undefined;
}

/**
 * 墓標（記憶へ移せなかった区間の印）と、見失ったセッションの印を立て、拾い直す協力者。
 * 状態は拾い直しの直列化（`#graveSweep`・`#graveSweepAgain`）・枠で落ちた鍵（`#graveFailedTokenKey`）・生ログの scope（`#projectKey`）の4本で、
 * すべてこの中だけで書く（`#projectKey` は `Clone` の `#measureRawLog` が読むだけ）。
 */
export class CloneGraves {
  readonly #ports: CloneGravePorts;

  /** 墓標の拾い直しの直列化（#4884）。走っている間は1本だけで、走行中に契機が来たら終わってからもう1周する。 */
  #graveSweep: Promise<void> | null = null;
  #graveSweepAgain = false;
  /** 墓標の蒸留が最後に枠で落ちたときの、その蒸留を組んだ時点の鍵（観測の前に立て、拾い直しが成功したら下ろす）。鍵が変わっていない契機（冷却だけの `parked` など）では撃ち直さない。 */
  #graveFailedTokenKey: string | undefined;
  // `cwd` から計算し直さない: SDK の sanitize（200 文字超は切って djb2 のハッシュを足す）の再実装は静かにずれるため
  #projectKey: string | null = null;

  constructor(ports: CloneGravePorts) {
    this.#ports = ports;
  }

  get projectKey(): string | null {
    return this.#projectKey;
  }

  /**
   * 畳む直前に、生ログを**器の外へ出す**。
   *
   * - (i) 退避（`archive`）と (ii) 蒸留（`distill`）を別の `try` に割る:
   *   (ii) は枠が閉じていると走れず、同じ `try` に入れると通るはずの (i) が巻き込まれるため
   * - (i) が落ちたら黙らず日誌へ残す: 「残っているはず」と読まれる守れない約束になるため
   * - (i) が落ちても (ii) へ進む: (i) は全文を1本の文字列にして `ERR_STRING_TOO_LONG` で落ちうる（`readTranscriptTail` の doc）。
   *   そこで止めると、記憶へ移すことが退避の都合で道連れになる
   */
  async salvageTranscript(
    options: { why: 'context-window' | 'reopen'; distill: boolean } = {
      why: 'context-window',
      distill: true,
    },
  ): Promise<ReopenArchive> {
    notePhase(`clone:salvage:${options.why}`);
    const label = options.why === 'reopen' ? '開き直す前' : '文脈窓で畳む前';
    const path = this.#ports.transcriptPath();
    // 控えが無いときは日誌へ書かず黙って通す: 道具を使う前に落ちた回のたびにノイズが1行増えるため
    if (path === null) return { kind: 'none' };

    // セッション id は最初の待ちの前に控える（#4787）: 読み出しの間に次のセッションが init すると、古い生ログを新しいセッションの id で退避するため
    const sessionId = this.#ports.sdkSessionId() ?? 'clone';
    let archiveId: string | null = null;
    try {
      // 画像の中身は archive へ渡さない: 保持期限後も消えない生ログになるため
      const transcript = await redactImagesInTranscriptYielding(await readFile(path, 'utf8'));
      const write = await this.#ports.stores().archive.archive(sessionId, transcript);
      archiveId = write.id;
      const continuityText = describeArchiveContinuityForJournal({
        caller: `${label}の退避`,
        sessionId,
        continuity: write.continuity,
        comparedTo: write.comparedTo,
        bodyChars: transcript.length,
      });
      if (continuityText !== null) {
        await this.#journalSelf('outbound', `${EXCHANGE_KIND_RECOVERY_PREFIX}${continuityText}`);
      }
    } catch (error) {
      await this.#journalSelf(
        'outbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}${label}の生ログの退避に失敗した: ${reasonOf(error)}` +
          '（⚠️ この区間の生ログは器の外に残っていない）',
      );
    }
    const archived: ReopenArchive =
      archiveId === null ? { kind: 'failed' } : { kind: 'saved', id: archiveId };

    // 蒸留しない開き直し（`distill: false`）はここで終わる: 弾かれているセッションの末尾を蒸留へ送ると、
    // 送った先でも弾かれて墓標が立ち、通れば汚れた内容を記憶へ書き込むため。退避した生ログは `GET /archive/:id` で読める。
    if (!options.distill) return archived;
    // (i) が落ちてもここへ進む: 蒸留は末尾を自分で読むので (i) の成否に依存せず、`return` すると記憶へ移すことが道連れになる。
    try {
      await this.#ports.distill(tailOf(await readTranscriptTail(path)));
    } catch (error) {
      await this.#journalSelf(
        'outbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}${label}の蒸留に失敗した: ${reasonOf(error)}` +
          // **退避が落ちた回に「退避は済んでいる」と書かない**（守れない約束になる）。
          (archiveId !== null
            ? '（生ログの退避は済んでいる。記憶へは移せていない。次の起動で拾い直す）'
            : '（⚠️ 退避も失敗しているので、この区間はどこにも残っていない）'),
      );

      // 墓標を立てる: 蒸留が落ちる主な理由は枠で、枠は待てば開くが、印が無いと開いた後に拾う手がかりが残らないため。投げない: 失敗の報告の途中のため
      const id = archiveId;
      if (id !== null) {
        await this.addTranscriptGrave(id);
      }
    }
    return archived;
  }

  /**
   * 墓標（`#pickUpTranscriptGrave` / `#pickUpLostSession`）の拾い直しを1本の列で回す（#4884）。
   * 起動時（`#pump` の先頭）・鍵が回った契機・枠の保持が解けた契機が同じ口を通る。走行中に来た契機は
   * 取りこぼさず、終わってからもう1周する（拾い直し同士が重ならない）。投げない。
   * `async` の関数で包まない: `#pump` の先頭の `void this.#graves.sweep()` が、最初の `await` まで同期でストアを呼ぶ形を保つため。
   */
  sweep(): Promise<void> {
    if (this.#graveSweep !== null) {
      this.#graveSweepAgain = true;
      return this.#graveSweep;
    }
    const run = (async () => {
      try {
        do {
          this.#graveSweepAgain = false;
          await this.#pickUpTranscriptGrave().catch((error: unknown) => {
            noteDroppedRecord('墓標の拾い直し', '', error);
          });
          await this.#pickUpLostSession().catch((error: unknown) => {
            noteDroppedRecord('捨てたセッションの拾い直し', '', error);
          });
        } while (this.#graveSweepAgain && !this.#ports.isStopped());
      } finally {
        this.#graveSweep = null;
      }
    })();
    this.#graveSweep = run;
    return run;
  }

  /**
   * 墓標を、既にある墓標を消さずに足す（#4884）。足せたら `true`。投げない（呼び出し側は失敗の報告の途中）。
   * 上限（`MAX_PENDING_GRAVES`）を超えて古い墓標が落ちたら、落とした区間は記憶へ移せないので ⚠ で日誌に残す。
   */
  async addTranscriptGrave(archiveId: string): Promise<boolean> {
    try {
      const { dropped } = await this.#ports.stores().sessions.addTranscriptGrave({ archiveId });
      await this.#reportDroppedGraves('生ログの墓標', dropped);
      return true;
    } catch (graveError) {
      noteDroppedRecord('墓標の記録', archiveId, graveError);
      return false;
    }
  }

  async #reportDroppedGraves(what: string, dropped: readonly string[]): Promise<void> {
    if (dropped.length === 0) return;
    await this.#journalSelf(
      'outbound',
      `${EXCHANGE_KIND_FAILURE_PREFIX}${what}が上限（${String(MAX_PENDING_GRAVES)} 件）を超えたので、` +
        `古いものから落とした: ${dropped.join(', ')}（⚠️ この区間は記憶へ移せていない）`,
    );
  }

  /** 契機から拾い直しを起こす。墓標が無ければ日誌も書かない（毎回の鍵の切替が日誌を埋めないため）。 */
  retryFor(trigger: string, options: { onlyIfKeyChanged?: boolean } = {}): void {
    if (this.#ports.isStopped() || this.#ports.isInboxClosed()) return;
    // 鍵が変わっていない契機では起こさない: 同じ鍵で撃ち直しても同じ枠に当たるだけのため。鍵の身元が取れないときは起こす（能力を削らない側）
    if (options.onlyIfKeyChanged === true && this.#graveFailedTokenKey !== undefined) {
      if (this.#ports.currentTokenKey() === this.#graveFailedTokenKey) return;
    }
    void (async () => {
      const [transcriptGraves, lostGraves] = await Promise.all([
        this.#ports
          .stores()
          .sessions.listTranscriptGraves()
          .catch(() => []),
        this.#ports
          .stores()
          .sessions.listLostSessionGraves()
          .catch(() => []),
      ]);
      if (transcriptGraves.length === 0 && lostGraves.length === 0) return;
      await this.#ports.journal({
        type: 'decision',
        decision: `墓標の拾い直しを、契機（${trigger}）で起こし直した`,
        grounds:
          '蒸留が枠で落ちると墓標が残るが、拾い直すのが起動時だけだと、鍵が回っても記憶への移しが' +
          '再起動まで遅れるため（#4884）',
      });
      await this.sweep();
    })().catch((error: unknown) => {
      noteDroppedRecord('墓標の拾い直しの起こし直し', '', error);
    });
  }

  // 起動時と、鍵が回った・枠が解けた契機（`retryFor`）で拾う: 契機の無いまま試し直しても枠はまだ閉じているため。`load()` ではなく `archive.readTail` から拾う: 退避は済んでおり、`load` は 60 秒の予算に掛かるため
  async #pickUpTranscriptGrave(): Promise<void> {
    // 古い順に1本ずつ（#4884）。1本が落ちても残りは試す: 落ちた1本が居座って後ろの区間を塞がないため
    for (const grave of await this.#ports.stores().sessions.listTranscriptGraves()) {
      await this.#pickUpOneTranscriptGrave(grave).catch((error: unknown) => {
        noteDroppedRecord('墓標の拾い直し', grave.archiveId, error);
      });
    }
  }

  async #pickUpOneTranscriptGrave(grave: TranscriptGrave): Promise<void> {
    // `read()`（全文）ではなく `readTail()`（末尾）を使う: `archive` の1行は最大 78.3 MB に育ち、全体をヒープへ載せると起動のたびに走るこの経路が OOM を起こしうるため
    const result = await this.#ports
      .stores()
      .archive.readTail(grave.archiveId, DISTILL_TRANSCRIPT_TAIL_CHARS);
    if (result.kind !== 'body') {
      // `missing` と `removed` を同じ文面へ畳まない: 別の出来事のため。どちらも印だけを残さない: 拾えないものを起動のたびに引きに行くことになるため。`missing` の文面は変えない: 保証するテストがあるため
      const text =
        result.kind === 'removed'
          ? `記憶へ移せていない区間の退避の本文が消されているので、印を下ろした: ${grave.archiveId}` +
            `（${result.removedAt} に ${result.bytes} バイトを落とした${describeArchiveRemovedBytesUnit()}。` +
            '⚠️ この区間は記憶へ移せていない）'
          : `記憶へ移せていない区間の退避が見つからないので、印を下ろした: ${grave.archiveId}` +
            '（器を作り直した、あるいはそもそも積まれなかった。⚠️ この区間は記憶へ移せていない）';
      // 判定と書き込みを1操作へ畳む: 引き直して比べる形では、引き直しの後・下ろす書き込みが効く前に新しい印が landing しうるため（`clone-grave-pickup-race.test.ts` が再現する）
      const lowered = await this.#ports.stores().sessions.clearTranscriptGraveIf(grave.archiveId);
      // 下ろしていないなら「下ろした」と書かない: 跡が嘘をつくため
      await this.#journalSelf(
        'outbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}${
          lowered
            ? text
            : `記憶へ移せていない区間の退避を拾えなかったが、拾っている間に新しい印が立ったので、印は下ろさなかった: ${grave.archiveId}`
        }`,
      );
      return;
    }
    await this.#distillGrave({
      kind: 'transcript',
      graveId: grave.archiveId,
      transcript: result.body,
      recoveryText: `前の器が記憶へ移せなかった区間を拾い直す: ${grave.archiveId}`,
      failureText: (reason) => `前の器が記憶へ移せなかった区間の蒸留に失敗した: ${reason}`,
      clear: () => this.#ports.stores().sessions.clearTranscriptGraveIf(grave.archiveId),
    });
  }

  /**
   * 墓標の拾い直しの後半（読めた本文を蒸留し、成功したら印を下ろす）。2種類の墓標で同じ手順を踏む。
   * 前半（本文の読み方と、読めなかったときの印の下ろし方）と日誌の文言は、呼び出し側が持つ: 読み取り結果の形が墓標ごとに違い、文言を寄せるとどちらの材料が無かったのかが日誌から消えるため
   */
  async #distillGrave(options: {
    readonly kind: 'transcript' | 'lost_session';
    readonly graveId: string;
    readonly transcript: string;
    /** 拾い直しの行の本文（接頭辞を除く） */
    readonly recoveryText: string;
    /** 蒸留の失敗の行の前半（接頭辞と「（印は残す…）」を除く）。`reason` は `reasonOf(error)` */
    readonly failureText: (reason: string) => string;
    /** 成功したときに印を下ろす。引き直してから下ろす形（`…GraveIf`）を渡す */
    readonly clear: () => Promise<unknown>;
  }): Promise<void> {
    const { kind, graveId } = options;

    // 上限を超えて失敗し続けている印は日誌へ書かない（#4752）。蒸留は試みる
    const quiet = await this.#graveDistillQuiet(kind, graveId);

    // 拾い直したことを日誌へ1行残す: `pre_compact_distill` の入力だけだと compaction の蒸留と区別が付かず、後から何回拾い直したかを数えられないため
    if (!quiet) {
      await this.#journalSelf(
        'outbound',
        `${EXCHANGE_KIND_RECOVERY_PREFIX}${options.recoveryText}`,
      );
    }

    try {
      await this.#ports.distill(tailOf(options.transcript), {
        journalInput: !quiet,
        onQuotaFailure: (tokenKey) => {
          this.#graveFailedTokenKey = tokenKey;
        },
      });
      this.#graveFailedTokenKey = undefined;
    } catch (error) {
      // 印は残す（#4705）: 蒸留が落ちる主な理由は枠で、次の起動か鍵の契機で拾い直せるため。鍵は枠で落ちた時点で、観測の前に控え済み（#4898）
      const note = await this.#graveDistillFailureNote(kind, graveId);
      if (note !== null) {
        await this.#journalSelf(
          'outbound',
          `${EXCHANGE_KIND_FAILURE_PREFIX}${options.failureText(reasonOf(error))}` +
            `（印は残す。次の起動で拾い直す: ${graveId}）${note}`,
        );
      }
      return;
    }

    // 印を下ろすのは蒸留が成功したときだけ、引き直してから下ろす: 拾っている間に新しい印が立つ窓があり、素で `null` を書くとその新しい方を消すため
    await options.clear();
  }

  // 読めなければ 0（書く側に倒す）: 数えられないだけで拾い直しを止める理由が無く、黙る側に倒すと失敗が見えなくなるため
  async #graveDistillQuiet(kind: 'transcript' | 'lost_session', graveId: string): Promise<boolean> {
    const prior = await this.#ports
      .stores()
      .sessions.graveDistillFailures(kind, graveId)
      .catch(() => 0);
    return prior >= GRAVE_DISTILL_FAILURE_JOURNAL_LIMIT;
  }

  /**
   * 蒸留の失敗を数え、失敗の行へ添える文を返す（#4752）。行を書かないなら `null`、添える文が無ければ空文字。
   * 数えられなかったら今までどおり書く（`undefined` 扱い）: 数えられないことを理由に失敗を黙らせると、見えなくなるため。
   */
  async #graveDistillFailureNote(
    kind: 'transcript' | 'lost_session',
    graveId: string,
  ): Promise<string | null> {
    const failures = await this.#ports
      .stores()
      .sessions.noteGraveDistillFailure(kind, graveId)
      .catch(() => undefined);
    if (failures === undefined || failures < GRAVE_DISTILL_FAILURE_JOURNAL_LIMIT) return '';
    if (failures > GRAVE_DISTILL_FAILURE_JOURNAL_LIMIT) return null;
    return `。同じ区間の蒸留が ${GRAVE_DISTILL_FAILURE_JOURNAL_LIMIT} 回続けて失敗したので、以後は成功するまで、この区間の拾い直しと失敗の行を日誌に書かない（拾い直しは続ける）`;
  }

  // 変わったときだけ器へ書く: `append` はおよそ 100ms ごとに来て、毎回書くとターン1本につき数十回の書き込みになるため。投げない: 失敗しても生ログを預ける本体の仕事を止める理由が無いため
  noteProjectKey(projectKey: string): void {
    if (this.#projectKey === projectKey) return;
    this.#projectKey = projectKey;
    void this.#ports
      .stores()
      .sessions.setProjectKey(projectKey)
      .catch((error: unknown) => {
        noteDroppedRecord('生ログの scope の記録', projectKey, error);
      });
  }

  // 捨てる前に呼ぶ。空振りは黙って通す: 生ログの預け先が無い構成は拾う材料が無く、書くと fs で動かすたびに同じ1行が積もり、`projectKey` を誰も知らない窓は預けた生ログが1件も無く失うものもほぼ無いため
  async noteLostSession(sessionId: string): Promise<void> {
    if (this.#ports.stores().sessionTranscriptTail === undefined) return;
    const projectKey = this.#projectKey ?? (await this.#ports.stores().sessions.getProjectKey());
    if (projectKey === null) return;

    try {
      const { dropped } = await this.#ports.stores().sessions.addLostSessionGrave({
        projectKey,
        sessionId,
      });
      await this.#reportDroppedGraves('捨てたセッションの墓標', dropped);
    } catch (error) {
      noteDroppedRecord('捨てたセッションの記録', sessionId, error);
    }
  }

  // `load()` は使わない: 全件を戻すと SDK が掛けている 60 秒の予算に当たりに行くため
  async #pickUpLostSession(): Promise<void> {
    const tail = this.#ports.stores().sessionTranscriptTail;
    if (tail === undefined) return;
    for (const grave of await this.#ports.stores().sessions.listLostSessionGraves()) {
      await this.#pickUpOneLostSession(tail, grave).catch((error: unknown) => {
        noteDroppedRecord('捨てたセッションの拾い直し', grave.sessionId, error);
      });
    }
  }

  async #pickUpOneLostSession(
    tail: NonNullable<Stores['sessionTranscriptTail']>,
    grave: LostSessionGrave,
  ): Promise<void> {
    const transcript = await tail.readTail(grave, DISTILL_TRANSCRIPT_TAIL_CHARS);
    if (transcript === null) {
      // 印だけを残さない: 残すと、拾えないものを起動のたびに引きに行くため
      const lowered = await this.#ports.stores().sessions.clearLostSessionGraveIf(grave.sessionId);
      await this.#journalSelf(
        'outbound',
        `${EXCHANGE_KIND_FAILURE_PREFIX}${
          lowered
            ? `捨てたセッションの生ログが1件も無いので、印を下ろした: ${grave.sessionId}` +
              '（⚠️ この区間は記憶へ移せていない）'
            : `捨てたセッションの生ログが1件も無かったが、拾っている間に新しい印が立ったので、印は下ろさなかった: ${grave.sessionId}`
        }`,
      );
      return;
    }

    await this.#distillGrave({
      kind: 'lost_session',
      graveId: grave.sessionId,
      transcript,
      recoveryText: `捨てたセッションの区間を、預けた生ログから拾い直す: ${grave.sessionId}`,
      failureText: (reason) => `捨てたセッションの区間の蒸留に失敗した: ${reason}`,
      clear: () => this.#ports.stores().sessions.clearLostSessionGraveIf(grave.sessionId),
    });
  }

  // `Clone` の `#journalSelf` と同じ形で置く（走査の試験は、この private な helper の呼び出しの字面を数える。口を直に呼ぶ字面だと拾わない）。
  // async にせず口の Promise をそのまま返す: `await` / `void` の呼び出し側のタイミングを変えない。
  // 接頭辞（EXCHANGE_KIND_*_PREFIX）は呼び出し箇所の text に字面で置く（exchange-kind-coverage.test.ts が第2引数を走査する）。
  #journalSelf(role: 'inbound' | 'outbound', text: string): Promise<void> {
    return this.#ports.journal({ type: 'exchange', with: 'self', role, text });
  }
}

import { noteBackgroundFailure, reasonOf } from './dropped-record.js';
import { NOTIFY_REPORT_EXCERPT, excerptLine } from './excerpt.js';
import type { ManagerRecord, ManagerSendResult } from './manager.js';
import { composeHeldDelivery } from './manager-notices.js';
import type { Job, JournalEntryInput } from './schema.js';
import type { SynthesizedNoticeLabel } from './synthesized-notice.js';

/**
 * `manager_send` が預かる伝言の上限（1委譲あたり）。超えた分は預からず、これまでどおり断る（`declined`）。
 * 数で締めるのは、届かない委譲へ周期の送り手が送り続けて台帳の1行が育ち続けないため。字数は1行の jsonb の大きさの歯止め。
 */
export const HELD_MESSAGES_MAX_COUNT = 20;
const HELD_MESSAGES_MAX_CHARS = 200_000;
/**
 * 預かりの期限。過ぎたら捨て、本文ごと日誌とクローンへ返す。背景処理が1日を超えて残る委譲は、待つより起こし直すほうがよい（`manager_stop` → `manager_start`）とクローンが判断する材料にする。
 */
export const HELD_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 預かった伝言が背景処理だけを理由にこれだけ届かなければ、背景処理ごと古い鍵のセッションを畳んで新しい鍵で届ける。
 * 背景処理そのものには上限を置かない（人が走らせる長いジョブを器が奪わない）。上限は「話しかけたい相手が居るのに古い鍵で居座る」長さにだけ掛ける。
 */
export const HELD_FORCE_FOLD_AFTER_MS = 15 * 60 * 1000;

/**
 * 畳めずに断った回の材料（#5041）。`HeldMessages#deliver` が15分届かない預かりをクローンへ知らせるために使う。
 * 鍵の値は持たない（世代・tokenId・状態だけ）。コマンドは伏せ字済み・字数を切ってある。
 */
export interface StaleHoldStuck {
  /** 畳めない理由（`#foldStaleTokenSession` の `blockers` をそのまま。それ以前に断った回は断った理由1つ） */
  blockers: string[];
  generation?: number;
  heldTokenId?: string;
  heldTokenState?: string;
  /** runner が本数を返したときだけ */
  backgroundTasks?: number;
  backgroundCommands: string[];
}

/**
 * 預かりの届け直しが `Pool#send` へ渡す届け方（`SendDelivery` の `mode === 'held-delivery'` の形）。
 * 断られても預け直さず、預かりの列にも並ばない（並ぶと自分自身を待つ）。
 */
export interface HeldDelivery {
  mode: 'held-delivery';
  // 届けた断り書きが畳んだ背景処理（peer を除く）の本数を呼び手へ返す（#4902）: 起こし直しが成功した回だけクローンへ知らせるため
  onFoldNoticeDelivered: (backgroundTasks: number) => void;
  // 見回り（`deliverHeldMessages`）からの届け直しだけ真（#4982）: 前と同じ判定で断るだけなら新しい判断ではないので、decision を書き直さない
  pollRetry: boolean;
  // 待ちの上限（`HELD_FORCE_FOLD_AFTER_MS`）を過ぎた見回りの回に、畳まずに断った材料を呼び手へ返す（#5041）
  onStuck: (stuck: StaleHoldStuck) => void;
}

function composeHeldStuckNotice(
  managerId: string,
  count: number,
  oldestHeldAt: string,
  stuck: StaleHoldStuck,
): string {
  const lines = [
    `${managerId} へ預かった伝言 ${String(count)} 通が、待ちの上限（${String(HELD_FORCE_FOLD_AFTER_MS / 60_000)} 分）を過ぎても、畳めずに届けられていない（最初の預かり ${oldestHeldAt}）。`,
    `- 抱えている鍵: 世代 ${stuck.generation === undefined ? '（分からない）' : String(stuck.generation)} / tokenId=${stuck.heldTokenId ?? '（分からない）'} / 状態=${stuck.heldTokenState ?? '（聞いていない）'}`,
    `- 畳めない理由: ${stuck.blockers.join('。')}`,
    `- 背景処理: ${stuck.backgroundTasks === undefined ? '本数が分からない' : `${String(stuck.backgroundTasks)} 本`}` +
      (stuck.backgroundCommands.length === 0
        ? '（コマンドは分からない）'
        : `（コマンド: ${stuck.backgroundCommands.join(' / ')}）`),
    '取れる手: (1) 待つ。届けられるようになれば自動で届ける（送り直さないこと。二重に届く）。' +
      '(2) 残っているものを捨ててよいなら manager_stop → manager_start で後継を起こす（預かりは本文ごと返る）。',
    '同じ理由の間は、この知らせを繰り返さない。',
  ];
  return lines.join('\n');
}

export interface HeldMessagesDeps {
  records: ReadonlyMap<string, ManagerRecord>;
  load: (managerId: string) => Promise<ManagerRecord | null>;
  persist: (record: ManagerRecord) => Promise<void>;
  journal: (entry: JournalEntryInput) => Promise<void>;
  queueNotice: (managerId: string, label: SynthesizedNoticeLabel, text: string) => void;
  /** `Pool#send` の `{}`（options）を埋めた形。届け直しは `manager_send` と同じ経路を通る。 */
  send: (managerId: string, message: string, delivery: HeldDelivery) => Promise<ManagerSendResult>;
  now: () => number;
  nowIso: () => string;
  stopped: () => boolean;
  /** 枠で止まった印（`Pool#usageStopped`）。読むだけ。 */
  usageStopped: ReadonlySet<string>;
  /** 器の入れ替えで取り直している最中の委譲（`Pool#resuming`）。読むだけ。 */
  resuming: ReadonlySet<string>;
}

/**
 * 預かった伝言（`Job.heldMessages`）の預かり・届け直し・返却。台帳が正で、この欄は索引と進行中の印だけを持つ（`PushLedger` と同じく、
 * 必要なものを束で受け取る）。`Pool#send` を呼び返すので、届け直しの `await` の数と順は `Pool` にあったときのまま。
 */
export class HeldMessages {
  /**
   * 預かった伝言（`Job.heldMessages`）を持つ委譲。台帳が正で、これは周期の見回りで全件の台帳を読まないための索引。
   * 起動時の `Pool#restoreJobs` が台帳から組み直す。
   */
  readonly #jobs = new Set<string>();
  /** 届け直しの最中の委譲: 同じ伝言を2本並べて届けない。 */
  readonly #delivering = new Set<string>();
  /**
   * 古い鍵の done へ本文を断った decision の、最後に書いた本文（decision と grounds）。managerId ごと（#4982）。
   * 見回りの届け直しが同じ判定をやり直しただけの回に、同じ decision を書き直さないために使う。預かりが届いた・捨てた・担当を外した時点で消す。
   */
  readonly #lastStaleDecline = new Map<string, string>();
  /** 15分届かない預かりを知らせた理由（`blockers` の並び）を委譲ごとに覚える（#5041）: 同じ理由では見回りのたびに知らせない。`#lastStaleDecline` と同じ所で消す。 */
  readonly #lastStuckNotice = new Map<string, string>();
  readonly #records: HeldMessagesDeps['records'];
  readonly #load: HeldMessagesDeps['load'];
  readonly #persist: HeldMessagesDeps['persist'];
  readonly #journal: HeldMessagesDeps['journal'];
  readonly #queueNotice: HeldMessagesDeps['queueNotice'];
  readonly #send: HeldMessagesDeps['send'];
  readonly #now: () => number;
  readonly #nowIso: () => string;
  readonly #stopped: () => boolean;
  readonly #usageStopped: ReadonlySet<string>;
  readonly #resuming: ReadonlySet<string>;

  constructor(deps: HeldMessagesDeps) {
    this.#records = deps.records;
    this.#load = deps.load;
    this.#persist = deps.persist;
    this.#journal = deps.journal;
    this.#queueNotice = deps.queueNotice;
    this.#send = deps.send;
    this.#now = deps.now;
    this.#nowIso = deps.nowIso;
    this.#stopped = deps.stopped;
    this.#usageStopped = deps.usageStopped;
    this.#resuming = deps.resuming;
  }

  /** 預かりを持つ委譲の索引。呼び手は読むだけ（`Pool#autoFoldBeforeWakes` が起こし直しの対象から外す）。 */
  jobIds(): Iterable<string> {
    return this.#jobs;
  }

  /** 起動時の組み直し: 台帳に預かりがあれば索引へ入れる。 */
  indexRestored(job: Job): void {
    if ((job.heldMessages?.length ?? 0) > 0) this.#jobs.add(job.id);
  }

  /** 古い鍵の done へ最後に断った decision の本文。なければ `undefined`。 */
  lastStaleDecline(managerId: string): string | undefined {
    return this.#lastStaleDecline.get(managerId);
  }

  rememberStaleDecline(managerId: string, declineRecord: string): void {
    this.#lastStaleDecline.set(managerId, declineRecord);
  }

  /** 担当を外す（`Pool#retire`）とき、断りの記録と15分の知らせの記録を消す。 */
  forget(managerId: string): void {
    this.#lastStaleDecline.delete(managerId);
    this.#lastStuckNotice.delete(managerId);
  }

  /**
   * 背景処理だけが理由で預かった伝言を、遅くともいつ畳んで届けるか（epoch ms）。見回りの届け直し（`deliver`）が畳む時刻
   * ＝ 最初の預かりと背景処理待ちに入った時刻の早いほう＋上限（`#send` の `waitedLongEnough` と同じ数え方）。これから預かる伝言は、いまを預かりの時刻とする。
   * 鍵の回転の起こし直しの上限（枠で止まった時刻から数える）は混ぜない: 挑み直しの状態が無い担当には効かず、「遅くとも」が守れない。
   * そちらが先に畳めば、この時刻より早く届くだけである。
   */
  foldDueAt(oldestHeldAt: string | undefined, awaitingSince: string | undefined): number {
    const starts = [oldestHeldAt ?? this.#nowIso(), awaitingSince]
      .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
      .filter((at) => !Number.isNaN(at));
    return Math.min(...starts) + HELD_FORCE_FOLD_AFTER_MS;
  }

  /**
   * 届けられない伝言を台帳に預かる。上限（`HELD_MESSAGES_MAX_COUNT` / `HELD_MESSAGES_MAX_CHARS`）を超えるなら預からず断る。
   * 書けなかったら預かったと言わない（台帳が正で、言った後に消えると呼び手は送り直す機会を失う）。
   */
  async hold(
    record: ManagerRecord,
    message: string,
    reason: string,
    // 背景処理だけが理由の回の、畳んで届ける上限の時刻（`foldDueAt`）。分からない・他の理由がある回は無い
    foldDueAt?: number,
  ): Promise<ManagerSendResult> {
    const managerId = record.job.id;
    const held = record.job.heldMessages ?? [];
    const chars = held.reduce((sum, item) => sum + item.text.length, 0) + message.length;
    if (held.length >= HELD_MESSAGES_MAX_COUNT || chars > HELD_MESSAGES_MAX_CHARS) {
      return {
        outcome: 'declined',
        detail:
          `${reason} 預かりの上限（1委譲あたり ${String(HELD_MESSAGES_MAX_COUNT)} 通・合計 ` +
          `${String(HELD_MESSAGES_MAX_CHARS)} 字。いま ${String(held.length)} 通を預かっている）を超えるので、` +
          'この伝言は預からなかった。送ってもいない。',
      };
    }
    const heldAt = this.#nowIso();
    const previous = record.job.heldMessages;
    record.job.heldMessages = [...held, { text: message, heldAt, reason }];
    try {
      await this.#persist(record);
    } catch (error) {
      record.job.heldMessages = previous;
      return {
        outcome: 'declined',
        detail: `${reason} 預かろうとしたが台帳に書けなかった（${reasonOf(error)}）。預かっていないし、送ってもいない。`,
      };
    }
    this.#jobs.add(managerId);
    const count = held.length + 1;
    await this.#journal({
      type: 'decision',
      decision: `[${managerId}] manager_send の伝言を届けずに預かった（預かり ${String(count)} 通目）`,
      grounds: `managerId=${managerId} 理由=${excerptLine(reason, NOTIFY_REPORT_EXCERPT)}`,
    });
    const expiresAt = new Date(Date.parse(heldAt) + HELD_MESSAGE_TTL_MS).toISOString();
    const deadlineClause =
      foldDueAt === undefined
        ? ''
        : `**遅くとも ${new Date(Math.max(foldDueAt, this.#now())).toISOString()}（待ちの上限 ` +
          `${String(HELD_FORCE_FOLD_AFTER_MS / 60_000)} 分）の後の見回り（1分ごと）で、残っている背景処理ごと畳み、` +
          '新しい鍵で起こし直してこの伝言を届ける**（背景処理が先に終われば、その時点で届く）。' +
          'それまで待てば、manager_stop も後継も要らない。';
    return {
      outcome: 'held',
      detail:
        `${reason}\n\nこの伝言は捨てずに預かった（${managerId} の預かり ${String(count)} 通目。期限 ${expiresAt}）。` +
        deadlineClause +
        '届けられるようになったら（背景処理・確認待ちが片付いて新しい鍵で起こし直せたとき・抱えている鍵が使えるようになったとき・' +
        '器が替わって resume から入るとき）、預かった順に自動で届け、届けたら知らせる。' +
        '送り直さないこと（二重に届く）。続けて送った伝言は、預かりの後ろに並べてまとめて届ける。' +
        (foldDueAt === undefined
          ? '残っている背景処理を捨ててよいなら manager_stop → manager_start で後継を起こす（預かりは本文ごと返す）。'
          : '上限を待たずに、残っている背景処理（とその結果）を今すぐ捨ててよい場合だけ、' +
            'manager_stop → manager_start で後継を起こす（預かりは本文ごと返す）。'),
    };
  }

  /**
   * 預かった伝言を古い順に1通へまとめ、`Pool#send` の同じ経路で届け直す。届けられなかったら預かったまま（`undefined` ではなく `held` を返す）。
   * `trigger === 'poll'` で届いた回だけクローンへ知らせる: `'caller'` は `manager_send` の応答がそのまま知らせになる。
   * 届いた分だけを列の頭から外す: 届け直しの `await` の間に後ろへ積まれた伝言を一緒に消さないため。
   */
  async deliver(
    managerId: string,
    trigger: 'caller' | 'poll',
  ): Promise<ManagerSendResult | undefined> {
    if (this.#delivering.has(managerId)) return undefined;
    this.#delivering.add(managerId);
    try {
      const record = this.#records.get(managerId) ?? (await this.#load(managerId));
      if (!record) {
        this.#jobs.delete(managerId);
        return undefined;
      }
      const held = record.job.heldMessages ?? [];
      if (held.length === 0) {
        this.#jobs.delete(managerId);
        return undefined;
      }

      const status = record.job.status;
      // 枠で止まった印の付いた failed・lost は終端ではない（#4854）: 鍵の回転で新しい鍵で起こし直す対象なので、預かりを保ち、起こし直して status が戻った後の見回りで届ける（預かった時点の「自動で届ける」の約束どおり）。
      // 期限切れの返却は下で今どおり効かせる: 起こし直されないまま残ると、本文が期限を過ぎても返らないため
      const awaitingUsageWake =
        (status === 'lost' || status === 'failed') && this.#usageStopped.has(managerId);
      // 止められた委譲と、後継へ引き継いだ委譲だけは届け先が無い: 本文を返す。
      // failed・lost は捨てない（#5111）: `manager_send` と同じく resume から入り直せば届くため（2026-10-20 18:57〜19:01Z に、捨てた後で
      // クローンが打ち直した manager_send が resume で届いた）。届けを試し、届かなかったときだけ下で本文を返す。
      if (status === 'stopped' || record.job.supersededBy !== undefined) {
        await this.release(record, held.length, `委譲が終端した（status=${status}）`);
        return {
          outcome: 'declined',
          detail: `${managerId} は終端している（status=${status}）ので届けられない。預かっていた伝言は本文ごと返した。`,
        };
      }
      const resumeToDeliver = !awaitingUsageWake && (status === 'lost' || status === 'failed');
      // 器の入れ替えで取り直している最中は重ねない（同じ session を二本起こす）: 返さずに次の見回りで試す
      if (resumeToDeliver && this.#resuming.has(managerId)) return undefined;
      const now = this.#now();
      // 預かりは時刻順に積むので、期限切れは列の頭にだけ居る。
      const expiredCount = held.findIndex(
        (item) => now - Date.parse(item.heldAt) <= HELD_MESSAGE_TTL_MS,
      );
      const expired = expiredCount === -1 ? held.length : expiredCount;
      if (expired > 0) {
        await this.release(
          record,
          expired,
          `預かりの期限（${String(HELD_MESSAGE_TTL_MS / 3_600_000)} 時間）を過ぎた`,
        );
      }
      const batch = record.job.heldMessages ?? [];
      if (batch.length === 0) return undefined;
      if (awaitingUsageWake) return undefined;

      let foldedBackgroundTasks = 0;
      let stuck: StaleHoldStuck | undefined;
      const result = await this.#send(managerId, composeHeldDelivery(batch), {
        mode: 'held-delivery',
        onFoldNoticeDelivered: (backgroundTasks) => {
          foldedBackgroundTasks = backgroundTasks;
        },
        pollRetry: trigger === 'poll',
        onStuck: (material) => {
          stuck = material;
        },
      });
      if (result.outcome !== 'delivered' && result.outcome !== 'answered') {
        if (resumeToDeliver) {
          // 終わった委譲を resume で起こして届けようとしたが届かなかった: 待っても届く見込みが無いので、本文を返す
          await this.release(
            record,
            batch.length,
            `委譲が終わっていて（status=${status}）、resume で起こして届けようとしたが届かなかった: ${excerptLine(result.detail, NOTIFY_REPORT_EXCERPT)}`,
          );
          return {
            outcome: 'declined',
            detail:
              `${managerId} は終わっていて（status=${status}）、resume で起こして届けようとしたが届かなかった（${result.detail}）。` +
              '預かっていた伝言は本文ごと返した。',
          };
        }
        if (stuck !== undefined) await this.#noticeStuck(managerId, batch, stuck);
        return {
          outcome: 'held',
          detail:
            `${managerId} へはまだ届けられない（${result.detail}）。` +
            `預かっている ${String(batch.length)} 通は捨てずに持っている（最初の預かり ${batch[0]?.heldAt ?? '?'}）。` +
            '届けられるようになったら自動で届け、届けたら知らせる。送り直さないこと（二重に届く）。',
        };
      }

      const remaining = (record.job.heldMessages ?? []).slice(batch.length);
      record.job.heldMessages = remaining.length === 0 ? undefined : remaining;
      await this.#persist(record);
      if (remaining.length === 0) this.#jobs.delete(managerId);
      // 背景処理を畳んだ回は、届け直しの知らせ（poll）か `manager_send` の応答（caller）の本文へ足す（#4913）: 別の種類で積むと同じ届け直しを2回知らせてしまう。結果は届かないので担当が自分で確かめて進める。クローンは止まったと見誤りうる。peer だけを預けた回では足さない
      const foldedClause =
        foldedBackgroundTasks > 0
          ? `背景処理 ${String(foldedBackgroundTasks)} 本を畳んで起こし直し、結果は届かないので自分で確かめて続きを進めるよう促した。`
          : '';
      this.forget(managerId);
      const summary =
        `預かっていた伝言 ${String(batch.length)} 通を ${managerId} へ届けた` +
        `（最初の預かり ${batch[0]?.heldAt ?? '?'}）。${foldedClause}${result.detail}`;
      await this.#journal({
        type: 'decision',
        decision: `[${managerId}] 預かっていた伝言 ${String(batch.length)} 通を届けた`,
        grounds: `managerId=${managerId} 契機=${trigger === 'poll' ? '周期の見回り' : 'manager_send'} ${result.detail}`,
      });
      if (trigger === 'poll') {
        this.#queueNotice(
          managerId,
          'held_delivered',
          [
            summary,
            ...batch.map(
              (item, index) =>
                `- ${String(index + 1)}通目（${item.heldAt}）: ${excerptLine(item.text, NOTIFY_REPORT_EXCERPT)}`,
            ),
          ].join('\n'),
        );
      }
      return { outcome: 'delivered', detail: summary };
    } finally {
      this.#delivering.delete(managerId);
    }
  }

  /**
   * 15分届かず、畳めずに断った預かりを、クローンへ知らせる（#5041）。理由（`blockers` の並び）が前に知らせたものと同じなら出さない:
   * 見回りのたびに出すと同じ知らせが積もる。理由が変われば、もう1回出す。経過は書かない（時刻だけ）: 知らせが積まれてから読まれるまでに嘘になるため。
   */
  async #noticeStuck(
    managerId: string,
    batch: readonly { heldAt: string }[],
    stuck: StaleHoldStuck,
  ): Promise<void> {
    const reasonKey = stuck.blockers.join('\u0000');
    if (this.#lastStuckNotice.get(managerId) === reasonKey) return;
    this.#lastStuckNotice.set(managerId, reasonKey);
    const oldestHeldAt = batch[0]?.heldAt ?? '?';
    const text = composeHeldStuckNotice(managerId, batch.length, oldestHeldAt, stuck);
    await this.#journal({
      type: 'decision',
      decision: `[${managerId}] 預かった伝言 ${String(batch.length)} 通が ${String(HELD_FORCE_FOLD_AFTER_MS / 60_000)} 分を過ぎても届けられないので、クローンへ知らせた`,
      grounds:
        `managerId=${managerId} 最初の預かり=${oldestHeldAt} ` +
        `鍵の世代=${stuck.generation === undefined ? '（分からない）' : String(stuck.generation)} ` +
        `鍵の状態=${stuck.heldTokenState ?? '（聞いていない）'} ` +
        `畳めない理由=${stuck.blockers.join('。')} ` +
        `背景処理=${stuck.backgroundTasks === undefined ? '（本数が分からない）' : `${String(stuck.backgroundTasks)} 本`}` +
        `${stuck.backgroundCommands.length === 0 ? '' : ` コマンド=${stuck.backgroundCommands.join(' / ')}`}（#5041）`,
    });
    this.#queueNotice(managerId, 'held_stuck', text);
  }

  /** 列の頭から `count` 通を捨て、本文ごと日誌とクローンへ返す: 預かった以上、黙って消すと誰にも届かない伝言が生まれるため。 */
  async release(record: ManagerRecord, count: number, why: string): Promise<void> {
    const managerId = record.job.id;
    this.forget(managerId);
    const held = record.job.heldMessages ?? [];
    const released = held.slice(0, count);
    const remaining = held.slice(count);
    record.job.heldMessages = remaining.length === 0 ? undefined : remaining;
    await this.#persist(record);
    if (remaining.length === 0) this.#jobs.delete(managerId);
    const body = [
      `${managerId} へ預かっていた伝言 ${String(released.length)} 通を、届けずに捨てた（${why}）。本文を返す。` +
        '要るなら届け先を決め直して送ること。',
      ...released.map(
        (item, index) => `--- ${String(index + 1)}通目（預かり ${item.heldAt}）---\n${item.text}`,
      ),
    ].join('\n');
    await this.#journal({
      type: 'decision',
      decision: `[${managerId}] 預かっていた伝言 ${String(released.length)} 通を届けずに捨てた（${why}）`,
      grounds: body,
    });
    this.#queueNotice(managerId, 'held_released', body);
  }

  /** 周期の見回り（`Pool#deliverHeldMessages`）。預かりを持つ委譲を1つずつ届け直し、落ちても次へ進む。 */
  async deliverAll(): Promise<void> {
    if (this.#stopped()) return;
    for (const managerId of [...this.#jobs]) {
      if (this.#stopped()) return;
      try {
        await this.deliver(managerId, 'poll');
      } catch (error) {
        noteBackgroundFailure('預かった伝言の届け直し', `managerId=${managerId}`, error);
      }
    }
  }
}

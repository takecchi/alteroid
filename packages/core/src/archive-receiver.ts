import { describeArchiveContinuityForJournal } from './archive-continuity.js';
import { noteDroppedRecord } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import type { ManagerRecord } from './manager.js';
import type { RunnerClient, RunnerEvent } from './runner-protocol.js';
import type { SessionLoaders } from './session-loaders.js';
import type { Stores } from './store.js';

/** 退避の id ごとの取り寄せの結果を覚えておく数（送り直しとの二重を防ぐ。#4899）。 */
const ARCHIVE_REF_OUTCOMES_MAX = 512;

/**
 * `Pool` が口として渡すもの。関数の口は async の皮で包まずに渡す（`await` の数と順を変えないため）。
 * `stores` は差し替わりうるので、欄ではなく入れ物の参照を受けて呼ぶたびに引く。
 */
export interface ArchiveReceiverPorts {
  stores: Pick<Stores, 'archive' | 'sessionStore'>;
  /** `SessionLoaders#fetchArchiveRetrying` を束ねたもの。 */
  fetchArchiveRetrying: SessionLoaders['fetchArchiveRetrying'];
  /** `SessionLoaders#appendMirrorRetrying` を束ねたもの。 */
  appendMirrorRetrying: SessionLoaders['appendMirrorRetrying'];
  persist: (record: ManagerRecord) => Promise<void>;
  /** `Pool#journalExchange` を束ねたもの（呼び出しの形は `exchange-kind-coverage.test.ts` が数える）。 */
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
}

/**
 * 生ログの退避（`archive`）と写し（`mirror`）を受け取る側（`Pool#handleEvent` から切り出した。振る舞いは変えていない）。
 * 移った後の古い runner から届いたものも捨てずに取り込む（取りに行く先は出来事を出した器）ので、`movedAwayFrom` は見ない。
 */
export class ArchiveReceiver {
  readonly #ports: ArchiveReceiverPorts;
  readonly #journalExchange: ArchiveReceiverPorts['journalExchange'];

  // 参照で届いた退避の id ごとに、置き場へ入れられたか（送り直しの本文との二重を防ぐ。#4899）。キーは `managerId/id`
  readonly #archiveRefOutcomes = new Map<string, Promise<boolean>>();
  // 本文で（送り直しで）届いた退避の id。参照の取り寄せが「無い」で落ちても落とした扱いにしないため
  readonly #inlineArchiveIds = new Set<string>();

  /**
   * 同じ生ログ（`projectKey`・`sessionId`・`subpath`）への `mirror` の預けを、届いた順に1つずつ行う（#4485）。
   * `Pool#onEvent` は並行に走るので、並べないと先の預け（大きい書き出し）が pg へ届く前に後の預けが追い越し、
   * 生ログの行が挿入の順（`seq`）で読み戻されるときに入れ替わる。札は最初の `await` より前に取る（`UsageRecordOrder` と同じ）。
   */
  readonly #mirrorTails = new Map<string, Promise<void>>();
  readonly #mirrorTurns = new WeakMap<RunnerEvent, Promise<void>>();

  constructor(ports: ArchiveReceiverPorts) {
    this.#ports = ports;
    this.#journalExchange = ports.journalExchange;
  }

  /** 札を取る。返すのは処理の終わりで呼ぶ解放（`Pool#onEvent` の `finally`）。 */
  takeMirrorTurn(event: Extract<RunnerEvent, { type: 'mirror' }>): () => void {
    // 欄の欠けで落とさない: 落とすと預けそのものが失われる（並べる鍵が粗くなるだけで済ませる）
    const key = [event.managerId, event.key?.projectKey, event.key?.sessionId, event.key?.subpath]
      .map((part) => String(part ?? '').replaceAll('\u0000', ''))
      .join('\u0000');
    const previous = this.#mirrorTails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    this.#mirrorTails.set(key, tail);
    this.#mirrorTurns.set(event, previous);
    return () => {
      release();
      // 最後の札なら消す: 生ログの鍵ごとに積もらせない
      void tail.then(() => {
        if (this.#mirrorTails.get(key) === tail) this.#mirrorTails.delete(key);
      });
    };
  }

  async onMirror(event: Extract<RunnerEvent, { type: 'mirror' }>): Promise<void> {
    const store = this.#ports.stores.sessionStore;
    if (store === undefined) return;
    // 同じ生ログへの先の預けが終わるのを待つ（`#mirrorTails`）
    await this.#mirrorTurns.get(event);
    await this.#ports.appendMirrorRetrying(store, event);
  }

  async onArchive(
    event: Extract<RunnerEvent, { type: 'archive' }>,
    fromRunnerId: string,
    record: ManagerRecord,
  ): Promise<void> {
    // 本文は参照で届くことがある（#4485）: SSE の1行で数十 MB を運ぶと、受け取りの間ループが塞がるため。取りに行くのは出来事を出した器
    // 送り直し（`body` と元の `id`）と参照が同じ退避を指すなら、置き場へ入れるのは1回だけ（#4899）。
    // 参照の取り寄せが終わった（置き場へ入れた）なら本文は捨てる。取り寄せ中なら結果を待ち、取れなかったときだけ本文を使う
    const archiveKey =
      event.ref !== undefined
        ? `${event.managerId}/${event.ref.id}`
        : event.id !== undefined
          ? `${event.managerId}/${event.id}`
          : undefined;
    let settleStored: ((stored: boolean) => void) | undefined;
    if (archiveKey !== undefined && event.ref !== undefined) {
      const outcome = new Promise<boolean>((resolve) => {
        settleStored = resolve;
      });
      this.#archiveRefOutcomes.set(archiveKey, outcome);
      // 古いものから忘れる: 退避の id は一度きりで、数を持ち続けない
      while (this.#archiveRefOutcomes.size > ARCHIVE_REF_OUTCOMES_MAX) {
        const oldest = this.#archiveRefOutcomes.keys().next().value;
        if (oldest === undefined) break;
        this.#archiveRefOutcomes.delete(oldest);
      }
    } else if (archiveKey !== undefined && event.body !== undefined) {
      this.#inlineArchiveIds.add(archiveKey);
      while (this.#inlineArchiveIds.size > ARCHIVE_REF_OUTCOMES_MAX) {
        const oldest = this.#inlineArchiveIds.values().next().value;
        if (oldest === undefined) break;
        this.#inlineArchiveIds.delete(oldest);
      }
      const earlier = this.#archiveRefOutcomes.get(archiveKey);
      if (earlier !== undefined && (await earlier)) return;
    }
    const chars = event.body?.length ?? event.ref?.chars ?? 0;
    let body: string;
    let fetchedFrom: { runner: RunnerClient; archiveId: string } | undefined;
    try {
      if (event.body !== undefined) {
        body = event.body;
      } else if (event.ref !== undefined) {
        const fetched = await this.#ports.fetchArchiveRetrying(
          event.managerId,
          event.ref.id,
          fromRunnerId,
        );
        body = fetched.body;
        fetchedFrom = { runner: fetched.runner, archiveId: event.ref.id };
      } else {
        throw new Error('本文も参照も無い退避の出来事が届いた');
      }
    } catch (error) {
      settleStored?.(false);
      // 本文で届いた id への参照の取り寄せが落ちたのは、runner が送り直して預かりを消したため。本文は届いているので、落とした扱いにしない
      if (
        archiveKey !== undefined &&
        event.ref !== undefined &&
        this.#inlineArchiveIds.has(archiveKey)
      ) {
        return;
      }
      noteDroppedRecord(
        'トランスクリプトの退避',
        `managerId=${event.managerId} chars=${String(chars)}${event.ref === undefined ? '' : ` ref=${event.ref.id}`}`,
        error,
      );
      return;
    }
    try {
      const write = await this.#ports.stores.archive.archive(event.managerId, body);
      record.job.archiveIds = [...(record.job.archiveIds ?? []), write.id];
      settleStored?.(true);
      await this.#ports.persist(record);
      // 置き場へ入れてから消させる: 先に消すと、置き場への書き込みが失敗した回に本文がどこにも残らないため。消せなくても runner の期限が消す
      if (fetchedFrom !== undefined) {
        await fetchedFrom.runner
          .deleteArchive?.(event.managerId, fetchedFrom.archiveId)
          .catch(() => undefined);
      }
      // `#journal` は自分で失敗を握るので、退避と台帳への記録の成功を日誌の失敗に道連れにしない。
      const continuityText = describeArchiveContinuityForJournal({
        caller: 'マネージャーの生ログの退避',
        sessionId: event.managerId,
        continuity: write.continuity,
        comparedTo: write.comparedTo,
        bodyChars: body.length,
      });
      if (continuityText !== null) {
        await this.#journalExchange('outbound', `${EXCHANGE_KIND_FAILURE_PREFIX}${continuityText}`);
      }
    } catch (error) {
      settleStored?.(false);
      // 止めないが黙って消さない: 跡が無いと「そもそも退避しなかった」と区別が付かない。
      noteDroppedRecord(
        'トランスクリプトの退避',
        `managerId=${event.managerId} chars=${String(body.length)}`,
        error,
      );
    }
  }
}

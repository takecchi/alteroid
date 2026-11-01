import { noteDroppedRecord, noteUnreadableRecord, reasonOf } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import type { LeaseSighting } from './lease.js';
import { jsonLinesYielding } from './loop-yield.js';
import type { Job, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import type { RunnerClient, RunnerEvent, RunnerRegistry } from './runner-protocol.js';
import {
  RESUME_PEER_BUDGET_CHARS,
  buildPeerTranscript,
  isPeerSubpath,
  peerIdOfSubpath,
  selectPeersWithinBudget,
  type ResumePeerTranscript,
} from './resume-peers.js';
import {
  RESUME_SUBAGENT_BUDGET_CHARS,
  isSubagentSubpath,
  selectSubagentsWithinBudget,
  type ResumeSubagentTranscript,
} from './resume-subagents.js';

/**
 * runner に預けた退避を取りに行って失敗したとき、やり直すまでの待ち（回数はこの長さ）。
 * 取りに行くのは出来事を受けた1回だけなので、やり直さないと本文は預かりの期限（`ARCHIVE_STASH_TTL_MS`、1時間）で消える。合計はその期限より十分短い。
 */
const ARCHIVE_FETCH_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000];

/**
 * 生ログの写し（`mirror`）を PG へ預けるのが落ちたとき、やり直すまでの待ち（回数はこの長さ。#4657）。
 * runner は預けたかを待たず送り直しもしないので、やり直さないとその塊は抜け、後の resume が欠けた会話から再開する。
 * 待つ間、同じ会話の後ろの塊は順番待ちで溜まるので、合計は短めにする。
 */
const MIRROR_APPEND_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];

/**
 * **`unknown[] | null` にしない。** `null` だと「預かっていない」と「読みに行って失敗した」が同じ値になり、
 * 一時的に読めなかっただけの委譲が `lost` で終端して、クローンに存在の否定が届く。
 */
type SessionMaterial =
  | { kind: 'loaded'; entries: unknown[] }
  /** 預かっていない（store が無い / `projectKey` が無い / 引いたが空だった）。 */
  | { kind: 'absent' }
  /** **引きに行って失敗した。** 待てば直りうるので、恒久の結論に変えない。 */
  | { kind: 'unreadable' };

export interface SessionLoadersDeps {
  /** `sessionStore` は呼ぶたびに読む（構築時に控えない）。 */
  stores: Pick<Stores, 'sessionStore'>;
  runners: Pick<RunnerRegistry, 'get'>;
  journal: (entry: JournalEntryInput) => Promise<void>;
  journalExchange: (role: 'inbound' | 'outbound', text: string) => Promise<void>;
  /** デーモンが止まったか。やり直しの待ちを打ち切る判断に使う。 */
  stopped: () => boolean;
  sighting: (runnerId: string) => LeaseSighting;
  swapNote: (runnerId: string, before: string | undefined) => string;
}

/**
 * 預かった生ログ・作業者・peer の読み出しと、runner への取り寄せ・PG への預けの再試行。`Pool` の欄は持たず、
 * 読むのは `stores`・`runners` と、止まったかだけ（`PushLedger` と同じく、必要なものを束で受け取る）。
 */
export class SessionLoaders {
  readonly #stores: Pick<Stores, 'sessionStore'>;
  readonly #runners: Pick<RunnerRegistry, 'get'>;
  readonly #journal: SessionLoadersDeps['journal'];
  // 接頭辞（EXCHANGE_KIND_*_PREFIX）は呼び出し箇所の text に字面で置く（exchange-kind-coverage.test.ts が第2引数を走査する）。
  readonly #journalExchange: SessionLoadersDeps['journalExchange'];
  readonly #stopped: () => boolean;
  readonly #sighting: SessionLoadersDeps['sighting'];
  readonly #swapNote: SessionLoadersDeps['swapNote'];

  constructor(deps: SessionLoadersDeps) {
    this.#stores = deps.stores;
    this.#runners = deps.runners;
    this.#journal = deps.journal;
    this.#journalExchange = deps.journalExchange;
    this.#stopped = deps.stopped;
    this.#sighting = deps.sighting;
    this.#swapNote = deps.swapNote;
  }

  /**
   * 「無い」と「読めなかった」を分けて返す: `null` に畳むと下流が恒久の結論へ変える（`Pool#resume` 参照）。本文は stderr に出さない（`noteDroppedRecord` と同じ）。
   */
  async loadSession(projectKey: string | undefined, sessionId: string): Promise<SessionMaterial> {
    const store = this.#stores.sessionStore;
    if (store === undefined || projectKey === undefined) return { kind: 'absent' };
    try {
      const entries = await store.load({ projectKey, sessionId });
      // 空と不在を分けない: どちらも引けてはいて、待っても変わらない。
      if (entries === null || entries.length === 0) return { kind: 'absent' };
      return { kind: 'loaded', entries };
    } catch (error) {
      noteUnreadableRecord(
        '預かってある生ログ',
        `projectKey=${projectKey} sessionId=${sessionId}`,
        error,
      );
      return { kind: 'unreadable' };
    }
  }

  /**
   * 作業者（`subagents/…`）の記録を預かり先から引く。引けなくても resume は止めない（主の記録だけで続けられる）が、
   * 戻せなかった作業者と上限で入らなかった作業者は日誌へ残す: 黙って落とすと、`SendMessage` が「記録が無い」で失敗する理由が追えない。
   * `listSubkeys` を持たない預かり先は、作業者の分が無いものとして空を返す。
   */
  async loadSubagents(
    managerId: string,
    projectKey: string,
    sessionId: string,
  ): Promise<ResumeSubagentTranscript[]> {
    const store = this.#stores.sessionStore;
    if (store?.listSubkeys === undefined) return [];
    const failed: string[] = [];
    const candidates: ResumeSubagentTranscript[] = [];
    try {
      const subpaths = (await store.listSubkeys({ projectKey, sessionId })).filter(
        isSubagentSubpath,
      );
      for (const subpath of subpaths) {
        try {
          const entries = await store.load({ projectKey, sessionId, subpath });
          if (entries !== null && entries.length > 0) candidates.push({ subpath, entries });
        } catch (error) {
          failed.push(subpath);
          noteUnreadableRecord(
            '預かってある作業者の生ログ',
            `projectKey=${projectKey} sessionId=${sessionId} subpath=${subpath}`,
            error,
          );
        }
      }
    } catch (error) {
      noteUnreadableRecord(
        '預かってある作業者の生ログの一覧',
        `projectKey=${projectKey} sessionId=${sessionId}`,
        error,
      );
      await this.#journal({
        type: 'decision',
        decision: `[${managerId}] resume で、作業者の生ログの一覧を読めなかったので、作業者の記録は戻さずに起こす`,
        grounds: `listSubkeys の失敗: ${reasonOf(error)}`,
      });
      return [];
    }
    const { included, omitted } = selectSubagentsWithinBudget(candidates);
    if (omitted.length > 0 || failed.length > 0) {
      const parts = [
        omitted.length === 0
          ? undefined
          : `合計の上限（${String(RESUME_SUBAGENT_BUDGET_CHARS)} 文字）に入らず戻さなかった作業者 ${String(omitted.length)} 件: ${omitted.join(', ')}`,
        failed.length === 0
          ? undefined
          : `読めずに戻さなかった作業者 ${String(failed.length)} 件: ${failed.join(', ')}`,
      ].filter((part) => part !== undefined);
      await this.#journal({
        type: 'decision',
        decision: `[${managerId}] resume で、作業者の記録の一部を戻さなかった（その作業者への SendMessage は記録が無く失敗する）`,
        grounds: parts.join('。'),
      });
    }
    return included;
  }

  /**
   * peer（`peers/<peerId>`）の記録を預かり先から引く。引けなくても resume は止めない（担当は peer を新しく頼み直せる）が、
   * 戻せなかった・上限で入らなかった・置き場の印が無い peer は日誌へ残す: 黙って落とすと、`peer_reply` が「無い」で断られる理由が追えない。
   * `listSubkeys` を持たない預かり先は、peer の分が無いものとして空を返す。
   */
  async loadPeers(
    managerId: string,
    projectKey: string,
    sessionId: string,
  ): Promise<ResumePeerTranscript[]> {
    const store = this.#stores.sessionStore;
    if (store?.listSubkeys === undefined) return [];
    const failed: string[] = [];
    const unplaceable: string[] = [];
    const candidates: ResumePeerTranscript[] = [];
    try {
      const subpaths = (await store.listSubkeys({ projectKey, sessionId })).filter(isPeerSubpath);
      for (const subpath of subpaths) {
        const peerId = peerIdOfSubpath(subpath);
        try {
          const stored = await store.load({ projectKey, sessionId, subpath });
          if (stored === null || stored.length === 0) continue;
          const peer = buildPeerTranscript(peerId, stored);
          if (peer === undefined) unplaceable.push(peerId);
          else candidates.push(peer);
        } catch (error) {
          failed.push(peerId);
          noteUnreadableRecord(
            '預かってある peer の生ログ',
            `projectKey=${projectKey} sessionId=${sessionId} subpath=${subpath}`,
            error,
          );
        }
      }
    } catch (error) {
      noteUnreadableRecord(
        '預かってある peer の生ログの一覧',
        `projectKey=${projectKey} sessionId=${sessionId}`,
        error,
      );
      await this.#journal({
        type: 'decision',
        decision: `[${managerId}] resume で、peer の生ログの一覧を読めなかったので、peer の記録は戻さずに起こす`,
        grounds: `listSubkeys の失敗: ${reasonOf(error)}`,
      });
      return [];
    }
    const { included, omitted } = selectPeersWithinBudget(candidates);
    if (omitted.length > 0 || failed.length > 0 || unplaceable.length > 0) {
      const parts = [
        omitted.length === 0
          ? undefined
          : `合計の上限（${String(RESUME_PEER_BUDGET_CHARS)} 文字）に入らず戻さなかった peer ${String(omitted.length)} 件: ${omitted.join(', ')}`,
        failed.length === 0
          ? undefined
          : `読めずに戻さなかった peer ${String(failed.length)} 件: ${failed.join(', ')}`,
        unplaceable.length === 0
          ? undefined
          : `置き場の印（${'alteroid_peer_meta'}）が無く戻せなかった peer ${String(unplaceable.length)} 件: ${unplaceable.join(', ')}`,
      ].filter((part) => part !== undefined);
      await this.#journal({
        type: 'decision',
        decision: `[${managerId}] resume で、peer の記録の一部を戻さなかった（その peer への peer_reply は続きから起こせず、新しく頼み直すことになる）`,
        grounds: parts.join('。'),
      });
    }
    return included;
  }

  async fromSessionStore(job: Job): Promise<string | null> {
    const material = await this.loadSession(job.projectKey, job.sessionId ?? '');
    if (material.kind !== 'loaded') return null;
    // 1回の `map` と `join` で作らない: 預かりは数百 MB になり、全件の直列化の間ループを塞ぐため（#4659）
    return jsonLinesYielding(material.entries);
  }

  /**
   * runner に預けた退避の本文を取りに行く。器が名簿に居ない・取りに行く呼び出しが落ちた回は、`ARCHIVE_FETCH_RETRY_DELAYS_MS` の間を置いてやり直す。
   * やり直すのは、そのうち取れる見込みのある失敗だけ: 本文が無い（期限切れ・既に消された）・口を持たない器は、何度聞いても同じ答えなので、すぐ投げる。
   */
  async fetchArchiveRetrying(
    managerId: string,
    archiveId: string,
    fromRunnerId: string,
  ): Promise<{ body: string; runner: RunnerClient }> {
    const delays = ARCHIVE_FETCH_RETRY_DELAYS_MS;
    const instanceBefore = this.#sighting(fromRunnerId).instanceId;
    for (let attempt = 0; ; attempt += 1) {
      let failure: unknown;
      const runner = await this.#runners.get(fromRunnerId);
      if (runner === null) {
        failure = new Error(`退避を預けた器（${fromRunnerId}）が名簿に居ない`);
      } else {
        if (runner.fetchArchive === undefined) {
          throw new Error('この器のクライアントは、預けた退避を取りに行く口を持たない');
        }
        let fetched: string | undefined;
        try {
          fetched = await runner.fetchArchive(managerId, archiveId);
        } catch (error) {
          failure = error;
        }
        if (failure === undefined) {
          if (fetched === undefined) {
            // 入れ替わりの前後かを日誌から読めるようにする（#4896）: 参照を受けた時と取りに行った時の instanceId が違えば、預けたプロセスはもう居ない
            const swapNote = this.#swapNote(fromRunnerId, instanceBefore);
            throw new Error(
              `runner に預けた退避（${archiveId}）が無かった（期限切れで捨てられたか、既に消された）。${swapNote}`,
            );
          }
          return { body: fetched, runner };
        }
      }
      const delayMs = delays[attempt];
      if (delayMs === undefined || this.#stopped()) throw failure;
      noteDroppedRecord(
        'トランスクリプトの退避の取り寄せ（やり直す）',
        `managerId=${managerId} ref=${archiveId} attempt=${String(attempt + 1)}`,
        failure,
      );
      // `unref` する: 待ちが止めたはずのデーモンの終了を引き延ばさないため
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs).unref?.();
      });
    }
  }

  /**
   * 生ログの写しを PG へ預ける。落ちたら `MIRROR_APPEND_RETRY_DELAYS_MS` の間を置いてやり直す（#4657）。
   * 順番は崩れない: 同じ会話の後ろの塊は、この預けが終わるのを `Pool#mirrorTurns` で待っている。
   * やり直しで二重に積まれうるのは uuid の無い行だけ（`append` は1つのトランザクションで、uuid の有る行は衝突を無視する）。抜けるより害が小さい。
   * やり直し切れなかったら日誌にも残す: 標準エラーだけだと、resume した会話のどこが抜けたかを後から辿れないため。
   */
  async appendMirrorRetrying(
    store: NonNullable<Stores['sessionStore']>,
    event: Extract<RunnerEvent, { type: 'mirror' }>,
  ): Promise<void> {
    const delays = MIRROR_APPEND_RETRY_DELAYS_MS;
    const detail =
      `managerId=${event.managerId} projectKey=${event.key.projectKey} ` +
      `sessionId=${event.key.sessionId} entries=${event.entries.length}`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await store.append(event.key, event.entries as never);
        return;
      } catch (error) {
        const delayMs = delays[attempt];
        if (delayMs === undefined || this.#stopped()) {
          // 止めないが黙って消さない: 預かり損ねたことすら残らないと、後から「無い」のか「預かれなかった」のかが分からない。
          noteDroppedRecord('生ログのミラー', `${detail} attempts=${String(attempt + 1)}`, error);
          await this.#journalExchange(
            'outbound',
            `${EXCHANGE_KIND_FAILURE_PREFIX}[${event.managerId}] 生ログの写し ${String(event.entries.length)} 件を PG へ預けられなかった` +
              `（${String(attempt + 1)} 回試した。sessionId=${event.key.sessionId}）。` +
              `この会話を resume すると、この区間が欠けたまま戻る: ${reasonOf(error)}`,
          );
          return;
        }
        noteDroppedRecord(
          '生ログのミラー（やり直す）',
          `${detail} attempt=${String(attempt + 1)}`,
          error,
        );
        // `unref` する: 待ちが止めたはずのデーモンの終了を引き延ばさないため
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs).unref?.();
        });
      }
    }
  }
}

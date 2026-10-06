/**
 * ヘッダの件数（承認待ち・実行中の委譲）と、ライブ接続の状態。
 *
 * `GET /journal/stream`（SSE）を 1 本だけ張り、届いた出来事を合図に件数を取り直す
 * （Web UI の `useJournalLive`〔`packages/swr/src/hooks/use-journal-live.ts`〕と同じ形）。
 * 切れたら指数バックオフで張り直す — 間にプロキシが挟まると無通信で黙って切られることが
 * あり、放っておくと画面は「静かなだけ」に見える（実際には死んでいる）。
 */
import type { JournalEntry } from '@alteroid/core';

import type { HeaderCounts, TuiApi } from './api.js';
import { Store } from './store.js';

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface HeaderState {
  /** 取れていなければ `null`（0 と区別する）。 */
  readonly counts: HeaderCounts | null;
  readonly live: LiveStatus;
}

export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

/** 再接続までの待ち（0 回目 = 1 秒、倍々で上限 30 秒）。 */
export function retryDelay(attempt: number, base = RETRY_BASE_MS, max = RETRY_MAX_MS): number {
  return Math.min(base * 2 ** attempt, max);
}

/** 件数に響かない（量が多く、承認待ち・委譲を動かさない）種別。 */
const QUIET_TYPES = new Set([
  'turn_usage',
  'context_usage',
  'inbox_flow',
  // GitHub の観測の記帳（#2245）。承認待ちも委譲も動かさない（Web の `use-journal-live` も落とす先を持たない）。
  'github_observation',
]);

export function affectsHeader(type: string): boolean {
  return !QUIET_TYPES.has(type);
}

export interface HeaderFeedOptions {
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** 出来事が続けて届いても、取り直しはこの間隔にまとめる。 */
  refetchDebounceMs?: number;
}

export class HeaderFeed {
  readonly store = new Store<HeaderState>({ counts: null, live: 'connecting' });
  private abort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private refetchTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = true;
  private readonly listeners = new Set<(type: string) => void>();
  private readonly entryListeners = new Set<(entry: JournalEntry) => void>();

  constructor(
    private readonly api: TuiApi,
    private readonly options: HeaderFeedOptions = {},
  ) {}

  /**
   * 画面が日誌の出来事を合図に自分のデータを取り直すための口（委譲の一覧など）。
   * 届くのは `open`（繋がった・張り直した）と、件数に響く種別（`affectsHeader`）。
   * 戻り値で解除する。
   */
  onEvent(listener: (type: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 日誌のタブが、**届いたエントリそのもの**を受けるための口（2 本目の SSE は張らない）。
   * `onEvent` と違い、件数に響かない種別（`turn_usage` など）も全部届く — 日誌は Web と同じく
   * 全種別を流す画面なので、間引くのは受け取る側（絞り込み）の仕事である。戻り値で解除する。
   */
  onEntry(listener: (entry: JournalEntry) => void): () => void {
    this.entryListeners.add(listener);
    return () => {
      this.entryListeners.delete(listener);
    };
  }

  private emit(type: string): void {
    for (const listener of this.listeners) listener(type);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refetch();
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    clearTimeout(this.retryTimer);
    clearTimeout(this.refetchTimer);
    this.refetchTimer = undefined;
  }

  /** 件数を取り直す。失敗しても前の件数を残す（古い値のほうが「0」より情報がある）。 */
  async refetch(): Promise<void> {
    try {
      const counts = await this.api.headerCounts();
      if (this.stopped) return;
      this.store.update((s) =>
        s.counts?.pendingApprovals === counts.pendingApprovals &&
        s.counts.unreadableApprovals === counts.unreadableApprovals &&
        s.counts.runningManagers === counts.runningManagers
          ? s
          : { ...s, counts },
      );
    } catch {
      // 次の出来事 / 再接続でまた取る。
    }
  }

  private scheduleRefetch(): void {
    if (this.refetchTimer !== undefined) return;
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = undefined;
      void this.refetch();
    }, this.options.refetchDebounceMs ?? 500);
  }

  private setLive(live: LiveStatus): void {
    this.store.update((s) => (s.live === live ? s : { ...s, live }));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const abort = new AbortController();
    this.abort = abort;
    this.setLive('connecting');
    try {
      for await (const { type, entry } of this.api.journalStream(abort.signal)) {
        if (entry !== null) for (const listener of this.entryListeners) listener(entry);
        if (type === 'open') {
          // 繋がった（張り直した）。切れていた間の出来事は届かないので取り直す。
          this.attempt = 0;
          this.setLive('live');
          void this.refetch();
          this.emit(type);
        } else if (affectsHeader(type)) {
          this.scheduleRefetch();
          this.emit(type);
        }
      }
    } catch {
      // 接続失敗も切断も同じ扱い（下の再接続へ）。
    }
    if (this.stopped || abort.signal.aborted) return;
    this.setLive('offline');
    const wait = retryDelay(this.attempt, this.options.retryBaseMs, this.options.retryMaxMs);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => void this.connect(), wait);
  }
}

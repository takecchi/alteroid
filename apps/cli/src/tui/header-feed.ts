// 切れたら張り直す: 間にプロキシが挟まると無通信で黙って切られ、画面が「静かなだけ」に見える（実際には死んでいる）ため
import type { JournalEntry } from '@alteroid/core';

import type { HeaderCounts, TuiApi } from './api.js';
import { affectsCounts } from './journal-targets.js';
import { Store } from './store.js';

export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface HeaderState {
  readonly counts: HeaderCounts | null;
  readonly live: LiveStatus;
}

export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;

export function retryDelay(attempt: number, base = RETRY_BASE_MS, max = RETRY_MAX_MS): number {
  return Math.min(base * 2 ** attempt, max);
}

const QUIET_TYPES = new Set([
  'turn_usage',
  'context_usage',
  'inbox_flow',
  // 件数に響かない: GitHub の観測の記帳は承認待ちも委譲も動かさない
  'github_observation',
]);

// 件数を取り直す種別: 各画面へ知らせる `QUIET_TYPES` とは別にする。記憶の画面は `memory_update` を受けるが、件数は動かさないため
export function affectsHeader(type: string, entry?: JournalEntry | null): boolean {
  return !QUIET_TYPES.has(type) && affectsCounts(type, entry);
}

export interface HeaderFeedOptions {
  retryBaseMs?: number;
  retryMaxMs?: number;
  refetchDebounceMs?: number;
}

export class HeaderFeed {
  readonly store = new Store<HeaderState>({ counts: null, live: 'connecting' });
  private abort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private refetchTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = true;
  private readonly listeners = new Set<(type: string, entry: JournalEntry | null) => void>();
  private readonly entryListeners = new Set<(entry: JournalEntry) => void>();

  constructor(
    private readonly api: TuiApi,
    private readonly options: HeaderFeedOptions = {},
  ) {}

  onEvent(listener: (type: string, entry: JournalEntry | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // 2 本目の SSE を張らない: 日誌のタブはここで届いたエントリを受ける
  onEntry(listener: (entry: JournalEntry) => void): () => void {
    this.entryListeners.add(listener);
    return () => {
      this.entryListeners.delete(listener);
    };
  }

  private emit(type: string, entry: JournalEntry | null): void {
    for (const listener of this.listeners) listener(type, entry);
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

  // 失敗しても前の件数を残す: 古い値のほうが「0」より情報があるため
  async refetch(): Promise<void> {
    try {
      const got = await this.api.headerCounts();
      if (this.stopped) return;
      this.store.update((s) => {
        // 0 と偽らず `null`（未取得）のままにする: 起動直後に片方だけ取れたときの、まだ取れていない欄のため
        const pendingApprovals = got.pendingApprovals ?? s.counts?.pendingApprovals;
        const unreadableApprovals = got.unreadableApprovals ?? s.counts?.unreadableApprovals;
        const runningManagers = got.runningManagers ?? s.counts?.runningManagers;
        if (
          pendingApprovals === undefined ||
          unreadableApprovals === undefined ||
          runningManagers === undefined
        ) {
          return s;
        }
        return s.counts?.pendingApprovals === pendingApprovals &&
          s.counts.unreadableApprovals === unreadableApprovals &&
          s.counts.runningManagers === runningManagers
          ? s
          : { ...s, counts: { pendingApprovals, unreadableApprovals, runningManagers } };
      });
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
          this.attempt = 0;
          this.setLive('live');
          void this.refetch();
          this.emit(type, null);
        } else if (!QUIET_TYPES.has(type)) {
          if (affectsHeader(type, entry)) this.scheduleRefetch();
          this.emit(type, entry);
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

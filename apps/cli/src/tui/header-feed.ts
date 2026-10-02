/**
 * ヘッダの件数（承認待ち・実行中の委譲）と、ライブ接続の状態。
 *
 * `GET /journal/stream`（SSE）を 1 本だけ張り、届いた出来事を合図に件数を取り直す
 * （Web UI の `useJournalLive`〔`packages/swr/src/hooks/use-journal-live.ts`〕と同じ形）。
 * 切れたら指数バックオフで張り直す — 間にプロキシが挟まると無通信で黙って切られることが
 * あり、放っておくと画面は「静かなだけ」に見える（実際には死んでいる）。
 */
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
const QUIET_TYPES = new Set(['turn_usage', 'context_usage', 'inbox_flow']);

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

  constructor(
    private readonly api: TuiApi,
    private readonly options: HeaderFeedOptions = {},
  ) {}

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
      for await (const type of this.api.journalStream(abort.signal)) {
        if (type === 'open') {
          // 繋がった（張り直した）。切れていた間の出来事は届かないので取り直す。
          this.attempt = 0;
          this.setLive('live');
          void this.refetch();
        } else if (affectsHeader(type)) {
          this.scheduleRefetch();
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

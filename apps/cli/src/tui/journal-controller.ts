/**
 * 「日誌」タブの状態と操作（React を持たない）。
 *
 * **Web（`apps/web/app/routes/journal.tsx` と `use-journal-window.ts`）と同じ API・同じ意味**:
 * - 直近は `GET /journal`（`limit` ・ `type` ・ 語 `q`）。新着は `HeaderFeed` が張っている
 *   `GET /journal/stream` の 1 本を共有して受ける（**2 本目は張らない**）。
 * - 絞りは**サーバへ投げる**。SSE で届く新着にも同じ絞りを掛け直す（掛けないと、絞っている画面へ
 *   当たらない行が割り込む）。照合は core の `matchesJournalSearch`（サーバと同じ 1 つの実装）。
 * - 古い側は `until`、取りこぼしは `since`（どちらも inclusive）。`pageOutcome` の `retryLarger` は
 *   黙って終端に見せず `limit` を上げて撃ち直し、上限まで上げて進まないなら `blocked` と言う。
 * - 量の多い種別（`turn_usage` など）は **Web と同じく隠さない**。見たくなければ種別で絞る。
 *
 * TUI 側の都合:
 * - 表示は古い→新しい（末尾が最新のログの形）。**選択は `id` で持つ**ので、新着が末尾に足されても
 *   遡って読んでいる位置は動かない。選択が最新にいる間は追従（`follow`）し、↑で外れ、最新へ戻ると
 *   追従に戻る。
 * - 持つ量は**文字数の予算**で締める（`JOURNAL_RETAIN_CHARS`）。超えたら古い側を捨てて、そう言う。
 */
import { matchesJournalSearch, type JournalEntry } from '@alteroid/core';
import {
  JOURNAL_MAX_LIMIT,
  JOURNAL_PAGE,
  JOURNAL_TYPES,
  applyInitialPage,
  applyNewerPage,
  applyOlderPage,
  journalHorizonNote,
  mergeFront,
  newerPageQuery,
  olderPageQuery,
  type PageOutcome,
} from '@alteroid/logic';

import type { TuiApi } from './api.js';
import type { HeaderFeed } from './header-feed.js';
import type { JournalType } from './journal-format.js';
import { JOURNAL_RETAIN_CHARS, trimToBudget } from './journal-window.js';
import { Store } from './store.js';

export type OlderStatus = PageOutcome | 'budget';

export interface JournalState {
  /** `list` = 一覧 / `filter` = 種別の選択 / `detail` = 1 件の全文。 */
  readonly view: 'list' | 'filter' | 'detail';
  /** `idle` = まだ一度も開いていない。 */
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  /** 新しい順（先頭 = 最新）。表示は逆順（末尾が最新）。 */
  readonly entries: readonly JournalEntry[];
  readonly chars: number;
  readonly types: readonly JournalType[];
  readonly q: string;
  readonly pageSize: number;
  readonly older: OlderStatus;
  readonly olderLoading: boolean;
  readonly horizonNote: string | undefined;
  /** 取りこぼし確認が同じ時刻の詰まりで止まった。 */
  readonly newerBlocked: boolean;
  readonly selectedId: string | null;
  /** 最新に張り付いて追従中。 */
  readonly follow: boolean;
  /** 文字数の予算で捨てた古い側の件数（累計）。 */
  readonly trimmed: number;
  readonly error: string | null;
  readonly loadedAt: number;
  /** 種別の選択画面の下書きとカーソル。 */
  readonly filterDraft: readonly JournalType[];
  readonly filterCursor: number;
  /** 詳細に開いている 1 件（捨てられても読めるよう、実体を持つ）。 */
  readonly detail: JournalEntry | null;
}

export const initialJournalState: JournalState = {
  view: 'list',
  status: 'idle',
  entries: [],
  chars: 0,
  types: [],
  q: '',
  pageSize: JOURNAL_PAGE,
  older: 'progress',
  olderLoading: false,
  horizonNote: undefined,
  newerBlocked: false,
  selectedId: null,
  follow: true,
  trimmed: 0,
  error: null,
  loadedAt: 0,
  filterDraft: [],
  filterCursor: 0,
  detail: null,
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 選択の位置（新しい順での index）。見つからなければ -1。 */
export function selectedIndex(state: JournalState): number {
  return state.selectedId === null ? -1 : state.entries.findIndex((e) => e.id === state.selectedId);
}

export class JournalController {
  readonly store = new Store<JournalState>(initialJournalState);
  /** 読みの世代（絞りを変えたあとに戻ってきた古い応答を捨てる）。 */
  private gen = 0;
  /** 初期読み込みの最中に届いた新着（新しい順）。読み終えたら前へ重ねる。 */
  private pending: JournalEntry[] = [];
  private detachers: (() => void)[] = [];

  constructor(
    private readonly api: TuiApi,
    private readonly options: { now?: () => number; retainChars?: number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private budget(): number {
    return this.options.retainChars ?? JOURNAL_RETAIN_CHARS;
  }

  /** `HeaderFeed` の 1 本の SSE から、新着と「繋ぎ直し」を受ける。 */
  attach(feed: HeaderFeed): void {
    this.dispose();
    this.detachers = [
      feed.onEntry((entry) => this.ingest(entry)),
      // 繋ぎ直した（`open`）。切れていた間の出来事は届かないので、`since` で取りこぼしを埋める。
      feed.onEvent((type) => {
        if (type === 'open') void this.refreshNewer();
      }),
    ];
  }

  dispose(): void {
    for (const detach of this.detachers) detach();
    this.detachers = [];
  }

  private patch(patch: Partial<JournalState>): void {
    this.store.update((s) => ({ ...s, ...patch }));
  }

  // --- 読み込み -----------------------------------------------------------

  /** タブを開いたとき。まだ読んでいない（idle）か、前の読みが失敗した（error）ときに読む（以後は SSE で流れる）。 */
  enter(): void {
    const { status } = this.store.getSnapshot();
    if (status === 'idle' || status === 'error') void this.load();
  }

  /** 先頭の頁から読み直す（初回・絞りの変更・`r`）。 */
  async load(): Promise<void> {
    const gen = ++this.gen;
    const { types, q, pageSize } = this.store.getSnapshot();
    this.pending = [];
    this.patch({
      status: 'loading',
      error: null,
      olderLoading: false,
      newerBlocked: false,
      view: 'list',
      detail: null,
    });
    try {
      const page = await this.api.listJournal({
        limit: pageSize,
        types,
        q,
        horizon: true,
      });
      if (gen !== this.gen) return;
      const applied = applyInitialPage([...page.entries], pageSize);
      const merged = mergeFront(applied.entries, this.pending).entries;
      this.pending = [];
      const budgeted = trimToBudget(merged, this.budget());
      this.patch({
        status: 'ready',
        entries: budgeted.entries,
        chars: budgeted.chars,
        older: budgeted.dropped > 0 ? 'budget' : applied.outcome,
        trimmed: budgeted.dropped,
        horizonNote:
          budgeted.dropped > 0
            ? undefined
            : journalHorizonNote(applied.outcome, page.oldestAt, page.crossesHorizon),
        selectedId: budgeted.entries[0]?.id ?? null,
        follow: true,
        loadedAt: this.now(),
      });
    } catch (error) {
      if (gen !== this.gen) return;
      this.patch({ status: 'error', error: messageOf(error) });
    }
  }

  /** 古い側の次の頁を読み足す（先頭まで上がったときも自動で呼ぶ）。 */
  async loadOlder(): Promise<void> {
    const s = this.store.getSnapshot();
    if (s.status !== 'ready' || s.olderLoading) return;
    if (s.older !== 'progress' && s.older !== 'retryLarger') return;
    if (s.chars >= this.budget()) {
      this.patch({ older: 'budget' });
      return;
    }
    const gen = this.gen;
    this.patch({ olderLoading: true, error: null });
    let limit = s.pageSize;
    try {
      for (;;) {
        const current = this.store.getSnapshot();
        const query = olderPageQuery([...current.entries]);
        if (query === undefined) {
          this.patch({ olderLoading: false });
          return;
        }
        const page = await this.api.listJournal({
          limit,
          types: current.types,
          q: current.q,
          ...query,
        });
        if (gen !== this.gen) return;
        const latest = this.store.getSnapshot();
        const applied = applyOlderPage([...latest.entries], [...page.entries], limit);
        if (applied.outcome === 'retryLarger') {
          // 黙って終端に見せない。limit を上げて同じ境界を撃ち直す。
          limit = JOURNAL_MAX_LIMIT;
          continue;
        }
        const budgeted = trimToBudget(applied.entries, this.budget());
        this.patch({
          entries: budgeted.entries,
          chars: budgeted.chars,
          older: budgeted.dropped > 0 ? 'budget' : applied.outcome,
          trimmed: latest.trimmed + budgeted.dropped,
          horizonNote:
            budgeted.dropped > 0
              ? undefined
              : journalHorizonNote(applied.outcome, page.oldestAt, page.crossesHorizon),
          olderLoading: false,
          selectedId: latest.selectedId,
        });
        return;
      }
    } catch (error) {
      if (gen !== this.gen) return;
      this.patch({ olderLoading: false, error: messageOf(error) });
    }
  }

  /** 新着側の取りこぼし確認（繋ぎ直したとき）。 */
  async refreshNewer(): Promise<void> {
    const s = this.store.getSnapshot();
    if (s.status !== 'ready') return;
    const gen = this.gen;
    let limit = s.pageSize;
    try {
      for (;;) {
        const current = this.store.getSnapshot();
        const query = newerPageQuery([...current.entries]);
        if (query === undefined) return;
        const page = await this.api.listJournal({
          limit,
          types: current.types,
          q: current.q,
          ...query,
        });
        if (gen !== this.gen) return;
        const latest = this.store.getSnapshot();
        const applied = applyNewerPage([...latest.entries], [...page.entries], limit);
        if (applied.outcome === 'retryLarger') {
          limit = JOURNAL_MAX_LIMIT;
          continue;
        }
        this.setEntries(applied.entries, { newerBlocked: applied.outcome === 'blocked' });
        return;
      }
    } catch (error) {
      if (gen !== this.gen) return;
      this.patch({ error: messageOf(error) });
    }
  }

  /** 新着側へ足した結果を状態に載せる（追従中なら選択も最新へ）。予算を超えたら古い側を捨てる。 */
  private setEntries(entries: JournalEntry[], extra: Partial<JournalState> = {}): void {
    const budgeted = trimToBudget(entries, this.budget());
    this.store.update((s) => {
      const keep =
        s.selectedId !== null && budgeted.entries.some((e) => e.id === s.selectedId)
          ? s.selectedId
          : (budgeted.entries.at(-1)?.id ?? null);
      return {
        ...s,
        ...extra,
        entries: budgeted.entries,
        chars: budgeted.chars,
        trimmed: s.trimmed + budgeted.dropped,
        // 捨てたなら、古い側は「もう無い」でも「続きを読める」でもなく、持てる量の上限。
        older: budgeted.dropped > 0 ? 'budget' : s.older,
        horizonNote: budgeted.dropped > 0 ? undefined : s.horizonNote,
        selectedId: s.follow ? (budgeted.entries[0]?.id ?? null) : keep,
      };
    });
  }

  /** SSE で届いた 1 件。まだ開いていなければ読まない（開いたときに履歴ごと読む）。 */
  private ingest(entry: JournalEntry): void {
    const s = this.store.getSnapshot();
    if (s.status === 'idle' || s.status === 'error') return;
    // サーバへ投げた絞りを、届いた新着にも同じだけ掛ける。
    if (s.types.length > 0 && !(s.types as readonly string[]).includes(entry.type)) return;
    if (s.q !== '' && !matchesJournalSearch(entry, s.q)) return;
    if (s.status === 'loading') {
      this.pending = mergeFront(this.pending, [entry]).entries;
      return;
    }
    const merged = mergeFront([...s.entries], [entry]);
    if (merged.freshCount === 0) return;
    this.setEntries(merged.entries);
  }

  // --- 絞り込み -----------------------------------------------------------

  /** 絞りを決めて先頭から読み直す（`/journal type=… q=…` と選択画面の Enter）。 */
  setFilter(types: readonly JournalType[], q: string, pageSize?: number): void {
    this.gen += 1;
    this.pending = [];
    this.patch({
      types,
      q,
      ...(pageSize === undefined ? {} : { pageSize }),
      entries: [],
      chars: 0,
      selectedId: null,
      follow: true,
      older: 'progress',
      horizonNote: undefined,
      trimmed: 0,
    });
    void this.load();
  }

  openFilter(): void {
    this.store.update((s) => ({ ...s, view: 'filter', filterDraft: s.types, filterCursor: 0 }));
  }

  moveFilterCursor(delta: number): void {
    this.store.update((s) => {
      const filterCursor = Math.min(JOURNAL_TYPES.length - 1, Math.max(0, s.filterCursor + delta));
      return filterCursor === s.filterCursor ? s : { ...s, filterCursor };
    });
  }

  toggleFilterDraft(): void {
    this.store.update((s) => {
      const type = JOURNAL_TYPES[s.filterCursor];
      if (type === undefined) return s;
      const filterDraft = s.filterDraft.includes(type)
        ? s.filterDraft.filter((t) => t !== type)
        : // 並びは Web のチップ順に保つ。
          JOURNAL_TYPES.filter((t) => t === type || s.filterDraft.includes(t));
      return { ...s, filterDraft };
    });
  }

  clearFilterDraft(): void {
    this.patch({ filterDraft: [] });
  }

  applyFilter(): void {
    const s = this.store.getSnapshot();
    // 語（q）は選択画面では触らない（`/journal q=…` で決める）。
    this.setFilter(s.filterDraft, s.q);
  }

  cancelFilter(): void {
    this.patch({ view: 'list' });
  }

  // --- 選択・詳細 ---------------------------------------------------------

  /** 古い側へ `towardOlder` 件動く（負なら新しい側へ。最新に届いたら追従に戻る）。 */
  moveSelection(towardOlder: number): void {
    const s = this.store.getSnapshot();
    if (s.entries.length === 0) return;
    const at = Math.max(0, selectedIndex(s));
    const next = Math.min(s.entries.length - 1, Math.max(0, at + towardOlder));
    const entry = s.entries[next];
    if (entry === undefined) return;
    this.patch({ selectedId: entry.id, follow: next === 0 });
    // 一番古いところへ届いたら、続きを読む（Web が端に近づいたら遡るのと同じ）。
    if (next === s.entries.length - 1 && towardOlder > 0) void this.loadOlder();
  }

  /** 最新へ戻って追従する。 */
  jumpNewest(): void {
    this.store.update((s) => ({ ...s, selectedId: s.entries[0]?.id ?? null, follow: true }));
  }

  openDetail(): void {
    const s = this.store.getSnapshot();
    const entry = s.entries[Math.max(0, selectedIndex(s))];
    if (entry !== undefined) this.patch({ view: 'detail', detail: entry });
  }

  back(): void {
    this.patch({ view: 'list', detail: null });
  }

  /** 一覧の最上行に一言出す（コマンドの引数の誤りなど）。次の読み込みで消える。 */
  note(message: string): void {
    this.patch({ error: message });
  }
}

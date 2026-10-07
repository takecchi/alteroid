// 選択を `id` で持つ: 新着が末尾に足されても、遡って読んでいる位置が動かないため
import { matchesJournalSearch } from '@alteroid/core/cli-light';
import type { JournalEntry } from '@alteroid/core';
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
  readThroughUnreadable,
  type PageCursor,
  type PageOutcome,
} from '@alteroid/logic';

import type { TuiApi } from './api.js';
import type { HeaderFeed } from './header-feed.js';
import type { JournalType } from './journal-format.js';
import { JOURNAL_RETAIN_CHARS, trimToBudget } from './journal-window.js';
import { redactedErrorMessage } from '../redact.js';
import { Store } from './store.js';

export type OlderStatus = PageOutcome | 'budget';

export interface JournalState {
  readonly view: 'list' | 'filter' | 'detail';
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly entries: readonly JournalEntry[];
  readonly chars: number;
  readonly types: readonly JournalType[];
  readonly q: string;
  readonly pageSize: number;
  readonly older: OlderStatus;
  readonly olderLoading: boolean;
  readonly horizonNote: string | undefined;
  readonly newerBlocked: boolean;
  // 次の取りこぼし確認が成功しても下ろさない: `since` が穴を飛び越えるため（`load()` で読み直すと下りる）
  readonly newerFailed: boolean;
  readonly selectedId: string | null;
  readonly follow: boolean;
  readonly trimmed: number;
  readonly error: string | null;
  readonly loadedAt: number;
  readonly filterDraft: readonly JournalType[];
  readonly qDraft: string;
  readonly filterCursor: number;
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
  newerFailed: false,
  selectedId: null,
  follow: true,
  trimmed: 0,
  error: null,
  loadedAt: 0,
  filterDraft: [],
  qDraft: '',
  filterCursor: 0,
  detail: null,
};

const messageOf = redactedErrorMessage;

export function selectedIndex(state: JournalState): number {
  return state.selectedId === null ? -1 : state.entries.findIndex((e) => e.id === state.selectedId);
}

export class JournalController {
  readonly store = new Store<JournalState>(initialJournalState);
  private gen = 0;
  private pending: JournalEntry[] = [];
  private olderCursor: PageCursor | null | undefined = undefined;
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

  // 2 本目の SSE を張らない: `HeaderFeed` の 1 本を共有するため
  attach(feed: HeaderFeed): void {
    this.dispose();
    this.detachers = [
      feed.onEntry((entry) => this.ingest(entry)),
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

  enter(): void {
    const { status } = this.store.getSnapshot();
    if (status === 'idle' || status === 'error') void this.load();
  }

  async load(): Promise<void> {
    const gen = ++this.gen;
    const { types, q, pageSize } = this.store.getSnapshot();
    this.pending = [];
    this.olderCursor = undefined;
    this.patch({
      status: 'loading',
      error: null,
      olderLoading: false,
      newerBlocked: false,
      newerFailed: false,
      view: 'list',
      detail: null,
    });
    try {
      const first = await this.api.listJournal({
        limit: pageSize,
        types,
        q,
        horizon: true,
      });
      const page = await readThroughUnreadable(first, (cursor) =>
        this.api.listJournal({
          limit: pageSize,
          types,
          q,
          afterId: cursor.id,
          afterAt: cursor.at,
          horizon: true,
        }),
      );
      if (gen !== this.gen) return;
      this.olderCursor = page.next;
      const applied = applyInitialPage([...page.entries], pageSize, page.next);
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
        const query = olderPageQuery([...current.entries], this.olderCursor);
        if (query === undefined) {
          this.patch({ olderLoading: false });
          return;
        }
        // `horizon` で求める: 継続点で読むと `until` が付かず地平の材料が付かないため
        const first = await this.api.listJournal({
          limit,
          types: current.types,
          q: current.q,
          ...query,
          ...('afterId' in query ? { horizon: true } : {}),
        });
        const page = await readThroughUnreadable(first, (cursor) =>
          this.api.listJournal({
            limit,
            types: current.types,
            q: current.q,
            afterId: cursor.id,
            afterAt: cursor.at,
            horizon: true,
          }),
        );
        if (gen !== this.gen) return;
        this.olderCursor = page.next;
        const latest = this.store.getSnapshot();
        const applied = applyOlderPage(
          [...latest.entries],
          [...page.entries],
          limit,
          JOURNAL_MAX_LIMIT,
          page.next,
        );
        if (applied.outcome === 'retryLarger') {
          // 黙って終端に見せない: limit を上げて同じ境界を撃ち直す
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
      this.patch({ error: messageOf(error), newerFailed: true });
    }
  }

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
        older: budgeted.dropped > 0 ? 'budget' : s.older,
        horizonNote: budgeted.dropped > 0 ? undefined : s.horizonNote,
        selectedId: s.follow ? (budgeted.entries[0]?.id ?? null) : keep,
      };
    });
  }

  private ingest(entry: JournalEntry): void {
    const s = this.store.getSnapshot();
    if (s.status === 'idle' || s.status === 'error') return;
    // 届いた新着にも同じ絞りを掛ける: 掛けないと、絞っている画面へ当たらない行が割り込むため
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

  setFilter(types: readonly JournalType[], q: string, pageSize?: number): void {
    this.gen += 1;
    this.pending = [];
    this.olderCursor = undefined;
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
    this.store.update((s) => ({
      ...s,
      view: 'filter',
      filterDraft: s.types,
      qDraft: s.q,
      filterCursor: 0,
    }));
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
    this.patch({ filterDraft: [], qDraft: '' });
  }

  applyFilter(): void {
    const s = this.store.getSnapshot();
    this.setFilter(s.filterDraft, s.qDraft);
  }

  cancelFilter(): void {
    this.patch({ view: 'list' });
  }

  moveSelection(towardOlder: number): void {
    const s = this.store.getSnapshot();
    if (s.entries.length === 0) return;
    const at = Math.max(0, selectedIndex(s));
    const next = Math.min(s.entries.length - 1, Math.max(0, at + towardOlder));
    const entry = s.entries[next];
    if (entry === undefined) return;
    this.patch({ selectedId: entry.id, follow: next === 0 });
    if (next === s.entries.length - 1 && towardOlder > 0) void this.loadOlder();
  }

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

  // 開く前に載せない: 開く読み込み（`load()`）の開始で消えるため
  note(message: string): void {
    this.patch({ error: message });
  }
}

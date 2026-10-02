/**
 * 「記憶」タブの状態と操作（React を持たない）。**読むだけ**: 一覧（`GET /memory`。タイトルと要旨
 * だけ）と、選んだ 1 件の詳細（`GET /memory/{slug}`。本文）。編集（PUT）と削除（DELETE）は作らない。
 *
 * 取り直し: ヘッダの `HeaderFeed.onEvent`（journal の SSE）の `memory_update`（と繋ぎ直しの `open`）を
 * 合図に、まとめて取り直す。まだ一度も開いていなければ読まない。
 */
import { codePointBoundary } from '@alteroid/core';

import type { MemoryDoc, MemoryRow, TuiApi } from './api.js';
import type { HeaderFeed } from './header-feed.js';
import type { LogEntry } from './log.js';
import { Store } from './store.js';

/** journal の出来事が続けて届いても、取り直しはこの間隔にまとめる。 */
export const MEMORY_REFRESH_DEBOUNCE_MS = 700;
/** 詳細 1 件で描く本文の文字数の上限。超えたら省いた字数を言う。 */
export const MEMORY_DETAIL_CHARS = 60_000;

export interface MemoryDetailState {
  readonly slug: string;
  /** 一覧の行で仮置きし、読めたら本文を足す。 */
  readonly row: MemoryRow | null;
  readonly doc: MemoryDoc | null;
  /** 本文をログビューで読める形にしたもの（1 件。参照を保って折り返しのキャッシュを効かせる）。 */
  readonly body: readonly LogEntry[];
  /** 予算で切ったときの全体の字数。切っていなければ `null`。 */
  readonly cutFrom: number | null;
  /** `missing` = 404（無い）。 */
  readonly status: 'loading' | 'ready' | 'missing' | 'error';
  readonly error: string | null;
  readonly loadedAt: number;
}

export interface MemoryState {
  readonly view: 'list' | 'detail';
  /** `idle` = まだ一度も開いていない。 */
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly rows: readonly MemoryRow[];
  readonly selected: number;
  readonly error: string | null;
  readonly loadedAt: number;
  readonly detail: MemoryDetailState | null;
}

export const initialMemoryState: MemoryState = {
  view: 'list',
  status: 'idle',
  rows: [],
  selected: 0,
  error: null,
  loadedAt: 0,
  detail: null,
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class MemoryController {
  readonly store = new Store<MemoryState>(initialMemoryState);
  private listGen = 0;
  private detailGen = 0;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detach: (() => void) | undefined;

  constructor(
    private readonly api: TuiApi,
    private readonly options: { debounceMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  attach(feed: HeaderFeed): void {
    this.detach?.();
    this.detach = feed.onEvent((type) => {
      if (type === 'memory_update' || type === 'open') this.scheduleRefresh();
    });
  }

  dispose(): void {
    this.detach?.();
    this.detach = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleRefresh(): void {
    if (this.store.getSnapshot().status === 'idle') return;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const current = this.store.getSnapshot();
      if (current.status === 'idle') return;
      void this.refreshList();
      if (current.view === 'detail' && current.detail !== null) void this.refreshDetail();
    }, this.options.debounceMs ?? MEMORY_REFRESH_DEBOUNCE_MS);
  }

  /** タブを開いたとき。初回だけ読む。 */
  enter(): void {
    if (this.store.getSnapshot().status === 'idle') void this.loadList();
  }

  async loadList(): Promise<void> {
    const gen = ++this.listGen;
    this.store.update((s) => ({ ...s, status: 'loading', error: null }));
    try {
      const rows = await this.api.listMemory();
      if (gen !== this.listGen) return;
      this.store.update((s) => ({
        ...s,
        status: 'ready',
        rows,
        selected: Math.min(s.selected, Math.max(0, rows.length - 1)),
        error: null,
        loadedAt: this.now(),
      }));
    } catch (error) {
      if (gen !== this.listGen) return;
      this.store.update((s) => ({ ...s, status: 'error', error: messageOf(error) }));
    }
  }

  /** 取り直す（選択は slug で保つ）。失敗しても前の一覧を残す。 */
  async refreshList(): Promise<void> {
    const before = this.store.getSnapshot();
    if (before.status === 'idle' || before.status === 'loading') return;
    const gen = ++this.listGen;
    try {
      const rows = await this.api.listMemory();
      if (gen !== this.listGen) return;
      this.store.update((s) => {
        const kept = s.rows[s.selected]?.slug;
        const at = kept === undefined ? -1 : rows.findIndex((r) => r.slug === kept);
        const selected = at >= 0 ? at : Math.min(s.selected, Math.max(0, rows.length - 1));
        return { ...s, status: 'ready', rows, selected, error: null, loadedAt: this.now() };
      });
    } catch (error) {
      if (gen !== this.listGen) return;
      this.store.update((s) => ({ ...s, error: messageOf(error) }));
    }
  }

  moveSelection(delta: number): void {
    this.store.update((s) => {
      const selected = Math.min(Math.max(0, s.rows.length - 1), Math.max(0, s.selected + delta));
      return selected === s.selected ? s : { ...s, selected };
    });
  }

  openSelected(): void {
    const s = this.store.getSnapshot();
    const row = s.rows[s.selected];
    if (row !== undefined) void this.open(row.slug, row);
  }

  async open(slug: string, seed: MemoryRow | null = null): Promise<void> {
    this.detailGen += 1;
    this.store.update((s) => ({
      ...s,
      view: 'detail',
      detail: {
        slug,
        row: seed,
        doc: null,
        body: [],
        cutFrom: null,
        status: 'loading',
        error: null,
        loadedAt: 0,
      },
    }));
    await this.refreshDetail();
  }

  back(): void {
    this.detailGen += 1;
    this.store.update((s) => (s.view === 'list' ? s : { ...s, view: 'list', detail: null }));
  }

  async refreshDetail(): Promise<void> {
    const detail = this.store.getSnapshot().detail;
    if (detail === null) return;
    const { slug } = detail;
    const gen = this.detailGen;
    try {
      const doc = await this.api.readMemory(slug);
      if (gen !== this.detailGen) return;
      this.store.update((s) => {
        if (s.detail === null || s.detail.slug !== slug) return s;
        if (doc === null) {
          return {
            ...s,
            detail: { ...s.detail, status: 'missing', error: null, loadedAt: this.now() },
          };
        }
        const unchanged = s.detail.doc?.content === doc.content;
        const cut = doc.content.length > MEMORY_DETAIL_CHARS;
        const text = cut
          ? doc.content.slice(0, codePointBoundary(doc.content, MEMORY_DETAIL_CHARS))
          : doc.content;
        return {
          ...s,
          detail: {
            ...s.detail,
            doc,
            // 本文が変わらなければ同じ参照を保つ（折り返しのキャッシュが効く）。
            body: unchanged ? s.detail.body : [{ seq: (this.seq += 1), kind: 'assistant', text }],
            cutFrom: cut ? doc.content.length : null,
            status: 'ready',
            error: null,
            loadedAt: this.now(),
          },
        };
      });
    } catch (error) {
      if (gen !== this.detailGen) return;
      // 取れなかったのを空の記憶と描かない。前の本文は残す。
      this.store.update((s) =>
        s.detail === null || s.detail.slug !== slug
          ? s
          : { ...s, detail: { ...s.detail, status: 'error', error: messageOf(error) } },
      );
    }
  }
}

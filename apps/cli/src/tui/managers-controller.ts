// 取り直しで錨を持ち回らない: 読み込み済みの件数と同じ `limit` で先頭から読めば、古い頁を読み足していても 1 回で揃うため
import { type ManagerRow, type ManagerStatus, type TuiApi, type UnreadableManager } from './api.js';
import type { HeaderFeed } from './header-feed.js';
import type { LogEntry } from './log.js';
import { parseTranscript } from './managers-transcript.js';
import { redactedErrorMessage, sanitizeForTerminal } from '../redact.js';
import { Store } from './store.js';

export const MANAGERS_PAGE = 50;
export const MANAGERS_LIMIT_MAX = 1_000;
export const REFRESH_DEBOUNCE_MS = 700;

export const FILTER_CYCLE: readonly (ManagerStatus | null)[] = [
  null,
  'running',
  'waiting_human',
  'done',
  'failed',
  'lost',
  'stopped',
];

export type OlderStatus = 'progress' | 'end' | 'blocked';

export interface ListState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly ManagerRow[];
  readonly unreadable: readonly UnreadableManager[];
  readonly selected: number;
  readonly filter: ManagerStatus | null;
  readonly older: OlderStatus;
  readonly olderLoading: boolean;
  readonly error: string | null;
  readonly loadedAt: number;
}

export interface DetailState {
  readonly id: string;
  readonly manager: ManagerRow | null;
  readonly missing: boolean;
  readonly transcript: readonly LogEntry[];
  readonly transcriptStatus: 'loading' | 'ready' | 'none' | 'error';
  readonly error: string | null;
  readonly busy: boolean;
  readonly notice: string | null;
  readonly confirmStop: boolean;
  readonly loadedAt: number;
}

export interface ManagersState {
  readonly view: 'list' | 'detail';
  readonly list: ListState;
  readonly detail: DetailState | null;
}

export const initialManagersState: ManagersState = {
  view: 'list',
  list: {
    status: 'idle',
    items: [],
    unreadable: [],
    selected: 0,
    filter: null,
    older: 'end',
    olderLoading: false,
    error: null,
    loadedAt: 0,
  },
  detail: null,
};

const messageOf = redactedErrorMessage;

const DELIVERED_OUTCOMES: ReadonlySet<string> = new Set(['delivered', 'answered']);

// `not_stopped`・`unknown` を止まったとみなさない: 止まったと確かめられていないため
const STOPPED_OUTCOMES: ReadonlySet<string> = new Set(['stopped']);

export class ManagersController {
  readonly store = new Store<ManagersState>(initialManagersState);
  private listGen = 0;
  private detailGen = 0;
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
    this.detach = feed.onEvent(() => this.scheduleRefresh());
  }

  dispose(): void {
    this.detach?.();
    this.detach = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleRefresh(): void {
    const s = this.store.getSnapshot();
    if (s.list.status === 'idle') return;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const current = this.store.getSnapshot();
      if (current.list.status === 'idle') return;
      void this.refreshList();
      if (current.view === 'detail' && current.detail !== null) void this.refreshDetail();
    }, this.options.debounceMs ?? REFRESH_DEBOUNCE_MS);
  }

  private setList(patch: Partial<ListState>): void {
    this.store.update((s) => ({ ...s, list: { ...s.list, ...patch } }));
  }

  private setDetail(id: string, patch: Partial<DetailState>): void {
    this.store.update((s) =>
      s.detail === null || s.detail.id !== id ? s : { ...s, detail: { ...s.detail, ...patch } },
    );
  }

  enter(): void {
    const { status } = this.store.getSnapshot().list;
    if (status === 'idle' || status === 'error') void this.loadList();
  }

  async loadList(): Promise<void> {
    const gen = ++this.listGen;
    const filter = this.store.getSnapshot().list.filter;
    this.setList({ status: 'loading', error: null });
    try {
      const { managers, unreadable } = await this.api.listManagers({
        ...(filter === null ? {} : { status: [filter] }),
        limit: MANAGERS_PAGE,
      });
      if (gen !== this.listGen) return;
      this.setList({
        status: 'ready',
        items: managers,
        unreadable,
        selected: 0,
        older: managers.length >= MANAGERS_PAGE ? 'progress' : 'end',
        olderLoading: false,
        error: null,
        loadedAt: this.now(),
      });
    } catch (error) {
      if (gen !== this.listGen) return;
      // 立てた印を残さない: 読み足しの応答は世代違いで捨てられ、残すと「読んでいる…」が出続けて m も効かなくなるため
      this.setList({ status: 'error', error: messageOf(error), olderLoading: false });
    }
  }

  async refreshList(): Promise<void> {
    const before = this.store.getSnapshot().list;
    if (before.status === 'idle' || before.status === 'loading') return;
    const gen = ++this.listGen;
    const limit = Math.min(Math.max(before.items.length, MANAGERS_PAGE), MANAGERS_LIMIT_MAX);
    try {
      const { managers, unreadable } = await this.api.listManagers({
        ...(before.filter === null ? {} : { status: [before.filter] }),
        limit,
      });
      if (gen !== this.listGen) return;
      this.store.update((s) => {
        const keptId = s.list.items[s.list.selected]?.managerId;
        const at = keptId === undefined ? -1 : managers.findIndex((m) => m.managerId === keptId);
        const selected = at >= 0 ? at : Math.min(s.list.selected, Math.max(0, managers.length - 1));
        return {
          ...s,
          list: {
            ...s.list,
            status: 'ready',
            items: managers,
            unreadable,
            selected,
            older: managers.length >= limit ? 'progress' : 'end',
            olderLoading: false,
            error: null,
            loadedAt: this.now(),
          },
        };
      });
    } catch (error) {
      if (gen !== this.listGen) return;
      this.setList({ error: messageOf(error), olderLoading: false });
    }
  }

  cycleFilter(): void {
    const current = this.store.getSnapshot().list.filter;
    const next = FILTER_CYCLE[(FILTER_CYCLE.indexOf(current) + 1) % FILTER_CYCLE.length] ?? null;
    this.setList({ filter: next, items: [], unreadable: [], selected: 0, older: 'end' });
    void this.loadList();
  }

  moveSelection(delta: number): void {
    this.store.update((s) => {
      const max = Math.max(0, s.list.items.length - 1);
      const selected = Math.min(max, Math.max(0, s.list.selected + delta));
      return selected === s.list.selected ? s : { ...s, list: { ...s.list, selected } };
    });
  }

  async loadOlder(): Promise<void> {
    const list = this.store.getSnapshot().list;
    const last = list.items.at(-1);
    if (last === undefined || list.olderLoading || list.older === 'end') return;
    const gen = this.listGen;
    this.setList({ olderLoading: true, older: 'progress' });
    try {
      const { managers } = await this.api.listManagers({
        ...(list.filter === null ? {} : { status: [list.filter] }),
        limit: MANAGERS_PAGE,
        after: { managerId: last.managerId, startedAt: last.startedAt },
      });
      if (gen !== this.listGen) return;
      this.store.update((s) => {
        const seen = new Set(s.list.items.map((m) => m.managerId));
        const added = managers.filter((m) => !seen.has(m.managerId));
        return {
          ...s,
          list: {
            ...s.list,
            items: [...s.list.items, ...added],
            older: managers.length >= MANAGERS_PAGE ? 'progress' : 'end',
            olderLoading: false,
          },
        };
      });
    } catch (error) {
      if (gen !== this.listGen) return;
      // 黙って終端に見せない: 錨の 400（読む間に状態が動いて絞りの外へ出た）が典型のため
      this.setList({ olderLoading: false, older: 'blocked', error: messageOf(error) });
    }
  }

  openSelected(): void {
    const list = this.store.getSnapshot().list;
    const row = list.items[list.selected];
    if (row !== undefined) void this.open(row.managerId, row);
  }

  async open(id: string, seed: ManagerRow | null = null): Promise<void> {
    this.detailGen += 1;
    this.store.update((s) => ({
      ...s,
      view: 'detail',
      detail: {
        id,
        manager: seed,
        missing: false,
        transcript: [],
        transcriptStatus: 'loading',
        error: null,
        busy: false,
        notice: null,
        confirmStop: false,
        loadedAt: 0,
      },
    }));
    await this.refreshDetail();
  }

  back(): void {
    this.detailGen += 1;
    this.store.update((s) => (s.view === 'list' ? s : { ...s, view: 'list', detail: null }));
    void this.refreshList();
  }

  async refreshDetail(): Promise<void> {
    const detail = this.store.getSnapshot().detail;
    if (detail === null) return;
    const { id } = detail;
    // 取り直しごとに世代を進める: 後から始めたものが勝つため
    const gen = ++this.detailGen;
    const [manager, transcript] = await Promise.allSettled([
      this.api.readManager(id),
      this.api.readManagerTranscript(id),
    ]);
    if (gen !== this.detailGen) return;
    this.store.update((s) => {
      if (s.detail === null || s.detail.id !== id) return s;
      const d = s.detail;
      const patch: { -readonly [K in keyof DetailState]?: DetailState[K] } = {
        loadedAt: this.now(),
      };
      const errors: string[] = [];
      if (manager.status === 'fulfilled') {
        if (manager.value === null) patch.missing = true;
        else {
          patch.manager = manager.value;
          patch.missing = false;
        }
      } else errors.push(messageOf(manager.reason));
      if (transcript.status === 'fulfilled') {
        if (transcript.value === null) patch.transcriptStatus = 'none';
        else {
          patch.transcript = parseTranscript(transcript.value, d.transcript);
          patch.transcriptStatus = 'ready';
        }
      } else {
        // 取れなかったのを「空」と描かない: 前のログは残す
        patch.transcriptStatus = 'error';
        errors.push(messageOf(transcript.reason));
      }
      patch.error = errors.length > 0 ? errors.join(' / ') : null;
      return { ...s, detail: { ...d, ...patch } };
    });
  }

  // `requestId` / `decision` を付けない: 確認への回答として消費させないため
  async sendMessage(text: string): Promise<boolean> {
    const detail = this.store.getSnapshot().detail;
    if (detail === null || text.length === 0) return false;
    if (detail.busy) {
      this.setDetail(detail.id, {
        notice: '送信中（前の操作が終わってから送る。書いた文は残してある）',
      });
      return false;
    }
    const { id } = detail;
    this.setDetail(id, { busy: true, notice: '送っている…' });
    let delivered: boolean;
    try {
      const result = await this.api.sendManagerMessage(id, text);
      // 端末へ出る前に掃除する: デーモンの応答の文字列のため
      this.setDetail(id, {
        busy: false,
        notice: sanitizeForTerminal(`${result.outcome}: ${result.detail}`),
      });
      // 200 でも `session_missing`・`declined` は送れていない: 書いた文を残させるため
      delivered = DELIVERED_OUTCOMES.has(result.outcome);
    } catch (error) {
      this.setDetail(id, { busy: false, notice: `✗ ${messageOf(error)}` });
      return false;
    }
    await this.refreshDetail();
    return delivered;
  }

  setNotice(notice: string | null): void {
    const d = this.store.getSnapshot().detail;
    if (d !== null && d.notice !== notice) this.setDetail(d.id, { notice });
  }

  askStop(): void {
    const d = this.store.getSnapshot().detail;
    if (d === null || d.busy) return;
    this.setDetail(d.id, { confirmStop: true });
  }

  cancelStop(): void {
    const d = this.store.getSnapshot().detail;
    if (d !== null) this.setDetail(d.id, { confirmStop: false });
  }

  async confirmStop(): Promise<void> {
    const detail = this.store.getSnapshot().detail;
    if (detail === null || !detail.confirmStop || detail.busy) return;
    const { id } = detail;
    this.setDetail(id, { confirmStop: false, busy: true, notice: '止めている…' });
    try {
      const result = await this.api.stopManager(id);
      const mark = STOPPED_OUTCOMES.has(result.outcome) ? '' : '✗ ';
      this.setDetail(id, {
        busy: false,
        notice: `${mark}${sanitizeForTerminal(`${result.outcome}: ${result.detail}`)}`,
      });
    } catch (error) {
      this.setDetail(id, {
        busy: false,
        notice: `✗ ${messageOf(error)}`,
      });
      return;
    }
    await this.refreshDetail();
  }
}

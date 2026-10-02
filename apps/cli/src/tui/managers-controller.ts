/**
 * 「委譲」タブの状態と操作（React を持たない）。一覧（`GET /managers`）と詳細
 * （`GET /managers/{id}` + `/transcript`）、追加指示（`POST /managers/{id}/messages`）、
 * 停止（`DELETE /managers/{id}`）。
 *
 * **Web（`apps/web/app/routes/managers.tsx` と `use-managers-window.ts`）と同じ API・同じ意味**:
 * - 一覧は既定で絞らない。状態で絞れる（Web のチップは複数選択、こちらは 1 つずつ巡る）。
 * - 頁は 50 件（`MANAGERS_PAGE`）。古い側は錨（`afterId` + `afterStartedAt`）で辿り、続きが在るかは
 *   「頁がちょうどいっぱいか」だけで言える（封筒が無い）。
 * - 読めない行（`unreadable`）は「居ない」と分けて数える。
 * - 追加指示は `requestId` / `decision` を付けない（確認への回答として消費させない）。
 *
 * 取り直し: ヘッダの `HeaderFeed.onEvent`（journal の SSE）を合図にまとめて取り直す。一覧の取り直しは
 * 「読み込み済みの件数と同じ `limit` で先頭から」読む（錨を持ち回らない — 古い頁を読み足していても
 * 1 回で揃う）。
 */
import {
  ApiError,
  type ManagerRow,
  type ManagerStatus,
  type TuiApi,
  type UnreadableManager,
} from './api.js';
import type { HeaderFeed } from './header-feed.js';
import type { LogEntry } from './log.js';
import { parseTranscript } from './managers-transcript.js';
import { Store } from './store.js';

/** Web の `MANAGERS_PAGE` と同じ。 */
export const MANAGERS_PAGE = 50;
/** `GET /managers` の `limit` の上限（`managersQuery`）。 */
export const MANAGERS_LIMIT_MAX = 1_000;
/** journal の出来事が続けて届いても、取り直しはこの間隔にまとめる。 */
export const REFRESH_DEBOUNCE_MS = 700;

/** `f` で巡る絞り込み。先頭の `null` は絞らない。 */
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
  /** `idle` = まだ一度も開いていない。 */
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly ManagerRow[];
  readonly unreadable: readonly UnreadableManager[];
  readonly selected: number;
  readonly filter: ManagerStatus | null;
  readonly older: OlderStatus;
  readonly olderLoading: boolean;
  /** 読み込みの失敗（前の一覧は残す）。 */
  readonly error: string | null;
  /** 読んだ時刻（「何分前」の基準）。 */
  readonly loadedAt: number;
}

export interface DetailState {
  readonly id: string;
  /** 一覧の行で仮置きし、読めたら差し替える。 */
  readonly manager: ManagerRow | null;
  /** 404（居ない）。 */
  readonly missing: boolean;
  readonly transcript: readonly LogEntry[];
  readonly transcriptStatus: 'loading' | 'ready' | 'none' | 'error';
  readonly error: string | null;
  /** 追加指示・停止の送信中。 */
  readonly busy: boolean;
  /** 操作の結果（`outcome: detail` をそのまま）。 */
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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ManagersController {
  readonly store = new Store<ManagersState>(initialManagersState);
  /** 一覧の読みの世代（絞りを変えたあとに戻ってきた古い応答を捨てる）。 */
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

  /** journal の出来事を合図に取り直す。 */
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
    // 一度も開いていなければ読まない（開いたときに読む）。
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

  // --- 一覧 ---------------------------------------------------------------

  /** タブを開いたとき。初回だけ読む（以後は journal の合図で取り直す）。 */
  enter(): void {
    if (this.store.getSnapshot().list.status === 'idle') void this.loadList();
  }

  /** 先頭の頁から読み直す（絞りの変更・初回）。 */
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
      this.setList({ status: 'error', error: messageOf(error) });
    }
  }

  /** 読み込み済みの件数ぶんを先頭から読み直す（選択は id で保つ）。失敗しても前の一覧を残す。 */
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
            error: null,
            loadedAt: this.now(),
          },
        };
      });
    } catch (error) {
      if (gen !== this.listGen) return;
      this.setList({ error: messageOf(error) });
    }
  }

  /** 状態の絞りを次へ巡る（すべて → 実行中 → … → すべて）。 */
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

  /** 古い側の次の頁を読み足す。 */
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
      // 錨の 400（読む間に状態が動いて絞りの外へ出た）が典型。黙って終端に見せない。
      this.setList({ olderLoading: false, older: 'blocked', error: messageOf(error) });
    }
  }

  // --- 詳細 ---------------------------------------------------------------

  /** 選択中の行を開く。 */
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

  /** 一覧へ戻る（詳細を捨てる）。 */
  back(): void {
    this.detailGen += 1;
    this.store.update((s) => (s.view === 'list' ? s : { ...s, view: 'list', detail: null }));
    void this.refreshList();
  }

  async refreshDetail(): Promise<void> {
    const detail = this.store.getSnapshot().detail;
    if (detail === null) return;
    const { id } = detail;
    const gen = this.detailGen;
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
        // 取れなかったのを「空」と描かない。前のログは残す。
        patch.transcriptStatus = 'error';
        errors.push(messageOf(transcript.reason));
      }
      patch.error = errors.length > 0 ? errors.join(' / ') : null;
      return { ...s, detail: { ...d, ...patch } };
    });
  }

  /** 追加指示を送る。結果（`outcome: detail`）はそのまま見せる。 */
  async sendMessage(text: string): Promise<void> {
    const detail = this.store.getSnapshot().detail;
    if (detail === null || detail.busy || text.length === 0) return;
    const { id } = detail;
    this.setDetail(id, { busy: true, notice: '送っている…' });
    try {
      const result = await this.api.sendManagerMessage(id, text);
      this.setDetail(id, { busy: false, notice: `${result.outcome}: ${result.detail}` });
    } catch (error) {
      this.setDetail(id, { busy: false, notice: `✗ ${messageOf(error)}` });
      return;
    }
    await this.refreshDetail();
  }

  /** 詳細の最下行に一言出す（コマンドの案内など）。`null` で消す。 */
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

  /** 確認のあとに呼ぶ。応答の `outcome` を読み替えずに出す（`stopped` 以外を「止めた」と言わない）。 */
  async confirmStop(): Promise<void> {
    const detail = this.store.getSnapshot().detail;
    if (detail === null || !detail.confirmStop || detail.busy) return;
    const { id } = detail;
    this.setDetail(id, { confirmStop: false, busy: true, notice: '止めている…' });
    try {
      const result = await this.api.stopManager(id);
      this.setDetail(id, { busy: false, notice: `${result.outcome}: ${result.detail}` });
    } catch (error) {
      this.setDetail(id, {
        busy: false,
        notice: `✗ ${error instanceof ApiError ? error.message : messageOf(error)}`,
      });
      return;
    }
    await this.refreshDetail();
  }
}

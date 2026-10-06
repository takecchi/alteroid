/**
 * 「承認待ち」タブの状態と操作（React を持たない）。一覧（`GET /approvals?pending=true&order=asc`）と
 * 詳細、答える（`POST /approvals/{id}/answer`）。
 *
 * **CLI `chat.ts` の `/approvals` `/approval` `/answer` と同じ API・同じ意味**:
 * - 一覧は未回答のみ、`order=asc`（古い順 — 番号を振って使う前提の並びを実装によらず揃える）。
 * - 設問が在れば `{ selections, answer? }`、無ければ `{ answer }`（自由文）。
 * - 400 などの失敗は、デーモンの理由（本文の `error`）をそのまま見せる。黙って閉じない。
 * - 詳細は一覧に無くても開ける（回答済み・取り下げ済みは `GET /approvals/{id}` で1件引く）。
 *
 * 取り直し: ヘッダの `HeaderFeed.onEvent`（journal の SSE）を合図にまとめて取り直す。
 * 詳細が開いていれば同じ 1 回の読みで詳細も更新する（`pending=true` に無いときだけ全件を読む）。
 *
 * **作らないもの**: `POST /approvals/answer`（まとめて答える）と、`request_permission` の許可/拒否の
 * 専用操作。後者は自由文で答える承認待ちとして扱い、`/allow` `/deny`（マネージャーへの
 * `decision` つきメッセージ）には触れない。
 */
import {
  ApiError,
  type AnsweredDateRow,
  type ApprovalRow,
  type TuiApi,
  type UnreadableApproval,
} from './api.js';
import {
  buildAnswer,
  emptyForm,
  moveCursor,
  setOther,
  setText,
  slotsOf,
  toggleOption,
  type BuiltAnswer,
  type FormState,
} from './approvals-form.js';
import type { HeaderFeed } from './header-feed.js';
import { redactedErrorMessage } from '../redact.js';
import { Store } from './store.js';

/** journal の出来事が続けて届いても、取り直しはこの間隔にまとめる。 */
export const REFRESH_DEBOUNCE_MS = 700;

export interface ListState {
  /** `idle` = まだ一度も開いていない。 */
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly ApprovalRow[];
  readonly unreadable: readonly UnreadableApproval[];
  readonly selected: number;
  /** 読み込みの失敗（前の一覧は残す）。 */
  readonly error: string | null;
  /** 読んだ時刻（「何分前」の基準）。 */
  readonly loadedAt: number;
}

export type DetailMode = 'read' | 'form' | 'confirm';

export interface ConfirmState {
  readonly preview: string;
  readonly unanswered: number;
}

export interface DetailState {
  readonly id: string;
  /** 一覧の行で仮置きし、読めたら差し替える。 */
  readonly approval: ApprovalRow | null;
  /** どこにも無い（404 相当）。 */
  readonly missing: boolean;
  readonly mode: DetailMode;
  /** 答えるフォーム（`a` で作る。読む画面へ戻っても、送るか詳細を閉じるまで残す）。 */
  readonly form: FormState | null;
  readonly confirm: ConfirmState | null;
  /** 送信中。 */
  readonly busy: boolean;
  /** 操作の結果（400 の理由はそのまま入る）。 */
  readonly notice: string | null;
  readonly noticeTone: 'info' | 'warn';
  /** 取り直しの失敗。 */
  readonly error: string | null;
  readonly loadedAt: number;
}

/** 決着した日の一覧（回答済み・取り下げ済みを日ごとに辿る入口。#3340）。 */
export interface DatesState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  /** 新しい日が上（デーモンが並べた順のまま）。 */
  readonly items: readonly AnsweredDateRow[];
  readonly selected: number;
  /** 読み込みの失敗（前の一覧は残す）。 */
  readonly error: string | null;
  /** 直近の読みがちょうど `limit` 件だった（= これより古い日があるかもしれない）。 */
  readonly maybeMore: boolean;
  readonly loadedAt: number;
}

/** 1 日ぶんの決着した件（回答済み・取り下げ済み。決着の新しい順）。 */
export interface DayState {
  readonly date: string | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly ApprovalRow[];
  readonly selected: number;
  readonly error: string | null;
  readonly loadedAt: number;
}

export interface ApprovalsState {
  /** list = 未回答 / detail = 1 件 / dates = 決着した日 / day = その日の件。 */
  readonly view: 'list' | 'detail' | 'dates' | 'day';
  readonly list: ListState;
  readonly detail: DetailState | null;
  readonly dates: DatesState;
  readonly day: DayState;
  /** 詳細を開いた元（Esc で戻る先）。 */
  readonly detailFrom: 'list' | 'day';
}

/** 決着した日の一覧を 1 回に読む日数（続きは `loadMoreDates`）。 */
export const ANSWERED_DATES_LIMIT = 30;

export const initialApprovalsState: ApprovalsState = {
  view: 'list',
  list: { status: 'idle', items: [], unreadable: [], selected: 0, error: null, loadedAt: 0 },
  detail: null,
  dates: { status: 'idle', items: [], selected: 0, error: null, maybeMore: false, loadedAt: 0 },
  day: { date: null, status: 'idle', items: [], selected: 0, error: null, loadedAt: 0 },
  detailFrom: 'list',
};

const messageOf = redactedErrorMessage;

/** まだ答えられる承認待ちか（未回答かつ未取り下げ）。 */
export const isOpen = (approval: ApprovalRow | null): boolean =>
  approval !== null && approval.answeredAt === undefined && approval.withdrawnAt === undefined;

/** もう答えられなくなったときの一言。送ろうとして落ちた理由（`✗ …`）があれば、それを残して添える。 */
function settledNotice(
  approval: ApprovalRow,
  previous: string | null,
  sendUnknown: boolean,
): string {
  const now =
    approval.withdrawnAt !== undefined
      ? 'この承認待ちは取り下げられた。答えは送っていない'
      : sendUnknown
        ? '応答が無く、送れたかは分からない。この承認待ちは回答済みになっている'
        : 'この承認待ちは他の入口で回答済みになった。答えは送っていない';
  return previous !== null && previous.startsWith('✗') ? `${previous}（${now}）` : now;
}

export class ApprovalsController {
  readonly store = new Store<ApprovalsState>(initialApprovalsState);
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detach: (() => void) | undefined;
  private feed: HeaderFeed | undefined;
  /** 応答が無いまま失敗した送信の承認待ち id（取り直しで回答済みなら「送っていない」と言い切らない）。 */
  private unknownSendId: string | undefined;

  constructor(
    private readonly api: TuiApi,
    private readonly options: { debounceMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** journal の出来事を合図に取り直す。回答のあとはヘッダの件数もすぐ取り直す。 */
  attach(feed: HeaderFeed): void {
    this.detach?.();
    this.feed = feed;
    this.detach = feed.onEvent(() => this.scheduleRefresh());
  }

  dispose(): void {
    this.detach?.();
    this.detach = undefined;
    this.feed = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleRefresh(): void {
    // 一度も開いていなければ読まない（開いたときに読む）。
    if (this.store.getSnapshot().list.status === 'idle') return;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.store.getSnapshot().list.status === 'idle') return;
      void this.reload();
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

  private currentDetail(): DetailState | null {
    return this.store.getSnapshot().detail;
  }

  // --- 一覧 ---------------------------------------------------------------

  /** タブを開いたとき。まだ読んでいない（idle）か、前の読みが失敗した（error）ときに読む（以後は journal の合図で取り直す）。 */
  enter(): void {
    const { status } = this.store.getSnapshot().list;
    if (status === 'idle' || status === 'error') void this.reload();
  }

  /**
   * 未回答の一覧を読み直す。詳細が開いていれば同じ読みで詳細も更新する（一覧に無ければ、
   * 回答済み・取り下げ済みを含めて探す）。失敗しても前の一覧を残す。選択は id で保つ。
   */
  async reload(): Promise<void> {
    const gen = ++this.gen;
    const first = this.store.getSnapshot().list.status === 'idle';
    if (first) this.setList({ status: 'loading', error: null });
    let pending: { approvals: ApprovalRow[]; unreadable: UnreadableApproval[] };
    try {
      pending = await this.api.listApprovals({ pending: true });
    } catch (error) {
      if (gen !== this.gen) return;
      this.setList({
        status: this.store.getSnapshot().list.status === 'ready' ? 'ready' : 'error',
        error: messageOf(error),
      });
      this.markDetailError(messageOf(error));
      return;
    }
    if (gen !== this.gen) return;
    this.store.update((s) => {
      const keptId = s.list.items[s.list.selected]?.id;
      const at = keptId === undefined ? -1 : pending.approvals.findIndex((a) => a.id === keptId);
      const selected =
        at >= 0 ? at : Math.min(s.list.selected, Math.max(0, pending.approvals.length - 1));
      return {
        ...s,
        list: {
          status: 'ready',
          items: pending.approvals,
          unreadable: pending.unreadable,
          selected,
          error: null,
          loadedAt: this.now(),
        },
      };
    });
    const detail = this.currentDetail();
    if (detail === null) return;
    const id = detail.id;
    let found: ApprovalRow | undefined = pending.approvals.find((a) => a.id === id);
    if (found === undefined) {
      // 未回答の一覧に無い: 回答済み・取り下げ済みか、そもそも無いか。全件は読まず、id で1件引く。
      try {
        found = (await this.api.readApproval(id)) ?? undefined;
      } catch (error) {
        if (gen !== this.gen) return;
        this.markDetailError(messageOf(error));
        return;
      }
      if (gen !== this.gen) return;
    }
    this.applyDetail(id, found ?? null);
  }

  private markDetailError(error: string): void {
    const d = this.currentDetail();
    if (d !== null) this.setDetail(d.id, { error });
  }

  /** 読んだ結果を詳細へ反映する。もう答えられないなら、書きかけのフォームは閉じてそう言う。 */
  private applyDetail(id: string, approval: ApprovalRow | null): void {
    this.store.update((s) => {
      const d = s.detail;
      if (d === null || d.id !== id) return s;
      if (approval === null) {
        return { ...s, detail: { ...d, missing: true, error: null, loadedAt: this.now() } };
      }
      const settledUnderfoot = !isOpen(approval) && d.mode !== 'read';
      return {
        ...s,
        detail: {
          ...d,
          approval,
          missing: false,
          error: null,
          loadedAt: this.now(),
          ...(settledUnderfoot
            ? {
                mode: 'read' as const,
                form: null,
                confirm: null,
                notice: settledNotice(approval, d.notice, this.unknownSendId === id),
                noticeTone: 'warn' as const,
              }
            : {}),
        },
      };
    });
  }

  moveSelection(delta: number): void {
    this.store.update((s) => {
      const max = Math.max(0, s.list.items.length - 1);
      const selected = Math.min(max, Math.max(0, s.list.selected + delta));
      return selected === s.list.selected ? s : { ...s, list: { ...s.list, selected } };
    });
  }

  // --- 詳細 ---------------------------------------------------------------

  openSelected(): void {
    const list = this.store.getSnapshot().list;
    const row = list.items[list.selected];
    if (row !== undefined) void this.open(row.id, row);
  }

  /** id から開く（会話の `ask_human` の案内・`/approvals <id>`）。一覧に無くても探す。 */
  async open(
    id: string,
    seed: ApprovalRow | null = null,
    from: 'list' | 'day' = 'list',
  ): Promise<void> {
    this.gen += 1;
    this.store.update((s) => ({
      ...s,
      view: 'detail',
      detailFrom: from,
      detail: {
        id,
        approval: seed,
        missing: false,
        mode: 'read',
        form: null,
        confirm: null,
        busy: false,
        notice: null,
        noticeTone: 'info',
        error: null,
        loadedAt: this.now(),
      },
    }));
    await this.reload();
  }

  /**
   * 元の画面へ戻る（詳細とフォームを捨てる）。その日の件から開いたならその日へ、それ以外は未回答の一覧へ。
   */
  back(): void {
    this.gen += 1;
    const from = this.store.getSnapshot().detailFrom;
    if (from === 'day') {
      this.store.update((s) =>
        s.view === 'detail' ? { ...s, view: 'day', detail: null, detailFrom: 'list' } : s,
      );
      void this.loadDay();
      return;
    }
    this.store.update((s) => (s.view === 'list' ? s : { ...s, view: 'list', detail: null }));
    void this.reload();
  }

  // --- 回答済み（決着した日ごと。#3340） -------------------------------------

  private datesGen = 0;
  private dayGen = 0;

  private setDates(patch: Partial<DatesState>): void {
    this.store.update((s) => ({ ...s, dates: { ...s.dates, ...patch } }));
  }

  private setDay(patch: Partial<DayState>): void {
    this.store.update((s) => ({ ...s, day: { ...s.day, ...patch } }));
  }

  /** 未回答の一覧から、決着した日の一覧へ。開くたびに読み直す（前の一覧は読み込み中も残す）。 */
  openDates(): void {
    this.store.update((s) => (s.view === 'list' ? { ...s, view: 'dates' } : s));
    void this.loadDates();
  }

  /** 決着した日の一覧から、未回答の一覧へ戻る。 */
  leaveDates(): void {
    this.store.update((s) => (s.view === 'dates' ? { ...s, view: 'list' } : s));
  }

  /** 決着した日を先頭から読み直す。失敗しても前の一覧を残し、失敗は `error` に出す（0 件と描かない）。 */
  async loadDates(): Promise<void> {
    const gen = ++this.datesGen;
    if (this.store.getSnapshot().dates.items.length === 0) {
      this.setDates({ status: 'loading', error: null });
    }
    let rows: AnsweredDateRow[];
    try {
      rows = await this.api.listAnsweredDates({ limit: ANSWERED_DATES_LIMIT });
    } catch (error) {
      if (gen !== this.datesGen) return;
      this.setDates({
        status: this.store.getSnapshot().dates.items.length > 0 ? 'ready' : 'error',
        error: messageOf(error),
      });
      return;
    }
    if (gen !== this.datesGen) return;
    this.store.update((s) => {
      const keptDate = s.dates.items[s.dates.selected]?.date;
      const at = keptDate === undefined ? -1 : rows.findIndex((r) => r.date === keptDate);
      return {
        ...s,
        dates: {
          status: 'ready',
          items: rows,
          selected: at >= 0 ? at : Math.min(s.dates.selected, Math.max(0, rows.length - 1)),
          error: null,
          maybeMore: rows.length === ANSWERED_DATES_LIMIT,
          loadedAt: this.now(),
        },
      };
    });
  }

  /** 古い側へ続きを読む（いま見えている最後の日より古い日から）。続きが無さそうなら何もしない。 */
  async loadMoreDates(): Promise<void> {
    const { items, maybeMore } = this.store.getSnapshot().dates;
    const last = items[items.length - 1];
    if (!maybeMore || last === undefined) return;
    const gen = ++this.datesGen;
    let rows: AnsweredDateRow[];
    try {
      rows = await this.api.listAnsweredDates({
        limit: ANSWERED_DATES_LIMIT,
        beforeDate: last.date,
      });
    } catch (error) {
      if (gen !== this.datesGen) return;
      this.setDates({ error: messageOf(error) });
      return;
    }
    if (gen !== this.datesGen) return;
    this.store.update((s) => ({
      ...s,
      dates: {
        ...s.dates,
        items: [...s.dates.items, ...rows],
        error: null,
        maybeMore: rows.length === ANSWERED_DATES_LIMIT,
        loadedAt: this.now(),
      },
    }));
  }

  moveDatesSelection(delta: number): void {
    this.store.update((s) => {
      const max = Math.max(0, s.dates.items.length - 1);
      const selected = Math.min(max, Math.max(0, s.dates.selected + delta));
      return selected === s.dates.selected ? s : { ...s, dates: { ...s.dates, selected } };
    });
  }

  /** 選んでいる日の件を開く。 */
  openDay(): void {
    const { items, selected } = this.store.getSnapshot().dates;
    const row = items[selected];
    if (row === undefined) return;
    this.store.update((s) => ({
      ...s,
      view: 'day',
      day: { date: row.date, status: 'loading', items: [], selected: 0, error: null, loadedAt: 0 },
    }));
    void this.loadDay();
  }

  /** その日の件から、決着した日の一覧へ戻る。 */
  leaveDay(): void {
    this.store.update((s) => (s.view === 'day' ? { ...s, view: 'dates' } : s));
  }

  /** いま開いている日の件を読み直す。失敗しても前の件を残し、0 件と描かない。 */
  async loadDay(): Promise<void> {
    const date = this.store.getSnapshot().day.date;
    if (date === null) return;
    const gen = ++this.dayGen;
    let rows: ApprovalRow[];
    try {
      rows = await this.api.listApprovalsAnsweredOn(date);
    } catch (error) {
      if (gen !== this.dayGen) return;
      this.setDay({
        status: this.store.getSnapshot().day.items.length > 0 ? 'ready' : 'error',
        error: messageOf(error),
      });
      return;
    }
    if (gen !== this.dayGen) return;
    this.store.update((s) => {
      const keptId = s.day.items[s.day.selected]?.id;
      const at = keptId === undefined ? -1 : rows.findIndex((r) => r.id === keptId);
      return {
        ...s,
        day: {
          date,
          status: 'ready',
          items: rows,
          selected: at >= 0 ? at : Math.min(s.day.selected, Math.max(0, rows.length - 1)),
          error: null,
          loadedAt: this.now(),
        },
      };
    });
  }

  moveDaySelection(delta: number): void {
    this.store.update((s) => {
      const max = Math.max(0, s.day.items.length - 1);
      const selected = Math.min(max, Math.max(0, s.day.selected + delta));
      return selected === s.day.selected ? s : { ...s, day: { ...s.day, selected } };
    });
  }

  /** その日の件から、既存の詳細（`open`）へ。Esc でその日へ戻る。 */
  openDayItem(): void {
    const { items, selected } = this.store.getSnapshot().day;
    const row = items[selected];
    if (row !== undefined) void this.open(row.id, row, 'day');
  }

  // --- 答える -------------------------------------------------------------

  /**
   * 答えるフォームを開く（書きかけがあれば続きから）。答えられない（回答済み・取り下げ済み・
   * 読み込み前）ときは何もしない。戻り値が `'edit'` なら、いまのカーソルは文字を書く欄
   * （設問の無い承認待ち）なので、呼び出し側は入力欄へフォーカスを移す。
   */
  startAnswer(): 'edit' | 'form' | null {
    const d = this.currentDetail();
    if (d === null || d.busy || !isOpen(d.approval)) return null;
    const form = d.form ?? emptyForm(0);
    this.setDetail(d.id, { mode: 'form', form, confirm: null, notice: null });
    // 設問の無い承認待ちは文字欄が 1 つだけ（カーソルは常にそこ）。
    return (d.approval?.questions ?? []).length === 0 ? 'edit' : 'form';
  }

  /** フォームを閉じて読む画面へ戻る（書きかけは残す）。 */
  leaveForm(): void {
    const d = this.currentDetail();
    if (d !== null && d.mode === 'form') this.setDetail(d.id, { mode: 'read' });
  }

  moveCursor(delta: number): void {
    const d = this.currentDetail();
    if (d === null || d.form === null || d.mode !== 'form') return;
    const form = moveCursor(d.form, slotsOf(d.approval?.questions), delta);
    if (form !== d.form) this.setDetail(d.id, { form });
  }

  /**
   * Space / Enter。選択肢の上なら選ぶ/外す（単一は排他）。文字を書く欄（その他・補足/回答）の上なら
   * `'edit'` を返す — 呼び出し側が入力欄へフォーカスを移し、終えたら `setFieldText` で返す。
   */
  activate(): 'toggled' | 'edit' | null {
    const d = this.currentDetail();
    if (d === null || d.form === null || d.mode !== 'form' || d.busy) return null;
    const questions = d.approval?.questions ?? [];
    const slot = slotsOf(questions)[d.form.cursor];
    if (slot === undefined) return null;
    if (slot.kind !== 'option') return 'edit';
    const question = questions[slot.q];
    const option = question?.options[slot.o];
    if (question === undefined || option === undefined) return null;
    this.setDetail(d.id, { form: toggleOption(d.form, question, option.id), notice: null });
    return 'toggled';
  }

  /** いまのカーソルが指す文字欄の中身（入力欄へ読み込む）。文字欄でなければ空。 */
  fieldText(): string {
    const d = this.currentDetail();
    if (d === null || d.form === null) return '';
    const questions = d.approval?.questions ?? [];
    const slot = slotsOf(questions)[d.form.cursor];
    if (slot?.kind === 'text') return d.form.text;
    if (slot?.kind === 'other') {
      const question = questions[slot.q];
      return question === undefined ? '' : (d.form.others[question.id] ?? '');
    }
    return '';
  }

  /** 入力欄で書いた文を、カーソルの指す文字欄へ置く。 */
  setFieldText(text: string): void {
    const d = this.currentDetail();
    if (d === null || d.form === null || d.mode !== 'form') return;
    const questions = d.approval?.questions ?? [];
    const slot = slotsOf(questions)[d.form.cursor];
    if (slot?.kind === 'text') this.setDetail(d.id, { form: setText(d.form, text) });
    else if (slot?.kind === 'other') {
      const question = questions[slot.q];
      if (question !== undefined) this.setDetail(d.id, { form: setOther(d.form, question, text) });
    }
  }

  /**
   * 入力欄で Enter。設問の無い承認待ちは、書いた自由文がそのまま回答なので確認へ進む。
   * 設問つきは、文字欄へ置いてフォームに戻る。
   */
  submitField(text: string): void {
    this.setFieldText(text);
    const d = this.currentDetail();
    if (d === null) return;
    const questions = d.approval?.questions;
    if (questions === undefined || questions.length === 0) this.askConfirm();
  }

  /** 確認へ進む。送る形にならない（空の回答など）ときは、理由を出してフォームに留まる。 */
  askConfirm(): void {
    const d = this.currentDetail();
    if (d === null || d.form === null || d.busy || !isOpen(d.approval)) return;
    const built = buildAnswer(d.approval?.questions, d.form);
    if (!built.ok) {
      this.setDetail(d.id, { notice: built.reason, noticeTone: 'warn' });
      return;
    }
    this.setDetail(d.id, {
      mode: 'confirm',
      confirm: { preview: built.preview, unanswered: built.unanswered },
      notice: null,
    });
  }

  /** 確認をやめてフォームへ戻る。 */
  cancelConfirm(): void {
    const d = this.currentDetail();
    if (d !== null && d.mode === 'confirm') {
      this.setDetail(d.id, { mode: 'form', confirm: null });
    }
  }

  /**
   * 確認を通った回答を送る。成功なら `true`。失敗（400・404・409）は、デーモンの理由をそのまま
   * 出してフォームへ戻る（書いた内容は残す）。
   */
  async confirmSend(): Promise<boolean> {
    const d = this.currentDetail();
    if (d === null || d.mode !== 'confirm' || d.form === null || d.busy) return false;
    const id = d.id;
    const built: BuiltAnswer = buildAnswer(d.approval?.questions, d.form);
    if (!built.ok) {
      this.setDetail(id, { mode: 'form', confirm: null, notice: built.reason, noticeTone: 'warn' });
      return false;
    }
    this.setDetail(id, { busy: true, notice: '送っている…', noticeTone: 'info' });
    try {
      await this.api.answerApproval(id, built.body);
    } catch (error) {
      // HTTP の応答が無い失敗（接続断など）は、デーモンが答えを受けたかどうか分からない。
      if (!(error instanceof ApiError)) this.unknownSendId = id;
      this.setDetail(id, {
        busy: false,
        mode: 'form',
        confirm: null,
        notice: `✗ ${messageOf(error)}`,
        noticeTone: 'warn',
      });
      // 409（既に回答済み・取り下げ済み）などで状態が変わっていれば、取り直して見せる。
      await this.reload();
      this.unknownSendId = undefined;
      return false;
    }
    this.setDetail(id, {
      busy: false,
      mode: 'read',
      form: null,
      confirm: null,
      notice: '回答した。答えた仕事だけが再開する',
      noticeTone: 'info',
    });
    void this.feed?.refetch();
    await this.reload();
    return true;
  }
}

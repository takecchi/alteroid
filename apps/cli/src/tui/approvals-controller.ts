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
  isBlankForm,
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

export const REFRESH_DEBOUNCE_MS = 700;

export interface ListState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly ApprovalRow[];
  readonly unreadable: readonly UnreadableApproval[];
  readonly selected: number;
  readonly error: string | null;
  readonly loadedAt: number;
}

export type DetailMode = 'read' | 'form' | 'confirm';

export interface ConfirmState {
  readonly preview: string;
  readonly unanswered: number;
}

export interface DetailState {
  readonly id: string;
  readonly approval: ApprovalRow | null;
  readonly missing: boolean;
  readonly mode: DetailMode;
  readonly form: FormState | null;
  readonly confirm: ConfirmState | null;
  readonly busy: boolean;
  readonly notice: string | null;
  readonly noticeTone: 'info' | 'warn';
  readonly error: string | null;
  readonly loadedAt: number;
}

export interface DatesState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly AnsweredDateRow[];
  readonly selected: number;
  readonly error: string | null;
  readonly maybeMore: boolean;
  readonly loadedAt: number;
}

export interface DayState {
  readonly date: string | null;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly ApprovalRow[];
  readonly selected: number;
  readonly error: string | null;
  readonly loadedAt: number;
}

export interface ApprovalsState {
  readonly view: 'list' | 'detail' | 'dates' | 'day';
  readonly list: ListState;
  readonly detail: DetailState | null;
  readonly dates: DatesState;
  readonly day: DayState;
  readonly detailFrom: 'list' | 'day';
}

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

export const isOpen = (approval: ApprovalRow | null): boolean =>
  approval !== null && approval.answeredAt === undefined && approval.withdrawnAt === undefined;

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

function cannotAnswerNotice(approval: ApprovalRow): string {
  return approval.withdrawnAt !== undefined
    ? 'もう答えられない: この承認待ちは取り下げ済み'
    : 'もう答えられない: この承認待ちは回答済み';
}

export class ApprovalsController {
  readonly store = new Store<ApprovalsState>(initialApprovalsState);
  private gen = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private detach: (() => void) | undefined;
  private feed: HeaderFeed | undefined;
  // 回答済みでも「送っていない」と言い切らない: 応答が無いまま失敗した送信は、デーモンが受けたか分からないため
  private unknownSendId: string | undefined;

  constructor(
    private readonly api: TuiApi,
    private readonly options: { debounceMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

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

  enter(): void {
    const { status } = this.store.getSnapshot().list;
    if (status === 'idle' || status === 'error') void this.reload();
  }

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

  openSelected(): void {
    const list = this.store.getSnapshot().list;
    const row = list.items[list.selected];
    if (row !== undefined) void this.open(row.id, row);
  }

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

  private datesGen = 0;
  private dayGen = 0;

  private setDates(patch: Partial<DatesState>): void {
    this.store.update((s) => ({ ...s, dates: { ...s.dates, ...patch } }));
  }

  private setDay(patch: Partial<DayState>): void {
    this.store.update((s) => ({ ...s, day: { ...s.day, ...patch } }));
  }

  openDates(): void {
    this.store.update((s) => (s.view === 'list' ? { ...s, view: 'dates' } : s));
    void this.loadDates();
  }

  leaveDates(): void {
    this.store.update((s) => (s.view === 'dates' ? { ...s, view: 'list' } : s));
  }

  // 失敗を 0 件と描かない: 前の一覧を残し、失敗は `error` に出す
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

  leaveDay(): void {
    this.store.update((s) => (s.view === 'day' ? { ...s, view: 'dates' } : s));
  }

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

  openDayItem(): void {
    const { items, selected } = this.store.getSnapshot().day;
    const row = items[selected];
    if (row !== undefined) void this.open(row.id, row, 'day');
  }

  startAnswer(): 'edit' | 'form' | null {
    const d = this.currentDetail();
    if (d === null || d.busy) return null;
    if (!isOpen(d.approval)) {
      if (d.approval !== null) {
        this.setDetail(d.id, { notice: cannotAnswerNotice(d.approval), noticeTone: 'warn' });
      }
      return null;
    }
    const form = d.form ?? emptyForm(0);
    this.setDetail(d.id, { mode: 'form', form, confirm: null, notice: null });
    return (d.approval?.questions ?? []).length === 0 ? 'edit' : 'form';
  }

  hasDraft(): boolean {
    const form = this.currentDetail()?.form ?? null;
    return form !== null && !isBlankForm(form);
  }

  setNotice(notice: string): void {
    const d = this.currentDetail();
    if (d !== null) this.setDetail(d.id, { notice, noticeTone: 'warn' });
  }

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

  submitField(text: string): void {
    this.setFieldText(text);
    const d = this.currentDetail();
    if (d === null) return;
    const questions = d.approval?.questions;
    if (questions === undefined || questions.length === 0) this.askConfirm();
  }

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

  cancelConfirm(): void {
    const d = this.currentDetail();
    if (d !== null && d.mode === 'confirm') {
      this.setDetail(d.id, { mode: 'form', confirm: null });
    }
  }

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
      if (!(error instanceof ApiError)) this.unknownSendId = id;
      this.setDetail(id, {
        busy: false,
        mode: 'form',
        confirm: null,
        notice: `✗ ${messageOf(error)}`,
        noticeTone: 'warn',
      });
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

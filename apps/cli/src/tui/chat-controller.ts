// 「考えている…」をサーバの `thinking` を待たずに出す: 先客のターンが走っている間は `thinking` が来ないため
import { randomUUID } from 'node:crypto';

import {
  AttachmentDraft,
  AttachmentMissingError,
  attachmentLinesOf,
  interpretAttachPath,
  describeAttachment,
  expireUploads,
  type DraftFile,
  uploadDraft,
} from '../attachments.js';
import {
  NotDeliveredError,
  type ChatEvent,
  type ConversationMessage,
  type ConversationSummary,
  type TuiApi,
} from './api.js';
import type { LogEntry, LogKind } from './log.js';
import {
  approvalNoticeLines,
  approvalText,
  interleaveApprovals,
  type ConversationApprovalsRead,
} from '../conversation-approvals.js';
import { redactBody, redactedErrorMessage, redactError } from '../redact.js';
import { resolveCommand } from './commands.js';
import { Store } from './store.js';
import { turnFailureHint } from './turn-failure.js';

export interface ChatState {
  readonly conversationId: string | null;
  readonly entries: readonly LogEntry[];
  readonly streaming: string;
  readonly busy: boolean;
  readonly transient: string | null;
  readonly pendingAsk: string | null;
}

export const MAX_ENTRIES = 1_000;

export const initialChatState: ChatState = {
  conversationId: null,
  entries: [],
  streaming: '',
  busy: false,
  transient: null,
  pendingAsk: null,
};

const messageOf = redactedErrorMessage;

function unansweredIds(read: ConversationApprovalsRead): string[] {
  const time = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return read.approvals
    .filter((a) => !a.answeredAt && !a.withdrawnAt)
    .sort((a, b) => time(a.createdAt) - time(b.createdAt))
    .map((a) => a.id);
}

export const EDIT_EMPTY_MESSAGE =
  '本文も添付も無いので送っていない（本文を打つか、/attach で添付を足す。やめるなら /edit-cancel）';

interface EditInProgress {
  readonly id: string;
  readonly conversationId: string;
}

interface EditStash {
  readonly text: string;
  readonly files: readonly DraftFile[];
}

const editKey = (edit: EditInProgress): string => `${edit.conversationId}\n${edit.id}`;

const EDIT_LIST_PREVIEW = 40;

function previewOf(text: string): string {
  const single = redactBody(text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(single);
  return chars.length > EDIT_LIST_PREVIEW
    ? `${chars.slice(0, EDIT_LIST_PREVIEW).join('')}…`
    : single;
}

// 待たずに同期で進める: 送信の前に非同期の隙間を作らないため
const NO_ATTACHMENTS = { ids: [] as string[], lines: [] as string[], files: [] as DraftFile[] };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 誰も待っていないまま reject されても未処理の拒否にしない。
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function closedQuietlyNotice(sawEvent: boolean): string {
  return sawEvent
    ? '応答が途中で切れた（done も error も来ないまま接続が閉じた）。出ているのは受け取った分だけ'
    : '応答が来ないまま接続が閉じた。発言が受け取られたかは分からない（次の送信の前に確かめ直す）';
}

export const RESUME_PROBE_LIMIT = 5;

class ReplyOutcome {
  conversationId: string | null = null;
  private done = false;
  private failed = false;
  sawEvent = false;

  see(event: ChatEvent): void {
    this.sawEvent = true;
    if (event.type === 'open') this.conversationId = event.conversationId;
    else if (event.type === 'done') this.done = true;
    else if (event.type === 'error' || event.type === 'usage_limited') this.failed = true;
  }

  get ended(): boolean {
    return this.done || this.failed;
  }

  get displayed(): boolean {
    return this.done && !this.failed;
  }
}

export class ChatController {
  readonly store = new Store<ChatState>(initialChatState);
  private seq = 0;
  private abort: AbortController | null = null;
  private opened: Deferred<string> | null = null;
  private watch: AbortController | null = null;

  private readonly draft = new AttachmentDraft(() => this.api.attachmentLimits());
  private uploading = false;
  // 新しい会話のまま送らない: 添付が最初の会話に結び付いたまま新しい会話として送ると `attachment_conflict` になるため
  private unopened: string | null = null;
  private lookingUp = false;
  private unopenedFiles: readonly DraftFile[] = [];
  // 開いている最中の送信は通さない: 開く処理の丸ごとの差し替えで発言の行が消え、会話 id が取り違えられるため
  private switching = false;
  private askIds: string[] = [];
  private readonly markedThrough = new Map<string, string>();
  private editing: EditInProgress | null = null;
  // 会話を移った編集の書きかけ（編集の対象ごと）: 戻って同じ発言を /edit したときに続けられるように
  private readonly editStash = new Map<string, EditStash>();
  private lastBody = '';
  private editList: { conversationId: string; ids: string[] } | null = null;

  constructor(private readonly api: TuiApi) {}

  isEditing(): boolean {
    return this.editing !== null;
  }

  // 入力欄の本文は、変わるたびに覚える: 会話を移るコマンドは入力欄へ打って Enter で出すので、
  // 動かす時点では入力欄が空（本文を消してコマンドを打ち、送信で空になる）で、そのとき読んでも本文は残っていないため。
  // コマンドとして読まれる文と空は覚えない（本文を消してコマンドを打つ途中で、本文を上書きしないため）。
  // 末尾を削っただけの変化も覚え直さない: Backspace で1文字ずつ消してからコマンドを打つと、最後に残った1文字だけをしまうことになるため
  noteInput(value: string): void {
    if (this.editing === null || value === '' || resolveCommand(value).kind !== 'text') return;
    if (this.lastBody.startsWith(value)) return;
    this.lastBody = value;
  }

  // 編集は持ち越さずしまう: 元の添付が別の会話へ付き、入力欄の本文が別の会話へ送られるため。捨てない: 書いたものを黙って失わないため
  private dropEdit(): void {
    this.editList = null;
    if (this.editing === null) return;
    this.editStash.set(editKey(this.editing), {
      text: this.lastBody,
      files: [...this.draft.list()],
    });
    this.lastBody = '';
    this.editing = null;
    this.draft.clear();
    this.addSystem(
      '編集の書きかけをしまった（会話を移ったので何も送っていない）。元の会話へ戻って同じ発言を /edit すれば続けられる',
    );
  }

  async edit(args: string): Promise<string | null> {
    const ref = args.trim();
    if (/\s/.test(ref)) {
      this.addSystem(
        '使い方: /edit（編集できる発言の一覧）、/edit <番号|id>（編集を始める。本文は入力欄に入る）',
      );
      return null;
    }
    if (ref !== '' && this.editing !== null) {
      this.addSystem(
        '編集の途中。Enter で確定するか、/edit-cancel でやめてから、もう一度 /edit する',
      );
      return null;
    }
    if (this.switching) {
      this.addSystem('会話を開いている最中なので、編集は始められない（開き終わってから）');
      return null;
    }
    const conversationId = this.store.getSnapshot().conversationId;
    if (conversationId === null) {
      this.addSystem('編集できる会話が開いていない（/history で開くか、発言を送ってから）');
      return null;
    }
    if (ref !== '' && this.draft.count > 0) {
      this.addSystem(
        '添えかけのファイルが残っている。先に送るか、/detach all で外してから /edit する',
      );
      return null;
    }
    let read: Awaited<ReturnType<TuiApi['readConversation']>>;
    try {
      read = await this.api.readConversation(conversationId);
    } catch (error) {
      this.addError(messageOf(error));
      return null;
    }
    if (read === null) {
      this.addError(`そんな会話はありません: ${conversationId}`);
      return null;
    }
    // 編集を始めない: 読んでいるあいだに会話が移った・別の編集が始まった・添えかけが足されたため
    if (
      this.store.getSnapshot().conversationId !== conversationId ||
      this.switching ||
      (ref !== '' && (this.editing !== null || this.draft.count > 0))
    ) {
      this.addSystem('読んでいるあいだに状態が変わったので、編集は始めていない（もう一度 /edit）');
      return null;
    }
    const editable = read.messages.filter(
      (m) => m.role === 'inbound' && m.supersededBy === undefined,
    );
    const listing = (): void => {
      this.editList = { conversationId, ids: editable.map((m) => m.id) };
      this.addSystem(
        editable.length === 0
          ? '編集できる発言は無い（自分の発言で、まだ畳まれていないものだけ編集できる）'
          : [
              '編集できる発言（/edit <番号|id> で始める）:',
              ...editable.map(
                (m, i) =>
                  `  [${String(i + 1)}] ${previewOf(m.text)}` +
                  `${(m.attachments?.length ?? 0) > 0 ? `（添付 ${String(m.attachments?.length)} 件）` : ''}`,
              ),
              ...(read.reachedStart ? [] : ['（遡れた範囲だけ。これより古い発言は出ていない）']),
            ].join('\n'),
      );
    };
    if (ref === '') {
      listing();
      return null;
    }
    let id: string | null;
    if (/^\d+$/.test(ref)) {
      if (this.editList === null || this.editList.conversationId !== conversationId) {
        // 番号は一覧の並びを引く: 一覧を見せてからでないと、見ていない番号を指させてしまうため
        listing();
        this.addSystem(`番号は上の一覧の並び。もう一度 /edit ${ref}`);
        return null;
      }
      id = this.editList.ids[Number(ref) - 1] ?? null;
    } else {
      id = ref;
    }
    const target = id === null ? undefined : editable.find((m) => m.id === id);
    if (target === undefined) {
      const known = read.messages.find((m) => m.id === id);
      this.addSystem(
        known?.role === 'outbound'
          ? `[${ref}] はクローンの返答。編集できるのは自分の発言だけ`
          : known?.supersededBy !== undefined
            ? `[${ref}] はもう別の編集に置き換えられている（新しい版は ${known.supersededBy}）`
            : `[${ref}] は、いま開いている会話の編集できる発言にない（/edit で一覧。番号は直前の一覧の並び）`,
      );
      return null;
    }
    this.editing = { id: target.id, conversationId };
    this.editList = null;
    this.lastBody = '';
    const stashed = this.editStash.get(editKey(this.editing));
    const original = target.attachments ?? [];
    if (stashed === undefined) {
      for (const attachment of original) this.draft.addUploaded(attachment);
    } else {
      this.draft.restore(stashed.files);
    }
    this.addSystem(
      [
        `編集を始める（${ref}）`,
        ...(stashed === undefined
          ? []
          : ['会話を移る前の書きかけ（本文と添えかけ）を戻した。続きから直せる']),
        `  元の本文: ${redactBody(target.text)}`,
        ...attachmentLinesOf(original).map((l) => `  ${redactBody(l)}`),
        '元の本文は入力欄に入れた。直して Enter で、置き換えた新しい版を送る（添付が残っていれば、本文を空にして Enter でもよい）。',
        '/detach <番号|all> で添付を外す・/attach <path> で足す（足した分は新しく上げる）・/edit-cancel でやめる',
      ].join('\n'),
    );
    if (stashed !== undefined) return stashed.text;
    // `/` で始まる本文はそのまま入れない: Enter でコマンドとして読まれるため（`//` で始めて、送るとき 1 つ外れるようにする）
    const head = target.text.trimStart();
    return head.startsWith('/') ? `/${head}` : target.text;
  }

  // 添えかけも空にする: 元の添付が次の発言へ残らないように
  cancelEdit(): void {
    if (this.editing === null) {
      this.addSystem('編集は始めていない');
      return;
    }
    if (this.uploading) {
      this.addSystem('やめられない: 添付を上げている最中（上がってから）');
      return;
    }
    this.editStash.delete(editKey(this.editing));
    this.lastBody = '';
    this.editing = null;
    this.draft.clear();
    this.addSystem('編集をやめた（何も送っていない。添えかけも空にした）');
  }

  async attach(args: string): Promise<void> {
    const path = interpretAttachPath(args);
    if (path === '') {
      this.addSystem('使い方: /attach <path>');
      return;
    }
    const added = await this.draft.add(path);
    this.addSystem(
      added.ok
        ? `添えかけ ${this.draft.count} 件（${added.file.name}）。本文を打って送ると一緒に上がる（空行の Enter なら添付だけを送る）`
        : `添えられない: ${added.reason}`,
    );
  }

  hasAttachments(): boolean {
    return this.draft.count > 0;
  }

  listAttachments(): void {
    this.addSystem(this.draft.describe().join('\n'));
  }

  detach(args: string): void {
    if (args.trim() === '') {
      this.addSystem('使い方: /detach <番号|all>');
      return;
    }
    if (this.uploading) {
      this.addSystem('外せない: 添付を上げている最中（上がってから外す）');
      return;
    }
    const removed = this.draft.remove(args);
    this.addSystem(
      removed.ok
        ? `外した: ${removed.removed.map((f) => f.name).join(', ')}（残り ${this.draft.count} 件）`
        : `外せない: ${removed.reason}`,
    );
  }

  // 上げ終えた分は添えかけから外す: 最初のイベントが届くまでの2回目の送信が、同じ添えかけをもう一度送らないように
  private async uploadDraft(): Promise<{
    ids: string[];
    lines: string[];
    files: DraftFile[];
  } | null> {
    if (this.draft.count === 0) return NO_ATTACHMENTS;
    this.uploading = true;
    let result: Awaited<ReturnType<typeof uploadDraft>>;
    try {
      result = await uploadDraft(this.draft, (file) => this.api.uploadAttachment(file));
    } finally {
      this.uploading = false;
    }
    if (!result.ok) {
      this.addError(
        `添付を上げられなかったので送っていない: ${redactError(result.reason)}（添えかけは残してある。/attachments で確認、/detach で外せる）`,
      );
      return null;
    }
    this.draft.discard(result.files);
    return {
      ids: result.uploaded.map((a) => a.id),
      lines: result.uploaded.map(describeAttachment),
      files: result.files,
    };
  }

  private push(kind: LogKind, text: string, approvalId?: string): number {
    this.seq += 1;
    const entry: LogEntry = {
      seq: this.seq,
      kind,
      text,
      ...(approvalId === undefined ? {} : { approvalId }),
    };
    this.store.update((s) => {
      const entries = [...s.entries, entry];
      return {
        ...s,
        entries: this.capEntries(entries),
      };
    });
    return entry.seq;
  }

  // 捨てた件数の断りを先頭に置く: 会話の先頭が途中から始まっているのに、先頭まで読めたように見えないように
  private capEntries(entries: readonly LogEntry[]): LogEntry[] {
    if (entries.length <= MAX_ENTRIES) return [...entries];
    const head = entries[0];
    const hasNotice = head?.dropped !== undefined;
    const body = hasNotice ? entries.slice(1) : entries;
    const keep = body.slice(-(MAX_ENTRIES - 1));
    const dropped = (hasNotice ? (head.dropped ?? 0) : 0) + body.length - keep.length;
    if (!hasNotice) this.seq += 1;
    const notice: LogEntry = {
      seq: hasNotice ? head.seq : this.seq,
      kind: 'system',
      text: `古い側 ${String(dropped)} 件は表示していない（新しい ${String(MAX_ENTRIES - 1)} 件だけを持っている。会話の全文は alteroid conversations show で読める）`,
      dropped,
    };
    return [notice, ...keep];
  }

  private markUnsent(seq: number): void {
    this.store.update((s) => ({
      ...s,
      entries: s.entries.map((e) =>
        e.seq === seq ? { ...e, kind: 'system' as const, text: `送れなかった発言:\n${e.text}` } : e,
      ),
    }));
  }

  addSystem(text: string): void {
    this.push('system', text);
  }

  addError(text: string): void {
    this.push('error', text);
  }

  private pushTurnFailureHint(kind: unknown): void {
    const hint = turnFailureHint(kind);
    if (hint !== null) this.push('system', hint);
  }

  private flushStreaming(): void {
    const text = this.store.getSnapshot().streaming;
    if (text.trim().length > 0) this.push('assistant', text.trim());
    this.store.update((s) => (s.streaming === '' ? s : { ...s, streaming: '' }));
  }

  private set(patch: Partial<ChatState>): void {
    this.store.update((s) => ({ ...s, ...patch }));
  }

  private setAsks(ids: string[]): void {
    this.askIds = ids;
    this.set({ pendingAsk: ids[0] ?? null });
  }

  async nextPendingAsk(): Promise<string | null> {
    const conversationId = this.store.getSnapshot().conversationId;
    if (this.askIds.length === 0 || conversationId === null) return null;
    const read = await this.api.readConversationApprovals(conversationId);
    if (this.store.getSnapshot().conversationId !== conversationId) return null;
    if (read.failure !== undefined) {
      this.addSystem(`承認待ちの状態を確かめられなかった（${read.failure}）。覚えている先頭を開く`);
      return this.askIds[0] ?? null;
    }
    const open = new Set(unansweredIds(read));
    const known = new Set(read.approvals.map((a) => a.id));
    // 答え済みと決めつけず残す: 一覧に無い id は判定できないため
    this.setAsks(this.askIds.filter((id) => open.has(id) || !known.has(id)));
    return this.askIds[0] ?? null;
  }

  // 引けなかったら黙って新しい会話として送らない: 受け取り済みかもしれないため
  private async adoptUnopened(): Promise<boolean> {
    const id = this.unopened;
    if (id === null || this.store.getSnapshot().conversationId !== null) return true;
    if (this.lookingUp) return false;
    this.lookingUp = true;
    try {
      const found = await this.api.findClientMessage(id);
      this.unopened = null;
      if (found !== null) {
        this.set({ conversationId: found });
        this.addSystem(`前の送信は受け取られていた。その会話（${found}）へ送る`);
        // 入力欄から外す: 添付は最初の会話に結び付いて届いており、残すと次の送信で二重に添えるため
        const before = this.draft.count;
        this.draft.discard(this.unopenedFiles);
        const dropped = before - this.draft.count;
        if (dropped > 0) {
          this.addSystem(
            `前の送信に添えていたファイル ${String(dropped)} 件は届いているので、添えかけから外した`,
          );
        }
        this.unopenedFiles = [];
      }
      return true;
    } catch (error) {
      this.addError(
        `前の送信が受け取られたか確かめられなかったので、送っていない（${messageOf(error)}）。もう一度送ると確かめ直す（入力と添えかけは残してある）`,
      );
      return false;
    } finally {
      this.lookingUp = false;
    }
  }

  async send(text: string): Promise<boolean> {
    if (text.length === 0 && this.draft.count === 0) {
      if (this.editing !== null) this.addSystem(EDIT_EMPTY_MESSAGE);
      return true;
    }
    if (this.uploading) {
      this.addSystem('添付を上げている最中なので、送っていない（上がってからもう一度送る）');
      return false;
    }
    if (this.switching) {
      this.addSystem(
        '会話を開いている最中なので、送っていない（開き終わってからもう一度送る。入力は残してある）',
      );
      return false;
    }
    if (this.store.getSnapshot().busy) return this.followUp(text);
    return this.sendTurn(text, null);
  }

  private async sendTurn(
    text: string,
    uploaded: { ids: string[]; lines: string[]; files: DraftFile[] } | null,
  ): Promise<boolean> {
    // 戻り接続を残さない: 自分のターンを始めるなら要らず、二重に流れるため
    this.stopWatch();
    // 覚えが無いときは待たずに進む: 送信の前に非同期の隙間を作らないため
    if (this.unopened !== null && !(await this.adoptUnopened())) {
      if (uploaded !== null) this.draft.restore(uploaded.files);
      return false;
    }
    const attached =
      uploaded ?? (this.draft.count === 0 ? NO_ATTACHMENTS : await this.uploadDraft());
    if (attached === null) return false;
    const edit = this.editing;
    const userSeq = this.push(
      'user',
      [...(edit === null ? [] : ['（編集）']), text, ...attached.lines]
        .filter((l) => l !== '')
        .join('\n'),
    );
    this.set({ busy: true, transient: '考えている…' });
    const abort = new AbortController();
    this.abort = abort;
    const opened = deferred<string>();
    this.opened = opened;
    const reply = new ReplyOutcome();
    const clientMessageId = randomUUID();
    const conversationId =
      edit === null ? this.store.getSnapshot().conversationId : edit.conversationId;
    let rejected = false;
    let closedQuietly = false;
    try {
      for await (const event of this.api.chat(
        {
          text,
          ...(conversationId === null ? {} : { conversationId }),
          ...(edit === null ? {} : { supersedes: edit.id }),
          ...(attached.ids.length === 0 ? {} : { attachments: attached.ids }),
          clientMessageId,
        },
        abort.signal,
      )) {
        reply.see(event);
        this.onEvent(event, opened);
      }
      closedQuietly = !reply.ended && !abort.signal.aborted;
    } catch (error) {
      if (error instanceof AttachmentMissingError) {
        rejected = true;
        this.addError(`${expireUploads(attached.files, error.message)}（${messageOf(error)}）`);
      } else if (!abort.signal.aborted) {
        if (error instanceof NotDeliveredError && !reply.sawEvent) rejected = true;
        this.addError(messageOf(error));
      }
    } finally {
      if (!reply.sawEvent) this.draft.restore(attached.files);
      if (edit !== null && reply.sawEvent) this.editStash.delete(editKey(edit));
      if (edit !== null && reply.sawEvent && this.editing === edit) this.editing = null;
      this.flushStreaming();
      opened.reject(new Error('会話が始まらないまま接続が終わったので、続きを送れなかった'));
      this.set({ busy: false, transient: null });
      if (this.abort === abort) this.abort = null;
      if (this.opened === opened) this.opened = null;
      if (conversationId === null && reply.conversationId === null && !rejected) {
        this.unopened = clientMessageId;
        this.unopenedFiles = attached.files;
      }
    }
    if (closedQuietly) this.addSystem(closedQuietlyNotice(reply.sawEvent));
    if (rejected) {
      this.markUnsent(userSeq);
      return false;
    }
    if (reply.displayed && !abort.signal.aborted) await this.markReplyRead(reply.conversationId);
    return true;
  }

  private async markReplyRead(conversationId: string | null): Promise<void> {
    const id = conversationId ?? this.store.getSnapshot().conversationId;
    if (id === null) return;
    try {
      const read = await this.api.readConversation(id);
      if (read === null) return;
      await this.markRead(id, read.messages);
    } catch (error) {
      this.reportReadFailure(error);
    }
  }

  private async markRead(conversationId: string, messages: ConversationMessage[]): Promise<void> {
    const latest = messages[messages.length - 1];
    if (latest === undefined) return;
    if (this.markedThrough.get(conversationId) === latest.id) return;
    this.markedThrough.set(conversationId, latest.id);
    try {
      await this.api.markConversationRead(conversationId, latest.id);
    } catch (error) {
      this.markedThrough.delete(conversationId);
      this.reportReadFailure(error);
    }
  }

  private reportReadFailure(error: unknown): void {
    this.addSystem(`この会話を既読にできなかった（${messageOf(error)}）`);
  }

  private onEvent(event: ChatEvent, opened: Deferred<string>): void {
    switch (event.type) {
      case 'open':
        this.set({ conversationId: event.conversationId });
        opened.resolve(event.conversationId);
        break;
      case 'queued':
        this.set({ transient: '順番を待っている…' });
        break;
      case 'thinking':
        this.set({ transient: '考えている…' });
        break;
      case 'tool':
        this.flushStreaming();
        this.push('tool', event.tool);
        this.set({ transient: `${event.tool} を実行中…` });
        break;
      case 'text':
        this.store.update((s) => ({
          ...s,
          streaming: redactBody(s.streaming + event.text),
          transient: null,
        }));
        break;
      case 'ask_human':
        this.flushStreaming();
        // 読み返しが同じ承認をすでに出していれば二重に出さない: 再生された `ask_human` が重なるため
        if (!this.store.getSnapshot().entries.some((e) => e.approvalId === event.approvalId)) {
          this.push(
            'ask',
            `確認したいことがある（承認待ち ${event.approvalId}）: ${redactBody(event.question)}\n` +
              `答えるには、Esc のあと a（承認待ちの詳細が開く）か /approvals ${event.approvalId}。` +
              `alteroid chat の /answer ${event.approvalId} <回答>、Web の承認待ちの画面からも答えられる`,
            event.approvalId,
          );
        }
        this.setAsks([...this.askIds.filter((id) => id !== event.approvalId), event.approvalId]);
        break;
      case 'attachments':
        this.flushStreaming();
        this.push(
          'system',
          event.attachments
            .map(
              (item) =>
                `${redactBody(describeAttachment(item))}\n  alteroid attachments get ${item.id} で取り出せます`,
            )
            .join('\n'),
        );
        break;
      case 'usage_limited':
        this.flushStreaming();
        // 文言を要約しない: 人間が検索できる形を保つため
        this.push(
          'system',
          `${redactError(event.message)}\n（この発言は保持されていて、次に枠が開いたときに配り直されて試し直される）`,
        );
        break;
      case 'error':
        this.flushStreaming();
        this.push('error', redactError(event.message));
        this.pushTurnFailureHint(event.kind);
        break;
      case 'done':
        this.flushStreaming();
        this.set({ transient: null });
        break;
    }
  }

  private async followUp(text: string): Promise<boolean> {
    const attached = this.draft.count === 0 ? NO_ATTACHMENTS : await this.uploadDraft();
    if (attached === null) return false;
    const opened = this.opened;
    if (opened === null && attached.files.length > 0 && !this.store.getSnapshot().busy) {
      return this.sendTurn(text, attached);
    }
    const edit = this.editing;
    const userSeq = this.push(
      'user',
      [...(edit === null ? [] : ['（編集）']), text, ...attached.lines]
        .filter((l) => l !== '')
        .join('\n'),
    );
    const clientMessageId = randomUUID();
    // 接続が途中で切れた場合は送り直さない: 受け取られたか分からないため
    let posted = false;
    let sawEvent = false;
    let rejected = false;
    try {
      if (opened === null) throw new Error('会話が始まっていないので、続きを送れなかった');
      const running = await opened.promise;
      const conversationId = edit === null ? running : edit.conversationId;
      const abort = new AbortController();
      posted = true;
      try {
        for await (const event of this.api.chat(
          {
            text,
            conversationId,
            ...(edit === null ? {} : { supersedes: edit.id }),
            ...(attached.ids.length === 0 ? {} : { attachments: attached.ids }),
            clientMessageId,
          },
          abort.signal,
        )) {
          sawEvent = true;
          if (event.type === 'open') break;
        }
      } finally {
        abort.abort();
      }
    } catch (error) {
      rejected =
        !sawEvent &&
        (!posted || error instanceof AttachmentMissingError || error instanceof NotDeliveredError);
      this.addError(
        error instanceof AttachmentMissingError
          ? `${expireUploads(attached.files, error.message)}（${messageOf(error)}）`
          : messageOf(error),
      );
    }
    if (!sawEvent) this.draft.restore(attached.files);
    if (edit !== null && sawEvent) this.editStash.delete(editKey(edit));
    if (edit !== null && sawEvent && this.editing === edit) this.editing = null;
    if (rejected) this.markUnsent(userSeq);
    return !rejected;
  }

  async interrupt(): Promise<{ readonly ok: boolean; readonly text: string }> {
    try {
      const text = await this.api.interrupt();
      this.addSystem(text);
      return { ok: true, text };
    } catch (error) {
      const text = messageOf(error);
      this.addError(text);
      return { ok: false, text };
    }
  }

  newConversation(): boolean {
    if (this.refuseWhileBusy()) return false;
    this.stopWatch();
    this.unopened = null;
    this.askIds = [];
    this.store.update(() => ({ ...initialChatState }));
    this.addSystem('新しい会話を始めた');
    this.dropEdit();
    return true;
  }

  async endConversation(): Promise<void> {
    if (this.refuseWhileBusy('応答中は会話を終えられない（Ctrl+C で止めてから /end）')) return;
    const id = this.store.getSnapshot().conversationId;
    if (id === null) {
      this.addSystem('終える会話がまだ無い');
      return;
    }
    try {
      await this.api.endConversation(id);
    } catch (error) {
      this.addError(messageOf(error));
      return;
    }
    this.stopWatch();
    this.unopened = null;
    this.askIds = [];
    this.store.update(() => ({ ...initialChatState }));
    this.addSystem('会話を終えた（学びを記憶へ蒸留している）。次の発言から新しい会話になる');
    this.dropEdit();
  }

  // ログへ積まない: 終了後は ink の描画が畳まれ、代替画面が捨てられるため
  shutdownFailure: string | null = null;

  async shutdown(): Promise<void> {
    this.abort?.abort();
    this.stopWatch();
    const id = this.store.getSnapshot().conversationId;
    if (id === null) return;
    try {
      await this.api.endConversation(id);
    } catch (error) {
      this.shutdownFailure =
        `会話 ${id} を終えられませんでした（${messageOf(error)}）。会話は終わっておらず、学びの蒸留も走っていません。` +
        'あとで Web の会話画面の「会話を終える」か、alteroid tui の /conversations から開き直して /end で終えられます';
    }
  }

  async listConversations(cursor?: string): Promise<{
    items: ConversationSummary[];
    at: number;
    scanned: number;
    reachedStart: boolean;
    hiddenByLimit: number;
    nextCursor?: string;
  }> {
    const { conversations, scanned, reachedStart, hiddenByLimit, nextCursor } =
      await this.api.listConversations(cursor);
    return {
      items: conversations,
      at: Date.now(),
      scanned,
      reachedStart,
      hiddenByLimit,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async openConversation(id: string): Promise<boolean> {
    if (this.refuseWhileBusy()) return false;
    if (this.refuseWhileSwitching()) return false;
    this.switching = true;
    try {
      return await this.openLocked(id);
    } finally {
      this.switching = false;
    }
  }

  private refuseWhileSwitching(): boolean {
    if (!this.switching) return false;
    this.addSystem('会話を開いている最中なので、別の会話は開けない（開き終わってから）');
    return true;
  }

  private async openLocked(id: string): Promise<boolean> {
    let read;
    try {
      read = await this.api.readConversation(id);
    } catch (error) {
      this.addError(messageOf(error));
      return false;
    }
    if (read === null) {
      this.addError(`そんな会話はありません: ${id}`);
      return false;
    }
    // 空の会話として開かない: 窓が先頭に届いていない空は判定できず、続きを送ると別の会話の続きとして話してしまうため
    if (!read.reachedStart && read.messages.length === 0) {
      this.addError(
        `会話 ${id} は判定できない（日誌の遡れた範囲に発言が無い。窓の外にあるかもしれない）`,
      );
      return false;
    }
    const approvalsRead = await this.api.readConversationApprovals(id);
    const entries = this.historyEntries(read.messages, approvalsRead);
    this.stopWatch();
    this.unopened = null;
    this.store.update(() => ({
      ...initialChatState,
      conversationId: id,
      entries: this.capEntries(entries),
    }));
    this.setAsks(unansweredIds(approvalsRead));
    this.dropEdit();
    this.switching = false;
    if (!read.reachedStart) {
      this.addSystem(
        '遡れた範囲だけを出している。これより古い発言は窓の外に残っているかもしれない',
      );
    }
    this.resume(id);
    await this.markRead(id, read.messages);
    return true;
  }

  // 会話ごとに stream を張って `open.inProgress` だけ読む: 進行中の会話の一覧を返す口が daemon に無いため
  async resumeConversation(id?: string): Promise<boolean> {
    const state = this.store.getSnapshot();
    if (state.busy && this.watch !== null && (id === undefined || id === state.conversationId)) {
      this.addSystem('すでにこの会話の進行中のターンを表示している');
      return true;
    }
    if (this.refuseWhileBusy()) return false;
    if (this.refuseWhileSwitching()) return false;
    this.switching = true;
    try {
      return await this.resumeLocked(id);
    } finally {
      this.switching = false;
    }
  }

  private async resumeLocked(id?: string): Promise<boolean> {
    let candidates: string[];
    if (id !== undefined) {
      candidates = [id];
    } else {
      try {
        const { conversations } = await this.api.listConversations();
        candidates = conversations.slice(0, RESUME_PROBE_LIMIT).map((c) => c.conversationId);
      } catch (error) {
        this.addError(messageOf(error));
        return false;
      }
    }
    for (const candidate of candidates) {
      let inProgress: boolean;
      try {
        inProgress = await this.probeInProgress(candidate);
      } catch (error) {
        this.addError(messageOf(error));
        return false;
      }
      if (inProgress) return this.openLocked(candidate);
    }
    this.addSystem(
      id === undefined
        ? '進行中の会話は無い（/history で履歴から開ける）'
        : `会話 ${id} に進行中のターンは無い（/history で履歴から開ける）`,
    );
    return false;
  }

  private async probeInProgress(conversationId: string): Promise<boolean> {
    const abort = new AbortController();
    try {
      for await (const event of this.api.chatStream(conversationId, abort.signal)) {
        if (event.type === 'open') return event.inProgress === true;
      }
      return false;
    } finally {
      abort.abort();
    }
  }

  private historyEntries(
    messages: ConversationMessage[],
    approvals: ConversationApprovalsRead,
  ): LogEntry[] {
    const entries: LogEntry[] = interleaveApprovals(messages, approvals.approvals).flatMap(
      (item): LogEntry[] => {
        this.seq += 1;
        if (item.kind === 'approval') {
          return [
            {
              seq: this.seq,
              kind: 'ask',
              text: approvalText(item.approval),
              approvalId: item.approval.id,
            },
          ];
        }
        const m = item.message;
        const entry: LogEntry = {
          seq: this.seq,
          kind: m.role === 'inbound' ? 'user' : 'assistant',
          text: redactBody([m.text, ...attachmentLinesOf(m.attachments)].join('\n')),
        };
        // 失敗ターンだけ種別を読む: 失敗でない発言に種別は付かないため
        const hint = m.turnFailure === undefined ? null : turnFailureHint(m.turnFailureKind);
        if (hint === null) return [entry];
        this.seq += 1;
        return [entry, { seq: this.seq, kind: 'system', text: hint }];
      },
    );
    for (const notice of approvalNoticeLines(approvals)) {
      this.seq += 1;
      entries.push({ seq: this.seq, kind: 'system', text: notice });
    }
    return this.capEntries(entries);
  }

  // 履歴を 1 回だけ読み直して差し替える: 読んでから戻り接続の `open` までの間に終わったターンの返信が、日誌には載っているのに画面には無いため
  private async refreshHistory(conversationId: string, abort: AbortController): Promise<void> {
    try {
      const read = await this.api.readConversation(conversationId);
      if (abort.signal.aborted || read === null) return;
      if (!read.reachedStart && read.messages.length === 0) return;
      const approvalsRead = await this.api.readConversationApprovals(conversationId);
      const entries = this.historyEntries(read.messages, approvalsRead);
      if (abort.signal.aborted) return;
      this.store.update((s) => (s.conversationId === conversationId ? { ...s, entries } : s));
      if (
        this.store.getSnapshot().conversationId === conversationId &&
        approvalsRead.failure === undefined
      ) {
        this.setAsks(unansweredIds(approvalsRead));
      }
      if (!read.reachedStart) {
        this.addSystem(
          '遡れた範囲だけを出している。これより古い発言は窓の外に残っているかもしれない',
        );
      }
      if (this.store.getSnapshot().conversationId === conversationId) {
        await this.markRead(conversationId, read.messages);
      }
    } catch (error) {
      if (!abort.signal.aborted) this.addError(messageOf(error));
    }
  }

  private stopWatch(): void {
    this.watch?.abort();
    this.watch = null;
  }

  private resume(conversationId: string): void {
    const abort = new AbortController();
    this.watch = abort;
    void this.runWatch(conversationId, abort);
  }

  private async runWatch(conversationId: string, abort: AbortController): Promise<void> {
    const live = () => !abort.signal.aborted;
    const opened = deferred<string>();
    opened.resolve(conversationId);
    let active = false;
    let refresh = false;
    const reply = new ReplyOutcome();
    try {
      for await (const event of this.api.chatStream(conversationId, abort.signal)) {
        if (!live()) break;
        if (active) reply.see(event);
        if (event.type === 'open') {
          if (event.inProgress !== true) {
            refresh = true;
            break;
          }
          active = true;
          this.opened = opened;
          this.set({ busy: true, transient: '考えている…' });
          continue;
        }
        if (active) this.onEvent(event, opened);
      }
      if (refresh && live()) await this.refreshHistory(conversationId, abort);
      if (active && !reply.ended && live()) this.addSystem(closedQuietlyNotice(true));
      if (active && reply.displayed && live()) await this.markReplyRead(conversationId);
    } catch (error) {
      if (live()) this.addError(messageOf(error));
    } finally {
      // 状態に触らない: 切り替え・終了で止めたときは、もう呼んだ側のもののため
      if (active && live()) {
        this.flushStreaming();
        this.set({ busy: false, transient: null });
      }
      if (this.opened === opened) this.opened = null;
      if (this.watch === abort) this.watch = null;
    }
  }

  private refuseWhileBusy(
    notice = '応答中は会話を切り替えられない（Ctrl+C で止めてから）',
  ): boolean {
    // 戻り接続だけで立った busy は切り替えを止めない: 切り替えが接続を abort するため
    if (!this.store.getSnapshot().busy || this.watch !== null) return false;
    this.addSystem(notice);
    return true;
  }
}

/**
 * 会話の画面の状態と操作（React を持たない）。`POST /chat` の SSE を受けて
 * ログ・応答の途中経過・「考えている…」を `Store` へ反映する。
 *
 * **Web（`apps/web/app/routes/chat.tsx` の `send` / `followUp`）と同じ body・同じ扱い**に
 * 揃えてある:
 * - 送るのは `{ text, conversationId }` だけ。新しい会話は `open` で決まった id を以後
 *   引き継ぐ。
 * - 応答中の追送は、その会話へ投函して `open` を見たところで受信をやめる（応答は
 *   走っている側のストリームに流れてくる）。新しい会話で id が未確定なら `open` を待つ。
 * - 送ると決めた瞬間から「考えている…」を出す（サーバの `thinking` を待たない。
 *   先客のターンが走っている間は `thinking` が来ない）。`queued` が来たら「順番を待っている…」
 *   へ、`thinking` が来たら戻す。
 * - `ask_human` / `usage_limited` / `error` は一時表示ではなくログに残る行にする。
 * - 履歴から開いた会話のターンが進行中なら、`GET /chat/:id/stream` に戻って途中経過
 *   （考えている…・ここまでの文章）を出し、続きを流す（Issue #2652）。送信と同じ `onEvent` を
 *   共有し、その間は `busy` で、発言は追送になる。
 */
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
import { Store } from './store.js';

export interface ChatState {
  readonly conversationId: string | null;
  readonly entries: readonly LogEntry[];
  /** いま流れてきている応答の本文（確定前。確定するとエントリになる）。 */
  readonly streaming: string;
  /** 自分のターンが走っているか（送信から `done` / 失敗まで）。 */
  readonly busy: boolean;
  /** 「考えている…」などの進行中の合図。 */
  readonly transient: string | null;
  /** この会話で最後に来た `ask_human` の承認待ち id（会話の画面で `a` を押すと承認待ちの詳細が開く）。 */
  readonly pendingAsk: string | null;
}

/** ログに残す最大件数。超えた古い側は捨てる（長く開いておいても膨らまない）。 */
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

/** 添えかけが無いときの結果（待たずに同期で進める。送信の前に非同期の隙間を作らない）。 */
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

/**
 * `done` も `error` も無いまま接続が閉じたときの 1 行（例外で切れたときは別の文を出す）。出ているのは受け取った分だけ。
 * 1 つもイベントが来ていなければ、受け取られたかも分からない。
 */
function closedQuietlyNotice(sawEvent: boolean): string {
  return sawEvent
    ? '応答が途中で切れた（done も error も来ないまま接続が閉じた）。出ているのは受け取った分だけ'
    : '応答が来ないまま接続が閉じた。発言が受け取られたかは分からない（次の送信の前に確かめ直す）';
}

/** `/resume`（id 無し）が進行中かを確かめに行く会話の数（履歴の新しい順）。 */
export const RESUME_PROBE_LIMIT = 5;

/**
 * 1 本の受信で返答が最後まで画面に出たか。`done` が来て、`error` / `usage_limited`（返答が出ていない）が
 * 無かったときだけ真。完了前に離れた・接続が切れた場合は `done` が来ないので偽（未読のまま残る）。
 */
class ReplyOutcome {
  conversationId: string | null = null;
  private done = false;
  private failed = false;
  /** 1 つでもイベントが来たか。 */
  sawEvent = false;

  see(event: ChatEvent): void {
    this.sawEvent = true;
    if (event.type === 'open') this.conversationId = event.conversationId;
    else if (event.type === 'done') this.done = true;
    else if (event.type === 'error' || event.type === 'usage_limited') this.failed = true;
  }

  /** 終端（`done` / `error` / `usage_limited`）が来たか。無いまま閉じたら、途中で切れている。 */
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
  /** 走っているストリームの `open`（会話 id の確定）。 */
  private opened: Deferred<string> | null = null;
  /** 履歴から開いた会話の進行中のターンに戻っている接続（無ければ `null`）。自分の送信とは別。 */
  private watch: AbortController | null = null;

  /** 次に送る発言へ添えかけのファイル（`/attach`）。 */
  private readonly draft = new AttachmentDraft(() => this.api.attachmentLimits());
  /** 添えかけを上げている最中か（Web の `uploading` と同じ。2回目の送信と `/detach` を止める。#3558）。 */
  private uploading = false;
  /**
   * 新しい会話（`conversationId` 無し）で `open` の前に終わった送信の `clientMessageId`（#3304）。受け取られたか
   * 分からないので、次の送信の前に `GET /client-messages/:id` で引き、受け取り済みならその会話へ送る
   * （添付が最初の会話に結び付いたまま新しい会話として送ると `attachment_conflict` になる）。
   */
  private unopened: string | null = null;
  /** {@link unopened} を引いている最中か（二重に引かない）。 */
  private lookingUp = false;
  /** 会話ごとに、最後に既読の要求を送った発言の id。 */
  private readonly markedThrough = new Map<string, string>();

  constructor(private readonly api: TuiApi) {}

  /** `/attach <path>`。 */
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

  /** 添えかけがあるか（空の入力欄の Enter で添付だけを送れるか）。 */
  hasAttachments(): boolean {
    return this.draft.count > 0;
  }

  /** `/attachments`。 */
  listAttachments(): void {
    this.addSystem(this.draft.describe().join('\n'));
  }

  /** `/detach <番号|all>`。 */
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

  /**
   * 添えかけを上げて、id を返す（無ければ空配列）。**失敗したら `null`**（送らない。添えかけは残す）。
   * 上げ終えた分（`files`）は、その時点で添えかけから外して「送り中」にする（上げ終えてから最初のイベントが
   * 届くまでの2回目の送信が、同じ添えかけをもう一度送らないように。#3588）。サーバが受けなかったら
   * `draft.restore` で戻す（上げ済みの印は残る。#3245・#3246）。待つあいだに足された分は元から対象外（#3245）。
   */
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

  /** ログに 1 件足す。 */
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

  /**
   * ログを {@link MAX_ENTRIES} 件に収める。古い側を捨てるときは、先頭に捨てた件数の断りを1行置く（累計。
   * 会話の先頭が途中から始まっているのに、先頭まで読めたように見えないように。#3409）。
   */
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

  /**
   * 送れなかった発言の行を、送ったように見える `user` から `system` の断りへ差し替える（文は残す）。
   * 文そのものは、呼び手が入力欄へ戻す（Web の #3064 と同じ）。
   */
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

  /** 流れてきた本文を確定してエントリにする。 */
  private flushStreaming(): void {
    const text = this.store.getSnapshot().streaming;
    if (text.trim().length > 0) this.push('assistant', text.trim());
    this.store.update((s) => (s.streaming === '' ? s : { ...s, streaming: '' }));
  }

  private set(patch: Partial<ChatState>): void {
    this.store.update((s) => ({ ...s, ...patch }));
  }

  /**
   * 前の送信（新しい会話で `open` の前に終わったもの）が受け取られていたか引き、受け取り済みならその会話を
   * 「いまの会話」にする（404 なら覚えを捨てて新しい会話のまま）。**引けなかったら `false`**（黙って新しい会話として
   * 送らない。理由と、もう一度送ると引き直すことを出す）。
   */
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

  /**
   * 発言を送る。応答中なら追送になる。**`false` は送らなかった印**（前の送信を引けなかった）で、呼び手は
   * 入力を入力欄へ戻す。
   */
  async send(text: string): Promise<boolean> {
    if (text.length === 0 && this.draft.count === 0) return true;
    if (this.uploading) {
      this.addSystem('添付を上げている最中なので、送っていない（上がってからもう一度送る）');
      return false;
    }
    if (this.store.getSnapshot().busy) return this.followUp(text);
    return this.sendTurn(text, null);
  }

  /**
   * 通常の送信の本体。`uploaded` が `null` なら、ここで添えかけを上げる。**上げ済みの分を渡されたら、それだけを送る**
   * （追送からの切り替え。上げているあいだに足された分は、生きた添えかけに残して次の発言のために取っておく。#3632）。
   */
  private async sendTurn(
    text: string,
    uploaded: { ids: string[]; lines: string[]; files: DraftFile[] } | null,
  ): Promise<boolean> {
    // まだ `open` が来ていない戻り接続があっても、自分のターンを始めるなら要らない（二重に流れる）。
    this.stopWatch();
    // 覚えが無いときは待たずに進む（送信の前に非同期の隙間を作らない）。
    if (this.unopened !== null && !(await this.adoptUnopened())) {
      if (uploaded !== null) this.draft.restore(uploaded.files); // 送っていない。上げ済みの分は戻す
      return false;
    }
    const attached =
      uploaded ?? (this.draft.count === 0 ? NO_ATTACHMENTS : await this.uploadDraft());
    if (attached === null) return false; // 送っていない（呼び手は文を入力欄へ戻す。#3589）
    const userSeq = this.push('user', [text, ...attached.lines].filter((l) => l !== '').join('\n'));
    this.set({ busy: true, transient: '考えている…' });
    const abort = new AbortController();
    this.abort = abort;
    const opened = deferred<string>();
    this.opened = opened;
    // 返答が最後まで画面に出たか。出たなら会話を既読にする（`docs/architecture.md`「会話の既読」）。
    const reply = new ReplyOutcome();
    const clientMessageId = randomUUID();
    const conversationId = this.store.getSnapshot().conversationId;
    let rejected = false;
    let closedQuietly = false;
    try {
      for await (const event of this.api.chat(
        {
          text,
          ...(conversationId === null ? {} : { conversationId }),
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
        rejected = true; // サーバは発言を受けていない
        this.addError(`${expireUploads(attached.files, error.message)}（${messageOf(error)}）`);
      } else if (!abort.signal.aborted) {
        // 繋がらない・非 ok の応答で、イベントが 1 つも来ていない: サーバは発言を受けていない。
        if (error instanceof NotDeliveredError && !reply.sawEvent) rejected = true;
        this.addError(messageOf(error));
      }
    } finally {
      // イベントが 1 つも来ていない: サーバが発言を受けたか分からない（受けていない）ので、添えかけを戻す。
      if (!reply.sawEvent) this.draft.restore(attached.files);
      this.flushStreaming();
      opened.reject(new Error('会話が始まらないまま接続が終わったので、続きを送れなかった'));
      this.set({ busy: false, transient: null });
      if (this.abort === abort) this.abort = null;
      if (this.opened === opened) this.opened = null;
      // 新しい会話で `open` の前に終わった（受信をやめた・接続が切れた）なら、受け取られたか分からない。
      // 次の送信の前に、この id で会話を引き直す（#3304）。
      if (conversationId === null && reply.conversationId === null && !rejected) {
        this.unopened = clientMessageId;
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

  /**
   * 返答が日誌に載った後の会話を読み直し、最後の発言まで既読にする（Web の `useMarkConversationRead` と
   * 同じ: SSE は発言の id を運ばないので、取り直した詳細の最後の発言を `through` にする）。
   */
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

  /** 表示した発言の最後（`messages` は古い順）まで既読にする。失敗しても会話は奪わず、1行だけ残す。 */
  private async markRead(conversationId: string, messages: ConversationMessage[]): Promise<void> {
    const latest = messages[messages.length - 1];
    if (latest === undefined) return;
    // 同じ位置を重ねて送らない（Web の `useMarkConversationRead` と同じ。失敗したら覚えを外して次に送り直す）。
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
        // 答える画面は承認待ちのタブ。id と質問を残し、そこへ飛ぶ口（`a`・`/approvals <id>`）を案内する。
        // 既存 CLI の `/answer <id> <回答>` と Web の承認待ちの画面からも答えられる。
        // 読み返し（履歴から開いた会話）が同じ承認をすでに出していれば、再生された `ask_human` で二重に出さない（#3408）。
        if (!this.store.getSnapshot().entries.some((e) => e.approvalId === event.approvalId)) {
          this.push(
            'ask',
            `確認したいことがある（承認待ち ${event.approvalId}）: ${redactBody(event.question)}\n` +
              `答えるには、Esc のあと a（承認待ちの詳細が開く）か /approvals ${event.approvalId}。` +
              `alteroid chat の /answer ${event.approvalId} <回答>、Web の承認待ちの画面からも答えられる`,
            event.approvalId,
          );
        }
        this.set({ pendingAsk: event.approvalId });
        break;
      case 'usage_limited':
        this.flushStreaming();
        // 文言は要約しない（人間が検索できる形を保つ）。発言は捨てられていないことを添える。
        this.push(
          'system',
          `${redactError(event.message)}\n（この発言は保持されていて、次に枠が開いたときに配り直されて試し直される）`,
        );
        break;
      case 'error':
        this.flushStreaming();
        this.push('error', redactError(event.message));
        break;
      case 'done':
        this.flushStreaming();
        this.set({ transient: null });
        break;
    }
  }

  /** 追送。**`false` は送らなかった（サーバが受け取っていない）印**で、呼び手は文を入力欄へ戻す。 */
  private async followUp(text: string): Promise<boolean> {
    const attached = this.draft.count === 0 ? NO_ATTACHMENTS : await this.uploadDraft();
    if (attached === null) return false; // 送っていない（呼び手は文を入力欄へ戻す。#3589）
    // 添付を上げているあいだに走っていたターンが終わったなら、追送ではなく通常の送信として送る（会話は始まっている。
    // 上げ済みの分だけを送る。上げているあいだに `/attach` で足された分は添えかけに残す。#3632）。
    // 添付の無い追送は同期で読むので、この形にならない。
    const opened = this.opened;
    if (opened === null && attached.files.length > 0 && !this.store.getSnapshot().busy) {
      return this.sendTurn(text, attached);
    }
    const userSeq = this.push('user', [text, ...attached.lines].filter((l) => l !== '').join('\n'));
    // 送るたびに付ける（#3203・#3304。通常の送信と同じ）。会話は `open` で決まってから送るので、
    // 通常の送信の `unopened`（会話が決まる前に終わった送信の取り直し）は要らない。
    const clientMessageId = randomUUID();
    // 受け取られていないと言えるのは、投函に着く前（会話が決まらなかった）と、投函して 1 つもイベントが来ないうちの
    // 繋がらない・非 ok の応答。接続が途中で切れた場合は、受け取られたか分からない（送り直さない）。
    let posted = false;
    let sawEvent = false;
    let rejected = false;
    try {
      if (opened === null) throw new Error('会話が始まっていないので、続きを送れなかった');
      const conversationId = await opened.promise;
      const abort = new AbortController();
      posted = true;
      try {
        for await (const event of this.api.chat(
          {
            text,
            conversationId,
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
    if (rejected) this.markUnsent(userSeq);
    return !rejected;
  }

  /** Ctrl+C / `/interrupt`: 走っているクローンのターンを止める。 */
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

  /** 新しい会話へ切り替える（今の会話は終えない）。応答中は切り替えない。 */
  newConversation(): boolean {
    if (this.refuseWhileBusy()) return false;
    this.stopWatch();
    this.unopened = null;
    this.store.update(() => ({ ...initialChatState }));
    this.addSystem('新しい会話を始めた');
    return true;
  }

  /** 今の会話を終える（蒸留の契機）。 */
  async endConversation(): Promise<void> {
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
    this.store.update(() => ({ ...initialChatState }));
    this.addSystem('会話を終えた（学びを記憶へ蒸留している）。次の発言から新しい会話になる');
  }

  /**
   * `shutdown` で会話を終えられなかったときの断り（成功・会話なしなら `null`）。終了後は ink の
   * 描画が畳まれる（代替画面は捨てられる）ので、ログへは積まず、呼び出し側が画面を戻した後に
   * 端末へ書く（`main.tsx` の `runApp`）。
   */
  shutdownFailure: string | null = null;

  /** 終了前の後始末: 受信をやめ、会話があれば終える（既存 CLI の chat と同じ）。 */
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

  /** 履歴の一覧。`at` は読んだ時刻（「何分前」の基準）。`cursor` は「もっと見る」の続きの頁（#3643）。 */
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

  /** 履歴の会話を開き直す。 */
  async openConversation(id: string): Promise<boolean> {
    if (this.refuseWhileBusy()) return false;
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
    // 窓が先頭に届いておらず中身も空なのは「無い」ではなく**判定できない**。空の会話として
    // 開かない（続きを送ると、既存の会話ではない別の会話の続きとして話してしまう）。
    if (!read.reachedStart && read.messages.length === 0) {
      this.addError(
        `会話 ${id} は判定できない（日誌の遡れた範囲に発言が無い。窓の外にあるかもしれない）`,
      );
      return false;
    }
    const entries = this.historyEntries(
      read.messages,
      await this.api.readConversationApprovals(id),
    );
    this.stopWatch();
    this.unopened = null;
    this.store.update(() => ({
      ...initialChatState,
      conversationId: id,
      entries: this.capEntries(entries),
    }));
    if (!read.reachedStart) {
      this.addSystem(
        '遡れた範囲だけを出している。これより古い発言は窓の外に残っているかもしれない',
      );
    }
    this.resume(id);
    // 開いて表示した発言は「画面に表示されたとき」に当たる（表示した最後の発言まで既読）。
    await this.markRead(id, read.messages);
    return true;
  }

  /**
   * `/resume [id]`。明示したときだけ、進行中のターンのある会話へ戻る（起動時に自動では戻らない）。
   * `id` があればその会話、無ければ履歴の新しい順に最大 {@link RESUME_PROBE_LIMIT} 件を
   * 見て、最初に進行中だったもの。進行中の会話の一覧を返す口は daemon に無いので、
   * 会話ごとに `GET /chat/:id/stream` を張って `open.inProgress` だけ読む（すぐ閉じる）。
   * 見つかったら {@link openConversation} で開く（履歴を出し、途中経過を再生し、続きを流す）。
   */
  async resumeConversation(id?: string): Promise<boolean> {
    const state = this.store.getSnapshot();
    if (state.busy && this.watch !== null && (id === undefined || id === state.conversationId)) {
      this.addSystem('すでにこの会話の進行中のターンを表示している');
      return true;
    }
    if (this.refuseWhileBusy()) return false;
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
      if (inProgress) return this.openConversation(candidate);
    }
    this.addSystem(
      id === undefined
        ? '進行中の会話は無い（/history で履歴から開ける）'
        : `会話 ${id} に進行中のターンは無い（/history で履歴から開ける）`,
    );
    return false;
  }

  /** `GET /chat/:id/stream` の最初の `open` だけ読み、`inProgress` を返して接続を閉じる。 */
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

  /**
   * 履歴の発言を、その会話のターンから積まれた承認と時刻順に並べて出す（#3261。承認は 'ask' の1行。
   * 取れなかった・読めない行があるときは、最後に 'system' の断りを足す）。
   */
  private historyEntries(
    messages: ConversationMessage[],
    approvals: ConversationApprovalsRead,
  ): LogEntry[] {
    const entries: LogEntry[] = interleaveApprovals(messages, approvals.approvals).map((item) => {
      this.seq += 1;
      if (item.kind === 'approval') {
        return {
          seq: this.seq,
          kind: 'ask',
          text: approvalText(item.approval),
          approvalId: item.approval.id,
        };
      }
      const m = item.message;
      return {
        seq: this.seq,
        kind: m.role === 'inbound' ? 'user' : 'assistant',
        text: redactBody([m.text, ...attachmentLinesOf(m.attachments)].join('\n')),
      };
    });
    for (const notice of approvalNoticeLines(approvals)) {
      this.seq += 1;
      entries.push({ seq: this.seq, kind: 'system', text: notice });
    }
    return this.capEntries(entries);
  }

  /**
   * 戻り接続が `inProgress:false` を返したあと、履歴を 1 回だけ読み直して差し替える。
   * 履歴を読んでから戻り接続の `open` までの間にターンが終わっていたら、その返信は
   * 日誌に載っている（日誌へ書いてから `done` を出す）のに画面には無いため。
   * 読み直しの最中に会話を移った・送信を始めた(= abort された)ら差し替えない。
   */
  private async refreshHistory(conversationId: string, abort: AbortController): Promise<void> {
    try {
      const read = await this.api.readConversation(conversationId);
      if (abort.signal.aborted || read === null) return;
      if (!read.reachedStart && read.messages.length === 0) return;
      const entries = this.historyEntries(
        read.messages,
        await this.api.readConversationApprovals(conversationId),
      );
      if (abort.signal.aborted) return;
      this.store.update((s) => (s.conversationId === conversationId ? { ...s, entries } : s));
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

  /** 戻り接続をやめる（状態は触らない。呼ぶ側が畳む）。 */
  private stopWatch(): void {
    this.watch?.abort();
    this.watch = null;
  }

  /**
   * 開いた会話の進行中のターンに戻る。待たずに返す（接続は背景で読む）。`inProgress` が
   * 偽なら何も出さない。履歴に載る返信は確定済みのターンの分だけで、進行中の分はここで
   * 再生される文章が確定したときに初めてログに入る（二重にならない）。
   */
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
          this.opened = opened; // 応答中の発言は追送になる（`send`）
          this.set({ busy: true, transient: '考えている…' });
          continue;
        }
        if (active) this.onEvent(event, opened);
      }
      if (refresh && live()) await this.refreshHistory(conversationId, abort);
      // 戻って流したターンが、`done` も `error` も無いまま閉じた。
      if (active && !reply.ended && live()) this.addSystem(closedQuietlyNotice(true));
      // 戻って流した進行中のターンの返答が最後まで画面に出たなら、既読にする。
      if (active && reply.displayed && live()) await this.markReplyRead(conversationId);
    } catch (error) {
      if (live()) this.addError(messageOf(error));
    } finally {
      // 切り替え・終了で止めたときは、状態はもう呼んだ側のもの（触らない）。
      if (active && live()) {
        this.flushStreaming();
        this.set({ busy: false, transient: null });
      }
      if (this.opened === opened) this.opened = null;
      if (this.watch === abort) this.watch = null;
    }
  }

  private refuseWhileBusy(): boolean {
    // 戻り接続だけで立った busy は、切り替えを止めない（切り替えは接続を abort する）。
    if (!this.store.getSnapshot().busy || this.watch !== null) return false;
    this.addSystem('応答中は会話を切り替えられない（Ctrl+C で止めてから）');
    return true;
  }
}

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
 */
import type { ChatEvent, ConversationSummary, TuiApi } from './api.js';
import type { LogEntry, LogKind } from './log.js';
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
}

/** ログに残す最大件数。超えた古い側は捨てる（長く開いておいても膨らまない）。 */
export const MAX_ENTRIES = 1_000;

export const initialChatState: ChatState = {
  conversationId: null,
  entries: [],
  streaming: '',
  busy: false,
  transient: null,
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

export class ChatController {
  readonly store = new Store<ChatState>(initialChatState);
  private seq = 0;
  private abort: AbortController | null = null;
  /** 走っているストリームの `open`（会話 id の確定）。 */
  private opened: Deferred<string> | null = null;

  constructor(private readonly api: TuiApi) {}

  /** ログに 1 件足す。 */
  private push(kind: LogKind, text: string): void {
    this.seq += 1;
    const entry: LogEntry = { seq: this.seq, kind, text };
    this.store.update((s) => {
      const entries = [...s.entries, entry];
      return {
        ...s,
        entries: entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries,
      };
    });
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

  /** 発言を送る。応答中なら追送になる。 */
  async send(text: string): Promise<void> {
    if (text.length === 0) return;
    if (this.store.getSnapshot().busy) {
      await this.followUp(text);
      return;
    }
    this.push('user', text);
    this.set({ busy: true, transient: '考えている…' });
    const abort = new AbortController();
    this.abort = abort;
    const opened = deferred<string>();
    this.opened = opened;
    try {
      const conversationId = this.store.getSnapshot().conversationId;
      for await (const event of this.api.chat(
        { text, ...(conversationId === null ? {} : { conversationId }) },
        abort.signal,
      )) {
        this.onEvent(event, opened);
      }
    } catch (error) {
      if (!abort.signal.aborted) this.addError(messageOf(error));
    } finally {
      this.flushStreaming();
      opened.reject(new Error('会話が始まらないまま接続が終わったので、続きを送れなかった'));
      this.set({ busy: false, transient: null });
      if (this.abort === abort) this.abort = null;
      if (this.opened === opened) this.opened = null;
    }
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
        this.store.update((s) => ({ ...s, streaming: s.streaming + event.text, transient: null }));
        break;
      case 'ask_human':
        this.flushStreaming();
        // 答える UI は次の段階。いまは id と質問を残し、答えられる口を案内する
        // （既存 CLI の「/answer <id> <回答> で返せます」と Web の「承認待ちの画面から答えられる」）。
        this.push(
          'ask',
          `確認したいことがある（承認待ち ${event.approvalId}）: ${event.question}\n` +
            `答えるには alteroid chat の /answer ${event.approvalId} <回答>、または Web の承認待ちの画面から`,
        );
        break;
      case 'usage_limited':
        this.flushStreaming();
        // 文言は要約しない（人間が検索できる形を保つ）。発言は捨てられていないことを添える。
        this.push(
          'system',
          `${event.message}\n（この発言は保持されていて、次に枠が開いたときに配り直されて試し直される）`,
        );
        break;
      case 'error':
        this.flushStreaming();
        this.push('error', event.message);
        break;
      case 'done':
        this.flushStreaming();
        this.set({ transient: null });
        break;
    }
  }

  private async followUp(text: string): Promise<void> {
    this.push('user', text);
    const opened = this.opened;
    try {
      if (opened === null) throw new Error('会話が始まっていないので、続きを送れなかった');
      const conversationId = await opened.promise;
      const abort = new AbortController();
      try {
        for await (const event of this.api.chat({ text, conversationId }, abort.signal)) {
          if (event.type === 'open') break;
        }
      } finally {
        abort.abort();
      }
    } catch (error) {
      this.addError(messageOf(error));
    }
  }

  /** Ctrl+C / `/interrupt`: 走っているクローンのターンを止める。 */
  async interrupt(): Promise<void> {
    try {
      this.addSystem(await this.api.interrupt());
    } catch (error) {
      this.addError(messageOf(error));
    }
  }

  /** 新しい会話へ切り替える（今の会話は終えない）。応答中は切り替えない。 */
  newConversation(): boolean {
    if (this.refuseWhileBusy()) return false;
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
    this.store.update(() => ({ ...initialChatState }));
    this.addSystem('会話を終えた（学びを記憶へ蒸留している）。次の発言から新しい会話になる');
  }

  /** 終了前の後始末: 受信をやめ、会話があれば終える（既存 CLI の chat と同じ）。 */
  async shutdown(): Promise<void> {
    this.abort?.abort();
    const id = this.store.getSnapshot().conversationId;
    if (id !== null) await this.api.endConversation(id).catch(() => undefined);
  }

  /** 履歴の一覧。`at` は読んだ時刻（「何分前」の基準）。 */
  async listConversations(): Promise<{ items: ConversationSummary[]; at: number }> {
    const items = await this.api.listConversations();
    return { items, at: Date.now() };
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
    const entries: LogEntry[] = read.messages.map((m) => {
      this.seq += 1;
      return { seq: this.seq, kind: m.role === 'inbound' ? 'user' : 'assistant', text: m.text };
    });
    this.store.update(() => ({
      ...initialChatState,
      conversationId: id,
      entries: entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries,
    }));
    if (!read.reachedStart) {
      this.addSystem(
        '遡れた範囲だけを出している。これより古い発言は窓の外に残っているかもしれない',
      );
    }
    return true;
  }

  private refuseWhileBusy(): boolean {
    if (!this.store.getSnapshot().busy) return false;
    this.addSystem('応答中は会話を切り替えられない（Ctrl+C で止めてから）');
    return true;
  }
}

import { Inbox } from './inbox.js';
import { CloneRedeliveryState } from './clone-redelivery-state.js';
import type { CommitOutcome, Listener } from './clone.js';
import type { InboxEvent } from './schema.js';

type PendingTokenPoolNotice = { id: string; at: string; key: string; folded: number };

type PendingCollapseEntry = { readonly id: string; readonly at: string; collapsed: number };

export class CloneDelivery {
  readonly inbox = new Inbox();
  readonly redeliveryState = new CloneRedeliveryState();

  readonly #listeners = new Map<string, Set<Listener>>();

  subscribeListener(conversationId: string, listener: Listener): Set<Listener> {
    const set = this.#listeners.get(conversationId) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(conversationId, set);
    return set;
  }

  // `set` の同一性を見る: 別の購読が同じ conversationId で新しい `Set` を作り直した後は、空でも消さないため
  unsubscribeListener(conversationId: string, listener: Listener, set: Set<Listener>): void {
    set.delete(listener);
    if (this.#listeners.get(conversationId) === set && set.size === 0) {
      this.#listeners.delete(conversationId);
    }
  }

  dropListenersIfEmpty(conversationId: string): void {
    const set = this.#listeners.get(conversationId);
    if (set && set.size === 0) this.#listeners.delete(conversationId);
  }

  listenersFor(conversationId: string): Iterable<Listener> {
    return this.#listeners.get(conversationId) ?? [];
  }

  readonly #completions = new Map<string, () => void>();

  registerCompletion(id: string, resolve: () => void): void {
    this.#completions.set(id, resolve);
  }

  settleAllCompletions(): void {
    for (const done of this.#completions.values()) done();
    this.#completions.clear();
  }

  // ここで完了を呼ばず返り値で渡す: 呼ぶかどうか・いつ呼ぶかは呼び出し側が決めており、ここで呼ぶと呼び出し順序が変わるため
  takeCompletion(id: string): (() => void) | undefined {
    const done = this.#completions.get(id);
    this.#completions.delete(id);
    return done;
  }

  readonly #deferred: InboxEvent[] = [];

  pushDeferred(event: InboxEvent): void {
    this.#deferred.push(event);
  }

  drainDeferred(): InboxEvent[] {
    return this.#deferred.splice(0);
  }

  // 後ろから外す: 前から `splice` すると添字がずれるため
  removeDeferredWhere(predicate: (event: InboxEvent) => boolean): InboxEvent[] {
    const found: InboxEvent[] = [];
    for (let i = this.#deferred.length - 1; i >= 0; i -= 1) {
      const held = this.#deferred[i];
      if (held === undefined || !predicate(held)) continue;
      this.#deferred.splice(i, 1);
      found.push(held);
    }
    found.reverse();
    return found;
  }

  removeDeferredById(id: string): InboxEvent | undefined {
    const index = this.#deferred.findIndex((held) => held.id === id);
    if (index === -1) return undefined;
    const [held] = this.#deferred.splice(index, 1);
    return held;
  }

  findDeferred(predicate: (event: InboxEvent) => boolean): InboxEvent[] {
    return this.#deferred.filter(predicate);
  }

  someDeferred(predicate: (event: InboxEvent) => boolean): boolean {
    return this.#deferred.some(predicate);
  }

  matchingDeferredCount(predicate: (event: InboxEvent) => boolean): number {
    return this.#deferred.filter(predicate).length;
  }

  get deferredCount(): number {
    return this.#deferred.length;
  }

  // `#unread` / `#committed` のメソッドを async にしない: 返す約束がラップされて tick が1つ増え、`await written` が実際の書き込みの完了より1 tick 遅れるため
  readonly #unread = new Map<string, Promise<void>>();

  getUnread(id: string): Promise<void> | undefined {
    return this.#unread.get(id);
  }

  setUnread(id: string, written: Promise<void>): void {
    this.#unread.set(id, written);
  }

  deleteUnread(id: string): void {
    this.#unread.delete(id);
  }

  get unreadSize(): number {
    return this.#unread.size;
  }

  readonly #pendingCollapse = new Map<string, PendingCollapseEntry>();

  // `Map` が持つ実体をそのまま返す: 呼び出し側が `existing.collapsed += 1` と直接書くため
  // `post()` の中だけで閉じる: 同期関数から呼ぶので照会と書き込みが不可分に起き、#1041 が台帳側（`list()` と `open()` の間）で指摘する TOCTOU はこの経路に構造的に存在しない
  getCollapseEntry(key: string): PendingCollapseEntry | undefined {
    return this.#pendingCollapse.get(key);
  }

  registerCollapseRepresentative(key: string, id: string, at: string): void {
    this.#pendingCollapse.set(key, { id, at, collapsed: 0 });
  }

  hasCollapseKey(key: string): boolean {
    return this.#pendingCollapse.has(key);
  }

  dropCollapseEntryIfMatches(key: string, id: string): PendingCollapseEntry | undefined {
    const existing = this.#pendingCollapse.get(key);
    if (existing === undefined || existing.id !== id) return undefined;
    this.#pendingCollapse.delete(key);
    return existing;
  }

  get collapseSize(): number {
    return this.#pendingCollapse.size;
  }

  #pendingTokenPoolNotice: PendingTokenPoolNotice | null = null;

  get pendingTokenPoolNotice(): PendingTokenPoolNotice | null {
    return this.#pendingTokenPoolNotice;
  }

  setPendingTokenPoolNotice(value: PendingTokenPoolNotice | null): void {
    this.#pendingTokenPoolNotice = value;
  }

  clearPendingTokenPoolNoticeIfMatches(id: string): void {
    if (this.#pendingTokenPoolNotice?.id === id) this.#pendingTokenPoolNotice = null;
  }

  readonly #recorded = new Map<string, Promise<void>>();
  // `#recordChain` を外へ出さず、chainRecord を async 関数で包まない: 受理の瞬間の日誌への追記を直列化する点を1つに保ち（会話の順序が追記順に依る）、tick 数・Promise の同一性を変えないため
  #recordChain: Promise<void> = Promise.resolve();

  chainRecord(id: string, write: () => Promise<void>): Promise<void> {
    const written = this.#recordChain.then(write);
    this.#recordChain = written.catch(() => undefined);
    this.#recorded.set(id, written);
    return written;
  }

  getRecorded(id: string): Promise<void> | undefined {
    return this.#recorded.get(id);
  }

  deleteRecorded(id: string): void {
    this.#recorded.delete(id);
  }

  readonly #committed = new Map<string, Promise<CommitOutcome>>();

  getCommitted(id: string): Promise<CommitOutcome> | undefined {
    return this.#committed.get(id);
  }

  setCommitted(id: string, outcome: Promise<CommitOutcome>): void {
    this.#committed.set(id, outcome);
  }

  deleteCommitted(id: string): void {
    this.#committed.delete(id);
  }
}

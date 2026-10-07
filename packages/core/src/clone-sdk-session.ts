import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { Turn } from './clone.js';

export class CloneSdkSession<Q extends { close(): void } = Query, I = SDKUserMessage> {
  #query: Q | null = null;
  #reader: Promise<void> | null = null;
  // .catch(...) まで含めた Promise を控える: 外すと pump が投げたとき、stop() が待つ前に unhandled rejection になるため
  #pumpLoop: Promise<void> | null = null;

  get query(): Q | null {
    return this.#query;
  }

  get reader(): Promise<void> | null {
    return this.#reader;
  }

  get pumpLoop(): Promise<void> | null {
    return this.#pumpLoop;
  }

  open(query: Q, reader: Promise<void>): void {
    this.#query = query;
    this.#reader = reader;
  }

  clearQuery(): void {
    this.#query = null;
  }

  closeQuery(): void {
    try {
      this.#query?.close();
    } catch {
      // 既に閉じている
    }
  }

  beginPumpLoop(promise: Promise<void>): void {
    this.#pumpLoop = promise;
  }

  #stopped = false;

  get stopped(): boolean {
    return this.#stopped;
  }

  markStopped(): void {
    this.#stopped = true;
  }

  #turn: Turn | null = null;

  get turn(): Turn | null {
    return this.#turn;
  }

  beginTurn(turn: Turn): void {
    this.#turn = turn;
  }

  // 回す印が立っていれば入力待ちの #inputStream を起こす: 起こさないと次の入力が届くまで古いトークンのまま走り続けるため
  finishTurn(): void {
    const turn = this.#turn;
    this.#turn = null;
    turn?.resolve();
    if (this.#recycleForToken || this.#recycleForContextWindow) this.wakeInput();
  }

  readonly #input: I[] = [];
  #inputWaiter: (() => void) | null = null;

  enqueueInput(message: I): void {
    this.#input.push(message);
  }

  dequeueInput(): I | undefined {
    return this.#input.shift();
  }

  waitForInput(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#inputWaiter = resolve;
    });
  }

  wakeInput(): void {
    const waiter = this.#inputWaiter;
    this.#inputWaiter = null;
    waiter?.();
  }

  #recycleForToken = false;
  #recycleForContextWindow = false;

  requestTokenRecycle(): void {
    this.#recycleForToken = true;
  }

  get wantsTokenRecycle(): boolean {
    return this.#recycleForToken;
  }

  takeTokenRecycle(): boolean {
    const wanted = this.#recycleForToken;
    this.#recycleForToken = false;
    return wanted;
  }

  armContextWindowRecycle(): void {
    this.#recycleForContextWindow = true;
  }

  get wantsContextWindowRecycle(): boolean {
    return this.#recycleForContextWindow;
  }

  takeContextWindowRecycle(): boolean {
    const wanted = this.#recycleForContextWindow;
    this.#recycleForContextWindow = false;
    return wanted;
  }

  #resumedFrom: string | null = null;
  #sawInit = false;

  get resumedFrom(): string | null {
    return this.#resumedFrom;
  }

  get sawInit(): boolean {
    return this.#sawInit;
  }

  beginSession(resume: string | null): void {
    this.#resumedFrom = resume;
    this.#sawInit = false;
  }

  markSawInit(): void {
    this.#sawInit = true;
  }

  #sdkSessionId: string | null = null;

  get sdkSessionId(): string | null {
    return this.#sdkSessionId;
  }

  setSdkSessionId(id: string | null): void {
    this.#sdkSessionId = id;
  }

  // 観測のたびに読み直さない: 回した後に届いた前のセッションの観測が新しい身元を名乗り、世代の照合が素通しになるため
  #sessionTokenIdentity: { tokenId: string; generation: number } | undefined;

  get sessionTokenIdentity(): { tokenId: string; generation: number } | undefined {
    return this.#sessionTokenIdentity;
  }

  captureSessionTokenIdentity(identity: { tokenId: string; generation: number } | undefined): void {
    this.#sessionTokenIdentity = identity;
  }
}

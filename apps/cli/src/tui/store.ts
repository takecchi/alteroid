/**
 * 購読できる小さなストア（subscribe / getSnapshot）。React の `useSyncExternalStore` へ
 * 載せる（`hooks.ts`）。出所: takecchi/codiva（MIT）`src/core/session-store.ts` の形。
 *
 * 状態は不変のオブジェクトで持ち、変えるたびに新しい参照へ差し替える。参照が変わらない
 * 更新は通知しない（描画を省く）。
 */
type Listener = () => void;

export class Store<S> {
  private readonly listeners = new Set<Listener>();
  private state: S;

  constructor(initial: S) {
    this.state = initial;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): S => this.state;

  /** `updater` が同じ参照を返したら何もしない。 */
  update(updater: (state: S) => S): void {
    const next = updater(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

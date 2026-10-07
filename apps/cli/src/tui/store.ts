// 出所: takecchi/codiva（MIT）`src/core/session-store.ts` の形
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

  update(updater: (state: S) => S): void {
    const next = updater(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

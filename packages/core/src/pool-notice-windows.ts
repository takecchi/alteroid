/**
 * 「1本目はすぐ・同じ出来事の残りは1通」の固定窓の置き場（枠の1通と取り戻した1通）。
 * 固定窓で延長しない（届き続ける限り閉じなくなり、配る保証が崩れる。north_star 禁止2）。
 * 窓の長さは使う側が2つの窓に同じ値を渡す（別の値にすると配る間隔が変わる）。
 */
export interface PoolNoticeWindow {
  timer: ReturnType<typeof setTimeout>;
  openedAt: number;
  /** 窓を開けた担当。この担当の束は配り済み。 */
  openerId: string;
  entries: Map<string, unknown>;
}

export class PoolNoticeWindows<K, W extends PoolNoticeWindow> {
  readonly #windows = new Map<K, W>();
  // 窓は読む前に外すので、`stop()` は外した後の配り中も待つ（さもないと台帳を読んでいる最中の一覧が落ちる）。
  readonly #inFlight = new Set<Promise<void>>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly deliver: (key: K, window: W) => Promise<void>,
  ) {}

  get(key: K): W | undefined {
    return this.#windows.get(key);
  }

  has(key: K): boolean {
    return this.#windows.has(key);
  }

  open(key: K, init: Omit<W, 'timer' | 'openedAt'>): void {
    const timer = setTimeout(() => void this.flush(key), this.windowMs);
    timer.unref?.();
    this.#windows.set(key, { ...init, timer, openedAt: this.now() } as W);
  }

  // 外してから配る: 読んでいる間に来た束が、配り終えた窓へ紛れ込まない。
  flush(key: K): Promise<void> {
    const window = this.#windows.get(key);
    if (window === undefined) return Promise.resolve();
    this.#windows.delete(key);
    clearTimeout(window.timer);
    const flush = this.deliver(key, window);
    this.#inFlight.add(flush);
    void flush.finally(() => this.#inFlight.delete(flush)).catch(() => undefined);
    return flush;
  }

  async flushAll(): Promise<void> {
    for (const key of [...this.#windows.keys()]) await this.flush(key);
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }
}

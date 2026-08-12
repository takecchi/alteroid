import { randomUUID } from 'node:crypto';

/**
 * 貸し出し期限（fencing lease / roadmap M5）。
 *
 * **これが、同じ仕事が2か所で走らないことを支えている唯一の仕掛けである。**
 *
 * デーモンから見て器が「落ちた」ことと、器が本当に止まっていることは別である。
 * ネットワークだけが切れて、マネージャーはこの器の中で手を動かし続けている、
 * という状態がありうる。その最中にデーモンが同じ session を別の器で resume
 * すれば、1つの仕事に2本のマネージャーが並ぶ — 共有 workspace への二重書きに
 * なり、`gh pr create` や MCP 越しの送信のような**取り消せない操作が2回**起きる。
 *
 * デーモン側の排他では止められない（別のプロセスで走っている1本だから）ので、
 * **器が自分から降りる**。`ttlMs` のあいだデーモンの `GET /health` が届かなければ、
 * 抱えているセッションを自分で畳む。デーモンはこの約束を根拠に、最後の名乗りから
 * `ttlMs` ＋ 余裕を過ぎたときだけ別の器で開き直す。
 *
 * **これは能力の制限ではない**（north_star 禁止2）。ターン数や実行回数のような
 * 人工上限ではなく、「デーモンに繋がっていない器はセッションを持ち続けない」という
 * 実行環境の境界である。道具は1つも減っていないし、繋がっている限り時間の上限も無い。
 *
 * 期限を更新するのは `GET /health` **だけ**である。他の口でも更新すると、器の期限が
 * デーモンの見立てより後ろへずれ、まだ走っている仕事を移されることになる。
 */

export interface SessionLeaseOptions {
  /** この時間デーモンから名乗りを聞かれなければ畳み始める（ミリ秒）。 */
  ttlMs: number;
  /**
   * 期限切れで畳む。返すのは畳んだ manager_id。
   *
   * **畳むのはセッションであって、器（プロセス）ではない。** 器が落ちてしまうと、
   * 通信が戻ってもデーモンが繋ぎ直す先が無くなる。
   */
  fence: () => Promise<string[]> | string[];
  /**
   * 期限が切れてから**畳み終わる**までに要りうる時間の上限（ミリ秒）。既定 5 秒。
   *
   * デーモンへはこの値を申告し、デーモンは `ttlMs + graceMs` ＋自分の余裕を過ぎて
   * から移送する。**畳むのに実際かかる時間より短く申告しないこと** — 申告が短いと、
   * デーモンが「もう止まっている」と見なした後もセッションが動いている窓ができる。
   */
  graceMs?: number;
  /** この起動を指す id（省略時は起動ごとに作る）。 */
  incarnation?: string;
  /** 畳んだことを人間に見せる（既定は何もしない）。 */
  onFenced?: (managerIds: string[]) => void;
  /** 主にテスト用。既定は `Date.now`。 */
  now?: () => number;
  /** 主にテスト用。既定は `setTimeout` / `clearTimeout`。 */
  timers?: {
    set: (callback: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
}

const DEFAULT_GRACE_MS = 5_000;

export class SessionLease {
  readonly #ttlMs: number;
  readonly #graceMs: number;
  readonly #incarnation: string;
  readonly #fence: () => Promise<string[]> | string[];
  readonly #onFenced: (managerIds: string[]) => void;
  readonly #now: () => number;
  readonly #timers: NonNullable<SessionLeaseOptions['timers']>;
  #lastContactAt: number;
  #timer: unknown = null;
  #armed = false;
  #fencing: Promise<string[]> | null = null;

  constructor(options: SessionLeaseOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('貸し出し期限（ttlMs）は正の数でなければならない');
    }
    this.#ttlMs = options.ttlMs;
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.#incarnation = options.incarnation ?? randomUUID();
    this.#fence = options.fence;
    this.#onFenced = options.onFenced ?? (() => undefined);
    this.#now = options.now ?? (() => Date.now());
    this.#timers = options.timers ?? {
      set: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        // 見張りだけでプロセスを生かし続けない。
        handle.unref?.();
        return handle;
      },
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    // 起きた時刻から数え始める。**誰も繋いでこないまま期限が来ても畳むものは無い**
    // （セッションはデーモンの命令でしか生まれない）ので、これで困らない。
    this.#lastContactAt = this.#now();
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  get graceMs(): number {
    return this.#graceMs;
  }

  get incarnation(): string {
    return this.#incarnation;
  }

  /**
   * デーモンから名乗りを聞かれた。ここでだけ期限が延びる。
   *
   * **見張りもここで張り直す。** 一定間隔で見に行く作りだと、最後の名乗りと見張りの
   * 位相が揃わず、畳み始めるのが最大で「間隔ぶん」遅れる。デーモンは `ttlMs` から
   * 数えて安全な時刻を出すので、その遅れがそのまま**二重に走る窓**になる。
   */
  touch(): void {
    this.#lastContactAt = this.#now();
    if (this.#armed) this.#arm();
  }

  /** 期限を過ぎているか。 */
  expired(at: number = this.#now()): boolean {
    return at - this.#lastContactAt > this.#ttlMs;
  }

  /**
   * 期限を過ぎていれば畳む。返るのは畳んだ manager_id。
   *
   * 畳んでいる最中にもう一度呼ばれても、同じ約束を返す（二重に畳まない）。
   */
  async check(): Promise<string[]> {
    if (!this.expired()) return [];
    if (this.#fencing !== null) return this.#fencing;

    const fencing = (async () => {
      const fenced = await this.#fence();
      if (fenced.length > 0) this.#onFenced(fenced);
      return fenced;
    })().finally(() => {
      this.#fencing = null;
    });

    this.#fencing = fencing;
    return fencing;
  }

  start(): void {
    if (this.#armed) return;
    this.#armed = true;
    this.#arm();
  }

  stop(): void {
    this.#armed = false;
    this.#disarm();
  }

  /**
   * 次に見るべき時刻ちょうどに1回だけ起きるように張る。
   *
   * 期限が来ていなければ残り時間ぶん、来ていれば即座に畳む。**間隔で回さない**
   * のは、名乗りとの位相のずれをデーモンの計算に持ち込まないためである。
   */
  #arm(): void {
    this.#disarm();
    if (!this.#armed) return;
    const remaining = this.#lastContactAt + this.#ttlMs - this.#now();
    this.#timer = this.#timers.set(
      () => {
        this.#timer = null;
        void this.check()
          .catch(() => undefined)
          .finally(() => {
            // 畳み終えたら、次に名乗りが届くまで張り直さない（同じ判定を回し続けない）。
            // 名乗りが戻れば `touch()` が張り直す — 器はその後も普通に使われる。
            if (this.#armed && !this.expired()) this.#arm();
          });
      },
      Math.max(remaining, 0),
    );
  }

  #disarm(): void {
    if (this.#timer === null) return;
    this.#timers.clear(this.#timer);
    this.#timer = null;
  }
}

/**
 * 環境変数から期限を読む（`ALTEROID_RUNNER_LEASE_TTL`、秒）。
 *
 * - 未設定 → 既定 30 秒（デーモンの生存確認は 10 秒間隔なので、3回分の猶予）
 * - `off` → 期限なし。**その器の仕事は自動では移らなくなる**（止まったことを
 *   確かめられないので、デーモンは人間かクローンの確認を待つ）
 */
export function leaseTtlMsOf(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.ALTEROID_RUNNER_LEASE_TTL;
  if (raw === undefined || raw.length === 0) return 30_000;
  if (raw.trim().toLowerCase() === 'off') return null;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ALTEROID_RUNNER_LEASE_TTL が読めない（秒か off を渡すこと）: ${raw}`);
  }
  return Math.round(seconds * 1000);
}

/**
 * 畳み終わるまでの猶予を環境変数から読む（`ALTEROID_RUNNER_LEASE_GRACE`、秒）。
 *
 * 既定 5 秒。**デーモンはこの申告ぶん余計に待ってから移送する**ので、走行中の
 * セッションを畳むのに実際かかる時間より短くしないこと。長くする分には安全側
 * （移送が遅くなるだけ）である。
 */
export function leaseGraceMsOf(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALTEROID_RUNNER_LEASE_GRACE;
  if (raw === undefined || raw.length === 0) return 5_000;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`ALTEROID_RUNNER_LEASE_GRACE が読めない（秒を渡すこと）: ${raw}`);
  }
  return Math.round(seconds * 1000);
}

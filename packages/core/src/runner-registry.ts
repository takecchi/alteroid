import type { RunnerCapacity, RunnerClient } from './runner-protocol.js';

/**
 * runner の名簿 — 登録・生存判定・資源による配置（roadmap M5）。
 *
 * デーモンは**固定 URL ではなくここ**を見る。1台構成でも複数構成でも、上の層
 * （`ManagerPool`・クローン・道具）から見える顔は同じである。M5 のゴールは
 * 「runner を増やしても、能力もプロトコルも1台構成と同じままでいる」なので、
 * ここで増えるのは**宛先の選び方**だけであって、口の数でも制限でもない。
 *
 * **この層でいちばん踏みやすい地雷**（roadmap M5 に明記されている）:
 *
 * - 配置の判断（資源を見る）と能力の制限（何本までと決める）を混同しない。
 *   `maxManagers` のような定員をここへ足した瞬間、それは禁止2 の違反になる
 * - だから `select` は**必ず置き先を返す**。全部の器が詰まっていても、負荷の低い
 *   方を返すだけで、拒む口はどこにも無い。委譲を止めてよいのは器が1つも
 *   登録されていないときだけである
 * - 生存判定も**配置の材料**である。「落ちて見える」ことは委譲を拒む理由にならず、
 *   生きている器が1つも見えなければ登録済みの器へそのまま投げる（見えないのが
 *   観測側の失敗であることもある。そのときは投げた先で本物の失敗が返る）
 */

/** 直近の生存判定の結果。**判定の材料と結論だけ**で、処分は含まない。 */
export interface RunnerHealthState {
  runnerId: string;
  /** 名乗りが返っている（か、まだ一度も聞いていない）。 */
  alive: boolean;
  /** 最後に名乗りが返った時刻（ISO 8601）。一度も返っていなければ null。 */
  lastSeenAt: string | null;
  /** 連続で届かなかった回数。 */
  misses: number;
  /** 最後に測れた資源（報告しない器では省かれる）。 */
  capacity?: RunnerCapacity;
  /** 最後の失敗の理由（人間が読む用）。 */
  lastError?: string;
}

export interface RunnerSelectInput {
  /** 実プロジェクトの作業ディレクトリ（呼び出し側が決めている場合）。 */
  cwd?: string;
  /**
   * ここに挙げた runner は選ばない。
   *
   * 落ちた器から移すときに、同じ器へ戻さないための口である（M5 受け入れ基準4）。
   */
  exclude?: readonly string[];
}

export interface RunnerRegistry {
  /** 登録済みの全 runner（生きているかどうかは問わない）。 */
  list(): Promise<RunnerClient[]>;
  get(runnerId: string): Promise<RunnerClient | null>;
  /**
   * 新しい委譲をどの runner に置くか。
   *
   * **拒まない。** 返せないのは1台も登録されていないときだけである。
   */
  select(input?: RunnerSelectInput): Promise<RunnerClient>;
  /** 名簿へ足す（runner が増えられること自体が M5 のゴール）。 */
  register(runner: RunnerClient): void;
  /** 生存判定を一巡させる。返るのは全 runner の状態。 */
  heartbeat(): Promise<RunnerHealthState[]>;
  /** 1台だけ聞き直す。宛先が生きているかを、周期を待たずに確かめるための口。 */
  probe(runnerId: string): Promise<RunnerHealthState | null>;
  /** 直近の判定結果（聞き直しはしない。観測用）。 */
  states(): RunnerHealthState[];
  /** いま生きて見えている runner だけ。 */
  live(): Promise<RunnerClient[]>;
  /**
   * runner が落ちたと見えた瞬間に呼ばれる。
   *
   * ここが**フェイルオーバーの契機**である。人間の不在で仕事が止まってよいのは
   * 承認待ちだけなので（PRD「自律」）、器が落ちたことに気づく口を持たないまま
   * 「次に話しかけられたら直す」にしない。
   */
  onLost(listener: (state: RunnerHealthState) => void): () => void;
  /** 定期の生存確認を始める / 止める。 */
  start(): void;
  stop(): void;
}

export interface RunnerRegistryOptions {
  /** 生存確認の間隔（ミリ秒）。既定 10 秒。 */
  heartbeatIntervalMs?: number;
  /**
   * 最後に名乗りが返ってからこの時間で「落ちた」と見る（ミリ秒）。既定 30 秒。
   *
   * 1回の取りこぼしで走っている仕事を動かさないための猶予である。短くしすぎると、
   * 生きている器から仕事を引き剥がす。
   */
  livenessTimeoutMs?: number;
  /** 主にテスト用。既定は `Date.now`。 */
  now?: () => number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 30_000;

interface MutableState {
  /** 最後に聞いた時刻（成功・失敗どちらも）。まだ聞いていなければ null。 */
  probedAt: number | null;
  lastSeen: number | null;
  misses: number;
  capacity: RunnerCapacity | undefined;
  lastError: string | undefined;
  /**
   * 直近この器へ置いた本数のうち、まだ実測（`capacity.activeManagers`）へ
   * 現れていない分。
   *
   * **これが無いと、続けて起こした委譲が全部同じ器へ落ちる。** 負荷平均も
   * セッション数も観測が遅れるので、置いた事実を次の観測まで自分で覚えておく。
   */
  placements: number;
}

export function createRunnerRegistry(
  runners: RunnerClient[] = [],
  options: RunnerRegistryOptions = {},
): RunnerRegistry {
  return new Registry(runners, options);
}

class Registry implements RunnerRegistry {
  readonly #runners: RunnerClient[] = [];
  /**
   * 状態は**クライアントそのもの**で引く（runner_id ではない）。
   *
   * HTTP の口は最初の名乗りが返るまで自分の id を知らない（落ちている器を名簿に
   * 載せたまま復帰を待てるようにするため）。id で引くと、その間の状態が迷子になる。
   */
  readonly #states = new Map<RunnerClient, MutableState>();
  readonly #listeners = new Set<(state: RunnerHealthState) => void>();
  readonly #heartbeatIntervalMs: number;
  readonly #livenessTimeoutMs: number;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(runners: RunnerClient[], options: RunnerRegistryOptions) {
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#livenessTimeoutMs = options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
    for (const runner of runners) this.register(runner);
  }

  register(runner: RunnerClient): void {
    if (this.#states.has(runner)) return;
    this.#runners.push(runner);
    this.#states.set(runner, {
      probedAt: null,
      lastSeen: null,
      misses: 0,
      capacity: undefined,
      lastError: undefined,
      placements: 0,
    });
  }

  async list(): Promise<RunnerClient[]> {
    return [...this.#runners];
  }

  async get(runnerId: string): Promise<RunnerClient | null> {
    const found = this.#runners.filter((runner) => runner.runnerId === runnerId);
    // 同じ id が二重に載っている（器が作り直された直後など）ときは生きている方。
    return found.find((runner) => this.#aliveOf(runner)) ?? found[0] ?? null;
  }

  async live(): Promise<RunnerClient[]> {
    return this.#runners.filter((runner) => this.#aliveOf(runner));
  }

  states(): RunnerHealthState[] {
    return this.#runners.map((runner) => this.#stateOf(runner));
  }

  /**
   * 置き先を決める。材料は**実行環境の資源だけ**である。
   *
   * 順に、除外されていない器 → 生きて見えている器 → （1つも生きて見えなければ）
   * 登録済みの器、と落としていく。**どの段でも「詰まっているから置かない」は無い。**
   */
  async select(input: RunnerSelectInput = {}): Promise<RunnerClient> {
    if (this.#runners.length === 0) {
      throw new Error(
        'manager-runner が登録されていない（ALTEROID_RUNNER_URL / ALTEROID_RUNNER_URLS か同一プロセスの runner が要る）',
      );
    }

    // 古い読みでは配置を決められない。必要な器だけ聞き直す。
    await this.#refreshStale();

    const excluded = new Set(input.exclude ?? []);
    const allowed = this.#runners.filter((runner) => !excluded.has(runner.runnerId));
    const living = allowed.filter((runner) => this.#aliveOf(runner));
    const candidates = living.length > 0 ? living : allowed.length > 0 ? allowed : this.#runners;

    let best = candidates[0] as RunnerClient;
    let bestScore = this.#scoreOf(best);
    for (const runner of candidates.slice(1)) {
      const score = this.#scoreOf(runner);
      if (score > bestScore) {
        best = runner;
        bestScore = score;
      }
    }

    const state = this.#states.get(best);
    if (state !== undefined) state.placements += 1;
    return best;
  }

  async heartbeat(): Promise<RunnerHealthState[]> {
    await Promise.all(this.#runners.map((runner) => this.#probe(runner)));
    return this.states();
  }

  async probe(runnerId: string): Promise<RunnerHealthState | null> {
    const runner = await this.get(runnerId);
    if (runner === null) return null;
    await this.#probe(runner);
    return this.#stateOf(runner);
  }

  onLost(listener: (state: RunnerHealthState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, this.#heartbeatIntervalMs);
    // 生存確認だけでプロセスを生かし続けない（常駐はデーモンの受け口の仕事）。
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  // -------------------------------------------------------------------------
  // 生存判定
  // -------------------------------------------------------------------------

  /**
   * 1台に名乗りを聞く。
   *
   * 落ちたと**見えた**瞬間だけ聞き手へ知らせる（毎回の失敗では鳴らさない）。
   * 鳴らし続けると、フェイルオーバーが同じ仕事を何度も掴み直す。
   */
  async #probe(runner: RunnerClient): Promise<void> {
    const state = this.#states.get(runner);
    if (state === undefined) return;

    const wasAlive = this.#aliveOf(runner);
    const at = this.#now();
    state.probedAt = at;

    try {
      const health = await runner.health();
      state.lastSeen = at;
      state.misses = 0;
      state.capacity = health.capacity;
      state.lastError = undefined;
      // 実測に置き換わったので、見込みで数えていた分は畳む。
      state.placements = 0;
    } catch (error) {
      state.misses += 1;
      state.lastError = String(error);
    }

    if (wasAlive && !this.#aliveOf(runner)) {
      const lost = this.#stateOf(runner);
      for (const listener of this.#listeners) {
        try {
          listener(lost);
        } catch {
          // 聞き手の失敗で生存判定を止めない
        }
      }
    }
  }

  /** 周期より古い読みだけを聞き直す（毎回全台へ聞きに行かない）。 */
  async #refreshStale(): Promise<void> {
    const now = this.#now();
    const stale = this.#runners.filter((runner) => {
      const probedAt = this.#states.get(runner)?.probedAt;
      return (
        probedAt === null || probedAt === undefined || now - probedAt >= this.#heartbeatIntervalMs
      );
    });
    await Promise.all(stale.map((runner) => this.#probe(runner)));
  }

  /**
   * 生きて見えているか。
   *
   * **まだ一度も聞いていない器は「生きているつもり」で扱う。** ここで false に
   * すると、生存確認が一巡する前の委譲が宛先を失う（1台構成のローカルでは
   * `alteroid chat` の初回がそれに当たる）。
   */
  #aliveOf(runner: RunnerClient): boolean {
    const state = this.#states.get(runner);
    if (state === undefined) return false;
    if (state.probedAt === null) return true;
    if (state.lastSeen === null) return false;
    return this.#now() - state.lastSeen <= this.#livenessTimeoutMs;
  }

  #stateOf(runner: RunnerClient): RunnerHealthState {
    const state = this.#states.get(runner);
    return {
      runnerId: runner.runnerId,
      alive: this.#aliveOf(runner),
      lastSeenAt:
        state?.lastSeen === null || state?.lastSeen === undefined
          ? null
          : new Date(state.lastSeen).toISOString(),
      misses: state?.misses ?? 0,
      ...(state?.capacity === undefined ? {} : { capacity: state.capacity }),
      ...(state?.lastError === undefined ? {} : { lastError: state.lastError }),
    };
  }

  /**
   * 余裕の目安。**大きいほど置きたい器**である。
   *
   * 材料は3つで、どれも実測である。
   *
   * - 空きメモリの割合 — SDK セッションはメモリを食う。器の大きさの違いがここに出る
   * - CPU あたりの負荷 — 走っている仕事の重さ。器の速さの違いがここに出る
   * - CPU あたりのセッション密度 — 1本が1コアを使い切る前提でならす。まだ観測に
   *   出ていない直近の配置（`placements`）も足す
   *
   * **これは点数であって定員ではない。** どれだけ低くても、`select` は置き先として
   * 返す（詰まっているという事実は器の限界として現れるべきで、名簿が先に断らない）。
   * 資源を報告しない器は、置いた本数だけで見る（報告が無いことを不利にしない）。
   */
  #scoreOf(runner: RunnerClient): number {
    const state = this.#states.get(runner);
    const capacity = state?.capacity;
    const sessions = (capacity?.activeManagers ?? 0) + (state?.placements ?? 0);
    if (capacity === undefined) return -sessions;

    const cpuCount = capacity.cpuCount > 0 ? capacity.cpuCount : 1;
    const freeMemoryRatio =
      capacity.totalMemoryBytes > 0 ? capacity.freeMemoryBytes / capacity.totalMemoryBytes : 1;
    return freeMemoryRatio - capacity.load1m / cpuCount - sessions / cpuCount;
  }
}

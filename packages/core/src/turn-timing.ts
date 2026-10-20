// クローンの1ターンを段に分けて時間を測る（#5086）。I/O を持たず、印を打たれた時刻の差を足し込むだけ:
// 測ることそのものが遅さの元にならないよう、ここでは日誌へ書かない（1ターン1行を書くのは呼び手）。

/**
 * 段の名前。`.` の前が親の段で、親の段どうしは重ならない（足すとターンの壁時計にほぼ等しい）。
 * `.` の付く段は親の段の内訳で、親と二重に数えない。
 */
export type TurnTimingPhase =
  // 合図が受信箱に積まれてから、このターンが始まるまで（前のターンの処理待ち）
  | 'queue'
  // ターンの前の断り書きの組み立て（`#pump` の先頭）
  | 'prepare'
  | `prepare.${string}`
  // SDK のセッションを起こす・開き直す（`#ensureQuery`）
  | 'sessionStart'
  // 記憶の焼き込み・要約の注入・本文の合成
  | 'composeInput'
  // SDK に投げてから `result` まで（内訳は道具・要約を別に持つ）
  | 'model'
  // `result` の後の後始末（文脈の観測・流量・使用量・返答の日誌など）
  | 'finalize'
  | `finalize.${string}`;

export interface TurnTimingToolSummary {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface TurnTimingRecord {
  /** 束ねた合図の種類（重複は除く） */
  triggers: string[];
  batchSize: number;
  kinds: Array<'normal' | 'distill'>;
  conversationId?: string;
  succeeded: boolean;
  /** 合図が積まれてから後始末の終わりまで（体感の「応答が全部終わるまで」） */
  totalMs: number;
  /** 合図が積まれてから最初の文字が出るまで（体感の「最初の応答」）。文字が出なかった回は無い */
  firstTextMs?: number;
  /** SDK に投げてから最初の出来事（文字・道具）が返るまで */
  firstResponseMs?: number;
  phases: Record<string, number>;
  tools?: { count: number; totalMs: number; top: TurnTimingToolSummary[] };
  compactions?: { count: number; totalMs: number };
  sdk?: { durationMs?: number; durationApiMs?: number; numTurns?: number };
  contextTokens?: number;
  /** そのターンのメインループの消費（SDK の `result.usage`。作業者・要約などの内部呼び出しは含まない）。入力の重さと費用の材料 */
  tokens?: { input: number; cacheRead: number; cacheCreation: number; output: number };
}

// 道具は名前ごとに集約し、長い順にこの件数だけ載せる: 1ターン1行のまま、行の大きさを道具の本数に比例させないため
export const TURN_TIMING_TOP_TOOLS = 8;

export class TurnTimer {
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #arrivedAt: number;
  readonly #phases = new Map<string, number>();
  readonly #triggers: string[];
  readonly #batchSize: number;
  readonly #kinds: Array<'normal' | 'distill'> = [];
  #conversationId: string | undefined;
  #modelStartedAt: number | undefined;
  #firstModelStartedAt: number | undefined;
  #firstResponseAt: number | undefined;
  #firstTextAt: number | undefined;
  #turnEndedAt: number | undefined;
  readonly #openTools = new Map<string, { name: string; startedAt: number }>();
  readonly #tools = new Map<string, TurnTimingToolSummary>();
  #toolCount = 0;
  #toolTotalMs = 0;
  #compactionStartedAt: number | undefined;
  #compactionCount = 0;
  #compactionTotalMs = 0;
  #sdk: TurnTimingRecord['sdk'];
  #contextTokens: number | undefined;
  #tokens: TurnTimingRecord['tokens'];
  #succeeded = true;

  constructor(options: {
    now: () => number;
    /** 束ねた合図の中でいちばん古い `at`（epoch ms）。読めなければ取り出した時刻 */
    arrivedAt: number;
    triggers: readonly string[];
    batchSize: number;
  }) {
    this.#now = options.now;
    this.#startedAt = options.now();
    this.#arrivedAt = Math.min(options.arrivedAt, this.#startedAt);
    this.#triggers = [...new Set(options.triggers)];
    this.#batchSize = options.batchSize;
    this.#phases.set('queue', this.#startedAt - this.#arrivedAt);
  }

  add(phase: TurnTimingPhase, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.#phases.set(phase, (this.#phases.get(phase) ?? 0) + ms);
  }

  /** `fn` の時間を `phase` に足す。投げても足してから投げ直す */
  async time<T>(phase: TurnTimingPhase, fn: () => Promise<T>): Promise<T> {
    const startedAt = this.#now();
    try {
      return await fn();
    } finally {
      this.add(phase, this.#now() - startedAt);
    }
  }

  turnStarted(kind: 'normal' | 'distill', conversationId: string | null): void {
    if (!this.#kinds.includes(kind)) this.#kinds.push(kind);
    if (conversationId !== null) this.#conversationId ??= conversationId;
  }

  /** 入力を SDK に投げた。最初の1回の時刻を、最初の応答までの起点として控える */
  modelStarted(): void {
    const now = this.#now();
    this.#modelStartedAt = now;
    this.#firstModelStartedAt ??= now;
  }

  /** SDK から何か（文字・道具）が返った。最初の1回だけ数える */
  responded(kind: 'text' | 'tool'): void {
    const now = this.#now();
    this.#firstResponseAt ??= now;
    if (kind === 'text') this.#firstTextAt ??= now;
  }

  toolStarted(id: string, name: string): void {
    this.responded('tool');
    this.#openTools.set(id, { name, startedAt: this.#now() });
  }

  toolEnded(ids: readonly string[]): void {
    const now = this.#now();
    for (const id of ids) {
      const open = this.#openTools.get(id);
      if (open === undefined) continue;
      this.#openTools.delete(id);
      this.#recordTool(open.name, now - open.startedAt);
    }
  }

  compactionStarted(): void {
    this.#compactionStartedAt ??= this.#now();
  }

  compactionEnded(): void {
    this.#compactionCount += 1;
    if (this.#compactionStartedAt !== undefined) {
      this.#compactionTotalMs += this.#now() - this.#compactionStartedAt;
      this.#compactionStartedAt = undefined;
    }
  }

  /** `result` が届いた。ここで `model` の段を閉じ、後始末（`finalize`）が始まる */
  turnEnded(facts: {
    succeeded: boolean;
    sdk?: TurnTimingRecord['sdk'];
    contextTokens?: number;
    tokens?: TurnTimingRecord['tokens'];
  }): void {
    const now = this.#now();
    if (this.#modelStartedAt !== undefined) {
      this.add('model', now - this.#modelStartedAt);
      this.#modelStartedAt = undefined;
    }
    this.#turnEndedAt ??= now;
    if (!facts.succeeded) this.#succeeded = false;
    if (facts.sdk !== undefined) this.#sdk = facts.sdk;
    if (facts.contextTokens !== undefined) this.#contextTokens = facts.contextTokens;
    // 1回分の束で複数ターンが回った回は足し合わせる
    if (facts.tokens !== undefined) {
      const before = this.#tokens;
      this.#tokens =
        before === undefined
          ? { ...facts.tokens }
          : {
              input: before.input + facts.tokens.input,
              cacheRead: before.cacheRead + facts.tokens.cacheRead,
              cacheCreation: before.cacheCreation + facts.tokens.cacheCreation,
              output: before.output + facts.tokens.output,
            };
    }
  }

  /** ターンの終わりに観測した文脈の大きさ（トークン）。「最初の応答が遅い」の材料 */
  contextObserved(tokens: number): void {
    this.#contextTokens = tokens;
  }

  /** ターンが入らずに失敗した回（入力を投げる前に落ちた）も失敗として残す */
  failed(): void {
    this.#succeeded = false;
  }

  get turnStartedAny(): boolean {
    return this.#kinds.length > 0;
  }

  #recordTool(name: string, ms: number): void {
    const elapsed = Math.max(0, ms);
    this.#toolCount += 1;
    this.#toolTotalMs += elapsed;
    const current = this.#tools.get(name) ?? { name, count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += elapsed;
    current.maxMs = Math.max(current.maxMs, elapsed);
    this.#tools.set(name, current);
  }

  /** 後始末まで終わった時点で呼ぶ。閉じていない道具は、終わりの時刻で閉じたものとして数える */
  finish(): TurnTimingRecord {
    const now = this.#now();
    if (this.#modelStartedAt !== undefined) {
      this.add('model', now - this.#modelStartedAt);
      this.#modelStartedAt = undefined;
    }
    for (const [id, open] of this.#openTools) {
      this.#openTools.delete(id);
      this.#recordTool(open.name, (this.#turnEndedAt ?? now) - open.startedAt);
    }
    if (this.#turnEndedAt !== undefined) this.add('finalize', now - this.#turnEndedAt);
    const round = (value: number): number => Math.round(value);
    const phases: Record<string, number> = {};
    for (const [name, ms] of this.#phases) phases[name] = round(ms);
    const top = [...this.#tools.values()]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, TURN_TIMING_TOP_TOOLS)
      .map((tool) => ({ ...tool, totalMs: round(tool.totalMs), maxMs: round(tool.maxMs) }));
    const modelStartedAt = this.#firstModelStartedAt;
    return {
      triggers: this.#triggers,
      batchSize: this.#batchSize,
      kinds: [...this.#kinds],
      ...(this.#conversationId === undefined ? {} : { conversationId: this.#conversationId }),
      succeeded: this.#succeeded,
      totalMs: round(now - this.#arrivedAt),
      ...(this.#firstTextAt === undefined
        ? {}
        : { firstTextMs: round(this.#firstTextAt - this.#arrivedAt) }),
      ...(this.#firstResponseAt === undefined || modelStartedAt === undefined
        ? {}
        : { firstResponseMs: round(this.#firstResponseAt - modelStartedAt) }),
      phases,
      ...(this.#toolCount === 0
        ? {}
        : { tools: { count: this.#toolCount, totalMs: round(this.#toolTotalMs), top } }),
      ...(this.#compactionCount === 0
        ? {}
        : {
            compactions: { count: this.#compactionCount, totalMs: round(this.#compactionTotalMs) },
          }),
      ...(this.#sdk === undefined ? {} : { sdk: this.#sdk }),
      ...(this.#contextTokens === undefined ? {} : { contextTokens: this.#contextTokens }),
      ...(this.#tokens === undefined ? {} : { tokens: this.#tokens }),
    };
  }
}

import type { MemoryDocument } from './schema.js';

export class CloneDistillMemoryState {
  #systemPromptChars = 0;
  // `#memoryOnRecord` の合計で代用しない: 走行中に人間が記憶を直せば動き、`CloneRuntimeFacts.injectedMemoryChars` が名乗る「セッションを組み立てた時点」の値が嘘になるため
  #promptMemoryChars = 0;

  get systemPromptChars(): number {
    return this.#systemPromptChars;
  }

  get promptMemoryChars(): number {
    return this.#promptMemoryChars;
  }

  recordBuiltSizes(systemPromptChars: number, promptMemoryChars: number): void {
    this.#systemPromptChars = systemPromptChars;
    this.#promptMemoryChars = promptMemoryChars;
  }

  // 永続化しない: 器が再起動すれば失われ、再起動後の最初の tick は「前回の tick が無い」として扱うのが正しいため
  #lastTickMemoryFloorChars: number | null = null;
  #lastTickMemoryBaselineChars: number | null = null;

  get lastTickMemoryFloorChars(): number | null {
    return this.#lastTickMemoryFloorChars;
  }

  get lastTickMemoryBaselineChars(): number | null {
    return this.#lastTickMemoryBaselineChars;
  }

  recordTick(floorChars: number, baselineChars: number): void {
    this.#lastTickMemoryFloorChars = floorChars;
    this.#lastTickMemoryBaselineChars = baselineChars;
  }

  // セッションを跨いで持ち越さない: 別のセッションの生ログをいまの `sessionId` の名前で退避することになるため
  #transcriptPath: string | null = null;

  get transcriptPath(): string | null {
    return this.#transcriptPath;
  }

  setTranscriptPath(path: string): void {
    this.#transcriptPath = path;
  }

  clearTranscriptPath(): void {
    this.#transcriptPath = null;
  }

  #contextWindowFoldNoticePending = false;

  armContextWindowFoldNotice(): void {
    this.#contextWindowFoldNoticePending = true;
  }

  takeContextWindowFoldNoticePending(): boolean {
    const pending = this.#contextWindowFoldNoticePending;
    this.#contextWindowFoldNoticePending = false;
    return pending;
  }

  #memoryIndexRefreshPending = false;

  armMemoryIndexRefresh(): void {
    this.#memoryIndexRefreshPending = true;
  }

  // 載せるものが無くても下ろす: 残すと無関係な更新に相乗りするため
  takeMemoryIndexRefreshPending(): boolean {
    const pending = this.#memoryIndexRefreshPending;
    this.#memoryIndexRefreshPending = false;
    return pending;
  }

  // 初期値は `true`: 前のプロセスが shutdown 蒸留を済ませたかをこの層からは知れず、知れないなら蒸留する側を既定にするため
  #hasUndistilledActivity = true;

  get hasUndistilledActivity(): boolean {
    return this.#hasUndistilledActivity;
  }

  // 失敗した蒸留では下ろさない: 移せなかった記憶を「移した」ことにして記憶を落とすため
  markDistilled(): void {
    this.#hasUndistilledActivity = false;
  }

  // 蒸留のターンでは呼ばない: 立て直すと印が永久に下りず、`stop()` の重複防止が何もしないのと同じになるため
  markActivity(): void {
    this.#hasUndistilledActivity = true;
  }

  // 全文の1文字列ではなく文書ごとに持つ: 1つの文書の1行を直しただけで記憶の全文を載せ直さず、実際に変わった文書だけを載せ直すため
  readonly #memoryOnRecord = new Map<string, string>();

  diffAgainstRecorded(documents: readonly MemoryDocument[]): {
    changed: MemoryDocument[];
    removed: string[];
  } {
    const changed = documents.filter((doc) => this.#memoryOnRecord.get(doc.slug) !== doc.content);
    const present = new Set(documents.map((doc) => doc.slug));
    const removed = [...this.#memoryOnRecord.keys()].filter((slug) => !present.has(slug));
    return { changed, removed };
  }

  // 退避 → クリア → 詰め直しの順を変えない: 逆にすると、退避したつもりの控えが新しい内容で埋まり、差分が常に空になるため
  commitMemory(documents: readonly MemoryDocument[]): ReadonlyMap<string, string> {
    const seenContent = new Map(this.#memoryOnRecord);
    this.#memoryOnRecord.clear();
    for (const doc of documents) this.#memoryOnRecord.set(doc.slug, doc.content);
    return seenContent;
  }

  forgetMemory(): void {
    this.#memoryOnRecord.clear();
  }

  #resumedHistoryHasMemory = false;

  setResumedHistoryHasMemory(resumed: boolean): void {
    this.#resumedHistoryHasMemory = resumed;
  }

  takeResumedHistoryHasMemory(): boolean {
    const had = this.#resumedHistoryHasMemory;
    this.#resumedHistoryHasMemory = false;
    return had;
  }

  readonly #bootAt = new Date().toISOString();

  get bootAt(): string {
    return this.#bootAt;
  }

  #distillGapNoticePending = true;

  takeDistillGapNoticePending(): boolean {
    const pending = this.#distillGapNoticePending;
    this.#distillGapNoticePending = false;
    return pending;
  }
}

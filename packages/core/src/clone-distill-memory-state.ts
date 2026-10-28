import {
  MEMORY_INDEX_NOT_REINJECTED_PHRASE,
  MEMORY_INDEX_REINJECTED_PHRASE,
} from './exchange-kind.js';
import type { MemoryDocument } from './schema.js';

/**
 * 開き直しで生ログを退避した結果。
 *
 * - `pending`: まだ退避が終わっていない（`#read` の `finally` が走る前）
 * - `saved`: 退避できた（`id` は `GET /archive/:id` で読める）
 * - `failed`: 退避しようとして失敗した
 * - `none`: 退避するものが無かった（生ログの控えが無い／セッションが無かった）
 */
export type ReopenArchive =
  { kind: 'pending' } | { kind: 'saved'; id: string } | { kind: 'failed' } | { kind: 'none' };

/** 人間の操作でセッションを開き直したことの控え（`Clone#reopenSession`）。 */
export interface ReopenRecord {
  readonly actor: string;
  readonly reason: string;
  readonly distill: boolean;
  /** クローン自身の判定で開き直したか（既定は人間の操作）。断りの主語が変わる。 */
  readonly automatic?: boolean;
  readonly previousSessionId: string | null;
  /** 受けた時点で開いていたセッションの通し番号（これより後のセッションが「開き直した後」）。 */
  readonly armedAtOrdinal: number;
  archive: ReopenArchive;
  noticePending: boolean;
  initPending: boolean;
}

/** 焼いた時点との差の文書の slug（本文は持たない）。 */
export interface BakedMemoryDiff {
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

// 語の持ち主は exchange-kind.ts（承認の追跡が行頭の定数で除外するため）。ここからも引けるように再 export する。
export { MEMORY_INDEX_NOT_REINJECTED_PHRASE, MEMORY_INDEX_REINJECTED_PHRASE };

// 並べる slug の上限: 文書が多い記憶で1行が長くならないため。超えた分は「ほか M 件」にする。
const REFRESH_DIFF_SLUG_LIMIT = 10;

/**
 * 要約後の索引の載せ直しの日誌1行の本文（接頭辞は書き手の `text:` に置く）。
 * slug・違いの種類・文字数・件数だけを書く: 記憶の本文・要旨は日誌に写さないため。
 */
export function describeMemoryIndexRefresh(input: {
  readonly reinjected: boolean;
  readonly diff: BakedMemoryDiff;
  readonly renderedChars: number;
  readonly totalDocuments: number;
}): string {
  if (!input.reinjected) {
    return (
      `${MEMORY_INDEX_NOT_REINJECTED_PHRASE}（要約後。焼いた時点から変わっていない）。` +
      `載せ直した文字数 0。全文書数 ${input.totalDocuments}`
    );
  }
  const entries = [
    ...input.diff.changed.map((slug) => `${slug}（内容が変わった）`),
    ...input.diff.added.map((slug) => `${slug}（焼いた時点に無かった）`),
    ...input.diff.removed.map((slug) => `${slug}（消えた）`),
  ];
  const shown = entries.slice(0, REFRESH_DIFF_SLUG_LIMIT).join(' / ');
  const rest = entries.length - REFRESH_DIFF_SLUG_LIMIT;
  return (
    `${MEMORY_INDEX_REINJECTED_PHRASE}（要約後。違った文書 ${entries.length} 件: ` +
    `${shown}${rest > 0 ? ` ほか ${rest} 件` : ''}）。` +
    `載せ直した文字数 ${input.renderedChars}。全文書数 ${input.totalDocuments}`
  );
}

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

  // 文脈窓の断り（上）とは別に持つ: 開き直しは人間の操作で、理由・操作者・退避先という別の中身を運ぶため
  #reopen: ReopenRecord | null = null;

  armReopen(record: Omit<ReopenRecord, 'archive' | 'noticePending' | 'initPending'>): void {
    // 同じ位置の別の `armReopen` を上書きする（直前の控えは捨てる）: 断りは最新の1件だけでよいため
    this.#reopen = {
      ...record,
      archive: { kind: 'pending' },
      noticePending: true,
      initPending: true,
    };
  }

  // 退避の結果を後から書き込む（退避は `#read` の `finally` で、開き直しを受けた後に走るため）
  recordReopenArchive(archive: ReopenArchive): void {
    if (this.#reopen !== null) this.#reopen.archive = archive;
  }

  // 下ろすのは最初の1回だけ: 2ターン目以降へ同じ断りを載せないため。
  // 開き直しを受けた時点より後に開いたセッション（`sessionOrdinal` が大きい）にしか載せない: 境界の前に積まれていた入力が古いセッションで走る回へ載ると、新しいセッションが断りを受け取れないため
  takeReopenNotice(sessionOrdinal: number): ReopenRecord | null {
    if (this.#reopen === null || !this.#reopen.noticePending) return null;
    if (sessionOrdinal <= this.#reopen.armedAtOrdinal) return null;
    this.#reopen.noticePending = false;
    return { ...this.#reopen };
  }

  // 開き直しの後の最初の init でだけ日誌に残す
  takeReopenInit(): ReopenRecord | null {
    if (this.#reopen === null || !this.#reopen.initPending) return null;
    this.#reopen.initPending = false;
    return { ...this.#reopen };
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

  // `#memoryOnRecord`（最後に載せた時点）とは別に持つ: あちらは差分を載せるたびに進むが、その差分は次の要約に畳まれて消える。要約を越えて残るのはシステムプロンプトに焼いた記憶だけで、要約後の索引の載せ直しが比べる相手はこちらのため。
  // `null` は「焼いた控えが無い」: 無ければ一致とは言えず、載せ直す側（全文）へ倒す。
  #bakedMemory: ReadonlyMap<string, string> | null = null;

  recordBakedMemory(documents: readonly MemoryDocument[]): void {
    this.#bakedMemory = new Map(documents.map((doc) => [doc.slug, doc.content]));
  }

  // 焼いた控えが無いときは全文書を `added`（焼いた時点に無かった）に数える: 一致とは言えず、載せ直す側へ倒す `matchesBakedMemory` と同じ向きのため。
  diffAgainstBaked(documents: readonly MemoryDocument[]): BakedMemoryDiff {
    const baked = this.#bakedMemory ?? new Map<string, string>();
    const changed: string[] = [];
    const added: string[] = [];
    for (const doc of documents) {
      const was = baked.get(doc.slug);
      if (was === undefined) added.push(doc.slug);
      else if (was !== doc.content) changed.push(doc.slug);
    }
    const present = new Set(documents.map((doc) => doc.slug));
    const removed = [...baked.keys()].filter((slug) => !present.has(slug));
    return { changed, added, removed };
  }

  // 差分だけを載せてよいのは焼いた控えが在るときだけ: 無いと `diffAgainstBaked` は全文書を `added` に数えるが、「ここに出ていない文書はシステムプロンプトのまま」とは言えない（焼いた覚えが無い）ため。
  hasBakedMemory(): boolean {
    return this.#bakedMemory !== null;
  }

  // 差が空でも、焼いた控えが無ければ一致としない（`null` は全文を載せる側）
  matchesBakedMemory(documents: readonly MemoryDocument[]): boolean {
    if (this.#bakedMemory === null) return false;
    const diff = this.diffAgainstBaked(documents);
    return diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0;
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

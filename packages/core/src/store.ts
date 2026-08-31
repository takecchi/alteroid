import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';

import type { AuthStore } from './auth.js';
import type { ActiveAgentToken, AgentToken, TokenRotationSettings } from './token-pool.js';
import type {
  Commitment,
  CommitmentClosedBy,
  CommitmentEditedBy,
  InboxEvent,
  Job,
  JournalEntry,
  JournalEntryInput,
  JournalEntryType,
  MemoryDocument,
  MemoryDocumentMeta,
  MemoryProtectionStatus,
  PendingApproval,
  SchedulePhase,
  ScheduledRequest,
  UnreadableCommitment,
} from './schema.js';
import type {
  UsageAccumulation,
  UsageAggregate,
  UsageBaseline,
  UsageFold,
  UsageLayer,
  UsageQuery,
  UsageSite,
  UsageSnapshot,
} from './usage.js';

/**
 * ストアのインターフェース（docs/architecture.md「ストレージ」）。
 * ドライバは storage-fs（ローカル）/ storage-pg（M4）で差し替える。
 *
 * 接続情報を持つのはデーモンプロセスだけである（非対称な可視性）。
 * マネージャー子プロセスへこれらの実装を渡してはいけない。
 */

/**
 * 記憶の本文を保存する形へ正規化する — 末尾に改行が1つある形にする。
 *
 * **`PersonaStore` を実装する側は、これを自分で書き直さないでここを呼ぶこと。**
 * 出所がここに在るのは、複製された結果が実際に食い違ったからである（下の
 * `write` の doc、および #370）。
 */
export function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** 記憶 = 人間がいつでも読んで直せる Markdown 文書群（提供価値1）。 */
export interface PersonaStore {
  list(): Promise<MemoryDocumentMeta[]>;
  read(slug: string): Promise<MemoryDocument | null>;
  /**
   * 全文置換。存在しなければ作る。
   *
   * **契約: 書いた本文は、末尾の改行が正規化されて読み戻る。**
   * `write(slug, '# X')` の直後の `read(slug)` が返す `content` は `'# X\n'`
   * であって `'# X'` ではない。既に `\n` で終わっているなら足さない。
   * `bytes` も `content_sha256` も、この正規化を通した後の本文に対して数える。
   * **実装する側はこの正規化を自分で書かず、上の `ensureTrailingNewline` を
   * 通すこと。**
   *
   * **この契約は、かつて3実装のうち1つで守られていなかった（#370）。**
   * `ensureTrailingNewline` は `storage-fs` と `storage-pg` に逐語で複製されて
   * いて共有の出所が無く、3つ目（`testing.ts` のインメモリ）はそれを持たない
   * まま書かれた。結果、同じ `write(slug, '# X')` に対して `read()` が返す値が
   * 実装ごとに違い（fs / pg は `'# X\n'`、インメモリは `'# X'`）、
   * **`packages/core` の単体テストが当たるのは乖離を持っているインメモリの
   * ほうだけだった** — 本番と違う形のものを測って、本番を測ったことにして
   * いた。**同型の前科がもう1件、`memory.ts` の冒頭に記録されている**
   * （見出しを付けるか否かで、やはりインメモリだけが違っていた）。
   *
   * **いまは3実装とも上の `ensureTrailingNewline` を通していて、この契約には
   * 3実装それぞれに歯が当たっている**（fs: `packages/storage-fs/src/index.test.ts`
   * / pg: `packages/storage-pg/src/index.test.ts` / インメモリ:
   * `packages/core/src/persona-contract.test.ts`）。**4つ目を足すときは、
   * その歯も4つ目にする。** 1つで測って3つとも測ったことにしないのが、
   * この Issue の主題そのものである。
   */
  write(slug: string, content: string): Promise<MemoryDocument>;
  /**
   * 末尾に追記。存在しなければ作る。
   *
   * **契約: 既存の本文と追記の本文のあいだには、必ず空行が1つ入る。**
   * 既存が改行で終わっているかどうかで結果が変わってはいけない — 上の `write`
   * の正規化に頼らず、`append` の側でも `ensureTrailingNewline` を通すこと
   * （fs / pg はどちらもそうしている。#354 の変異試験は、この二重の守りの
   * 片方だけを外しても歯が落ちないことを実測している）。
   */
  append(slug: string, content: string): Promise<MemoryDocument>;
  remove(slug: string): Promise<void>;
  /**
   * 全文書を本文ごと、`slug` の昇順で返す。
   *
   * **かつてここは `concat(): Promise<string>` だった。** 器の側で1つの文字列に
   * 潰していたので、上の層は「どの文書が変わったか」を問えず、走行中に人間が1行
   * 直しただけで**記憶の全文をもう一度クローンの文脈へ載せていた**（システム
   * プロンプトに載っている分と合わせて二重に載る）。載せ方は
   * `renderMemoryDocuments`（`memory.ts`）が持ち、器は文書を渡すだけにする。
   */
  documents(): Promise<MemoryDocument[]>;

  /**
   * この文書の保護状態（`schema.ts` の `MemoryProtectionStatus`）を返す。
   *
   * **新しい真実ではない。** 実体は日誌（`memory_update.cause`）にあり、ここは
   * その派生値（pg: `memory` テーブルの2列 / fs: `.index.json`）を読んだ結果を
   * 返すだけである。派生値を失った・信用できないとき（fs で索引ファイルが無い・
   * 壊れている／内容のハッシュが `content_sha256` と一致しない＝デーモンを
   * 通さず誰かが書き換えた可能性がある）は `unknown`（守る側）を返す。
   *
   * **誰にも送られない。** HTTP / CLI / 道具のどの入力スキーマにも登場しない
   * — `tools.ts` の distill ガードと、状態を人間可読にする表示のためだけに
   * 内部で使う値である。
   */
  protectionStatus(slug: string): Promise<MemoryProtectionStatus>;

  /**
   * `cause:'human'` の `memory_update`（`action:'write'`）が記録されたことを、
   * 保護状態の派生値へ反映する。
   *
   * 呼ぶのは日誌へ `cause:'human'` を書く箇所（`apps/daemon/src/app.ts` の
   * `PUT /memory/:slug`）と、デーモン起動時の backfill（`apps/daemon/src/storage.ts`）
   * だけである。**新しく配線を増やす場所ではない。**
   *
   * **一度立てたら降ろさない。** `at` はその時点で分かっている human 書き込みの
   * 時刻で、既に持っている値より古ければ何もしない（新しい順に舐める backfill が
   * 呼んでも巻き戻らないため）。実体（`.md` ファイル / `memory` テーブルの行）が
   * 既に無い slug に対して呼ばれても、新しく行を作ってはいけない — 削除済みの
   * slug が空文字の「文書」として `list()` / `read()` に化けて出てくる。
   */
  markHumanTouched(slug: string, at: string): Promise<void>;

  /**
   * `createdAt` の派生値へ、日誌から導出した「最初に `action:'write'` で
   * 書かれた時刻」を反映する。
   *
   * 呼ぶのはデーモン起動時の backfill（`apps/daemon/src/storage.ts`）だけである。
   * **新しく配線を増やす場所ではない**（`markHumanTouched` と同じ約束）。
   *
   * **`createdAt` の第一の出所はこのメソッドではない。** ストア自身が
   * 書き込み経路（fs の `#writeNow` / pg の `write` と `append`）の中で、
   * その書き込みが文書を作った瞬間に直接 `createdAt` を立てる（記憶の
   * `createdAt` 対応）。このメソッドが担うのは、**その配線より前に作られた
   * 行**——書き込み経路がまだ見ていない昔の記憶——を日誌から埋める後始末
   * だけである。新しく作られる記憶にとって、このメソッドは通常呼ばれても
   * 何もしない（既に書き込み経路で値が入っているため、絶対条件2の
   * 「値が無いときだけ」に当たらない）。
   *
   * **`markHumanTouched` と違い、単調非減少ではない——一度きりの確定である。**
   * 既に値が入っている slug には何もしない（**冪等**。2回目以降の backfill は
   * 何も変えない）。実体が既に無い slug に対して呼ばれても、新しく行を作っては
   * いけない（`markHumanTouched` と同じ理由）。
   *
   * **`unknown` という値をストアへ書き込む口ではない。** 根拠が無い slug に
   * ついてはこのメソッドを呼ばないこと——値が無いこと自体が「根拠が無い」を
   * 表す（`memoryCreatedAtSchema` の doc）。読み出し側（`list()` / `read()`）が
   * 値の無い slug を `{ kind: 'unknown' }` として組み立てる。
   *
   * **戻り値は「実際に書いたか」。** `markHumanTouched` と違って `boolean` を
   * 返すのは、backfill が「何件埋めたか」を観測できる必要があるからである
   * （記憶の絶対条件5）。既に値が入っていた・実体が無い、のどちらでも `false`。
   */
  markCreatedAt(slug: string, at: string): Promise<boolean>;
}

/**
 * `exchange` の `with`（誰との往復か）。`journalEntrySchema` の `exchange` 枝
 * （`schema.ts`）から型だけを取り出す — 値の一覧をここへ複製しない。`with` を
 * 持つのは `exchange` だけである。
 */
export type ExchangeWith = Extract<JournalEntry, { type: 'exchange' }>['with'];

/**
 * `ExchangeWith` の値の一覧（`journal_read` ツールの zod の `enum` を組み立てる
 * ために要る——zod は型だけからは実行時の値を取り出せない）。
 *
 * **`schema.ts` の `journalEntrySchema`（正本）の値をここへ書き写したもので
 * はない——`satisfies Record<ExchangeWith, true>` で縛ってあるので、正本の
 * `with` に値が増減して `ExchangeWith` が変われば、ここがコンパイルエラーに
 * なる（`schema.ts` の `journalEntryTypeNames` が `JOURNAL_ENTRY_TYPES` を
 * 作るのと同じ形。あちらを踏襲した——`types` と `with` で違う流儀を作らない）。**
 */
const exchangeWithNames = {
  human: true,
  manager: true,
  self: true,
} satisfies Record<ExchangeWith, true>;

export const EXCHANGE_WITH_VALUES = Object.keys(exchangeWithNames) as [
  ExchangeWith,
  ...ExchangeWith[],
];

export interface JournalQuery {
  /**
   * 返す最大件数。
   *
   * **`0` = 0件（issue #425）。** 「絞らない」ではなく「0件くれ」という指定
   * として扱う——`with: []` と同じ理由（下の `with` の doc）。**契約
   * （3実装で揃える。`journal-query-edge-contract.ts` の
   * `verifyJournalStoreQueryEdgeContract` が測る）:**
   *
   * - `limit: 0` = 0件
   * - `limit: N`（`N >= 1`）は従来どおり N 件で切る——1文字も変えていない
   */
  limit?: number;
  /**
   * エントリの種別で絞る。
   *
   * **`types: []`（空配列）= 0件（issue #425）。** 「絞らない」ではなく
   * 「どれにも当たらない」という指定として扱う——`with: []` が #418 で
   * 「0件」に決まっている（下の `with` の doc）ので、それに揃えた。
   * **以前は pg だけが `types: []` を「絞らない」に倒していた**（`length
   * === 0` を特別扱いする条件を持っていたのが `types` の pg 実装だけ
   * だった。`packages/storage-pg/src/journal.ts` の `types` の行を参照）。
   * **契約（3実装で揃える。`journal-query-edge-contract.ts` の
   * `verifyJournalStoreQueryEdgeContract` が測る）:**
   *
   * - 未指定 = 絞らない（既存の挙動を1文字も変えない）
   * - 指定 = その種別だけを返す
   * - `[]` = 0件
   */
  types?: JournalEntryType[];
  /** ISO 8601。この時刻以降のエントリだけ返す。 */
  since?: string;
  /**
   * ISO 8601。この時刻以前のエントリだけ返す。
   *
   * **`since` だけでは過去の一区間を取れない。** 返るのは新しい順なので、
   * 「9時に何があったか」を聞いても手前に積まれた最新のものが `limit` を
   * 食い尽くし、狙った時刻には決して届かない（実際にそれで届かなかった）。
   * 窓の終端を閉じられて初めて、過去の一点を掘れる。
   */
  until?: string;
  /**
   * `exchange` を `with` で絞る（issue #418）。
   *
   * **契約（3実装 — `testing.ts` のインメモリ / `storage-fs` / `storage-pg` —
   * で揃える。3つとも歯を持つ。`journal-with-contract.ts` の
   * `verifyJournalStoreWithContract` が単一の契約として測る）:**
   *
   * - **未指定 = 絞らない。** 既存の挙動を1文字も変えない
   * - **指定 = その値の `exchange` だけを返す。** `with` を持たない種別
   *   （`decision` / `tool_use` 等）は `with` を持たないので、絞りを指定した
   *   時点で1件も返らない — `types` でそれらを別途除く必要はない
   * - **`[]`（空配列）= 0件。** 「どれにも当たらない」という指定として扱う。
   *   **この issue（#418）の時点では `types: []` の挙動が実装間で食い違って
   *   おり（インメモリ / fs は0件、pg は絞らない）、ここは`別に決めた`契約
   *   だった。#425 で `types` もここへ揃えた**（上の `types` の doc）ので、
   *   いまは同じ契約である
   * - **`limit` より前に効く。** ここが要点である — `GET /conversations` /
   *   `GET /conversations/:id` / `conversation_read` はいずれも
   *   `types: ['exchange']` で件数の窓を切ってから `with === 'human'` に
   *   絞っていたため、`with: 'manager'` / `with: 'self'` の行が `scan` の
   *   予算を食い尽くし、人間との会話が窓の外へ落ちていた（#418）。絞りを
   *   `limit` より前（ストアの側）へ移すことで、`scan` の予算を食うのは
   *   その `with` に当たる行だけになる。
   *
   * 組み立てるのは `conversation.ts` の `readConversationWindow` 1か所だけに
   * すること — 呼び出し口ごとに手で組むと、直したほうと忘れたほうで挙動が
   * ずれる（この issue の症状そのものの再発）。
   */
  with?: ExchangeWith[];
  /**
   * 本文を語で探す（issue #250）。
   *
   * **意味論は `conversation_read` の `q` をそのまま踏襲する。新しい検索の
   * 意味論を発明しない** —— `conversation.ts` の `searchExchanges`（「語で探す。
   * **大文字小文字を区別しない単純な部分一致だけを持つ。**」）と同じである。
   * 正規表現も AND/OR も無い。
   *
   * **どの欄を本文と見るかは `journal-search.ts` の
   * `SEARCHABLE_FIELDS_BY_TYPE` が唯一の正本である**（3実装がそこから式を
   * 組み立てる）。**`tool_use` の `input` / `worker_wait` / `turn_usage` は
   * 対象外** —— 理由と、そこから来る「当たらない ≠ 日誌に無い」は同ファイルの
   * doc が持つ。ここに書き写さない。
   *
   * **契約（3実装で揃える。`journal-search-contract.ts` の
   * `verifyJournalStoreSearchContract` が測る）:**
   *
   * - **未指定 = 絞らない**（既存の挙動を1文字も変えない）
   * - **指定 = 本文にその語を含む行だけを返す（大文字小文字を区別しない
   *   部分一致）**
   * - **`''`（空文字列）= 絞らない。** `types: []` / `with: []` の「0件」とは
   *   逆に見えるが逆ではない（`matchesJournalSearch` の doc —— あちらは許す値
   *   の集合で、空集合は何も許さない。こちらは探す語で、空の語はどの文字列にも
   *   含まれる）
   * - **`%` と `_` はワイルドカードではない。** pg 実装が `ILIKE` を使うので、
   *   ここを塞がないと **pg だけ**が `q: '50%'` で全件を返す。3実装で揃える
   *   対象そのものである
   * - **`limit` より前に効く**（`with` と同じ。#418 の穴の本体）。ここが崩れて
   *   いると、当たらない行が `limit` の予算を食い尽くし、狙った行が窓の外へ
   *   落ちる
   * - **適用順序は `types` / `with` / `since` / `until` と同じ段である**
   *   （下の `after` の doc の「`after` → 絞り込み → `limit`」の、絞り込みの側）
   */
  q?: string;
  /**
   * 返す順序（issue #432 の2本目）。**既定 `'desc'`**（新しい順＝従来の挙動を
   * 1バイトも変えない）。`'asc'` で古い順にできる。
   */
  order?: 'asc' | 'desc';
  /**
   * ページングの錨（issue #432 の2本目）。**この行の「次」（＝返る順序における
   * 次）から返す。** `order: 'desc'`（既定）なら錨より**古い**側、
   * `order: 'asc'` なら錨より**新しい**側が返る——「次」は時間の意味ではなく
   * 返る順序の意味である。
   *
   * **なぜ位置ではなく `(id, at)` の値で錨を指すか。** 日誌は追記専用で
   * `JournalStore`（本ファイル）に更新・削除の口が無い——既存の行どうしの
   * 前後関係は永久に変わらない。だから値そのものを錨にしても、頁の間に
   * 新しい行が追記されても位置がずれない（`/approvals` のカーソルが
   * `putApproval` による行の移動に耐えるために `(createdAt, id)` を使うのと
   * 同じ理由。あちらは移動に耐えるためだが、こちらは日誌が構造的に移動しない
   * ことそのものが理由である）。
   *
   * **`id` だけでは足りない。** `id` の一致だけで錨を引くと、fs 実装は
   * `at` からファイルを決める都合上 `at` に依存しており、pg / インメモリが
   * `at` を見なければ同じ入力で実装ごとに答えが違いうる。だから3実装とも
   * `id` **と** `at` の両方が一致する行を探すこと。
   *
   * **`at` だけでは足りない。** `at` はミリ秒精度の `new Date().toISOString()`
   * なので、同じミリ秒に2行積まれることがある（`id` はその同着を割るための
   * 補助キーである）。
   *
   * **契約（3実装 — `testing.ts` のインメモリ / `storage-fs` / `storage-pg` —
   * で揃える。3つとも歯を持つ。`journal-order-with-contract.ts` の
   * `verifyJournalStoreOrderContract` が単一の契約として測る）:**
   *
   * - **`id` と `at` の両方が一致する行が無ければ `JournalAnchorNotFoundError`
   *   を投げる。** 黙って「先頭から」に倒さない——判定できないという第3の
   *   状態を持つ（AGENTS.md「静かに失敗する道具」）。
   * - **適用順序: `after` → `types` / `with` / `q` / `since` / `until` → `limit`。**
   *   錨の位置は全順序（絞り込み前）の中で決め、そこから先を絞って、最後に
   *   切る。この順序が逆だと、絞りに当たらない行が錨と `limit` のあいだに
   *   挟まったとき（あるいは錨自体が絞りに当たらない種別のとき）に頁の連結が
   *   壊れる。
   */
  after?: { id: string; at: string };
}

/**
 * `JournalStore.list` の `after` で指定した錨（`{ id, at }`）が、`id` と `at`
 * の両方が一致する行として見つからないときに投げる専用のエラー型
 * （issue #432 の2本目）。
 *
 * **黙って「先頭から」に倒さないための型。** `after` が指す行は頁の継続点
 * そのものなので、見つからないことは「判定できない」という第3の状態であって
 * 「無かったので最初から返す」ではない（AGENTS.md「静かに失敗する道具」
 * 「判定できないという3つ目の状態を持つ」）。呼び出し側（`apps/daemon/src/app.ts`
 * の `GET /journal`）はこれを `instanceof` で捕まえて 400 へ変換する。
 *
 * `UnreadableCommitmentError` と同じ形（メッセージの文字列ではなく型で
 * 判定できるようにする）。
 */
export class JournalAnchorNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalAnchorNotFoundError';
  }
}

/** 日誌 = 追記専用の記録（PRD「可観測性」）。 */
export interface JournalStore {
  append(entry: JournalEntryInput): Promise<JournalEntry>;
  /**
   * 既定は新しい順（`order: 'desc'`）。**未指定は従来の挙動と1バイトも
   * 変わらない。** `order: 'asc'` で古い順に、`after` で頁の継続点を指定できる
   * （issue #432 の2本目。`JournalQuery.order` / `JournalQuery.after` の doc）。
   */
  list(query?: JournalQuery): Promise<JournalEntry[]>;
  /**
   * 1件を id で引く。
   *
   * **一覧を抜粋にするなら、全文への行き先が要る**（`manager_list` ↔
   * `manager_report` と同じ形）。無いと、抜粋にした時点で長い記録は
   * クローンから永久に読めなくなる＝能力の削除（north_star 禁止1）。
   */
  get(id: string): Promise<JournalEntry | null>;
}

/** ジョブと承認待ちキュー。M1 では承認待ちだけを使う。 */
export interface JobStore {
  listJobs(): Promise<Job[]>;
  putJob(job: Job): Promise<void>;

  listApprovals(options?: { pendingOnly?: boolean }): Promise<PendingApproval[]>;
  getApproval(id: string): Promise<PendingApproval | null>;
  putApproval(approval: PendingApproval): Promise<void>;
}

/**
 * 継続中の定期の依頼（PRD「自律」の起点②）。
 *
 * **人間の依頼のうち「これから先ずっと」の部分を持つ器である。** 会話は消え、
 * 受信箱は揮発し、記憶は根拠を持つ場所であって時計を持たない。ここが無いと
 * 「定期的に見ておいて」は次の compaction かデーモン再起動で静かに消える。
 *
 * 人間もここを読んで直せること（CLI / HTTP API）が要件である — 人間の制御手段は
 * 記憶・日誌・境界の3つだが、自分が出した継続の依頼が見えないのは可観測性の穴になる。
 */
export interface ScheduleStore {
  /** kind の昇順。 */
  list(): Promise<ScheduledRequest[]>;
  get(kind: string): Promise<ScheduledRequest | null>;
  /** 同じ kind があれば置き換える（`createdAt` は呼び出し側が引き継ぐ）。 */
  put(entry: ScheduledRequest): Promise<void>;
  remove(kind: string): Promise<void>;
  /**
   * 発火を確定させる。**読むことと記録することを1操作に閉じる。**
   *
   * `expectedUpdatedAt` と同じ版がまだ在るときだけ記録し、**確定した依頼（記録を
   * 進める前の姿）** を返す。消えていた・書き換わっていたら null。
   *
   * **これが2操作に分かれていると、読んでから記録するまでの隙間で人間が消した・
   * 直した依頼が古い本文で走る。** 「本文は処理する瞬間にストアから読む」という
   * 約束は、競合したときにこそ効かないと意味がない（消した依頼が外の世界に手を
   * 出したら取り返せない）。返り値が更新前の姿なのは、呼び出し側が「前回いつ
   * 動いたか」を材料として要るからである。
   *
   * ここで付けるのは **`pendingRun`（引き受けた印）と `lastRunAt`（観測用）だけ**で、
   * 定期の予定の基準（`lastScheduledRunAt`）は `completeRun` まで進めない。claim の
   * 直後に器が落ちたとき、その回が「もう動いた」ことになって消えないようにするため。
   */
  claimRun(
    kind: string,
    expectedUpdatedAt: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<ScheduledRequest | null>;

  /**
   * 引き受けた発火が終わったことを記録する。`pendingRun` を消し、`schedule` なら
   * 定期の予定の基準（`lastScheduledRunAt`）を進める。
   *
   * **`manual` では基準を動かさない**（手で起こした1回で予定をずらさない）。
   * 消えている kind、別の発火の印が付いている場合は何もしない。
   */
  completeRun(kind: string, at: string, cause: 'schedule' | 'manual'): Promise<void>;

  /**
   * 既定の仕込み（日報・発意 tick）の位相を読む。無ければ null。
   *
   * **依頼（`list()` / `get()`）とは別の器である。** 理由は `schedulePhaseSchema` に
   * 書いてある（1つにまとめると、既定の仕込みがクローンから継続中の依頼に見えて
   * `schedule_remove` で消せる）。**だから `list()` にこれを混ぜないこと。**
   */
  getPhase(kind: string): Promise<SchedulePhase | null>;

  /** 同じ kind があれば置き換える。 */
  putPhase(phase: SchedulePhase): Promise<void>;
}

/**
 * `CommitmentStore.get(id)` が、その行を `commitmentSchema` として読めなかった
 * ときに投げる専用のエラー型（issue #296）。
 *
 * **なぜ型を分けるか。** `get` は「無い（`null`）」と「読めない（throw）」を
 * 区別する契約のままだが（`CommitmentStore.get` の doc）、呼び出し側
 * （`commitment_list` ツールの全文モード、`tools.ts`）はその throw をさらに
 * 2種類へ割る必要がある — **台帳の1行が壊れているという性質**（`entries` /
 * `unreadable` と同じ第3の状態。安全側は「読めない」と伝えて返す）と、
 * **DB が落ちた・ファイルが読めない等の器そのものの障害**（安全側は握り潰さず
 * 上へ投げる）である。前者を後者と同じ扱いで握り潰すと、器の異常が
 * 「台帳が壊れている」に化けて見えなくなる。
 *
 * メッセージの文字列（`/読めない形/` 等）で判定するのは、メッセージの言い回し
 * を直しただけで判定が静かに外れる脆さがあるので、`instanceof` で見分けられる
 * 専用のクラスを立てる。
 */
export class UnreadableCommitmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableCommitmentError';
  }
}

/**
 * `CommitmentStore.list` の返り値（issue #296）。
 *
 * **`Commitment[]` のままにしなかったのは、呼び出し側が握り潰せない形にする
 * ためである。** 台帳の1行が保存されている形（enum の値など）と、いま動いて
 * いるコードが読める形は、将来ずれうる（`schema.ts` の `unreadableCommitmentSchema`
 * の doc）。ずれた行を空配列（無い）へ潰すと、`parseCommitment`
 * （`packages/storage-pg/src/commitments.ts`）の doc が防ごうとしている結末 —
 * クローンが引き受けたことを二度と思い出さない — へそのまま着く。件数や
 * ログではなく型を変えるのは、`entries` だけを見て `unreadable` を読み飛ばす
 * ことは書けても、`CommitmentList` を受け取っておいて `unreadable` が
 * コンパイラの目に触れないことはできない、という違いのためである。
 */
export interface CommitmentList {
  entries: Commitment[];
  /** 読めなかった行。**「無い」でも「片付いた」でもない第3の状態。** */
  unreadable: UnreadableCommitment[];
  /**
   * `close()` の契約（「行は消さない」）を実装が守れなかった回数の累計 — 保持
   * 上限を超えて物理削除された、片付いた行の件数（issue #416）。
   *
   * **`unreadable` と同じ理由で型に足す。** 削除という事象を件数やログではなく
   * 型で持たせるのは、`CommitmentList` を受け取っておいて `unreadable` は読んで
   * `trimmedClosed` は読み飛ばす、ということは書けても、このフィールドそのものが
   * コンパイラの目に触れないことはできないからである。「合図が無い」
   * （issue #416 の1点目）はこの欄が塞ぐ。
   *
   * **契約を守れている実装は常に `0` を返す。** いまのところ `storage-pg`
   * （`PgCommitmentStore`）と in-memory（`packages/core/src/testing.ts`）が
   * それで、`storage-fs`（`FsCommitmentStore`）だけが `CLOSED_HISTORY_LIMIT`
   * （`packages/storage-fs/src/commitments.ts`）を超えた古い片付き行を物理削除
   * するのでこの値を増やしうる。**0 は「削除を数えていない」ではなく「削除が
   * 起きていない」を意味する** — 契約を守る実装には削除という事象自体が無い。
   *
   * **3実装の保持方針を揃えるかどうかは、この欄の追加では決まらない**
   * （issue #416 のコメントに測った根拠を置いてある）。揃っていない事実を
   * 隠さずに運ぶのがこの欄の役目であって、揃える判断そのものは別に要る。
   */
  trimmedClosed: number;
}

/**
 * 引き受けたまま終わっていない仕事の台帳（`schema.ts` の `Commitment`）。
 *
 * **受信箱（`InboxStore`）とは守るものが違う。** あちらが持つのは「その合図がまだ
 * モデルに届いていない」という配達の状態で、ターンが終われば消える。こちらが持つのは
 * 「頼まれたことがまだ片付いていない」という**仕事の状態**で、ターンが終わっても
 * 残る。片方でもう片方を代用できないので、両方要る。
 *
 * **省略可能にしないこと**（`schedules` / `inbox` と同じ理由）。ここが任意だと、
 * 片方の器でだけ依頼が黙って消えるという能力差が生まれる（north_star 禁止1）。
 */
export interface CommitmentStore {
  /**
   * 台帳を返す。**未了は古い順**（齢が判断の材料なので、古いものから見せる）、
   * 片付いたものは新しい順で未了の後ろに続く。
   *
   * `includeClosed` を省いたら未了だけ。
   *
   * **1行が読めなくても、その行だけが `unreadable` へ回り `entries` は返る**
   * （issue #296）。`entries` の順序・件数は「読めた行だけで見たときの」台帳の
   * 姿であって、読めなかった行はどこにも数え上げに紛れ込まない。
   */
  list(options?: { includeClosed?: boolean }): Promise<CommitmentList>;

  /**
   * 1件を読む。**「無い（`null`）」と「読めない」は別物**——単票なので
   * `list()` のように隔離する一覧が無く、この区別を型（`CommitmentList`）へ
   * 逃がす先も無い。読めない行は `UnreadableCommitmentError`（本ファイル）を
   * 投げる。呼び出し側（`commitment_list` ツール、`tools.ts`）はこれを
   * `instanceof` で捕まえ、「読めない」を text として返す——それ以外の
   * 例外（器そのものの障害）は捕まえずに上へ通す。
   */
  get(id: string): Promise<Commitment | null>;

  /**
   * 未了として開く。**同じ id が既に在れば何もしない**（開いたら `true`）。
   *
   * **冪等であることがこの器の要である。** 受信箱の合図は配り直されうるので
   * （`InboxStore` の取引）、その id をそのまま使う自動 open は同じ id で二度呼ばれる。
   * 上書きしてしまうと、**一度片付けた仕事が配り直しのたびに開き直る** — 器が落ちる
   * たびに終わったはずの依頼が蘇り、クローンが同じ仕事を二度起こす。
   */
  open(entry: Commitment): Promise<boolean>;

  /**
   * 片付いたことを記録する。閉じたら `true`、無い id と既に閉じているものは `false`。
   *
   * **契約は「行は消さない」である。** 消すと「何を片付けたか」が日報の材料から
   * 落ちる。人間が普段読むのは日報だけである（PRD「可観測性」）。
   *
   * **⚠️ ただし `storage-fs`（`FsCommitmentStore`）はこの契約を完全には守れて
   * いない（issue #416）。** fs 版は毎回ファイル全体を書き直す器なので、片付いた
   * 行を無限に積むと1回の書き込み費用が台帳の齢に比例して増える——それを避ける
   * ため `CLOSED_HISTORY_LIMIT`（`packages/storage-fs/src/commitments.ts`）件を
   * 超えた古い片付き行を新しい順に切り詰め、超えた分は物理削除する（`trimClosed`）。
   * **`storage-pg` と in-memory（`packages/core/src/testing.ts`）はこの上限を
   * 持たず、契約どおり行を消さない。** 3実装の保持方針をどちらへ揃えるかは別途の
   * 判断であって、この doc の修正だけでは揃わない。
   * **実装が行を消したら、消した累計件数を `CommitmentList.trimmedClosed` で
   * 申告すること** — 契約からの逸脱を型の外で握り潰さない（`CommitmentList`
   * の doc）。
   *
   * **`by` は必須である。** optional にすると、呼び出し側が「誰が閉じたか」を
   * 決めずに通せてしまう — 実際には全ての呼び出し元（`commitment_close` ツール /
   * `POST /commitments/:id/close`）が閉じた主体を知っているので、必須にすれば
   * 決めていない呼び出しはコンパイルエラーで立ち止まる（issue #286）。
   */
  close(id: string, at: string, reason: string, by: CommitmentClosedBy): Promise<boolean>;

  /**
   * `body` を書き換える。**まだ片付いていない行だけを書き換える** — 片付いて
   * いる行・無い id は `false` を返す。
   *
   * **書き換えるのは `body` / `editedAt` / `editedBy` の3つだけである。**
   * `origin` / `source` / `at` / `closedAt` / `closedReason` / `closedBy` には
   * 触れない。
   *
   * **`origin` が何であるかの判定はここでは行わない。** `origin` は
   * 開いたときから決して変わらない値なので、並行に呼ばれても競合しない——
   * 競合しうるのは「まだ閉じていない」という不変条件だけである。**競合する
   * 不変条件だけを台帳の1操作へ畳み、競合しない方針判断（どの `origin` の行を
   * 直してよいか）は呼び出し側へ残す**（AGENTS.md「不変条件はストアの1操作に
   * 閉じること」と同じ考え方——`close()` が `where ... and closed_at is null`
   * だけを SQL 側へ畳み、`by` の決定は呼び出し側に残しているのと対になる）。
   *
   * **`by` は必須である。** 理由は `close` の `by` と同じ（`close` の doc を
   * 見よ）——optional にすると、呼び出し側が「誰が直したか」を決めずに通せて
   * しまう。呼び出し元は2つあり、**どちらも「自分が書いた行を自分で直す」形に
   * なっている**（`commitmentSchema.editedAt` の doc）：
   *
   * - `PATCH /commitments/:id`（`apps/daemon/src/app.ts`）— `origin: 'human'`
   *   の行だけを直し、`'human'` を渡す
   * - `commitment_edit`（`packages/core/src/tools.ts`）— `origin: 'self'`
   *   の行だけを直し、`'clone'` を渡す（issue #580 の (B)）
   *
   * **⚠️ かつてここには「実際の呼び出し元（`PATCH /commitments/:id`）は常に
   * `'human'` を渡す（クローン向けの編集ツールは無い）」と書いてあった。
   * issue #580 でそれが偽になった。**
   *
   * **⚠️ そして呼び出し側にはもう1つ義務がある — 編集の前後の本文を日誌へ
   * 逐語で残すこと。** 台帳が守っているのは不変性ではなく追跡可能性なので
   * （`commitmentSchema.editedAt` の doc）、原文が日誌から読み戻せない編集の
   * 口を足すと、その線が壊れる。**ここ（ストア）はそれを強制できない** —
   * 日誌は別のストアであり、この署名からは見えない。新しい呼び出し元を足す
   * なら、`journal.append` を必ず対にすること。
   */
  editBody(id: string, body: string, at: string, by: CommitmentEditedBy): Promise<boolean>;
}

/**
 * まだ処理し終えていない受信箱の合図（PRD「可観測性」/ architecture.md「同時実行モデル」）。
 *
 * **受信箱そのものはインメモリでよい。ここが持つのは「まだ終えていない」という事実だけ**
 * である。デーモンが落ちたとき、`Inbox` の `#queue` に居たものも、`#waiters` へ直接
 * 渡されて一度も queue を通らなかったものも、同じように消える。消えるのは人間の発言・
 * webhook・マネージャーの報告＝**判断の材料**であって、失われたことに気づく手段も無い。
 *
 * **境界は「`post` が受理した時点」であって「queue に入った時点」ではない。** クローンが
 * 暇なときに届いた合図は `Inbox#push` の waiter 経路を通って queue を素通りするので、
 * 「落ちる前に queue を吐き出す」形の永続化はその経路を1件も救わない。
 *
 * **消し込みは「処理を終えた時点」である**（取り出した時点ではない）。取り出した時点で
 * 消すと、処理の途中でプロセスが死んだものが失われる＝いま塞いでいる穴がそのまま残る。
 * したがって同じ合図が二度処理されうるが、**二度届く（雑音）より消える（判断材料の
 * 喪失）方が高い**。二度目だと分かる形にすることでこの取引を成立させる（`deliveries`）。
 *
 * **本文を持つ。** ここは日誌やジョブ台帳と同じ記憶ストアの中で、本文を持つ器は既に
 * ある（新しい露出面ではない）。持たなければ拾い直せないので、持たない選択は無い。
 * ただし**書けなかったときに外へ出す跡には本文を載せない**（`dropped-record.ts`）。
 */
export interface InboxStore {
  /**
   * 受け取った合図を未読として置く。同じ id なら上書きする（配達回数は保つ）。
   *
   * **`post` が受理した順に呼ばれるが、書けた順は保証されない。** 呼び出し側は
   * 消し込みがこの書き込みを追い越さないようにすること（追い越すと、消したはずの
   * 合図が後から書かれて永久に配り直される）。
   */
  put(event: InboxEvent, at: string): Promise<void>;

  /** 処理を終えた合図を消す。無ければ何もしない。 */
  remove(id: string): Promise<void>;

  /**
   * 残っている未読を古い順に返し、**同時に配達回数を1つ進める**。
   *
   * **読むことと回数を進めることを1操作に閉じること**（`ScheduleStore.claimRun` と
   * 同じ作法）。分けると、配り直しの途中で落ちたときに回数が進まず、「何回目の配達か」
   * が嘘になる。回数はクローンが毒（＝配り直すたびに器ごと落ちる合図）を見分ける
   * ための唯一の材料なので、**これは実行回数の制限ではない**（AGENTS.md 地雷2）—
   * 何回目であっても配ることは変わらない。
   */
  claimPending(): Promise<PendingInboxEvent[]>;

  /**
   * 残っている未読の件数と、いちばん古いものが積まれた時刻（#358）。
   * **`claimPending()` と違い、配達回数を進めない。**
   *
   * `manager_list` のような一覧が「デーモン→クローンの脚で詰まっているか」を
   * 覗くための読み取り専用の口。配達回数（`deliveries`）は「配り直された」
   * ことを示す唯一の材料（`claimPending` の doc）で、覗いただけで進めると、
   * まだ一度も配っていない合図が「前に配ったが終わらなかった」と嘘をつく。
   *
   * 1件も無ければ `oldestAt` は無い（0件のときに値を作らない。AGENTS.md
   * 「取れない軸に0の行を作る」）。
   */
  pending(): Promise<{ count: number; oldestAt?: string }>;
}

/** 未読として残っていた合図1件。 */
export interface PendingInboxEvent {
  event: InboxEvent;
  /** `post` が受理した時刻（ISO 8601）。 */
  at: string;
  /**
   * 何度目の配達か。`1` は「初めて配る」＝一度も配られずに器が落ちた。
   * `2` 以上は「前に配ったが、終える前にまた落ちた」。
   */
  deliveries: number;
}

/** セッションの生ログ退避先（PreCompact フックで落とす）。 */
export interface TranscriptArchive {
  /** 退避したアーカイブのパス（または識別子）を返す。 */
  archive(sessionId: string, transcript: string): Promise<string>;
  list(): Promise<string[]>;
  read(id: string): Promise<string | null>;
}

/**
 * 実行環境プロファイル（人間の `.zprofile` / `.zshenv` に当たるもの）。
 *
 * **記憶ではない。** 人格は記憶（Markdown）に宿るのであって、鍵や `PATH` の話は
 * そこに混ぜない。器を作り直しても残るという性質だけが同じなので、同じストアの
 * 一員として持つ。
 *
 * 持つのはデーモンだけである。runner は自分で読みに行かず、**降ってきたものを
 * 器に置くだけ**にしてある（読みに行けるということは、runner から記憶ストアへの
 * 経路があるということで、それは M4 の受け入れ基準3 が無いと言っているものである）。
 */
export interface EnvProfile {
  /** 人間が書いたシェルスクリプトそのもの。器は中身を解釈しない。 */
  script: string;
  updatedAt: string;
}

export interface ProfileStore {
  /** 置かれていなければ null。 */
  read(): Promise<EnvProfile | null>;
  /** 全文置換。空文字は「プロファイルを外す」。 */
  write(script: string): Promise<EnvProfile>;
  /**
   * **取り消した更新をなかったことにする**（本文と更新日時を組で戻す）。
   *
   * `write` で戻すと本文は元に戻っても `updatedAt` が失敗した時刻へ進む。
   * そこは「人間かクローンが最後に**本文を変えた**時刻」であって、`profile status`
   * と `GET /profile` が見せる監査情報である。成功していない更新でそこが動くと、
   * 起動のたびに動いていたときと同じ意味の壊れ方をする。
   *
   * `null` は「置かれていなかった状態へ戻す」。**通常の書き込みに使わないこと** —
   * 更新日時を呼び出し側が決められる口なので、失敗の巻き戻し専用である。
   */
  revert(previous: EnvProfile | null): Promise<void>;
}

/**
 * 認証トークンのプール（Issue #393「プールの器」）。**回さない。** 検知も切替も
 * ここには無い——ここが持つのは置き場と、置いたものを読み書きする口だけである。
 *
 * `env_profile` と同じ形（正本はデーモンが持ち、器違い（fs / pg）は挙動を変えない）。
 * `Stores` の一員として持つのは、環境を作り直しても残るという性質が同じだからである。
 */
export interface TokenPoolStore {
  /** プールの全行（**値を含む**。正本を返す口はここだけである）。`order` 昇順。 */
  list(): Promise<AgentToken[]>;
  /** 全文置換。**入力に無い行は消える。** */
  replace(tokens: readonly AgentToken[]): Promise<AgentToken[]>;
  /** 回す契機と冷却の既定。置かれていなければ core の既定（`DEFAULT_TOKEN_ROTATION_SETTINGS`）を返す。 */
  readSettings(): Promise<TokenRotationSettings>;
  writeSettings(settings: TokenRotationSettings): Promise<TokenRotationSettings>;
  /**
   * いま撒いてある現役の指名（Issue #393 PR3）。**まだ一度も指名していなければ
   * `null`。**
   *
   * **`null` を「1本目が現役」で埋めないこと。** 器の環境変数だけで走っている
   * 既定の構成と、プールの1本目を撒いた後は別の状態である——前者では runner にも
   * クローンにも何も降ろしていない。埋めると、撒いていないものを撒いたことに
   * なる（受け入れ基準7: 既定の構成の挙動を1文字も変えない）。
   */
  readActive(): Promise<ActiveAgentToken | null>;
  /** 現役を指名し直す。**世代を増やすのは呼ぶ側**（この口は受けた値を書くだけ）。 */
  writeActive(active: ActiveAgentToken): Promise<ActiveAgentToken>;
}

/**
 * 利用状況の台帳（`usage.ts`）。
 *
 * **持つのはデーモンだけである。** runner に持たせると記憶ストアの鍵が要る
 * （M4 受け入れ基準3）。runner から降りてくるのは累積スナップショットという
 * 事実だけで、差分にして積むのはここ。
 */
export interface UsageStore {
  /**
   * 累積スナップショットを台帳へ畳み込む。
   *
   * **読むことと書くことを1操作に閉じること。** 基準を読んでから増分を書くまでの
   * 隙間で同じマネージャーの次の `result` が届くと、同じ増分が2回積まれる。
   * pg はトランザクション、fs は1回の書き込みで守る（`auth-service` と同じ作法）。
   *
   * 返すのは**実際に積んだ増分**と、数え直しが起きたならその事実。呼び出し側は
   * それを日誌へ落とす（黙って数え直さない）。
   */
  record(input: {
    /** **誰が**使ったか。モデル id で代用しないこと（`usage.ts` の `usageLayerSchema`）。 */
    layer: UsageLayer;
    /** **どこで**使ったか。 */
    site: UsageSite;
    /** 誰の分か（マネージャーの id か `CLONE_ACTOR_ID`）。 */
    managerId: string;
    /** ローカル時刻の `YYYY-MM-DD`（`usageDate()` で作る）。 */
    date: string;
    at: string;
    snapshot: UsageSnapshot;
    /**
     * 累積の器がどこで閉じるか。**既定を持たせないこと。**
     *
     * 黙って `cumulative` に倒すと、1回で閉じる `query()` の高くついた回だけが
     * 目減りする（`usage.ts` の {@link foldOneshotUsage}）。呼ぶ側が毎回言う。
     */
    accumulation: UsageAccumulation;
    /**
     * **どの認証トークンで**使ったか（`AgentToken.id`。Issue #393 受け入れ基準6）。
     *
     * **省略は「取れなかった」であって「既定のトークン」ではない。** プールが空の
     * 器では現役の指名が無いので毎回省略される。**呼ぶ側は分からないときに何かを
     * 埋めないこと** — 埋めた瞬間、その id で使った分として集計に出る（AGENTS.md
     * 地雷表「取れない軸に 0 の行を作る」の同型）。
     *
     * **渡すのは「そのセッションが起きた瞬間の身元」である。** 観測のたびに現役を
     * 読み直すと、回した後に届いた前のセッションぶんの消費が新しいトークンに付く
     * （`manager.ts` の `#tokenIdentities` が同じ理由で在る）。
     */
    tokenId?: string;
  }): Promise<UsageFold>;

  /**
   * 期間の集計。日 × actor × モデル × 層 × 場所 × 認証トークンの行を返す。
   *
   * **`since` を必ず載せること。** 台帳が始まる前を照会されたら 0 ではなく
   * 「記録が無い」と言えるようにするためである（過去分の掘り起こしはしない）。
   *
   * **`layersSince` も必ず載せること。** 層の軸は台帳より後から入ったので、
   * それより前の行の `layer` / `site` は既定値であって観測ではない。
   *
   * **`tokensSince` も必ず載せること。** トークンの軸は後から入ったうえに、
   * **プールを使っていない器では最後まで始まらない。** ここが null のまま
   * `since` だけ載っていると、読む側は「トークンの内訳が空」を「1本のトークンで
   * 全部使った」と読みうる。
   */
  aggregate(query: UsageQuery): Promise<UsageAggregate>;

  /**
   * 累積を持つ主体1つの現在の基準（前回読んだ累積）。無ければ null。
   *
   * **鍵は「層 × actor」である。** actor の id だけで引くと、層をまたいで同じ id が
   * 来たときに別の累積が1つの基準を共有し、差分がまるごと嘘になる。
   */
  baseline(layer: UsageLayer, managerId: string): Promise<UsageBaseline | null>;

  /**
   * 台帳（`usage_daily`）に1行でも行が在る managerId の集合（Issue #98
   * 「台帳が取りこぼした委譲」）。
   *
   * **引数を持たない。** `aggregate()` のように `from` / `to` で絞れる形にすると、
   * 呼ぶ側が誤って絞り込んだ結果を「行が在る managerId の集合」として使いうる —
   * それをやると、照会範囲の外で記録された委譲が「記録が無い」に化ける（5月に
   * 走った委譲を今日の範囲で照会したときに取りこぼしとして数えられる）。**この
   * 判定は全期間でなければ成り立たない**ので、引数を持たせないこと自体で
   * その事故を構造的に防ぐ。
   *
   * **`aggregate()` の `rows` から作らないこと。** 呼び出し側が `aggregate({})`
   * （絞り込み無し）を呼べば同じ集合が作れるように見えるが、それは「今この瞬間の
   * 全件」を毎回読み直す高コストな経路になる。ここは器（fs / pg）が持つ索引や
   * 集合演算で答えられる別の口として持つ——pg なら `usage_daily` の
   * `(manager_id, date)` 索引を使った `distinct` で足りる。
   *
   * **基準（`usage_baseline`）ではなく行（`usage_daily`）を見ること。** 基準は
   * ゼロだけのスナップショットからでも作られうる（`foldUsageSnapshot` の
   * doc）ので、基準の有無で数えると「記録が無い」と「$0.00 使った」が混ざる。
   *
   * 使うのは `ManagerPool.list()` で得た全委譲との突き合わせ
   * （{@link findUnrecordedManagers}、`usage-format.ts`）だけである——`UsageStore`
   * は `ManagerPool` を知らないので、突き合わせそのものは呼び出し側（`app.ts` /
   * `tools.ts`）が行う。
   */
  recordedManagerIds(): Promise<Set<string>>;
}

/**
 * **記憶へ移せなかった区間の墓標**（Issue #564 E1b）。
 *
 * 退避（`TranscriptArchive.archive`）は済んでいるが、蒸留が落ちた区間を指す。
 * ⟹ 次の起動が `archive.read(archiveId)` で拾い直して蒸留できる。
 *
 * ## なぜ指すのが `archive` の id で、セッション id ではないのか
 *
 * **印を立てるのは蒸留が落ちた後であり、その時点でセッション id は既に捨てられている**
 * （`clone.ts` の「resume すると同じ長すぎる会話が戻ってくる」の枝が、畳むと決めた
 * 瞬間に `setCloneSessionId(null)` を打つ）。⟹ セッション id を控える形にすると
 * 「捨てるのと印を立てるのを同じ操作にする」という順序の約束が要る。
 *
 * **`archive` の id はセッション id の生死と無関係なので、その約束が要らない。**
 * ⟹ 順序を守り損ねて静かに拾えなくなる形が、構造的に消える。
 */
export interface TranscriptGrave {
  /** `TranscriptArchive.archive()` が返した id。 */
  archiveId: string;
}

/**
 * クローンのセッション id と、記憶へ移せなかった区間の墓標を跨いで覚えておくための
 * 最小の永続化。
 *
 * ## ⚠️ 墓標はセッション id と**別の欄**に置くこと（器の実装の約束）
 *
 * `setCloneSessionId(null)` は resume 素材を捨てる操作であり、**fs 実装は置き場の
 * ファイルを丸ごと消す。** ⟹ 同じレコードに同居させると、resume を捨てた瞬間に
 * 墓標も消える —— **拾い直すために立てた印が、拾う理由ができた瞬間に消える。**
 */
export interface SessionRegistry {
  getCloneSessionId(): Promise<string | null>;
  setCloneSessionId(sessionId: string | null): Promise<void>;
  /**
   * 墓標を読む。**高々1つしか持たない。**
   *
   * 代償: **2回続けて蒸留に失敗すると、古い方が失われる。** 数える単位を増やす
   * （列にする）と、拾い切れなかった墓標が積もる側の面倒が入れ替わりで増える。
   * ⟹ #564 が数えているのは「1区間」なので、高々1つで釣り合う。
   */
  getTranscriptGrave(): Promise<TranscriptGrave | null>;
  setTranscriptGrave(grave: TranscriptGrave | null): Promise<void>;
  /**
   * **resume 素材を捨てた回の墓標**（#564 E1b。`TranscriptGrave` とは別の欄）。
   *
   * ## なぜ `TranscriptGrave` と同じ欄にしないのか
   *
   * **同時に立ちうるからである。** 文脈窓で畳む回（退避は済んでいる）と、次の起動が
   * セッションを開けなかった回（退避が無い）は**別々に起きる。** 1つの欄に相乗りさせると、
   * **後に立った方が前の方を消す** —— 消えた側は誰も拾わない。
   *
   * ⟹ 指す先が違い（`archive` / pg の生ログ）、立つ契機も違うので、欄を分ける。
   * **どちらも「高々1つ」である**（同じ種類が2回続いたら古い方が失われる、は変わらない）。
   */
  getLostSessionGrave(): Promise<LostSessionGrave | null>;
  setLostSessionGrave(grave: LostSessionGrave | null): Promise<void>;
  /**
   * SDK が生ログを預けるときの scope（`SessionKey.projectKey`）を、**器を跨いで**覚える。
   *
   * ## なぜ持ち越す必要があるのか
   *
   * この値は `append` が渡してくるものなので、**`append` が1度も来ていないプロセスは
   * 知らない。** そして墓標を立てたい回（`init` すら来ずに落ちた回）は、まさに
   * **そのプロセスで `append` が1度も来ていない回である** —— 起き直して resume に
   * 失敗した直後がそれで、`#564` が数えている経路そのものである。
   *
   * ⟹ 前の器が覚えた値をここから読む。**`cwd` から計算し直さないこと**
   * （`LostSessionGrave` の doc）。
   *
   * ⚠️ **配備してから1度も `append` が来ていないうちは `null` である。** その窓で
   * 落ちた回は墓標が立たない（拾う鍵が無い）。
   */
  getProjectKey(): Promise<string | null>;
  setProjectKey(projectKey: string): Promise<void>;
}

/**
 * **resume 素材を捨てた回に、その区間を後から引くための鍵**（#564 E1b）。
 *
 * `init` すら来ずにセッションが落ちた回は、`clone.ts` が resume 素材（セッション id）を
 * 捨てる。**そこで捨てた id が、pg に載っている生ログを引く唯一の鍵である。**
 * ⟹ 捨てる前にここへ写しておかないと、区間は pg に在るのに誰も引けなくなる。
 *
 * ## なぜ `projectKey` も要るのか
 *
 * SDK の `SessionStore` は `projectKey` + `sessionId` の対で引く口しか持たない。
 * そして **`projectKey` を `cwd` から計算し直さないこと** —— SDK の型定義が逐語で
 * 「Default: sanitized cwd. Paths longer than 200 characters are truncated and
 * suffixed with a portable djb2 hash」と書いており、再実装は静かにずれる。
 * ⟹ `append` が渡してくる値をそのまま控える（`clone.ts` の `withProjectKeyProbe`）。
 */
export interface LostSessionGrave {
  projectKey: string;
  sessionId: string;
}

/**
 * pg に載っている生ログの**末尾だけ**を読む口（#564 E1b）。
 *
 * ## なぜ `SessionStore.load()` を使わないのか
 *
 * あちらは**全件**を戻す。実測でクローンの生ログは 1 セッションで 580 MB 級に育ち、
 * SDK は `load()` に **60 秒の予算**を掛けている（`Options.loadTimeoutMs` の既定）。
 * ⟹ 拾い直しのために全件を戻すと、**その予算に設計が自分から当たりに行く。**
 *
 * **蒸留が読むのは末尾だけである**（`clone.ts` の `tailOf`）。⟹ 末尾を返す口を分ける。
 *
 * ## ⚠️ pg 構成でだけ付く
 *
 * `sessionStore` と同じである（`Stores.sessionStore` の doc）。fs 構成には生ログの
 * 預け先そのものが無いので、**この口も無い。**
 */
export interface SessionTranscriptTail {
  /**
   * 末尾から `maxChars` 文字ぶんを返す。**1本も無ければ `null`。**
   *
   * 返すのは生ログ（JSONL）の形そのままで、**行の途中から始まりうる。** 整えるのは
   * 呼び出し側（`tailOf`）である —— 器ごとに整え方が分かれると、蒸留へ渡るものが
   * 器で変わる。
   */
  readTail(key: LostSessionGrave, maxChars: number): Promise<string | null>;
}

/** デーモンが必要とするストア一式。 */
export interface Stores {
  persona: PersonaStore;
  journal: JournalStore;
  jobs: JobStore;
  /**
   * 継続中の定期の依頼。
   *
   * **省略可能にしないこと。** 器（fs / pg）が違うだけで上の層が見るものは同じで
   * ある、が M4 の要件である。ここを任意にすると、片方の器では「定期的にやって」が
   * 効かないという能力差が生まれる（north_star 禁止1）。
   */
  schedules: ScheduleStore;
  /**
   * まだ処理し終えていない受信箱の合図。
   *
   * **省略可能にしないこと**（`schedules` / `usage` と同じ理由）。ここが任意だと、
   * 片方の器でだけデーモンの死で未読が消えるという能力差が生まれる（north_star 禁止1）。
   */
  inbox: InboxStore;
  /**
   * 引き受けたまま終わっていない仕事の台帳。
   *
   * **省略可能にしないこと**（`inbox` と同じ理由）。ここが任意だと、片方の器でだけ
   * 「その場で着手しなかった依頼が黙って消える」という能力差が生まれる。
   */
  commitments: CommitmentStore;
  archive: TranscriptArchive;
  sessions: SessionRegistry;
  /**
   * ログインしたアカウントと、alteroid を使ってよいかの2値（`auth.ts`）。
   *
   * **これは「誰がこの API に触れるか」の話であって、PRD「権限境界」（クローンが
   * 記憶を根拠に何を人間へ確認するか）とは別の層である。** 混ぜてはいけない。
   */
  auth: AuthStore;
  /**
   * 実行環境プロファイル（`.zprofile` 相当）。**環境変数を器に増やす代わりの口**で
   * あり、用途が増えるたびに実装を直さずに済ませるためにここに置く。
   */
  profile: ProfileStore;
  /**
   * 認証トークンのプール（Issue #393）。
   *
   * **省略可能にしないこと**（`schedules` / `inbox` と同じ理由）。器が違うだけで
   * 上の層が見るものは同じである、という約束をここでも保つ——ここを任意にすると、
   * 片方の器でだけ「枠に当たったときに他のトークンへ回せる」という能力差が
   * 生まれる（north_star 禁止1）。
   */
  tokens: TokenPoolStore;
  /**
   * 利用状況の台帳。
   *
   * **省略可能にしないこと**（`schedules` と同じ理由）。器が違うだけで上の層が
   * 見るものは同じである、が M4 の要件で、ここを任意にすると「pg では消費が
   * 見えるが fs では見えない」という能力差が生まれる（north_star 禁止1）。
   */
  usage: UsageStore;
  /**
   * SDK のセッション生ログの預け先（M4 のクラウド構成でだけ付く）。
   *
   * **manager-runner はこれを持たない。** runner から預かった生ログをここへ落とすのは
   * デーモンであり、runner には記憶ストアへ到達する鍵を渡さない
   * （docs/architecture.md「非対称な可視性」）。
   */
  sessionStore?: SessionStore;
  /**
   * 預けた生ログの**末尾だけ**を読む口（#564 E1b）。`sessionStore` と対で付く。
   *
   * **省略可能なのは `sessionStore` と同じ理由である**（M4 のクラウド構成でだけ付く）。
   * ⟹ fs 構成では拾い直せない。それは能力差だが、**fs には生ログの預け先そのものが
   * 無い**ので、ここだけ揃えても埋まらない（`SessionTranscriptTail` の doc）。
   */
  sessionTranscriptTail?: SessionTranscriptTail;
}

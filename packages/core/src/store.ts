import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'node:crypto';

import type { ArchiveContinuity } from './archive-continuity.js';
import type { AttachmentStore } from './attachment.js';
import type { AuthStore } from './auth.js';
import type { CodexChatgptAuthStore } from './codex-chatgpt-auth.js';
import type { IntegrationKeyStore } from './integration-key.js';
import type {
  ConversationBaselineResult,
  ConversationOutboundIndex,
  ConversationOutboundIndexRead,
  ConversationReadPosition,
  ConversationReadRead,
} from './conversation-read.js';
import type { CredentialEntry } from './credentials.js';
import type { McpServers, StoredMcpServers, WriteMcpServersOptions } from './mcp-servers.js';
import type { PluginInput, PluginSummary, StoredPlugin } from './plugins.js';
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
  PermissionGrant,
  Practice,
  PracticeMeta,
  PracticeVersion,
  PracticeVersionMeta,
  SchedulePhase,
  ScheduledRequest,
  ScheduleSpec,
  UnreadableApproval,
  UnreadableCommitment,
  UnreadableInboxEvent,
  UnreadableJob,
  UnreadablePermissionGrant,
  UnreadablePractice,
  UnreadableSchedule,
  UnreadableToken,
} from './schema.js';
import type {
  UsageAccumulation,
  UsageAggregate,
  UsageBaseline,
  UsageFold,
  UsageRecordRunner,
  UsageLayer,
  UsageQuery,
  UsageSite,
  UsageSnapshot,
} from './usage.js';

/**
 * ストアのインターフェース（docs/architecture.md「ストレージ」）。
 * 接続情報を持つのはデーモンプロセスだけである。マネージャー子プロセスへこれらの実装を渡さない。
 */

/**
 * 記憶の本文を保存する形へ正規化する（末尾に改行が1つある形）。
 * `PersonaStore` の実装は自分で書き直さずここを呼ぶ: 複製すると3実装の読み戻しが食い違うため。
 */
export function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * 記憶文書の「版」。保存された本文（正規化後の `content`）の sha256 hex。
 * `updatedAt` にしない: fs の mtime の精度では同じ時刻内の2回の書き込みを区別できず、3実装が同じ式で出せないため。
 */
export function memoryVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** `PersonaStore.write` の任意の引数。 */
export interface WriteMemoryOptions {
  /** 前提の版（`memoryVersion`）。書く瞬間の版と違えば書かず `MemoryConflictError`。`null` は「無いときだけ書ける」、省略は後勝ち。 */
  ifMatch?: string | null;
}

/** `PersonaStore.remove` の任意の引数。 */
export interface RemoveMemoryOptions {
  /** 前提の版（`memoryVersion`）。合わなければ消さず `MemoryConflictError`。省略は無条件。 */
  ifMatch?: string;
}

/** 前提の版が合わず、書かなかった。`current` はいまの文書（無ければ `null`）。 */
export class MemoryConflictError extends Error {
  readonly current: MemoryDocument | null;
  constructor(slug: string, current: MemoryDocument | null) {
    super(`記憶が読んだ後に変わっています: ${slug}`);
    this.name = 'MemoryConflictError';
    this.current = current;
  }
}

/** 前提の版 `ifMatch` が、いまの文書と合うか（`undefined` は前提なし＝常に合う）。 */
export function memoryVersionMatches(
  current: { content: string } | null,
  ifMatch: string | null | undefined,
): boolean {
  if (ifMatch === undefined) return true;
  if (ifMatch === null) return current === null;
  return current !== null && memoryVersion(current.content) === ifMatch;
}

/** 記憶 = 人間がいつでも読んで直せる Markdown 文書群（提供価値1）。 */
export interface PersonaStore {
  /**
   * **slug の昇順。**（#662 の継続点が依拠する契約）
   *
   * `memory_list` の継続点（`memory-cursor.ts`）が並びに全面的に依拠するので、偶然揃っている状態にしない。
   * 照合順序の厳密な一致までは保証しない: 継続点は位置の探索を第一にし、比較は錨が消えたときの保険に留める。
   */
  list(): Promise<MemoryDocumentMeta[]>;
  read(slug: string): Promise<MemoryDocument | null>;
  /**
   * 全文置換。存在しなければ作る。
   *
   * **書いた本文は、末尾の改行が正規化されて読み戻る**（`write(slug, '# X')` → `read` は `'# X\n'`）。
   * `bytes` も `content_sha256` も正規化後の本文で数える。実装は自分で正規化せず `ensureTrailingNewline` を通す:
   * 複製したせいでインメモリだけ読み戻しが違い、単体テストが乖離した側だけを測っていた。
   * 実装を足すときは、fs / pg / インメモリ（`persona-contract.test.ts`）と同じ歯を足す。
   *
   * `options.ifMatch` の比較は書き込みと同じ排他の中で行う（fs: `#serialize` の内側、pg: 条件付きの1文）。
   * 本文の NUL は、fs も含めて落として残す（slug は `memorySlugSchema` が NUL ごと弾く）。
   */
  write(slug: string, content: string, options?: WriteMemoryOptions): Promise<MemoryDocument>;
  /**
   * 末尾に追記。存在しなければ作る。
   * 既存の本文とのあいだには必ず空行が1つ入る: `write` の正規化に頼らず `append` でも `ensureTrailingNewline` を通す（二重の守り）。
   */
  append(slug: string, content: string): Promise<MemoryDocument>;
  /** 文書を消す。無ければ何もしない（冪等）。`options.ifMatch` の比較は排他の中（`write` と同じ）。 */
  remove(slug: string, options?: RemoveMemoryOptions): Promise<void>;
  /**
   * 全文書を本文ごと、`slug` の昇順で返す。
   * 器は文書を渡すだけにする: 1つの文字列に潰すと、人間が1行直しただけで記憶の全文をクローンの文脈へ載せ直すことになる
   * （載せ方は `renderMemoryDocuments`〈`memory.ts`〉が持つ）。
   */
  documents(): Promise<MemoryDocument[]>;

  /** 全文書を消す（ワークスペースのリセット専用）。保護状態（`human_touched_at` 等）も同じ行・ファイルに乗っているので一緒に消える。消した件数を返す。 */
  clear(): Promise<number>;

  /**
   * この文書の保護状態。新しい真実ではなく、日誌（`memory_update.cause`）の派生値（pg: `memory` テーブルの2列 / fs: `.index.json`）を読むだけ。
   * 派生値を失った・信用できないとき（索引が無い・壊れている・内容のハッシュが `content_sha256` と不一致）は `unknown`（守る側）を返す。
   * 誰にも送られない（HTTP / CLI / 道具の入力スキーマに出さない）。
   */
  protectionStatus(slug: string): Promise<MemoryProtectionStatus>;

  /**
   * `cause:'human'` の `memory_update`（`action:'write'`）が記録されたことを、保護状態の派生値へ反映する。
   * 呼ぶのは日誌へ `cause:'human'` を書く箇所（`PUT /memory/:slug`）と起動時の backfill だけで、配線を増やす場所ではない。
   *
   * 一度立てたら降ろさない: 既に持つ値より古い `at` では何もしない（新しい順に舐める backfill で巻き戻らないため）。
   * 実体が無い slug に対して行を作らない: 削除済みの slug が空文字の「文書」として `list()` / `read()` に化ける。
   */
  markHumanTouched(slug: string, at: string): Promise<void>;

  /**
   * `createdAt` の派生値へ、日誌から導出した「最初に `action:'write'` で書かれた時刻」を反映する。呼ぶのは起動時の backfill だけ。
   * `markHumanTouched` と違い一度きりの確定: 既に値がある slug には何もしない。実体が無い slug に行を作らない。
   * 根拠が無い slug には呼ばない（値が無いこと自体が「根拠が無い」を表す。`memoryCreatedAtSchema`）。戻り値は「実際に書いたか」（backfill が何件埋めたかの観測に要る）。
   */
  markCreatedAt(slug: string, at: string): Promise<boolean>;
}

/** `exchange` の `with`（誰との往復か）。`journalEntrySchema` から型だけを取り出す（値の一覧を複製しない）。 */
export type ExchangeWith = Extract<JournalEntry, { type: 'exchange' }>['with'];

/** `satisfies Record<ExchangeWith, true>` で縛ってあり、正本の `with` が増減すればここがコンパイルエラーになる。 */
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
   * 返す最大件数。**`0` = 0件**（「絞らない」ではない。`with: []` と同じ）。
   * 3実装で揃える契約は `verifyJournalStoreQueryEdgeContract` が測る。掛かるのは「ストアの問い合わせ」の引数だけで、面の側の絞り（`manager_list` の `status` など）は別。
   */
  limit?: number;
  /** エントリの種別で絞る。未指定 = 絞らない、`[]` = 0件（`with: []` と揃える。契約は `verifyJournalStoreQueryEdgeContract`）。 */
  types?: JournalEntryType[];
  /** ISO 8601。この時刻以降のエントリだけ返す。 */
  since?: string;
  /**
   * ISO 8601。この時刻以前のエントリだけ返す。
   * 閉じない: `since` だけだと返るのは新しい順なので、手前の最新が `limit` を食い尽くして過去の一点に届かない。
   */
  until?: string;
  /**
   * `exchange` を `with` で絞る。契約は `verifyJournalStoreWithContract` が3実装に当てる:
   *
   * - 未指定 = 絞らない。指定 = その値の `exchange` だけ（`with` を持たない種別は1件も返らない）。`[]` = 0件
   * - **`limit` より前に効く**: 件数の窓を切ってから絞ると、他の `with` の行が `scan` の予算を食い尽くし、人間との会話が窓の外へ落ちる
   *
   * 組み立てるのは `conversation.ts` の `readConversationWindow` 1か所だけにする: 呼び出し口ごとに手で組むと、直したほうと忘れたほうで挙動がずれる。
   */
  with?: ExchangeWith[];
  /**
   * 本文を語で探す。意味論は `conversation_read` の `q`（`conversation.ts` の `searchExchanges`）を踏襲し、
   * 大文字小文字を区別しない単純な部分一致だけ（新しい検索の意味論を発明しない）。どの欄を本文と見るかの正本は `journal-search.ts` の `SEARCHABLE_FIELDS_BY_TYPE`。
   * 契約は `verifyJournalStoreSearchContract` が3実装に当てる:
   *
   * - 未指定も `''` も絞らない（空の語はどの文字列にも含まれる）
   * - `%` と `_` はワイルドカードではない: pg が `ILIKE` を使うので、塞がないと pg だけが `q: '50%'` で全件を返す
   * - `limit` より前に効く（`with` と同じ。適用順序は `after` → 絞り込み → `limit`）
   */
  q?: string;
  /** 返す順序。既定 `'desc'`（新しい順）。`'asc'` で古い順。 */
  order?: 'asc' | 'desc';
  /**
   * ページングの錨。**この行の「次」（返る順序における次）から返す。**
   * `desc` なら錨より古い側、`asc` なら錨より新しい側。
   *
   * `(id, at)` の値で錨を指す: 日誌は追記専用で行どうしの前後関係が永久に変わらないので、頁の間に追記されても位置がずれない。
   * `id` だけでは足りない: fs は `at` からファイルを決める都合で `at` に依存し、pg / インメモリが `at` を見なければ実装ごとに答えが違う。
   * `at` だけでも足りない: ミリ秒精度なので同着がありうる。
   *
   * 契約は `verifyJournalStoreOrderContract` が3実装に当てる:
   *
   * - 一致する行が無ければ `JournalAnchorNotFoundError`。黙って「先頭から」に倒さない（判定できないという第3の状態）
   * - 適用順序: `after` → `types` / `with` / `q` / `since` / `until` → `limit`。錨の位置は絞り込み前の全順序で決める
   *   （逆だと、絞りに当たらない行が錨と `limit` のあいだに挟まったとき頁の連結が壊れる）
   */
  after?: { id: string; at: string };
}

/**
 * `JournalQuery.after` の錨（`{ id, at }`）が見つからないときに投げる。
 * 黙って「先頭から」に倒さない: `after` は頁の継続点そのものなので、見つからないことは「判定できない」である。
 */
export class JournalAnchorNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalAnchorNotFoundError';
  }
}

/**
 * 日誌の頁の継続点。`JournalQuery.after` へそのまま渡せる形。
 * 返った行の最後ではなく、ストアが実際に読んだ最後の行（形が合わず捨てた行を含む）を指す。
 */
export type JournalCursor = { id: string; at: string };

/** `JournalStore.listPage` の返り値。 */
export interface JournalPage {
  /** `list()` と同じ中身（読めた行だけ）。 */
  entries: JournalEntry[];
  /** 次の頁の継続点。`null` = ストアの上でもうこの先に行が無い。非 `null` なら `entries` が空でもありうる（頁の行が全部読めずに捨てられたとき）。 */
  next: JournalCursor | null;
}

/** 日誌 = 追記専用の記録（PRD「可観測性」）。 */
export interface JournalStore {
  append(entry: JournalEntryInput): Promise<JournalEntry>;
  /** 既定は新しい順（`order: 'desc'`）。`order` / `after` は `JournalQuery` の doc。 */
  list(query?: JournalQuery): Promise<JournalEntry[]>;
  /**
   * `list()` と同じ問い合わせに、続きの有無と次の頁の継続点を添えて返す。
   *
   * 終端をストア自身が言う: pg の `list()` は `LIMIT` の後で形の合わない行を捨てるので、件数が少ないことも空であることも「その先に行が無い」を意味しない。
   * そこから終端を推すと、読めない行の向こうの古い行を静かに取りこぼす。
   * `next === null` は、読めない行も含めて続きがもう無いことだけを意味する（`limit` 未指定・`0` のときは常に `null`）。
   */
  listPage(query?: JournalQuery): Promise<JournalPage>;
  /**
   * 1件を id で引く。一覧を抜粋にするなら全文への行き先が要る（無いと長い記録がクローンから永久に読めなくなる＝能力の削除。north_star 禁止1）。
   *
   * `id`・`after.id`・`q` に NUL があっても断らず、「無い」と同じ結果（`get` は `null`、`after` は `JournalAnchorNotFoundError`、`q` は0件）を返す。本文の NUL は落として残す（3実装とも）。
   *
   * 「無い」と「在るが読めない」を分ける: 無い id は `null`、行が在るのに `journalEntrySchema` に合わないときは `UnreadableJournalEntryError`
   * （`null` に畳むと呼び出し元が「まだ書かれていない」と言ってしまう）。fs・pg が投げ（`verifyJournalStoreUnreadableGetContract`）、インメモリは読めない行を持てないので投げない。
   */
  get(id: string): Promise<JournalEntry | null>;

  /**
   * 日誌の地平（最古の行の `at`）。1件も無ければ `null`。
   * `since`/`until` で掘って0件のとき、「その窓に行が無い」のか「日誌がその窓まで遡れない」のかを `list()` の0件からは区別できない。
   * 毎回全件走査で取らない: 3実装とも索引に乗る形で最初の1行だけを引く（pg は `journal_at_idx` の `ORDER BY at ASC LIMIT 1`）。
   */
  oldestAt(): Promise<string | null>;

  /**
   * 全件を消す（ワークスペースのリセット専用）。「追記専用」の契約への例外で、呼ぶのは `resetWorkspaceState` だけ。
   * 日誌の「聞かずに実行した判断は必ず残る」は、通常運用で消せないことではなく、リセットが常に人間の明示的な決定を経ることで保たれる。消した件数を返す。
   */
  clear(): Promise<number>;
}

/**
 * `JobStore.updateJob()` が、id の行は在るが読めない（`jobSchema` に合わない）ときに投げる。
 * `instanceof` で見分けること: メッセージの文字列で判定すると言い回しの修正で静かに外れる。
 * id 以外の値は持たない: job の欄には人間の依頼文・マネージャーの報告がそのまま入りうる。
 */
export class UnreadableJobError extends Error {
  readonly id: string;

  constructor(params: { id: string; reason?: string }) {
    super(
      `job ${JSON.stringify(params.id)} は読めない形で入っている（消されたのではない）` +
        (params.reason === undefined ? '' : `: ${params.reason}`),
    );
    this.name = 'UnreadableJobError';
    this.id = params.id;
  }
}

/**
 * `JobStore.getApproval()` / `updateApproval()` が、id の行は在るが読めないときに投げる（`UnreadableJobError` と同じ線）。
 * id 以外の値は持たない: 承認の欄には質問文・人間の回答がそのまま入りうる。
 */
export class UnreadableApprovalError extends Error {
  readonly id: string;

  constructor(params: { id: string; reason?: string }) {
    super(
      `承認待ち ${params.id} は在るが読めない（壊れた行。消されたのではない）` +
        (params.reason === undefined ? '' : `: ${params.reason}`),
    );
    this.name = 'UnreadableApprovalError';
    this.id = params.id;
  }
}

/**
 * `JournalStore.get()` が、id の行は在るが読めないときに投げる（`UnreadableApprovalError` と同じ線）。行は1バイトも変えない（日誌は追記専用）。
 * id 以外の値は持たない: 日誌の欄には人間の発言・クローンの判断の本文がそのまま入りうる。
 * インメモリ実装（`testing.ts`）は投げない: `append` が `journalEntrySchema` で断るので読めない行を持てない。
 */
export class UnreadableJournalEntryError extends Error {
  readonly id: string;

  constructor(params: { id: string; reason?: string }) {
    super(
      `日誌 ${params.id} は在るが読めない（壊れた行。消されたのでも、無いのでもない）` +
        (params.reason === undefined ? '' : `: ${params.reason}`),
    );
    this.name = 'UnreadableJournalEntryError';
    this.id = params.id;
  }
}

/**
 * `PermissionGrantStore.revoke()` が、id の行は在るが読めないときに投げる（`UnreadableJobError` と同じ線）。行は1バイトも変えない。
 * 取り消しは効いていないので、呼び手は「取り消した」とも「無い」とも言わず「読めない形で入っている」と言う。
 * 許可が余計に通る向きにはならない（読めない行は `list()` / `get()` に現れず「許可が無い」扱い）。id 以外の値は持たない: 許可の欄には人間の回答の原文が入りうる。
 */
export class UnreadablePermissionGrantError extends Error {
  readonly id: string;

  constructor(params: { id: string; reason?: string }) {
    super(
      `許可 ${params.id} は在るが読めない（壊れた行。消されたのでも、取り消されたのでもない）` +
        (params.reason === undefined ? '' : `: ${params.reason}`),
    );
    this.name = 'UnreadablePermissionGrantError';
    this.id = params.id;
  }
}

/**
 * `AuthStore.revokeAccountAccess()` が、id の行は在るが読めないときに投げる（`UnreadablePermissionGrantError` と同じ線）。
 * 読めない行は `getAccount()` / `listAccounts()` に現れないので認可は通らない（fail-closed）。id 以外の値は持たない。
 */
export class UnreadableAccountError extends Error {
  readonly id: string;

  constructor(params: { id: string; reason?: string }) {
    super(
      `アカウント ${params.id} は在るが読めない（壊れた行。消されたのでも、許可が落ちたのでもない）` +
        (params.reason === undefined ? '' : `: ${params.reason}`),
    );
    this.name = 'UnreadableAccountError';
    this.id = params.id;
  }
}

/**
 * `JobStore.listApprovals` の返り値（`CommitmentList` と同じ形）。
 * `PendingApproval[]` のままにしない: 読めない行を空配列へ潰すと、人間もクローンも読めない承認待ちが在ることに気づけない。
 */
export interface ApprovalList {
  entries: PendingApproval[];
  /**
   * 読めなかった行。「無い」でも「回答済み」でもない第3の状態。一覧全体は落とさない。
   * `pendingOnly: true` のとき、回答済み・取り下げ済みと分かる行は含めない（pg は列で、fs は生の行の `answeredAt` / `withdrawnAt` で見る）。どちらも取れない行は含める（数える側へ倒す）。
   */
  unreadable: UnreadableApproval[];
}

/**
 * 読めない承認待ちが在るときの1文（0件なら `null`）。
 * 0件のときは何も出さない: 「読めない承認待ちは 0 件」の行を作らない（AGENTS.md「取れない軸に 0 の行を作る」）。本文は載せない（`unreadableApprovalSchema` の doc）。
 */
export function describeUnreadableApprovals(
  unreadable: readonly UnreadableApproval[],
  options: { idLimit?: number } = {},
): string | null {
  if (unreadable.length === 0) return null;
  const idLimit = options.idLimit ?? 10;
  const ids = unreadable.flatMap((row) => (row.id === undefined ? [] : [row.id]));
  const shown = ids.slice(0, idLimit);
  const idNote =
    ids.length === 0
      ? '（id も取れない）'
      : `（id: ${shown.join(', ')}` +
        (ids.length > shown.length ? ` ほか ${ids.length - shown.length} 件` : '') +
        (ids.length < unreadable.length
          ? `。id が取れない行が ${unreadable.length - ids.length} 件`
          : '') +
        '）';
  return (
    `読めない承認待ちが ${unreadable.length} 件ある${idNote}。` +
    '壊れた行であって、回答済み・取り下げ済みではない。この一覧には載っていない。'
  );
}

/** 読めない委譲の行が在るときの1文（0件なら `null`。0件のときは何も出さない）。本文は載せない（`unreadableJobSchema` の doc）。 */
export function describeUnreadableJobs(
  unreadable: readonly UnreadableJob[],
  options: { idLimit?: number } = {},
): string | null {
  if (unreadable.length === 0) return null;
  const idLimit = options.idLimit ?? 10;
  const ids = unreadable.flatMap((row) => (row.id === undefined ? [] : [row.id]));
  const shown = ids.slice(0, idLimit);
  const idNote =
    ids.length === 0
      ? '（id も取れない）'
      : `（id: ${shown.join(', ')}` +
        (ids.length > shown.length ? ` ほか ${ids.length - shown.length} 件` : '') +
        (ids.length < unreadable.length
          ? `。id が取れない行が ${unreadable.length - ids.length} 件`
          : '') +
        '）';
  return (
    `読めない委譲が ${unreadable.length} 件ある${idNote}。` +
    '壊れた行であって、居ないのでも、畳まれたのでもない。この一覧には載っていない。'
  );
}

/**
 * id を1本指して引いたとき、その id の行が読めない形で在ることの1文（`describeUnreadableJobs` の単票版）。本文は載せない。
 * 見つからなかったときだけ `JobStore.listUnreadableJobs()` を読んで使う。
 */
export function describeUnreadableManagerRow(id: string, reason: string): string {
  return (
    `マネージャー ${id} は読めない形で入っている（消されたのでも、畳まれたのでもない）。` +
    `理由: ${reason}。本文はここでは取れない。`
  );
}

/**
 * 会話の既読の位置と基準時刻（`conversation-read.ts`）。全員で1組（PRD「非ゴール」: 利用者ごとにデータを分けない）。
 *
 * `clear()` を持たない: `POST /reset` で会話の日誌は消え、残った位置が既読にする相手は居ない。
 * 基準時刻が残るので、リセット後に始まった会話は未読になる。
 */
export interface ConversationReadStore {
  /** 基準時刻と位置のすべて。読めなければ `unreadable`（「無い」と混ぜない）。 */
  read(): Promise<ConversationReadRead>;
  /** 基準時刻が無ければ `at` で決め、在れば何もしない。並行して呼ばれても1つに決まる。記録が読めないときは書き換えず `unreadable` を返す。 */
  ensureBaseline(at: string): Promise<ConversationBaselineResult>;
  /**
   * 会話 `conversationId` の位置を `readThrough` まで進める。戻らない（いまの位置より古い値では何もせず、いまの位置を返す。並行2本でも単調）。
   * 記録が読めない状態ならこの会話の位置で書き直す。`conversationId` は鍵なので、NUL があれば `NulNotAllowedError`。
   */
  advance(conversationId: string, readThrough: string): Promise<ConversationReadPosition>;
  /** 「会話ごとの最後のクローン側発言の時刻」の索引（`ConversationOutboundIndex`）。 */
  readOutboundIndex(): Promise<ConversationOutboundIndexRead>;
  /** 索引へ足す。単調（古い値では戻らない。`watermark: null` は「進めない」）。`lastOutbound` の会話 id に NUL があれば `NulNotAllowedError` で、何も足さない。 */
  mergeOutboundIndex(update: ConversationOutboundIndex): Promise<void>;
  /** 索引だけを空にする（`POST /reset` が日誌を消すとき、消えた会話を未読に数え続けないため）。 */
  clearOutboundIndex(): Promise<void>;
}

/**
 * ジョブと承認待ちキュー。
 *
 * NUL: `putJob`・`putApproval` の `id`（鍵）は `NulNotAllowedError` で断り、本文（`summary`・`request`・`lastReport`・`question`・`context`・`answer`）は落として残す（3実装とも）。
 * 読むだけの口（`getApproval`・`updateJob`・`updateApproval`）は NUL を含む `id` でも断らず `null` を返す（`mutate` は呼ばない）。
 * 参照キー・印（`conversationId`・`managerId`・`jobId`・`requestId` など）と `questions` / `selections` の中の文字列も落として残す:
 * 自分の行を指す鍵ではなく、断ると記録が丸ごと落ちる。
 */
export interface JobStore {
  listJobs(): Promise<Job[]>;
  /**
   * `listJobs()` が読み飛ばした行（`jobSchema` に合わない行）を、本文を含まない形で返す。
   * 0件のときだけ「委譲は居ない」と言える（`listApprovals()` の `unreadable` と対）。メモリ実装は常に空。
   *
   * `listJobs()` の戻り型を変えない: 呼び手が約64か所あり、大半は読めない行を見せる先を持たないので、型を変えても気づける呼び手が増えない。
   * 見せる先（`manager_list`・`GET /managers`・digest・進捗）だけがこの口を呼ぶ。本文は返さない（`unreadableJobSchema` の doc）。
   */
  listUnreadableJobs(): Promise<UnreadableJob[]>;
  putJob(job: Job): Promise<void>;

  /**
   * 現在の値を排他区間の中で読み直し、`mutate` で書き換えて書く。書き込んだ後の値を返す。
   * `listJobs()` → `putJob()` の間に別の書き込みが挟まると、その書き込みが古いスナップショットに丸ごと上書きされて消える。
   *
   * `mutate` は同期の関数: 区間の中で `await` を挟むと排他の外へ出る（fs は `withPathLock`、pg は `select … for update` のトランザクションの中でだけ意味を持つ）。
   * 無ければ何もせず `null`。読めない行は `null` ではなく `UnreadableJobError`（`mutate` は呼ばれず、行にも触れない）:
   * `null` に畳むと呼び出し元が「台帳に居ない」と言い切るうえ、版ずれの行を古い版が上書きしてしまう。メモリ実装は `putJob` がスキーマを通すので投げない。
   */
  updateJob(id: string, mutate: (current: Job) => Job): Promise<Job | null>;

  /**
   * 承認待ちの一覧。読めない行（`pendingApprovalSchema` に合わない行）は一覧全体を落とさず `unreadable` に別欄で返す
   * （`CommitmentStore.list` と同じ形）。メモリ実装は常に空。並び順は契約しない。
   *
   * `conversationId` を渡すと `entries` をその会話の確認だけに絞る（`pendingOnly` と併用可。並びは変えない）。
   * `unreadable` も会話で絞る: 生の行の `conversationId` がその会話と一致する読めない行だけが載る。
   * 会話の id すら読めない行と他の会話の壊れた行は載らない（全行を検査せずに済ませるため。壊れた行は `conversationId` なしの呼びで全件見える）。
   * 3実装で揃える（`verifyApprovalConversationFilterContract`）。
   */
  listApprovals(options?: {
    pendingOnly?: boolean;
    conversationId?: string;
  }): Promise<ApprovalList>;
  /** 承認待ち1件を id で読む。無ければ `null`。在るが読めない行は `UnreadableApprovalError`（`null` に畳むと呼び出し元が「存在しない」と言い切る）。メモリ実装は投げない。 */
  getApproval(id: string): Promise<PendingApproval | null>;
  putApproval(approval: PendingApproval): Promise<void>;

  /**
   * 現在の値を排他区間の中で読み直し、`mutate` で書き換えて書く（`updateJob` と同じ形）。
   * 回答と取り下げが「読んでから書く」だと排他が無く、ほぼ同時の2つの回答が両方「まだ回答済みではない」と読んで仕事が2回再開しうる。
   * 取り下げと回答が重なると、取り下げたはずの承認に回答が立って再開まで進みうる。
   *
   * 無ければ何もせず `null`。読めない行は `UnreadableApprovalError`（`mutate` は呼ばれず、行にも触れない）。
   * `mutate` が書かないと決めたとき（既に `answeredAt` か `withdrawnAt` が立っている）は `null` を返せて、何も書かない。
   * 「行が無い」と「`mutate` が断った」は同じ `null` なので、区別したい呼び出し側は `mutate` が呼ばれたかを自分のクロージャで覚える。
   */
  updateApproval(
    id: string,
    mutate: (current: PendingApproval) => PendingApproval | null,
  ): Promise<PendingApproval | null>;

  /** ジョブと承認待ちを両方とも消す（ワークスペースのリセット専用）。この2つは1枚のストアなので1操作で消す。 */
  clear(): Promise<{ jobs: number; approvals: number }>;
}

/** 読めない行を id で指して消す口（`PermissionGrantStore.removeUnreadable` / `AuthStore.removeUnreadableAccounts`）の追加の引数。 */
export interface RemoveUnreadableRowsOptions {
  /**
   * 消すと決まった id（読めない行に実在するものだけ）を、消す前に、書き込みの排他区間の中で呼ぶ。
   * 投げたら何も消さずに投げ直す（日誌を先に書き、書けなければ状態を変えない作法のための口）。
   */
  beforeRemove?: (ids: readonly string[]) => Promise<void>;
}

/** 読めない行を id で指して消した結果。値（行の中身）は持たず、件数と id だけ。 */
export type RemoveUnreadableRowsResult =
  { kind: 'removed'; ids: string[] } | { kind: 'unknown'; count: number };

/**
 * 人間が承認した Bash 許可の記録。
 *
 * `clear()` を持たない（意図してである）: `POST /reset` はこのストアに触れない。
 * 人間が承認した許可は、記憶や日誌をリセットしても黙って失われるべきではない（消したいなら `revoke` を明示的に叩く）。
 *
 * `list()` を毎回ストアを引き直す前提で使う呼び手が居る（`clone.ts` の `#onPreToolUse`。Bash 呼び出しのたびに呼ぶ）。
 * キャッシュを実装側に足さない: 「取り消しは次の呼び出しから効く」が崩れる。
 */
export interface PermissionGrantStore {
  list(): Promise<PermissionGrant[]>;
  get(id: string): Promise<PermissionGrant | null>;
  /**
   * 新規作成専用。既存行の更新には使わない（`revoke` / `markUsed` が居る理由は各 doc）。
   *
   * `id`・`approvalId`・`route.accountId`（鍵・参照キー）に NUL があれば `NulNotAllowedError` で断る。`rule`・`allows`・`denies`・`answer`（本文）は落として残す。
   * 読むだけの口（`get`・`revoke`・`markUsed`・`removeUnreadable`）は、NUL を含む `id` でも断らず「無い」と同じ結果
   * （`get` / `revoke` は `null`、`markUsed` は `false`、`removeUnreadable` は `unknown`）を返す: 書き込みで NUL の鍵を断るので、NUL を含む `id` の行はどの器にも存在しえない。pg は DB に投げる前に短絡する。
   */
  put(grant: PermissionGrant): Promise<void>;

  /**
   * 取り消す（人間の `POST /permission-grants/:id/revoke`）。排他区間の中で現在値を読み直し、`revokedAt` だけを立てる。
   * 無ければ `null`。既に取り消し済みなら元の `revokedAt` を保つ。書いた後の全体を返す。
   *
   * `get()` → `put({ ...grant, revokedAt })` で代用しない: `put()` は無条件の全置換で、間に `#onPreToolUse` の古い写し
   * （`revokedAt` が無い）の書き戻しが割り込むと、取り消した許可が生き返る。
   *
   * 読めない行は書き換えず、「無い」（`null`）とは分けて `UnreadablePermissionGrantError` を投げる:
   * `null` にすると呼び手が「無い」と言い切り、取り消したつもりの行が残ったまま、後で読めるようになったときに許可が生き返る。
   * 読めない行の許可は「許可が無い」扱いなので、投げても許可が余計に通ることは無い（fail-closed）。
   */
  revoke(id: string, at: string): Promise<PermissionGrant | null>;

  /**
   * `#onPreToolUse` が許可を消費するたびに `lastUsedAt` だけを進める（排他区間の中で現在値を読み直す。`revokedAt` を含む他の欄には触れない）。無ければ何もしない。
   *
   * 既存より古い時刻では戻さない: 遅延した呼び出しが新しいほうを巻き戻すと「最後に使った時刻」の意味が崩れる。
   * `get()` → `put({ ...grant, lastUsedAt })` で代用しない: 間に人間の `revoke` が割り込むと、古い写しの書き戻しで取り消しが消える。
   *
   * 取り消されていれば記録せず `false`。返すのは「排他区間の中で、許可が在り取り消されていなかったか」で、`lastUsedAt` を進めたかではない
   * （古い時刻で進めなかった回も `true`）。`#onPreToolUse` は `list()` の写しで照合するので、判断をこの戻り値に寄せないと、
   * 「取り消した」が人間に返った後にもその許可で道具が通りうる。無い id・読めない行も `false`。
   */
  markUsed(id: string, at: string): Promise<boolean>;

  /**
   * `list()` が読み飛ばした行（`permissionGrantSchema` に合わない行）を、本文を含まない形（id と不正な欄名だけ）で返す
   * （`TokenPoolStore.listUnreadable` と同じ線）。読めない行しか無いと `list()` は空で「許可が無い」と読める。
   * 許可の本文（`allows` / `denies` / `answer` など）は決して返さない（`unreadablePermissionGrantSchema`）。id が取れない行（fs のみ）は `id` を持たない。メモリ実装は常に空。
   */
  listUnreadable(): Promise<UnreadablePermissionGrant[]>;

  /**
   * 読めない行を、id で指して消す。読めない行は `revoke` が投げて触らないので、片付ける口はこれだけ。
   *
   * - `ids` のどれかが読めない行に無ければ（読める行・無い id を含む）何も消さずに `{ kind: 'unknown' }`（全部か無か。打ち間違いで読める許可を消さない）。件数だけで、指された文字列は返さない
   * - 消すと決まったら、{@link RemoveUnreadableRowsOptions.beforeRemove} を排他区間の中で先に呼ぶ。投げたら何も消さずに投げ直す
   * - id が取れない行（fs のみ）は消せない（指す名前が無い。`permission-grants.json` を手で直す）。読める行には一切触れない
   */
  removeUnreadable(
    ids: readonly string[],
    options?: RemoveUnreadableRowsOptions,
  ): Promise<RemoveUnreadableRowsResult>;
}

/**
 * `ScheduleStore.get(kind)` が、その行を `scheduledRequestSchema` として読めなかったときに投げる。
 * `instanceof` で見分ける（メッセージの文字列で判定すると言い回しの修正で静かに外れる）。
 * `kind` を専用のフィールドに持つのは、`schedule_list` がメッセージの文字列解析なしで取れるようにするため。
 */
export class UnreadableScheduleError extends Error {
  readonly kind: string;

  constructor(message: string, params: { kind: string }) {
    super(message);
    this.name = 'UnreadableScheduleError';
    this.kind = params.kind;
  }
}

/**
 * `ScheduleStore.list` の返り値（`ApprovalList` / `CommitmentList` と同じ形）。
 * `ScheduledRequest[]` のままにしない: 読めない行を空配列へ潰すと、クローンも人間も読めない依頼が在ることに気づけない。
 */
export interface ScheduleList {
  /** 読めた行。kind の昇順。 */
  entries: ScheduledRequest[];
  /** 読めなかった行。「無い」でも「消された」でもない第3の状態。一覧全体は落とさず、行そのものも消さない（`get(kind)` は投げ、`remove` / `removeIfPresent` で外せる）。 */
  unreadable: UnreadableSchedule[];
}

/** 読めない継続中の依頼が在るときの1文（0件なら `null`。0件のときは何も出さない）。本文は載せない（`unreadableScheduleSchema` の doc）。 */
export function describeUnreadableSchedules(
  unreadable: readonly UnreadableSchedule[],
  options: { kindLimit?: number } = {},
): string | null {
  if (unreadable.length === 0) return null;
  const kindLimit = options.kindLimit ?? 10;
  const kinds = unreadable.flatMap((row) => (row.kind === undefined ? [] : [row.kind]));
  const shown = kinds.slice(0, kindLimit);
  const kindNote =
    kinds.length === 0
      ? '（kind も取れない）'
      : `（kind: ${shown.join(', ')}` +
        (kinds.length > shown.length ? ` ほか ${kinds.length - shown.length} 件` : '') +
        (kinds.length < unreadable.length
          ? `。kind が取れない行が ${unreadable.length - kinds.length} 件`
          : '') +
        '）';
  return (
    `読めない継続中の依頼が ${unreadable.length} 件ある${kindNote}。` +
    '壊れた行であって、消された依頼ではない。この一覧には載っていない。' +
    (kinds.length === 0 ? '' : 'kind が分かるものは schedule_remove kind=<kind> で外せる。')
  );
}

/** 読めない行への編集（`POST /schedule`・`schedule_create`）を断る文。本文は載せない（kind だけ）。 */
export function describeUnreadableScheduleEdit(error: UnreadableScheduleError): string {
  return (
    `継続中の依頼 ${error.kind} は読めない形で入っているので編集できない（書き換えていない）。` +
    `消してから作り直すこと（DELETE /schedule/${error.kind}、道具なら schedule_remove kind=${error.kind}）。`
  );
}

/**
 * 予定の「版」は `ScheduledRequest.updatedAt`。本文の編集（`editRequest` / `put`）では進み、発火（`claimRun` / `completeRun`）では動かない
 * （`claimRun` の `expectedUpdatedAt` の照合に使う値と同じ）。時刻なので、同じミリ秒に2回書かれると区別できない。
 */
export interface WriteScheduleOptions {
  /** 前提の版（読んだ時の `updatedAt`）。書く瞬間の版と違えば書かず `ScheduleConflictError`。`null` は「無いときだけ書ける」、省略は後勝ち。 */
  ifMatch?: string | null;
}

/** 前提の版が合わず、書かなかった。`current` はいまの依頼（無ければ、読めない形のときも `null`）。 */
export class ScheduleConflictError extends Error {
  readonly current: ScheduledRequest | null;
  constructor(kind: string, current: ScheduledRequest | null) {
    super(`継続中の依頼が読んだ後に変わっています: ${kind}`);
    this.name = 'ScheduleConflictError';
    this.current = current;
  }
}

/** 前提の版 `ifMatch` が、いまの依頼と合うか（`undefined` は前提なし＝常に合う）。 */
export function scheduleVersionMatches(
  current: Pick<ScheduledRequest, 'updatedAt'> | null,
  ifMatch: string | null | undefined,
): boolean {
  if (ifMatch === undefined) return true;
  if (ifMatch === null) return current === null;
  return current !== null && current.updatedAt === ifMatch;
}

/**
 * 継続中の定期の依頼（PRD「自律」の起点②）。人間の依頼のうち「これから先ずっと」の部分を持つ器。
 * 会話は消え、受信箱は揮発し、記憶は時計を持たない。ここが無いと「定期的に見ておいて」は compaction かデーモン再起動で静かに消える。
 * 人間もここを読んで直せること（CLI / HTTP API）が要件: 自分が出した継続の依頼が見えないのは可観測性の穴になる。
 */
export interface ScheduleStore {
  /** 継続中の依頼の一覧。読めない行は一覧全体を落とさず `unreadable` に別欄で返す。`entries` は kind の昇順。メモリ実装は `unreadable` が常に空。 */
  list(): Promise<ScheduleList>;
  /**
   * 無ければ `null`。読めないは throw（`UnreadableScheduleError`）。
   *
   * NUL: 読むだけの口（`get`・`remove`・`removeIfPresent`・`editRequest`・`claimRun`・`completeRun`・`getPhase`）は、NUL を含む kind でも断らず「無い」と同じ結果を返す。
   * 書き込みは、依頼の kind を入口のスキーマが弾き、位相の kind（`putPhase`）は `NulNotAllowedError` で断る。`request`（本文）の NUL は落として残す。
   *
   * インメモリ実装は投げない: `put()` が `scheduledRequestSchema.parse` を通すので壊れた行を持てない（テストで再現するときは `stores.schedules.get` を丸ごと差し替える）。
   */
  get(kind: string): Promise<ScheduledRequest | null>;
  /**
   * 同じ kind があれば置き換える（`createdAt` は呼び出し側が引き継ぐ）。
   * `options.ifMatch` の比較は書き込みと同じ排他の中。版つきの `put` は読めない行に `UnreadableScheduleError`。
   * 省略（無条件）は読めない行を置き換える: 壊れた行を直す口を塞がないため。
   */
  put(entry: ScheduledRequest, options?: WriteScheduleOptions): Promise<void>;
  remove(kind: string): Promise<void>;

  /**
   * kind が在れば消す。`get(kind)` と違い、読めない行でも投げない。
   * 戻り値は消す前の状態の3値: 無かった（`null`）／読めた（消した値）／在ったが読めなかった（`'unreadable'`）。
   *
   * `get` → `remove` の2操作にしない: 読んでから書くまでの隙間が残るうえ、`get` が読めない行で投げて壊れた依頼を片付ける手が無くなる
   * （`editRequest` / `PermissionGrantStore.revoke` と同じ理由）。
   */
  removeIfPresent(kind: string): Promise<ScheduledRequest | 'unreadable' | null>;

  /**
   * 依頼の「人間・クローンが直す欄」（`request` / `spec`）だけを差し替える。
   * 排他区間の中で読み直した現在値から `pendingRun` / `lastRunAt` / `lastScheduledRunAt` / `createdAt` を引き継ぎ、`request` / `spec` / `updatedAt` だけを差し替えて、書き込んだ後の全体を返す。
   *
   * `put()` で代用しない: `put()` は無条件の全置換で版チェックが無いので、`get()` → コピー → `put()` の間に `claimRun()` が成立すると、
   * その `pendingRun` / `lastRunAt` を丸ごと消す（claim の印が、器が落ちなくても消える）。
   * 無ければ何もせず `null`（新規作成は `put()`）。
   *
   * `options.ifMatch` が合わなければ何も書かず `ScheduleConflictError`（`current` は現在値）。無い kind に版つき（文字列）で呼ぶのも「読んだ後に消された」衝突（`current: null`）。
   * 在るが読めない行は `UnreadableScheduleError`（`ifMatch` を問わない）: `null` にすると続く `put()` で壊れた行を黙って置き換えてしまう。
   */
  editRequest(
    kind: string,
    changes: { readonly request: string; readonly spec: ScheduleSpec },
    updatedAt: string,
    options?: WriteScheduleOptions,
  ): Promise<ScheduledRequest | null>;

  /**
   * 発火を確定させる。読むことと記録することを1操作に閉じる。
   *
   * `expectedUpdatedAt` と同じ版がまだ在るときだけ記録し、確定した依頼（記録を進める前の姿。呼び出し側が「前回いつ動いたか」を要る）を返す。消えていた・書き換わっていたら `null`。
   * 在るが読めない行は `UnreadableScheduleError`（版を問わない）: `null` は「消された・書き換わった」だけの意味に保つ。
   *
   * 2操作に分けない: 読んでから記録するまでの隙間で人間が消した・直した依頼が古い本文で走り、外の世界に手を出したら取り返せない。
   *
   * ここで付けるのは `pendingRun`（引き受けた印）と `lastRunAt`（観測用）だけ。定期の予定の基準（`lastScheduledRunAt`）は `completeRun` まで進めない:
   * claim の直後に器が落ちたとき、その回が「もう動いた」ことになって消えないようにするため。本文だけ直す編集（`editRequest`）が割り込んでも、この印は引き継がれて残る。
   */
  claimRun(
    kind: string,
    expectedUpdatedAt: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<ScheduledRequest | null>;

  /**
   * 引き受けた発火が終わったことを記録する。`pendingRun` を消し、`schedule` なら定期の予定の基準（`lastScheduledRunAt`）を進める。
   * `manual` では基準を動かさない（手で起こした1回で予定をずらさない）。消えている kind、別の発火の印が付いている場合は何もしない。
   */
  completeRun(kind: string, at: string, cause: 'schedule' | 'manual'): Promise<void>;

  /**
   * 既定の仕込み（日報・発意 tick）の位相を読む。無ければ null。
   * 依頼（`list()` / `get()`）とは別の器: 混ぜると既定の仕込みがクローンから継続中の依頼に見えて `schedule_remove` で消せる（`schedulePhaseSchema`）。
   */
  getPhase(kind: string): Promise<SchedulePhase | null>;

  /** 同じ kind があれば置き換える。 */
  putPhase(phase: SchedulePhase): Promise<void>;

  /** 継続中の依頼と既定の仕込みの位相を両方とも消す（ワークスペースのリセット専用）。この2つは1枚のストアなので1操作で消す。 */
  clear(): Promise<{ schedules: number; phases: number }>;
}

/**
 * `CommitmentStore.get(id)` が、その行を `commitmentSchema` として読めなかったときに投げる。
 * 呼び出し側（`commitment_list` の全文モード）は throw を、台帳の1行が壊れている（安全側は「読めない」と伝えて返す）と、
 * 器そのものの障害（安全側は握り潰さず上へ投げる）に割る必要がある。前者を後者と同じに握り潰すと器の異常が「台帳が壊れている」に化ける。
 * `instanceof` で見分ける（メッセージの文字列で判定すると言い回しの修正で静かに外れる）。
 */
export class UnreadableCommitmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableCommitmentError';
  }
}

/**
 * `UnreadableCommitmentError` を人間・クローンへ返す1文へ変換する共通の文面。
 * HTTP の口と道具が別ファイルなので、同じ状況の説明を手で書くと片方だけ直して食い違う。
 *
 * 「閉じることはできる」は常に言ってよい: `POST /commitments/:id/close` と `commitment_close` は読めない行を閉じられる。
 * 本文の書き直しは、この関数を呼ぶどの口からもできない（本文が読める形へ戻る保証が無い）。
 */
export function describeUnreadableCommitment(error: UnreadableCommitmentError): string {
  return (
    `${error.message}。close で閉じることはできる` +
    '（POST /commitments/:id/close・commitment_close）。' +
    '本文の書き直し（PATCH /commitments/:id・commitment_edit）はできない。'
  );
}

/**
 * `CommitmentStore.list` の返り値。
 * `Commitment[]` のままにしない: 保存された形と、いま動いているコードが読める形は将来ずれうる。ずれた行を空配列へ潰すと、
 * クローンが引き受けたことを二度と思い出さない。型に載せれば `unreadable` の読み飛ばしがコンパイラの目に触れる。
 */
export interface CommitmentList {
  entries: Commitment[];
  /** 読めなかった行。「無い」でも「片付いた」でもない第3の状態。 */
  unreadable: UnreadableCommitment[];
  /**
   * `close()` の契約（「行は消さない」）を実装が守れなかった累計 — 保持上限を超えて物理削除された、片付いた行の件数。
   * 契約を守れている実装は常に `0` を返す（`storage-pg` とインメモリ。`storage-fs` だけが `CLOSED_HISTORY_LIMIT` を超えた古い片付き行を物理削除する）。
   * 0 は「削除を数えていない」ではなく「削除が起きていない」を意味する。揃っていない保持方針の事実を隠さずに運ぶのがこの欄の役目。
   */
  trimmedClosed: number;
}

/**
 * `CommitmentStore.open` が実際に何をしたか。
 *
 * `boolean` のままにしない: 開かなかった理由が「同じ id が既に在った」（冪等性）と「同一マネージャー×同一本文の未了へ任せた」
 * （{@link findOpenManagerDuplicate}）の2つあり、1つの `false` へ潰すと `Clone` 側の区別（`CommitOutcome` の `'existed'` と `'folded'`）が失われる。
 * 文字列の union にもしない: `'existed'` も `'folded'` も truthy なので、`if (await store.open(entry))` と書いた呼び出しが型検査を通ったまま意味を反転させる。
 */
export interface CommitmentOpenResult {
  /** 新しい行を開いたか。 */
  readonly opened: boolean;
  /** 同一マネージャー×同一本文の未了へ任せたか（畳んだか）。`opened` が `true` なら必ず `false`。両方 `false` なら「同じ id が既に在った」。 */
  readonly folded: boolean;
  /**
   * 畳んだ先の行の id。
   * 畳んだのに分からないことがある: `storage-pg` は「探す」と「入れる」を1文に畳んでいるので、同じ文が同時に走って DB の制約で弾かれた場合、
   * 読み取りスナップショットに相手の行が無い。嘘の id を埋めないために任意にしてある（fs と in-memory は常に持つ）。
   */
  readonly foldedInto?: string;
}

/**
 * `entry` と同じマネージャー（`origin: 'manager'` かつ同じ `source`）× 同じ `body` の未了行を `entries` から探す。
 * 判定の規則をここに1本だけ置く: 3実装がそれぞれ持つと必ずずれる。`storage-pg` だけが同じ規則を SQL で書き直す
 * （DB の制約にしないとプロセスを跨げない）ので、3実装が同じ答えを返すことを `commitment-fold-contract.ts` が測る。
 *
 * 対象はマネージャー起因の行だけ: 無限連投の形（同一マネージャーの合成通知が同文のまま連投される）は `origin: 'manager'` にしか出ない。
 * 人間の発言・回答・外部イベントまで畳むと、たまたま同じ文言になった別々の発言を1件に潰しかねない。
 * `source` が無い行どうしは重複と数えない（出所の分からない行どうしを「同じマネージャー」とは言えない。pg の `foldable` と同じ）。
 * 閉じたあとの同文は畳まない: 「二度と報告できなくなる」側には倒さない。
 *
 * 見つかった行を返す（`boolean` ではない）。呼び出し側は {@link CommitmentOpenResult.foldedInto} へその id を載せる義務がある:
 * どの行へ任せたか分からないと、クローンはその仕事を閉じる手段を持たない。
 */
export function findOpenManagerDuplicate(
  entries: readonly Commitment[],
  entry: Commitment,
): Commitment | undefined {
  if (entry.origin !== 'manager' || entry.source === undefined) return undefined;
  return entries.find(
    (existing) =>
      existing.closedAt === undefined &&
      existing.origin === 'manager' &&
      existing.source === entry.source &&
      existing.body === entry.body,
  );
}

/**
 * 台帳の行の本文の「版」。`editedAt ?? at` で、クライアントが `GET /commitments` の行から同じ式で出せる（欄は足さない）。
 * `commitmentUpdatedAt`（`closedAt ?? at`）とは別物で、本文の編集では動かない。時刻なので、同じミリ秒に2回書かれると区別できない。
 */
export function commitmentBodyVersion(entry: Pick<Commitment, 'at' | 'editedAt'>): string {
  return entry.editedAt ?? entry.at;
}

/** `CommitmentStore.editBody` の任意の引数。 */
export interface EditCommitmentBodyOptions {
  /** 前提の版（`commitmentBodyVersion`）。書く瞬間の版と違えば書かず `CommitmentConflictError`。省略は後勝ち。無い行は `current: null` の衝突。片付いている行は版を見ず `false`。 */
  ifMatch?: string;
}

/** 前提の版が合わず、書かなかった。`current` はいまの行（消えていれば `null`）。 */
export class CommitmentConflictError extends Error {
  readonly current: Commitment | null;
  constructor(id: string, current: Commitment | null) {
    super(`引き受けた仕事が読んだ後に変わっています: ${id}`);
    this.name = 'CommitmentConflictError';
    this.current = current;
  }
}

/** 前提の版 `ifMatch` が、いまの行と合うか（`undefined` は前提なし＝常に合う）。 */
export function commitmentVersionMatches(
  current: Pick<Commitment, 'at' | 'editedAt'> | null,
  ifMatch: string | undefined,
): boolean {
  if (ifMatch === undefined) return true;
  return current !== null && commitmentBodyVersion(current) === ifMatch;
}

/**
 * 引き受けたまま終わっていない仕事の台帳（`schema.ts` の `Commitment`）。
 * 受信箱（`InboxStore`）とは守るものが違う: あちらは配達の状態（ターンが終われば消える）、こちらは仕事の状態（ターンが終わっても残る）で、片方でもう片方を代用できない。
 */
export interface CommitmentStore {
  /**
   * 台帳を返す。**未了は古い順**（齢が判断の材料なので古いものから見せる）、片付いたものは新しい順で未了の後ろに続く。`includeClosed` を省いたら未了だけ。
   * 1行が読めなくても、その行だけが `unreadable` へ回り `entries` は返る。`entries` の順序・件数は読めた行だけで見た台帳の姿で、読めなかった行は数え上げに紛れ込まない。
   */
  list(options?: { includeClosed?: boolean }): Promise<CommitmentList>;

  /**
   * 1件を読む。「無い（`null`）」と「読めない」は別物: 単票なので型へ逃がす先が無く、読めない行は `UnreadableCommitmentError` を投げる。
   * 呼び出し側（`commitment_list`）は `instanceof` で捕まえて「読めない」を返し、それ以外の例外（器そのものの障害）は上へ通す。
   *
   * NUL: 読むだけの口（`get`・`close`・`closeMany`・`editBody` の id）は NUL を含む id でも断らず「無い」と同じ結果（`null`・`false`・閉じた id に含めない）を返す。
   * `open` は `id` の NUL を `NulNotAllowedError` で断り、`body`・`closedReason` の NUL は落として残す（3実装とも）。
   * `source`（出所の注記。行を指す鍵ではない）の NUL も断らず落として残す（畳み込みの判定も落とした値で揃う）:
   * 断ると引き受けた仕事が台帳から消え、害が大きいのはそちら（`UsageStore` と同じ事情）。
   */
  get(id: string): Promise<Commitment | null>;

  /**
   * 未了として開く。**同じ id が既に在れば何もしない**（開いたら `opened: true`）。
   *
   * 冪等であることがこの器の要: 受信箱の合図は配り直されうるので、その id を使う自動 open は同じ id で二度呼ばれる。上書きすると、一度片付けた仕事が配り直しのたびに開き直る。
   *
   * 同一マネージャー×同一本文×未了も開かない（規則は {@link findOpenManagerDuplicate}）。この判定を呼び出し側（読んでから書く形）へ戻さない:
   * `list()` → 判定 → `open()` と割ると、同じストアを指す2つのデーモンが同時に post したときに台帳が2行に割れる。
   *
   * 「読みと書きを同じ排他区間に入れる」だけでは実装によって強さが違う: in-memory の排他はプロセス内の `Map` で、2プロセスが同じストアを指すと効かない。
   * fs は `withPathLock`（advisory なファイルロック）で、ロックを見ない書き手は防げず、`staleMs` を過ぎた古いロックの回収は lease（同時に区間へ入りうる）。
   * 書き手が何であっても拒む強さでプロセスを跨いで原子なのは `storage-pg` だけ。契約の歯（`commitment-fold-contract.ts`）が測るのは同一プロセスの同期区間までで、それ以上をこの歯だけで名乗らせない。
   */
  open(entry: Commitment): Promise<CommitmentOpenResult>;

  /**
   * 片付いたことを記録する。閉じたら `true`、無い id と既に閉じているものは `false`。
   *
   * 契約は「行は消さない」: 消すと「何を片付けたか」が日報の材料から落ちる（人間が普段読むのは日報だけ。PRD「可観測性」）。
   * ただし `storage-fs` は毎回ファイル全体を書き直す器なので、片付いた行が積もると書き込み費用が台帳の齢に比例して増える。
   * それを避けるため `CLOSED_HISTORY_LIMIT` 件を超えた古い片付き行を物理削除する（`trimClosed`）。`storage-pg` とインメモリは行を消さない。
   * 実装が行を消したら、消した累計件数を `CommitmentList.trimmedClosed` で申告すること: 契約からの逸脱を型の外で握り潰さない。
   *
   * `by` は必須: optional にすると「誰が閉じたか」を決めずに通せてしまう。必須にすれば決めていない呼び出しはコンパイルエラーで立ち止まる。
   */
  close(id: string, at: string, reason: string, by: CommitmentClosedBy): Promise<boolean>;

  /**
   * 複数件を1回でまとめて片付いたことを記録する。
   *
   * `close()` を `ids` の件数だけ呼び出し側でループしない: `storage-fs` は `close()` のたびに台帳の JSON 全体を tmp へ書いて置き換えるので、
   * 500件を閉じれば500回の全体書き直しになる。`closeMany` は複数件を1回の排他区間・1回の更新へ畳む（`storage-pg` は `inArray` の UPDATE 1本、`storage-fs` は `#update` の排他区間を1回）。
   *
   * 戻り値は実際に閉じた id の配列で、件数ではない（存在しない id・既に閉じていた id は含まない）:
   * 呼び出し側（`tools.ts` の一括 close）に「閉じた id を全部日誌へ残す」義務があり、件数だけでは後から組み立てる材料が無い。
   * `ids` が空なら何も書かずに `[]`。同じ id を重複して渡しても二重に閉じず、返る id も重複しない。
   * `ids` の件数に上限を持たない: 呼び出し側が既に1回あたりの上限（2000件以下）で抑えており、ここにも持たせると、どちらの上限が効いたのか外から読めなくなる。
   * 行は消さない（`close()` の契約を継承）。`by` は必須（理由は `close()`）。
   */
  closeMany(
    ids: readonly string[],
    at: string,
    reason: string,
    by: CommitmentClosedBy,
  ): Promise<string[]>;

  /**
   * `body` を書き換える。まだ片付いていない行だけ: 片付いている行・無い id は `false`。
   * 書き換えるのは `body` / `editedAt` / `editedBy` の3つだけで、`origin` / `source` / `at` / `closedAt` / `closedReason` / `closedBy` には触れない。
   *
   * `origin` の判定はここでは行わない: `origin` は開いたときから変わらず並行に呼ばれても競合しない。
   * 競合しうる不変条件（まだ閉じていない）だけをストアの1操作へ畳み、競合しない方針判断（どの `origin` の行を直してよいか）は呼び出し側に残す
   * （AGENTS.md「不変条件はストアの1操作に閉じること」）。
   *
   * `by` は必須（理由は `close` の `by`）。`PATCH /commitments/:id` は `origin: 'human'` の行だけを直し `'human'` を、`commitment_edit` は `origin: 'self'` の行だけを直し `'clone'` を渡す。
   *
   * 呼び出し側は、編集の前後の本文を日誌へ逐語で残すこと。台帳が守っているのは不変性ではなく追跡可能性で（`commitmentSchema.editedAt`）、
   * 原文が日誌から読み戻せない編集の口はその線を壊す。日誌は別のストアなのでストアは強制できない: 新しい呼び出し元を足すなら `journal.append` を必ず対にする。
   */
  editBody(
    id: string,
    body: string,
    at: string,
    by: CommitmentEditedBy,
    options?: EditCommitmentBodyOptions,
  ): Promise<boolean>;

  /**
   * 全件を消す（ワークスペースのリセット専用）。未了・片付いた行の両方、`unreadable` に回っていた読めない行も含めて消す。消した件数を返す。
   * `close()` / `closeMany()` の「行は消さない」契約とは別の操作で、人間が明示的に「引き受けた仕事ごと全部忘れる」と決めたときにしか呼ばれない。
   */
  clear(): Promise<number>;

  /**
   * ある会話から自動で開いた行を、物理的に消す（会話の削除）。`origin: 'human'` かつ `source === conversationId` の行を、
   * 未了・片付いた行の両方とも消し、消した件数を返す。別の会話の行・`origin: 'self'` / `'manager'` の行には触れない。
   * `close()` の「行は消さない」契約とは別の操作で、呼ばれるのは人間が会話の削除を明示したときだけ。
   *
   * `editBody` で本文を空にして代用しない: 編集の前後の本文は日誌へ逐語で残す決まりで、秘密を日誌へ写し直すことになる。
   * 読めない行（`list()` の `unreadable`）も `clear()` / `closeMany()` と同じ作法で、生の値の `origin` / `source` が一致すれば消す（3実装で揃える。pg は jsonb の欄をそのまま見る）。
   * `conversationId` に NUL を含むときは「無い」と同じ（0件）。刈られた id（fs の `trimmedClosedIds`）は触らない。
   */
  removeForConversation(conversationId: string): Promise<number>;
}

/**
 * まだ処理し終えていない受信箱の合図（PRD「可観測性」/ architecture.md「同時実行モデル」）。
 *
 * 受信箱そのものはインメモリでよい。ここが持つのは「まだ終えていない」という事実だけ。
 * 境界は「`post` が受理した時点」であって「queue に入った時点」ではない: 暇なクローンへ届いた合図は `Inbox#push` の waiter 経路で queue を素通りするので、
 * 「落ちる前に queue を吐き出す」形の永続化はその経路を1件も救わない。
 * 消し込みは「処理を終えた時点」（取り出した時点ではない）: 取り出した時点で消すと、処理の途中でプロセスが死んだものが失われる。
 * そのため同じ合図が二度処理されうるが、二度届く（雑音）より消える（判断材料の喪失）方が高い。二度目だと分かる形にして取引を成立させる（`deliveries`）。
 * 本文を持つ: 持たなければ拾い直せない。ただし書けなかったときに外へ出す跡には本文を載せない（`dropped-record.ts`）。
 */
export interface InboxStore {
  /**
   * 受け取った合図を未読として置く。同じ id なら上書きする（配達回数は保つ）。
   * 外側の `at` は `Z` 付きの ISO 表記（`new Date(at).toISOString()`）に正規化して保存・返す。読めない時刻は拒む（throw）。`event` の中の `at` は触らない。
   * 呼び出し側は、消し込みがこの書き込みを追い越さないようにする（追い越すと、消したはずの合図が後から書かれて永久に配り直される）。
   */
  put(event: InboxEvent, at: string): Promise<void>;

  /**
   * 処理を終えた合図を消す。無ければ何もしない。
   * id を名指しした削除は、読めない行（`peekPending().unreadable`）にも効く（3実装で同じ。`removeMany` も同じ）:
   * 「読めない行は消さずに残す」は、まとめての削除・自動の片付けで黙って失わないための線で、名指しは意図した操作である。
   */
  remove(id: string): Promise<void>;

  /**
   * 残っている未読を古い順に返し、**同時に配達回数を1つ進める**。
   *
   * 進めるのは、呼び出した時点で残っている未読の全行（pg は `WHERE` 句の無い `UPDATE`、fs は全件の map）。
   * 回数が数えているのは「器が入れ替わった回数」であって「この合図の処理が落ちた回数」ではない。
   * 待ち行列に居ただけで一度も処理されていない合図も同じだけ増える。この口を使う側はここしか読まないので、無いと因果を誤読する
   * （未読 104 件の器で「4 回目の配達」と名乗る合図が届き、クローンは「なぜ落ちたか」を調べてターンを1本使った。答えは「一度も処理されていなかった」）。
   *
   * 読むことと回数を進めることを1操作に閉じる（`ScheduleStore.claimRun` と同じ作法）: 分けると、配り直しの途中で落ちたときに回数が進まず「何回目の配達か」が嘘になる。
   * 回数はクローンが毒（配り直すたびに器ごと落ちる合図）を見分ける材料だが、言えるのは同時に拾い直したのが1件だけのときに限る
   * （2件以上ならどれが原因かは言えない。名乗り分けは `Clone` の `#restoredCohort`）。これは実行回数の制限ではない（AGENTS.md 地雷2）: 何回目でも配ることは変わらない。
   */
  claimPending(): Promise<PendingInboxEvent[]>;

  /**
   * 残っている未読の件数と、いちばん古いものが積まれた時刻。`claimPending()` と違い配達回数を進めない。
   * `manager_list` のような一覧が「デーモン→クローンの脚で詰まっているか」を覗く読み取り専用の口。
   * 覗いただけで回数を進めると、まだ一度も配っていない合図が「前に配ったが終わらなかった」と嘘をつく（`deliveries` は配り直しを見分ける唯一の材料）。
   * 1件も無ければ `oldestAt` は無い（0件のときに値を作らない。AGENTS.md「取れない軸に0の行を作る」）。
   */
  pending(): Promise<{ count: number; oldestAt?: string }>;

  /**
   * 残っている未読を古い順に返す。`claimPending()` と違い配達回数を進めない（`pending()` と同じ）。
   * 内訳（`summarizeInboxBacklog`）のために本文まで返すので、毎ターン呼ぶ口ではない: `clone.ts` の `#situationNoticeFor` は安い `pending()` を使い、この口は `manager_list`（明示的に内訳を求めたとき）からだけ呼ぶ。
   */
  peekPending(): Promise<InboxPeek>;

  /**
   * 絞り込みで選んだ複数件を、まとめて消す。
   *
   * `remove()` を `ids.length` 回ループしない: `storage-fs` は `remove()` のたびに `inbox.json` 全体を書き直す（`CommitmentStore.closeMany` と同じ理由）ので、
   * 3,000件なら3,000回の全体書き直しになる。`removeMany` は1回の排他区間・1回の更新へ畳む。
   *
   * どの id を対象にするかはここでは決めない: 絞り込みは `peekPending()` が返した行に呼び出し側（`POST /inbox/remove`）が当てる。
   * 判定を SQL 側に複製しない（1箇所の `matchesInboxRemoveManyFilter` に保つ。`inboxBacklogDedupeKey` と同じ理由）。
   * 戻り値は実際に消えた（存在した）id の配列で、件数ではない: 呼び出し側が実際に何を消したかを日誌へ残せるようにする。`ids` が空なら何も書かずに `[]`。
   */
  removeMany(ids: readonly string[]): Promise<string[]>;

  /** 全件を消す（ワークスペースのリセット専用）。配達回数（`deliveries`）ごと消える: 次に同じ合図が来ても初回として配ればよい。消した件数を返す。 */
  clear(): Promise<number>;
}

/**
 * `InboxStore.peekPending` の返り値（`ApprovalList` と同じ形）。
 * `PendingInboxEvent[]` のままにしない: 読めない行を空へ潰すと、人間の発言が壊れていても受信箱が空に見える。
 * `entries.length + unreadable.length` は `pending().count` に一致する。配る側（`claimPending`）は変えない: 読めない行は配れない。
 */
export interface InboxPeek {
  /** 読めた行。古い順。 */
  entries: PendingInboxEvent[];
  /** 読めなかった行。「無い」でも「処理済み」でもない第3の状態。全体は落とさず、行そのものは消さない。本文は載せない（`unreadableInboxEventSchema`）。 */
  unreadable: UnreadableInboxEvent[];
}

/** 読めない合図が在るときの1文（0件なら `null`。0件のときは何も出さない）。本文は載せない。 */
export function describeUnreadableInboxEvents(
  unreadable: readonly UnreadableInboxEvent[],
  options: { idLimit?: number } = {},
): string | null {
  if (unreadable.length === 0) return null;
  const idLimit = options.idLimit ?? 10;
  const ids = unreadable.flatMap((row) => (row.id === undefined ? [] : [row.id]));
  const shown = ids.slice(0, idLimit);
  const idNote =
    ids.length === 0
      ? '（id も取れない）'
      : `（id: ${shown.join(', ')}` +
        (ids.length > shown.length ? ` ほか ${ids.length - shown.length} 件` : '') +
        (ids.length < unreadable.length
          ? `。id が取れない行が ${unreadable.length - ids.length} 件`
          : '') +
        '）';
  return (
    `読めない合図が ${unreadable.length} 件ある${idNote}。` +
    '壊れた行であって、処理済みで消えたのではない。この内訳には載っていない。配られてもいない。'
  );
}

/** 未読として残っていた合図1件。 */
export interface PendingInboxEvent {
  event: InboxEvent;
  /** `post` が受理した時刻（ISO 8601）。 */
  at: string;
  /**
   * 何度目の配達か。`1` は「初めて配る」。
   * `2` 以上を「前に配ったが、終える前にまた落ちた」と読まない: `claimPending()` は残っている未読の全行を一緒に進めるので、
   * 待ち行列に居ただけの合図も同じだけ増える。`2` 以上から言えるのは「器がそれだけ入れ替わった」ことまで。
   */
  deliveries: number;
}

/**
 * `TranscriptArchive.read()` が返す3つの顔。
 *
 * `null` へ畳まない: `remove()` を足すと「積まれたが本文を落とした」という2つ目の『無い』が生まれ、同じ `null` へ畳むと
 * `manager_transcript` / `GET /archive/:id` の呼び出し元は「どこにも無かった」としか言えなくなる。
 *
 * - `body` — 本文がある（消されていない）。
 * - `removed` — 退避は在ったが `remove()` で本文だけを落とした。行は残る（`list()` に出続ける）。
 * - `missing` — id 自体が存在しない。
 *
 * `removed` の `bytes` は本文の素の UTF-8 バイト数（3実装が `verifyTranscriptArchiveContract()` で一致を固定）。
 * `ArchiveEntry.storedBytes`（その置き場が実際に使っている量。pg は TOAST 圧縮後）とは単位が違い、置き場で解放した量ではない。
 */
export type ArchiveRead =
  | { readonly kind: 'body'; readonly body: string }
  | { readonly kind: 'removed'; readonly removedAt: string; readonly bytes: number }
  | { readonly kind: 'missing' };

/**
 * `TranscriptArchive.remove()` の結果。
 *
 * 存在しない id を黙って成功にしない（`memory_delete` / `DELETE /memory/:slug` と同じ作法）: 消せなかったことと消せたことを畳むと、
 * 「消したつもりで何も変わっていない」を検出できない。
 *
 * - `removed` — いま消した。落とす直前のバイト数を返す。
 * - `already` — 前から消されていた（冪等な再実行）。「いま消した」と畳むと、呼んだ側は自分の呼び出しが何をしたのか見失う。
 * - `missing` — id 自体が存在しない。これだけが失敗。
 *
 * `bytes` の単位は `ArchiveRead` の `removed` と同じ（`ArchiveEntry.storedBytes` とは違う）。
 */
export type ArchiveRemoval =
  | { readonly kind: 'removed'; readonly bytes: number }
  | { readonly kind: 'already'; readonly removedAt: string; readonly bytes: number }
  | { readonly kind: 'missing' };

/**
 * `TranscriptArchive.list()` の1行。
 *
 * `storedBytes` はその置き場がこの行に実際に使っている量（pg は圧縮後のバイト数、fs は `stat().size`、インメモリは文字列長）。
 * 生ログの文字数ではなく、置き場をまたいで比較してはならない（展開後の文字数と圧縮後のバイト数を取り違えた比較が実際に起きた）。
 * `removedAt` / `removedBytes` は `remove()`（tombstone）が起きた行にだけ載る（`removedBytes` の単位は `ArchiveRemoval` と同じ）。
 * `continuity` は `archive()` が積んだ瞬間に判定した直前の退避との連続性。この機能より前に積まれた行には無いので optional。
 */
export interface ArchiveEntry {
  readonly id: string;
  readonly sessionId: string;
  /** ISO 8601（`archive()` を呼んだ時刻）。 */
  readonly at: string;
  readonly storedBytes: number;
  readonly removedAt?: string;
  readonly removedBytes?: number;
  readonly continuity?: ArchiveContinuity;
}

/**
 * `TranscriptArchive.archive()` の戻り値。
 * `continuity` / `comparedTo` は判定結果を呼び出し側へ渡すためのもので、これを受けて `remove()` を呼ぶコードは無い（判定を記録するだけで、畳まない）。
 */
export interface ArchiveWrite {
  readonly id: string;
  readonly continuity: ArchiveContinuity;
  /** 比べた相手の id。`continuity` が `'first'` のときは無い。 */
  readonly comparedTo?: string;
}

/**
 * `ArchiveSessionSummary.continuity` の内訳。
 *
 * `absent` と `unknown` を畳まない: `unknown` は門は走ったが直前の行が指紋を持っていなかった（確かめようとしたが材料が無かった）、
 * `absent` は行自体が門より前に積まれた（確かめる機会自体が無かった）。1つへ畳むと確かめていないことを確かめた側へ寄せてしまう
 * （`archive-continuity.ts` の「`'unknown'` を `'continues'` に倒さない」と同じ種類の誤り）。
 *
 * 不変条件: `first + continues + diverged + unknown + absent === rows`（`verifyTranscriptArchiveContract()` が全 `sessionId` について測る）。
 */
export interface ArchiveContinuityTally {
  readonly first: number;
  readonly continues: number;
  readonly diverged: number;
  readonly unknown: number;
  readonly absent: number;
}

/**
 * `TranscriptArchive.sessions()` の1行 — `sessionId` ごとの集計。
 *
 * `rows` は `archive()` が呼ばれた回数（tombstone 済みの行も含む）。同じセッションの生ログが何度も積まれているという重複の事実が、個々の `storedBytes` の大小より先に問題の所在を特定した。
 * `storedBytes` / `maxStoredBytes` の単位・比較不可の制約は `ArchiveEntry.storedBytes` を継承する。
 * `continuity` は無い行を `absent` として数えるので、集計自体は常に存在する（optional にしない）。
 */
export interface ArchiveSessionSummary {
  readonly sessionId: string;
  readonly rows: number;
  readonly storedBytes: number;
  readonly maxStoredBytes: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly continuity: ArchiveContinuityTally;
}

/**
 * セッションの生ログ退避先（PreCompact フックで落とす）。
 *
 * `remove()` は行を消さない。本文だけを落とす（tombstone）。走行中の委譲の生ログを消せない守りはここではなく
 * `ManagerPool.runningManagerOwning()` が持つ（HTTP の口と道具の両方がそこを通ることで、守りを1箇所に保つ）。
 */
export interface TranscriptArchive {
  /**
   * 退避したアーカイブの id と、直前の退避との連続性判定を返す。判定するだけで畳まない:
   * `continuity` が `'diverged'` / `'unknown'` でも、この呼び出しの中で古い行を `remove()` しない。
   *
   * NUL: `sessionId` の NUL は `InvalidArchiveSessionIdError` で断る。`transcript`（本文）の NUL は落として残す（3実装とも。指紋と連続性は落とす前の本文で取る）。
   * 読むだけの口（`read`・`readTail`・`remove`）は NUL を含む id でも断らず `missing` を返す。
   */
  archive(sessionId: string, transcript: string): Promise<ArchiveWrite>;
  /** 新しい順。 */
  list(): Promise<ArchiveEntry[]>;
  /**
   * `sessionId` ごとの集計。3実装の一致は `verifyTranscriptArchiveContract()` が測る。
   * 並びは `storedBytes` の降順、同値なら `sessionId` の昇順: 並びを決めないと同じ問い合わせが呼ぶたびに違う順で返りうる（容量を追う面では黙った揺れになる）。
   */
  sessions(): Promise<ArchiveSessionSummary[]>;
  read(id: string): Promise<ArchiveRead>;
  /**
   * 末尾だけを読む。`read()` を使わない: 本文の全体を返し、`archive` の1行は最大 78.3 MB に育つ。
   * 起動のたびに自動で走る拾い直し（`clone.ts` の `#pickUpTranscriptGrave`）が全文をヒープへ載せてから末尾だけを使っていたのが OOM の原因だった。
   *
   * 契約:
   * - 戻りの形は `read()` と同じ3状態（`body` / `removed` / `missing`）。`#pickUpTranscriptGrave` が日誌の文面を分けているので区別を潰さない。
   * - `maxChars` はコードポイント数で数える。UTF-16 コード単位（`.length`）ではない: 補助面の文字でずれ、実装ごとに数えが違うと、
   *   本当は消えるはずのない本文の先頭が静かに消える・サロゲートペアの途中で切って孤立サロゲートを作る。
   *   単位の変換は `tailByCodePoints`（`excerpt.ts`）の唯一の出所へ寄せ、実装ごとに手で書き直さない。
   * - `kind: 'body'` のとき返すのは本文の末尾から少なくとも `maxChars` コードポイント（実装が窓をバイトで切る都合で、それより多く返してよい）。本文が `maxChars` 以下なら全文。
   * - 本文が `maxChars` より長いとき、返す量は `maxChars` を厳密に上回ること（同じ数で切り詰めない）。
   *   呼び出し側（`tailOf`）は「`tailByCodePoints(transcript, DISTILL_TRANSCRIPT_TAIL_CHARS)` の結果が元の文字列と一致するか」で切り詰めが要るかを判定する。
   *   ちょうど `maxChars` だと「切り詰め済みの窓」か「もとから短い本文」か区別できず、行の途中の窓をそのまま蒸留へ渡してしまう。
   *   切り詰めが起きるときは必ず `maxChars + 1` コードポイント以上を返す（pg は `right(body, maxChars + 1)`、fs は窓のバイト数を `(maxChars + 1) * MAX_UTF8_BYTES_PER_CODE_POINT` にして `tailByCodePoints` で揃える、インメモリは `tailByCodePoints(body, maxChars + 1)`）。
   * - 行の途中・文字の途中から始まりうる。整えるのは呼び出し側（`tailOf`）: 器ごとに整え方が分かれると蒸留へ渡るものが器で変わる。
   * - 実装は本文の全体を呼び出し側のメモリへ載せない: 避けたい OOM をこの関数自身が起こす。
   * - `maxChars` は正の整数。不正な値は fail-closed で拒む（黙って全文へ倒さない）。
   *
   * `SessionTranscriptTail.readTail`（別のインターフェース）も同じくコードポイント数で `maxChars` を数える。
   */
  readTail(id: string, maxChars: number): Promise<ArchiveRead>;
  /**
   * 本文だけを落とす（tombstone。`DELETE` ではない）。
   * `body` が空であることを判定に使わない: 空の生ログは正当にありえる（`storage-pg` は `removed_at is not null`、`storage-fs` は脇の印ファイルで、本文の中身を見ずに判定する）。
   */
  remove(id: string): Promise<ArchiveRemoval>;

  /** 全件を消す（ワークスペースのリセット専用）。`remove()`（tombstone）とは違い行そのものを消す。消した件数を返す。 */
  clear(): Promise<number>;
}

/**
 * 実行環境プロファイル（人間の `.zprofile` / `.zshenv` / `/etc/profile.d/*.sh` に当たるもの）の1行。
 *
 * 記憶ではない: 人格は記憶（Markdown）に宿るのであって、鍵や `PATH` の話はそこに混ぜない。器を作り直しても残るという性質だけが同じなので、同じストアの一員として持つ。
 * 持つのはデーモンだけ: runner は自分で読みに行かず、降ってきたものを器に置くだけにする
 * （読みに行けるなら runner から記憶ストアへの経路があることになり、M4 の受け入れ基準3 が無いと言っているもの）。
 *
 * 名前付きの行を複数持つ。かつての「高々1本のスクリプト・層による効かせ分けを持たない」形は、人間の明示的な決定で作り替えた
 * （オーナーの逐語:「env-profileを環境変数と同じように指定できるようにして欲しい」「デフォルトは両方です」）。
 * `StoredCredential.scope` と同じ理由・同じ形: AGENTS.md 地雷3が禁じるのは「行為の確認要否を配線で固定する」ことで、
 * `scope` は確認・許可の話ではなく「どのプロセスにとってこの環境が意味を持つか」というプロセストポロジーの表現である。
 * クローンは `scope` が `runner` の行も `profile_read` で読める（読む口は `scope` で変わらない）。
 */
export interface EnvProfileEntry {
  /** 行の名前（`PROFILE_ENTRY_NAME` の形。つなげる順番はこの名前のコード単位順）。 */
  name: string;
  /** 人間が書いたシェルスクリプトそのもの（何行でもよい）。器は中身を解釈しない。 */
  script: string;
  /** 撒く先。`'all'`（クローンと runner の両方）/ `'app'`（クローン＝デーモンだけ）/ `'runner'`（runner＝マネージャー・作業者だけ）。既定は常に `'all'`。 */
  scope: EnvProfileScope;
  updatedAt: string;
}

/**
 * {@link EnvProfileEntry.scope} の3値。環境変数（{@link StoredCredential.scope}）と同じ。
 * plugin の撒く先（`plugins.ts`）も同じ値を使う（重複して書くと片方だけ増える）。
 */
export const ENV_PROFILE_SCOPES = ['all', 'app', 'runner'] as const;

export type EnvProfileScope = (typeof ENV_PROFILE_SCOPES)[number];

/**
 * 行の名前の形。器の中のファイル名になる（fs 版は `profile.d/<name>.sh`）ので、パスとして解釈されうる形（`/`・先頭の `.`・`..`）を最初から認めない。
 * 置き場を読む側（fs 版の一覧）でも同じ検査をする（人間が手で書き換えられる。`credentials.ts` の `CREDENTIAL_NAME` と同じ理由）。
 */
export const PROFILE_ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 名前のコード単位順（`<` 比較。ロケールに依存させない。`/etc/profile.d` の辞書順と同じ）。 */
export function compareProfileEntryNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ProfileStore {
  /** 置かれている全行。名前のコード単位順（つなげる順番そのもの）。 */
  list(): Promise<EnvProfileEntry[]>;
  /**
   * 1行を置く（無ければ作り、在れば本文・撒く先・更新日時を入れ替える）。呼び出し側が名前（`PROFILE_ENTRY_NAME`）と本文が空でないことを検査して渡す。
   * `name`（鍵）・`script`（環境変数になる値）に NUL があれば `NulNotAllowedError` で断る。
   */
  set(name: string, script: string, scope: EnvProfileScope): Promise<EnvProfileEntry>;
  /** 1行を外す。在れば `true`、無ければ `false`。 */
  remove(name: string): Promise<boolean>;
  /**
   * 取り消した更新をなかったことにする（行の集合を、本文・撒く先・更新日時ごと組で戻す）。入力に無い行は消える。
   *
   * 通常の書き込みで戻さない: 本文は戻っても `updatedAt` が失敗した時刻へ進み、「最後に本文を変えた時刻」（`profile status` と `GET /profile` の監査情報）が成功していない更新で動いてしまう。
   * 更新日時を呼び出し側が決められる口なので、失敗の巻き戻し専用で、通常の書き込みには使わない。
   * `set` と同じく `name`・`script` の NUL は `NulNotAllowedError` で断る（全行を先に検査し、1行でも不正なら何も書かない）。
   */
  replaceAll(previous: readonly EnvProfileEntry[]): Promise<void>;

  /** 置かれていた行を全部外す（ワークスペースのリセット専用）。消した行数を返す。 */
  clear(): Promise<number>;
}

/**
 * 人間の MCP 連携の登録（`.mcp.json` の `mcpServers` と同じ形）の置き場。
 * `ProfileStore` と同じ形（正本はデーモンが持ち、器違い（fs / pg）は挙動を変えない。高々1つの文書を全文置換する）。
 * `Stores` の一員にするのは、器を作り直しても残るため（Railway には volume が無く、ファイルで置くと器と一緒に消える）。
 * 記憶ではない: `env` / `headers` に鍵が入りうるので `memory/` には置かない（置けばクローンのシステムプロンプトに鍵が載る）。形と検査の正本は `mcp-servers.ts`。
 */
export interface McpServerStore {
  /**
   * 置かれていなければ null（空の登録も null として読む）。
   * 返すサーバーは名前の `compareCodeUnits` 順（`write()` の戻り値も同じ。3実装とも `sortMcpServers` を通す。pg の jsonb の並びに依らない）。
   */
  read(): Promise<StoredMcpServers | null>;
  /**
   * 全文置換。空の登録（`{}`）は「登録を外す」（`ProfileStore.write()` と同じ約束）。
   * `options.ifMatch`（`mcpServersVersionOf`）が書く瞬間の版と違えば何も書かず `McpServersConflictError`（比較と書き込みは1つの排他の中）。
   *
   * 書く前に `parseMcpServers` を通す（3実装とも）: 器ごとに検査を書き分けると1つだけ緩い器が生まれる。不正なら投げ、前のものが残る。
   * サーバー名と `env` の名前・値の NUL は `NulNotAllowedError` で断る。`command`・`args`・`url`・`headers` などの本文の NUL は落として残す。
   */
  write(servers: McpServers, options?: WriteMcpServersOptions): Promise<StoredMcpServers>;
}

/**
 * 人間が入れた plugin（skill を含む）の置き場。1 plugin = 1 行（名前が鍵）。
 * `McpServerStore` と同じ理由で `Stores` の一員にする（Railway には volume が無く、器のファイルに置くと器と一緒に消える）。
 * 取り込んだ時点の中身のまま持つので、取り元が消えても書き換えられても動くものは変わらない。記憶ではない。形と検査の正本は `plugins.ts`。
 */
export interface PluginStore {
  /**
   * 置かれている全 plugin の要約（files を含まない）。名前の `compareCodeUnits` 順。
   * 読めない行があれば投げる（黙って飛ばすと「入れたのに無い」が原因の出ない形で起きる）。
   */
  list(): Promise<PluginSummary[]>;
  /**
   * 1つを files ごと返す。無ければ null。名前が形に合わない・NUL を含むときも投げず null（書き込みで断るので、そのような行はどの器にも存在しえない）。
   * 読むときに形と `contentSha256` を検査し、合わなければ投げる（SQL や手での書き換え）。
   */
  get(name: string): Promise<StoredPlugin | null>;
  /**
   * 置く。同名は置き換え（files も新しいものだけが残る）。書く前に `parsePluginInput` を通す（3実装とも。`contentSha256` はそこで計算する）。不正なら投げ、前のものが残る。
   * 大文字小文字だけが違う名前が既にあれば `PluginNameConflictError`（大文字小文字を区別しないファイルシステムで衝突するため）。
   */
  put(input: PluginInput): Promise<PluginSummary>;
  /** 外す。在れば `true`、無ければ `false`（形に合わない名前も `false`）。 */
  remove(name: string): Promise<boolean>;
}

/**
 * マネージャーへ降ろす環境変数の正本1行（名前と値）。
 *
 * 鍵に限らない: `GH_TOKEN` のような秘密も `GIT_AUTHOR_NAME` のような身元も同じ形で持つ。器（`credentials.ts` の `CredentialStore`）は中身の意味を知らず、
 * 用途が増えても実装を直さない（`compose.yaml` へ環境変数を足していく形にしない。AGENTS.md 地雷表「用途が増えるたびに `compose.yaml` へ環境変数を足す」）。
 *
 * 実行環境プロファイル（`EnvProfileEntry`）との違いは読む側の性質: あちらは名前付きのシェルスクリプトで、届くのは SDK 子プロセスの起動時（走行中の仕事には届かない）。
 * こちらは名前ごとにファイルへ落ちるので、`gh` シムのように呼ばれるたびに読み直す道具には走行中でも届く。
 * `GET /profile` が本文ごと返すのに対し、こちらは指紋しか返さない。秘密の正本はこちら。
 */
export interface StoredCredential {
  /** 環境変数の名前そのもの（`CREDENTIAL_NAME` の形）。 */
  name: string;
  /** 値。平文で持つ（`agent_tokens.value` と同じ扱い。器の外へは指紋しか出ない）。 */
  value: string;
  updatedAt: string;
  /**
   * 撒く先。既定は `'all'`（クローン・マネージャー双方）。per-row の使い分けは「どうしても要るとき」だけの例外。
   *
   * 行ごとの列を持つのは、人間の明示的な指示で `env_profile` / この表が避けていた形を上書きしたため。
   * AGENTS.md 地雷3が禁じるのは「行為の確認要否を配線で固定する」ことで、`scope` は確認・許可の話ではなく
   * 「どのプロセスにとってこの環境変数が意味を持つか」というプロセストポロジーの表現である（`GOOGLE_CLIENT_SECRET` はマネージャーの Bash 環境には意味を持たない）。
   */
  scope?: 'all' | 'app' | 'runner';
  /**
   * この行が API/CLI/Web UI に対して値を伏せる（`secret: true`）か、そのまま見せてよい（`secret: false`）か。
   * 配布（クローン・マネージャーへ渡る実値）には一切影響しない: 効くのは読み出し API の応答に `value` を載せるかどうかだけ。
   * 一度作った行では変更できない（`assertEntries` が検査する）: 後から秘密化・その逆をすると、UI 上で見えていた値が突然消える／秘密のはずが見えるようになる。
   * 既定は `true`（この列が無かった頃の全行の挙動）。
   */
  secret?: boolean;
}

/**
 * マネージャーへ降ろす環境変数の正本（名前→値）。
 *
 * 持つのはデーモンだけ: runner は自分で読みに行かず、降ってきたものを器に置くだけ（読みに行けるなら runner に記憶ストアの鍵があることになり、M4 受け入れ基準3 が無いと言っているもの）。
 * `Stores` の一員にするのは、器を作り直しても残るため: 無いと、器を作り直した runner は鍵を失ったまま上がってくる。
 */
export interface CredentialVaultStore {
  /** 置いてある全行（値を含む。正本を返す口はここだけ）。`name` 昇順。 */
  list(): Promise<StoredCredential[]>;
  /**
   * 名前ごとに置き換える。入力に無い名前は触らない（全文置換ではない）。
   * 空文字は「その名前を外す」（`CredentialStore#set` と同じ約束。器と正本で「外す」の表し方が違うと片方だけ残る）。
   * 返すのは置き換えた後の全行: 呼ぶ側（`CredentialService`）がそのまま配るので、部分更新のつもりが一部しか降りない形を作らない。
   *
   * 入口で断る（3実装とも同じ型付きの例外）: 名前・値に NUL があれば `NulNotAllowedError`、`CREDENTIAL_NAME` に合わない名前（空文字を含む）は `InvalidCredentialNameError`。1件でも断れば何も書かない。
   */
  put(entries: readonly CredentialEntry[]): Promise<StoredCredential[]>;
  /**
   * 名前付きの印が無いときだけ、行が無い名前を1度だけ書く。返すのは実際に書いた名前（印が既にあれば空）。
   * 器の環境変数にだけ置かれていた鍵（`GH_TOKEN` 等）を、器の env を土台にする経路を撤去する際に正本へ移す1回きりの移行用
   * （`env-vars-boot.ts` の `migrateEnvBaseCredentialsOnce`）。印を持つのは「画面で消した後の再起動で蘇らせない」ため
   * （無いと、正本から消した名前が器の env から毎回戻ってくる。`env_profile_entries_migrated` と同じ理由）。
   *
   * 既に行が在る名前は上書きしない（人間が置いたものが勝つ）。書いても書かなくても印は立てる。
   * 印の確認・行の書き込み・印を立てる操作は1つの区間で行う（3実装とも）。入口の検査は `put` と同じ。
   */
  seedOnce(marker: string, entries: readonly CredentialEntry[]): Promise<string[]>;
}

/**
 * 認証トークンのプール。回さない: 検知も切替もここには無く、ここが持つのは置き場と、置いたものを読み書きする口だけ。
 * `env_profile` と同じ形（正本はデーモンが持ち、器違いは挙動を変えない）。`Stores` の一員にするのは、環境を作り直しても残るため。
 */
export interface TokenPoolStore {
  /**
   * プールの全行（値を含む。正本を返す口はここだけ）。`order` 昇順。
   * `settings` / `active` が壊れていても道連れにしない: `list()` が投げてよいのは `tokens` 自体の形が壊れているとき（配列でない等）だけ。
   */
  list(): Promise<AgentToken[]>;
  /**
   * `list()` が読み飛ばした行（`agentTokenSchema` に合わない行）を、値を含まない形で返す。
   * 0件のときだけ「登録されていない」と言える（`readSettings()` の `UnreadableTokenSettingsError` が設定について言い分けているのと対）。
   *
   * `list()` の戻り型を変えない: 回し手（`token-rotator.ts`）が十数か所で読み直し、読んだ行をそのまま `replace()` で書き戻すので、読めない行を見せる先が無い。
   * 見せる先（`TokenPoolService.list()` の `rowsUnreadable` 経由の HTTP・CLI・Web と `token_list`）は別欄で受ける。
   * 値（`value`）は決して返さない（`unreadableTokenSchema`）。メモリ実装は常に空。pg 実装も常に空
   * （正規化された列で持ち、型が合わない行を作れない。読み捨てるのは過去の `source = 'env'` の行だけで、これは「読めない」ではない）。
   */
  listUnreadable(): Promise<UnreadableToken[]>;
  /**
   * 全文置換。入力に無い（読めた）行は消える。**読めない行は消さずに持ち越す**（fs 実装。`FsTokenPoolStore.replace`）。
   *
   * 持ち越す理由: トークンを登録・無効化するのは人の手で、クローンにも回し手にもその権限が無い。人が入れた行を、自動の回転
   * （回し手の書き戻しもこの口を通る）が知らせずに消してよい理由が無い。捨てた跡が残っても鍵そのものは戻らない。
   * 失うのは「全文置換の意味の純粋さ」だけ。読めない行を消したいときは {@link TokenPoolStore.removeUnreadable}（id で指す）を使う。
   * pg 実装とインメモリ実装は読めない行を持てないので、持ち越すものが無く挙動は変わらない。
   *
   * 入口で断る（3実装とも同じ型付きの例外）: 同じ `id` が2行以上なら `DuplicateTokenIdError`、`id`・`value`（資格）に NUL があれば `NulNotAllowedError`。1件でも断れば何も変えない。
   * `label`・`lastRejectedReason` などの本文の NUL は、fs も含めて落として残す。
   */
  replace(tokens: readonly AgentToken[]): Promise<AgentToken[]>;
  /**
   * 読めない行を、id で指して消す。`listUnreadable()` が返す `id` と一致する読めない行だけを消し、読めた行・`settings` / `active` には触れない。
   * 消した行の id を返す（指された id のうち読めない行に無かったものは含まれない — 呼び手が突き合わせる）。
   * id が取れない読めない行は、この口では消せない（指す名前が無い。`tokens.json` を手で直す）。pg・インメモリは常に空を返す。
   */
  removeUnreadable(ids: readonly string[]): Promise<string[]>;
  /**
   * 回す契機と冷却の既定。置かれていなければ core の既定（`DEFAULT_TOKEN_ROTATION_SETTINGS`）を返す。
   *
   * 置かれている値が壊れて読めないときは、既定へすり替えず `UnreadableTokenSettingsError` を投げる:
   * 「無い」と「読めない」は別の状態で、既定へ潰すと `off` にしてあった回転を実装が黙って戻す。
   * `writeSettings()` はこの状態でも上書きできる（読まずに書けるので、書き直しの口は塞がらない）。
   */
  readSettings(): Promise<TokenRotationSettings>;
  writeSettings(settings: TokenRotationSettings): Promise<TokenRotationSettings>;
  /**
   * いま撒いてある現役の指名。まだ一度も指名していなければ `null`。
   *
   * `null` を「1本目が現役」で埋めない: 器の環境変数だけで走っている既定の構成と、プールの1本目を撒いた後は別の状態で、
   * 前者では runner にもクローンにも何も降ろしていない。埋めると、撒いていないものを撒いたことになる（既定の構成の挙動を1文字も変えない）。
   * 置かれている値が壊れて読めないときは `null` へすり替えず `UnreadableActiveTokenError`（`readSettings()` と同じ理由・同じ形）。`writeActive()` はこの状態でも上書きできる。
   */
  readActive(): Promise<ActiveAgentToken | null>;
  /** 現役を指名し直す。世代を増やすのは呼ぶ側（この口は受けた値を書くだけ）。`tokenId` は鍵なので、NUL があれば `NulNotAllowedError` で断る。 */
  writeActive(active: ActiveAgentToken): Promise<ActiveAgentToken>;
}

/**
 * `TokenPoolStore.readSettings()` が、置かれている回転設定を `tokenRotationSettingsSchema` として読めなかったときに投げる。
 * `instanceof` で見分ける（メッセージの文字列で判定すると言い回しの修正で静かに外れる）。メッセージは「どの欄が」だけを含み、値そのものは含めない。
 * `TokenPoolService.setSettings` は、`patch` が `rotateOn` と `cooldownMs` の両方を持っていれば、読めない現在値を読まずに新しい値だけで書き直す。片方しか無ければ埋める元が無いので投げ返す。
 */
export class UnreadableTokenSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableTokenSettingsError';
  }
}

/** `TokenPoolStore.readActive()` が、置かれている現役の指名を `activeAgentTokenSchema` として読めなかったときに投げる（`UnreadableTokenSettingsError` と同じ形・同じ理由）。 */
export class UnreadableActiveTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableActiveTokenError';
  }
}

/**
 * 利用状況の台帳（`usage.ts`）。
 *
 * 持つのはデーモンだけ: runner に持たせると記憶ストアの鍵が要る（M4 受け入れ基準3）。runner から降りてくるのは累積スナップショットという事実だけで、差分にして積むのはここ。
 *
 * 鍵列（`managerId`・`model`・`tokenId`・`provider`・`sessionId`）の NUL は、断らずに落として残す（3実装とも）。
 * これらは集計の切り口で、特定の1行を指して書き換える鍵ではない。断ると、NUL を含む `model` のターンの消費が台帳から丸ごと消える
 * （呼び出し側は失敗を握りつぶして日誌に残すだけ）。害が大きいのは記録を失うほうで、他のストアが鍵の NUL を断るのとは逆の向きの例外である（`nul-guard.ts`）。
 * 同じ理由の例外がもう1つある: `CommitmentStore` の `source`。ジョブと承認待ち（`JobStore`）の参照キー・印と `questions` / `selections` の中の文字列も同じ（`id` 自身は断る）。
 *
 * `aggregate()` の絞り込み（`managerId`・`tokenId`）の NUL は、落としてから引く（3実装とも）: 書き込みが落として残しているので対称にする。投げず、一致しなければ空の集計を返す。
 * NUL だけの `tokenId`（落とすと空文字になるもの）は、固定の目印 `'(nul-only)'`（`USAGE_NUL_ONLY_TOKEN_ID`）に置き換えて記録する: pg の空文字は「帰属なし」の行なので、そのまま落とすと混ざる。
 * `aggregate()` の絞り込みも同じ置き換えを通す。目印の丸括弧は、`randomUUID()`（16進とハイフン）で作られる本物のトークン id に現れないので衝突しない。
 * `aggregate()` の `from` / `to` に NUL を含む日付は「読めない範囲」で、3実装とも一致なし（空の集計）: 日付は鍵ではなく、落として引くと別の日に一致してしまう。
 */
export interface UsageStore {
  /**
   * 累積スナップショットを台帳へ畳み込む。
   *
   * 読むことと書くことを1操作に閉じる: 基準を読んでから増分を書くまでの隙間で同じマネージャーの次の `result` が届くと、同じ増分が2回積まれる
   * （pg はトランザクション、fs は1回の書き込みで守る。`auth-service` と同じ作法）。
   * 返すのは実際に積んだ増分と、数え直しが起きたならその事実。呼び出し側はそれを日誌へ落とす（黙って数え直さない）。
   */
  record(input: {
    /** 誰が使ったか。モデル id で代用しない（`usage.ts` の `usageLayerSchema`）。 */
    layer: UsageLayer;
    /** どこで使ったか。 */
    site: UsageSite;
    /** 誰の分か（マネージャーの id か `CLONE_ACTOR_ID`）。 */
    managerId: string;
    /** ローカル時刻の `YYYY-MM-DD`（`usageDate()` で作る）。 */
    date: string;
    at: string;
    snapshot: UsageSnapshot;
    /**
     * 累積の器がどこで閉じるか。**既定を持たせない**: 黙って `cumulative` に倒すと、1回で閉じる `query()` の高くついた回だけが目減りする
     * （`usage.ts` の {@link foldOneshotUsage}）。呼ぶ側が毎回言う。
     */
    accumulation: UsageAccumulation;
    /**
     * どの認証トークンで使ったか（`AgentToken.id`）。
     * 省略は「取れなかった」であって「既定のトークン」ではない（プールが空の器では毎回省略される）。
     * 呼ぶ側は分からないときに何かを埋めない: 埋めた瞬間、その id で使った分として集計に出る（AGENTS.md 地雷表「取れない軸に 0 の行を作る」の同型）。
     * 渡すのは「そのセッションが起きた瞬間の身元」: 観測のたびに現役を読み直すと、回した後に届いた前のセッションぶんの消費が新しいトークンに付く
     * （`manager.ts` の `#tokenIdentities` が同じ理由で在る）。
     */
    tokenId?: string;
    /**
     * どの runner の累積か（マネージャー層の `cumulative` だけが渡す）。台帳は runner ごとの最後の累積を基準の行に持つ（`UsageBaseline.byRunner`）ので、デーモンを再起動しても消えない。
     * `superseded: true` は「委譲がもう別の runner へ移った後に、古い runner から届いた累積」で、基準の高さ（現役の runner の累積）へは畳まず、
     * その runner 自身の前回との差だけを積む（`foldRecordForStore`）。控えが無い・累積が減っていたときは積まず、返り値の `skipped` に理由を載せる（呼び出し側が日誌に残す）。
     */
    runner?: UsageRecordRunner;
  }): Promise<UsageFold>;

  /**
   * 消費を報告しない provider（`capabilities.usage === false`）のターンを1回数える。
   * 消費の値を積まない: `usage_daily` / `usage_turns` / 基準 / 台帳の始点には触れず、別の行（`UsageUnmeteredRow`）だけを足す。
   * 0 を積むとその層が安いと読めるため、「取れなかった」として `aggregate().unmeteredRows` に出す。
   * 呼ぶ側は `usage === undefined` を理由に呼ばない: 起こす条件は provider の `capabilities.usage === false`（Claude の失敗 result は usage が無いが無報告ではない）。
   */
  recordUnmetered(input: {
    layer: UsageLayer;
    site: UsageSite;
    managerId: string;
    date: string;
    at: string;
    /** 報告しなかった provider の id。 */
    provider: string;
    tokenId?: string;
  }): Promise<void>;

  /**
   * 期間の集計。日 × actor × モデル × 層 × 場所 × 認証トークンの行を返す。
   *
   * `since` / `layersSince` / `tokensSince` を必ず載せる: 台帳が始まる前を照会されたら 0 ではなく「記録が無い」と言えるようにする。
   * 層・トークンの軸は台帳より後から入ったので、それより前の行の `layer` / `site` は既定値であって観測ではなく、プールを使っていない器ではトークンの軸は最後まで始まらない。
   * ここが null のまま `since` だけ載っていると、読む側は「トークンの内訳が空」を「1本のトークンで全部使った」と読みうる。
   */
  aggregate(query: UsageQuery): Promise<UsageAggregate>;

  /**
   * 累積を持つ主体1つの現在の基準（前回読んだ累積）。無ければ null。
   * 鍵は「層 × actor」: actor の id だけで引くと、層をまたいで同じ id が来たときに別の累積が1つの基準を共有し、差分がまるごと嘘になる。
   */
  baseline(layer: UsageLayer, managerId: string): Promise<UsageBaseline | null>;

  /**
   * 台帳（`usage_daily`）に1行でも行が在る managerId の集合（台帳が取りこぼした委譲を見つけるため）。
   *
   * 引数を持たない: `from` / `to` で絞れる形にすると、呼ぶ側が絞り込んだ結果を「行が在る managerId の集合」として使いうる。
   * それをやると照会範囲の外で記録された委譲が「記録が無い」に化ける。この判定は全期間でなければ成り立たない。
   * `aggregate()` の `rows` から作らない: 全件を毎回読み直す高コストな経路になる。器（fs / pg）の索引や集合演算で答える別の口として持つ。
   * 基準（`usage_baseline`）ではなく行（`usage_daily`）を見る: 基準はゼロだけのスナップショットからでも作られうる（`foldUsageSnapshot`）ので、基準の有無で数えると「記録が無い」と「$0.00 使った」が混ざる。
   *
   * 使うのは `ManagerPool.list()` の全委譲との突き合わせ（{@link findUnrecordedManagers}、`usage-format.ts`）だけ。`UsageStore` は `ManagerPool` を知らないので突き合わせは呼び出し側（`app.ts` / `tools.ts`）が行う。
   */
  recordedManagerIds(): Promise<Set<string>>;

  /**
   * 台帳（`usage_daily` / `usage_baseline` / `usage_ledger` / `usage_turns` に当たる4つの単位）を丸ごと消す（ワークスペースのリセット専用）。
   * `since` / `layersSince` / `tokensSince` / `turnsSince` も一緒に消える: 日次行だけを消して開始時刻だけ残すと、`aggregate()` が「記録の空白期間」と「本当に使っていない期間」を見分けられなくなる。
   * 消した行数の内訳を返す。
   */
  clear(): Promise<{ daily: number; baseline: number; ledger: number; turns: number }>;
}

/**
 * 記憶へ移せなかった区間の墓標。退避（`TranscriptArchive.archive`）は済んでいるが蒸留が落ちた区間を指し、次の起動が `archive.read(archiveId)` で拾い直して蒸留できる。
 *
 * 指すのは `archive` の id で、セッション id ではない: 印を立てるのは蒸留が落ちた後で、その時点でセッション id は既に捨てられている
 * （`clone.ts` の「resume すると同じ長すぎる会話が戻ってくる」の枝が、畳むと決めた瞬間に `setCloneSessionId(null)` を打つ）。
 * セッション id を控える形にすると「捨てるのと印を立てるのを同じ操作にする」順序の約束が要り、守り損ねると静かに拾えなくなる。
 */
export interface TranscriptGrave {
  /** `TranscriptArchive.archive()` が返した id。 */
  archiveId: string;
}

/**
 * クローンのセッション id と、記憶へ移せなかった区間の墓標を跨いで覚えておくための最小の永続化。
 *
 * 墓標はセッション id と別の欄に置く（器の実装の約束）: `setCloneSessionId(null)` は resume 素材を捨てる操作で、fs 実装は置き場のファイルを丸ごと消す。
 * 同じレコードに同居させると、resume を捨てた瞬間に墓標も消え、拾い直すために立てた印が拾う理由ができた瞬間に消える。
 */
export interface SessionRegistry {
  getCloneSessionId(): Promise<string | null>;
  /** NUL を含む id は `NulNotAllowedError` で断る。墓標は JSON 文字列で持つので NUL を含んでも往復する。 */
  setCloneSessionId(sessionId: string | null): Promise<void>;
  /**
   * 墓標を読む。**高々1つしか持たない。**
   * 代償: 2回続けて蒸留に失敗すると古い方が失われる。数える単位を増やす（列にする）と、拾い切れなかった墓標が積もる側の面倒が入れ替わりで増える。
   */
  getTranscriptGrave(): Promise<TranscriptGrave | null>;
  setTranscriptGrave(grave: TranscriptGrave | null): Promise<void>;
  /**
   * いま立っているのが `archiveId` の墓標であるときにだけ下ろす。下ろしたら `true`、既に別の墓標へ入れ替わっていたら `false`。
   *
   * `get` → 比較 → `set(null)` で代用しない: 拾い上げ（`Clone#pickUpTranscriptGrave`）は `#pump` から待たれずに走るので、拾っている間に新しい墓標が立ち（文脈窓で畳む回はいつでも起きる）、
   * 素で `null` を書くとその新しい方を消して、その区間は二度と拾われない。
   * 呼び出し側で引き直して比べる形は窓を狭めるだけで閉じない: 読みと書きが別々の `await` なので、引き直しの後・書き込みが効く前に新しい墓標が landing しうる。
   * 判定と書き込みを1操作へ畳む（`CommitmentStore.open` と同じ形・同じ理由）。呼び出し側の壁（ロック）では代わりにならない: ストアのロックは1回の呼び出しの中にしか掛からず、この区間は2回の呼び出しに跨がる。
   */
  clearTranscriptGraveIf(archiveId: string): Promise<boolean>;
  /**
   * resume 素材を捨てた回の墓標（`TranscriptGrave` とは別の欄）。
   * 同じ欄にしない: 文脈窓で畳む回（退避は済んでいる）と、次の起動がセッションを開けなかった回（退避が無い）は別々に同時に立ちうる。
   * 1つの欄に相乗りさせると後に立った方が前の方を消し、消えた側は誰も拾わない。どちらも「高々1つ」。
   */
  getLostSessionGrave(): Promise<LostSessionGrave | null>;
  setLostSessionGrave(grave: LostSessionGrave | null): Promise<void>;
  /** いま立っているのが `sessionId` の墓標であるときにだけ下ろす。理由と形は {@link SessionRegistry.clearTranscriptGraveIf} と同じ。 */
  clearLostSessionGraveIf(sessionId: string): Promise<boolean>;
  /**
   * SDK が生ログを預けるときの scope（`SessionKey.projectKey`）を、器を跨いで覚える。
   * `append` が渡してくる値なので `append` が1度も来ていないプロセスは知らず、墓標を立てたい回（`init` すら来ずに落ちた回）はまさにその回（起き直して resume に失敗した直後）である。
   * 前の器が覚えた値をここから読む。`cwd` から計算し直さない（`LostSessionGrave`）。配備してから1度も `append` が来ていないうちは `null`: その窓で落ちた回は墓標が立たない（拾う鍵が無い）。
   */
  getProjectKey(): Promise<string | null>;
  /** NUL を含む鍵は `NulNotAllowedError` で断る。 */
  setProjectKey(projectKey: string): Promise<void>;

  /**
   * ここが持つ4つの欄（クローンのセッション id・2つの墓標・生ログの scope）をすべて消す（ワークスペースのリセット専用）。
   * resume を諦める操作で、失うのは走っていたセッションへ戻る手段だけ（クローンの同一性は記憶に宿るので、次のターンから記憶を通じて再構成される。`architecture.md`「寿命モデル」）。
   * 消した欄の数（0〜4）を返す。
   */
  clear(): Promise<number>;
}

/**
 * resume 素材を捨てた回に、その区間を後から引くための鍵。
 * `init` すら来ずにセッションが落ちた回は、`clone.ts` が resume 素材（セッション id）を捨てる。その id が pg に載っている生ログを引く唯一の鍵なので、捨てる前にここへ写しておかないと誰も引けなくなる。
 *
 * `projectKey` を `cwd` から計算し直さない: SDK の型定義が逐語で
 * 「Default: sanitized cwd.」 [sdk-verbatim SessionKey.projectKey]
 * と言い、長すぎるパス（200文字超）については
 * 「characters are truncated and suffixed with a portable djb2 hash」 [sdk-verbatim SessionKey.projectKey]
 * とも言っており、再実装は静かにずれる。`append` が渡してくる値をそのまま控える（`clone.ts` の `withProjectKeyProbe`）。
 */
export interface LostSessionGrave {
  projectKey: string;
  sessionId: string;
}

/**
 * pg に載っている生ログの末尾だけを読む口。
 *
 * `SessionStore.load()` を使わない: 全件を戻し（クローンの生ログは 1 セッションで 580 MB 級に育つ）、SDK は `load()` に 60 秒の予算（`Options.loadTimeoutMs` の既定）を掛けているので、
 * 拾い直しのために全件を戻すとその予算に設計が自分から当たりに行く。蒸留が読むのは末尾だけ（`clone.ts` の `tailOf`）なので、末尾を返す口を分ける。
 * pg 構成でだけ付く（`Stores.sessionStore` と同じ。fs 構成には生ログの預け先そのものが無いので、この口も無い）。
 */
export interface SessionTranscriptTail {
  /**
   * 末尾から `maxChars` 文字ぶんを返す。1本も無ければ `null`。
   * 生ログ（JSONL）の形そのままで、行の途中から始まりうる。整えるのは呼び出し側（`tailOf`）: 器ごとに整え方が分かれると蒸留へ渡るものが器で変わる。
   *
   * 契約:
   * - `maxChars` はコードポイント数で数える。UTF-16 コード単位（`.length`）ではない: 補助面の文字でずれる
   *   （`TranscriptArchive.readTail`・`tailByCodePoints`〈`excerpt.ts`〉と同じ区別）。単位の変換は `tailByCodePoints` の唯一の出所へ寄せる。
   * - 本文が `maxChars` より長いとき、返す量は `maxChars` を厳密に上回ること（同じ数で切り詰めない。`TranscriptArchive.readTail` と同じ契約）。
   *   呼び出し側（`tailOf`）は `tailByCodePoints(transcript, DISTILL_TRANSCRIPT_TAIL_CHARS)` の結果が元の文字列と一致するかで「切り詰めが要ったか」を判定するので、
   *   ちょうど `maxChars` 以下を返すと、切り捨てた行があるのに「本文がもとから短かった」と誤読される。本文が `maxChars` 以下なら全文を返す。
   */
  readTail(key: LostSessionGrave, maxChars: number): Promise<string | null>;

  /**
   * その鍵のセッションが占める、おおよその大きさ（バイト）を、本文を1バイトも読まずに測る。
   * `SessionStore.load()` は全件を返す契約で削れないので、大きすぎる鍵は `load()` を呼ぶ前に避けるしかない（呼び出し側は `clone.ts` の `#ensureQuery` 周辺）。
   *
   * 契約:
   * - 返すのは実テキストのバイト数（`JSON.parse` が展開する量）で、ディスク上の格納バイト数ではない。
   *   圧縮後の格納バイトを返さない: 予算は実テキストの量として導かれており（`clone.ts` の `RESUME_SIZE_BUDGET_BYTES`）、圧縮後の値と比べると
   *   いちばん圧縮の効く＝いちばん大きいセッションをいちばん小さく見積もる（実測で約85倍の過小申告。`packages/storage-pg/src/session-store.ts` の `measureSize`）。
   * - 実装は本文（`entry` そのもの）を呼び出し側のメモリへ載せない: 載せれば避けたい OOM をこの関数自身が起こしかねない。
   *   pg 実装は `sum(octet_length(entry::text))` で測り、伸長するぶんコストの上限が要るので `statement_timeout` を掛け、打ち切られたら `null` に倒す。
   * - 測れないとき（実装が対応していない、またはエラー）は `null`。`0` を返さない: `0` は「測って0バイトだった」という実測で、「測れなかった」の代用にしない（AGENTS.md 地雷表「取れない軸に 0 の行を作る」）。
   */
  measureSize(key: LostSessionGrave): Promise<number | null>;
}

/**
 * `PracticeStore.read(slug)` / `readVersion(slug, version)` が、その行を `practiceSchema` / `practiceVersionSchema` として読めなかったときに投げる。
 * `instanceof` で見分ける（メッセージの文字列で判定すると言い回しの修正で静かに外れる）。
 * `slug` と、版を読んでいたときは `version` も持つ: `PUT`/`DELETE /practices/:slug` と `practice_write` / `practice_remove` は `read()` を「無いかどうか」の判定にしか使っていないので、
 * 壊れた行で `read()` が投げて `write()` / `remove()` まで届かない穴を塞ぐ。この4つの口はこれを捕まえたら「在ったが読めない」として扱い、書き直し・削除まで進む。
 */
export class UnreadablePracticeError extends Error {
  readonly slug: string;
  readonly version: number | undefined;

  constructor(message: string, params: { slug: string; version?: number }) {
    super(message);
    this.name = 'UnreadablePracticeError';
    this.slug = params.slug;
    this.version = params.version;
  }
}

/**
 * `PracticeStore.list` の返り値（`ScheduleList` と同じ形）。
 * `PracticeMeta[]` のままにしない: 読めない行を空配列へ潰すと、「やり方はまだ1件も無い。正常」と言い切れてしまう。
 */
export interface PracticeList {
  /** 読めた行。slug の昇順。 */
  entries: PracticeMeta[];
  /** 読めなかった行。「無い」でも「消された」でもない第3の状態。一覧全体は落とさず、行そのものも消さない（`read(slug)` は投げ、`remove` で外せる）。 */
  unreadable: UnreadablePractice[];
}

/** 読めないやり方が在るときの1文（0件なら `null`。0件のときは何も出さない）。本文・題は載せない（`unreadablePracticeSchema`）。 */
export function describeUnreadablePractices(
  unreadable: readonly UnreadablePractice[],
  options: { slugLimit?: number } = {},
): string | null {
  if (unreadable.length === 0) return null;
  const slugLimit = options.slugLimit ?? 10;
  const slugs = unreadable.flatMap((row) => (row.slug === undefined ? [] : [row.slug]));
  const shown = slugs.slice(0, slugLimit);
  const slugNote =
    slugs.length === 0
      ? '（slug も取れない）'
      : `（slug: ${shown.join(', ')}` +
        (slugs.length > shown.length ? ` ほか ${slugs.length - shown.length} 件` : '') +
        (slugs.length < unreadable.length
          ? `。slug が取れない行が ${unreadable.length - slugs.length} 件`
          : '') +
        '）';
  return (
    `読めないやり方が ${unreadable.length} 件ある${slugNote}。` +
    '壊れた行であって、消されたやり方ではない。この一覧には載っていない。'
  );
}

/** 読めない認証トークンの行が在るときの1文（0件なら `null`。0件のときは何も出さない）。トークンの値は載せない（`unreadableTokenSchema`）。識別は id とラベルだけ。 */
export function describeUnreadableTokens(
  unreadable: readonly UnreadableToken[],
  options: { rowLimit?: number } = {},
): string | null {
  if (unreadable.length === 0) return null;
  const rowLimit = options.rowLimit ?? 10;
  const named = unreadable.flatMap((row) => {
    if (row.id === undefined && row.label === undefined) return [];
    return [
      [
        row.id === undefined ? null : `id ${row.id}`,
        row.label === undefined ? null : `ラベル ${row.label}`,
      ]
        .filter((part) => part !== null)
        .join(' / '),
    ];
  });
  const shown = named.slice(0, rowLimit);
  const note =
    named.length === 0
      ? '（id もラベルも取れない）'
      : `（${shown.join(', ')}` +
        (named.length > shown.length ? ` ほか ${named.length - shown.length} 件` : '') +
        (named.length < unreadable.length
          ? `。id もラベルも取れない行が ${unreadable.length - named.length} 件`
          : '') +
        '）';
  return (
    `読めないトークンの行が ${unreadable.length} 件ある${note}。` +
    '壊れた行であって、消されたトークンではない。この一覧には載っていない。' +
    'プールを全文置換する操作（PUT /tokens。alteroid token add などが通る）や回し手の書き戻しは、' +
    'この行を捨てずに持ち越す。消すには、id を指して消す口（POST /tokens/unreadable/remove。' +
    'alteroid token remove-unreadable <id>）を使う' +
    (unreadable.some((row) => row.id === undefined)
      ? '（id が取れない行は、その口では消せない）'
      : '') +
    '。'
  );
}

/**
 * やり方の「版」（記憶の `memoryVersion` と同じ考え方）。保存された `kind` / `title` / `content`（正規化後。`read()` が返す値）の sha256 hex。
 * 版の履歴の番号（`listVersions` の `version`）にしない: 履歴の番号は読み口（`GET /practices/:slug`）が持たず、履歴の整合（壊れた行・`remove()` 後の続き番号）に依存する。
 * `updatedAt` を使わないのも `memoryVersion` と同じ理由。
 */
export function practiceVersion(practice: Pick<Practice, 'kind' | 'title' | 'content'>): string {
  return createHash('sha256')
    .update(JSON.stringify([practice.kind, practice.title, practice.content]))
    .digest('hex');
}

/** `PracticeStore.write` の任意の引数。 */
export interface WritePracticeOptions {
  /** 前提の版（`practiceVersion`）。書く瞬間の版と違えば書かず `PracticeConflictError`。`null` は「無いときだけ書ける」、省略は後勝ち。 */
  ifMatch?: string | null;
}

/** 前提の版が合わず、書かなかった。`current` はいまのやり方（無ければ、読めない形のときも `null`）。 */
export class PracticeConflictError extends Error {
  readonly current: Practice | null;
  constructor(slug: string, current: Practice | null) {
    super(`やり方が読んだ後に変わっています: ${slug}`);
    this.name = 'PracticeConflictError';
    this.current = current;
  }
}

/** `PracticeStore.remove` の任意の引数。 */
export interface RemovePracticeOptions {
  /** 前提の版（`practiceVersion`）。合わなければ消さず `PracticeConflictError`。省略は無条件。 */
  ifMatch?: string;
}

/** 前提の版 `ifMatch` が、いまのやり方と合うか（`undefined` は前提なし＝常に合う）。 */
export function practiceVersionMatches(
  current: Pick<Practice, 'kind' | 'title' | 'content'> | null,
  ifMatch: string | null | undefined,
): boolean {
  if (ifMatch === undefined) return true;
  if (ifMatch === null) return current === null;
  return current !== null && practiceVersion(current) === ifMatch;
}

/**
 * 仕事のやり方 = クローンが読む素材。
 *
 * 器が実行を強制しない（壊れると北極星が壊れる）: 持っているのは読み書きだけで、「このやり方を適用せよ」に当たる操作が1つも無い。
 * 従わせた時点でクローンは「制限された自動化ジョブ」に戻る（`practiceSchema`、`docs/north_star.md`）。
 * この interface に `apply` / `enforce` / `requiredFor` を足さない。足したくなったら、器ではなく指示文の側でやる（読む素材として渡す）。
 *
 * やり方が1件も無いのは正常な状態で、`list()` が空を返してもどこかの前提を崩さない（空を「未設定」の異常として扱わない）。
 * ただし「正常」と言えるのは読めない行も0件のときだけ（`PracticeList.unreadable`）: 読めない行を飛ばして「1件も無い」と言うと壊れた行を無いと見せる。
 */
export interface PracticeStore {
  /**
   * **`entries` は slug の昇順。**（`PersonaStore.list` と同じ理由で契約にしてある — 続きを取る口を後から足すとき、一覧が並んでいることに依拠する。）
   * 照合順序の厳密な一致までは保証しない（`PersonaStore.list` と同じ）。
   *
   * 読めない行（`practiceMetaSchema` に合わない行）は一覧全体を落とさず、`unreadable` に別欄で返す。メモリ実装は `unreadable` が常に空。
   */
  list(): Promise<PracticeList>;
  /**
   * 無ければ `null`。読めないは throw（`UnreadablePracticeError`）。
   *
   * NUL: 書く口は、slug の NUL を入口のスキーマ（`practiceSlugSchema`）が弾く（3実装とも投げる）。本文（`kind`・`title`・`content`）の NUL は落として残す。
   * 読むだけの口（`read`・`readVersion`・`listVersions`・`remove`）は、NUL を含む slug でも断らず「無い」と同じ結果（`null`・`null`・空・何もしない）を返す。
   */
  read(slug: string): Promise<Practice | null>;
  /**
   * 全文置換。存在しなければ作る。
   *
   * 書いた本文は、末尾の改行が正規化されて読み戻る（`write({ ..., content: '# X' })` → `read()` は `'# X\n'`）。`chars`（コードポイント数）も正規化後の本文で数える。
   * 実装は自分で正規化せず `ensureTrailingNewline` を通す（出所が1つに無かったせいで3実装のうち1つだけ振る舞いが違った前科がある。`PersonaStore.write`）。
   * `createdAt` は最初に作られたときのものを引き継ぐ（上書きで作成時刻を捏造しない）。`updatedAt` は毎回進む。
   *
   * 書いた後の本文を、1つの版として追記専用の履歴へ足す。版番号は slug ごとに 1 始まりの連番で、`remove()` しても版は消えず、作り直したら続きから振られる。
   * この追記は `write()` と同じ操作の中で行う: 別操作に割ると、途中で落ちたときに「本体は書き変わったが版は増えていない」食い違いが生まれる。
   *
   * `options.ifMatch` が合わなければ何も書かず（版の履歴にも足さず）`PracticeConflictError`。比較は書き込みと同じ排他の中（fs: `withPathLock` 内、pg: 行ロックつきのトランザクション内、インメモリ: 同期の区間）。
   * `verifyPracticeStoreContract` が3実装に同じ歯を当てる。
   */
  write(
    input: { slug: string; kind: string; title: string; content: string },
    options?: WritePracticeOptions,
  ): Promise<Practice>;
  /**
   * `options.ifMatch` が合わなければ何も消さず `PracticeConflictError`（`current` はいまのやり方。無ければ `null`）。比較は消すのと同じ排他の中（`write` と同じ）。
   * 省略は無条件（HTTP の `DELETE` を壊さない）。読めない形の行は版が無いので「無い」側に数える。
   *
   * 版は消さない: `remove()` が消すのは「いまのやり方」の1件だけで、`listVersions` / `readVersion` の追記専用の履歴は残る
   * （同じ slug を後で作り直したときに前の系統の版を失わないため）。
   */
  remove(slug: string, options?: RemovePracticeOptions): Promise<void>;
  /**
   * 全部消す（ワークスペースのリセット専用。`PersonaStore.clear` と同じ形）。消した件数を返す（`WorkspaceResetSummary` が申告に使う）。消したのに申告に出ない形を作らない。
   * 版の履歴（`listVersions` / `readVersion`）も一緒に消える: `clear()` は人間が明示的に「全部忘れる」と決めた操作なので、`PersonaStore.clear` が保護状態ごと消すのと同じ理由で版もろとも消してよい。
   */
  clear(): Promise<number>;

  /**
   * ある slug の版の一覧（メタだけ。本文は含まない）。版番号の昇順。
   * 無い slug には空配列を返す（throw しない — `list()` が空を正常として扱うのと同じ線）。`remove()` 後も消える前に積んだ版は残り続ける。
   */
  listVersions(slug: string): Promise<PracticeVersionMeta[]>;

  /**
   * 版を1つ、本文まで読む。無ければ `null`（`read()` と同じ線）。読めない行は `UnreadablePracticeError`（`version` も持つ）。
   * `remove()` された slug の版も読める（版は「いまのやり方」の存在に依存しない）。
   */
  readVersion(slug: string, version: number): Promise<PracticeVersion | null>;
}

/** デーモンが必要とするストア一式。 */
export interface Stores {
  persona: PersonaStore;
  journal: JournalStore;
  jobs: JobStore;
  /**
   * 継続中の定期の依頼。
   *
   * **省略可能にしないこと。** 器（fs / pg）が違うだけで上の層が見るものは同じである、が M4 の要件。
   * ここを任意にすると、片方の器では「定期的にやって」が効かないという能力差が生まれる（north_star 禁止1）。
   */
  schedules: ScheduleStore;
  /**
   * まだ処理し終えていない受信箱の合図。
   *
   * **省略可能にしないこと**（`schedules` / `usage` と同じ理由）。ここが任意だと、片方の器でだけデーモンの死で未読が消えるという能力差が生まれる（north_star 禁止1）。
   */
  inbox: InboxStore;
  /**
   * 引き受けたまま終わっていない仕事の台帳。
   *
   * **省略可能にしないこと**（`inbox` と同じ理由）。ここが任意だと、片方の器でだけ「その場で着手しなかった依頼が黙って消える」という能力差が生まれる。
   */
  commitments: CommitmentStore;
  /**
   * 仕事のやり方。
   *
   * **省略可能にしないこと**（`commitments` / `schedules` と同じ理由）。ここが任意だと、片方の器でだけ「人間が書いたやり方が読めない」という能力差が生まれる（north_star 禁止1）。
   */
  practices: PracticeStore;
  archive: TranscriptArchive;
  sessions: SessionRegistry;
  /**
   * ログインしたアカウントと、alteroid を使ってよいかの2値（`auth.ts`）。
   * 「誰がこの API に触れるか」の話で、PRD「権限境界」（クローンが記憶を根拠に何を人間へ確認するか）とは別の層。混ぜない。
   *
   * NUL（3実装とも）: 読むだけの口は、NUL を含む鍵で引かれても断らず「無い」と同じ結果を返す
   * （`getAccount`・`findIdentity`・`findAccessTokenBySha256`・`getLoginRequest`・`findAccountByEmail` は `null`、`listIdentities`・`listAccessTokens` は空配列、
   * `markAccountLoggedIn`・`revokeAccountAccess`・`markAccessTokenUsed` は何もしない、`removeUnreadableAccounts` は `unknown`、
   * `revokeAccessToken`・`grantAccess`・`setAccountOwner` は `not_found`、`beginLoginExchange`・`claimLoginRequest` は `null`〈`claimLoginRequest` は `issue` を呼ばない〉）。
   * 書き込みで NUL の鍵を断るので、NUL を含む鍵の行はどの器にも存在しえない。既存の鍵に NUL を足した値でも一致させない。pg は DB に投げる前に短絡する。
   *
   * 書く口は、鍵・参照キー・突き合わせに使う値の NUL を `NulNotAllowedError` で断り、本文の NUL は落として残す。
   * - 断る: アカウントの `id`・`grantedBy`・`email`、identity の `subject`・`accountId`、トークンの `id`・`accountId`・`sha256`、
   *   ログイン要求の `id`・`nonce`・`codeVerifier`・`claimSha256`・`redirectUri`・`accountId`、`grantAccess` の `by`（`createAccountWithIdentity` と `claimLoginRequest` が発行するトークンも同じ）。
   * - 落として残す: `displayName`、トークンの `label`、ログイン要求の `label`・`error`、identity の `email`。
   *
   * メールアドレス: `AuthAccount.email` は一意の索引と衝突の検査に使うので鍵として断る（落とすと別のアカウントと一致しうる）。
   * `AuthIdentity.email` はプロバイダの申告で毎回上書きされる本文なので落として残す。`findAccountByEmail` は NUL を含めば `null`。例外の文には欄名だけを載せ、値は載せない。部品は `auth-input.ts`。
   */
  auth: AuthStore;
  /** 連携の鍵（外のサービスへ渡す、固定の1 source で外部イベントを送るだけの鍵。`integration-key.ts`）。素の値は持たず sha256 だけを持つ。 */
  integrationKeys: IntegrationKeyStore;
  /**
   * 人間が承認した Bash 許可の記録。
   *
   * **省略可能にしないこと**（`schedules` / `inbox` と同じ理由）。片方の器でだけ「以降許可」が効かないという能力差を作らない。
   */
  permissionGrants: PermissionGrantStore;
  /** 実行環境プロファイル（`.zprofile` 相当）。環境変数を器に増やす代わりの口で、用途が増えるたびに実装を直さずに済ませるためにここに置く。 */
  profile: ProfileStore;
  /**
   * マネージャーへ降ろす環境変数の正本（名前→値）。
   *
   * **省略可能にしないこと**（`schedules` / `inbox` と同じ理由）。ここを任意にすると、片方の器でだけ「器を作り直しても鍵が戻る」という能力差が生まれる（north_star 禁止1）。
   */
  credentials: CredentialVaultStore;
  /**
   * 人間の MCP 連携の登録。
   *
   * **省略可能にしないこと**（`credentials` と同じ理由）。ここを任意にすると、片方の器でだけ「人間が使っている連携がクローンからも使える」が成り立たないという能力差が生まれる（north_star 禁止1）。
   */
  mcpServers: McpServerStore;
  /**
   * 人間が入れた plugin。
   *
   * **省略可能にしないこと**（`mcpServers` と同じ理由）。ここを任意にすると、片方の器でだけ「入れた plugin が器を作り直しても残る」が成り立たないという能力差が生まれる。
   */
  plugins: PluginStore;
  /**
   * 会話の既読の位置と基準時刻（全員で1組）。
   *
   * **省略可能にしないこと**（`mcpServers` と同じ理由）。ここが任意だと、片方の器でだけ既読がデーモンの作り直しで消えるという能力差が生まれる。
   */
  conversationReads: ConversationReadStore;
  /**
   * 認証トークンのプール。
   *
   * **省略可能にしないこと**（`schedules` / `inbox` と同じ理由）。ここを任意にすると、片方の器でだけ「枠に当たったときに他のトークンへ回せる」という能力差が生まれる（north_star 禁止1）。
   */
  tokens: TokenPoolStore;
  /**
   * Codex の ChatGPT ログイン（`auth.json` の中身）の正本（`codex-chatgpt-auth.ts`）。
   *
   * **省略可能にしないこと**（`tokens` と同じ理由）。ここを任意にすると、片方の器でだけ「ログインが器を作り直しても残る」が成り立たないという能力差が生まれる（north_star 禁止1）。
   */
  codexAuth: CodexChatgptAuthStore;
  /**
   * 利用状況の台帳。
   *
   * **省略可能にしないこと**（`schedules` と同じ理由）。ここを任意にすると「pg では消費が見えるが fs では見えない」という能力差が生まれる（north_star 禁止1）。
   */
  usage: UsageStore;
  /**
   * 添付ファイル（画像・動画・ファイル）の置き場。記憶（memory）とは独立で、期限つきで預かる。
   *
   * **省略可能にしないこと**（`usage` と同じ理由。片方の器でだけ添付が預けられない能力差を作らない）。
   */
  attachments: AttachmentStore;
  /**
   * SDK のセッション生ログの預け先（M4 のクラウド構成でだけ付く）。
   * manager-runner はこれを持たない: runner から預かった生ログをここへ落とすのはデーモンで、runner には記憶ストアへ到達する鍵を渡さない（docs/architecture.md「非対称な可視性」）。
   */
  sessionStore?: SessionStore;
  /**
   * 預けた生ログの末尾だけを読む口。`sessionStore` と対で付く。
   * 省略可能なのは `sessionStore` と同じ理由（M4 のクラウド構成でだけ付く）。fs 構成では拾い直せないが、fs には生ログの預け先そのものが無いので、ここだけ揃えても埋まらない（`SessionTranscriptTail`）。
   */
  sessionTranscriptTail?: SessionTranscriptTail;
}

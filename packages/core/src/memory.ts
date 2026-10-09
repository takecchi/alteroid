/**
 * 記憶をクローンの文脈へ載せる形を決める場所。器（fs / pg / インメモリ）の側に置かない:
 * 器ごとに書くと食い違い、インメモリ実装だけ見出し無しの連結でテストが緑になっていた。
 */

import { createHash } from 'node:crypto';

import {
  excerpt,
  excerptLine,
  fillListingBudget,
  renderListing,
  renderListingFromEnd,
} from './excerpt.js';
import { encodeMemoryCursor } from './memory-cursor.js';
import { heuristicChars, type HeuristicChars } from './quantity.js';
import type {
  JournalEntry,
  MemoryCreatedAt,
  MemoryDescriptionDrift,
  MemoryDescriptionFreshness,
  MemoryDocKind,
  MemoryFrontmatterState,
  MemoryProtectionStatus,
} from './schema.js';
import type { JournalQuery, JournalStore } from './store.js';

/**
 * `content` から導出できるもの（区分・要旨・親）は渡さず、`renderMemoryDocuments` が毎回 `content`
 * から読み直す: 保存された別の値との食い違いを作らないため。
 */
export interface MemoryPart {
  slug: string;
  content: string;
  title?: string;
  /** `content` から導出できない（`describedAt` はストアの派生値置き場にある）ので渡し手が添える。 */
  descriptionFreshness?: MemoryDescriptionFreshness;
}

export interface PremiseOutlineFit {
  slug: string;
  total: number;
  shown: number;
  rest: number;
}

export interface MemoryFloor {
  premiseChars: HeuristicChars;
  indexedChars: HeuristicChars;
  tocChars: HeuristicChars;
  totalChars: HeuristicChars;
  premiseDocs: number;
  indexedDocs: number;
  factDocs: number;
  /**
   * `premiseDocs` から引かない: カードが落ちても premise のままである。0 でない限り
   * `totalChars` は蓋が効いた後の値なので、premise を足しても安いと読ませないために持つ。
   */
  demotedPremiseDocs: number;
  largestPremise: { slug: string; chars: HeuristicChars } | null;
  largestIndexed: { slug: string; chars: HeuristicChars } | null;
  /**
   * `demotedPremiseDocs` は除く: 目次を焼いていないので「目次が予算で切れている」と名乗ると嘘になる。
   * `describeMemoryFloor` は本文を持たず before/after の差だけを語るので、計算し直せず値として持つ。
   */
  outlineSaturatedPremise: readonly PremiseOutlineFit[];
}

export function assertNeverMemoryProtectionStatus(status: never): never {
  throw new Error(`未知の記憶保護状態: ${JSON.stringify(status)}`);
}

// 量で判定しない: 蒸留は正当な運用として大きく畳むことがあるため
export function memoryProtectionAllowsFullReplace(status: MemoryProtectionStatus): boolean {
  switch (status.kind) {
    case 'human':
      return false;
    case 'unknown':
      return false;
    case 'clone-only':
      return true;
    default:
      return assertNeverMemoryProtectionStatus(status);
  }
}

export function describeMemoryProtectionStatus(status: MemoryProtectionStatus): string {
  switch (status.kind) {
    case 'human':
      return '人間が過去に書いた記憶（human）';
    case 'clone-only':
      return 'クローンだけが書いてきた記憶（clone-only）';
    case 'unknown':
      return '履歴が無い、または外から書き換えられた可能性がある記憶（unknown。守る側の既定）';
    default:
      return assertNeverMemoryProtectionStatus(status);
  }
}

// 日誌を全件読みにしない: 日誌が育つと1回の呼び出しでヒープに載る量が育ち、起動時の OOM の疑いになるため
export const MEMORY_JOURNAL_SCAN_PAGE_SIZE = 1000;

async function walkMemoryUpdateJournalAscending(
  journal: Pick<JournalStore, 'listPage'>,
  pageSize: number,
  onPage: (page: JournalEntry[]) => void,
): Promise<void> {
  let after: JournalQuery['after'];
  for (;;) {
    const { entries: page, next } = await journal.listPage({
      types: ['memory_update'],
      order: 'asc',
      limit: pageSize,
      ...(after === undefined ? {} : { after }),
    });
    if (page.length > 0) onPage(page);
    // ページの長さで終端を判定しない: store が壊れた行を捨てると、ページは短くなっても・空でも先に行が在りうるため
    if (next === null) return;
    after = next;
  }
}

export async function deriveHumanTouchedAtFromJournal(
  journal: Pick<JournalStore, 'listPage'>,
  options: { pageSize?: number } = {},
): Promise<Map<string, string>> {
  const pageSize = options.pageSize ?? MEMORY_JOURNAL_SCAN_PAGE_SIZE;
  const result = new Map<string, string>();
  await walkMemoryUpdateJournalAscending(journal, pageSize, (page) => {
    for (const entry of page) {
      if (entry.type !== 'memory_update') continue;
      if (entry.cause !== 'human') continue;
      // action:'remove' は含めない: 人間による削除は将来この slug に書かれる新しい内容を保護する理由にならないため
      if (entry.action === 'remove') continue;
      result.set(entry.slug, entry.at);
    }
  });
  return result;
}

export async function deriveMemoryCreatedAtFromJournal(
  journal: Pick<JournalStore, 'listPage'>,
  options: { pageSize?: number } = {},
): Promise<Map<string, string>> {
  const pageSize = options.pageSize ?? MEMORY_JOURNAL_SCAN_PAGE_SIZE;
  const result = new Map<string, string>();
  await walkMemoryUpdateJournalAscending(journal, pageSize, (page) => {
    for (const entry of page) {
      if (entry.type !== 'memory_update') continue;
      // action:'append' と action 無しは対象にしない: 広げて誤って早い時刻を拾うより、根拠が無ければ unknown に倒すため
      if (entry.action !== 'write') continue;
      if (!result.has(entry.slug)) result.set(entry.slug, entry.at);
    }
  });
  return result;
}

// `memory_update` は使わず、新しい `JournalEntryType` も足さない: 記憶（本文）は変わっておらず、種別を足すと web とクローンの道具が型で落ちるため
export function memoryProtectionRebuildDecision(counts: {
  humanRestored: number;
  hashesBaselined: number;
}): { decision: string; grounds: string } {
  return {
    decision:
      '記憶の保護状態の索引（派生値）を日誌から組み直した' +
      `（human 印 ${counts.humanRestored} 件を復元、本文のハッシュ ${counts.hashesBaselined} 件を` +
      '現在の値で基準化）。',
    grounds:
      '索引が読めなかった（無い・壊れている・スキーマが合わない）ため、次の読み出しでその場で' +
      '組み直した。cause:human の記録は日誌が持つので保護（human 印）は失われていないが、' +
      'この組み直しより前に外部から本文が書き換えられていたとしても、それはもう検出できない' +
      '（ハッシュは日誌に無いので、組み直す瞬間の本文の値で新しく基準化するため）。',
  };
}

// frontmatter を意識しない: 区分の判定・malformed の印づけ・目次への振り分けは呼び手（`renderMemoryDocuments`）の責務で、ここで分岐させると単文書を固定している既存のテストの意味が変わるため
// 先頭や本文には触らない: 人間の手書きの記述を整形の都合で書き換えないため
export function renderMemoryDocument({ slug, content }: MemoryPart): string {
  return `<!-- memory: ${slug}.md -->\n${content.trimEnd()}`;
}

const FRONTMATTER_DELIMITER = '---';

const KNOWN_FRONTMATTER_KEYS = new Set(['description', 'type', 'parent']);

// YAML ライブラリを使わない: `description: no` が静かに `false` になる挙動を避け、読めなければ落ちるパーサが欲しいため
export function parseMemoryFrontmatter(content: string): MemoryFrontmatterState {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return { kind: 'none' };

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (closingIndex === -1) return { kind: 'malformed' };

  const fields: { description?: string; type?: string; parent?: string } = {};
  for (const line of lines.slice(1, closingIndex)) {
    const separator = line.indexOf(':');
    if (separator === -1) return { kind: 'malformed' };
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) return { kind: 'malformed' };
    if (key === 'description') fields.description = value;
    else if (key === 'type') fields.type = value;
    else if (key === 'parent') fields.parent = value;
  }
  return { kind: 'parsed', ...fields };
}

export function assertNeverMemoryFrontmatterState(state: never): never {
  throw new Error(`未知の frontmatter 解釈状態: ${JSON.stringify(state)}`);
}

function frontmatterBody(content: string): string {
  return content.slice(memoryBodyStart(content));
}

// frontmatterBody と実装を分けない: 本文と本文の始まる位置が食い違うと、memory_section_move が本文の一部を frontmatter として運ぶため
export function memoryBodyStart(content: string): number {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return 0;
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );
  if (closingIndex === -1) return 0;
  let offset = 0;
  for (let index = 0; index <= closingIndex; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  // content.length へ詰める: 本文が無いのに本文が在るように見えるのを避けるため
  return Math.min(offset, content.length);
}

export interface MemoryFrontmatterPatch {
  description?: string;
  type?: string;
  parent?: string;
}

// キーの並びは `description` → `type` → `parent` に正規化する: 既存の順序を保つ処理ではない
function serializeMemoryFrontmatter(fields: MemoryFrontmatterPatch): string {
  const lines = [FRONTMATTER_DELIMITER];
  if (fields.description !== undefined) lines.push(`description: ${fields.description}`);
  if (fields.type !== undefined) lines.push(`type: ${fields.type}`);
  if (fields.parent !== undefined) lines.push(`parent: ${fields.parent}`);
  lines.push(FRONTMATTER_DELIMITER);
  return lines.join('\n');
}

export interface MemoryFrontmatterLineBreak {
  /** 最初に見つかった改行の位置（1始まりの文字目）。 */
  position: number;
  char: '\n' | '\r';
  excerpt: string;
}

const MEMORY_LINE_BREAK_EXCERPT_RADIUS = 20;

function escapeMemoryLineBreaksForDisplay(value: string): string {
  return value.replace(/\r\n/g, '\\r\\n').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

// `\r` も検査する: 単独の `\r` は目次の1行にそのまま残り、読めない行を作るため
export function containsMemoryFrontmatterLineBreak(value: string): boolean {
  return findMemoryFrontmatterLineBreak(value) !== null;
}

export function findMemoryFrontmatterLineBreak(value: string): MemoryFrontmatterLineBreak | null {
  const match = /[\r\n]/.exec(value);
  if (match === null) return null;
  const index = match.index;
  const char = match[0] as '\n' | '\r';
  const start = Math.max(0, index - MEMORY_LINE_BREAK_EXCERPT_RADIUS);
  const end = Math.min(value.length, index + 1 + MEMORY_LINE_BREAK_EXCERPT_RADIUS);
  const before = escapeMemoryLineBreaksForDisplay(value.slice(start, index));
  const breakMark = escapeMemoryLineBreaksForDisplay(char);
  const after = escapeMemoryLineBreaksForDisplay(value.slice(index + 1, end));
  const excerpt =
    (start > 0 ? '…' : '') + before + breakMark + after + (end < value.length ? '…' : '');
  return { position: index + 1, char, excerpt };
}

export function applyMemoryFrontmatterPatch(
  content: string,
  patch: MemoryFrontmatterPatch,
): string {
  const state = parseMemoryFrontmatter(content);
  if (state.kind === 'malformed') {
    throw new Error(
      'applyMemoryFrontmatterPatch: malformed な frontmatter にはパッチを当てられない' +
        '（呼び手が先に断ること）',
    );
  }
  const priorFields: MemoryFrontmatterPatch = state.kind === 'parsed' ? state : {};
  const nextFields: MemoryFrontmatterPatch = {
    description: patch.description ?? priorFields.description,
    type: patch.type ?? priorFields.type,
    parent: patch.parent ?? priorFields.parent,
  };
  const body = frontmatterBody(content);
  const header = serializeMemoryFrontmatter(nextFields);
  if (body.length > 0) return `${header}\n${body}`;
  // 本文が空のとき `${header}\n` も `header` も無条件には返さない: `frontmatterBody` は閉じの `---` の後ろの改行の有無に関わらず空文字を返すので、元の文書の末尾で決める
  return content.endsWith('\n') ? `${header}\n` : header;
}

const KNOWN_DOC_KINDS: ReadonlySet<MemoryDocKind> = new Set(['premise', 'fact', 'indexed']);

// 綴り間違いの値を黙って書かせない: resolveMemoryDocKind が premise へ倒すので区分は変わらないのに、書き手には変えたつもりが残るため
export function isKnownMemoryDocKind(value: string): value is MemoryDocKind {
  return KNOWN_DOC_KINDS.has(value as MemoryDocKind);
}

// 区分が無い・読めない・未知の値は fact / indexed にせず premise へ倒す: 誤りが「余分に全文を焼く」だけで self_status の総文字数から気づけるが、fact にすると文書が黙って目次の1行へ縮み、気づく手段が失われるため
export function resolveMemoryDocKind(frontmatter: MemoryFrontmatterState): MemoryDocKind {
  if (frontmatter.kind !== 'parsed') return 'premise';
  const { type } = frontmatter;
  if (type !== undefined && KNOWN_DOC_KINDS.has(type as MemoryDocKind))
    return type as MemoryDocKind;
  return 'premise';
}

export function assertNeverMemoryDocKind(kind: never): never {
  throw new Error(`未知の記憶の区分: ${JSON.stringify(kind)}`);
}

export function resolveMemoryDescriptionFreshness(input: {
  description: string | undefined;
  describedAt: string | undefined;
  updatedAt: string;
  describedBytes: number | undefined;
  describedBytesAt: string | undefined;
  currentBytes: number;
}): MemoryDescriptionFreshness {
  if (input.description === undefined) return { kind: 'absent' };
  if (input.describedAt === undefined) return { kind: 'unknown' };
  if (input.describedAt >= input.updatedAt) return { kind: 'fresh' };
  // clamp はここ1か所に置く: 呼び出し側や表示側でも重ねると同じ異常を2箇所が別々に隠し、片方が「0（＝最新）」に化けても気づけないため
  const staleForMs = Math.max(0, Date.parse(input.updatedAt) - Date.parse(input.describedAt));
  const drift = resolveMemoryDescriptionDrift({
    describedBytes: input.describedBytes,
    describedBytesAt: input.describedBytesAt,
    describedAt: input.describedAt,
    currentBytes: input.currentBytes,
  });
  return { kind: 'stale', staleForMs, drift };
}

function resolveMemoryDescriptionDrift(input: {
  describedBytes: number | undefined;
  describedBytesAt: string | undefined;
  describedAt: string;
  currentBytes: number;
}): MemoryDescriptionDrift {
  // `describedBytes` が無いことを 0（変化なし）に見せない: 取れなかったことを変化なしに化けさせないため
  if (input.describedBytes === undefined) return { kind: 'unrecorded' };
  if (input.describedBytesAt === undefined || input.describedBytesAt <= input.describedAt) {
    return {
      kind: 'measured',
      describedBytes: input.describedBytes,
      currentBytes: input.currentBytes,
      deltaBytes: input.currentBytes - input.describedBytes,
    };
  }
  return {
    kind: 'at-least',
    baselineBytes: input.describedBytes,
    baselineAt: input.describedBytesAt,
    currentBytes: input.currentBytes,
    deltaBytes: input.currentBytes - input.describedBytes,
  };
}

export function assertNeverMemoryDescriptionFreshness(freshness: never): never {
  throw new Error(`未知の要旨の鮮度状態: ${JSON.stringify(freshness)}`);
}

export function assertNeverMemoryDescriptionDrift(drift: never): never {
  throw new Error(`未知の要旨の変化量の状態: ${JSON.stringify(drift)}`);
}

export function deriveMemoryFrontmatter(input: {
  content: string;
  updatedAt: string;
  describedAt: string | undefined;
  describedBytes: number | undefined;
  describedBytesAt: string | undefined;
  currentBytes: number;
}): {
  frontmatter: MemoryFrontmatterState;
  kind: MemoryDocKind;
  description: string | undefined;
  parent: string | undefined;
  descriptionFreshness: MemoryDescriptionFreshness;
} {
  const frontmatter = parseMemoryFrontmatter(input.content);
  const kind = resolveMemoryDocKind(frontmatter);
  const description = frontmatter.kind === 'parsed' ? frontmatter.description : undefined;
  const parent = frontmatter.kind === 'parsed' ? frontmatter.parent : undefined;
  const descriptionFreshness = resolveMemoryDescriptionFreshness({
    description,
    describedAt: input.describedAt,
    updatedAt: input.updatedAt,
    describedBytes: input.describedBytes,
    describedBytesAt: input.describedBytesAt,
    currentBytes: input.currentBytes,
  });
  return { frontmatter, kind, description, parent, descriptionFreshness };
}

// 3つの値を1つのオブジェクトで返す: 片方だけ進む状態を型の上で作れなくするため
export function nextDescribedState(input: {
  priorContent: string | null;
  nextContent: string;
  priorDescribedAt: string | undefined;
  priorDescribedBytes: number | undefined;
  priorDescribedBytesAt: string | undefined;
  priorBytes: number | undefined;
  priorUpdatedAt: string | undefined;
  writtenAt: string;
  writtenBytes: number;
}): {
  describedAt: string | undefined;
  describedBytes: number | undefined;
  describedBytesAt: string | undefined;
} {
  const priorDescription =
    input.priorContent === null
      ? undefined
      : ((state) => (state.kind === 'parsed' ? state.description : undefined))(
          parseMemoryFrontmatter(input.priorContent),
        );
  const nextState = parseMemoryFrontmatter(input.nextContent);
  const nextDescription = nextState.kind === 'parsed' ? nextState.description : undefined;

  if (priorDescription !== nextDescription) {
    return {
      describedAt: input.writtenAt,
      describedBytes: input.writtenBytes,
      describedBytesAt: input.writtenAt,
    };
  }

  // 基準点は書き込みのたびに進めない: 進めると常に直前の1回ぶんしか測れなくなるため
  if (input.priorDescribedBytes !== undefined) {
    return {
      describedAt: input.priorDescribedAt,
      describedBytes: input.priorDescribedBytes,
      describedBytesAt: input.priorDescribedBytesAt,
    };
  }

  if (input.priorBytes === undefined || input.priorUpdatedAt === undefined) {
    return {
      describedAt: input.priorDescribedAt,
      describedBytes: undefined,
      describedBytesAt: undefined,
    };
  }
  // 書いた後の値（writtenBytes / writtenAt）を基準にしない: 直後の読み出しが deltaBytes: 0 になり、欠測が「変わっていない」に見えるため
  return {
    describedAt: input.priorDescribedAt,
    describedBytes: input.priorBytes,
    describedBytesAt: input.priorUpdatedAt,
  };
}

// 記憶の全文（branded type — `renderMemoryDocuments` だけが作れる。4-14）
declare const RENDERED_MEMORY_BRAND: unique symbol;

export type RenderedMemory = string & { readonly [RENDERED_MEMORY_BRAND]: true };

function brandRenderedMemory(text: string): RenderedMemory {
  return text as RenderedMemory;
}

export const MEMORY_TOC_LINE_LIMIT = 200;

// 件数の上限とは別に、束ねた全体の文字数にも蓋を持つ（`MEMORY_TOC_CHAR_BUDGET`）: 1行は可変長で、件数だけでは総量が運任せになるため
export const MEMORY_TOC_ENTRY_LIMIT = 300;

// 12,000: 理論上の最悪（約6〜7万字）を約1/5に抑え、fact が数本の現状では噛まない値にした。既存の予算（8,000 / 6,000）の値を写さない: 道具側の予算・premise 1文書あたりの予算とは軸が違うため
export const MEMORY_TOC_CHAR_BUDGET = 12_000;

// MEMORY_TOC_ENTRY_LIMIT と共有しない: あちらはプロンプトへ焼く件数、こちらは1回のツール応答（MCP の出力上限）の文字数で、上限を決めるものが違うため
export const MEMORY_LISTING_BUDGET = 8_000;

interface MemoryTocEntry {
  slug: string;
  title: string;
  description: string | undefined;
  descriptionFreshness: MemoryDescriptionFreshness;
  parent: string | undefined;
}

// 5つを1つに畳まない: 読み手が次に見に行く先が違い、畳むと最も多い状態（親は実在し描画に載っていないだけ）が最も怖い状態（文書が無い）の言葉で報告されるため
export type MemoryTocIssue =
  'missing-parent' | 'cycle' | 'parent-not-listed' | 'parent-not-rendered' | 'cycle-outside-render';

interface ResolvedTocNode {
  entry: MemoryTocEntry;
  depth: number;
  issue?: MemoryTocIssue;
  children: ResolvedTocNode[];
}

interface MemoryPresence {
  readonly slugs: ReadonlySet<string>;
  parentOf(slug: string): string | undefined;
}

// `parentOf` の解析は遅延させる: `#withFreshMemory` は毎ターンここを通り、全体の parent を先読みすると更新の無いターンまで記憶の大きさに比例して重くなるため
function buildMemoryPresence(documents: readonly MemoryPart[]): MemoryPresence {
  const slugs = new Set(documents.map((doc) => doc.slug));
  let parentBySlug: Map<string, string | undefined> | undefined;
  function parentOf(slug: string): string | undefined {
    if (parentBySlug === undefined) {
      parentBySlug = new Map(
        documents.map((doc) => {
          const frontmatter = parseMemoryFrontmatter(doc.content);
          return [doc.slug, frontmatter.kind === 'parsed' ? frontmatter.parent : undefined];
        }),
      );
    }
    return parentBySlug.get(slug);
  }
  return { slugs, parentOf };
}

// 2つを1つの集合に混ぜない: 載っていないだけで記憶には在る親を、全文で載っている親の言い方（「上を読め」）で報告すると嘘になるため
interface MemoryHierarchyElsewhere {
  renderedAsPremise?: ReadonlySet<string>;
  presentInMemory?: MemoryPresence;
}

function resolveMemoryHierarchy(
  entries: readonly MemoryTocEntry[],
  elsewhere: MemoryHierarchyElsewhere = {},
): ResolvedTocNode[] {
  const renderedAsPremise = elsewhere.renderedAsPremise ?? new Set<string>();
  const presentInMemory = elsewhere.presentInMemory;
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const parentOf = new Map(entries.map((entry) => [entry.slug, entry.parent]));

  function detectCycle(slug: string): 'cycle' | 'cycle-outside-render' | undefined {
    const seen = new Set<string>([slug]);
    let cursor = parentOf.get(slug);
    let touchedOutside = false;
    for (;;) {
      if (cursor === undefined || cursor === '') return undefined;
      if (seen.has(cursor)) return touchedOutside ? 'cycle-outside-render' : 'cycle';
      seen.add(cursor);
      if (bySlug.has(cursor)) {
        cursor = parentOf.get(cursor);
        continue;
      }
      if (presentInMemory === undefined) return undefined;
      touchedOutside = true;
      cursor = presentInMemory.parentOf(cursor);
    }
  }

  function effectiveParent(slug: string): {
    parent?: string;
    issue?: MemoryTocIssue;
  } {
    const direct = parentOf.get(slug);
    if (direct === undefined || direct === '') return {};
    // 循環の判定を他より先に行う: 循環を「親は外に在る」で覆うと直すべき欠陥が黙るため
    const cycle = detectCycle(slug);
    if (cycle !== undefined) return { issue: cycle };
    if (!bySlug.has(direct)) {
      // renderedAsPremise を先に見る: 記憶の全体にはその premise も入っており、逆順にすると具体的な言い方が二度と出なくなるため
      if (renderedAsPremise.has(direct)) return { issue: 'parent-not-listed' };
      if (presentInMemory?.slugs.has(direct)) return { issue: 'parent-not-rendered' };
      return { issue: 'missing-parent' };
    }
    return { parent: direct };
  }

  const nodes = new Map<string, ResolvedTocNode>(
    entries.map((entry) => [entry.slug, { entry, depth: 0, children: [] }]),
  );
  const roots: ResolvedTocNode[] = [];

  for (const entry of entries) {
    const node = nodes.get(entry.slug);
    if (!node) continue;
    const resolved = effectiveParent(entry.slug);
    if (resolved.issue !== undefined) node.issue = resolved.issue;
    const parentNode = resolved.parent === undefined ? undefined : nodes.get(resolved.parent);
    if (parentNode !== undefined) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  function sortAndDepth(node: ResolvedTocNode, depth: number): void {
    node.depth = depth;
    node.children.sort((a, b) => a.entry.slug.localeCompare(b.entry.slug));
    for (const child of node.children) sortAndDepth(child, depth + 1);
  }
  roots.sort((a, b) => a.entry.slug.localeCompare(b.entry.slug));
  for (const root of roots) sortAndDepth(root, 0);

  return roots;
}

function flattenMemoryToc(roots: readonly ResolvedTocNode[]): ResolvedTocNode[] {
  const out: ResolvedTocNode[] = [];
  function walk(node: ResolvedTocNode): void {
    out.push(node);
    for (const child of node.children) walk(child);
  }
  for (const root of roots) walk(root);
  return out;
}

export function assertNeverMemoryCreatedAt(createdAt: never): never {
  throw new Error(`未知の記憶作成時刻の状態: ${JSON.stringify(createdAt)}`);
}

// 根拠が無ければ「不明」と明言する: 値を持たないことを空文字で隠さないため
export function formatMemoryCreatedAt(createdAt: MemoryCreatedAt): string {
  switch (createdAt.kind) {
    case 'known':
      return createdAt.at;
    case 'unknown':
      return '不明';
    default:
      return assertNeverMemoryCreatedAt(createdAt);
  }
}

// ここでは clamp を重ねない: 同じ異常を2箇所で別々に隠すと、片方だけ直っていない状態に気づけなくなるため
function formatMemoryStaleness(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間`;
  const days = Math.floor(hours / 24);
  return `${days}日`;
}

// `describedBytes === 0` のときは % を出さない: 0除算を「0%」に化けさせないため
function formatMemoryDescriptionDrift(drift: {
  describedBytes: number;
  currentBytes: number;
  deltaBytes: number;
}): string {
  const sign = drift.deltaBytes < 0 ? '-' : '+';
  const magnitude = Math.abs(drift.deltaBytes).toLocaleString('en-US');
  if (drift.describedBytes === 0) return `本文は${sign}${magnitude}バイト変わった`;
  const percent = Math.round((Math.abs(drift.deltaBytes) / drift.describedBytes) * 100);
  return `本文は${sign}${magnitude}バイト（${sign}${percent.toLocaleString('en-US')}%）変わった`;
}

// `%` と `baselineAt` を出さない: 母数が measured と別の量になり、この文字列は毎ターンプロンプトへ焼かれるのでトークン肥大を避けるため
function formatMemoryDescriptionDriftAtLeast(drift: {
  baselineBytes: number;
  currentBytes: number;
  deltaBytes: number;
}): string {
  const sign = drift.deltaBytes < 0 ? '-' : '+';
  const magnitude = Math.abs(drift.deltaBytes).toLocaleString('en-US');
  return `${sign}${magnitude}バイト以上変わった`;
}

// `at-least` と `unrecorded` を `measured` と同じ言葉にしない: 下限を確定値に見せず、記録が無いことを「0バイト変わった」に化けさせないため
function describeMemoryDescriptionDrift(drift: MemoryDescriptionDrift): string {
  switch (drift.kind) {
    case 'measured':
      return formatMemoryDescriptionDrift(drift);
    case 'at-least':
      return formatMemoryDescriptionDriftAtLeast(drift);
    case 'unrecorded':
      return '本文の変化量は記録されていない';
    default:
      return assertNeverMemoryDescriptionDrift(drift);
  }
}

// stale の有無という1bitの印にしない: 常に鳴る印に読み手が慣れて他の印まで見なくなるため。unknown を「0（最新）」に見せない: 欠測が「手を入れなくてよい」側に化けるため
function memoryFreshnessMarker(freshness: MemoryDescriptionFreshness): string {
  switch (freshness.kind) {
    case 'fresh':
      return '要旨の後に本文は動いていない: ';
    case 'stale':
      return (
        `要旨は本文より${formatMemoryStaleness(freshness.staleForMs)}古い` +
        `（${describeMemoryDescriptionDrift(freshness.drift)}）: `
      );
    case 'unknown':
      return '要旨を書いた時刻が記録されていない: ';
    case 'absent':
      return '';
    default:
      return assertNeverMemoryDescriptionFreshness(freshness);
  }
}

// 5つを畳まない: 読み手が次に疑う先が違う。parent-not-rendered で「見つからない」と書かない: クローンが記憶の階層が壊れたと読んで確かめに行くため
function renderMemoryTocIssue(node: ResolvedTocNode): string {
  if (node.issue === 'missing-parent') return `［親 ${String(node.entry.parent)} が見つからない］`;
  if (node.issue === 'cycle') return `［親 ${String(node.entry.parent)} との間で循環］`;
  if (node.issue === 'parent-not-listed') {
    // 文言は premise を名指ししたまま据え置く: premise/fact のみの入力では出力を1文字も変えないため
    return (
      `［親 ${String(node.entry.parent)} は在るが、この目次は fact だけを列挙する` +
      '（premise として本文が上に全文で載っている）］'
    );
  }
  if (node.issue === 'parent-not-rendered') {
    return (
      `［親 ${String(node.entry.parent)} は在るが、ここに載せた分には含まれない` +
      '（記憶には実在する——消えたのではない）］'
    );
  }
  if (node.issue === 'cycle-outside-render') {
    return (
      `［親 ${String(node.entry.parent)} との間で循環` +
      '（輪の一部はここに載せた分には含まれない——記憶の側にある）］'
    );
  }
  return '';
}

function renderMemoryTocLine(node: ResolvedTocNode): string {
  const indent = '  '.repeat(node.depth);
  const descriptor =
    node.entry.description === undefined
      ? '（要旨なし）'
      : `${memoryFreshnessMarker(node.entry.descriptionFreshness)}${excerptLine(node.entry.description, MEMORY_TOC_LINE_LIMIT)}`;
  return `${indent}- ${node.entry.slug}: ${node.entry.title} — ${descriptor}${renderMemoryTocIssue(node)}`;
}

function tocEntriesCoverWholeMemory(
  entries: readonly MemoryTocEntry[],
  elsewhere: MemoryHierarchyElsewhere,
): boolean {
  if (elsewhere.presentInMemory === undefined) return true;
  const rendered = new Set<string>(entries.map((entry) => entry.slug));
  for (const slug of elsewhere.renderedAsPremise ?? []) rendered.add(slug);
  for (const slug of elsewhere.presentInMemory.slugs) {
    if (!rendered.has(slug)) return false;
  }
  return true;
}

// 件数で切れたか文字数で切れたかを畳まない: 件数は直し方が無く、文字数は要旨を短くする手が在り、畳むと直し方を間違えるため
function renderMemoryTocOmission(input: {
  omitted: number;
  total: number;
  wholeMemory: boolean;
  countCut: boolean;
  charCut: boolean;
}): string {
  const { omitted, total, wholeMemory, countCut, charCut } = input;

  const scope = wholeMemory
    ? `目次の対象は全 ${total} 件`
    : `この目次に並べたのは全 ${total} 件。記憶の全体ではなく、今回載せた分だけである`;

  const cause =
    countCut && charCut
      ? `件数（${formatMemoryCharCount(MEMORY_TOC_ENTRY_LIMIT)} 件の上限）と文字数（予算 ` +
        `${formatMemoryCharCount(MEMORY_TOC_CHAR_BUDGET)} 文字）の両方に当たって切った。`
      : countCut
        ? `${formatMemoryCharCount(MEMORY_TOC_ENTRY_LIMIT)} 件の上限に当たって件数で切った` +
          `（文字数の予算 ${formatMemoryCharCount(MEMORY_TOC_CHAR_BUDGET)} 文字にはまだ余裕がある）。`
        : `文字数の予算 ${formatMemoryCharCount(MEMORY_TOC_CHAR_BUDGET)} 文字に当たって文字数で切った` +
          `（件数は ${formatMemoryCharCount(MEMORY_TOC_ENTRY_LIMIT)} 件の上限の下——要旨が長い文書が多い）。`;

  // 件数のみで切れているときは直し方を出さない: 実行できない助言（fact を減らせ）は越権のため
  const remedy = charCut
    ? ' 要旨（description）が長い文書は memory_frontmatter_set で短くすると、同じ件数でもここに多く載る。'
    : '';

  return [
    `…ほか ${omitted} 件は目次から省略（${scope}）。${cause}`,
    '⚠️ この目次は、fact 文書が存在することを毎ターンの焼き込みの中で名乗る唯一の場所である' +
      '（premise はカードが切られても見出しは必ず残るが、fact はここでしか名乗らない）。' +
      `省かれた ${formatMemoryCharCount(omitted)} 件は、この焼き込みの中では存在しないのと見分けが付かない。`,
    `全件は memory_list、本文は memory_read slug=<slug> で取れる。${remedy}`,
  ].join('\n');
}

function renderMemoryToc(
  entries: readonly MemoryTocEntry[],
  elsewhere: MemoryHierarchyElsewhere = {},
): string {
  const flat = flattenMemoryToc(resolveMemoryHierarchy(entries, elsewhere));
  const countShown = flat.slice(0, MEMORY_TOC_ENTRY_LIMIT);
  const countCut = countShown.length < flat.length;

  const candidateLines = countShown.map(renderMemoryTocLine);

  let charBudgetInfo: { rest: number; shown: number; total: number } | undefined;
  // 断り書きの文言はここで作らない: 切り方を2本のテンプレート系列に割らず、renderMemoryTocOmission が1本で組み立てるため
  renderListing(candidateLines, {
    budget: MEMORY_TOC_CHAR_BUDGET,
    omitted: (info) => {
      charBudgetInfo = info;
      return '';
    },
  });
  const charCut = charBudgetInfo !== undefined;
  const shownLines =
    charBudgetInfo === undefined ? candidateLines : candidateLines.slice(0, charBudgetInfo.shown);
  const omitted = flat.length - shownLines.length;

  const lines = [
    '<!-- memory: index -->',
    '## 記憶の目次（fact。本文は memory_read で開く。階層はインデントで表す）',
    ...shownLines,
  ];
  if (omitted > 0) {
    lines.push(
      renderMemoryTocOmission({
        omitted,
        total: flat.length,
        wholeMemory: tocEntriesCoverWholeMemory(entries, elsewhere),
        countCut,
        charCut,
      }),
    );
  }
  return lines.join('\n');
}

const MALFORMED_FRONTMATTER_NOTE =
  '<!-- memory: frontmatter が壊れている（既知の形にならなかった。premise として扱っている） -->';

const MEMORY_DELTA_MAX_RATIO = 0.5;

// MEMORY_PROMPT_OMITTED_TAIL_BUDGET を流用しない: 切る理由も場面も違い（あちらは毎ターンの焼き込み、こちらは書き換えが起きたときだけ）、定数として分けるため
const MEMORY_DELTA_PUSHED_OUT_BUDGET = 300;

// 要旨にも予算を置く: 上限が無いとそこへ本文を書いて同じ肥大が戻るため
export const MEMORY_PROMPT_DESCRIPTION_BUDGET = 3_000;

// 道具の MEMORY_OUTLINE_BUDGET と共有しない: こちらは毎ターン全員が払う焼き込みの予算で、切る理由が違うため。割る基準は prompt.ts（毎ターンの床）ではなくここが生む断り書き側に置く: 要るときだけ出て、床を増やさないため
export const MEMORY_PROMPT_OUTLINE_BUDGET = 6_000;

// indexed の要旨予算を 6,000 にする: 3,000 のままだと切られるのが末尾（いちばん新しい記述）で、節の目次と要旨の二重の切断になるため。無制限にもしない: 肥大化対策の放棄になるため
export const MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET = 6_000;

// 件数ではなく文字数で持つ: 件数で決めると見出しの長さ次第で断り書きの長さが暴れるため
export const MEMORY_PROMPT_OMITTED_TAIL_BUDGET = 300;

// 1文書あたりの予算とは別に、premise のカード全体にも蓋を持つ: 床が文書数に比例して伸びて文脈窓を超えると、記憶の索引を自動で軽くする経路が無く、人間が直すまでクローンが1ターンも走れなくなるため
export const MEMORY_PREMISE_CARD_BUDGET = 60_000;

// MEMORY_TOC_LINE_LIMIT と値が同じでも使い回さない: 片方だけ直したくなったときに一緒に動いてしまうため
const MEMORY_PREMISE_STUB_LINE_LIMIT = 200;

// 落とした分の一覧にも予算を持つ: 無いと落とした件数に比例して伸び、蓋で切った総量が断り書きの側から戻ってくるため
const MEMORY_PREMISE_STUB_BUDGET = 3_000;

// 見出しはこれ未満へは縮められない: 「平均 N 文字まで縮めれば載る」の N がこれを下回る助言は縮める先が無く嘘になるため
const MEMORY_MIN_HEADING_CHARS = 3;

function renderPremiseOutlineOmission(
  items: readonly string[],
  sections: readonly MemorySection[],
  { rest, shown, total }: { rest: number; shown: number; total: number },
): string {
  const dropped = items.slice(shown);
  // 末尾を残す向きで切る: 落ちた並びの中でも読み手が要るのは新しい側（末尾）で、穴が空くのは古い側（先頭）のため
  const tail = renderListingFromEnd(dropped, {
    budget: MEMORY_PROMPT_OMITTED_TAIL_BUDGET,
    omitted: ({ rest: above }) =>
      `…（この上にさらに ${formatMemoryCharCount(above)} 節落ちている。全部は memory_outline の side=tail で見る）`,
  });

  const outlineChars = items.reduce((sum, item) => sum + item.length, 0);
  const shownChars = items.slice(0, shown).reduce((sum, item) => sum + item.length, 0);
  const droppedChars = dropped.reduce((sum, item) => sum + item.length, 0);
  const headingChars = sections.reduce((sum, section) => sum + section.heading.length, 0);
  // 固定費は引き算で出す: 1行の形（`memorySectionLines`）が変わったときに、書き写した数だけが古くなるのを防ぐため
  const fixedChars = outlineChars - headingChars;
  const room = MEMORY_PROMPT_OUTLINE_BUDGET - fixedChars;
  // 固定費が節数に比例して最短の見出しでも載らない文書には「縮めれば載る」と言わない: 縮める先が無く、実行できない助言になるため
  const arithmetic =
    room < total * MEMORY_MIN_HEADING_CHARS
      ? `⚠ 節id と文字数の固定費だけで ${formatMemoryCharCount(fixedChars)} 文字を使う（予算 ` +
        `${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字）。**見出しを最短（\`# x\`）まで` +
        `縮めても全 ${formatMemoryCharCount(total)} 節は載らない**——固定費は節数に比例するので、` +
        `この文書は縮めるのではなく memory_section_move で割るしかない。`
      : `1行の平均は ${formatMemoryCharCount(Math.round(outlineChars / total))} 文字` +
        `（うち節id と文字数の固定費が ${formatMemoryCharCount(Math.round(fixedChars / total))} 文字）。` +
        `予算 ${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字に全 ` +
        `${formatMemoryCharCount(total)} 節を載せるには、見出しを平均 ` +
        `${formatMemoryCharCount(Math.floor(room / total))} 文字（いま ` +
        `${formatMemoryCharCount(Math.round(headingChars / total))} 文字）まで縮める必要がある。`;

  return [
    `…末尾 ${formatMemoryCharCount(rest)} 節は目次から省略（全 ${formatMemoryCharCount(total)} 節のうち先頭 ` +
      `${formatMemoryCharCount(shown)} 節だけ載せた）。` +
      '⚠ この文書は大きすぎて、目次すら毎ターンの焼き込みに収まっていない。' +
      `節の目次は全 ${formatMemoryCharCount(total)} 節ぶんで ${formatMemoryCharCount(outlineChars)} 文字` +
      `（節の本文の総量ではない）——うち焼き込みに載った分 ${formatMemoryCharCount(shownChars)} 文字、` +
      `予算に入らず省いた分 ${formatMemoryCharCount(droppedChars)} 文字。` +
      `⭐ 落ちている ${formatMemoryCharCount(rest)} 節をすべて移し切るまで、毎ターンの床はほとんど動かない` +
      '——目次の費用は1文書あたりの予算に張り付いていて、節を減らしても「載る節が入れ替わる」だけ' +
      `だからである。${formatMemoryCharCount(shown)} 節まで割り切った時点で省略が消え、この断り書きごと` +
      '床から落ちる——そこが節の移動が床に効き始める点である。',
    '落ちた末尾のうち直近の節（節id はそのまま memory_section_read に渡せる。' +
      '**足したばかりの節はここに出る**）:',
    tail,
    arithmetic,
    'memory_outline は side=tail で末尾も見られるほか、q=<文字列> で見出しを絞り込めば一致した節の節id へ直接届き、' +
      'offset=<N> で先頭から窓をずらして読むこともできる——後者は窓の大きさぶんずつ進めれば、' +
      'この文書がどれだけ大きくても全節の節id に有限回で届く（中央の節も含めて）。これらで残りを確かめてから、' +
      'memory_section_move で付録の文書へ割ること。**移すのは済んだ経緯・' +
      '1回きりの実測・失効した手順であって、末尾の新しい節ではない。** ' +
      '⚠ side=tail は末尾を**読む**ための向きであって、末尾を**移す**ための指示ではない' +
      '——読んで確かめた末尾をそのまま移すと、いちばん新しい学びを fact へ追い出すことになる。' +
      '同じ理由で、q や offset で中央の節id が読めても、それをそのまま移してよいとは限らない——' +
      '何を移すかの基準（直上）は変わらない。',
  ].join('\n');
}

function renderMemoryCardSummaryLine(description: string | undefined, budget: number): string {
  const trimmed = description?.trim() ?? '';
  return trimmed.length === 0
    ? '要旨: （まだ書かれていない。memory_frontmatter_set の description で書くこと——' +
        'ここが空だと、本文を開くまでこの文書が何なのか分からない）'
    : trimmed.length <= budget
      ? `要旨: ${trimmed}`
      : `要旨: ${excerpt(trimmed, budget)}\n` +
        `⚠ 要旨が長すぎて毎ターンの焼き込みに収まっていない（${formatMemoryCharCount(trimmed.length)} 文字 / ` +
        `目安 ${formatMemoryCharCount(budget)} 文字）。全文は memory_list / memory_read に在る。` +
        '要旨に本文を書かず、本文は節へ移して memory_frontmatter_set で要旨を短くすること。';
}

function renderPremiseCard(part: MemoryPart): string {
  const frontmatter = parseMemoryFrontmatter(part.content);
  const description = frontmatter.kind === 'parsed' ? frontmatter.description : undefined;
  const { sections } = scanMemorySections(part.content);

  const head =
    `<!-- memory: ${part.slug}.md（premise・本文は載っていない。` +
    `全 ${formatMemoryCharCount(part.content.length)} 文字 / ${formatMemoryCharCount(sections.length)} 節） -->`;

  const summaryLine = renderMemoryCardSummaryLine(description, MEMORY_PROMPT_DESCRIPTION_BUDGET);

  if (sections.length === 0) {
    return [
      head,
      summaryLine,
      '節: 1つも無い（見出しが無いか、前書きしか無い）。本文は memory_read で開く。' +
        '**見出しを付けると節id で名指しして開けるようになる**（memory_section_read）。',
    ].join('\n');
  }

  // 1行の形は1回だけ組む: 断り書きも同じ行を名指しに使うので、2回組むと目次に載っている行と落ちたと名乗る行が別々の計算になりうるため
  const items = memorySectionLines(sections);
  const listing = renderListing(items, {
    budget: MEMORY_PROMPT_OUTLINE_BUDGET,
    omitted: (part) => renderPremiseOutlineOmission(items, sections, part),
  });

  return [
    head,
    summaryLine,
    '節（memory_section_read に節id を渡せば本文が開く。数字は文字数・子込み）:',
    listing,
  ].join('\n');
}

// renderPremiseCard と同じ `fillListingBudget`・同じ予算で数える: ここで独自にループを書くと、断り書きが数える shown/rest と食い違うため
export function measurePremiseOutlineFit(part: MemoryPart): PremiseOutlineFit | null {
  const { sections } = scanMemorySections(part.content);
  if (sections.length === 0) return null;
  const items = memorySectionLines(sections);
  const { shown, rest, total } = fillListingBudget(items, MEMORY_PROMPT_OUTLINE_BUDGET);
  if (rest === 0) return null;
  return { slug: part.slug, total, shown, rest };
}

function renderIndexedCard(part: MemoryPart): string {
  const frontmatter = parseMemoryFrontmatter(part.content);
  const description = frontmatter.kind === 'parsed' ? frontmatter.description : undefined;
  const { sections } = scanMemorySections(part.content);

  // 見出しは premise と同じ形にする: premise には無い説明を足すと、それだけで premise より必ず大きくなるため
  const head =
    `<!-- memory: ${part.slug}.md（indexed・本文は載っていない。` +
    `全 ${formatMemoryCharCount(part.content.length)} 文字 / ${formatMemoryCharCount(sections.length)} 節） -->`;

  const summaryLine = renderMemoryCardSummaryLine(
    description,
    MEMORY_PROMPT_INDEXED_DESCRIPTION_BUDGET,
  );

  // 節が0件のとき premise と同じ文にしない: indexed の床が premise の床と一致し、indexed の床は premise の床を必ず下回るという不変条件が破れるため
  const sectionsLine =
    sections.length === 0
      ? '節: 1つも無い（見出しが無いか、前書きしか無い）。本文は memory_read で開く。'
      : `節: 全 ${formatMemoryCharCount(sections.length)} 節（目次は載らない。` +
        'memory_outline → memory_section_read で開く）。';

  return [head, summaryLine, sectionsLine].join('\n');
}

function parseOutlineLineHeading(line: string): string | null {
  const match = /^\s*\[[^\]]+\] (.+) — [\d,]+ 文字/.exec(line);
  return match ? (match[1] as string) : null;
}

function classifyDroppedOutlineLines(
  droppedLines: readonly string[],
  currentSections: readonly MemorySection[],
  nextLineSet: ReadonlySet<string>,
): {
  pushedOut: { heading: string; section: MemorySection }[];
  removedOrRewritten: string[];
  ambiguous: string[];
  other: string[];
} {
  const byHeading = new Map<string, MemorySection[]>();
  for (const section of currentSections) {
    const list = byHeading.get(section.heading);
    if (list) list.push(section);
    else byHeading.set(section.heading, [section]);
  }
  // 節ごとに単独で `memorySectionLines` を呼び直さない: id の衝突マーカーは文書全体を見て初めて正しく判定できるため
  const currentLineBySectionId = new Map<string, string>();
  const currentLines = memorySectionLines(currentSections);
  currentSections.forEach((section, index) => {
    currentLineBySectionId.set(section.id, currentLines[index]!);
  });

  const pushedOut: { heading: string; section: MemorySection }[] = [];
  const removedOrRewritten: string[] = [];
  const ambiguous: string[] = [];
  const other: string[] = [];

  for (const line of droppedLines) {
    const heading = parseOutlineLineHeading(line);
    if (heading === null) {
      other.push(line);
      continue;
    }
    const matches = byHeading.get(heading) ?? [];
    if (matches.length === 0) {
      removedOrRewritten.push(line);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push(line);
      continue;
    }
    const section = matches[0]!;
    const currentLine = currentLineBySectionId.get(section.id);
    if (currentLine !== undefined && nextLineSet.has(currentLine)) {
      // 見出しが一致するだけでは押し出されたと言わない: いまの行が新しいカードに現に載っているなら、ただの更新のため
      other.push(line);
      continue;
    }
    pushedOut.push({ heading, section });
  }

  return { pushedOut, removedOrRewritten, ambiguous, other };
}

function renderPushedOutSections(
  pushedOut: readonly { heading: string; section: MemorySection }[],
): string {
  const uniqueById = new Map<string, MemorySection>();
  for (const { section } of pushedOut) uniqueById.set(section.id, section);
  const items = memorySectionLines([...uniqueById.values()]);
  return renderListing(items, {
    budget: MEMORY_DELTA_PUSHED_OUT_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `…ほか ${formatMemoryCharCount(rest)} 節は省略（押し出された ${formatMemoryCharCount(total)} 節のうち ` +
      `${formatMemoryCharCount(shown)} 節だけ載せた。残りは memory_outline で確認すること）。`,
  });
}

function renderPremiseDelta(
  slug: string,
  seenCard: string,
  nextCard: string,
  currentSections: readonly MemorySection[],
): string | null {
  const nextLines = nextCard.trimEnd().split('\n');
  const seenLines = seenCard.trimEnd().split('\n');
  if (nextCard.trimEnd() === seenCard.trimEnd()) return null;

  // 前後の一致（共通の接頭辞・接尾辞）で切らない: カードの1行目は全 N 文字 / M 節を含み必ず変わるので、末尾に節を1つ足しただけで全部変わった扱いになるため
  const seenSet = new Set(seenLines);
  const nextSet = new Set(nextLines);
  const added = nextLines.filter((line) => !seenSet.has(line));
  const droppedLines = seenLines.filter((line) => !nextSet.has(line));
  const unchangedCount = nextLines.length - added.length;

  if (added.join('\n').length > nextCard.length * MEMORY_DELTA_MAX_RATIO) return null;

  const { pushedOut, removedOrRewritten, ambiguous } = classifyDroppedOutlineLines(
    droppedLines,
    currentSections,
    nextSet,
  );

  // 消えたのが節ではない行だけなら文言を出さない: 起きていないことを起きたかのように書かないため
  const droppedNotes: string[] = [];
  if (pushedOut.length > 0) {
    droppedNotes.push(
      `（前の版のカードに載っていたが、予算で押し出された節: ${formatMemoryCharCount(pushedOut.length)} 節。` +
        '節そのものは文書に在る——いまの節id で memory_section_read / memory_section_move に渡せる）:',
      renderPushedOutSections(pushedOut),
    );
  }
  if (removedOrRewritten.length > 0) {
    droppedNotes.push(
      `（前の版に在って、いまは無い節: ${formatMemoryCharCount(removedOrRewritten.length)} 節。` +
        'いまの文書のどの節の見出しとも一致しない——消されたか、見出しごと書き換わった）',
    );
  }
  if (ambiguous.length > 0) {
    droppedNotes.push(
      `（判定できない節: ${formatMemoryCharCount(ambiguous.length)} 節。同じ見出しがいまの文書に複数在るため、` +
        '押し出されたのか消えたのか決められない。memory_outline q=<見出しの一部> で確かめること）',
    );
  }

  return [
    `<!-- memory: ${slug}.md（カードの変わった範囲だけ） -->`,
    `（このカードは全 ${formatMemoryCharCount(nextLines.length)} 行。うち ` +
      `${formatMemoryCharCount(unchangedCount)} 行は変わっていないので載せていない。` +
      `カードの全体は memory_list、節の本文は memory_section_read で開ける）`,
    ...added,
    ...droppedNotes,
  ].join('\n');
}

function renderPremisePart(part: MemoryPart, seen?: string): string {
  const frontmatter = parseMemoryFrontmatter(part.content);
  const card = renderPremiseCard(part);
  const delta =
    seen === undefined
      ? null
      : renderPremiseDelta(
          part.slug,
          renderPremiseCard({ slug: part.slug, content: seen }),
          card,
          scanMemorySections(part.content).sections,
        );
  const rendered = delta ?? card;
  return frontmatter.kind === 'malformed' ? `${MALFORMED_FRONTMATTER_NOTE}\n${rendered}` : rendered;
}

// 識別子を必ず載せる: 詳細を取りに行く鍵が無いと、抜粋にした瞬間に到達できないものが生まれるため
function renderPremiseStub(part: MemoryPart, cardChars: number, kind: MemoryDocKind): string {
  const frontmatter = parseMemoryFrontmatter(part.content);
  const description =
    (frontmatter.kind === 'parsed' ? frontmatter.description : undefined)?.trim() ?? '';
  const { sections } = scanMemorySections(part.content);
  const summary =
    description.length === 0
      ? '（要旨がまだ書かれていない。memory_frontmatter_set の description で書くこと）'
      : excerptLine(description, MEMORY_PREMISE_STUB_LINE_LIMIT);
  return (
    `- ${part.slug}.md（${kind}・全 ${formatMemoryCharCount(part.content.length)} 文字 / ` +
    `${formatMemoryCharCount(sections.length)} 節・カードにすると ` +
    `${formatMemoryCharCount(cardChars)} 文字）: ${summary}`
  );
}

// 測る側と描く側で別の関数を使わない: 蓋が実際に載る量とは違う量を測るため。uncappedChars は呼び手に計算させない: 区切りの数え方が2本に割れて断り書きだけが静かにずれるため
function selectPremiseCards(
  parts: readonly MemoryPart[],
  seenContent: ReadonlyMap<string, string> | undefined,
  render: (part: MemoryPart) => string = renderPremisePart,
): {
  kept: MemoryPart[];
  demoted: { part: MemoryPart; chars: number }[];
  uncappedChars: number;
} {
  // 蓋を掛けるのは記憶の全体を描く呼び手だけ: seenContent が渡される呼びは差分の側で、蓋を掛けると同じ文脈で同じ文書の載り方が2つ並ぶため
  if (seenContent !== undefined) return { kept: [...parts], demoted: [], uncappedChars: 0 };

  const rendered = parts.map((part) => ({ part, chars: render(part).length }));
  const joinedChars = (count: number, sum: number): number =>
    count === 0 ? 0 : sum + MEMORY_SECTION_JOIN.length * (count - 1);
  const totalChars = joinedChars(
    rendered.length,
    rendered.reduce((sum, entry) => sum + entry.chars, 0),
  );
  if (totalChars <= MEMORY_PREMISE_CARD_BUDGET)
    return { kept: [...parts], demoted: [], uncappedChars: totalChars };

  // 位置ではなく大きいほうから落とす: 位置で落とすと落ちる先を動かす手がリネームしか無くなるため。同じ大きさなら slug で決める: 入力の順に依らせないと、同じ記憶が呼びごとに違うカードを落としてクローンが記憶が壊れたと読むため
  const ascending = [...rendered].sort(
    (a, b) => a.chars - b.chars || a.part.slug.localeCompare(b.part.slug),
  );
  const keep = new Set<string>();
  let used = 0;
  for (const entry of ascending) {
    const next = joinedChars(keep.size + 1, used + entry.chars);
    // 1枚も残らない形にしない: 0枚にすると「上限がある」と言えなくなるため
    if (keep.size > 0 && next > MEMORY_PREMISE_CARD_BUDGET) break;
    used += entry.chars;
    keep.add(entry.part.slug);
  }

  return {
    kept: parts.filter((part) => keep.has(part.slug)),
    demoted: rendered.filter((entry) => !keep.has(entry.part.slug)),
    uncappedChars: totalChars,
  };
}

function renderPremiseBudgetNotice(
  demoted: readonly { part: MemoryPart; chars: number }[],
  keptCount: number,
  totalChars: number,
  kindOf: (part: MemoryPart) => MemoryDocKind,
): string {
  const items = demoted.map((entry) =>
    renderPremiseStub(entry.part, entry.chars, kindOf(entry.part)),
  );
  const demotedPremise = demoted.filter((entry) => kindOf(entry.part) === 'premise').length;
  const demotedIndexed = demoted.length - demotedPremise;
  const listing = renderListing(items, {
    budget: MEMORY_PREMISE_STUB_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `…ほか ${formatMemoryCharCount(rest)} 件はこの一覧からも省略（全 ${formatMemoryCharCount(total)} 件のうち ` +
      `${formatMemoryCharCount(shown)} 件だけ出した）。全件は memory_list で取れる。`,
  });

  return [
    '<!-- memory: カードを落とした分（premise / indexed。文書は消えていない） -->',
    `⚠️ カード（premise と indexed）の合計が ${formatMemoryCharCount(totalChars)} 文字になり、` +
      `毎ターンの焼き込みの予算 ${formatMemoryCharCount(MEMORY_PREMISE_CARD_BUDGET)} 文字を超えた。` +
      `⟹ **大きいほうから ${formatMemoryCharCount(demoted.length)} 件のカードを落として1行にした**` +
      `（premise ${formatMemoryCharCount(demotedPremise)} 件 / indexed ${formatMemoryCharCount(demotedIndexed)} 件。` +
      `カードのまま載っているのは ${formatMemoryCharCount(keptCount)} 件）。` +
      '**落ちたのは節の目次と要旨の全文であって、文書そのものではない。**',
    listing,
    '**開く口**: memory_outline slug=<slug>（節の目次。side=tail で末尾も見える）→ ' +
      'memory_section_read（節の本文）。要旨の全文は memory_list / memory_read に在る。',
    '**直し方（どれか1つを実際にやること。読み流さない）**: ' +
      // `indexed` にする手は落ちたのが premise のときだけ出す: 既に indexed の文書へ言うと床が1文字も下がらず、実行できない助言になるため
      (demotedPremise > 0
        ? `(1) 上の premise ${formatMemoryCharCount(demotedPremise)} 件を memory_frontmatter_set で ` +
          'type: indexed にする——要旨だけが焼かれ、節の目次は焼かれなくなるので、' +
          'カード1枚が確実に小さくなる（節は memory_outline の q= / offset= で引ける）。'
        : '') +
      '(2) memory_section_move で割り、付録にした側を memory_frontmatter_set で fact にする' +
      (demotedIndexed > 0
        ? `——**上の indexed ${formatMemoryCharCount(demotedIndexed)} 件に残っている手はこれだけである。` +
          'すでに節の目次を手放しているので、type: indexed にしても1文字も下がらない。**'
        : '') +
      '。**⚠️ 要旨（description）を削る方向へ倒さないこと** —— 要旨は判断の前提そのもので、' +
      '落ちたのは索引のほうである。要旨を削ると、開く口はそのままなのに' +
      '「何が書いてあるか」を指す手掛かりだけが消える。',
  ].join('\n');
}

function renderIndexedPart(part: MemoryPart, seen?: string): string {
  const frontmatter = parseMemoryFrontmatter(part.content);
  const card = renderIndexedCard(part);
  const delta =
    seen === undefined
      ? null
      : renderPremiseDelta(
          part.slug,
          renderIndexedCard({ slug: part.slug, content: seen }),
          card,
          scanMemorySections(part.content).sections,
        );
  const rendered = delta ?? card;
  return frontmatter.kind === 'malformed' ? `${MALFORMED_FRONTMATTER_NOTE}\n${rendered}` : rendered;
}

// 焼き込みの本体と大きさだけを答える関数で別々に書かない: どちらか一方だけを直した瞬間にメーターが実物と食い違うため
function buildMemoryDocumentSections(
  documents: readonly MemoryPart[],
  presentInMemory?: readonly MemoryPart[],
  seenContent?: ReadonlyMap<string, string>,
): {
  premiseParts: MemoryPart[];
  premiseSection: string;
  demotedPremise: MemoryPart[];
  indexedParts: MemoryPart[];
  indexedSection: string;
  tocEntries: MemoryTocEntry[];
  tocSection: string;
} {
  const premiseParts: MemoryPart[] = [];
  const indexedParts: MemoryPart[] = [];
  const tocEntries: MemoryTocEntry[] = [];

  for (const doc of documents) {
    const frontmatter = parseMemoryFrontmatter(doc.content);
    const kind = resolveMemoryDocKind(frontmatter);
    if (kind === 'premise') {
      premiseParts.push(doc);
      continue;
    }
    if (kind === 'indexed') {
      indexedParts.push(doc);
      continue;
    }
    tocEntries.push({
      slug: doc.slug,
      title: doc.title ?? doc.slug,
      description: frontmatter.kind === 'parsed' ? frontmatter.description : undefined,
      descriptionFreshness: doc.descriptionFreshness ?? { kind: 'unknown' },
      parent: frontmatter.kind === 'parsed' ? frontmatter.parent : undefined,
    });
  }

  // 蓋は premise と indexed の両方に掛ける: indexed を蓋の外に置くと上限が「60,000 ＋ indexed の総量」に化けて、文書数に比例して伸びる穴が indexed 側に開き直るため
  const cardParts = [...premiseParts, ...indexedParts];
  const indexedSlugs = new Set(indexedParts.map((part) => part.slug));
  const renderCard = (part: MemoryPart, seen?: string): string =>
    indexedSlugs.has(part.slug) ? renderIndexedPart(part, seen) : renderPremisePart(part, seen);
  const { kept, demoted, uncappedChars } = selectPremiseCards(cardParts, seenContent, renderCard);
  const keptPremiseCards = kept
    .filter((part) => !indexedSlugs.has(part.slug))
    .map((part) => renderPremisePart(part, seenContent?.get(part.slug)));
  const keptIndexedCards = kept
    .filter((part) => indexedSlugs.has(part.slug))
    .map((part) => renderIndexedPart(part, seenContent?.get(part.slug)));
  const premiseSection =
    cardParts.length === 0
      ? ''
      : demoted.length === 0
        ? keptPremiseCards.join(MEMORY_SECTION_JOIN)
        : [
            ...keptPremiseCards,
            renderPremiseBudgetNotice(demoted, kept.length, uncappedChars, (part) =>
              indexedSlugs.has(part.slug) ? 'indexed' : 'premise',
            ),
          ].join(MEMORY_SECTION_JOIN);
  const indexedSection = keptIndexedCards.join(MEMORY_SECTION_JOIN);
  // 在り処ごとに分けて渡す・indexed も premise と同じ集合へ合流させる: 畳むと実在する親が「見つからない」と出るため。indexed も premise と同じくカードとして描かれる側のため
  const cardSlugs = new Set([...premiseParts, ...indexedParts].map((part) => part.slug));
  const presence = presentInMemory === undefined ? undefined : buildMemoryPresence(presentInMemory);
  const tocSection =
    tocEntries.length === 0
      ? ''
      : renderMemoryToc(tocEntries, { renderedAsPremise: cardSlugs, presentInMemory: presence });

  return {
    premiseParts,
    premiseSection,
    demotedPremise: demoted.map((entry) => entry.part),
    indexedParts,
    indexedSection,
    tocEntries,
    tocSection,
  };
}

export interface RenderMemoryDocumentsOptions {
  // 型は slug の集合ではなく文書そのもの: 循環の検出が在否だけでなく parent まで引ける必要があるため
  presentInMemory?: readonly MemoryPart[];

  /**
   * **クローンが既に見ている版**（slug → その時点の `content`）。
   * 載せ直す呼び手（`clone.ts` の `#withFreshMemory`）だけが渡す。
   *
   * 渡すと、premise は**全文ではなく変わった範囲だけ**が描かれる
   * （差分にする価値があるときだけ。`renderPremiseDelta`）。
   * **渡さなければ出力は1バイトも変わらない**——システムプロンプトへの
   * 焼き込みと `measureMemoryFloor`（床の測定）はどちらも渡さないので、
   * 「毎ターンの床」の値はこの引数の存在によって1文字も動かない。
   *
   * **`fact` には効かない。** fact はもともと目次の1行しか載らないので、
   * 差分にする余地が無い（`buildMemoryDocumentSections` は premise の枝でしか
   * これを見ない）。
   */
  seenContent?: ReadonlyMap<string, string>;
}

/**
 * 焼き込みの中で塊を繋ぐ区切り。**`premise` のカード同士・カードと断り書き・
 * `premise` の節と `fact` の目次の、3箇所すべてがこれを使う。**
 *
 * **リテラルで書き散らさない理由は、この区切りが予算の計算に入るからである。**
 * {@link selectPremiseCards} は「カードを1枚足したら全体が何文字になるか」を
 * 区切りぶんも含めて数える。⟹ 繋ぐ側と数える側で別のリテラルを持つと、
 * **蓋が予算をわずかに超えて通る**（`measureMemoryFloor` の doc「数え方を2本に
 * 割ると、どちらかだけを直したときにメーターが黙って嘘をつく」と同じ形）。
 */
const MEMORY_SECTION_JOIN = '\n\n';

/**
 * 区分ごとの節を、実際に焼き込む1本の文字列へ繋ぐ。**可変長の引数を取る**
 * （2026-09-11 に `indexed` の節を挟むため2引数から3引数対応へ拡張した）。
 * 空文字の節は素通りするので、`indexed` を1件も持たない入力では出力が
 * 従来と1バイトも変わらない（不変条件3）。
 *
 * **区切りは {@link MEMORY_SECTION_JOIN} である**——繋ぐ側と数える側で別の
 * リテラルを持つと蓋が予算をわずかに超えて通る（直上の doc）。
 */
function joinMemorySections(...sections: readonly string[]): string {
  return sections.filter((section) => section.length > 0).join(MEMORY_SECTION_JOIN);
}

/**
 * 記憶をクローンの文脈へ載せる、唯一の入口。
 *
 * **区分ごとに載り方を変える**（4-1「B. 区分と載せ方」。`indexed` は
 * 2026-09-11 に追加した3つ目の区分）:
 * - `premise`（判断の前提。既定でもある） — **要旨と節の目次**
 *   （`renderPremiseCard`）。本文は `memory_section_read` で節id を指して開く
 * - `indexed`（特定のプロジェクトでしか使わない記憶） — **要旨だけ**
 *   （`renderIndexedCard`）。節の目次は焼かれない——節を確かめるにはまず
 *   `memory_outline` を呼ぶ必要がある（premise は焼き込みにある目次から
 *   節id をそのまま拾えるが、`indexed` にはその近道が無い）
 * - `fact`（事実と蓄積） — **目次の1行だけ**。本文は `memory_read` で開く
 *
 * **⚠️ かつてここは「`premise` は全文。切り詰めない（切り詰めた前提は『持って
 * いない前提』と区別できない）」だった。人間が実測を見たうえで反転させた**
 * （2026-09-08。経緯と数は `renderPremiseCard` の doc）。**本文が消えたのでは
 * なく、開く口が別に在る**（`memory_section_read`）——「切り詰め」ではないと
 * 言えるのはその口が在るからで、**口を消したらこの載せ方は能力の削除になる。**
 *
 * **どの文書も、カードか目次行かの「どちらか一方」に必ず現れる**（二重に
 * 載せない・取りこぼさない）。文書の順序は呼び手（ストア）が決めた順
 * そのまま（`premise` は slug 昇順のまま連結、`fact` は目次側で
 * 階層・slug 昇順に並べ直す）。
 *
 * frontmatter を1つも持たない文書の集合（`kind: 'none'` のみ）に対しては、
 * 全件が `premise` に分類される——**区分の既定は変えていない。** ただし
 * `premise` の載り方そのものが全文からカードへ変わったので、**「frontmatter
 * 導入前と1バイトも変わらない」はもう成り立たない**（かつてここに在った
 * 受け入れ基準は、人間が載せ方を反転させた時点で意味を失った。歯も同じ
 * 理由で書き換えてある）。
 *
 * ## ⚠️ `documents` が「記憶の全部」でない呼び方がある
 *
 * 上の不変条件（どの文書も全文か目次行のどちらか一方に必ず現れる）は、**記憶の
 * 全体を渡したときの約束である。** `clone.ts` の `#withFreshMemory` は
 * **変わった文書だけ**を渡す——そのとき「渡されなかった文書」は上にも下にも
 * 現れない。**その状態を「存在しない」と報告しないために、部分だけを渡す呼び手は
 * `options.presentInMemory` に記憶の全体の文書を渡すこと**（渡さないと、親が
 * 今回変わっていないだけで「親 X が見つからない」と出る）。
 *
 * ## ⚠️ `options.seenContent` を渡すと premise が全文でなくなる
 *
 * 上の「`premise` は全文。切り詰めない」は、**`seenContent` を渡さない呼び手に
 * 対する約束である。** 渡した呼び手（載せ直し）には、変わった範囲だけが返る
 * ——省いた側は必ず行数と文字数で名乗る（`renderPremiseDelta`）。
 *
 * **これは「切り詰め」ではない。** 切り詰めは「全体を渡すつもりで一部を落と
 * す」ことで、落ちた分が読み手から見えなくなる。こちらは**渡す集合そのものが
 * 「今回変わった範囲」**であり、変わっていない側は同じ文脈の別の場所
 * （システムプロンプトの「現在の記憶」）に全文で載っている。
 */
export function renderMemoryDocuments(
  documents: readonly MemoryPart[],
  options: RenderMemoryDocumentsOptions = {},
): RenderedMemory {
  const { premiseSection, indexedSection, tocSection } = buildMemoryDocumentSections(
    documents,
    options.presentInMemory,
    options.seenContent,
  );
  return brandRenderedMemory(joinMemorySections(premiseSection, indexedSection, tocSection));
}

/**
 * 「記憶の肥大」を測る——毎ターン焼き込みへ実際に載る分量。
 *
 * **`renderMemoryDocuments` と同じ下ごしらえ（`buildMemoryDocumentSections`）を
 * 共有する。** 数え方を2本に割ると、どちらかだけを直したときにメーターが
 * 黙って嘘をつく（このファイル冒頭の見出しの話と同じ形の前科——器ごとに
 * 別々に書いていた載せ方が実際に食い違った）。
 *
 * **`totalChars` は `renderMemoryDocuments(documents).length` と厳密に一致する
 * ことを歯で固定する。** 一致を「たぶん同じ」で済ませない——`joinMemorySections`
 * を両方から呼ぶことで、実装として一致を強制する。
 *
 * **単位は文字（`String.length`）であって bytes ではない。** self_status が
 * 総文字数と文書ごとの bytes を混在させていたことで、依頼者は実際に bytes から
 * 文字数を割り戻して読んでいた——ここで bytes を返すと、対策自身がその誤りを
 * 再生産する。
 *
 * **各 premise の文字数は `content.length` ではなく `renderPremisePart` の
 * 結果の長さで数える**（`tools.ts` の「クローンの文脈へ実際に載る形で数える」と
 * 同じ理由——malformed な frontmatter は説明の1行が前に付くので、`content` だけ
 * を足すと実物より少ない数を「毎ターンの床」として名乗ることになる）。
 */
export function measureMemoryFloor(documents: readonly MemoryPart[]): MemoryFloor {
  const {
    premiseParts,
    premiseSection,
    demotedPremise,
    indexedParts,
    indexedSection,
    tocEntries,
    tocSection,
  } = buildMemoryDocumentSections(documents);
  const totalChars = joinMemorySections(premiseSection, indexedSection, tocSection).length;

  let largestPremise: { slug: string; chars: HeuristicChars } | null = null;
  for (const part of premiseParts) {
    const chars = renderPremisePart(part).length;
    if (largestPremise === null || chars > largestPremise.chars) {
      largestPremise = { slug: part.slug, chars: heuristicChars(chars) };
    }
  }

  let largestIndexed: { slug: string; chars: HeuristicChars } | null = null;
  for (const part of indexedParts) {
    const chars = renderIndexedPart(part).length;
    if (largestIndexed === null || chars > largestIndexed.chars) {
      largestIndexed = { slug: part.slug, chars: heuristicChars(chars) };
    }
  }

  // **束ねた蓋（`demotedPremise`）で1行に落ちた文書は除外する**——目次そのものが
  // 焼かれていないので、「目次が予算で切れている」と名乗ると嘘になる
  // （`MemoryFloor.outlineSaturatedPremise` の doc）。
  const demotedSlugs = new Set(demotedPremise.map((part) => part.slug));
  const outlineSaturatedPremise: PremiseOutlineFit[] = [];
  for (const part of premiseParts) {
    if (demotedSlugs.has(part.slug)) continue;
    const fit = measurePremiseOutlineFit(part);
    if (fit !== null) outlineSaturatedPremise.push(fit);
  }

  return {
    premiseChars: heuristicChars(premiseSection.length),
    indexedChars: heuristicChars(indexedSection.length),
    tocChars: heuristicChars(tocSection.length),
    totalChars: heuristicChars(totalChars),
    premiseDocs: premiseParts.length,
    indexedDocs: indexedParts.length,
    factDocs: tocEntries.length,
    demotedPremiseDocs: demotedPremise.length,
    largestPremise,
    largestIndexed,
    outlineSaturatedPremise,
  };
}

// ---------------------------------------------------------------------------
// 一覧（`memory_list` / `GET /memory` / CLI / Web が使う。全区分を対象にする）
// ---------------------------------------------------------------------------

/** `memory_list` 等の一覧に出す1件。`MemoryDocumentMeta` はこれを満たす。 */
export interface MemoryListingEntry {
  slug: string;
  title: string;
  kind: MemoryDocKind;
  description: string | undefined;
  descriptionFreshness: MemoryDescriptionFreshness;
  parent: string | undefined;
  updatedAt: string;
  createdAt: MemoryCreatedAt;
}

/**
 * 記憶の一覧を人間可読な形にする（`memory_list` ツールの出力）。
 *
 * **プロンプトへ焼き込む目次（`renderMemoryDocuments` の TOC 節）とは別物。**
 * あちらは `fact` だけを対象にする（`premise` は全文で載っているので二重に
 * 載せない）が、こちらは**全区分を対象にする**——一覧はクローンが「何が
 * あるか」を把握するための道具であり、`premise` の文書も一覧には出ている
 * べきである（全文がどこかに焼かれていることと、一覧に載ることは別の話）。
 *
 * 階層の組み立て（循環・存在しない親の扱い）は目次と同じ実装を共有する。
 *
 * **上限は件数ではなく文字数で持つ。** ここが無上限だったあいだ、
 * `MEMORY_TOC_ENTRY_LIMIT` はプロンプトへ焼く目次（`renderMemoryToc`）にだけ
 * 効いていて、同じものを返す道具（`memory_list`）は全件を返していた。
 *
 * そして**件数だけでは足りない。** 300件 × 1行200字で 60,000 字になり、
 * `manager_list` が実際に溢れた 52,997 字を超える。件数から出力量を決めると
 * 何件で壊れるかが運任せになる——だから他の一覧（`journal_read` /
 * `manager_list` / `approvals_list` / `schedule_list` / `runner_list`）と
 * 同じ `renderListing` を通し、**文字数の予算**で締める。
 */
/**
 * @param paging - **道具（`memory_list`）から呼ぶときだけ渡す。**渡すと、予算で
 * 落ちた分の断り書きが `cursor` を案内する形になる（#662）。⛔ **省略時の文言は
 * 1文字も変わらない**——プロンプトへの焼き込みなど、続きを取る口が無い呼び手が
 * 他に在るので、そちらの出力を動かさない。
 */
export function renderMemoryListing(
  entries: readonly MemoryListingEntry[],
  paging?: { total: number; anchor?: string },
): string {
  if (entries.length === 0) return '（記憶はまだ空）';

  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  // **錨（続きの頁の先頭。#2510）は親から切り離して root の先頭に描く。**
  // 親が view に在ると錨が子として親の後ろへ回って落ち、同じ cursor が返り
  // 続ける（`memory-cursor.ts` の「頁が必ず進むこと」）。
  const anchor = paging?.anchor;
  const tocEntries: MemoryTocEntry[] = entries.map((entry) => ({
    slug: entry.slug,
    title: entry.title,
    description: entry.description,
    descriptionFreshness: entry.descriptionFreshness,
    parent:
      entry.slug === anchor && entry.parent !== undefined && bySlug.has(entry.parent)
        ? undefined
        : entry.parent,
  }));
  const roots = resolveMemoryHierarchy(tocEntries);
  const anchorRootIndex =
    anchor === undefined ? -1 : roots.findIndex((root) => root.entry.slug === anchor);
  if (anchorRootIndex > 0) roots.unshift(...roots.splice(anchorRootIndex, 1));
  const flat = flattenMemoryToc(roots);

  const items = flat.map((node) => {
    const meta = bySlug.get(node.entry.slug);
    const indent = '  '.repeat(node.depth);
    const kindTag = meta === undefined ? '' : `[${meta.kind}] `;
    // ラベルの語彙・順序（`作成: … / 更新: …`）は `manager_list` / `schedule_list`
    // に既に在るもの（`tools.ts`）と揃えてある——同じ人間の依頼（id + 名前 + 概要 +
    // updated_at + created_at）に対する3本目の一覧なので、ここだけ違う言い方を
    // 発明しない。
    const updatedAt =
      meta === undefined
        ? ''
        : ` (作成: ${formatMemoryCreatedAt(meta.createdAt)} / 更新: ${meta.updatedAt})`;
    const descriptor =
      node.entry.description === undefined
        ? ''
        : ` — ${memoryFreshnessMarker(node.entry.descriptionFreshness)}${excerptLine(node.entry.description, MEMORY_TOC_LINE_LIMIT)}`;
    return `${indent}- ${kindTag}${node.entry.slug}: ${node.entry.title}${updatedAt}${descriptor}${renderMemoryTocIssue(node)}`;
  });

  return renderListing(items, {
    budget: MEMORY_LISTING_BUDGET,
    omitted: ({ rest, shown, total }) => {
      // **母数は cursor を当てる前の全件**（頁が進んでもこの数は変わらない）。
      // `renderListing` が渡す `total` は今回の view の件数なので、道具から
      // 呼ばれたときは `paging.total` を優先する（`schedule_list` が同じ理由で
      // 同じことをしている）。
      const whole = paging?.total ?? total;
      const head = `…ほか ${rest} 件は省略（記憶は全 ${whole} 件あり、${shown} 件だけ出した）。`;
      if (paging === undefined) {
        // 続きを取る口が無い呼び手（プロンプトへの焼き込み等）。**文言は従来どおり。**
        return head + '狙った文書が出ていなければ memory_read slug=<slug> で直接開けること。';
      }
      // **落ちた中でいちばん小さい slug から（含む）**続ける。描く順（木の DFS）と
      // 錨の順（slug 昇順）が一致しないので、「最後に出した行の後ろから」では
      // 行が飛ぶ——理由の全文は `memory-cursor.ts` の
      // 「`schedule-cursor.ts` とあえて違えた点」に在る。
      // 「いちばん小さい」は **entries（＝view＝ストア順）での最初**で取る。JS の
      // 文字列比較で取ると、view を切った順序（照合順序）と食い違ったとき間の
      // 文書が飛ぶ。錨は必ず出ているので、from は錨より厳密に後ろ（頁が進む）。
      const omittedSlugs = new Set(flat.slice(shown).map((node) => node.entry.slug));
      const from = entries.find((entry) => omittedSlugs.has(entry.slug))!.slug;
      return (
        head +
        `続きは memory_list cursor=${encodeMemoryCursor({ from })} で取れる` +
        '（⚠ 木の順で描くので、続きの頁に一度出た文書がもう一度出ることがある。' +
        '**落とさない側へ倒してある。**）。'
      );
    },
  });
}

// ---------------------------------------------------------------------------
// memory_write / memory_append の応答に添える差分の要約（#318 案 (d)）
// ---------------------------------------------------------------------------

/**
 * なぜ要るか。
 *
 * クローンが `memory_write` で全文を再生成するとき、ツール呼び出しの
 * 中で本文を作り直す。その本文が途中で切れても、記憶には控えも履歴も
 * 無いので突き合わせる相手が存在しない——だからクローンは全文置換を
 * 安全に選べない。ここは「そもそも切れない」ようにするものではなく、
 * **切れたことにその場で気づけるようにする**ものである。
 *
 * `memory_append` にも同じ要約を付ける。追記も、追記しようとした文字列
 * そのものがツール呼び出しの中で切れれば、足りない分は静かに失われる。
 * ただし append は既存を消さないので、「消えた見出し」は理屈のうえでは
 * 常に 0 件のはずである——0 件でないなら append の異常（呼び手のバグや
 * ストア側の想定外の挙動）を疑う根拠になる。
 *
 * **この「常に」が何に依っているかを書いておく（#354）。** 依っているのは
 * 「消さない」ことではなく、**追記が `before` を*行の境界を保ったまま*
 * 前置きすること**である。`PersonaStore.append` の実装が
 * `${existing.content}${content}`（あいだに改行を挟まない形）になると、
 * **末尾の行が見出しだった文書でその見出しが追記の1行目と融合し、消えた
 * 見出しとして名指しされる**——`tsc` は落ちず、説明文（`memory_append`）
 * だけが静かに嘘になる。
 *
 * **実装は3つ在るので、歯も3つに置いてある**（1つを測って3つとも測った
 * ことにしない）: `tools.test.ts`（`testing.ts` のインメモリ実装。道具の
 * 応答まで通す）・`packages/storage-fs/src/index.test.ts`・
 * `packages/storage-pg/src/index.persona.test.ts`。**fs と pg は書き込みのたびに
 * 本文を `ensureTrailingNewline` に通すので二重に守られており、`append`
 * 側の連結だけを壊しても落ちない**（#354 の変異試験で実測した）。
 * **単一点なのは `testing.ts` のインメモリ実装だけである。**
 *
 * **単位は文字数で統一する**（`content.length`）。日誌の `bytesBefore` /
 * `bytesAfter`（バイト）はそのまま——機械可読な面はバイト、人が読む面は
 * 文字という既にある二重構造（`memory_delete` の「削除直前 N 文字」と
 * 同じ軸）を壊さない。バイトと文字を1つの文に混ぜない。
 *
 * **本文そのものは載せない**（AGENTS.md「秘密の扱い」）。載せるのは
 * 見出しの文字列と数だけである。
 */

/** 消えた見出しの列挙を切るときの予算（文字数）。`renderListing` と同じ規律。 */
export const MEMORY_MISSING_HEADINGS_BUDGET = 600;

function formatMemoryCharCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** 増減の文字数。0 以上には `+` を付け、符号を持たない生の数と区別する。 */
function formatMemoryCharDelta(delta: number): string {
  return delta >= 0 ? `+${formatMemoryCharCount(delta)}` : formatMemoryCharCount(delta);
}

/**
 * Markdown の ATX 見出し（行頭の `#` 〜 `######`）を抜き出す。
 *
 * **行頭に限る。** 行の途中に `#` があるだけの行（インラインの `#`）は
 * 見出しではない——ここを緩めると、本文中の `#` がすべて「見出し」として
 * 数えられてしまう。
 *
 * ## ⚠️ 過剰に拾う側へ「意図して」倒してある（#354）
 *
 * この関数を呼ぶのは `missingMemoryHeadings` だけで、そこでの誤りは2方向
 * にしか出ない。**その2つは対称ではない。**
 *
 * | 誤りの向き               | 何が起きるか                                                                     |
 * | ------------------------ | -------------------------------------------------------------------------------- |
 * | **拾いすぎ（偽陽性）**   | 見出しでないものが「消えた見出し」に名指しされる。呼び手が余分に1つ確かめて済む  |
 * | **拾い漏れ（偽陰性）**   | 本物の見出しが消えたのに「消えた見出し: なし」と返る。**その場で気づく手段が無い** |
 *
 * 差分の要約が在る理由は「全文置換で本文が途中で切れたことに**その場で**
 * 気づく」ことだけで、記憶には控えも履歴も無い（`describeMemoryWriteDiff`
 * の doc）。**見落としたらそこで終わる。** だから拾いすぎを受け入れて
 * 拾い漏れを潰す側へ倒す。**これは #338 の実装がたまたまそうなっていた
 * 向きを、意図として固定したものである（#354）。**
 *
 * ### 次に触る人へ — 以下は欠陥ではない。「直す」と検出器が弱くなる
 *
 * - **コードフェンス（```` ``` ````）の中を除外していない。** フェンスの中の
 *   `# コメント`（シェル・設定ファイルの例）も見出しとして数える。**除外する
 *   実装を足さないこと** — フェンスの開閉が非対称な本文（**途中で切れた本文が
 *   まさにそうなる**）ではフェンスの内外を見誤り、そこから先の本物の見出しを
 *   丸ごと落とす。**この検出器がいちばん働くべき入力で、いちばん壊れる。**
 * - **setext 見出し（`===` / `---` の下線）は数えていない。** こちらは逆向きの
 *   拾い漏れで、上の方針からは足すほうが正しい。足していないのは、`---` が
 *   frontmatter の閉じと同じ形で、区別に本文全体の文脈が要るからである。
 *   **限界として道具の説明文（`memory_write` / `memory_append`）にも書いてある**
 *   ので、足すならそちらも直すこと。
 *
 * **単位は文字（`content.length`）である。** 日誌の `bytesBefore` /
 * `bytesAfter` はバイトで、別物である（`describeMemoryWriteDiff` の doc の
 * 「バイトと文字を1つの文に混ぜない」）。
 *
 * ### ⚠️ ただし「見落とす側」の限界が1つ在る。ここではなく呼び手にある
 *
 * この関数の倒し方（拾いすぎる側）だけを読んで「見落としは無い」と結論
 * しないこと。**`missingMemoryHeadings` は見出しを集合で比べるので、同じ
 * 見出しが他所に残っていれば節を丸ごと消しても検出されない**——向きが逆の
 * 限界で、そちらの doc に実測ごと書いてある（#354）。
 */
function extractMemoryHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split('\n')) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) headings.push(`${match[1]} ${match[2]}`);
  }
  return headings;
}

/**
 * `before` に在って `after` に無い見出しを、重複を畳んで返す（出現順）。
 *
 * 見出しは集合として比べる——同じ見出しが `before` に複数回出ていても、
 * `after` のどこかに1つでも残っていれば「消えた」とは数えない。
 *
 * ## ⚠️ この設計が生む見落とし（#354）
 *
 * 直上の1文は**挙動**であって、**その結果どういう見落としが起きるか**を
 * 言っていない。言うとこうなる:
 *
 * > **同じ見出しが文書の他所に1つでも残っていれば、その見出しの節を
 * > 丸ごと消しても「消えた見出し: なし」が返る。**
 *
 * 実測（この2関数をそのまま走らせたもの）:
 *
 * ```
 * before の見出し: ["# 私について","### だから","## 経歴","### だから"]
 * after  の見出し: ["# 私について","### だから","## 経歴"]
 * missingMemoryHeadings = []      // ← 2つ目の「### だから」の節が丸ごと消えている
 * ```
 *
 * **これは `extractMemoryHeadings` の doc に在る限界とは向きが逆で、その
 * ぶん重い。** あちらは拾いすぎる（偽陽性）側だが、こちらは**見落とす
 * （偽陰性）側**である。この場合に残る手がかりは、同じ行に並ぶ文字数の
 * 増減（`describeMemoryWriteDiff`）だけになる。
 *
 * ## それでも集合で比べる——直さないこと
 *
 * **多重度を保つ形（`### だから` が2回 → 1回なら1件消えたと数える）へ
 * 変えないこと。** 同じ見出し（`### だから` のような定型の小見出し）を
 * 何度も使う記憶では、**多重度を見ると誤検出のほうが増える**——節の並べ
 * 替えや統合のたびに「消えた」が鳴り、鳴りっぱなしの警報は読まれなく
 * なる。**#338 のレビューで承認された設計判断であって、欠陥ではない。**
 *
 * 限界のほうは道具の説明文（`memory_write` / `memory_append`）にも書いて
 * あるので、ここを変えるならそちらも直すこと。**歯は `tools.test.ts` に
 * 在り、この見落としを「仕様」として固定している**（反転しに来ないこと）。
 *
 * **偽陽性と偽陰性のどちらへ倒してあるかの全体像は `extractMemoryHeadings`
 * の doc に在る。** ここを厳しくする変更は、そちらを読んでからにすること。
 */
function missingMemoryHeadings(before: string, after: string): string[] {
  const beforeHeadings = extractMemoryHeadings(before);
  const afterHeadings = new Set(extractMemoryHeadings(after));
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const heading of beforeHeadings) {
    if (afterHeadings.has(heading)) continue;
    if (seen.has(heading)) continue;
    seen.add(heading);
    missing.push(heading);
  }
  return missing;
}

/**
 * **⚠️ #662。省略された分へ到達する手は無い——ここは「口が無い」ではなく
 * 「継続点の指す先が存在しない」側である。** 他の一覧（`schedule_list` /
 * `manager_list` / `memory_list` / `token_list` / `runner_list` /
 * `approvals_list`）が予算で切ったときに `cursor` / `offset` を案内できる
 * のは、切った側の中身が呼び手の到達できる場所（ストアや帳面）に残って
 * いるからである。**ここは違う。** `before` はこの関数の呼び出しが返る
 * 時点で既に上書きされていて（`PersonaStore` に控えも履歴も無い——
 * `describeMemoryWriteDiff` の doc の「記憶には控えも履歴も無いので突き
 * 合わせる相手が存在しない」）、消えた見出しの文字列はこの1行の外の
 * どこにも残っていない。**だから「言えないと書く」のが正しい**（#662 の
 * 逐語）。`token_list` が到達手段を持たなかった頃に使っていた自己申告
 * （`残りを見る手はこの道具に無い`）に字面を寄せてある。
 */
function describeMemoryHeadingDiff(before: string, after: string): string {
  const missing = missingMemoryHeadings(before, after);
  if (missing.length === 0) return '消えた見出し: なし。';
  return [
    `消えた見出し（${formatMemoryCharCount(missing.length)} 件）:`,
    renderListing(
      missing.map((heading) => `- ${heading}`),
      {
        budget: MEMORY_MISSING_HEADINGS_BUDGET,
        omitted: ({ rest, shown, total }) =>
          `…ほか ${rest} 件は省略（消えた見出しは全 ${total} 件のうち ${shown} 件だけ出した）。` +
          '**残りを見る手はここに無い**——before の本文はこの応答の外のどこにも残っていない。',
      },
    ),
  ].join('\n');
}

/**
 * `memory_write` / `memory_append` が成功したときに返す差分の要約。
 *
 * `before` は書き込み前の本文（無ければ `null`）、`after` は書き込み後の
 * 本文（ストアが返した実際の値——呼び手が計算し直さない）。
 *
 * **新規作成（`before === null`）は「前」が無いので、増減ではなくそう
 * 分かる形にする。** 見出しの比較も行わない（比べる相手が無い）。
 */
export function describeMemoryWriteDiff(before: string | null, after: string): string {
  if (before === null) {
    return `新規作成（${formatMemoryCharCount(after.length)} 文字）。`;
  }
  const delta = after.length - before.length;
  const charLine = `${formatMemoryCharCount(before.length)} → ${formatMemoryCharCount(after.length)} 文字（${formatMemoryCharDelta(delta)}）`;
  return [charLine, describeMemoryHeadingDiff(before, after)].join('\n');
}

/**
 * `N` から `M` へ動いたことを、矢印（`→`）を使わずに言う。
 *
 * **`describeMemoryWriteDiff` は矢印を使うのに、なぜここは使わないのか。**
 * `tools.test.ts`（`memory_write` の新規作成の歯）に
 * `expect(reply).not.toContain('→')` が固定で在り、これは「新規作成には
 * 『前』が無いので増減の矢印が出ない」ことを測る歯である。`describeMemoryFloor`
 * は新規作成のときも（premise が新規作成された場合は特に強く）床の遷移を言う
 * ——同じ応答に矢印を持ち込むと、上の歯が「新規作成なのに増減の表現がある」を
 * 誤って撃つ。**両立できないので、ここだけ矢印を使わない側へ倒した。**
 */
function formatMemoryFloorTransition(beforeChars: number, afterChars: number): string {
  const delta = afterChars - beforeChars;
  return (
    `${formatMemoryCharCount(beforeChars)} 文字から ${formatMemoryCharCount(afterChars)} 文字へ` +
    `（${formatMemoryCharDelta(delta)}）`
  );
}

/**
 * `memory_write` / `memory_append` / `memory_frontmatter_set` /
 * `memory_section_move` の応答の末尾に添える、「毎ターンの床」の一言。
 *
 * **`describeMemoryWriteDiff` とは別の関数である。** あちらは4口が共有していて
 * 出力を `tools.test.ts` が78件の `expect(reply)` で逐語に固定しているため、
 * 機能を足せば全部を壊す。こちらは追加の1行として応答の末尾に足すためだけに
 * 存在する。
 *
 * 言うことは4つ:
 * 1. 書いた文書の区分（`premise` / `fact`。書いた**後**の区分）
 * 2. 焼き込み全体の文字数が `before.totalChars` → `after.totalChars` へ
 *    どう動いたか（文字。`renderMemoryDocuments(documents).length` と一致する値。
 *    **`stores.persona.documents()` をいま読み直した値であることを短く名乗る**
 *    ——`read()` から `write()` までの間に人間が `PUT /memory/:slug` で
 *    書き換える窓があり、ここに出る値と次のターンに実際に焼かれる量が
 *    一致しない可能性があるため。`self_status` が既に採っている形
 *    「記憶の大きさ（いま stores.persona を読み直した値）」に揃える）
 * 3. **`premise` を新規作成したときだけ**、それが「毎ターン要旨と節の目次が焼かれる」
 *    ことを1行で言う——premise の新規作成は稀である（習慣化しない）ので、
 *    ここだけ他の枝より明確に強い言い方にしてある。**この枝にはさらに2つ
 *    足す**（依頼者の決裁。#318 の議論で「線が無くても、稀にしか出ない枝には
 *    置ける」とされた手当てを、稀にしか出ないこの枝へ畳んだもの）:
 *    - **いま最大の premise を名指しする**（`after.largestPremise`。書いた
 *      直後の状態で「どこを見ればよいか」にその場で答える——依頼者はまさに
 *      これが無くて詰まった。`about-me-core` を作った夜、応答は文字数だけ
 *      だった）
 *    - **縮めるのに全文置換は要らないこと**と、その3手順の道具名
 *      （`memory_outline` → `memory_section_move` → `memory_frontmatter_set`）
 * 4. **この書き込みで状態が動いた premise の、節の目次が1文書あたりの予算
 *    （`MEMORY_PROMPT_OUTLINE_BUDGET`）に対してどの領域に居るか**（#772
 *    「記憶の肥大」の続き）。⚠️ **対象は `input.slug` ではない**——
 *    `before.outlineSaturatedPremise` と `after.outlineSaturatedPremise` を
 *    premise の slug で突き合わせ、状態が変わった premise をそれ自身の
 *    slug で名乗る（`outlineSaturationNote` の doc に理由がある）。
 *
 * ## ⚠️ 3 と 4 は別の蓋である。混ぜない
 *
 * **`demotedNote`（3の隣で先に足された、束ねた蓋 `MEMORY_PREMISE_CARD_BUDGET`
 * の断り）と、この4つ目（1文書あたりの目次の予算 `MEMORY_PROMPT_OUTLINE_BUDGET`）
 * は別の蓋である。** 前者はカードそのものが1行に潰れる蓋、後者はカードの中の
 * 節の目次だけが切れる蓋——**どちらか片方だけが噛むことも、両方が同時に噛む
 * こともある。** 両方が噛んだ回は `floorLine` に両方の断りが並ぶ。どちらの
 * 蓋の断りかは文言そのもの（「束ねた予算」対「1文書あたりの予算」）で見分けが
 * つくようにしてある。
 *
 * ⚠️ **この4つ目の行は床には乗らない。** `describeMemoryFloor` は書く4口が
 * 応答の末尾に足す1行であって、システムプロンプトへの焼き込みではない
 * （`renderPremiseOutlineOmission` が断り書きに足す1文――変更4――とは違い、
 * こちらは毎ターン繰り返し焼かれるわけではなく、この応答1回にしか乗らない）。
 *
 * ⛔ 既存の語「区分が変わった」（`memory_frontmatter_set` の `kindChangeNote`）を
 * 使い回さない。`tools.test.ts` に
 * `expect(reply).not.toContain('区分が変わった')`（type を変えなかったときの歯）
 * が固定であり、同じ語をここでも使うと、type を変えていない呼び出しでもこの
 * 関数が毎回その文字列を返すことになって歯を撃つ。
 *
 * ## ⚠️ 「毎回出る行」の限界（doc に書く条件で採用された）
 *
 * `created` が `false`（既存文書への追記・上書き・frontmatter 変更・節の
 * 移動）のときも、この行は出る。**この行は毎回出るので読み飛ばされる。それでも
 * 置くのは、参照値がその場に在ることに価値が在るから。これは行動を変える
 * 機構ではない。** 行動を変えるのは、稀にしか出ない側（新規作成・区分の変更・
 * 線を越えたとき）である。**「効かない場面」をここに書かずに入れると、次に
 * 読む人は「対策済み」と読む——だから書く。**
 *
 * **⚠️ 上の2要素（最大の premise・3手順）を `fact` の新規作成や `created === false`
 * の枝へは足さないこと。** あの枝を強くしている理由は「premise の新規作成は
 * 稀だから習慣化しない」であり、全部の枝に足すと稀ではなくなる——毎回出る側は
 * 「効かない機構」のままにしておく（直上の限界のとおり）。
 *
 * ## `outlineSaturationNote`（4つ目）— なぜ `input.slug` では引かないか
 *
 * ⚠️ **`input.slug` はこの note の対象を選ぶのに使わない。** `slug` は
 * 「書いた文書」を指すが、`memory_section_move` は**移し先**（`toSlug`）の
 * 視点でこれを渡す（`tools.ts` の「床は『移した先』の視点で言う」）。
 * ⟹ 節の移動元（予算に張り付いていた当の文書であることが多い——それこそ
 * この計器が存在する理由の場面）は、`slug` として一度も渡ってこない。
 * `input.slug` で `outlineSaturatedPremise` を引くと、**張り付いた文書から
 * 節を移したのに床が動かない**という、この4つ目の note がいちばん言うべき
 * 場面で黙る。
 *
 * **だから `before.outlineSaturatedPremise` と `after.outlineSaturatedPremise`
 * を premise の slug で突き合わせ、状態が変わった premise を**それ自身の
 * slug で**名乗る。** 1回の書き込みで複数の premise の状態が動きうる
 * （`memory_section_move` は移動元・移動先の2文書を書く）ので、対象は
 * 1件とは限らない——slug ごとに次の表で分け、該当した分だけ**すべて**
 * 出す（`renderListing` の予算は掛けない。次の節に理由がある）。
 *
 * | before | after | 出すもの |
 * | --- | --- | --- |
 * | 張り付き | 張り付き・**数値が変わった** | **A: 「揺れ」の断り**——この増減は張り付いた領域の中の揺れ |
 * | 張り付き | 張り付き・**数値が1つも変わっていない** | ⭐ **出さない**（この書き込みとは無関係） |
 * | 収まっている（or 無い） | 張り付き | **B: 「この書き込みで予算を越えた」**——増分は本物 |
 * | 張り付き | 収まっている（or 無い） | **C: 「目次で切られなくなった」**——落ちている節がもう無い |
 * | 収まっている | 収まっている | ⭐ **出さない** |
 *
 * **なぜ両方が要るか。** `describeMemoryFloor` は純粋関数で、受け取るのは
 * `before` / `after` の `MemoryFloor` だけである——文書の本文を持っていない
 * ので、飽和状態をここで計算し直せない。そして語るのは `before → after` の
 * **差**なので、片端だけでは B と C を A と区別できない（`before` だけを
 * 見ると、いま張り付いているかどうかしか分からず、それが「元から張り付いて
 * いた（A）」のか「今回張り付いた（B）」のか言えない）。
 *
 * **A のうち「数値が変わっていない」回は出さない。** 無関係な文書へ書いた
 * ターンでも、他の張り付いた premise が毎回名乗られると、本当に動いた
 * ときの目印が効かなくなる（`demotedNote` / 変更4と同じ「噛んでいない回は
 * 1文字も出さない」の倒し方）。**A のうち数値が変わった回では「これは
 * 揺れだ」と言い、B では言わない**——B の増分は**本物である**（省略の
 * 断り書きがまるごと生える。実測で 1,136 文字。見出し40字・要旨2,900字の
 * 合成、#772）。ここで「揺れ」と言うと、本物の増分を雑音として捨てさせる
 * ことになる。**C は逆に、いちばん名乗るべき回である**——省略の断り書きが
 * まるごと落ちた瞬間だからである。
 *
 * ## ⚠️ C は「この先どう動くか」を言わない（言えないから）
 *
 * **「収まっている」と「（前後どちらかに）存在しない」は、同じ側へ倒して
 * ある。** 節を移して予算に収まった回だけでなく、`premise` から
 * `indexed` / `fact` へ区分を変えた回・文書を消した回でも、その slug は
 * `after.outlineSaturatedPremise` に現れない。**この関数は4つを区別できない**
 * ——`MemoryFloor` は区分の内訳を slug ごとには持っていないからである。
 *
 * ⛔ **だから C は「ここから先は、節を移した分だけ床が下がる」と言わない。**
 * かつてそう書いていたが、**それは `indexed` / `fact` へ移った回には偽である**
 * ——どちらも節の目次を1行も焼かないので、節を移しても床は1文字も動かない。
 * **そして `premise` から `indexed` への付け替えは、実運用で最も多く起きた
 * 操作である**（本番の記憶は 2026-09-12 時点で6文書中5文書が `indexed`）。
 * ⟹ **いちばん起きる遷移で、いちばん強く嘘をつく形だった。**
 *
 * **言えるのは「目次から落ちている節はもう無い」までである。** その先は
 * この行では区別できないので、**区別していないことを行そのものに書く**
 * （`renderPremiseOutlineOmission` の「実行できない助言を出さない」と同じ
 * 倒し方——出せない値を出さず、出せないことを名乗る）。
 *
 * ⚠️ **C では「全 T 節」（after の節の総数）を出さない。** `after` は
 * 定義上もう飽和していないので `after.outlineSaturatedPremise` には
 * 現れず、この関数は `before` / `after` の `MemoryFloor` 以外の情報を
 * 持たない——T を出すには `measurePremiseOutlineFit` が `rest === 0` でも
 * 値を返すよう変え、かつ `outlineSaturatedPremise` の絞り込み（飽和して
 * いる文書だけを載せる、という `MemoryFloor` 側の約束）をやめる必要が
 * あり、そちらを崩すと `MemoryFloor.outlineSaturatedPremise` の doc
 * 「切れていない文書はここに現れない」が嘘になる。**達成できない値を
 * 出すよりは、その値を文面から落とす**（`renderPremiseOutlineOmission`
 * の「実行できない助言を出さない」と同じ倒し方）。
 *
 * ## 件数に予算を掛けない理由と、その上界
 *
 * **1回の書き込みで状態が変わりうる premise は、通常は最大2件である**
 * （4口のうち `memory_section_move` だけが2文書を書き、残り3口は1文書
 * しか書かない）。**⚠️ ただし「必ず2件以下」とは言い切らない**——人間が
 * `PUT /memory/:slug` で横から書き換える窓が理屈のうえでは在る
 * （`describeMemoryFloor` の「2. 焼き込み全体の文字数が…」に既にある
 * 同種の断りと同じ形）。件数がその窓のせいで想定より増えても、`renderListing`
 * のような一覧の予算はここでは掛けない——最大でも数件であることが期待
 * される軸に予算を掛けると、いちばん言うべき回（張り付いた文書の名前）が
 * 予算で落ちる恐れのほうが実害として大きい。
 *
 * ⚠️ 並び順は premise の **slug 昇順**で固定する。`before` / `after` の
 * 配列に載っている順（挿入順・呼び手の順）に依存させると、同じ入力でも
 * 呼び手が違うだけで出力の並びが動き、歯が不安定になる。
 */
export function describeMemoryFloor(input: {
  before: MemoryFloor;
  after: MemoryFloor;
  slug: string;
  kind: MemoryDocKind;
  created: boolean;
}): string {
  const { before, after, slug, kind, created } = input;
  const transition = formatMemoryFloorTransition(before.totalChars, after.totalChars);
  // **蓋が噛んでいるあいだ、床の増減だけを読むと嘘になる**（`MemoryFloor.demotedPremiseDocs`
  // の doc）。premise を足しても別のカードが落ちて釣り合うので、増減はほとんど動かない。
  // ⟹ 噛んでいる回はそれを同じ行で名乗る。**噛んでいない回は1文字も出さない**
  // （毎回付けると、本当に噛んだときの目印が効かなくなる——`memory_read` と同じ倒し方）。
  const demotedNote =
    after.demotedPremiseDocs === 0
      ? ''
      : `⚠️ premise のカードは束ねた予算 ${formatMemoryCharCount(MEMORY_PREMISE_CARD_BUDGET)} 文字に当たっていて、` +
        `${formatMemoryCharCount(after.demotedPremiseDocs)} 件が1行に落ちている。` +
        '⟹ **この増減は蓋が効いた後の値である**（premise を足しても、別のカードが落ちて釣り合う）。' +
        '落ちた文書の名前と直し方は焼き込みの断り書きに在る。';

  // **1文書あたりの目次の予算——`demotedNote`（束ねた蓋）とは別の蓋である。**
  // ⚠️ **`input.slug` では引かない。** `memory_section_move` は移し先
  // （`toSlug`）の視点で `slug` を渡す（`tools.ts` の「床は『移した先』の
  // 視点で言う」）ので、`slug` で引くと**移動元**（張り付いている当の文書で
  // あることが多い）を一度も名乗れない。⟹ `before` / `after` の
  // `outlineSaturatedPremise` を**両方とも slug で突き合わせ**、状態が
  // 変わった premise を**それ自身の slug で**名乗る（`describeMemoryFloor`
  // の doc「なぜ `input.slug` を使わないか」）。
  const beforeOutlineFits = new Map(before.outlineSaturatedPremise.map((fit) => [fit.slug, fit]));
  const afterOutlineFits = new Map(after.outlineSaturatedPremise.map((fit) => [fit.slug, fit]));
  const outlineTouchedSlugs = [
    ...new Set([...beforeOutlineFits.keys(), ...afterOutlineFits.keys()]),
  ].sort((a, b) => a.localeCompare(b));
  const outlineSaturationNotes: string[] = [];
  for (const outlineSlug of outlineTouchedSlugs) {
    const beforeFit = beforeOutlineFits.get(outlineSlug);
    const afterFit = afterOutlineFits.get(outlineSlug);
    if (afterFit !== undefined) {
      if (beforeFit !== undefined) {
        // A: 前も今回も張り付いている。数が1つも変わっていなければ、この
        // 書き込みとは無関係なので**名乗らない**（無関係な文書へ書いた
        // ターンで、他の張り付いた文書の名前が毎回出るのを防ぐ）。
        if (
          beforeFit.total === afterFit.total &&
          beforeFit.shown === afterFit.shown &&
          beforeFit.rest === afterFit.rest
        ) {
          continue;
        }
        outlineSaturationNotes.push(
          `⚠️ ${outlineSlug} の節の目次は1文書あたりの予算 ${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字に張り付いている（全 ${formatMemoryCharCount(afterFit.total)} 節のうち ${formatMemoryCharCount(afterFit.shown)} 節だけが焼き込みに載っている）。⟹ **この増減は張り付いた領域の中の揺れであって、節を移した効果ではない**——落ちている ${formatMemoryCharCount(afterFit.rest)} 節を移し切るまで、床は移した本文の量と関係なく動く。移し切ると省略の断り書きごと消えて、そこで初めてまとめて落ちる。`,
        );
      } else {
        // B: 収まっていた（または存在しなかった）のが、この書き込みで
        // 張り付いた——増分は本物。
        outlineSaturationNotes.push(
          `⚠️ この書き込みで ${outlineSlug} の節の目次が1文書あたりの予算 ${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字を越えた（全 ${formatMemoryCharCount(afterFit.total)} 節のうち ${formatMemoryCharCount(afterFit.shown)} 節しか焼き込みに載らなくなり、${formatMemoryCharCount(afterFit.rest)} 節が落ちた）。⟹ **この増分は揺れではなく本物である**——省略の断り書きがまるごと生えたぶんを含む。ここから先は、節を移しても ${formatMemoryCharCount(afterFit.rest)} 節を移し切るまで床はほとんど動かない。`,
        );
      }
    } else if (beforeFit !== undefined) {
      // C: 張り付いていた（そして今回はもう飽和リストに無い＝収まった、
      // または区分が変わった・消えた等で飽和リストから外れた）。⛔ この先どう
      // 動くかは言わない（`describeMemoryFloor` の doc「C は『この先どう動くか』を
      // 言わない」——`indexed` / `fact` へ移った回には偽になるため）。
      outlineSaturationNotes.push(
        `⭐ この書き込みで ${outlineSlug} の節の目次は、1文書あたりの予算 ${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字で切られなくなった。⟹ **省略の断り書きごと床から落ちた**——目次から落ちている節は、もう無い。⚠️ この先どう動くかはこの行では言えない（予算に収まったのか、premise ではなくなった（indexed / fact）のか、消えたのかを区別していない——後の2つでは節の目次そのものが焼かれないので、節を移しても床は動かない）。`,
      );
    }
    // 両方とも undefined（前も今回も収まっている）はここへ来ない
    // （`outlineTouchedSlugs` が before/after どちらかの飽和リストに
    // 載っている slug だけを列挙するため）。
  }
  const outlineSaturationNote = outlineSaturationNotes.join('');
  const floorLine =
    `毎ターンの床（焼き込み全体。いま読み直した値）: ${transition}。` +
    demotedNote +
    outlineSaturationNote;

  if (created && kind === 'premise') {
    const lines = [
      `⭐ 新規作成: ${slug}（区分: premise）。`,
      floorLine,
      '⚠️ premise は毎ターン「要旨＋節の目次」がクローンの文脈へ焼かれる（本文は載らない）。' +
        '節の本文は memory_section_read で開く。要旨と見出しは短く保つこと。',
    ];
    const largest = after.largestPremise;
    if (largest !== null) {
      lines.push(
        `いま最も大きい premise: ${largest.slug}（${formatMemoryCharCount(largest.chars)} 文字）。`,
      );
    }
    lines.push(
      '縮めるのに全文置換は要らない: memory_outline で節を確かめ、' +
        'memory_section_move で付録の文書へ移し、memory_frontmatter_set でその付録を fact にする。',
    );
    return lines.join('\n');
  }

  const actionLabel = created ? '新規作成' : '更新';
  return `${actionLabel}: ${slug}（区分: ${kind}）。\n${floorLine}`;
}

/**
 * `memory_write` / `memory_append` / `memory_frontmatter_set` /
 * `memory_section_move` の応答に添える、「**この書き込みによって、次の
 * ターンの会話へ載る見込みの文字数**」の一言（P2、#318 の続き）。
 *
 * ## `describeMemoryFloor`（毎ターンの床）とは別の量である——置き換えない
 *
 * `describeMemoryFloor` が答えるのは「記憶全体が**毎ターン**焼き込まれ
 * **続ける**総量」（before/after は書き込み前後の記憶全体のスナップショット）。
 * こちらが答えるのは、`clone.ts` の `#withFreshMemory` がこの書き込みの
 * 結果として**次の1ターンだけ**会話へ差分として載せ直す量
 * （`renderMemoryDocuments(changed)`）——載った塊はその後会話の履歴として
 * 残り続けるので、毎ターンの床（前者）とは別の現象である。**2つの数を
 * 混ぜないよう、呼び手はこの関数の戻り値を `describeMemoryFloor` の行に
 * 続けて足すだけにし、どちらの行かは文言そのもので区別できるようにする**
 * （`floorLine` は「毎ターンの床」、こちらは「次のターンの会話へ載る見込み」
 * と名乗る）。
 *
 * ## 計算は `renderMemoryDocuments` そのもの——数え方を2本に割らない
 *
 * `渡された文書（群）をそのまま同じ純粋関数（`renderMemoryDocuments`）に
 * 通した文字数を返す。**区分で結果が変わることが要点である**——`premise`
 * なら全文、`fact` なら目次1行ぶんしか返らない。`measureMemoryFloor` が
 * 「後の床から逆算しない」のと同じ理由で、ここも `renderMemoryDocuments`
 * を再実装しない。
 *
 * ## 引数は「1回のツール呼び出しで変わった文書すべて」＋「書き込み後の記憶の全体」
 *
 * `memory_write` / `memory_append` / `memory_frontmatter_set` は1文書しか
 * 変えないので `[written]` の1要素配列を渡す。**`memory_section_move` だけ
 * 移動元・移動先の両方を「変わった文書」にする**——`#withFreshMemory` は
 * 次のターンにこの2つを**まとめて**載せ直すので、呼び手は両方を1回で
 * この関数へ渡すこと（`[toWritten, fromWritten]`）。
 *
 * **⚠️ ここが「合計」を選んだ理由。** 2文書ぶんを別々に
 * `renderMemoryDocuments([a])` / `renderMemoryDocuments([b])` で測って
 * 単純に足すと、`joinMemorySections` が挟む区切り文字（premise 同士なら
 * `\n\n`）のぶんだけ実物より少なく出る——**2本の render を足したもの**と
 * **2文書をまとめて1回 render したもの**は同じ値にならない。だから
 * ここは2文書をまとめて1回だけ `renderMemoryDocuments` に通し、**単一の
 * 合計**として返す（内訳は文書ごとの区分を並べて示す）。
 *
 * **`memoryAfter`（第2引数）は `renderMemoryDocuments(parts, { presentInMemory:
 * memoryAfter })` へそのまま渡す。** 呼び手4箇所（`tools.ts`）は書き込み
 * **後**に `stores.persona.documents()` を読み直した値をもう手元に持っている
 * （`memoryFloorNote` / `memorySessionGrowthNote` に渡しているのと同じ変数
 * `memoryAfter`）——**ここで改めてストアを読み直さない**（依頼者の門3
 * 「クローンの呼び出し回数に比例する費用を足さない」）。
 *
 * ## 第3引数（`seenContent`）— 「クローンが既に見ている版」
 *
 * `#withFreshMemory` は**変わった範囲だけ**を載せるので、見込みも同じ計算に
 * 揃える必要がある（`renderMemoryDocuments` の `options.seenContent`）。
 * 呼び手4箇所は**この書き込みの直前の内容**をもう手元に持っている
 * （`describeMemoryWriteDiff` へ渡している `before` と同じ値）ので、それを
 * そのまま渡す。
 *
 * **⚠️ 「直前の内容」と「クローンが実際に見ている版」は、いつも同じではない。**
 * クローンが見ているのは**前回の載せ直しの時点の内容**であり、同じターンの
 * 中で同じ文書を2回書き換えれば、2回目の呼び出しが渡す `before` は1回目の
 * 結果＝クローンがまだ見ていない版になる。そのとき実物（次のターンに載る量）
 * のほうが**多い**。これは下の「他に何も変わらなければ」という既存の条件の
 * 一形態であって、新しく生まれた限界ではない——**ただし向きは覚えておくこと。
 * ずれるときは必ず「見込みのほうが小さい」側へずれる。**
 *
 * **`undefined` を許さず、空の `Map` を渡させる形にしていない**のは
 * `memoryAfter` と同じ理由である（省略できる形にすると、渡し忘れが黙って
 * 「全文」寄りの大きい数へ倒れる。そちらは安全側だが、**実物と食い違った
 * まま気づけない**——見込みは実物と一致することにしか価値が無い）。
 *
 * ## ⚠️ これは予測であって実測ではない（依頼者の明示条件）
 *
 * 1. **「他に何も変わらなければ」という条件付きである。** ここで返す数は
 *    「このツール呼び出しで変わった文書（群）だけが変わった」という前提で
 *    計算している。**同じターンの中でこれ以外の文書も変われば、次の
 *    ターンにはそれも合わせて載る**——書き込みごとに出るこの数を機械的に
 *    合算して「次のターンに載る総量」を求めないこと（同じ文書を同じ
 *    ターンで複数回書き換えた場合は特に、後の呼び出しが返す数はその文書の
 *    最終状態の全部を含むので、前の呼び出しぶんまで足すと二重に数える）。
 * 2. **`memory_section_move` は移動元と移動先の両方を「変わった文書」に
 *    する。** 直上のとおり、ここでは両方をまとめた**合計**を1つの数で返す
 *    （別々に出す選択肢もあったが採らなかった——理由は直上）。
 * 3. **`memoryAfter` は「この呼び出しの時点でのスナップショット」である。**
 *    `read()` から `write()` までの間に人間が `PUT /memory/:slug` で別の
 *    文書を書き換える窓が理屈のうえでは在る（`describeMemoryFloor` の同種の
 *    注意と同じ）。次のターンが始まるまでにさらに記憶が動けば、そのぶんは
 *    この数に入らない——これは1の「他に何も変わらなければ」の条件そのもの
 *    であって、`memoryAfter` を渡したことで新しく生まれた限界ではない。
 *
 * ### ⭐ 直っていたもの: `presentInMemory` を渡していなかった欠落（#618 の続き）
 *
 * **これは以前ここに書かれていた「範囲外」の1つだった。** 第2引数
 * （`memoryAfter`）が無かった頃、この関数は「今回書いた文書」しか持たず、
 * 記憶の全体を知らなかった。書いた文書が **fact で、その `parent` が今回の
 * 書き込みに含まれない**ときだけ、実際に載る印（「在るが、ここに載せた分には
 * 含まれない」146+32=178文字級）より短い印（「見つからない」146文字級）で
 * 数えることになり、**数十文字（実測32文字）少なく出ていた**。`memoryAfter`
 * を必須の第2引数にし、`renderMemoryDocuments` へ `presentInMemory` として
 * そのまま渡すことで、書く側（この関数）と読む側（`clone.ts` の
 * `#withFreshMemory`）が同じ「記憶の全体」を見て同じ印を選ぶようになった
 * ——この一致は `clone-memory-injection.test.ts` の通しの歯（道具の応答から
 * 見込み文字数を取り出し、次のターンに実際に載る塊の文字数と突き合わせる）
 * で固定してある。
 *
 * ## ⚠️ 引数を必須にしてある理由（第2引数も含む）
 *
 * **`memoryAfter` は optional にしていない。** `renderMemoryDocuments` 自身の
 * `options.presentInMemory` が optional なのとは事情が違う——あちらは「記憶の
 * 全体を渡す呼び手（システムプロンプトへの焼き込み・`memory_list`）が正当に
 * 省略する」ための optional だが、こちらの4呼び手はどれも書き込み**後**に
 * `stores.persona.documents()` を読み直した値をすでに手元に持っており、
 * 省略する正当な理由が無い。**省略できる形にすると、渡し忘れが黙って
 * 「見つからない」寄りの短い数へ倒れる**（この関数がいままさに踏んでいた
 * 欠落そのもの）。必須にして `tsc` に強制させることで、渡し忘れを実行時では
 * なくビルド時に落とす（依頼者の門4「黙って効かなくなる形を作らない」）。
 *
 * **空配列を渡されても `throw` しない。** 呼び手が書き込みの成功
 * **後**にここを呼ぶ以上、`memoryAfter` が空になるのは「ストアが記憶を
 * 1件も返さなかった」という異常時だけで、直下の `parts` の非空タプルほど
 * 型で防げる性質のものではない。**空を渡すと `presentInMemory` を渡さな
 * かったのと同じ挙動になるだけ**（`renderMemoryDocuments` の既定）で、
 * 直下の `throw`（`parts` が空のとき）とは扱いが違う——`parts`
 * の空は呼び手の実装誤りだが `memoryAfter` の空はストアの状態そのものであり、
 * ここで投げると「記憶は書けているのに応答がエラーになる」形になって
 * 二重書きを誘発する（直下の「なぜ空を渡しても投げっぱなしにしてよいのか」と
 * 同じ理由）。**いまの4呼び手が実際に空を渡すことは起こりえない**
 * （`stores.persona.documents()` は書き込み直後の呼び出しなので、書いた
 * 文書自身が最低1件返る）。
 *
 * ## ⚠️ `parts` を非空タプルにしてある理由（P3 の同乗、#318）
 *
 * 呼び手4箇所（`tools.ts` の `memory_write` / `memory_append` /
 * `memory_frontmatter_set` / `memory_section_move`）は**全部、書き込みが
 * 成功した後にこれを呼ぶ。** だから空配列を渡す呼び手は構造的に存在しない
 * ——それを型で表すため、引数を `readonly [MemoryPart, ...MemoryPart[]]`
 * （非空タプル）にしてある。**直下の `throw` は残す**——型を迂回した
 * 呼び手（`as unknown as` 等）への最後の砦であって、正しく型を通る4箇所が
 * ここへ来ることは無い。
 *
 * **なぜ空を渡しても投げっぱなしにしてよいのか。** 呼び手が書き込みの
 * 成功**後**にここを呼ぶので、ここで投げると「記憶は書けているのに応答が
 * エラーになる」形になる。クローンはそれを「書けなかった」と読んで
 * 二重に書きうる（`memory_append` なら本文が二重になる）。**⟹ 空を渡し
 * うる呼び手を新しく足すなら、投げる前に握り潰す側へ倒すかを再検討する
 * こと。** いまの4呼び手は配列リテラル（`[written]` / `[toWritten, fromWritten]`）
 * なので、この型変更で1文字も直す必要が無い——空を作りようがない形で
 * 呼んでいる。
 */
export function describeMemoryReinjectionEstimate(
  parts: readonly [MemoryPart, ...MemoryPart[]],
  memoryAfter: readonly MemoryPart[],
  seenContent: ReadonlyMap<string, string>,
): string {
  if (parts.length === 0) {
    throw new Error('describeMemoryReinjectionEstimate: parts が空（呼び手の実装誤り）');
  }

  const chars = renderMemoryDocuments(parts, {
    presentInMemory: memoryAfter,
    seenContent,
  }).length;
  const kindOf = (part: MemoryPart): MemoryDocKind =>
    resolveMemoryDocKind(parseMemoryFrontmatter(part.content));
  // **「全文」か「変わった範囲だけ」かは、実際に描いてみて決まる**
  // （`renderPremiseDelta` は差分にする価値が無ければ全文へ倒れる）。
  // ラベルを別の判定で作らない——判定を2本に割ると、片方だけ直したときに
  // 内訳が黙って嘘をつく（`measureMemoryFloor` と同じ形の前科）。
  const labelOf = (part: MemoryPart): string => {
    const kind = kindOf(part);
    if (kind === 'fact') return 'fact・目次1行';
    const seen = seenContent.get(part.slug);
    return seen !== undefined &&
      renderPremiseDelta(
        part.slug,
        renderPremiseCard({ slug: part.slug, content: seen }),
        renderPremiseCard(part),
        scanMemorySections(part.content).sections,
      ) !== null
      ? 'premise・カードの変わった範囲だけ'
      : 'premise・カード（要旨＋節の目次）';
  };
  const breakdown = parts.map((part) => `${part.slug}（${labelOf(part)}）`).join(' + ');

  const subjectLabel =
    parts.length === 1
      ? 'この書き込み'
      : `この移動（${parts.map((part) => part.slug).join(' と ')} の合計）`;

  const lines = [
    `${subjectLabel}が次のターンの会話へ載る見込み: ${formatMemoryCharCount(chars)} 文字（${breakdown}）。`,
    '⚠️ これは予測であって実測ではない。「他に何も変わらなければ」という前提が付く' +
      '——同じターンで他の文書も変われば、次のターンにはそれも合わせて載るので、' +
      '書き込みごとに出るこの数を単純に合算しないこと。',
  ];
  if (parts.length > 1) {
    lines.push(
      'memory_section_move は移動元と移動先の両方を「変わった文書」にするため、' +
        'この数は両方の合計である（別々の値を足したものではなく、renderMemoryDocuments へ' +
        '両方まとめて渡した結果——区切り文字のぶんの誤差が乗らない）。',
    );
  }
  return lines.join('\n');
}

/** `formatMemoryCharDelta` の百分率版。1桁で丸める。 */
function formatMemoryPercentDelta(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  if (rounded === 0) return '0%'; // `-0` を含む（`Object.is(-0, 0)` は false だが `-0 === 0` は true）。
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

/**
 * `memory_write` / `memory_append` / `memory_frontmatter_set` /
 * `memory_section_move` の応答に足す、「セッション構築時点からの増分」の
 * 一言（P3、#318 の続き）。
 *
 * ## なぜ「セッション構築時点」を基準にするのか（依頼者の逐語）
 *
 * 「私が実際に毎ターン払っているのは組み立て時点の値である（畳んでも
 * 追記しても、いま走っているセッションが払う額は変わらない）。⟹ そこ
 * からの差は『次にセッションが組み立て直されたら、いくらになるか』を
 * 意味する。⟹『前回の書き込みから』だと、その意味を持たない。」
 *
 * だから比較の相手は「1つ前の書き込み」でも「セッション開始の壁時計」でも
 * なく、`CloneRuntimeFacts.injectedMemoryChars`
 * （このセッションのシステムプロンプトへ実際に焼き込まれた文字数。
 * セッションの間は固定 — `clone.ts` の `#promptMemoryChars` の doc）。
 *
 * ## `injectedMemoryChars` が引けないとき（依頼者が事後に承認した代替）
 *
 * `ToolContext.runtime` はテストのためだけに省略できる口で、本番の配線
 * （`clone.ts` の `#toolContext` / `#distillFromTranscript`）は本セッションと
 * 蒸留のサイドクエリの両方へ必ず渡す——両方とも `#runtimeFacts()` を経由し、
 * `injectedMemoryChars` は `#buildOptions` がセッションを開く時点で確定
 * するので、この4口のどのハンドラが呼ばれる時点でも既に値が入っている
 * （`self_status` が同じ値を「システムプロンプトへ焼き込んだ記憶の文字数」
 * として出しているのと同じ経路）。
 *
 * **それでも呼び手が `runtime` を渡さない場合に備え、黙って0や現在値へ
 * 倒さない。** `injectedMemoryChars` が `null` のときは「いま読み直した
 * 総量」を出すが、**それがセッション構築時点との差ではないことを文言に
 * 明記する**——依頼者の条件そのもの（「黙って別の数に差し替えない
 * でほしい。どちらの数かで、意味が変わる」）。
 *
 * ## 閾値を置かない（依頼者の明示条件）
 *
 * ここは「増えた／減った／変わらない」という事実だけを言う。「畳め」
 * 「危ない」に相当する語は使わない——判断はクローンが下す
 * （`docs/north_star.md` が要求する形）。
 *
 * ## ⚠️ 増分が 0 のときに「増えた」と読める文言を出さない
 *
 * `formatMemoryCharDelta` は 0 に `+` を付けるが、それをそのまま「増える」
 * という動詞に埋め込むと、変化が無いのに増加の文として読めてしまう。
 * ここでは delta === 0 のときだけ別の文（動詞を含まない）を返す
 * （歯: `tools.test.ts` の「増分が0のとき、増えたかのような文言を出さない」）。
 *
 * ## この機能が効くかどうかは未検証である（依頼者の明示指定）
 *
 * クローンは一度、同じ「毎ターンの床」の数を見ながら止まらなかった
 * （37,515 → 51,751 文字、+38%）。**⟹ 数を増やして見せることが、行動を
 * 変えるとは限らない。** この関数と `describeMemoryPremiseRanking` を
 * 足しても、それだけで記憶の肥大が止まる保証は無い——測っていない。
 */
export function describeMemorySessionDelta(input: {
  /** いま `stores.persona.documents()` を読み直した後の、焼き込み全体の文字数。 */
  afterChars: number;
  /**
   * `CloneRuntimeFacts.injectedMemoryChars`。引けないときは `null`
   * （直上の「引けないとき」を読むこと）。
   */
  injectedMemoryChars: number | null;
}): string {
  const { afterChars, injectedMemoryChars } = input;

  if (injectedMemoryChars === null) {
    return (
      `いまの記憶の総量（現在値）: ${formatMemoryCharCount(afterChars)} 文字。` +
      ' ⚠️ これはセッション構築時点との差ではなく現在値である' +
      '——セッション構築時点の値（`self_status` が「システムプロンプトへ焼き込んだ' +
      '記憶の文字数」として出す数）がこの呼び出しからは引けなかったため、' +
      '代わりに現在値だけを出している。'
    );
  }

  const label = '次に組み立て直されたら焼かれる量（セッション構築時点との差）';
  const delta = afterChars - injectedMemoryChars;

  if (delta === 0) {
    return (
      `${label}: セッション構築時点（${formatMemoryCharCount(injectedMemoryChars)} 文字）から` +
      '変わっていない。'
    );
  }

  const direction = delta > 0 ? '増える' : '減る';
  const percentNote =
    injectedMemoryChars === 0
      ? '（セッション構築時点が0文字だったため割合は出せない）'
      : `（${formatMemoryPercentDelta((delta / injectedMemoryChars) * 100)}）`;

  return (
    `${label}: セッション構築時点 ${formatMemoryCharCount(injectedMemoryChars)} 文字 → ` +
    `いま ${formatMemoryCharCount(afterChars)} 文字（${formatMemoryCharDelta(delta)} 文字` +
    `${percentNote}、${direction}見込み）。`
  );
}

/** `describeMemoryPremiseRanking` の一覧予算（文字数）。件数では切らない（AGENTS.md の地雷表）。 */
export const MEMORY_PREMISE_RANKING_BUDGET = 2_000;

/**
 * `memory_write` / `memory_append` / `memory_frontmatter_set` /
 * `memory_section_move` の応答に足す、「premise の大きさの順位」の一言
 * （P3、#318 の続き）。
 *
 * ## なぜ要るか
 *
 * `describeMemoryFloor` が名指しするのは「いま最も大きい premise」1件だけで、
 * しかも premise を新規作成した枝でしか出ない。それ以外の呼び出しでは
 * 「総量が動いた」しか見えず、**どの文書が大きいのか**が分からない——
 * 畳む判断に直接使える形にするには、全 premise の順位そのものが要る。
 *
 * ## サイズの数え方は `measureMemoryFloor` と揃える
 *
 * `content.length` ではなく `renderPremisePart` の結果の長さで数える——
 * malformed な frontmatter は説明の1行が前に付くので、`content` だけを
 * 足すと実物より少ない数を名乗ることになる（`measureMemoryFloor` の doc と
 * 同じ理由）。
 *
 * ## 一覧の上限は文字数で持つ（件数ではない）
 *
 * `renderListing`（`excerpt.ts`）を通し、切ったら省いた件数を必ず言う
 * （`.claude/skills/listing-and-detail/SKILL.md`。AGENTS.md の地雷表
 * 「一覧の上限を件数だけで決める」——300件 × 200字のような掛け算の見落としを
 * 避けるため、件数の上限は持たず文字数の予算だけで締める）。
 *
 * ## fact は対象にしない
 *
 * fact はプロンプトへ目次の1行しか載らない（`renderMemoryDocuments` が
 * 組む `tocSection`）ので、「どれが大きいか」の対象は premise だけである。
 *
 * ## 閾値を置かない・畳むことを勧めない
 *
 * 出すのは順位と文字数だけである。「これは大きすぎる」「畳め」に相当する
 * 語は使わない——`describeMemorySessionDelta` と同じ理由（判断はクローンが
 * 下す）。
 *
 * ## この機能が効くかどうかは未検証である
 *
 * `describeMemorySessionDelta` の doc の「未検証」節を見よ——同じ限界が
 * ここにも当てはまる。
 */
export function describeMemoryPremiseRanking(documents: readonly MemoryPart[]): string {
  const { premiseParts } = buildMemoryDocumentSections(documents);
  if (premiseParts.length === 0) {
    return 'premise の大きさの順位: いま premise はまだ無い。';
  }

  const ranked = premiseParts
    .map((part) => ({ slug: part.slug, chars: renderPremisePart(part).length }))
    // 大きい順。同数なら slug 昇順（出力を決定的にする——同数の並びが
    // 呼ぶたびに入れ替わると、変わっていないのに差分に見える）。
    .sort((a, b) => b.chars - a.chars || a.slug.localeCompare(b.slug));

  const items = ranked.map(
    (entry, index) => `${index + 1}. ${entry.slug}: ${formatMemoryCharCount(entry.chars)} 文字`,
  );

  const listing = renderListing(items, {
    budget: MEMORY_PREMISE_RANKING_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `…ほか ${rest} 件は省略（大きい順に ${shown} 件だけ出した。全 ${total} 件。` +
      '残りは memory_list で確認できる）。',
  });

  return `premise の大きさの順位（大きい順、全 ${ranked.length} 件）:\n${listing}`;
}

/** 「棚卸しの的」の一覧の文字数の予算。件数ではない（`excerpt.ts` の約束）。 */
export const MEMORY_TIDY_TARGETS_BUDGET = 3_000;

/**
 * **いま毎ターンの焼き込みに収まっていない文書を名指しする。**
 *
 * ## なぜ要るか — 印はカードの中にしか無かった
 *
 * `renderPremiseCard` は、要旨が `MEMORY_PROMPT_DESCRIPTION_BUDGET` を超えた
 * ときと、節の目次が `MEMORY_PROMPT_OUTLINE_BUDGET` に入りきらなかったときに
 * ⚠ の1行を出す。**しかしそれは「その文書のカードの中」にしか無い。**
 *
 * ⟹ クローンが「どの文書を割ればよいか」を知るには、焼き込みを自分で
 * 読み返して ⚠ を探すしかなかった。tick の digest にも、書き込みの応答にも、
 * `self_status` にも、`memory_list` にも、**予算に当たった文書を名指しする
 * 情報は1つも無い**（実測 2026-09-08。全走査して確かめた）。
 *
 * **集計も無かった** ——「いま何件が当たっているか」を答える口が存在しない。
 *
 * ## 出すのは的と数だけである。「畳め」は言わない
 *
 * 判断（どれをどう割るか）はクローンが下す（`describeMemoryPremiseRanking` の
 * doc と同じ線。**閾値を置かない**）。ここが返すのは「予算に当たっている」
 * という**測れた事実**と、その文書の名前と数だけである。
 *
 * **⚠️ 当たっていないことは「小さい」ではない。** 予算は1文書ごとに掛かるので、
 * 全部が予算の下でも合計は大きくなりうる——だから総量（`measureMemoryFloor`）と
 * この一覧は**別に出す**（呼び手が両方を並べる）。
 */
export function describeMemoryTidyTargets(documents: readonly MemoryPart[]): string {
  const { premiseParts } = buildMemoryDocumentSections(documents);

  const targets: string[] = [];
  for (const part of premiseParts) {
    const frontmatter = parseMemoryFrontmatter(part.content);
    const description =
      (frontmatter.kind === 'parsed' ? frontmatter.description : undefined)?.trim() ?? '';
    const { sections } = scanMemorySections(part.content);
    const outlineChars = memorySectionLines(sections).join('\n').length;

    const reasons: string[] = [];
    if (outlineChars > MEMORY_PROMPT_OUTLINE_BUDGET) {
      reasons.push(
        `節の目次が ${formatMemoryCharCount(outlineChars)} 文字（予算 ${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字。全 ${formatMemoryCharCount(sections.length)} 節のうち末尾が焼き込みに載っていない）`,
      );
    }
    if (description.length > MEMORY_PROMPT_DESCRIPTION_BUDGET) {
      reasons.push(
        `要旨が ${formatMemoryCharCount(description.length)} 文字（予算 ${formatMemoryCharCount(MEMORY_PROMPT_DESCRIPTION_BUDGET)} 文字）`,
      );
    }
    if (reasons.length === 0) continue;
    targets.push(`- ${part.slug}: ${reasons.join(' / ')}`);
  }

  if (targets.length === 0) {
    return (
      '棚卸しの的: 毎ターンの焼き込みに収まっていない文書は無い。' +
      '**これは「記憶が小さい」ではない** —— 予算は1文書ごとに掛かるので、' +
      '全部が予算の下でも合計は大きくなりうる（総量は別の行で出る）。'
    );
  }

  const listing = renderListing(targets, {
    budget: MEMORY_TIDY_TARGETS_BUDGET,
    omitted: ({ rest, shown, total }) =>
      `…ほか ${rest} 件は省略（全 ${total} 件のうち ${shown} 件だけ出した）。`,
  });

  return (
    `棚卸しの的（毎ターンの焼き込みに収まっていない文書。全 ${targets.length} 件）:\n${listing}\n` +
    '**ここに出た文書は、焼き込みで見えていない節が在る。** memory_outline' +
    '（side=tail で末尾も見られる）で節を確かめ、memory_section_move で付録の文書へ移すこと。'
  );
}

// ---------------------------------------------------------------------------
// 節（section）— memory_outline / memory_section_move（#318 案 (b)）
// ---------------------------------------------------------------------------

/**
 * 節1つ。**`start` / `end` は `content` そのものへの添字**（本文への相対では
 * ない）で、`start` は必ず `memoryBodyStart(content)` 以上である。
 *
 * `end` は排他——「同じ深さ以下の次の見出しの行頭」か、無ければ
 * `content.length`。だから**入れ子の子（`##` の下の `###`）は親の節に
 * 含まれる**し、切り取った文字列は必ず行の境界で始まり行の境界で終わる。
 */
export interface MemorySection {
  /** 節id（`memorySectionId` を読むこと）。 */
  id: string;
  /** 見出し行そのもの（改行を含まない生の1行）。 */
  heading: string;
  /** 見出しの深さ（`#` の数。1〜6）。 */
  depth: number;
  /** `content` の中での開始位置（見出し行の先頭）。 */
  start: number;
  /** `content` の中での終了位置（排他）。 */
  end: number;
  /** この節の文字数。**子込みである**（`end - start`）。 */
  chars: number;
}

/** `scanMemorySections` の戻り値。 */
export interface MemorySectionScan {
  /** 本文が始まる位置（`memoryBodyStart`）。frontmatter を添字で運ぶために要る。 */
  bodyStart: number;
  /** 見つかった節（文書に現れる順）。 */
  sections: MemorySection[];
}

/**
 * 節id。
 *
 * ```
 * 節id = <見出しの8桁> "-" <sha256(見出し行 + "\n" + その節の中身) の先頭8桁>
 * ```
 *
 * ## ⭐ この値の役割は2つある
 *
 * > **id は「指し先」であると同時に「版の照合」である。**
 *
 * **節の中身が変われば id が変わる。** ⟹ `memory_outline` で目次を読んでから
 * `memory_section_move` を呼ぶまでの間に、誰か（人間・統合の走行）がその節を
 * 書き換えていたら、**id が一致せず断られる。＝ 楽観的排他そのものである。**
 *
 * ### ⚠️ 不便さが機能である。「毎回変わるのは不便だから見出しベースへ」と直さないこと
 *
 * 見出しの文字列で指す形にすると、**書き換えを検出する材料が引数の中から
 * 消える**——同名の見出し（この repo の当事者の記憶には `### だから` が
 * 何度も出る。#366）で曖昧になるうえ、曖昧でないときですら「読んだときの
 * その節」と「いま動かそうとしているその節」が同じものだと言えなくなる。
 * **この id が毎回変わることは欠陥ではなく、この道具が持っている唯一の
 * 並行制御である。**
 *
 * ### そして他の節が変わっても id は変わらない
 *
 * ハッシュの材料はその節の見出し行と中身だけである。**文書全体のハッシュを
 * ETag にする形と違い、無関係な変更で誤検出しない**——人間が別の節に1行
 * 足しただけで移動が断られる、ということが起きない。歯（`tools.test.ts`）が
 * この2つを別々に固定している（当たり＝断る／誤検出しない＝通る）。
 *
 * ### ⚠️ 例外を1つ: 入れ子の子を動かすと、親の id は変わる
 *
 * `##` の中に `###` が在るとき、節の範囲は子を含む（上の
 * `MemorySection.end` の doc）。だから**子を移すと親の中身が実際に変わり、
 * 親の id も変わる。** これは正しい振る舞い（親の中身は本当に変わった）だが、
 * **呼び手は驚く**——目次を1回読んで2つの節を続けて移そうとすると、2つ目が
 * 「その id は古い」で断られる。目次を読み直すのが正しい手当てである。
 *
 * ## なぜ2つに分かれているのか（依頼の設計からの逸脱と、その理由）
 *
 * **後半8桁は設計そのもの**（`sha256(見出し行 + "\n" + 中身)` の先頭8桁）。
 * **前半8桁（`sha256(見出し行)` の先頭8桁）を足したのは、断りを2つに分けろ
 * という要求と、単一の不透明なハッシュが両立しないからである:**
 *
 * | 断り | 意味 | 判定 |
 * | --- | --- | --- |
 * | **そんな id は無い** | 打ち間違い／別の文書／見出しごと書き換えられた | 前半が1つも一致しない |
 * | **その id は古い** | 誰かが中身を書き換えた。読み直せ | 前半は一致するが後半が違う |
 *
 * 単一のハッシュだけを受け取ると、一致しなかったときに「見出しは一致するが
 * 中身のハッシュが違う」を**計算する材料が無い**（過去の中身を知らないと
 * 逆算できない）。前半を足しても、**中身まで完全に同一の節が2つ在れば
 * id は依然として衝突する**（曖昧さの明示という役目は失われていない）。
 */
export function memorySectionId(heading: string, body: string): string {
  const digest = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
  return `${digest(heading)}-${digest(`${heading}\n${body}`)}`;
}

/** 節の見出しとして数える ATX 見出しの行。 */
const SECTION_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * コードフェンスの開始／終了の行。行頭のインデントは3つまで許す（CommonMark）。
 */
const SECTION_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * `content` を節に切り分ける。**frontmatter は節ではない**（`memoryBodyStart`
 * より前は一度も見ない）。**最初の見出しより前の前書きも節ではない**——
 * 指す値が発行されないので、この道具では動かせない。
 *
 * ## ⚠️⚠️ 走査は2本である。`extractMemoryHeadings` と1本にまとめないこと
 *
 * この関数は**コードフェンスの中の `## X` を見出しとして数えない**。
 * `extractMemoryHeadings`（差分の要約が使う検出器）は**数える**。
 * **食い違っているのではなく、向きが逆だから2本在る:**
 *
 * | 使い道 | 拾いすぎるとどうなるか | 安全な倒れ先 |
 * | --- | --- | --- |
 * | **`extractMemoryHeadings`**（消えた見出しの検出器） | 誤検出が増える。呼び手が1つ余計に確かめて終わる。**見落とす側には倒れない** | **拾いすぎる側** |
 * | **この関数**（節の境界の決定器） | **フェンスが片方だけ残る。静かに壊れる** | **拾わない側** |
 *
 * 決定器が拾いすぎるとどうなるか、具体的に書く。フェンスの中の `## X` を
 * 「次の見出し」と読むと、その手前で節が終わる——**移した後、出どころの
 * 文書には開きの ``` だけが残り、そこから先が全部コードとして描かれる。**
 * しかも**文字数の増減は妥当な値のままなので、差分の要約は何も言わない。**
 *
 * **`extractMemoryHeadings` を「直し」に行かないこと。** そちらの doc には
 * PR #360 で「コードフェンスの中を除外する実装を足さないこと」が理由つきで
 * 書いてある（フェンスの開閉が非対称な本文＝まさに途中で切れた本文で内外を
 * 見誤り、**あの検出器がいちばん働くべき入力でいちばん壊れる**）。**この2本を
 * 1本にまとめる変更は、どちらの向きへ寄せても片方を壊す。** 意図として固定
 * するため、**同じ文書に対して片方は拾い片方は拾わないことを1つの `it()` で
 * 並べて assert する歯**が `tools.test.ts` に在る。
 *
 * フェンスの数え方: 行頭（インデント3つまで）の ` ``` ` または `~~~` を3つ
 * 以上。閉じるのは**同じ記号で、開いたときと同じ長さ以上で、後ろに情報文字列
 * が無い行**だけである。開いたまま文書が終わったら、そこまで全部フェンスの
 * 中とみなす（＝節の境界を作らない。**拾わない側へ倒す**）。
 */
export function scanMemorySections(content: string): MemorySectionScan {
  const bodyStart = memoryBodyStart(content);
  const body = content.slice(bodyStart);
  const lines = body.split('\n');

  // 行頭の絶対添字（`content` 基準）を先に作る。切り取りは添字で行うので、
  // 行の再結合（`join`）を通さない——通すと改行コードの扱いで1バイト動く。
  const lineStart: number[] = [];
  let offset = bodyStart;
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length + 1;
  }

  interface Open {
    depth: number;
    heading: string;
    start: number;
    bodyFrom: number;
  }
  const open: Open[] = [];
  const sections: MemorySection[] = [];
  let fence: { marker: string; length: number } | null = null;

  const close = (upTo: number, minDepth: number): void => {
    while (open.length > 0 && (open[open.length - 1] as Open).depth >= minDepth) {
      const entry = open.pop() as Open;
      const end = upTo;
      sections.push({
        id: memorySectionId(entry.heading, content.slice(Math.min(entry.bodyFrom, end), end)),
        heading: entry.heading,
        depth: entry.depth,
        start: entry.start,
        end,
        chars: end - entry.start,
      });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const fenceMatch = SECTION_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] as string;
      const info = fenceMatch[2] as string;
      if (fence === null) {
        // ` ``` ` の情報文字列にバックティックは置けない（CommonMark）。
        // 置かれていたらフェンスではない＝ただの本文の行として扱う。
        if (!(marker.startsWith('`') && info.includes('`'))) {
          fence = { marker: marker[0] as string, length: marker.length };
          continue;
        }
      } else if (
        marker.startsWith(fence.marker) &&
        marker.length >= fence.length &&
        info.trim().length === 0
      ) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;

    const headingMatch = SECTION_HEADING_PATTERN.exec(line);
    if (!headingMatch) continue;
    const depth = (headingMatch[1] as string).length;
    const start = lineStart[index] as number;
    // 「同じ深さ以下の次の見出しの直前」で閉じる。**「同じ深さ」に狭めない**
    // ——`###` の節が次の `##` で終わらなくなり、子でないものを子として運ぶ。
    close(start, depth);
    open.push({
      depth,
      heading: line,
      start,
      bodyFrom: start + line.length + 1,
    });
  }
  close(content.length, 1);

  sections.sort((a, b) => a.start - b.start);
  return { bodyStart, sections };
}

/** `lookupMemorySection` の結果。**「無い」と「古い」を畳まない。** */
export type MemorySectionLookup =
  | { kind: 'found'; section: MemorySection }
  /** 中身まで同一の節が複数在り、この id では1つに決まらない。 */
  | { kind: 'ambiguous'; sections: MemorySection[] }
  /** 見出しは一致するが中身のハッシュが違う＝誰かが書き換えた。 */
  | { kind: 'stale'; sections: MemorySection[] }
  /** その id の節がこの文書に1つも無い。 */
  | { kind: 'absent' };

/**
 * 節id で節を1つに決める。
 *
 * **「どちらか」を選ばない。** 中身まで同一の節が2つ在るときは
 * `ambiguous` を返して呼び手に断らせる——片方を黙って選ぶと、**消える側が
 * 観測できない**（応答は「移した」としか言わないので、呼び手は取り違えに
 * 気づく手段を持たない）。
 *
 * **`stale` と `absent` を畳まない。** 疑う先が違う——前者は「誰かが書き
 * 換えた。読み直せ」、後者は「打ち間違いか、別の文書か、見出しごと書き
 * 換えられた」である。判定の材料は `memorySectionId` の doc に在る。
 */
export function lookupMemorySection(
  sections: readonly MemorySection[],
  id: string,
): MemorySectionLookup {
  const exact = sections.filter((section) => section.id === id);
  if (exact.length === 1) return { kind: 'found', section: exact[0] as MemorySection };
  if (exact.length > 1) return { kind: 'ambiguous', sections: exact };
  const headingKey = `${id.split('-')[0] ?? ''}-`;
  const sameHeading = sections.filter((section) => section.id.startsWith(headingKey));
  if (sameHeading.length > 0) return { kind: 'stale', sections: sameHeading };
  return { kind: 'absent' };
}

/**
 * 複数の節をまとめて切り取った後の `content` と、切り取った文字列を返す
 * （`memory_section_move` が1回で複数の節id を移せるようにするために足した。
 * 節が1個のときも同じ関数を通す——単体版は残していない。1節しか渡されない
 * 呼び出しは `sections` に1要素の配列を渡すだけでよく、実装を2本持つ理由が
 * 無い）。
 *
 * ## 組み立て
 *
 * 1. `sections` を **`start` の昇順に並べ替える**——呼び手が渡した順ではない
 *    （`memory_section_move` の `sections` 引数の doc「渡す順ではなく文書に
 *    現れる順」）。
 * 2. `nextContent` は範囲の**間**の slice を繋いで作る（先頭の節の前・
 *    節と節の間・末尾の節の後ろ）。
 * 3. `cut` は範囲の中身を**文書に現れる順**で繋ぐ。呼び手が逆順（後ろの
 *    節を先に）渡しても、移し先には元の文書に現れる順で並ぶ。
 *
 * **継ぎ足しであることは1節のときと変わらない。** `slice` を繋ぐだけで
 * `serializeMemoryFrontmatter` を一度も通さない。`section.start` は必ず
 * `memoryBodyStart(content)` 以上（`MemorySection` の doc）なので、
 * frontmatter のバイト列がどの節の範囲にも入らないことも変わらない
 * （`memoryBodyStart` の doc）。**それでも書き込み前に検査すること**——
 * この関数が正しいことと、次にここを触る人が組み直す形に変えないことは
 * 別である（`memory_section_move` の第3層。`tools.ts` を読むこと）。
 *
 * ## ⚠️ 並べ替えた列（`ordered`）も返す——並び順の所有権はここにある
 *
 * 呼び手（`memory_section_move`）は、移した節を応答の一覧に**文書順で**並べる
 * ためにこの並びを要る。そこで呼び手が自分でもう一度並べ替えると、**同じ規則が
 * 2箇所に立つ**——片方を壊しても、もう片方が結果を正しくしてしまうので、
 * 「渡す順ではなく文書順で並ぶ」という保証を変異で撃っても歯が1本も赤く
 * ならなくなる（実測 2026-09-08。変異試験で見つけた）。**規則を1箇所に置き、
 * 並べ替えの結果そのものを返して呼び手に使わせる。**
 *
 * ## ⚠️ 範囲が重ならないことは呼び手の責任である
 *
 * ここには重なりを検出する分岐を置いていない。重なった範囲を渡すと、
 * 昇順に並べた次の節の `start` が前の節の `end` より手前に来て、
 * 「間」の slice が負の範囲になったり同じ文字列を2回運んだりする——
 * その検出は `findOverlappingMemorySections` の仕事であり、
 * `memory_section_move` はこの関数を呼ぶ前にそちらで断る
 * （`tools.ts` を読むこと）。ここに同じ検査を重ねて置くと、片方を
 * 直したときにもう片方が古いままになる経路ができるので、重ねない。
 */
export function cutMemorySections(
  content: string,
  sections: readonly MemorySection[],
): { nextContent: string; cut: string; ordered: readonly MemorySection[] } {
  const ordered = [...sections].sort((a, b) => a.start - b.start);

  let nextContent = '';
  let cut = '';
  let cursor = 0;
  for (const section of ordered) {
    nextContent += content.slice(cursor, section.start);
    cut += content.slice(section.start, section.end);
    cursor = section.end;
  }
  nextContent += content.slice(cursor);

  return { nextContent, cut, ordered };
}

/**
 * 複数の節id を渡されたとき、範囲が重なっている組が無いかを確かめる
 * （`memory_section_move` が複数節を移す前の全件先出しの検査の一部）。
 *
 * `start` の昇順に並べ、**隣り合う組だけ**を見る。範囲が重ならないなら
 * ソート後は隣り合う組ごとに `prev.end <= next.start` が成り立つはずなので、
 * それが崩れた最初の組を返せば十分——3つ以上にまたがる重なりも、
 * どこかの隣り合う組で必ず引っかかる。重なりが無ければ `null`。
 *
 * ## 捕まえるのは2つの形
 *
 * 1. **親と子を同時に指した。** `MemorySection.end` は子込み（同じ深さ
 *    以下の次の見出しの直前まで）なので、親を切り取ると子も一緒に
 *    消える——気づかずに子の節id も渡していると、同じ節を実質2回
 *    動かす指示になる。
 * 2. **同じ節id を2回渡した。** `lookupMemorySection` で同じ節を指す
 *    id を2つ渡すと、範囲（`start` と `end`）が完全に一致するので、
 *    これも重なりとして拾われる。
 *
 * ## ⚠️ 兄弟（隣り合う節）は重なりではない
 *
 * 兄弟どうしは前の節の `end` が次の節の `start` に一致する
 * （`prev.end === next.start`）。ここでの判定は**厳密な** `next.start < prev.end`
 * なので、これは重なりとして拾われない。`<=` にすると、1つの見出しの
 * 下に並ぶ複数の兄弟節を一度に移すだけの正当な呼び出しまで断ることに
 * なる——複数の兄弟をまとめて移すのは複数節対応そのものの使い道なので、
 * ここを断る分岐は足さない。
 */
export function findOverlappingMemorySections(
  sections: readonly MemorySection[],
): { first: MemorySection; second: MemorySection } | null {
  const sorted = [...sections].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1] as MemorySection;
    const next = sorted[index] as MemorySection;
    if (next.start < prev.end) return { first: prev, second: next };
  }
  return null;
}

/**
 * 見出しの階層が**直近の実在する親より2段以上深い**節（issue #1382「階層飛び」）。
 *
 * `parent` はこの節を直接内包する最も深い節（無ければ `findMemorySectionHierarchyJumps`
 * に渡した `root` そのもの）。`gap` は `section.depth - parent.depth`（必ず2以上）。
 */
export interface MemorySectionHierarchyJump {
  readonly section: MemorySection;
  readonly parent: MemorySection;
  readonly gap: number;
}

/**
 * `root` に内包される子孫のうち、見出しの階層が直近の親より2段以上飛んでいる
 * ものを探す（issue #1382）。
 *
 * ## なぜ調べるか
 *
 * `cutMemorySections` は「同じ深さ以下の次の見出しの直前まで」を子として
 * 一緒に運ぶ（`scanMemorySections` の doc）。これは正しい仕様であり、
 * ここでは変えない——だが**実際に壊れた例が在る**（#916 comment 7、項目
 * 14-2）: `##` の節の直下に `###` として書かれた、親とは無関係な独立した
 * 規則が、親を移したときに一緒に運ばれた。「見出しの深さが1段ずつ連続して
 * いない子孫」（間の深さの見出しを1つも挟まず、親よりいきなり2段以上深く
 * なる見出し）は、書き手が意図せず別の話題を入れ子にしてしまった徴候で
 * ありうる。**ただし妥当な構造でも起こりうる**（もともと `####` から
 * 書き始めると決めている文書もある）ので、ここでは判定しない——
 * `describeMemorySectionMoveHierarchyJumpWarning` の doc「拒否ではなく
 * 警告にとどめる」を読むこと。
 *
 * ## 「直近の親」の求め方——スタックで内包関係を追う
 *
 * `scanMemorySections` が組み立てる節はきれいな入れ子である（重なりが
 * あっても部分重なりにはならない。範囲が完全に一致するか、片方がもう
 * 片方を完全に内包するかのどちらかしかない——`findOverlappingMemorySections`
 * の doc の「親と子を同時に指した」「同じ節id を2回」の2形がこの性質の
 * 上に立っている）。だから `root` に内包される節を `start` の昇順に並べ、
 * スタックの先頭の `end` がこの節の `start` 以下になるまで pop すれば、
 * 残った先頭が直近の親になる——兄弟どうしは `prev.end === next.start`
 * （`findOverlappingMemorySections` の doc）なので、この不等号は `<=`
 * でなければならない（`<` にすると直前の兄弟が親として誤って残る）。
 * `root` 自身はスタックの底に置いたまま pop しない——`root` に内包
 * される節である以上、直近の親が見つからないことは無いはずだが、
 * 万一のときの倒れ先を `root` に固定する（`gap` は `root` 基準で
 * 計算されるので、拒否ではなく警告という性質のまま安全側に倒れる）。
 */
export function findMemorySectionHierarchyJumps(
  allSections: readonly MemorySection[],
  root: MemorySection,
): readonly MemorySectionHierarchyJump[] {
  const descendants = allSections
    .filter(
      (section) => section.id !== root.id && section.start >= root.start && section.end <= root.end,
    )
    .sort((a, b) => a.start - b.start);

  const jumps: MemorySectionHierarchyJump[] = [];
  const stack: MemorySection[] = [root];
  for (const section of descendants) {
    while (stack.length > 1 && (stack[stack.length - 1] as MemorySection).end <= section.start) {
      stack.pop();
    }
    const parent = stack[stack.length - 1] as MemorySection;
    if (section.depth - parent.depth > 1) {
      jumps.push({ section, parent, gap: section.depth - parent.depth });
    }
    stack.push(section);
  }
  return jumps;
}

/**
 * 階層飛びの警告一覧の文字数予算（`MEMORY_SECTION_MOVE_LIST_BUDGET` と同じ
 * 思想。件数ではなく文字数で切る——AGENTS.md の地雷表）。
 */
export const MEMORY_SECTION_MOVE_HIERARCHY_JUMP_LIST_BUDGET = 800;

/**
 * `memory_section_move` の応答へ足す、階層飛びの警告（無ければ `null`）。
 *
 * ## 拒否ではなく警告にとどめる
 *
 * 移動そのものは、この関数を呼ぶ時点で既に完了している——`findOverlappingMemorySections`
 * のような「1文字も書く前に断る」検査とは違う。階層が飛んでいることは
 * **妥当な構造の可能性を残す**（`findMemorySectionHierarchyJumps` の doc）ので、
 * ここでは移動を止めない。既存の7種の断り（frontmatter が壊れている・
 * stale・ambiguous・範囲の重なり等。`tools.ts` の `memory_section_move` の
 * doc の列挙）はどれも**機械的に一意に決まる不正**だが、階層飛びは
 * 「無関係な話題が紛れ込んでいるかもしれない」という**意味の妥当性**の
 * 話で、道具には判定できない——だから応答に1件足すだけにする
 * （issue #1382 の「最小の形（案）」がそのまま警告を提案している）。
 *
 * ## 複数根への拡張
 *
 * `memory_section_move` は複数の節id を1回で移せる（`cutMemorySections`
 * の doc）。`roots`（今回移した節、複数可）ごとに `findMemorySectionHierarchyJumps`
 * を呼び、**全根をまたいだ合計**で「子孫 M 件中 K 件」を言う——Issue の
 * 最小案の文言（「この節id の子孫は M 個で、そのうち見出しの階層が飛んで
 * いるものが K 個」）をそのまま複数根へ拡張した形である。
 *
 * `allSections` は移動前の文書全体の走査結果（`scanMemorySections(...).sections`）
 * を渡すこと——`roots` はその中から選ばれた節でなければ、内包関係の判定が
 * 成り立たない。
 */
export function describeMemorySectionMoveHierarchyJumpWarning(
  allSections: readonly MemorySection[],
  roots: readonly MemorySection[],
): string | null {
  const perRoot = roots.map((root) => ({
    root,
    descendantCount: allSections.filter(
      (section) => section.id !== root.id && section.start >= root.start && section.end <= root.end,
    ).length,
    jumps: findMemorySectionHierarchyJumps(allSections, root),
  }));

  const descendantTotal = perRoot.reduce((sum, entry) => sum + entry.descendantCount, 0);
  const allJumps = perRoot.flatMap((entry) => entry.jumps);
  if (allJumps.length === 0) return null;

  const lines = allJumps.map(
    (jump) =>
      `- 「${jump.section.heading}」は直近の親「${jump.parent.heading}」より ${jump.gap} 階層深い（1段飛ばし以上）`,
  );
  const listing = renderListing(lines, {
    budget: MEMORY_SECTION_MOVE_HIERARCHY_JUMP_LIST_BUDGET,
    omitted: ({ rest, total }) =>
      `…ほか ${rest} 件は一覧から省略（階層が飛んでいる子孫は全 ${total} 件）。`,
  });

  return (
    `⚠ 移した節の子孫 ${descendantTotal} 件のうち ${allJumps.length} 件は、見出しの階層が` +
    '直近の親より2段以上飛んでいる（例: `##` の子に `####` が直接ぶら下がる、間の `###` が無い）。' +
    '親と無関係な話題が、書式の都合で子として一緒に運ばれた可能性がある——妥当な構造のこともあるので' +
    '断ってはいない。移した先を memory_outline で確かめ、無関係なら memory_section_move で切り離すこと。\n' +
    listing
  );
}

/**
 * `memory_section_move` が応答に並べる「移した節の一覧」の文字数予算。
 *
 * **件数ではなく文字数で切る**——`MEMORY_OUTLINE_BUDGET` と同じ思想
 * （見出しの長さは節ごとにばらばらなので、件数で切ると出力量が見出しの
 * 長さ次第で暴れる。AGENTS.md の地雷表）。渡された節id が90個でも応答が
 * 際限なく伸びないための歯止めであり、ここで切れるのは**一覧の表示**
 * だけである——移動そのものは、この一覧を組む前に全件先出しの検査
 * （`findOverlappingMemorySections` を含む）を通って一括で終わっている
 * ので、「一覧から省略」であって「移動していない」ではない
 * （`tools.ts` の `memory_section_move` の doc）。
 */
export const MEMORY_SECTION_MOVE_LIST_BUDGET = 2_000;

/** 目次の予算（文字数）。件数では切らない（AGENTS.md の地雷表）。 */
export const MEMORY_OUTLINE_BUDGET = 8_000;

/**
 * 目次を文書の**どちら側**から詰めるか（`memory_outline` の `side`）。
 *
 * **落ちるのは常に反対側である。** `'head'`（既定）なら末尾側が落ち、
 * `'tail'` なら先頭側が落ちる。**行の並びはどちらでも文書順のままで、この値が
 * 変えるのは「予算に入らなかったときにどちらを捨てるか」だけである。**
 *
 * **これは窓（オフセット）ではない。** 予算は文字数なので何節入るかは見出しの
 * 長さで動き、「末尾の N 節」を添字で当てる材料は呼び手の手元に無い。⟹ 渡すのは
 * 向きだけにして、何節入るかは予算に決めさせる。
 *
 * **値の列挙をここ1箇所に置く。** `tools.ts` が `z.enum(MEMORY_OUTLINE_SIDES)` で
 * 同じ配列を引くので、増やしても道具の側の書き換えが要らない
 * （`z.enum(JOURNAL_ENTRY_TYPES)` と同じ形）。
 */
export const MEMORY_OUTLINE_SIDES = ['head', 'tail'] as const;

/** 目次を出す向き（`MEMORY_OUTLINE_SIDES` の doc を読むこと）。 */
export type MemoryOutlineSide = (typeof MEMORY_OUTLINE_SIDES)[number];

/**
 * `memory_outline` の応答本体。
 *
 * **本文は1文字も出さない**（`memory_delete` が本文を日誌へ写さない線と
 * 同じ。`tools.ts` の該当 doc）。出るのは節id・見出し行・文字数だけである。
 * **frontmatter の行も1つも出ない**（`scanMemorySections` が
 * `memoryBodyStart` より前を一度も見ないので、材料が存在しない）。
 *
 * インデントが見出しの深さを表す。文字数は**子込み**なので、
 * **移したときに動く量が、呼ぶ前に数字で分かる。**
 *
 * **中身まで完全に同一の節が2つ在ると id が衝突する。** そのときはその id の
 * 行に印を出す——黙って並べると、呼び手はどちらか一方を指したつもりで
 * 断られる理由が分からない。
 *
 * ## `side` — 予算で落とす側を選ぶ
 *
 * **`'tail'` は `renderListingFromEnd`（`excerpt.ts`）を通すだけである。** 向きが
 * 違うだけの予算のループは既にあちらに在り、断り書きを穴の空いた側（先頭）へ
 * 置くところまで持っている。ここに同じループを書き直さない。
 *
 * **⚠️ `side` 単独が言えないこと: 中央は、どちらの向きでも出ない。** 予算に
 * 入らない中間の節は `'head'` でも `'tail'` でも落ちる。**「末尾から出せる」は
 * 「全部見える」ではない。**
 *
 * **節id は `side` に依存しない。** 材料はその節の見出し行と中身だけである
 * （`memorySectionId`）ので、**どちら側を出したかで id は1文字も変わらない ＝
 * 版の照合は弱まらない。**
 *
 * ## `q` — 見出しで絞り込む（中央へ届く道その1）
 *
 * 大文字小文字を区別しない**部分一致**。渡された文字列は `String.includes`
 * にそのまま渡すので、正規表現としては解釈しない——メタ文字（`.` `*` `[` `(`
 * `\` など）を含んでいても、その文字どおりの並びとしてしか一致しない。
 *
 * 応答は必ず「全 N 節のうち M 節が一致」を言う。**一致0件と、一致はあるが
 * 予算で切れた場合は別の文言にしてある**——前者は「一致そのものが無い」で
 * あって「予算が足りない」ではない。混ぜると、絞り込み語を直せば直るのか
 * `offset` で窓をずらすしかないのかが読み手に伝わらない。
 *
 * `side` と併用できる（絞り込んだ結果を先頭から詰めるか末尾から詰めるか）。
 * 一致した行は目次の1行と同じ形（`[節id] 見出し — N 文字`）——そのまま
 * `memory_section_read` / `memory_section_move` へ渡せる。**中間の節でも、
 * 見出しに残る言葉さえ思い出せれば、この口で直接 節id に届く。**
 *
 * ## `offset` — 窓をずらす（中央へ届く道その2。完全な到達を保証する側）
 *
 * 先頭から `offset` 節を飛ばしてから予算を埋める。**`q` は「思い出せる言葉が
 * あるとき」の近道で、`offset` は「言葉を思い出せなくても、有限回の呼び出しで
 * 必ず全節へ届く」ほうの保証である**——窓の大きさ（応答が「続きは
 * offset=N で」と返す、その N）ぶんずつ進めれば、文書がどれだけ大きくても
 * 全節の節id に到達できる。`offset` を渡すと `side` は見ない——`offset` は
 * 「窓をどこから開けるか」の指定で、`side` は「窓の中で予算に入らない側を
 * どちらへ捨てるか」の指定であり、役割が違う（窓を開いた後で詰める向きが
 * 変わると、offset を進める歩幅の保証が崩れる）。範囲外の `offset`（節数以上）
 * は黙って空にせず、その旨を明示して断る。
 *
 * `q` と `offset` は併用できる——`offset` は「絞り込み後の並び」に対して窓を
 * 開く。
 *
 * **⚠️ `q` も `offset` も渡さないとき、出力は1文字も変えていない。** 以下の
 * 実装はまずこの分岐を独立させ、その中身を移設前と揃えてある。
 */
/**
 * 節の一覧の**1行の形**。目次を出す場所が2つ（道具の `memory_outline` と、
 * プロンプトへ焼く記憶のカード）あるので、**行の形の持ち主をここ1つにする。**
 *
 * **予算と省略の文言は共有しない。** どちらも「何文字まで載せてよいか」と
 * 「省いたときに何をすればよいか」が違う（道具は `side` で反対側を出せるが、
 * 焼き込みは1回しか描かない）。⟹ 共有するのは行の形だけで、切り方は呼び手が
 * 持つ（`.claude/skills/listing-and-detail/SKILL.md` の「予算は件数ではなく
 * 文字数で持つ」は呼び手ごとに効く）。
 */
function memorySectionLines(sections: readonly MemorySection[]): string[] {
  const counts = new Map<string, number>();
  for (const section of sections) counts.set(section.id, (counts.get(section.id) ?? 0) + 1);
  return sections.map((section) => {
    const indent = '  '.repeat(section.depth - 1);
    const ambiguous =
      (counts.get(section.id) ?? 0) > 1
        ? ' ⚠この id は複数箇所に当たる。この id では動かせない（memory_section_move は断る）'
        : '';
    return `${indent}[${section.id}] ${section.heading} — ${formatMemoryCharCount(section.chars)} 文字${ambiguous}`;
  });
}

/**
 * `memory_outline` の省略の断り書きに足す、予算についての注記。
 *
 * **head/tail の2箇所で書き分けず、ここ1つに集約してある。** 依頼者が
 * 実際にこの予算の値（8,000）を、別の予算（毎ターンの焼き込みの節目次、
 * `MEMORY_PROMPT_OUTLINE_BUDGET` = 6,000）の値だと取り違えて自分の記憶に
 * 書いた実例がある——**値も観測も正しく、誤っていたのは値の帰属だけ**
 * だった。だから「値を見せる」だけでは再発する。次の4つを**同時に**
 * 見せる。
 *
 * 1. **その値**（`MEMORY_OUTLINE_BUDGET`。定数から組み立てる——文字列へ
 *    直書きすると、値が動いたときに断り書きのほうが嘘をつく）
 * 2. **何を切る予算か**——「`memory_outline` の1回のツール応答」（MCP の
 *    出力上限のため）であって、「毎ターンの焼き込み」ではない。焼き込み側
 *    の予算は2つに分かれている——fact 全体を束ねた目次は
 *    `MEMORY_TOC_CHAR_BUDGET`、premise 1文書ぶんの節目次は
 *    `MEMORY_PROMPT_OUTLINE_BUDGET`（値も別なので、混同すると値まで違う）
 * 3. ⭐ **同じ数字を持つ別の記憶の予算の名前**——`MEMORY_LISTING_BUDGET`
 *    （`memory_list` の一覧の予算）。この2つは値がたまたま同じなだけで、
 *    切っている対象が違う（`memory_outline` は1文書の節を、`memory_list`
 *    は全文書を並べる）
 * 4. **族の名乗り**——この値は「1回のツール応答に何文字載せるか」
 *    （MCP の出力上限）という理由で、道具の応答を切る予算に共通して
 *    使われている値である。⟹ 3 で兄弟を1本（`MEMORY_LISTING_BUDGET`）
 *    だけ名指ししても、読み手が「これで全部」と誤読する余地が残る——
 *    同じ理由で同じ値を持つ予算は他にもある、という事実そのものを言う
 *    （個体名までは列挙しない。名指しの範囲を「記憶の予算」に限ったのは
 *    3 の判断のままで変えていない）
 *
 * **3つ目は値が一致しているときにしか真ではない。** `MEMORY_LISTING_BUDGET`
 * を直接比較して分岐する——将来どちらかの値だけが動いて一致が崩れても、
 * この関数は「一致しない」と正直に書く（黙って嘘の一致を言い続けない）。
 *
 * **4つ目は3つ目の分岐（値が一致するかどうか）と独立させ、必ず出す。**
 * `sibling` の2分岐のどちらかの中に書くと、その分岐が選ばれたときにしか
 * 出ない非対称が生まれる——`family` を別の変数として立て、`scope` /
 * `sibling` と並べて連結する。
 *
 * `memory_outline` 自身の応答は、ここでは「目次」と呼ばない。「目次」は
 * この repo で3つの別のものを指す（fact 全体の目次・premise の節目次・
 * この `memory_outline` の応答）——**取り違えの発端がまさにここだった**ので、
 * この注記の中でだけは道具名（`memory_outline`）または定数名で名指しする。
 */
function renderMemoryOutlineBudgetNote(): string {
  const value = formatMemoryCharCount(MEMORY_OUTLINE_BUDGET);
  const scope =
    `この ${value} 文字は、memory_outline の1回のツール応答を切る予算である` +
    '（MCP の出力上限のため）。毎ターン全員が払う焼き込みの予算——fact 全体の' +
    '目次（MEMORY_TOC_CHAR_BUDGET）や premise 1文書ぶんの節目次' +
    '（MEMORY_PROMPT_OUTLINE_BUDGET）——とは別の予算である。';
  const sibling =
    MEMORY_LISTING_BUDGET === MEMORY_OUTLINE_BUDGET
      ? `⚠ memory_list の一覧の予算（MEMORY_LISTING_BUDGET）もいま同じ ${value} 文字だが、` +
        '別の予算である（1文書の節を並べる予算と、全文書を並べる予算）。'
      : 'memory_list の一覧の予算（MEMORY_LISTING_BUDGET、いま ' +
        `${formatMemoryCharCount(MEMORY_LISTING_BUDGET)} 文字）とは値が一致しない` +
        '——一致していた時期があっても、いまは別の値である。';
  const family =
    `そして ${value} は「1回のツール応答に何文字載せるか」（MCP の出力上限）という理由で` +
    '道具の応答を切る予算に共通して使われている値であり、この数字だけではどの予算かは決まらない' +
    '——同じ理由で同じ値を持つ予算が他にもある。';
  return `${scope} ${sibling} ${family}`;
}

/**
 * `memory_outline` へ渡せるオプション。**`side` 単体・省略・`{}` のどれでも、
 * `q` と `offset` を1つも渡さなければ出力は移設前と1文字も変わらない。**
 * （下の `renderMemoryOutline` の分岐そのものが歯である——`q === undefined
 * && offset === undefined` のときは旧実装の式をそのまま評価する。）
 */
export interface MemoryOutlineOptions {
  /** 予算で落とす側（`MEMORY_OUTLINE_SIDES` の doc）。既定は `'head'`。 */
  side?: MemoryOutlineSide;
  /** 見出しの絞り込み（上のクラスdocの「`q`」節）。 */
  q?: string;
  /** 窓の開始位置（上のクラスdocの「`offset`」節）。0起点。 */
  offset?: number;
}

/**
 * `q` による見出しの絞り込み。
 *
 * **大文字小文字を区別しない部分一致。正規表現としては解釈しない。** 渡された
 * 文字列は `String.prototype.includes` へそのまま渡すので、`.` `*` `[` `(`
 * `\` のようなメタ文字を含んでいても、その文字どおりの並びとしてしか一致
 * しない——`RegExp` を経由しないので、壊れようがない。
 */
function filterMemorySectionsByHeading(
  sections: readonly MemorySection[],
  q: string,
): MemorySection[] {
  const needle = q.toLowerCase();
  return sections.filter((section) => section.heading.toLowerCase().includes(needle));
}

export function renderMemoryOutline(
  sections: readonly MemorySection[],
  sideOrOptions: MemoryOutlineSide | MemoryOutlineOptions = 'head',
): string {
  if (sections.length === 0) {
    return (
      '節が1つも無い（見出しが1つも無いか、最初の見出しより前の前書きしか無い）。' +
      '前書きは節ではないので memory_section_move では動かせない。'
    );
  }

  // **文字列（旧い呼び方）とオプション（新しい呼び方）の両方を受ける。**
  // 既存の呼び手（`renderMemoryOutline(sections, 'tail')` の形）を壊さない
  // ための後方互換であって、新しい呼び手が文字列を渡す理由にはならない。
  const options: MemoryOutlineOptions =
    typeof sideOrOptions === 'string' ? { side: sideOrOptions } : sideOrOptions;
  const side = options.side ?? 'head';
  const { q, offset } = options;

  // ============================================================
  // **`q` も `offset` も渡さないとき: 以下は移設前の実装そのものである。**
  // 1文字も変えていない——変えたのは「ここへ来る前に分岐したこと」だけ。
  // ============================================================
  if (q === undefined && offset === undefined) {
    const items = memorySectionLines(sections);
    // **どちら側を落としたかを言う。** 「N 節省略」だけだと続きの取り方を間違える
    // （`conversation_read` の中身モードが同じ理由で同じことをしている）。そして
    // **続きの取り方を書けるのは、呼び手の側にその口が実在するときだけである**
    // （`excerpt.ts` の `ListingBudget.omitted` の doc）——`side` を足したこの版で
    // 初めて、末尾側へ行く口が実在する。旧い文面の「先に上の節を減らす」は、
    // **末尾を指せないまま末尾を減らせ**と言っていた ＝ 到達できない助言だった。
    const render = side === 'tail' ? renderListingFromEnd : renderListing;
    const budgetNote = renderMemoryOutlineBudgetNote();
    return render(items, {
      budget: MEMORY_OUTLINE_BUDGET,
      omitted: ({ rest, shown, total }) =>
        side === 'tail'
          ? `…先頭 ${rest} 節は省略（節は全 ${total} 件あり、末尾から ${shown} 件だけ出した）。` +
            '先頭側は side を渡さずに呼べば出る（既定）。' +
            '⚠中央（どちらの端からも予算の外に出る節）は、どちらの向きでも出ない——' +
            '端の節を memory_section_move で移して文書を縮めれば、次に memory_outline を' +
            '呼んだときの応答にそれが載る。' +
            ` ${budgetNote}`
          : `…末尾 ${rest} 節は省略（節は全 ${total} 件あり、先頭から ${shown} 件だけ出した）。` +
            '末尾側の節id が要るなら side=tail で呼ぶこと。' +
            '⚠中央（どちらの端からも予算の外に出る節）は、どちらの向きでも出ない。' +
            ` ${budgetNote}`,
    });
  }

  // ============================================================
  // ここから先は `q` / `offset` のどちらか（または両方）が渡された経路。
  // 上のブロックとは完全に別の式なので、上のブロックの出力には1バイトも
  // 影響しない。
  // ============================================================

  // `q`: 見出しで絞り込む。絞り込んだ後の並び（`pool`）を、以降の offset /
  // side の材料にする。
  let pool = sections;
  let queryHeader = '';
  if (q !== undefined) {
    const matched = filterMemorySectionsByHeading(sections, q);
    if (matched.length === 0) {
      // **一致0件と、一致はあるが予算で切れた場合を混ぜない。** 前者は
      // 「一致そのものが無い」であって「予算が足りない」ではない——文言を
      // 変えれば当たるのか、offset で窓をずらすしかないのかが違う。
      return (
        `見出しに「${q}」を含む節は無かった（一致0件。全 ${formatMemoryCharCount(sections.length)} 節を検索した）。` +
        'これは予算で落ちたのではない——一致そのものが無い。'
      );
    }
    pool = matched;
    queryHeader =
      `見出しに「${q}」を含む節: 全 ${formatMemoryCharCount(sections.length)} 節のうち ` +
      `${formatMemoryCharCount(matched.length)} 節が一致した。`;
  }

  const budgetNote = renderMemoryOutlineBudgetNote();
  const scopeLabel = q !== undefined ? '絞り込み後' : '全';

  // `offset`: 窓をずらす。**常に先頭から詰める（`side` を見ない）。** offset は
  // 「窓をどこから開けるか」、side は「窓の中で入らない側をどちらへ捨てるか」
  // で役割が違う——ここで side を見てしまうと、offset を「窓の大きさぶんずつ
  // 進めれば有限回で全節に届く」という保証が、進み方が向きで変わることで崩れる。
  if (offset !== undefined) {
    if (!Number.isInteger(offset) || offset < 0) {
      return `offset は0以上の整数で渡すこと（渡された値: ${offset}）。`;
    }
    if (offset >= pool.length) {
      return (
        `${queryHeader ? queryHeader + ' ' : ''}` +
        `offset=${offset} の位置に節は無い（${scopeLabel} ${formatMemoryCharCount(pool.length)} 節しか無い）。`
      );
    }
    const windowed = pool.slice(offset);
    const items = memorySectionLines(windowed);
    const { lines, shown } = fillListingBudget(items, MEMORY_OUTLINE_BUDGET, false);
    const endIndex = offset + shown; // 次に呼ぶべき offset そのもの。呼び手は算術をしない。
    const more = endIndex < pool.length;
    const rangeLine =
      `${formatMemoryCharCount(offset + 1)}〜${formatMemoryCharCount(endIndex)} 節目 / ` +
      `${scopeLabel} ${formatMemoryCharCount(pool.length)} 節のうち ${formatMemoryCharCount(shown)} 節を出した。`;
    const continuationLine = more
      ? `続きが在る。次は offset=${endIndex} で呼ぶこと` +
        '（窓の大きさぶんずつ進めれば、有限回で全節に届く）。'
      : '続きは無い（最後まで出した）。';
    return [queryHeader, rangeLine, continuationLine, budgetNote, ...lines]
      .filter((line) => line !== '')
      .join('\n');
  }

  // `q` だけが渡された経路。`side` で「絞り込んだ結果」を先頭から詰めるか
  // 末尾から詰めるかを選ぶ——offset と違い、ここでは向きに意味がある
  // （窓の開始点を固定していないため）。
  const items = memorySectionLines(pool);
  const { lines, shown } = fillListingBudget(items, MEMORY_OUTLINE_BUDGET, side === 'tail');
  const omittedCount = pool.length - shown;
  const shownLabel =
    side === 'tail'
      ? `そのうち末尾から ${formatMemoryCharCount(shown)} 節を載せた`
      : `そのうち先頭から ${formatMemoryCharCount(shown)} 節を載せた`;
  const remainderNote =
    omittedCount === 0
      ? '（全件を載せた）。'
      : side === 'tail'
        ? `（先頭側の ${formatMemoryCharCount(omittedCount)} 節は予算で省略。` +
          'offset を併用すればこの絞り込みの先頭側も出せる）。'
        : `（末尾側の ${formatMemoryCharCount(omittedCount)} 節は予算で省略。` +
          'side=tail か offset を併用すれば続きが出せる）。';
  return [`${queryHeader}${shownLabel}${remainderNote}`, budgetNote, ...lines].join('\n');
}

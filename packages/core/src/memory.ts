/**
 * 記憶をクローンの文脈へ載せる形を決める場所。器（fs / pg / インメモリ）の側に置かない:
 * 器ごとに書くと食い違い、インメモリ実装だけ見出し無しの連結でテストが緑になっていた。
 */

import {
  excerpt,
  excerptLine,
  fillListingBudget,
  renderListing,
  renderListingFromEnd,
} from './excerpt.js';
import { encodeMemoryCursor } from './memory-cursor.js';
import { memoryFreshnessMarker } from './memory-freshness-format.js';
import {
  formatMemoryCreatedAt,
  parseMemoryFrontmatter,
  resolveMemoryDocKind,
} from './memory-frontmatter.js';
import {
  formatMemoryCharCount,
  formatMemoryCharDelta,
  formatMemoryPercentDelta,
  MEMORY_PROMPT_OUTLINE_HEADING_WIDTH,
  type MemorySection,
  memorySectionLines,
  OUTLINE_AMBIGUOUS_MARKER,
  scanMemorySections,
  truncateOutlineHeading,
} from './memory-sections.js';
import { heuristicChars, type HeuristicChars } from './quantity.js';
import type { MemoryCreatedAt, MemoryDescriptionFreshness, MemoryDocKind } from './schema.js';

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

interface PremiseOutlineFit {
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

export {
  assertNeverMemoryProtectionStatus,
  deriveHumanTouchedAtFromJournal,
  deriveMemoryBootBackfillFromJournal,
  MEMORY_JOURNAL_SCAN_PAGE_SIZE,
  memoryProtectionRebuildDecision,
} from './memory-journal-derive.js';

export {
  applyMemoryFrontmatterPatch,
  assertNeverMemoryCreatedAt,
  assertNeverMemoryDocKind,
  deriveMemoryFrontmatter,
  findMemoryFrontmatterLineBreak,
  formatMemoryCreatedAt,
  isKnownMemoryDocKind,
  memoryBodyStart,
  nextDescribedState,
  parseMemoryFrontmatter,
  resolveMemoryDescriptionFreshness,
  resolveMemoryDocKind,
  toMemoryCreatedAt,
} from './memory-frontmatter.js';
export {
  cutMemorySections,
  describeMemorySectionMoveHierarchyJumpWarning,
  findMemorySectionHierarchyJumps,
  findOverlappingMemorySections,
  lookupMemorySection,
  MEMORY_PROMPT_OUTLINE_HEADING_WIDTH,
  MEMORY_SECTION_MOVE_HIERARCHY_JUMP_LIST_BUDGET,
  MEMORY_SECTION_MOVE_LIST_BUDGET,
  memorySectionId,
  scanMemorySections,
} from './memory-sections.js';
export type { MemorySection, MemorySectionLookup } from './memory-sections.js';

// 鮮度の印の一式は `memory-freshness-format.ts` に置く（CLI と同じ1本）。ここからも同じ名前で出す
export {
  assertNeverMemoryDescriptionDrift,
  assertNeverMemoryDescriptionFreshness,
} from './memory-freshness-format.js';

// 記憶の全文（branded type — `renderMemoryDocuments` だけが作れる。4-14）
// 生の文字列を `buildCloneSystemPrompt` に渡すと tsc が落ちる: 記憶が文字列になる経路を `renderMemoryDocuments` の1つに閉じるため
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
  // 渡し手は「今回載せていないもの」を選り分けず、手元の全体をそのまま渡す: 選り分けを渡し手にやらせると、そこが2つ目の間違えどころになるため
  presentInMemory?: MemoryPresence;
}

// 循環と、存在しない親を指す `parent` を黙って落とさない: 文書は消さずルートとして目次に残し、印をつける
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
  { rest, shown, total }: { rest: number; shown: number; total: number },
): string {
  const dropped = items.slice(shown);
  // 末尾を残す向きで切る: 落ちた並びの中でも読み手が要るのは新しい側（末尾）で、穴が空くのは古い側（先頭）のため
  const tail = renderListingFromEnd(dropped, {
    budget: MEMORY_PROMPT_OMITTED_TAIL_BUDGET,
    omitted: ({ rest: above }) =>
      `…（この上にさらに ${formatMemoryCharCount(above)} 節落ちている。全部は memory_outline の side=tail で見る）`,
  });

  // 毎ターン焼かれるので、数と開き方と移す基準だけにする。仕組みと算術の説明は memory_outline の応答側（`renderPremiseOutlineOverflowNote`）
  return [
    `…末尾 ${formatMemoryCharCount(rest)} 節は目次から省略（全 ${formatMemoryCharCount(total)} 節のうち先頭 ` +
      `${formatMemoryCharCount(shown)} 節だけ載せた）。` +
      '落ちた末尾のうち直近の節（節id はそのまま memory_section_read に渡せる）:',
    tail,
    'memory_outline の side=tail（末尾）・q=<文字列>（見出しで絞る）・offset=<N>（窓をずらす）で残りの節id に届く。' +
      '割るなら memory_section_move で付録へ。**移すのは済んだ経緯・失効した手順であって、末尾の新しい節ではない。**',
  ].join('\n');
}

// 焼き込みの断り書きから移した説明: その文書の目次が premise の焼き込み予算を超えているときだけ memory_outline の応答に出す。
// 焼き込みと同じ行の形（prompt: 文字数なし・見出しは切る）・同じ予算・同じ `fillListingBudget` で数える: 道具の形（文字数あり・全文）で数えると、焼き込みが省略を名乗る線と、この説明が出る線がずれるため
function renderPremiseOutlineOverflowNote(sections: readonly MemorySection[]): string {
  const items = memorySectionLines(sections, sections, 'prompt');
  const { rest, shown, total } = fillListingBudget(items, MEMORY_PROMPT_OUTLINE_BUDGET, false);
  if (rest === 0) return '';

  const outlineChars = items.reduce((sum, item) => sum + item.length, 0);
  const shownChars = items.slice(0, shown).reduce((sum, item) => sum + item.length, 0);
  const droppedChars = items.slice(shown).reduce((sum, item) => sum + item.length, 0);
  // 焼き込みに載る見出し（80 字で切った後）の長さで引く: 全文の長さで引くと、切った分が固定費に化ける
  const headingChars = sections.reduce(
    (sum, section) => sum + truncateOutlineHeading(section.heading).length,
    0,
  );
  // 固定費は引き算で出す: 1行の形（`memorySectionLines`）が変わったときに、書き写した数だけが古くなるのを防ぐため
  const fixedChars = outlineChars - headingChars;
  const room = MEMORY_PROMPT_OUTLINE_BUDGET - fixedChars;
  // 固定費が節数に比例して最短の見出しでも載らない文書には「縮めれば載る」と言わない: 縮める先が無く、実行できない助言になるため
  const arithmetic =
    room < total * MEMORY_MIN_HEADING_CHARS
      ? `⚠ 節id と記号の固定費だけで ${formatMemoryCharCount(fixedChars)} 文字を使う（予算 ` +
        `${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字）。**見出しを最短（\`# x\`）まで` +
        `縮めても全 ${formatMemoryCharCount(total)} 節は載らない**——固定費は節数に比例するので、` +
        `この文書は縮めるのではなく memory_section_move で割るしかない。`
      : `1行の平均は ${formatMemoryCharCount(Math.round(outlineChars / total))} 文字` +
        `（うち節id と記号の固定費が ${formatMemoryCharCount(Math.round(fixedChars / total))} 文字）。` +
        `予算 ${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字に全 ` +
        `${formatMemoryCharCount(total)} 節を載せるには、見出しを平均 ` +
        `${formatMemoryCharCount(Math.floor(room / total))} 文字（いま ` +
        `${formatMemoryCharCount(Math.round(headingChars / total))} 文字）まで縮める必要がある。` +
        `（焼き込みでは ${MEMORY_PROMPT_OUTLINE_HEADING_WIDTH} 字を超える見出しは切ってあり、いまの数はその後の長さ）`;

  return [
    '⚠ この文書は大きすぎて、目次すら毎ターンの焼き込みに収まっていない。' +
      `節の目次は全 ${formatMemoryCharCount(total)} 節ぶんで ${formatMemoryCharCount(outlineChars)} 文字` +
      `（節の本文の総量ではない）——うち焼き込みに載った分 ${formatMemoryCharCount(shownChars)} 文字、` +
      `予算に入らず省いた分 ${formatMemoryCharCount(droppedChars)} 文字。` +
      `⭐ 落ちている ${formatMemoryCharCount(rest)} 節をすべて移し切るまで、毎ターンの床はほとんど動かない` +
      '——目次の費用は1文書あたりの予算に張り付いていて、節を減らしても「載る節が入れ替わる」だけ' +
      `だからである。${formatMemoryCharCount(shown)} 節まで割り切った時点で省略が消え、この断り書きごと` +
      '床から落ちる——そこが節の移動が床に効き始める点である。',
    arithmetic,
    'q=<文字列> で見出しを絞り込めば一致した節の節id へ直接届き、' +
      'offset=<N> で先頭から窓をずらして読むこともできる——後者は窓の大きさぶんずつ進めれば、' +
      'この文書がどれだけ大きくても全節の節id に有限回で届く（中央の節も含めて）。これらで残りを確かめてから、' +
      'memory_section_move で付録の文書へ割ること。**移すのは済んだ経緯・' +
      '1回きりの実測・失効した手順であって、末尾の新しい節ではない。** ' +
      '⚠ side=tail は末尾を**読む**ための向きであって、末尾を**移す**ための指示ではない' +
      '——読んで確かめた末尾をそのまま移すと、いちばん新しい学びを fact へ追い出すことになる。' +
      '同じ理由で、q や offset で中央の節id が読めても、それをそのまま移してよいとは限らない——' +
      '何を移すかの基準（直上）は変わらない。',
    // 1行にまとめる: 注記が複数行だと、行ごとに節の並びを読む呼び出し側（断り書きは穴の側の端の行に在る）が注記の行と並びの行を取り違えるため
  ].join(' ');
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
  const items = memorySectionLines(sections, sections, 'prompt');
  const listing = renderListing(items, {
    budget: MEMORY_PROMPT_OUTLINE_BUDGET,
    omitted: (part) => renderPremiseOutlineOmission(items, part),
  });
  const anyTruncated = sections.some(
    (section) => truncateOutlineHeading(section.heading) !== section.heading,
  );

  return [
    head,
    summaryLine,
    '節（memory_section_read に節id を渡せば本文が開く。文字数（子込み）は memory_outline で見られる）:',
    ...(anyTruncated ? ['見出しが長いものは … で切ってある。全文は memory_outline。'] : []),
    listing,
  ].join('\n');
}

// renderPremiseCard と同じ `fillListingBudget`・同じ予算で数える: ここで独自にループを書くと、断り書きが数える shown/rest と食い違うため
export function measurePremiseOutlineFit(part: MemoryPart): PremiseOutlineFit | null {
  const { sections } = scanMemorySections(part.content);
  if (sections.length === 0) return null;
  const items = memorySectionLines(sections, sections, 'prompt');
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

// 行から見出しの候補を返す（先に試すものから）: 焼き込みの行（文字数なし）と道具の行（`— N 文字` 付き）の両方を読める。
// 見出しが `— N 文字` で終わる節と区別が付かないので、末尾を外さない読みを先に置く
function parseOutlineLineHeadings(line: string): string[] | null {
  const match = /^\s*\[[^\]]+\] (.+)$/.exec(line);
  if (!match) return null;
  let rest = match[1] as string;
  if (rest.endsWith(OUTLINE_AMBIGUOUS_MARKER))
    rest = rest.slice(0, -OUTLINE_AMBIGUOUS_MARKER.length);
  const withoutChars = /^(.+) — [\d,]+ 文字$/.exec(rest);
  return withoutChars ? [rest, withoutChars[1] as string] : [rest];
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
    // 行に出る形（切った後）でも引けるようにする: 切った見出しは行から全文へ戻せないので、前方一致の代わりに切った後の形で突き合わせる
    for (const key of new Set([section.heading, truncateOutlineHeading(section.heading)])) {
      const list = byHeading.get(key);
      if (list) list.push(section);
      else byHeading.set(key, [section]);
    }
  }
  // 節ごとに単独で `memorySectionLines` を呼び直さない: id の衝突マーカーは文書全体を見て初めて正しく判定できるため
  const currentLineBySectionId = new Map<string, string>();
  const currentLines = memorySectionLines(currentSections, currentSections, 'prompt');
  currentSections.forEach((section, index) => {
    currentLineBySectionId.set(section.id, currentLines[index]!);
  });

  const pushedOut: { heading: string; section: MemorySection }[] = [];
  const removedOrRewritten: string[] = [];
  const ambiguous: string[] = [];
  const other: string[] = [];

  for (const line of droppedLines) {
    const candidates = parseOutlineLineHeadings(line);
    if (candidates === null) {
      other.push(line);
      continue;
    }
    const heading = candidates.find((candidate) => byHeading.has(candidate)) ?? candidates[0]!;
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
  const sections = [...uniqueById.values()];
  const items = memorySectionLines(sections, sections, 'prompt');
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
  // 行で扱う（UTF-16 の code unit で切らない）: 見出しには絵文字（⚠️ / 🎯）が含まれ、サロゲートペアが割れた壊れた文字を文脈へ載せうるため。行が移動しただけなら変わっていない側に数える: カードは索引で、位置まで見ると節を1つ並べ替えただけで全体が差分に出るため
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
// 文書は消さず、落とすのは節の目次と要旨の全文だけにする: premise はカードが切られても見出しは必ず残るという `renderMemoryTocOmission` の名乗りを破らない唯一の形のため
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

interface RenderMemoryDocumentsOptions {
  // 型は slug の集合ではなく文書そのもの: 循環の検出（`detectCycle`）が記憶の全体を辿るには、在否だけでなく parent（frontmatter）まで引ける必要があるため
  presentInMemory?: readonly MemoryPart[];
  seenContent?: ReadonlyMap<string, string>;
}

// リテラルで書き散らさない: この区切りが予算の計算に入り、繋ぐ側と数える側で別のリテラルを持つと蓋が予算をわずかに超えて通るため
const MEMORY_SECTION_JOIN = '\n\n';

function joinMemorySections(...sections: readonly string[]): string {
  return sections.filter((section) => section.length > 0).join(MEMORY_SECTION_JOIN);
}

// premise の本文が消えたのではなく、開く口が別に在る（memory_section_read）: 口を消したらこの載せ方は能力の削除になる
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

// 単位は文字（bytes ではない）: bytes を返すと、self_status で起きた bytes から文字数を割り戻す誤読を再生産するため。premise の文字数は `content.length` ではなく描いた結果の長さで数える: malformed な frontmatter は説明の1行が前に付き、実物より少ない数を名乗ることになるため
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

  // demotedPremise は除外する: 目次そのものが焼かれていないので、「目次が予算で切れている」と名乗ると嘘になるため
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

interface MemoryListingEntry {
  slug: string;
  title: string;
  kind: MemoryDocKind;
  description: string | undefined;
  descriptionFreshness: MemoryDescriptionFreshness;
  parent: string | undefined;
  updatedAt: string;
  createdAt: MemoryCreatedAt;
}

// 上限は件数ではなく文字数で持つ: 件数から出力量を決めると何件で壊れるかが運任せになるため
export function renderMemoryListing(
  entries: readonly MemoryListingEntry[],
  paging?: { total: number; anchor?: string },
): string {
  if (entries.length === 0) return '（記憶はまだ空）';

  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  // 錨は親から切り離して root の先頭に描く: 親が view に在ると錨が子として親の後ろへ回って落ち、同じ cursor が返り続けるため
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
      // 母数は cursor を当てる前の全件を優先する: renderListing が渡す total は今回の view の件数のため
      const whole = paging?.total ?? total;
      const head = `…ほか ${rest} 件は省略（記憶は全 ${whole} 件あり、${shown} 件だけ出した）。`;
      if (paging === undefined) {
        // 続きを取る口が無い呼び手（プロンプトへの焼き込み等）の文言は動かさない
        return head + '狙った文書が出ていなければ memory_read slug=<slug> で直接開けること。';
      }
      // 「最後に出した行の後ろから」にしない: 描く順（木の DFS）と錨の順（slug 昇順）が一致せず行が飛ぶため。落ちた中の最初は entries（view＝ストア順）で取る: JS の文字列比較だと照合順序と食い違ったとき間の文書が飛ぶため
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

// 本文そのものは載せない: 載せるのは見出しの文字列と数だけ（AGENTS.md「秘密の扱い」）
const MEMORY_MISSING_HEADINGS_BUDGET = 600;

// 拾いすぎる側へ倒す: 拾い漏れは本物の見出しが消えたのに「なし」と返ってその場で気づく手段が無いが、拾いすぎは呼び手が余分に1つ確かめて済むため。コードフェンスの中を除外しない: 途中で切れた本文ではフェンスの内外を見誤り、以降の本物の見出しを丸ごと落とすため
// setext 見出しは数えない: `---` が frontmatter の閉じと同じ形で、区別に本文全体の文脈が要るため
function extractMemoryHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split('\n')) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) headings.push(`${match[1]} ${match[2]}`);
  }
  return headings;
}

// 見出しを集合で比べる（多重度を保たない）: 定型の小見出しを何度も使う記憶では、並べ替えや統合のたびに「消えた」が鳴りっぱなしの警報になって読まれなくなるため
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

// 省略分に cursor / offset を案内しない: before は既に上書きされ、消えた見出しの文字列はこの1行の外のどこにも残っていないため
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

// 切れたことをその場で気づけるようにする: 全文再生成で本文が途中で切れても、記憶には控えも履歴も無く突き合わせる相手が居ないため
// append で消えた見出しが常に 0 件なのは、追記が before を行の境界を保ったまま前置きするから: 改行を挟まない連結だと末尾の見出しが追記の1行目と融合し、消えた見出しとして名指しされる
// 単位は文字数で統一する: 日誌の bytes（機械可読な面）と同じ文に混ぜない
export function describeMemoryWriteDiff(before: string | null, after: string): string {
  if (before === null) {
    return `新規作成（${formatMemoryCharCount(after.length)} 文字）。`;
  }
  const delta = after.length - before.length;
  const charLine = `${formatMemoryCharCount(before.length)} → ${formatMemoryCharCount(after.length)} 文字（${formatMemoryCharDelta(delta)}）`;
  return [charLine, describeMemoryHeadingDiff(before, after)].join('\n');
}

// 矢印（`→`）を使わない: `tools.test.ts` の新規作成の歯が `not.toContain('→')` で固定しており、床の遷移は新規作成のときも言うため
function formatMemoryFloorTransition(beforeChars: number, afterChars: number): string {
  const delta = afterChars - beforeChars;
  return (
    `${formatMemoryCharCount(beforeChars)} 文字から ${formatMemoryCharCount(afterChars)} 文字へ` +
    `（${formatMemoryCharDelta(delta)}）`
  );
}

// 「区分が変わった」の語を使い回さない: type を変えていない呼び出しでも毎回その文字列を返し、tools.test.ts の `not.toContain('区分が変わった')` の歯を撃つため
// 最大の premise・3手順を fact の新規作成や created === false の枝へ足さない: 毎回出る側は読み飛ばされ、強くしている理由（premise の新規作成は稀）が失われるため
// 件数に予算を掛けない: 最大でも数件の軸に予算を掛けると、いちばん言うべき張り付いた文書の名前が落ちる恐れのほうが大きいため
export function describeMemoryFloor(input: {
  before: MemoryFloor;
  after: MemoryFloor;
  slug: string;
  kind: MemoryDocKind;
  created: boolean;
}): string {
  const { before, after, slug, kind, created } = input;
  const transition = formatMemoryFloorTransition(before.totalChars, after.totalChars);
  // 噛んでいない回は1文字も出さない: 毎回付けると、本当に噛んだときの目印が効かなくなるため
  const demotedNote =
    after.demotedPremiseDocs === 0
      ? ''
      : `⚠️ premise のカードは束ねた予算 ${formatMemoryCharCount(MEMORY_PREMISE_CARD_BUDGET)} 文字に当たっていて、` +
        `${formatMemoryCharCount(after.demotedPremiseDocs)} 件が1行に落ちている。` +
        '⟹ **この増減は蓋が効いた後の値である**（premise を足しても、別のカードが落ちて釣り合う）。' +
        '落ちた文書の名前と直し方は焼き込みの断り書きに在る。';

  // `input.slug` では引かない: `memory_section_move` は移し先の視点で slug を渡すので、張り付いている移動元を一度も名乗れなくなるため
  const beforeOutlineFits = new Map(before.outlineSaturatedPremise.map((fit) => [fit.slug, fit]));
  const afterOutlineFits = new Map(after.outlineSaturatedPremise.map((fit) => [fit.slug, fit]));
  const outlineTouchedSlugs = [
    ...new Set([...beforeOutlineFits.keys(), ...afterOutlineFits.keys()]),
  ].sort((a, b) => a.localeCompare(b));
  // 並びは slug 昇順で固定する: 呼び手の順に依存させると出力の並びが動き、歯が不安定になるため
  const outlineSaturationNotes: string[] = [];
  for (const outlineSlug of outlineTouchedSlugs) {
    const beforeFit = beforeOutlineFits.get(outlineSlug);
    const afterFit = afterOutlineFits.get(outlineSlug);
    if (afterFit !== undefined) {
      if (beforeFit !== undefined) {
        // 数が1つも変わっていなければ名乗らない: 無関係な文書へ書いたターンで、他の張り付いた文書の名前が毎回出るのを防ぐため
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
        outlineSaturationNotes.push(
          `⚠️ この書き込みで ${outlineSlug} の節の目次が1文書あたりの予算 ${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字を越えた（全 ${formatMemoryCharCount(afterFit.total)} 節のうち ${formatMemoryCharCount(afterFit.shown)} 節しか焼き込みに載らなくなり、${formatMemoryCharCount(afterFit.rest)} 節が落ちた）。⟹ **この増分は揺れではなく本物である**——省略の断り書きがまるごと生えたぶんを含む。ここから先は、節を移しても ${formatMemoryCharCount(afterFit.rest)} 節を移し切るまで床はほとんど動かない。`,
        );
      }
    } else if (beforeFit !== undefined) {
      // この先どう動くかは言わない: indexed / fact へ移った回には偽になるため
      outlineSaturationNotes.push(
        `⭐ この書き込みで ${outlineSlug} の節の目次は、1文書あたりの予算 ${formatMemoryCharCount(MEMORY_PROMPT_OUTLINE_BUDGET)} 文字で切られなくなった。⟹ **省略の断り書きごと床から落ちた**——目次から落ちている節は、もう無い。⚠️ この先どう動くかはこの行では言えない（予算に収まったのか、premise ではなくなった（indexed / fact）のか、消えたのかを区別していない——後の2つでは節の目次そのものが焼かれないので、節を移しても床は動かない）。`,
      );
    }
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

// 見込みの行に添える予測文。意味は3点: 予測であって実測ではない／「他に何も変わらなければ」の前提／書き込みごとの数は単純に合算しない
// 実測の取り方は名指さない: 載る量を測る道具は無く、memory_list は一覧であって再注入量の実測ではないため
export const MEMORY_REINJECTION_ESTIMATE_NOTE =
  '⚠️ 予測であって実測ではない（他に何も変わらなければ。単純に合算しないこと）。';

// 2文書を別々に render して足さない:区切り文字のぶん実物より少なく出るため、まとめて1回 render した単一の合計を返す
// memoryAfter を必須にする: 省略できる形にすると、渡し忘れが黙って「見つからない」寄りの短い数へ倒れるため。ここでストアを読み直さない: 呼び手が既に手元に持っているため
// memoryAfter が空でも投げない: 書き込みの成功後に呼ぶので、投げると記憶は書けているのに応答がエラーになり、二重書きを誘発するため
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
  // ラベルを別の判定で作らない: 判定を2本に割ると、片方だけ直したときに内訳が黙って嘘をつくため
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
    MEMORY_REINJECTION_ESTIMATE_NOTE,
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

// 閾値を置かない: 「畳め」「危ない」に相当する語は使わず、判断はクローンが下すため
// 引けないときも黙って0や現在値へ倒さない: どちらの数かで意味が変わるので、現在値であることを文言に明記する
// delta === 0 のとき増えたと読める文言を出さない: 0 に `+` を付けた数を「増える」に埋め込むと変化が無いのに増加の文に読めるため
export function describeMemorySessionDelta(input: {
  afterChars: number;
  injectedMemoryChars: number | null;
}): string {
  const { afterChars, injectedMemoryChars } = input;

  if (injectedMemoryChars === null) {
    return (
      `いまの記憶の総量（現在値）: ${formatMemoryCharCount(afterChars)} 文字。` +
      ' ⚠️ セッション構築時点の値（`self_status` が「システムプロンプトへ焼き込んだ' +
      '記憶の文字数」として出す数）がこの呼び出しからは引けなかったため、' +
      'これはセッション構築時点との差ではなく現在値である。'
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

// 一覧の上限は件数ではなく文字数で持つ: 件数 × 字数の掛け算の見落としを避けるため。閾値を置かず畳むことも勧めない: 判断はクローンが下すため
export const MEMORY_PREMISE_RANKING_BUDGET = 2_000;

export function describeMemoryPremiseRanking(documents: readonly MemoryPart[]): string {
  const { premiseParts } = buildMemoryDocumentSections(documents);
  if (premiseParts.length === 0) {
    return 'premise の大きさの順位: いま premise はまだ無い。';
  }

  const ranked = premiseParts
    .map((part) => ({ slug: part.slug, chars: renderPremisePart(part).length }))
    // 同数なら slug 昇順: 同数の並びが呼ぶたびに入れ替わると、変わっていないのに差分に見えるため
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

// 「畳め」を言わず閾値を置かない: 判断（どれをどう割るか）はクローンが下すため
export const MEMORY_TIDY_TARGETS_BUDGET = 3_000;

export function describeMemoryTidyTargets(documents: readonly MemoryPart[]): string {
  const { premiseParts } = buildMemoryDocumentSections(documents);

  const targets: string[] = [];
  for (const part of premiseParts) {
    const frontmatter = parseMemoryFrontmatter(part.content);
    const description =
      (frontmatter.kind === 'parsed' ? frontmatter.description : undefined)?.trim() ?? '';
    const { sections } = scanMemorySections(part.content);
    const outlineChars = memorySectionLines(sections, sections, 'prompt').join('\n').length;

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

export const MEMORY_OUTLINE_BUDGET = 8_000;

// `side` を窓（オフセット）にしない: 予算は文字数なので何節入るかは見出しの長さで動き、末尾の N 節を添字で当てる材料が呼び手の手元に無いため
export const MEMORY_OUTLINE_SIDES = ['head', 'tail'] as const;

type MemoryOutlineSide = (typeof MEMORY_OUTLINE_SIDES)[number];

// 値を定数から組み立てる: 文字列へ直書きすると値が動いたときに断り書きのほうが嘘をつくため。memory_outline の応答を「目次」と呼ばない: 目次は3つの別のものを指し、予算の値の取り違えの発端だったため。`sibling` が値の一致を直接比較する: どちらかの値だけが動いたときに嘘の一致を言い続けないため
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
  // family は sibling の分岐と独立させて必ず出す: 分岐の中に書くとその分岐が選ばれたときにしか出ない非対称になるため
  const family =
    `そして ${value} は「1回のツール応答に何文字載せるか」（MCP の出力上限）という理由で` +
    '道具の応答を切る予算に共通して使われている値であり、この数字だけではどの予算かは決まらない' +
    '——同じ理由で同じ値を持つ予算が他にもある。';
  return `${scope} ${sibling} ${family}`;
}

interface MemoryOutlineOptions {
  side?: MemoryOutlineSide;
  q?: string;
  offset?: number;
}

// 正規表現として解釈しない: メタ文字を含んでいても、その文字どおりの並びとしてしか一致しないよう `includes` に渡すため
function filterMemorySectionsByHeading(
  sections: readonly MemorySection[],
  q: string,
): MemorySection[] {
  const needle = q.toLowerCase();
  return sections.filter((section) => section.heading.toLowerCase().includes(needle));
}

// 本文は1文字も出さず、frontmatter の行も出さない: 出るのは節id・見出し行・文字数だけ（`memory_delete` が本文を日誌へ写さない線と同じ）
export function renderMemoryOutline(
  sections: readonly MemorySection[],
  options: MemoryOutlineOptions = {},
): string {
  if (sections.length === 0) {
    return (
      '節が1つも無い（見出しが1つも無いか、最初の見出しより前の前書きしか無い）。' +
      '前書きは節ではないので memory_section_move では動かせない。'
    );
  }

  const side = options.side ?? 'head';
  const { q, offset } = options;
  // 絞り込み後の節ではなく文書の全節で測る: 焼き込みが載せるのは文書の全節の目次のため。超えていなければ空で、行ごと出さない
  const overflowNote = renderPremiseOutlineOverflowNote(sections);

  if (q === undefined && offset === undefined) {
    const items = memorySectionLines(sections);
    // どちら側を落としたかを言う: 「N 節省略」だけだと続きの取り方を間違えるため
    // tail は `renderListingFromEnd` を通すだけにする: 向きが違うだけの予算のループがあちらに既に在るため
    const render = side === 'tail' ? renderListingFromEnd : renderListing;
    const budgetNote = renderMemoryOutlineBudgetNote();
    const listing = render(items, {
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
    return overflowNote === '' ? listing : `${overflowNote}\n${listing}`;
  }

  let pool = sections;
  let queryHeader = '';
  if (q !== undefined) {
    const matched = filterMemorySectionsByHeading(sections, q);
    if (matched.length === 0) {
      // 一致0件と、一致はあるが予算で切れた場合を混ぜない: 文言を変えれば当たるのか、offset で窓をずらすしかないのかが違うため
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

  // offset を渡すと `side` を見ない: 窓を開いた後で詰める向きが変わると、窓の大きさぶんずつ進めれば有限回で全節に届くという保証が崩れるため
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
    const items = memorySectionLines(windowed, sections);
    const { lines, shown } = fillListingBudget(items, MEMORY_OUTLINE_BUDGET, false);
    const endIndex = offset + shown;
    const more = endIndex < pool.length;
    const rangeLine =
      `${formatMemoryCharCount(offset + 1)}〜${formatMemoryCharCount(endIndex)} 節目 / ` +
      `${scopeLabel} ${formatMemoryCharCount(pool.length)} 節のうち ${formatMemoryCharCount(shown)} 節を出した。`;
    const continuationLine = more
      ? `続きが在る。次は offset=${endIndex} で呼ぶこと` +
        '（窓の大きさぶんずつ進めれば、有限回で全節に届く）。'
      : '続きは無い（最後まで出した）。';
    return [queryHeader, rangeLine, continuationLine, overflowNote, budgetNote, ...lines]
      .filter((line) => line !== '')
      .join('\n');
  }

  const items = memorySectionLines(pool, sections);
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
  return [`${queryHeader}${shownLabel}${remainderNote}`, overflowNote, budgetNote, ...lines]
    .filter((line) => line !== '')
    .join('\n');
}

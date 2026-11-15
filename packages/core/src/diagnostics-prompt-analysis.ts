// `diagnostics pull` が保存した `prompt.json`（`GET /self/prompt` の応答）を読んで、クローンが毎ターン払っているプロンプトの大きさを並べる純関数。
// 読み取りのみ・通信なし。表にするのは `diagnostics-prompt-format.ts`、入力の検査は `diagnostics-prompt-input.ts`。
// 文字数とトークンを混ぜない: 文字数は `HeuristicChars`、トークンは SDK が測った `ExactTokens`（`contextUsage` 由来）だけ。文字数からトークンへの換算はしない。
// 取れない軸に 0 を置かない（`state: 'unavailable'` と理由）。能力（道具・MCP）を減らす候補は出さない: 出すのは大きさの順と、定義を短くできる余地の所在まで。
import { compareCodeUnits } from './code-unit-order.js';
import { summarizeContextCategories } from './context-usage.js';
import type { PromptInput, PromptJson } from './diagnostics-prompt-input.js';
import { MCP_SERVER_NAME } from './mcp-server-name.js';
import { foldMcpToolsByServer } from './mcp-tools-by-server.js';
import { exactTokens, heuristicChars, type ExactTokens, type HeuristicChars } from './quantity.js';

export interface PromptUnavailable {
  state: 'unavailable';
  reason: string;
}

/** 行頭の `# ` の見出しで割った節。`heading` が null の節は、最初の見出しより前の導入部 */
export interface PromptSystemSection {
  heading: string | null;
  chars: HeuristicChars;
  share: number | null;
}

export interface PromptSdkTokenRow {
  name: string;
  tokens: ExactTokens;
  share: number | null;
}

export interface PromptMemoryIndexReconciliation {
  state: 'read';
  sectionHeading: string;
  sectionChars: HeuristicChars;
  indexCharsSum: HeuristicChars;
  /** 索引の合計 ÷ 節の文字数 */
  indexShareOfSection: number | null;
  /** 節 − 索引の合計。負なら索引の合計のほうが節より大きい（合わない）。丸めない */
  difference: number;
  /** 索引の長さが取れなかった文書（`indexChars` が null）の数。合計に入っていない */
  documentsWithoutIndexChars: number;
  note: string;
}

export interface PromptSystemPromptSection {
  state: 'read';
  /** 応答の `systemPrompt.chars` */
  chars: HeuristicChars;
  sections:
    | {
        state: 'read';
        textChars: HeuristicChars;
        /** `text` の長さが `chars` と違う（秘密走査の伏せ字で長さが変わりうる）。割合は `textChars` が分母 */
        textCharsDiffersFromChars: boolean;
        rows: PromptSystemSection[];
      }
    | PromptUnavailable;
  memoryIndex: PromptMemoryIndexReconciliation | PromptUnavailable;
  sdkSections:
    | {
        state: 'read';
        total: ExactTokens;
        rows: PromptSdkTokenRow[];
        omitted: number;
      }
    | PromptUnavailable;
}

export interface PromptMemoryDocumentRow {
  slug: string;
  type: string;
  indexChars: HeuristicChars;
  shareOfIndex: number | null;
  /** 文書の本文の文字数 */
  chars: HeuristicChars;
  /** 索引の断片 ÷ 本文 */
  indexOverBody: number | null;
  /** 要旨（description）の文字数。無ければ null */
  descriptionChars: HeuristicChars | null;
}

export interface PromptMemoryUnindexedRow {
  slug: string;
  type: string;
  chars: HeuristicChars;
  /** true = 索引から省かれた。false = 索引の中での長さを取れなかった */
  omitted: boolean;
  indexNote: string | null;
}

export interface PromptMemorySection {
  state: 'read';
  documents: number;
  indexCharsSum: HeuristicChars;
  rows: PromptMemoryDocumentRow[];
  unindexed: PromptMemoryUnindexedRow[];
  /** 載せる件数の上限で切り捨てた文書の数（そもそも一覧に無い） */
  omittedDocuments: number;
  memoryFiles:
    | {
        state: 'read';
        total: ExactTokens;
        rows: Array<{ path: string; type: string | null; tokens: ExactTokens }>;
        omitted: number;
      }
    | PromptUnavailable;
}

export interface PromptToolRow {
  name: string;
  descriptionChars: HeuristicChars;
  inputSchemaChars: HeuristicChars;
  totalChars: HeuristicChars;
  shareOfTotal: number | null;
  /** SDK が測ったトークン。`contextUsage.mcpTools` に対応する行が無ければ null */
  tokens: ExactTokens | null;
}

export interface PromptToolsSection {
  state: 'read';
  count: number;
  totalChars: HeuristicChars;
  rows: PromptToolRow[];
  tokens:
    | {
        state: 'read';
        /** 道具の名前が `contextUsage.mcpTools` の行と対応した本数 */
        matched: number;
        unmatchedTools: string[];
        /** クローン自身の MCP サーバ名の行のうち、どの道具とも名前が対応しなかったもの */
        unmatchedCloneServerRows: { count: number; tokens: ExactTokens };
        omittedRows: number;
      }
    | PromptUnavailable;
}

export interface PromptExternalServerRow {
  name: string;
  type: string | null;
  /** `externalMcpServers` に登録がある名前か（無い名前の行は、登録の写しと食い違う） */
  registered: boolean;
  tools: number;
  tokens: ExactTokens;
}

export interface PromptExternalMcpSection {
  state: 'read';
  servers: { state: 'read'; rows: Array<{ name: string; type: string }> } | PromptUnavailable;
  live:
    | { state: 'read'; at: string; failed: string[]; retained: string[] }
    | { state: 'none'; reason: string };
  tokens:
    | {
        state: 'read';
        total: ExactTokens;
        byServer: PromptExternalServerRow[];
        /** 登録はあるが `mcpTools` に行が無いサーバ */
        registeredWithoutRows: string[];
        topTools: Array<{
          name: string;
          serverName: string | null;
          tokens: ExactTokens;
          isLoaded: boolean | null;
        }>;
        omittedRows: number;
      }
    | PromptUnavailable;
}

export interface PromptBuiltinSection {
  state: 'read';
  reason: string;
  systemTools:
    | {
        state: 'read';
        total: ExactTokens;
        rows: Array<{ name: string; tokens: ExactTokens }>;
        omitted: number;
      }
    | PromptUnavailable;
  deferredBuiltinTools:
    | {
        state: 'read';
        total: ExactTokens;
        rows: Array<{ name: string; tokens: ExactTokens; isLoaded: boolean }>;
        omitted: number;
      }
    | PromptUnavailable;
}

export interface PromptOccupancyBucket {
  tokens: ExactTokens;
  count: number;
}

export interface PromptOccupancySection {
  state: 'read';
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  /** 毎ターン払っている量。free・buffer・deferred・分類できない行を混ぜない */
  used: PromptOccupancyBucket & { rows: PromptSdkTokenRow[] };
  free: PromptOccupancyBucket;
  buffer: PromptOccupancyBucket;
  deferred: PromptOccupancyBucket;
  unclassified: PromptOccupancyBucket;
  omittedRows: number;
}

export type PromptCandidateCharsKind =
  'system-section' | 'memory-index' | 'memory-index-other' | 'clone-tool';

export interface PromptCharsCandidate {
  kind: PromptCandidateCharsKind;
  label: string;
  size: HeuristicChars;
  /** 分母は candidates.chars.baseline（システムプロンプトの文字数 + 道具の定義の文字数） */
  share: number | null;
  /** 文字数の出所: `text-counted` = プロンプト本文から数えた / `server-chars` = daemon が応答に書いた文字数 */
  basis: 'text-counted' | 'server-chars';
  where: string;
}

export type PromptCandidateTokensKind =
  | 'sdk-section'
  | 'memory-file'
  | 'clone-tool'
  | 'external-mcp'
  | 'builtin-system-tool'
  | 'builtin-deferred-tool';

export interface PromptTokensCandidate {
  kind: PromptCandidateTokensKind;
  label: string;
  size: ExactTokens;
  /** 分母は candidates.tokens.baseline（contextUsage の used の合計） */
  share: number | null;
  basis: 'sdk-tokens';
  where: string;
}

export interface PromptCandidates {
  /** 候補は「定義を短くできる余地」の大きい順であって、能力（道具・MCP）を減らす候補ではない */
  chars:
    | {
        state: 'read';
        baseline: HeuristicChars;
        baselineNote: string;
        rows: PromptCharsCandidate[];
        total: number;
      }
    | PromptUnavailable;
  tokens:
    | {
        state: 'read';
        baseline: ExactTokens | null;
        baselineNote: string;
        rows: PromptTokensCandidate[];
        total: number;
        excludedNotLoaded: number;
      }
    | PromptUnavailable;
}

export interface PromptContextUsageAxis {
  axis: string;
  available: boolean;
  reason: string | null;
  /** 上限で切り捨てた行数。取れない軸は null */
  omitted: number | null;
}

export interface PromptCoverage {
  session:
    | { state: 'none'; reason: string }
    | { state: 'failed'; at: string; error: string }
    | {
        state: 'ok';
        builtAt: string;
        model: string;
        resumedFrom: string | null;
        sessionId: string | null;
      };
  pulledAt: string | null;
  /** pull した時刻 − プロンプトが焼かれた時刻。どちらかが無い・読めなければ null */
  ageAtPullMs: number | null;
  ageNote: string;
  full: boolean;
  bodyOmitted: boolean;
  notices: string[];
  secretScan: Array<{ rule: string; count: number }>;
  contextUsage:
    | { state: 'none'; reason: string }
    | { state: 'failed'; at: string; error: string }
    | {
        state: 'ok';
        at: string;
        axes: PromptContextUsageAxis[];
      };
}

export type PromptAnalysis =
  | { state: 'none' | 'unreadable'; reason: string }
  | {
      state: 'read';
      coverage: PromptCoverage;
      systemPrompt: PromptSystemPromptSection | PromptUnavailable;
      memory: PromptMemorySection | PromptUnavailable;
      tools: PromptToolsSection | PromptUnavailable;
      externalMcp: PromptExternalMcpSection | PromptUnavailable;
      builtin: PromptBuiltinSection | PromptUnavailable;
      occupancy: PromptOccupancySection | PromptUnavailable;
      candidates: PromptCandidates;
    };

export interface AnalyzePromptInput {
  input: PromptInput;
  /** `manifest.json` の `pulledAt`。無ければ null */
  pulledAt: string | null;
  topN: number;
  /** 表示する文字列（見出し・slug・道具名・サーバ名・理由）の直前に掛ける伏せ字。必須: 掛け忘れを型で防ぐ */
  redact: (text: string) => string;
}

/** 出力に書く1行。「削除の勧め」ではないことを出力にも置く（AGENTS.md の地雷: 能力の削除・クローンの tools を絞る） */
export const PROMPT_NO_REMOVAL_NOTE = '能力を減らす候補ではなく、定義の簡潔化の候補';

const MEMORY_SECTION_HEADING = '現在の記憶';

const WHERE_SYSTEM_SECTION =
  '`packages/core/src/prompt.ts`／`self.ts` の節の文章（クローンの開発者が短くする）';
const WHERE_MEMORY_DOCUMENT =
  '人間が書き換える記憶の文書（要旨・節の目次を短くする。slug は表のとおり）';
const WHERE_MEMORY_OTHER =
  '`packages/core/src/prompt.ts` の「現在の記憶」の導入文・索引の組み立て（記憶の文書ではない部分）';
const WHERE_CLONE_TOOL = '`packages/core/src/clone-tools-*.ts` の道具の説明・入力スキーマの文章';
const WHERE_EXTERNAL_MCP =
  '人間が登録した MCP（`PUT /mcp-servers`）。道具の説明・スキーマは MCP サーバ側の定義';
const WHERE_BUILTIN = '変えられない（SDK 組み込み。説明・スキーマは SDK が返さない）';
const WHERE_SDK_SECTION =
  'SDK が名前つきで測った節。クローンが足した節なら `prompt.ts`／`self.ts`、SDK 自身の節なら変えられない（名前から断定しない）';
const WHERE_MEMORY_FILE = '人間が書く指示ファイル（CLAUDE.md など。パスは表のとおり）';

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const sumChars = (values: readonly number[]): HeuristicChars => heuristicChars(sum(values));
const sumTokens = (values: readonly number[]): ExactTokens => exactTokens(sum(values));

const unavailable = (reason: string): PromptUnavailable => ({ state: 'unavailable', reason });

/**
 * システムプロンプトを、行頭の `# ` の見出し（`prompt.ts` の構成）で割る。コードの囲み（```）の中の行は見出しにしない。
 * 節の文字数の合計は `text.length` に一致する（見出しの行も節に数える）。
 */
export function splitSystemPromptSections(
  text: string,
): Array<{ heading: string | null; chars: number }> {
  const lines = text.split('\n');
  const sections: Array<{ heading: string | null; chars: number }> = [];
  let inFence = false;
  let current: { heading: string | null; chars: number } = { heading: null, chars: 0 };
  lines.forEach((line, index) => {
    const lineChars = line.length + (index < lines.length - 1 ? 1 : 0);
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence && line.startsWith('# ') ? line.slice(2).trim() : null;
    if (heading !== null && !/^\s*```/.test(line)) {
      if (current.heading !== null || current.chars > 0) sections.push(current);
      current = { heading, chars: 0 };
    }
    current.chars += lineChars;
  });
  if (current.heading !== null || current.chars > 0) sections.push(current);
  return sections;
}

type UsageOk = Extract<NonNullable<PromptJson['contextUsage']>, { ok: true }>;

const bySizeThenName = <T extends { size: number; label: string }>(a: T, b: T): number =>
  b.size - a.size || compareCodeUnits(a.label, b.label);

export function analyzePrompt(options: AnalyzePromptInput): PromptAnalysis {
  const { input, topN } = options;
  if (input.state !== 'read') return { state: input.state, reason: options.redact(input.reason) };
  const body = input.body;
  // 伏せ字を掛けた後に切り、制御文字を除く（入力の自由文が出力へ紛れないように）
  const text = (value: string, limit = 120): string => {
    // eslint-disable-next-line no-control-regex
    const cleaned = options.redact(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
    return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
  };
  const nullable = (value: string | null, limit = 120): string | null =>
    value === null ? null : text(value, limit);

  const usage: UsageOk | null =
    body.contextUsage !== null && body.contextUsage.ok ? body.contextUsage : null;
  const usageUnavailableReason =
    body.contextUsage === null
      ? 'contextUsage が null（今のセッションでまだターン境界を観測していない）'
      : body.contextUsage.ok
        ? ''
        : `contextUsage が失敗の回（${text(body.contextUsage.at)}。理由: ${text(body.contextUsage.error, 300)}）`;

  const axisOf = <T>(
    axis:
      | { available: true; value: { rows: T[]; omitted: number } }
      | { available: false; reason: string },
  ): { state: 'read'; rows: T[]; omitted: number } | PromptUnavailable =>
    axis.available
      ? { state: 'read', rows: axis.value.rows, omitted: axis.value.omitted }
      : unavailable(`SDK が返さなかった（${text(axis.reason, 300)}）`);

  const coverage = buildCoverage(body, options.pulledAt, usage, text, nullable);
  const system = buildSystemPrompt(body, usage, usageUnavailableReason, text, axisOf);
  const memory = buildMemory(body, usage, usageUnavailableReason, text, axisOf);
  const tools = buildTools(body, usage, usageUnavailableReason, text, axisOf);
  const externalMcp = buildExternalMcp(body, usage, usageUnavailableReason, topN, text, axisOf);
  const builtin = buildBuiltin(body, usageUnavailableReason, text, axisOf);
  const occupancy = buildOccupancy(usage, usageUnavailableReason, text);
  const candidates: PromptCandidates = {
    chars: charsCandidates({ system, memory, tools, topN }),
    tokens: tokensCandidates({ system, memory, tools, externalMcp, builtin, occupancy, topN }),
  };
  return {
    state: 'read',
    coverage,
    systemPrompt: system,
    memory,
    tools,
    externalMcp,
    builtin,
    occupancy,
    candidates,
  };
}

type Text = (value: string, limit?: number) => string;
type NullableText = (value: string | null, limit?: number) => string | null;
type AxisOf = <T>(
  axis:
    | { available: true; value: { rows: T[]; omitted: number } }
    | { available: false; reason: string },
) => { state: 'read'; rows: T[]; omitted: number } | PromptUnavailable;

function buildCoverage(
  body: PromptJson,
  pulledAt: string | null,
  usage: UsageOk | null,
  text: Text,
  nullable: NullableText,
): PromptCoverage {
  const session: PromptCoverage['session'] =
    body.session === null
      ? {
          state: 'none',
          reason: 'まだセッションが組まれていない（このプロセスで1回もセッションを開いていない）',
        }
      : body.session.ok
        ? {
            state: 'ok',
            builtAt: text(body.session.builtAt),
            model: text(body.session.model),
            resumedFrom: nullable(body.session.resumedFrom),
            sessionId: nullable(body.session.sessionId),
          }
        : { state: 'failed', at: text(body.session.at), error: text(body.session.error, 300) };

  let ageAtPullMs: number | null = null;
  let ageNote: string;
  if (body.session === null || !body.session.ok) {
    ageNote = '取れない（プロンプトが焼かれた時刻 builtAt が無い）';
  } else if (pulledAt === null) {
    ageNote = '取れない（manifest.json の pulledAt が無い）';
  } else {
    const built = Date.parse(body.session.builtAt);
    const pulled = Date.parse(pulledAt);
    if (Number.isNaN(built) || Number.isNaN(pulled)) {
      ageNote = '取れない（builtAt か pulledAt が時刻として読めない）';
    } else {
      ageAtPullMs = pulled - built;
      ageNote =
        ageAtPullMs < 0
          ? 'builtAt が pulledAt より後（時計のずれか、pull の後に焼き直された）'
          : 'pull した時刻 − 焼かれた時刻';
    }
  }

  const contextUsage: PromptCoverage['contextUsage'] =
    body.contextUsage === null
      ? {
          state: 'none',
          reason: 'ターン境界をまだ観測していない（今のセッションで1ターンも終わっていない）',
        }
      : body.contextUsage.ok
        ? {
            state: 'ok',
            at: text(body.contextUsage.at),
            axes: contextUsageAxes(usage, text),
          }
        : {
            state: 'failed',
            at: text(body.contextUsage.at),
            error: text(body.contextUsage.error, 300),
          };

  return {
    session,
    pulledAt: nullable(pulledAt),
    ageAtPullMs,
    ageNote,
    full: body.full,
    bodyOmitted: !body.full,
    notices: body.notice.map((notice) => text(notice, 600)),
    secretScan: body.secretScan.hits.map((hit) => ({ rule: text(hit.rule), count: hit.count })),
    contextUsage,
  };
}

function contextUsageAxes(usage: UsageOk | null, text: Text): PromptContextUsageAxis[] {
  if (usage === null) return [];
  const axes = [
    ['categories', usage.categories],
    ['mcpTools', usage.mcpTools],
    ['systemPromptSections', usage.systemPromptSections],
    ['memoryFiles', usage.memoryFiles],
    ['systemTools', usage.systemTools],
    ['deferredBuiltinTools', usage.deferredBuiltinTools],
  ] as const;
  return axes.map(([axis, value]) =>
    value.available
      ? { axis, available: true, reason: null, omitted: value.value.omitted }
      : { axis, available: false, reason: text(value.reason, 300), omitted: null },
  );
}

function buildSystemPrompt(
  body: PromptJson,
  usage: UsageOk | null,
  usageUnavailableReason: string,
  text: Text,
  axisOf: AxisOf,
): PromptSystemPromptSection | PromptUnavailable {
  if (body.systemPrompt === null) {
    return unavailable(
      'systemPrompt が null（セッションが未取得か、組み立てに失敗した。理由は coverage の notice）',
    );
  }
  const sp = body.systemPrompt;
  const chars = heuristicChars(sp.chars);

  let sections: PromptSystemPromptSection['sections'];
  let memoryIndex: PromptSystemPromptSection['memoryIndex'];
  if (!body.full || sp.text === undefined) {
    const reason = !body.full
      ? '本文が省かれている（full=0）。`pull` は既定で全文を取る'
      : 'full=1 なのに systemPrompt.text が応答に無い';
    sections = unavailable(reason);
    memoryIndex = unavailable(reason);
  } else {
    const textChars = heuristicChars(sp.text.length);
    const split = splitSystemPromptSections(sp.text);
    sections = {
      state: 'read',
      textChars,
      textCharsDiffersFromChars: sp.text.length !== sp.chars,
      rows: split.map((section) => ({
        heading: section.heading === null ? null : text(section.heading, 80),
        chars: heuristicChars(section.chars),
        share: ratio(section.chars, sp.text?.length ?? 0),
      })),
    };
    memoryIndex = reconcileMemoryIndex(body, split);
  }

  const sdk =
    usage === null ? unavailable(usageUnavailableReason) : axisOf(usage.systemPromptSections);
  const sdkSections: PromptSystemPromptSection['sdkSections'] =
    sdk.state === 'unavailable'
      ? sdk
      : (() => {
          const total = sumTokens(sdk.rows.map((row) => row.tokens));
          return {
            state: 'read' as const,
            total,
            omitted: sdk.omitted,
            rows: sdk.rows
              .map((row) => ({
                name: row.name === null ? '(名前なし)' : text(row.name, 80),
                tokens: exactTokens(row.tokens),
                share: ratio(row.tokens, total),
              }))
              .sort((a, b) => b.tokens - a.tokens || compareCodeUnits(a.name, b.name)),
          };
        })();
  return { state: 'read', chars, sections, memoryIndex, sdkSections };
}

function reconcileMemoryIndex(
  body: PromptJson,
  split: Array<{ heading: string | null; chars: number }>,
): PromptMemoryIndexReconciliation | PromptUnavailable {
  if (body.memoryInPrompt === null) {
    return unavailable('memoryInPrompt が null');
  }
  const section = split.find((candidate) => candidate.heading === MEMORY_SECTION_HEADING);
  if (section === undefined) {
    return unavailable(
      `本文に「# ${MEMORY_SECTION_HEADING}」の見出しが無い。prompt.ts の構成が変わったか、本文が別物`,
    );
  }
  const measured = body.memoryInPrompt.documents.flatMap((document) =>
    document.indexChars === null ? [] : [document.indexChars],
  );
  const indexCharsSum = sumChars(measured);
  const difference = section.chars - indexCharsSum;
  const withoutIndex = body.memoryInPrompt.documents.length - measured.length;
  return {
    state: 'read',
    sectionHeading: MEMORY_SECTION_HEADING,
    sectionChars: heuristicChars(section.chars),
    indexCharsSum,
    indexShareOfSection: ratio(indexCharsSum, section.chars),
    difference,
    documentsWithoutIndexChars: withoutIndex,
    note:
      difference < 0
        ? `合わない: 索引の合計が節より ${String(-difference)} 字大きい（本文が伏せ字で縮んだか、版の食い違い）`
        : `その他 ${String(difference)} 字（節の見出し・導入文・断片の区切り・索引の長さが取れなかった文書の分）`,
  };
}

function buildMemory(
  body: PromptJson,
  usage: UsageOk | null,
  usageUnavailableReason: string,
  text: Text,
  axisOf: AxisOf,
): PromptMemorySection | PromptUnavailable {
  if (body.memoryInPrompt === null) {
    return unavailable('memoryInPrompt が null（セッションが未取得か、組み立てに失敗した）');
  }
  const documents = body.memoryInPrompt.documents;
  const indexed = documents.flatMap((document) =>
    document.indexChars === null || document.omitted
      ? []
      : [{ document, indexChars: document.indexChars }],
  );
  const indexCharsSum = sumChars(indexed.map((entry) => entry.indexChars));
  const rows = indexed
    .map(({ document, indexChars }) => ({
      slug: text(document.slug, 80),
      type: text(document.type, 40),
      indexChars: heuristicChars(indexChars),
      shareOfIndex: ratio(indexChars, indexCharsSum),
      chars: heuristicChars(document.chars),
      indexOverBody: ratio(indexChars, document.chars),
      descriptionChars:
        document.description === null ? null : heuristicChars(document.description.length),
    }))
    .sort((a, b) => b.indexChars - a.indexChars || compareCodeUnits(a.slug, b.slug));
  const unindexed = documents
    .filter((document) => document.omitted || document.indexChars === null)
    .map((document) => ({
      slug: text(document.slug, 80),
      type: text(document.type, 40),
      chars: heuristicChars(document.chars),
      omitted: document.omitted,
      indexNote: document.indexNote === null ? null : text(document.indexNote, 300),
    }))
    .sort((a, b) => compareCodeUnits(a.slug, b.slug));

  const files = usage === null ? unavailable(usageUnavailableReason) : axisOf(usage.memoryFiles);
  return {
    state: 'read',
    documents: documents.length,
    indexCharsSum,
    rows,
    unindexed,
    omittedDocuments: body.memoryInPrompt.omittedDocuments,
    memoryFiles:
      files.state === 'unavailable'
        ? files
        : {
            state: 'read',
            total: sumTokens(files.rows.map((row) => row.tokens)),
            omitted: files.omitted,
            rows: files.rows
              .map((row) => ({
                path: row.path === null ? '(パスなし)' : text(row.path, 160),
                type: row.type === null ? null : text(row.type, 40),
                tokens: exactTokens(row.tokens),
              }))
              .sort((a, b) => b.tokens - a.tokens || compareCodeUnits(a.path, b.path)),
          },
  };
}

/** SDK の道具名と、スナップショットの道具名の対応。クローンの道具は `mcp__alteroid__<名前>` で SDK に見える */
const qualifiedCloneToolName = (name: string): string => `mcp__${MCP_SERVER_NAME}__${name}`;

function buildTools(
  body: PromptJson,
  usage: UsageOk | null,
  usageUnavailableReason: string,
  text: Text,
  axisOf: AxisOf,
): PromptToolsSection | PromptUnavailable {
  if (body.tools === null) {
    return unavailable('tools が null（セッションが未取得か、組み立てに失敗した）');
  }
  const mcp = usage === null ? unavailable(usageUnavailableReason) : axisOf(usage.mcpTools);
  const tokenByName = new Map<string, number>();
  if (mcp.state === 'read') {
    for (const row of mcp.rows) {
      if (row.name !== null && !tokenByName.has(row.name)) tokenByName.set(row.name, row.tokens);
    }
  }
  const totals = body.tools.map((tool) => tool.descriptionChars + tool.inputSchemaChars);
  const totalChars = sumChars(totals);
  const matchedKeys = new Set<string>();
  const unmatchedTools: string[] = [];
  const rows = body.tools
    .map((tool, index) => {
      const key = [tool.name, qualifiedCloneToolName(tool.name)].find((name) =>
        tokenByName.has(name),
      );
      const name = text(tool.name, 80);
      if (key === undefined) unmatchedTools.push(name);
      else matchedKeys.add(key);
      return {
        name,
        descriptionChars: heuristicChars(tool.descriptionChars),
        inputSchemaChars: heuristicChars(tool.inputSchemaChars),
        totalChars: heuristicChars(totals[index] ?? 0),
        shareOfTotal: ratio(totals[index] ?? 0, totalChars),
        tokens: key === undefined ? null : exactTokens(tokenByName.get(key) ?? 0),
      };
    })
    .sort((a, b) => b.totalChars - a.totalChars || compareCodeUnits(a.name, b.name));
  const unmatchedCloneRows =
    mcp.state === 'read'
      ? mcp.rows.filter(
          (row) =>
            row.serverName === MCP_SERVER_NAME && !(row.name !== null && matchedKeys.has(row.name)),
        )
      : [];
  return {
    state: 'read',
    count: body.tools.length,
    totalChars,
    rows,
    tokens:
      mcp.state === 'unavailable'
        ? mcp
        : {
            state: 'read',
            matched: body.tools.length - unmatchedTools.length,
            unmatchedTools: unmatchedTools.sort(compareCodeUnits),
            unmatchedCloneServerRows: {
              count: unmatchedCloneRows.length,
              tokens: sumTokens(unmatchedCloneRows.map((row) => row.tokens)),
            },
            omittedRows: mcp.omitted,
          },
  };
}

function buildExternalMcp(
  body: PromptJson,
  usage: UsageOk | null,
  usageUnavailableReason: string,
  topN: number,
  text: Text,
  axisOf: AxisOf,
): PromptExternalMcpSection | PromptUnavailable {
  if (body.externalMcpServers === null) {
    return unavailable('externalMcpServers が null（セッションが未取得か、組み立てに失敗した）');
  }
  const registered = body.externalMcpServers.map((server) => ({
    name: text(server.name, 80),
    type: text(server.type, 20),
  }));
  const live = body.externalMcpServersLive;
  const mcp = usage === null ? unavailable(usageUnavailableReason) : axisOf(usage.mcpTools);

  let tokens: PromptExternalMcpSection['tokens'];
  if (mcp.state === 'unavailable') {
    tokens = mcp;
  } else {
    // クローン自身の in-process 道具（サーバ名 alteroid）は外部 MCP に数えない
    const external = mcp.rows.filter((row) => row.serverName !== MCP_SERVER_NAME);
    const folded = foldMcpToolsByServer(
      external.map((row) => ({
        ...(row.serverName === null ? {} : { serverName: text(row.serverName, 80) }),
        tokens: row.tokens,
      })),
    );
    const typeByName = new Map(registered.map((server) => [server.name, server.type]));
    const foldedNames = new Set(folded.map((row) => row.name));
    tokens = {
      state: 'read',
      total: sumTokens(external.map((row) => row.tokens)),
      byServer: folded.map((row) => ({
        name: row.name,
        type: typeByName.get(row.name) ?? null,
        registered: typeByName.has(row.name),
        tools: row.count,
        tokens: exactTokens(row.tokens),
      })),
      registeredWithoutRows: registered
        .filter((server) => !foldedNames.has(server.name))
        .map((server) => server.name),
      topTools: external
        .map((row) => ({
          name: row.name === null ? '(名前なし)' : text(row.name, 80),
          serverName: row.serverName === null ? null : text(row.serverName, 80),
          tokens: exactTokens(row.tokens),
          isLoaded: row.isLoaded ?? null,
        }))
        .sort((a, b) => b.tokens - a.tokens || compareCodeUnits(a.name, b.name))
        .slice(0, topN),
      omittedRows: mcp.omitted,
    };
  }
  return {
    state: 'read',
    servers: { state: 'read', rows: registered },
    live:
      live === null || live === undefined
        ? {
            state: 'none',
            reason: '走行中の差し替えはまだ無い（登録はセッション開始時の値）',
          }
        : {
            state: 'read',
            at: text(live.at),
            failed: live.failed.map((name) => text(name, 80)),
            retained: live.retained.map((name) => text(name, 80)),
          },
    tokens,
  };
}

function buildBuiltin(
  body: PromptJson,
  usageUnavailableReason: string,
  text: Text,
  axisOf: AxisOf,
): PromptBuiltinSection | PromptUnavailable {
  if (body.builtinTools === null) {
    return unavailable('builtinTools が null（セッションが未取得か、組み立てに失敗した）');
  }
  const builtin = body.builtinTools;
  const missing = usageUnavailableReason || 'contextUsage から引く値が応答に無い';
  const system = builtin.systemTools === null ? unavailable(missing) : axisOf(builtin.systemTools);
  const deferred =
    builtin.deferredBuiltinTools === null
      ? unavailable(missing)
      : axisOf(builtin.deferredBuiltinTools);
  return {
    state: 'read',
    reason: text(builtin.reason, 400),
    systemTools:
      system.state === 'unavailable'
        ? system
        : {
            state: 'read',
            total: sumTokens(system.rows.map((row) => row.tokens)),
            omitted: system.omitted,
            rows: system.rows
              .map((row) => ({ name: text(row.name, 80), tokens: exactTokens(row.tokens) }))
              .sort((a, b) => b.tokens - a.tokens || compareCodeUnits(a.name, b.name)),
          },
    deferredBuiltinTools:
      deferred.state === 'unavailable'
        ? deferred
        : {
            state: 'read',
            total: sumTokens(deferred.rows.map((row) => row.tokens)),
            omitted: deferred.omitted,
            rows: deferred.rows
              .map((row) => ({
                name: text(row.name, 80),
                tokens: exactTokens(row.tokens),
                isLoaded: row.isLoaded,
              }))
              .sort((a, b) => b.tokens - a.tokens || compareCodeUnits(a.name, b.name)),
          },
  };
}

function buildOccupancy(
  usage: UsageOk | null,
  usageUnavailableReason: string,
  text: Text,
): PromptOccupancySection | PromptUnavailable {
  if (usage === null) return unavailable(usageUnavailableReason);
  if (!usage.categories.available) {
    return unavailable(`SDK が返さなかった（${text(usage.categories.reason, 300)}）`);
  }
  const { rows, omitted } = usage.categories.value;
  const summary = summarizeContextCategories(rows);
  const usedRows = rows.filter((row) => row.kind === 'used');
  return {
    state: 'read',
    totalTokens: usage.totalTokens,
    rawMaxTokens: usage.rawMaxTokens,
    percentage: usage.percentage,
    used: {
      ...summary.used,
      rows: usedRows
        .map((row) => ({
          name: text(row.name, 80),
          tokens: exactTokens(row.tokens),
          share: ratio(row.tokens, summary.used.tokens),
        }))
        .sort((a, b) => b.tokens - a.tokens || compareCodeUnits(a.name, b.name)),
    },
    free: summary.free,
    buffer: summary.buffer,
    deferred: summary.deferred,
    unclassified: summary.unclassified,
    omittedRows: omitted,
  };
}

function charsCandidates(input: {
  system: PromptSystemPromptSection | PromptUnavailable;
  memory: PromptMemorySection | PromptUnavailable;
  tools: PromptToolsSection | PromptUnavailable;
  topN: number;
}): PromptCandidates['chars'] {
  const { system, memory, tools, topN } = input;
  if (
    system.state === 'unavailable' &&
    memory.state === 'unavailable' &&
    tools.state === 'unavailable'
  ) {
    return unavailable(
      '文字数で測れるもの（システムプロンプト・記憶の索引・道具の定義）が1つも取れない',
    );
  }
  const rows: PromptCharsCandidate[] = [];
  // システムプロンプトの文字数が分母。記憶の索引はその中に含まれる（足し算にしない）
  const systemChars =
    system.state === 'read'
      ? system.sections.state === 'read'
        ? system.sections.textChars
        : system.chars
      : heuristicChars(0);
  const toolsChars = tools.state === 'read' ? tools.totalChars : heuristicChars(0);
  const baseline = heuristicChars(systemChars + toolsChars);
  const add = (
    kind: PromptCandidateCharsKind,
    label: string,
    size: HeuristicChars,
    basis: PromptCharsCandidate['basis'],
    where: string,
  ): void => {
    rows.push({ kind, label, size, share: ratio(size, baseline), basis, where });
  };

  // 記憶の索引の文書ごとの行を足してよいのは、システムプロンプトの行が「索引の分を除いた形」に分けられているときだけ（二重に数えない）
  let documentsPartitioned = false;
  if (system.state === 'read' && system.sections.state === 'read') {
    const splitMemory = system.memoryIndex.state === 'read' && system.memoryIndex.difference >= 0;
    for (const section of system.sections.rows) {
      // 記憶の節は、索引の文書ごとの行と「それ以外」の行に分けて数える
      if (splitMemory && section.heading === MEMORY_SECTION_HEADING) continue;
      add(
        'system-section',
        `システムプロンプト「${section.heading === null ? '導入' : section.heading}」`,
        section.chars,
        'text-counted',
        WHERE_SYSTEM_SECTION,
      );
    }
    if (system.memoryIndex.state === 'read' && splitMemory) {
      documentsPartitioned = true;
      add(
        'memory-index-other',
        `システムプロンプト「${MEMORY_SECTION_HEADING}」のうち索引の文書以外`,
        heuristicChars(system.memoryIndex.difference),
        'text-counted',
        WHERE_MEMORY_OTHER,
      );
    }
  } else if (system.state === 'read') {
    // 本文が省かれている: 節ごとは取れない。索引の合計が全体に収まるなら「全体 − 索引の合計」を1行にして、索引は文書ごとに足す
    const indexSum = memory.state === 'read' ? memory.indexCharsSum : null;
    if (indexSum !== null && indexSum <= system.chars) {
      documentsPartitioned = true;
      add(
        'system-section',
        'システムプロンプトのうち記憶の索引以外（節ごとは取れない。本文が省かれている）',
        heuristicChars(system.chars - indexSum),
        'server-chars',
        WHERE_SYSTEM_SECTION,
      );
    } else {
      add(
        'system-section',
        'システムプロンプト全体（節ごとは取れない。本文が省かれている）',
        system.chars,
        'server-chars',
        WHERE_SYSTEM_SECTION,
      );
    }
  }

  if (memory.state === 'read' && documentsPartitioned) {
    for (const row of memory.rows) {
      add(
        'memory-index',
        `記憶の索引「${row.slug}」（${row.type}）`,
        row.indexChars,
        'server-chars',
        `${WHERE_MEMORY_DOCUMENT}`,
      );
    }
  }
  if (tools.state === 'read') {
    for (const row of tools.rows) {
      add(
        'clone-tool',
        `クローンの道具の定義「${row.name}」（説明 + 入力スキーマ）`,
        row.totalChars,
        'server-chars',
        WHERE_CLONE_TOOL,
      );
    }
  }
  const sorted = rows.sort((a, b) => b.size - a.size || compareCodeUnits(a.label, b.label));
  return {
    state: 'read',
    baseline,
    baselineNote:
      '分母 = システムプロンプトの文字数 + クローンの道具の定義の文字数（記憶の索引はシステムプロンプトの中にあり、足していない。外部 MCP・SDK 組み込みの定義は文字数が取れない）',
    rows: sorted.slice(0, topN),
    total: sorted.length,
  };
}

function tokensCandidates(input: {
  system: PromptSystemPromptSection | PromptUnavailable;
  memory: PromptMemorySection | PromptUnavailable;
  tools: PromptToolsSection | PromptUnavailable;
  externalMcp: PromptExternalMcpSection | PromptUnavailable;
  builtin: PromptBuiltinSection | PromptUnavailable;
  occupancy: PromptOccupancySection | PromptUnavailable;
  topN: number;
}): PromptCandidates['tokens'] {
  const { system, memory, tools, externalMcp, builtin, occupancy, topN } = input;
  const baseline = occupancy.state === 'read' ? occupancy.used.tokens : null;
  const rows: PromptTokensCandidate[] = [];
  let excludedNotLoaded = 0;
  const add = (
    kind: PromptCandidateTokensKind,
    label: string,
    size: ExactTokens,
    where: string,
  ): void => {
    rows.push({
      kind,
      label,
      size,
      share: baseline === null ? null : ratio(size, baseline),
      basis: 'sdk-tokens',
      where,
    });
  };

  if (system.state === 'read' && system.sdkSections.state === 'read') {
    for (const row of system.sdkSections.rows) {
      add(
        'sdk-section',
        `SDK が測ったシステムプロンプトの節「${row.name}」`,
        row.tokens,
        WHERE_SDK_SECTION,
      );
    }
  }
  if (memory.state === 'read' && memory.memoryFiles.state === 'read') {
    for (const row of memory.memoryFiles.rows) {
      add('memory-file', `指示ファイル「${row.path}」`, row.tokens, WHERE_MEMORY_FILE);
    }
  }
  if (tools.state === 'read') {
    for (const row of tools.rows) {
      if (row.tokens !== null) {
        add(
          'clone-tool',
          `クローンの道具「${row.name}」（SDK の測定）`,
          row.tokens,
          WHERE_CLONE_TOOL,
        );
      }
    }
  }
  if (externalMcp.state === 'read' && externalMcp.tokens.state === 'read') {
    for (const row of externalMcp.tokens.byServer) {
      add(
        'external-mcp',
        `外部 MCP「${row.name}」（${row.tools} 本）`,
        row.tokens,
        WHERE_EXTERNAL_MCP,
      );
    }
  }
  if (builtin.state === 'read') {
    if (builtin.systemTools.state === 'read') {
      for (const row of builtin.systemTools.rows) {
        add('builtin-system-tool', `SDK 組み込みの道具「${row.name}」`, row.tokens, WHERE_BUILTIN);
      }
    }
    if (builtin.deferredBuiltinTools.state === 'read') {
      for (const row of builtin.deferredBuiltinTools.rows) {
        // 未ロードの遅延道具は毎ターン払っていない: 毎ターンの量の候補に入れない
        if (!row.isLoaded) {
          excludedNotLoaded += 1;
          continue;
        }
        add(
          'builtin-deferred-tool',
          `SDK 組み込みの遅延道具「${row.name}」（ロード済み）`,
          row.tokens,
          WHERE_BUILTIN,
        );
      }
    }
  }
  if (rows.length === 0) {
    return unavailable(
      'SDK が測ったトークンが1つも取れない（contextUsage が無い・失敗した・各軸が空）',
    );
  }
  const sorted = rows.sort(bySizeThenName);
  return {
    state: 'read',
    baseline,
    baselineNote:
      baseline === null
        ? '分母が取れない（contextUsage.categories の used が無い）。割合は出さない'
        : '分母 = contextUsage.categories のうち kind が used の合計（毎ターン払っている量）',
    rows: sorted.slice(0, topN),
    total: sorted.length,
    excludedNotLoaded,
  };
}

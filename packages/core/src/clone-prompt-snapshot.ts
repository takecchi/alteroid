import { basename } from 'node:path';

import { z } from 'zod';

import type { AgentContextUsage } from './agent-session.js';
import { CONTEXT_USAGE_CATEGORY_LIMIT } from './context-usage.js';
import { stripSchemaKey } from './mcp-lean-schema.js';
import type { McpServers } from './mcp-servers.js';
import { parseMemoryFrontmatter, resolveMemoryDocKind } from './memory-frontmatter.js';
import type { MemoryBakedForm, MemoryDocumentBake, MemoryPart } from './memory.js';
import type { MemoryDocKind } from './schema.js';
import { describeProbeError } from './usage-probe.js';

/**
 * クローンが実際に焼いたプロンプトと、直近のターン境界で払っている文脈の中身を、メモリ上にだけ1件持つ（口は PR-2 の `GET /self/prompt`。ここには無い）。
 * - 日誌にもファイルにも書かない: システムプロンプト全文が日誌へ積まれると、毎セッションぶん日誌が肥える。再起動後は次のセッションが始まるまで空。
 * - 上書きで1件だけ: 履歴にしない（肥大させない）。
 * - 取れない軸に 0 や空配列を置かない: 「使っていない」と読めてしまう。取れないものは `available: false` と理由を値として持つ（AGENTS.md「取れない軸に 0 の行を作る」）。
 */

/** 配列の件数の上限（`CONTEXT_USAGE_CATEGORY_LIMIT` と同じ考え方）。切った件数は `omitted` に値として残す。 */
export const PROMPT_SNAPSHOT_ROWS_LIMIT = 200;
export const PROMPT_SNAPSHOT_MEMORY_DOCUMENTS_LIMIT = 500;

export type SnapshotAxis<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false; readonly reason: string };

export interface CappedRows<T> {
  readonly rows: readonly T[];
  /** 上限で切り捨てた件数。切っていなければ 0 */
  readonly omitted: number;
}

export interface PromptSnapshotTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly descriptionChars: number;
  readonly inputSchemaChars: number;
}

/**
 * その文書が、焼いた索引の中で占めた断片。`#buildSessionSpec` が索引を組んだ同じ1回から取った値（読み直さない）。
 * - `baked`: 断片の長さ（`renderMemoryDocuments` が焼いた断片そのもの。区切りの空行は含まない）と、断片の形（カード・落として1行にした分・fact の目次の1行）
 * - `omitted`: 索引に焼かれなかった（長さを持たない。0 を置かない）。理由を文で持つ
 * - `unavailable`: 長さを取れなかった。理由を文で持つ（0 を置かない）
 */
export type PromptSnapshotMemoryIndex =
  | { readonly kind: 'baked'; readonly form: MemoryBakedForm; readonly chars: number }
  | { readonly kind: 'omitted'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface PromptSnapshotMemoryDocument {
  readonly slug: string;
  readonly type: MemoryDocKind;
  /** frontmatter の要旨。書かれていなければ null（空文字にしない） */
  readonly description: string | null;
  /** 文書の本文の文字数。焼かれた索引の文字数ではない（本文は焼かれていない。焼かれた断片の長さは `index`） */
  readonly chars: number;
  readonly index: PromptSnapshotMemoryIndex;
}

export interface PromptSnapshotExternalMcpServer {
  readonly name: string;
  /** 接続設定の値（url・args・env・headers・command）は持たない。種別だけ */
  readonly type: 'stdio' | 'http' | 'sse';
}

export interface PromptSnapshotSession {
  readonly ok: true;
  readonly builtAt: string;
  readonly resumedFrom: string | null;
  /** init が届くまで null。届いたら `fillSessionId` が埋める */
  readonly sessionId: string | null;
  readonly model: string;
  readonly systemPrompt: { readonly text: string; readonly chars: number };
  readonly memoryInPrompt: {
    readonly documents: readonly PromptSnapshotMemoryDocument[];
    readonly omitted: number;
  };
  readonly tools: readonly PromptSnapshotTool[];
  readonly builtinTools: SnapshotAxis<never>;
  /**
   * いまのセッションに効いている外部 MCP の登録（名前と種別だけ）。セッション開始時の値で始まり、走行中に登録が差し替わったら
   * `updateExternalMcpServers` が差し替え後の値へ合わせる（モデルに実際に見える登録と食い違う状態を黙って残さない）。
   * `builtAt` と `systemPrompt` は焼いたまま変えない。
   */
  readonly externalMcpServers: readonly PromptSnapshotExternalMcpServer[];
  /** null = 走行中の差し替えはまだ無い（`externalMcpServers` はセッション開始時の値）。差し替えた時刻と、その結果の名前 */
  readonly externalMcpServersLive: {
    readonly at: string;
    /** 登録にあるが接続できなかった名前 */
    readonly failed: readonly string[];
    /** 登録から外れたが、起動時の登録ファイルから来たのでこのセッションには残る名前 */
    readonly retained: readonly string[];
  } | null;
  /** セッション開始時の値。plugin を走行中に置き直す経路は無い（開き直したときに変わる） */
  readonly plugins: readonly { readonly name: string }[];
}

export interface PromptSnapshotFailure {
  readonly ok: false;
  readonly at: string;
  readonly error: string;
}

export interface PromptSnapshotContextRow {
  readonly name: string;
  readonly tokens: number;
}

export interface PromptSnapshotContextUsage {
  readonly ok: true;
  /** 答えを受けた時刻（ISO）。いつの値かをここで読む */
  readonly at: string;
  readonly totalTokens: number;
  readonly rawMaxTokens: number;
  readonly percentage: number;
  readonly autoCompactThreshold: number | null;
  readonly isAutoCompactEnabled: boolean;
  readonly categories: SnapshotAxis<
    CappedRows<{ name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }>
  >;
  readonly mcpTools: SnapshotAxis<
    CappedRows<{
      name: string | null;
      serverName: string | null;
      tokens: number;
      isLoaded: boolean | null;
    }>
  >;
  readonly systemPromptSections: SnapshotAxis<CappedRows<{ name: string | null; tokens: number }>>;
  readonly memoryFiles: SnapshotAxis<
    CappedRows<{ path: string | null; type: string | null; tokens: number }>
  >;
  readonly systemTools: SnapshotAxis<CappedRows<PromptSnapshotContextRow>>;
  readonly deferredBuiltinTools: SnapshotAxis<
    CappedRows<{ name: string; tokens: number; isLoaded: boolean }>
  >;
  readonly mcpInstructions: SnapshotAxis<CappedRows<{ serverName: string; tokens: number }>>;
  readonly messageBreakdown: SnapshotAxis<{
    readonly toolCallTokens: number;
    readonly toolResultTokens: number;
    readonly attachmentTokens: number;
    readonly assistantMessageTokens: number;
    readonly userMessageTokens: number;
    readonly toolCallsByType: CappedRows<{
      name: string;
      callTokens: number;
      resultTokens: number;
    }>;
  }>;
}

export interface ClonePromptSnapshot {
  /** null = このプロセスでまだセッションを組んでいない（再起動後は次のセッションが始まるまで空） */
  readonly session: PromptSnapshotSession | PromptSnapshotFailure | null;
  /** null = 今のセッションでまだターン境界を観測していない。失敗した回は理由つきの値（古い成功値は残さない） */
  readonly contextUsage: PromptSnapshotContextUsage | PromptSnapshotFailure | null;
}

// 版と型を逐語で指す（行番号を単独の出典にしない）。この主張が崩れたら `clone-prompt-snapshot.test.ts` の歯が落ちる
const BUILTIN_TOOLS_DEFINITION_UNAVAILABLE =
  'SDK 組み込みの道具の定義（説明・入力スキーマ）は取れない（@anthropic-ai/claude-agent-sdk 0.3.318 で確認）: ' +
  'SDKControlGetContextUsageResponse の systemTools / deferredBuiltinTools は name と tokens だけ、' +
  'SDKSystemMessage（init）の tools は string[]（名前だけ）で、Query に組み込みの道具の定義を返す口が無い。' +
  '名前と大きさは contextUsage.systemTools に在る。';

const ABSENT_FIELD_REASON =
  'getContextUsage の答えにこの欄が無かった（SDK の版がこの欄を返さない、または駆動役が返さない）';

export const BUILTIN_TOOLS_UNAVAILABLE_AXIS: SnapshotAxis<never> = Object.freeze({
  available: false as const,
  reason: BUILTIN_TOOLS_DEFINITION_UNAVAILABLE,
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function capRows<T, U>(
  rows: readonly T[] | undefined,
  map: (row: T) => U,
  limit: number,
): SnapshotAxis<CappedRows<U>> {
  if (!Array.isArray(rows)) return { available: false, reason: ABSENT_FIELD_REASON };
  return {
    available: true,
    value: { rows: rows.slice(0, limit).map(map), omitted: Math.max(0, rows.length - limit) },
  };
}

interface CloneToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/**
 * `createCloneTools` の返り値から、モデルに見える定義を写す。`clone-tools-registry-pin.test.ts` の `actualTools()` と同じ取り方（zod → JSON Schema）。
 * `tool()` は入力を zod の object に包んで持つので、素の shape で来た場合だけ包む。
 */
export function describeCloneTools(tools: readonly CloneToolDefinition[]): PromptSnapshotTool[] {
  return tools.map((entry) => {
    // `$schema` を外す: モデルへ渡す `tools/list` からは外してある（`withoutSchemaKey`）。「モデルに見える定義」と大きさを合わせるため、同じ `stripSchemaKey` を使う
    const inputSchema = stripSchemaKey(
      JSON.parse(
        JSON.stringify(
          z.toJSONSchema(
            '_zod' in (entry.inputSchema as object)
              ? (entry.inputSchema as unknown as z.ZodType)
              : z.object(entry.inputSchema as z.ZodRawShape),
            { io: 'input', unrepresentable: 'any' },
          ),
        ),
      ) as unknown,
    );
    return {
      name: entry.name,
      description: entry.description,
      inputSchema,
      descriptionChars: entry.description.length,
      inputSchemaChars: JSON.stringify(inputSchema).length,
    };
  });
}

const MEMORY_BAKE_ABSENT_REASON =
  '索引を組んだときの文書ごとの長さの控えにこの文書が無かった（取れなかったので、0 とは書かない）';

/**
 * 区分と要旨は `renderMemoryDocuments` が使う導出関数をそのまま使う（二重実装しない）。
 * 索引の中での長さ（`index`）は、`renderMemoryDocumentsWithBake` が索引を組んだ同じ1回に返した値をそのまま写す。数え直さない。
 */
export function describeMemoryInPrompt(
  documents: readonly MemoryPart[],
  bake: ReadonlyMap<string, MemoryDocumentBake>,
): {
  documents: PromptSnapshotMemoryDocument[];
  omitted: number;
} {
  const shown = documents.slice(0, PROMPT_SNAPSHOT_MEMORY_DOCUMENTS_LIMIT).map((doc) => {
    const frontmatter = parseMemoryFrontmatter(doc.content);
    const description =
      frontmatter.kind === 'parsed' ? (frontmatter.description?.trim() ?? '') : '';
    const baked = bake.get(doc.slug);
    const index: PromptSnapshotMemoryIndex =
      baked === undefined
        ? { kind: 'unavailable', reason: MEMORY_BAKE_ABSENT_REASON }
        : baked.omitted
          ? { kind: 'omitted', reason: baked.reason }
          : { kind: 'baked', form: baked.form, chars: baked.chars };
    return {
      slug: doc.slug,
      type: resolveMemoryDocKind(frontmatter),
      description: description.length === 0 ? null : description,
      chars: doc.content.length,
      index,
    };
  });
  return {
    documents: shown,
    omitted: Math.max(0, documents.length - PROMPT_SNAPSHOT_MEMORY_DOCUMENTS_LIMIT),
  };
}

/** 接続設定の値は読まない: `type` 以外の欄（url・args・env・headers・command）へ触らない */
export function describeExternalMcpServers(servers: McpServers): PromptSnapshotExternalMcpServer[] {
  return Object.entries(servers).map(([name, config]) => ({ name, type: config.type ?? 'stdio' }));
}

export interface PromptSnapshotSessionInput {
  builtAt: string;
  resumedFrom: string | null;
  model: string;
  systemPrompt: string;
  documents: readonly MemoryPart[];
  /** `renderMemoryDocumentsWithBake` が索引を組んだ同じ1回に返した、文書ごとに焼いた断片の長さ（slug が鍵）。読み直さず、その値をそのまま置く */
  memoryBake: ReadonlyMap<string, MemoryDocumentBake>;
  // 関数で受ける: 道具の組み立てが投げても、`recordSession` の中で失敗の値へ畳み、セッションの起動を止めないため
  tools: () => readonly CloneToolDefinition[];
  externalMcpServers: McpServers;
  pluginPaths: readonly string[];
}

export class ClonePromptSnapshotState {
  #session: PromptSnapshotSession | PromptSnapshotFailure | null = null;
  #contextUsage: PromptSnapshotContextUsage | PromptSnapshotFailure | null = null;

  /**
   * セッションを組んだ直後に1回だけ置く。前のセッションの文脈占有は消す: 新しいセッションの値として残すと嘘になるため。
   * 組めなかったときは投げず、その理由を値として置く（観測のためにセッションの起動を止めない。古い版も残さない）。
   */
  recordSession(
    input: PromptSnapshotSessionInput,
    now: () => string = () => new Date().toISOString(),
  ): void {
    this.#contextUsage = null;
    try {
      this.#session = deepFreeze({
        ok: true as const,
        builtAt: input.builtAt,
        resumedFrom: input.resumedFrom,
        sessionId: null,
        model: input.model,
        systemPrompt: { text: input.systemPrompt, chars: input.systemPrompt.length },
        memoryInPrompt: describeMemoryInPrompt(input.documents, input.memoryBake),
        tools: describeCloneTools(input.tools()),
        builtinTools: BUILTIN_TOOLS_UNAVAILABLE_AXIS,
        externalMcpServers: describeExternalMcpServers(input.externalMcpServers),
        externalMcpServersLive: null,
        plugins: input.pluginPaths.map((path) => ({ name: basename(path) })),
      });
    } catch (error) {
      this.#session = deepFreeze({
        ok: false as const,
        at: now(),
        error: describeProbeError(error, process.env),
      });
    }
  }

  /** init が届いたとき。組んだ後に届く（セッションを開くのは組んだ後）ので、無ければ何もしない */
  fillSessionId(sessionId: string | null): void {
    const session = this.#session;
    if (session === null || !session.ok || session.sessionId !== null || sessionId === null) return;
    this.#session = deepFreeze({ ...session, sessionId });
  }

  /**
   * 走行中のセッションへ登録を置き直せたとき、その欄だけを差し替え後に合わせる。接続設定の値は読まない（名前と種別だけ）。
   * 残っている名前（`retained`）は種別を差し替え前の値から引く（登録から外れて、設定の値が手元に無いため）。
   */
  updateExternalMcpServers(
    servers: McpServers,
    applied: { failed: readonly string[]; retained: readonly string[] },
    at: string,
  ): void {
    const session = this.#session;
    if (session === null || !session.ok) return;
    const kept = describeExternalMcpServers(servers);
    const keptNames = new Set(kept.map((server) => server.name));
    const retained = session.externalMcpServers.filter(
      (server) => applied.retained.includes(server.name) && !keptNames.has(server.name),
    );
    this.#session = deepFreeze({
      ...session,
      externalMcpServers: [...kept, ...retained],
      externalMcpServersLive: { at, failed: [...applied.failed], retained: [...applied.retained] },
    });
  }

  recordContextUsage(usage: AgentContextUsage, at: string): void {
    this.#contextUsage = deepFreeze({
      ok: true as const,
      at,
      totalTokens: usage.totalTokens,
      rawMaxTokens: usage.rawMaxTokens,
      percentage: usage.percentage,
      autoCompactThreshold: usage.autoCompactThreshold ?? null,
      isAutoCompactEnabled: usage.isAutoCompactEnabled,
      categories: capRows(
        usage.categories,
        (row) => ({ name: row.name, tokens: row.tokens, kind: row.kind }),
        CONTEXT_USAGE_CATEGORY_LIMIT,
      ),
      mcpTools: capRows(
        usage.mcpTools,
        (row) => ({
          name: row.name ?? null,
          serverName: row.serverName ?? null,
          tokens: row.tokens,
          isLoaded: row.isLoaded ?? null,
        }),
        PROMPT_SNAPSHOT_ROWS_LIMIT,
      ),
      systemPromptSections: capRows(
        usage.systemPromptSections,
        (row) => ({ name: row.name ?? null, tokens: row.tokens }),
        PROMPT_SNAPSHOT_ROWS_LIMIT,
      ),
      memoryFiles: capRows(
        usage.memoryFiles,
        (row) => ({ path: row.path ?? null, type: row.type ?? null, tokens: row.tokens }),
        PROMPT_SNAPSHOT_ROWS_LIMIT,
      ),
      systemTools: capRows(
        usage.systemTools,
        (row) => ({ name: row.name, tokens: row.tokens }),
        PROMPT_SNAPSHOT_ROWS_LIMIT,
      ),
      deferredBuiltinTools: capRows(
        usage.deferredBuiltinTools,
        (row) => ({ name: row.name, tokens: row.tokens, isLoaded: row.isLoaded }),
        PROMPT_SNAPSHOT_ROWS_LIMIT,
      ),
      mcpInstructions: capRows(
        usage.mcpInstructions,
        (row) => ({ serverName: row.serverName, tokens: row.tokens }),
        PROMPT_SNAPSHOT_ROWS_LIMIT,
      ),
      messageBreakdown:
        usage.messageBreakdown === undefined
          ? { available: false, reason: ABSENT_FIELD_REASON }
          : {
              available: true,
              value: {
                toolCallTokens: usage.messageBreakdown.toolCallTokens,
                toolResultTokens: usage.messageBreakdown.toolResultTokens,
                attachmentTokens: usage.messageBreakdown.attachmentTokens,
                assistantMessageTokens: usage.messageBreakdown.assistantMessageTokens,
                userMessageTokens: usage.messageBreakdown.userMessageTokens,
                toolCallsByType: capRowsValue(
                  usage.messageBreakdown.toolCallsByType,
                  (row) => ({
                    name: row.name,
                    callTokens: row.callTokens,
                    resultTokens: row.resultTokens,
                  }),
                  PROMPT_SNAPSHOT_ROWS_LIMIT,
                ),
              },
            },
    });
  }

  /** 古い成功値を残さずに、この回が取れなかったことと理由を置く。`error` は `describeProbeError` を通したもの */
  recordContextUsageFailure(error: string, at: string): void {
    this.#contextUsage = deepFreeze({ ok: false as const, at, error });
  }

  snapshot(): ClonePromptSnapshot {
    return deepFreeze({ session: this.#session, contextUsage: this.#contextUsage });
  }
}

function capRowsValue<T, U>(
  rows: readonly T[] | undefined,
  map: (row: T) => U,
  limit: number,
): CappedRows<U> {
  const list = Array.isArray(rows) ? (rows as readonly T[]) : [];
  return { rows: list.slice(0, limit).map(map), omitted: Math.max(0, list.length - limit) };
}

import { z } from "zod";
import type { Ctx } from "./ctx.js";
import { defaultDecayStrategy } from "./strategies/decay.js";
import type { LLMProvider, PromptSpec } from "./interfaces/llm-provider.js";
import type { DigestSource, NewMemory } from "./memory.js";
import type { Observation } from "./observation.js";
import type { Provenance } from "./provenance.js";

/**
 * 基本の Memory Extraction（roadmap.md 段階3、docs/architecture.md §3.8）。
 *
 * Observation → Memory 候補 + digest を `LLMProvider.completeStructured` で得る。
 * この核は `runtime.ts` から使われる純粋なロジックであり、`LLMProvider` は注入される
 * （core は OpenAI/Anthropic の型を知らない、docs/architecture.md §3.8）。
 */

/** LLM に返させる、1件の Memory 候補の構造化スキーマ。 */
export const ExtractedMemoryCandidateSchema = z.object({
  content: z.string().min(1),
  /**
   * 要旨。LLM が生成できなかった場合は省略してよい（省略・空文字は「LLM 側の digest 生成が
   * 失敗した」ものとして扱い、機械的な先頭文字列切り出しへフォールバックする。
   * docs/memory-model.md §4 の安全弁）。
   */
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /**
   * オーナーの原則7（AI の推論とユーザーが言った事実を区別する）。抽出結果は必ず
   * `stated`（本人が明示的に述べた事実）か `inferred`（LLM の推論）のどちらかを申告する。
   */
  provenanceKind: z.enum(["stated", "inferred"]),
  /** `provenanceKind: 'inferred'` のときの確信度。`stated` では無視する。 */
  confidence: z.number().min(0).max(1).optional(),
});
export type ExtractedMemoryCandidate = z.infer<typeof ExtractedMemoryCandidateSchema>;

export const ExtractionResultSchema = z.object({
  memories: z.array(ExtractedMemoryCandidateSchema),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

function observationPayloadText(observation: Observation): string {
  const payload = observation.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.length > 0) {
      return record.text;
    }
    if (typeof record.content === "string" && record.content.length > 0) {
      return record.content;
    }
    if (typeof record.name === "string" && record.name.length > 0) {
      return record.name;
    }
  }
  return JSON.stringify(payload ?? null);
}

function observationSpeaker(observation: Observation): string | undefined {
  const payload = observation.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const speaker = (payload as Record<string, unknown>).speaker;
    if (typeof speaker === "string" && speaker.length > 0) {
      return speaker;
    }
  }
  return undefined;
}

/** `completeStructured` へ渡すプロンプト。文面はこの PR の裁量であり、契約はスキーマ側にある。 */
export function buildExtractionPrompt(observation: Observation): PromptSpec {
  return {
    system:
      "あなたは会話・イベント・文書から再利用可能な記憶を抽出するアシスタントです。" +
      "本人が明示的に述べた事実は provenanceKind: 'stated' として、それ以外の推論は " +
      "'inferred' として区別してください。何も記憶に値しない場合は空配列を返してください。",
    messages: [
      {
        role: "user",
        content: observationPayloadText(observation),
      },
    ],
  };
}

/**
 * 機械的な先頭文字列切り出し（docs/memory-model.md §4 の安全弁）。
 * `content` は生成の成否に関わらず常に保持される前提で、`digest` だけをこの関数で埋める。
 */
export function truncateForFallbackDigest(content: string, maxLength: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxLength) {
    return trimmed.length > 0 ? trimmed : "（内容なし）";
  }
  return `${trimmed.slice(0, maxLength)}…`;
}

export interface ResolvedDigest {
  digest: string;
  digestSource: DigestSource;
}

/** LLM が返した digest が空・欠落なら機械的フォールバックへ倒す（1件ずつの判定）。 */
export function resolveDigest(
  candidate: Pick<ExtractedMemoryCandidate, "content" | "digest">,
  fallbackLength: number,
): ResolvedDigest {
  const llmDigest = candidate.digest?.trim();
  if (llmDigest && llmDigest.length > 0) {
    return { digest: llmDigest, digestSource: "llm" };
  }
  return {
    digest: truncateForFallbackDigest(candidate.content, fallbackLength),
    digestSource: "fallback",
  };
}

/**
 * LLM 呼び出し自体が失敗した場合の安全弁: Observation の全文をそのまま1件の `stated` Memory
 * として残す。**content（全文）は生成の成否に関わらず必ず書く**という規律（docs/memory-model.md
 * §4）を、抽出全体が失敗した場合にも一貫させる（曖昧なら厚い側に倒す）。
 */
function fallbackWholeObservationCandidate(observation: Observation): ExtractedMemoryCandidate {
  return {
    content: observationPayloadText(observation),
    tags: [],
    provenanceKind: "stated",
  };
}

/**
 * 抽出がどう終わったか（ADR 0008 の「無い」の分類を、recall だけでなく取り込み側にも適用する）。
 *
 * - `ok` — LLM が正常に応答した。**0件を返した場合も `ok`** である
 *   （何も記憶に値しないという判断は正常な抽出結果であり、失敗ではない）。
 * - `llm_failed_whole_observation` — LLM 呼び出し自体が失敗し、Observation の全文を
 *   1件の Memory として残す安全弁へ倒れた（docs/memory-model.md §4「曖昧なら厚い側に倒す」）。
 *   **この Memory は「抽出された」ものではない。** 未処理の生テキストである。
 * - `skipped` — この呼び出しでは抽出を実行していない（`deferred`、`memory_usage`、冪等な再送）。
 */
export type ExtractionOutcome = "ok" | "llm_failed_whole_observation" | "skipped";

/**
 * `extractCandidates` が LLM 呼び出しの例外を飲んだとき、**中身だけは捨てずに運ぶ**ための形。
 *
 * 背景: `ExtractionOutcome: "llm_failed_whole_observation"` という1つの値に、実測で
 * 少なくとも6種の原因（拒否 / 切り詰め / 空応答 / `ZodError` / `SyntaxError` / 通信・認証
 * エラー）が畳まれていた。「例外を上へ伝播させない」こと自体は ADR 0013 の意図的な決定
 * （安全弁）であり維持するが、「中身まで捨てる」ことを決めた記述はどこにも無い。
 */
export interface ExtractionFailure {
  /**
   * provider が名乗った種類（`@mnemora/openai` / `@mnemora/anthropic` が投げるエラーの
   * `kind`）。**名乗っていなければ `null`**——「分からない」を勝手な種類に読み替えない。
   */
  kind: string | null;
  /** 例外のメッセージ（人が読むため）。 */
  message: string;
}

/**
 * 任意の `throw` された値から `ExtractionFailure` を組み立てる。
 *
 * ⚠ **core は provider のクラスを知らない**（`packages/core/package.json` の
 * `dependencies` は `zod` だけ、`dependency-boundary.test.ts` が機械的に検査している）。
 * そのため `instanceof AnthropicLLMProviderError` のような判定はできず、**値として
 * `error.kind` を読む**（duck typing）。`kind` は `typeof === "string"` かつ空文字でない
 * ときだけ採り、それ以外（無い・数値・空文字など）は `null` にする——「分からない」を
 * 勝手な種類に読み替えないため。
 *
 * `message` は `error instanceof Error ? error.message : String(error)` に相当する。
 * **非 `Error`（文字列・`undefined`・プレーンオブジェクト等）が投げられても落ちない。**
 */
export function describeExtractionFailure(error: unknown): ExtractionFailure {
  const rawKind = (error as { kind?: unknown } | null | undefined)?.kind;
  const kind = typeof rawKind === "string" && rawKind.length > 0 ? rawKind : null;
  const message = error instanceof Error ? error.message : String(error);
  return { kind, message };
}

export interface ExtractCandidatesResult {
  candidates: ExtractedMemoryCandidate[];
  /** LLM 呼び出し自体が失敗し、全文フォールバックへ倒れたかどうか。 */
  usedWholeObservationFallback: boolean;
  /**
   * LLM 呼び出しが失敗した理由。**成功経路（0件を含む）は必ず `null`。**
   * 失敗経路（`usedWholeObservationFallback: true`）は必ず非 `null`。
   */
  failure: ExtractionFailure | null;
}

/**
 * `LLMProvider.completeStructured` を呼び、失敗したら全文フォールバックへ倒す。
 *
 * **LLM が正常に「0件」を返した場合はフォールバックしない。** 何も記憶に値しないという判断は
 * 正常な抽出結果であり、これを「失敗」として無理に1件作ると、北極星の物差し（毎回渡す量を
 * 減らす方向に働くか）に反するゴミ記憶を増やす。フォールバックの対象はあくまで
 * **LLM 呼び出し自体が失敗した場合**（ネットワークエラー・タイムアウト・スキーマ不整合等）。
 */
export async function extractCandidates(
  llmProvider: LLMProvider,
  ctx: Ctx,
  observation: Observation,
): Promise<ExtractCandidatesResult> {
  try {
    const result = await llmProvider.completeStructured(ctx, {
      prompt: buildExtractionPrompt(observation),
      schema: ExtractionResultSchema,
    });
    return { candidates: result.memories, usedWholeObservationFallback: false, failure: null };
  } catch (error) {
    return {
      candidates: [fallbackWholeObservationCandidate(observation)],
      usedWholeObservationFallback: true,
      failure: describeExtractionFailure(error),
    };
  }
}

export interface BuildNewMemoryParams {
  ctx: Ctx;
  observation: Observation;
  candidate: ExtractedMemoryCandidate;
  hashContent: (content: string) => string;
  extractorVersion: string;
  llmModelId: string;
  promptVersion: string;
  halfLifeHours: number;
  now: Date;
  digestFallbackLength: number;
}

function buildProvenance(params: BuildNewMemoryParams): Provenance {
  const { candidate, observation } = params;
  if (candidate.provenanceKind === "inferred") {
    return {
      kind: "inferred",
      model: params.llmModelId,
      promptVersion: params.promptVersion,
      basis: { memoryIds: [], observationIds: [observation.id] },
      confidence: candidate.confidence ?? 0.5,
    };
  }
  const speaker = observationSpeaker(observation);
  return {
    kind: "stated",
    sourceObservationId: observation.id,
    at: (observation.occurredAt ?? observation.recordedAt).toISOString(),
    ...(speaker !== undefined ? { speaker } : {}),
  };
}

/** 1件の抽出候補から `NewMemory` を組み立てる（D16: contentHash は注入された関数で計算する）。 */
export function buildNewMemoryFromCandidate(params: BuildNewMemoryParams): NewMemory {
  const { digest, digestSource } = resolveDigest(params.candidate, params.digestFallbackLength);
  const decayFloorAt = defaultDecayStrategy.floorAt({
    recordedAt: params.now,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
  });
  return {
    tenantId: params.ctx.tenantId,
    subjectId: params.observation.subjectId ?? null,
    sourceObservationId: params.observation.id,
    extractorVersion: params.extractorVersion,
    content: params.candidate.content,
    contentHash: params.hashContent(params.candidate.content),
    digest,
    digestSource,
    provenance: buildProvenance(params),
    tags: params.candidate.tags ?? [],
    occurredAt: params.observation.occurredAt ?? null,
    recordedAt: params.now,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
    decayFloorAt,
    embeddingStatus: "pending",
  };
}

import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { resolveDigest } from "../extraction.js";
import type { PromptSpec } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "./decay.js";

/**
 * `runtime.consolidate`（Issue #103、ADR 0089）が LLM に返させる構造化スキーマ。
 *
 * `extraction.ts` の `ExtractionResultSchema`（`{ memories: [...] }`）とは**別のスキーマ**
 * である——抽出は「1件の Observation → 0〜N件の Memory 候補」だが、統合は
 * 「N件の Memory → ちょうど1件の統合結果」であり、配列に包まない。
 */
export const ConsolidationLLMResultSchema = z.object({
  content: z.string().min(1),
  /**
   * 省略・空文字は「LLM 側の digest 生成が失敗した」ものとして扱い、機械的な先頭文字列
   * 切り出しへフォールバックする（`resolveDigest`、extraction.ts と同じ規律）。
   */
  digest: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type ConsolidationLLMResult = z.infer<typeof ConsolidationLLMResultSchema>;

/**
 * `completeStructured` へ渡すプロンプト。文面はこの PR の裁量であり、契約は
 * {@link ConsolidationLLMResultSchema} 側にある。
 */
export function buildConsolidationPrompt(eligible: Memory[]): PromptSpec {
  return {
    system:
      "あなたは複数の記憶を1件に統合するアシスタントです。渡された記憶それぞれの本文と要旨を読み、" +
      "重複を除いて1つの本文にまとめてください。矛盾する内容がある場合はどちらも書き残してください。",
    messages: [
      {
        role: "user",
        content: eligible
          .map((m, i) => `[${i + 1}] content: ${m.content}\ndigest: ${m.digest}`)
          .join("\n\n"),
      },
    ],
  };
}

export interface BuildConsolidatedMemoryParams {
  ctx: Ctx;
  /**
   * 統合される側（`status: 'active'` の eligible）。**入力の順序をそのまま使う**——
   * `occurredAt` の最新判定・`subjectId` の一致判定・タグの和集合はこの並びに従う。
   */
  eligible: Memory[];
  llmResult: ConsolidationLLMResult;
  hashContent: (content: string) => string;
  digestFallbackLength: number;
  halfLifeHours: number;
  now: Date;
}

/**
 * 統合先の `NewMemory` を組み立てる純関数（Issue #103 §手順6、ADR 0089）。
 *
 * ⚠ **`extraction.ts` の `buildNewMemoryFromCandidate` は流用できない**——あちらは
 * Observation 由来の Memory を組み立てる前提（`sourceObservationId`/`extractorVersion`/
 * `provenance.kind: 'stated' | 'inferred'` を Observation から導く）であり、統合はどの
 * Observation にも由来しない。この関数はそのための専用の純関数である。
 *
 * - `subjectId`: eligible 全件の `subjectId` が一致すればその値、割れていれば `null`。
 * - `provenance`: `{ kind: 'consolidated', sources: <eligible の memoryId> }`。
 * - `tags`: LLM が返した `tags` があればそれを使い、無ければ eligible の `tags` の和集合。
 * - `occurredAt`: eligible の `occurredAt` のうち最も新しいもの。全部 `null` なら `null`。
 * - `sourceObservationId` / `extractorVersion`: 常に `null`（Observation 由来ではない）。
 */
export function buildConsolidatedMemory(params: BuildConsolidatedMemoryParams): NewMemory {
  const { eligible, llmResult, now } = params;

  const subjectIds = new Set(eligible.map((m) => m.subjectId ?? null));
  const subjectId = subjectIds.size === 1 ? [...subjectIds][0]! : null;

  const { digest, digestSource } = resolveDigest(
    { content: llmResult.content, digest: llmResult.digest },
    params.digestFallbackLength,
  );

  const tagUnion = Array.from(new Set(eligible.flatMap((m) => m.tags)));
  const tags = llmResult.tags ?? tagUnion;

  const occurredAtCandidates = eligible
    .map((m) => m.occurredAt ?? null)
    .filter((d): d is Date => d !== null);
  const occurredAt =
    occurredAtCandidates.length === 0
      ? null
      : new Date(Math.max(...occurredAtCandidates.map((d) => d.getTime())));

  const decayFloorAt = defaultDecayStrategy.floorAt({
    recordedAt: now,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
  });

  return {
    tenantId: params.ctx.tenantId,
    subjectId,
    sourceObservationId: null,
    extractorVersion: null,
    content: llmResult.content,
    contentHash: params.hashContent(llmResult.content),
    digest,
    digestSource,
    provenance: { kind: "consolidated", sources: eligible.map((m) => m.id) },
    tags,
    occurredAt,
    recordedAt: now,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: params.halfLifeHours,
    decayFloorAt,
    embeddingStatus: "pending",
  };
}

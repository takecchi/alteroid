import { z } from "zod";
import type { Ctx } from "../ctx.js";
import { resolveDigest } from "../extraction.js";
import type { PromptSpec } from "../interfaces/llm-provider.js";
import type { Memory, NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "./decay.js";

/**
 * `runtime.reflect`（Issue #104）が LLM に返させる構造化スキーマ。
 *
 * `consolidate.ts` の `ConsolidationLLMResultSchema`（`{ content, digest?, tags? }`）とは
 * **判別子 `outcome` を持つ点で意図的に違う**。`consolidate` は必ず1件の統合結果を返す前提
 * （eligible が2件以上あることが手順3で保証されている）だが、`reflect` は「渡された記憶から
 * 一般化できるものが実際にあるか」自体を LLM に判定させる必要がある——断れないスキーマを
 * 渡すと、モデルは毎回何かを捏造する。⟹ `outcome: 'reflected' | 'nothing'` の判別可能
 * ユニオンにして、モデルが「一般化するものは無い」と答えられる形にした。
 *
 * 🔴 この `outcome` という必須の判別子は、`ConsolidationLLMResultSchema`
 * （`{content, digest?, tags?}`、判別子を持たない）とも `extraction.ts` の
 * `ExtractionResultSchema`（`{memories:[...]}`）とも**互いに素**である——3つのどれを
 * `DeterministicLLMProvider`（`packages/testkit`）に渡しても取り違えて成功することがない
 * （`reflect.test.ts` で測っている）。
 */
export const ReflectionLLMResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("reflected"),
    content: z.string().min(1),
    /**
     * 省略・空文字は「LLM 側の digest 生成が失敗した」ものとして扱い、機械的な先頭文字列
     * 切り出しへフォールバックする（`resolveDigest`、extraction.ts と同じ規律）。
     */
    digest: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  }),
  z.object({ outcome: z.literal("nothing") }),
]);
export type ReflectionLLMResult = z.infer<typeof ReflectionLLMResultSchema>;

/** {@link ReflectionLLMResultSchema} の `outcome: 'reflected'` 側だけを取り出した形。 */
export type ReflectedLLMResult = Extract<ReflectionLLMResult, { outcome: "reflected" }>;

/**
 * `completeStructured` へ渡すプロンプト。文面はこの PR の裁量であり、契約は
 * {@link ReflectionLLMResultSchema} 側にある。
 *
 * `buildConsolidationPrompt` と違い、**モデルに「無理に一般化を作らないでよい」ことを
 * 明示する**——スキーマ側で断れるようにしただけでは、文面が「必ず1件作れ」と読める場合
 * モデルは断らない（北極星の問い6「知らないことを知らないと言えるか」の、プロンプト面での
 * 適用）。
 */
export function buildReflectionPrompt(basis: Memory[]): PromptSpec {
  return {
    system:
      "あなたは複数の記憶から、まだ言語化されていない一般化や気づきを見つけるアシスタントです。" +
      "渡された記憶それぞれの本文と要旨を読み、それらに共通するパターンや示唆が実際にある場合" +
      "だけ、それを1件の新しい記憶としてまとめてください。共通点が見つからない、または単なる" +
      "言い換えにしかならない場合は、無理に作らず outcome: 'nothing' を返してください。",
    messages: [
      {
        role: "user",
        content: basis
          .map((m, i) => `[${i + 1}] content: ${m.content}\ndigest: ${m.digest}`)
          .join("\n\n"),
      },
    ],
  };
}

export interface BuildReflectedMemoryParams {
  ctx: Ctx;
  /**
   * 土台になった側（`status: 'active'` かつ `provenance.kind !== 'reflected'` の eligible）。
   * **入力の順序をそのまま使う**——`occurredAt` の最新判定・`subjectId` の一致判定・タグの
   * 和集合はこの並びに従う（`buildConsolidatedMemory` と同じ規律）。
   */
  eligible: Memory[];
  llmResult: ReflectedLLMResult;
  hashContent: (content: string) => string;
  digestFallbackLength: number;
  halfLifeHours: number;
  now: Date;
}

/**
 * 新しい Memory の `NewMemory` を組み立てる純関数（Issue #104 手順7）。
 *
 * `strategies/consolidate.ts` の `buildConsolidatedMemory` の双子——`subjectId` の割れ方・
 * `digest` のフォールバック・`tags` の決め方・`occurredAt`・`halfLifeHours`・`decayFloorAt`・
 * `strength`・`embeddingStatus`・`sourceObservationId`/`extractorVersion` の扱いを
 * **全部そのまま踏襲する**。`consolidate` と `reflect` はどちらも「Observation に由来しない、
 * 複数の既存 Memory から新しい Memory を組み立てる」という同じ形の操作であり、この部分の
 * 意味論は統合か反映かで変わらない:
 *
 * - `subjectId`: eligible 全件の `subjectId` が一致すればその値、割れていれば `null`
 *   （`consolidate` と同じ——「この一般化は誰について言っているか」も、一致するときだけ
 *   引き継げる）。
 * - `digest`: LLM が返した digest が空・欠落なら機械的フォールバックへ倒す
 *   （`resolveDigest`、extraction.ts / consolidate.ts と同じ安全弁）。
 * - `tags`: LLM が返した `tags` があればそれを使い、無ければ eligible の `tags` の和集合。
 * - `occurredAt`: eligible の `occurredAt` のうち最も新しいもの。全部 `null` なら `null`。
 * - `halfLifeHours` / `decayFloorAt`: 呼び出し側（`runtime.reflect`）がテナント既定値から
 *   計算して渡す。`decayFloorAt` は `strength: 1` を前提に計算する（`consolidate` と同じ）。
 * - `strength`: **`1`（`MAX_STRENGTH`）に固定する。`consolidate` と同じ値・同じ書き方**
 *   ——`packages/core/src/provenance.ts` 冒頭の JSDoc が「オーナーの原則7は追加のフラグ
 *   ではなく `kind` の値そのものとして実装される」と明示しており、`strength` を下げると
 *   同じ区別を2本目の信号で複製することになる。ADR 0078 も「`Runtime` から初期値の
 *   `strength` を設定する口は開けない」と明示的に閉じている。
 * - `embeddingStatus`: 常に `'pending'`（`createMemoryWithOutbox` が `embed` ジョブを積む）。
 * - `sourceObservationId` / `extractorVersion`: 常に `null`（Observation 由来ではない）。
 * - `provenance`: `{ kind: 'reflected', sources: <eligible の memoryId> }`。**`sources` は
 *   常に埋める**——型としては `ReflectedProvenance.sources` は省略可のままだが（公開型の
 *   破壊的変更を避けるため、`provenance.ts` は変えていない）、この実装が作る値は常に埋める。
 */
export function buildReflectedMemory(params: BuildReflectedMemoryParams): NewMemory {
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
    provenance: { kind: "reflected", sources: eligible.map((m) => m.id) },
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

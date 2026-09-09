import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import {
  buildNewMemoryFromCandidate,
  describeExtractionFailure,
  extractCandidates,
  resolveDigest,
  truncateForFallbackDigest,
  type ExtractedMemoryCandidate,
} from "../extraction.js";
import { z } from "zod";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { Observation } from "../observation.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs-1",
    tenantId: "tenant-1",
    subjectId: "user-1",
    externalId: null,
    kind: "utterance",
    payload: { text: "明日は東京に出張する予定です", speaker: "田中" },
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    recordedAt: new Date("2026-01-01T00:00:01.000Z"),
    ...overrides,
  };
}

/** テストごとに固定の候補集合を返すだけの LLMProvider フェイク。 */
function llmProviderReturning(memories: ExtractedMemoryCandidate[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used in this test");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      return req.schema.parse({ memories }) as T;
    },
  };
}

function throwingLlmProvider(): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used in this test");
    },
    completeStructured: async () => {
      throw new Error("simulated LLM failure (timeout/network)");
    },
  };
}

/** provider が `kind` 付きで投げる想定（`@mnemora/openai` / `@mnemora/anthropic` の模倣）。 */
function throwingLlmProviderWithKind(kind: string, message: string): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used in this test");
    },
    completeStructured: async () => {
      const error = new Error(message) as Error & { kind: string };
      error.kind = kind;
      throw error;
    },
  };
}

describe("extractCandidates（roadmap.md 段階3の基本抽出）", () => {
  it("LLM が候補を返せば、そのまま candidates として返す（フォールバックしない）", async () => {
    const provider = llmProviderReturning([
      { content: "東京出張の予定がある", digest: "東京出張予定", provenanceKind: "stated" },
    ]);
    const result = await extractCandidates(provider, ctx, makeObservation());
    expect(result.usedWholeObservationFallback).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.content).toBe("東京出張の予定がある");
    // 成功経路（0件を含む）は必ず failure: null（「間違った有る」を作らない）。
    expect(result.failure).toBeNull();
  });

  it("LLM が0件を返した場合はフォールバックしない（『何も無い』は正常系）", async () => {
    const provider = llmProviderReturning([]);
    const result = await extractCandidates(provider, ctx, makeObservation());
    expect(result.usedWholeObservationFallback).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.failure).toBeNull();
  });

  it("LLM 呼び出し自体が失敗したら、全文をそのまま1件の stated Memory 候補として残す（安全弁）", async () => {
    const provider = throwingLlmProvider();
    const observation = makeObservation();
    const result = await extractCandidates(provider, ctx, observation);
    expect(result.usedWholeObservationFallback).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.content).toBe("明日は東京に出張する予定です");
    expect(result.candidates[0]?.provenanceKind).toBe("stated");
    // 失敗経路は必ず failure が非 null。kind を名乗らない Error は kind: null になる。
    expect(result.failure).toEqual({
      kind: null,
      message: "simulated LLM failure (timeout/network)",
    });
  });

  it("provider が kind 付きで投げたら、failure.kind にその値がそのまま運ばれる（中身を捨てない）", async () => {
    const provider = throwingLlmProviderWithKind("refusal", "the model refused to answer");
    const result = await extractCandidates(provider, ctx, makeObservation());
    expect(result.usedWholeObservationFallback).toBe(true);
    expect(result.failure).toEqual({ kind: "refusal", message: "the model refused to answer" });
  });

  it("フォールバック候補は payload.text が無い document/event でも空文字にならない", async () => {
    const provider = throwingLlmProvider();
    const observation = makeObservation({
      kind: "event",
      payload: { name: "login", data: { ip: "127.0.0.1" } },
    });
    const result = await extractCandidates(provider, ctx, observation);
    expect(result.candidates[0]?.content).toBe("login");
  });
});

describe("resolveDigest（docs/memory-model.md §4 の安全弁）", () => {
  it("LLM の digest が非空なら、それをそのまま使い digestSource は 'llm'", () => {
    const resolved = resolveDigest({ content: "本文", digest: "要旨" }, 200);
    expect(resolved).toEqual({ digest: "要旨", digestSource: "llm" });
  });

  it("digest が undefined ならフォールバックし digestSource は 'fallback'", () => {
    const resolved = resolveDigest({ content: "本文がここに入る", digest: undefined }, 200);
    expect(resolved.digestSource).toBe("fallback");
    expect(resolved.digest).toBe("本文がここに入る");
  });

  it("digest が空白のみならフォールバックする（LLM が空文字を返した場合と同じ扱い）", () => {
    const resolved = resolveDigest({ content: "本文", digest: "   " }, 200);
    expect(resolved.digestSource).toBe("fallback");
  });
});

describe("truncateForFallbackDigest", () => {
  it("maxLength 以下ならそのまま（末尾の … を付けない）", () => {
    expect(truncateForFallbackDigest("短い本文", 200)).toBe("短い本文");
  });

  it("maxLength を超えたら切り詰めて … を付ける", () => {
    const long = "あ".repeat(10);
    const result = truncateForFallbackDigest(long, 5);
    expect(result).toBe(`${"あ".repeat(5)}…`);
  });

  it("空文字（trim後）には固定のプレースホルダを返す（NOT NULL 制約を満たすため）", () => {
    expect(truncateForFallbackDigest("   ", 200)).toBe("（内容なし）");
  });
});

describe("buildNewMemoryFromCandidate", () => {
  const baseParams = {
    ctx,
    hashContent: (content: string) => `hash(${content})`,
    extractorVersion: "v1",
    llmModelId: "test-model",
    promptVersion: "prompt-v1",
    halfLifeHours: 720,
    now: new Date("2026-02-01T00:00:00.000Z"),
    digestFallbackLength: 200,
  };

  it("provenanceKind: 'stated' は sourceObservationId・at・speaker を持つ", () => {
    const observation = makeObservation();
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      observation,
      candidate: { content: "本文", digest: "要旨", provenanceKind: "stated" },
    });
    expect(memory.provenance).toEqual({
      kind: "stated",
      sourceObservationId: "obs-1",
      at: observation.occurredAt!.toISOString(),
      speaker: "田中",
    });
    expect(memory.sourceObservationId).toBe("obs-1");
    expect(memory.extractorVersion).toBe("v1");
    expect(memory.contentHash).toBe("hash(本文)");
    expect(memory.digestSource).toBe("llm");
    expect(memory.embeddingStatus).toBe("pending");
  });

  it("speaker が payload に無い場合、stated provenance に speaker フィールドを含めない", () => {
    const observation = makeObservation({ payload: { text: "本文のみ" } });
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      observation,
      candidate: { content: "本文", provenanceKind: "stated" },
    });
    expect(memory.provenance.kind).toBe("stated");
    expect("speaker" in memory.provenance).toBe(false);
  });

  it("provenanceKind: 'inferred' は model/promptVersion/basis/confidence を持つ", () => {
    const observation = makeObservation();
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      observation,
      candidate: { content: "推論した内容", provenanceKind: "inferred", confidence: 0.8 },
    });
    expect(memory.provenance).toEqual({
      kind: "inferred",
      model: "test-model",
      promptVersion: "prompt-v1",
      basis: { memoryIds: [], observationIds: ["obs-1"] },
      confidence: 0.8,
    });
  });

  it("provenanceKind: 'inferred' で confidence が省略されたら既定値 0.5 を使う", () => {
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      observation: makeObservation(),
      candidate: { content: "推論した内容", provenanceKind: "inferred" },
    });
    expect(memory.provenance.kind === "inferred" && memory.provenance.confidence).toBe(0.5);
  });

  it("occurredAt が無い Observation では recordedAt を freshness の起点として使う（stated.at）", () => {
    const observation = makeObservation({ occurredAt: null });
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      observation,
      candidate: { content: "本文", provenanceKind: "stated" },
    });
    expect(memory.occurredAt).toBeNull();
    expect(memory.provenance.kind === "stated" && memory.provenance.at).toBe(
      observation.recordedAt.toISOString(),
    );
  });
});

/**
 * `describeExtractionFailure`（ADR 0072 追記）の単体の歯。
 *
 * ⚠ core は provider のクラスを知らない（`instanceof` は使えない）ので、`kind` を名乗らない
 * エラーで `kind` を勝手な種類に読み替えないことを固定する。
 */
describe("describeExtractionFailure", () => {
  it("kind: string を持つオブジェクトが投げられたら、その値をそのまま kind として運ぶ", () => {
    const error = new Error("truncated") as Error & { kind: string };
    error.kind = "truncated";
    expect(describeExtractionFailure(error)).toEqual({ kind: "truncated", message: "truncated" });
  });

  it("素の Error（kind を持たない）は kind: null になる", () => {
    const error = new Error("simulated LLM outage");
    expect(describeExtractionFailure(error)).toEqual({
      kind: null,
      message: "simulated LLM outage",
    });
  });

  it("ZodError（スキーマ不適合）は kind: null、message は Error のものになる", () => {
    const schema = z.object({ memories: z.array(z.string()) });
    const parseResult = schema.safeParse({ memories: [123] });
    expect(parseResult.success).toBe(false);
    const zodError = parseResult.success ? undefined : parseResult.error;
    const result = describeExtractionFailure(zodError);
    expect(result.kind).toBeNull();
    expect(result.message).toBe(zodError!.message);
  });

  it("文字列がそのまま投げられても（非 Error）落ちず、message は String(error) 相当、kind は null", () => {
    expect(describeExtractionFailure("plain string thrown")).toEqual({
      kind: null,
      message: "plain string thrown",
    });
  });

  it("undefined が投げられても落ちず、kind は null", () => {
    expect(describeExtractionFailure(undefined)).toEqual({ kind: null, message: "undefined" });
  });

  it("null が投げられても落ちない（オプショナルチェイニングで kind を安全に読む）", () => {
    expect(describeExtractionFailure(null)).toEqual({ kind: null, message: "null" });
  });

  it("kind が空文字なら null 扱いにする（『分からない』を空文字という別の種類に読み替えない）", () => {
    const error = new Error("empty kind") as Error & { kind: string };
    error.kind = "";
    expect(describeExtractionFailure(error).kind).toBeNull();
  });

  it("kind が数値など非文字列なら null 扱いにする", () => {
    const error = new Error("numeric kind") as unknown as Error & { kind: number };
    error.kind = 42;
    expect(describeExtractionFailure(error).kind).toBeNull();
  });

  it("プレーンオブジェクト（Error ではない）が投げられても落ちず、message は String(error) 相当", () => {
    const result = describeExtractionFailure({ someField: "value" });
    expect(result.kind).toBeNull();
    expect(result.message).toBe(String({ someField: "value" }));
  });
});

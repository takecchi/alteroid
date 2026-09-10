import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";

/**
 * `LLMProvider` の決定的な擬似実装（roadmap.md 段階3・PR 本文「擬似物の扱い」）。
 *
 * **正直に書く**: これは本物の LLM を模したものではない。`packages/openai` の
 * `OpenAILLMProvider` を CI で本物に対して検査することはできない（API キーが無い）ため、
 * `runtime.ts`（core）や `packages/postgres` の実 DB 往復テストは、この決定的な擬似物に
 * 差し替えて検査する。**同じ入力には常に同じ出力を返す**（LLM 呼び出しの非決定性を
 * テストに持ち込まない）。
 *
 * この実装は `extraction.ts` の `ExtractionResultSchema`（`{ memories: [...] }`）と
 * `runtime.consolidate`（Issue #103、ADR 0089）の統合スキーマ（`{ content, digest?, tags? }`、
 * `strategies/consolidate.ts` の `ConsolidationLLMResultSchema`）の2つの形だけを知っている。
 * それ以外のスキーマを渡された場合は例外を投げる——「知らない形に遭遇したら黙って何か返す」
 * ことをしない（原則の姿3の適用）。
 *
 * ⚠ **既存の extraction 経路のふるまいは1ミリも変えていない**——下の分岐は「まず extraction の
 * 形を試し、通ればそのまま返る」という元のコードパスをそのまま保ち、通らなかった場合にだけ
 * 統合の形を試す**新しい分岐を足しただけ**である（ADR 0089 §9.3）。
 */
export class DeterministicLLMProvider implements LLMProvider {
  async complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    const lastMessage = req.messages[req.messages.length - 1];
    return { content: lastMessage?.content ?? "" };
  }

  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    const userText = req.prompt.messages.find((m) => m.role === "user")?.content ?? "";
    const digest = userText.length > 40 ? `${userText.slice(0, 40)}…` : userText;

    const extractionCandidate = {
      memories: [
        {
          content: userText,
          digest,
          tags: [],
          provenanceKind: "stated" as const,
        },
      ],
    };
    const extractionParsed = req.schema.safeParse(extractionCandidate);
    if (extractionParsed.success) {
      return extractionParsed.data;
    }

    // ADR 0089 §9.3: extraction の形にマッチしなかった場合だけ、統合の形を決定的に試す。
    // 渡された Memory の content を連結した userText を、そのまま統合結果の content として
    // 返す——意味を持たせない決定的な stub である（`deterministic` 層の役割はあくまで
    // 配線・契約の検査。AGENTS.md「provider は3層ある」参照）。
    const consolidationCandidate = { content: userText, digest, tags: [] };
    const consolidationParsed = req.schema.safeParse(consolidationCandidate);
    if (consolidationParsed.success) {
      return consolidationParsed.data;
    }

    throw new Error(
      "DeterministicLLMProvider: 未対応のスキーマが渡された（extraction.ts の " +
        "ExtractionResultSchema / runtime.consolidate の統合スキーマ以外の形には " +
        "対応していない）: " +
        consolidationParsed.error.message,
    );
  }
}

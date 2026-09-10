import { describe, expect, it } from "vitest";
import type { Ctx, LexicalStore, MemoryId, MemoryStatus, ProvenanceKind } from "@mnemora/core";

/**
 * `prepareMemory` が用意する Memory の属性。
 *
 * `VectorStoreConformanceOptions` の `PrepareMemoryIdAttrs` と違い、**`content` を必須にしている。**
 * `VectorStore` の適合テストは vector（引数で直接渡す）を検査対象にしており、Memory の `content`
 * が何であっても歯には影響しない。**`LexicalStore` はその逆——`content` そのものが検査対象**
 * （`search` が引き当てるかどうかは `content` の語彙で決まる）であり、ここを adapter の裁量に
 * 委ねると、ほぼ全ての歯が「何を検査しているか分からない」ものになる。
 *
 * `status` / `subjectId` / `provenanceKind` / `occurredAt` / `recordedAt` は
 * `PrepareMemoryIdAttrs` と同じ理由（`vector-store-conformance.ts` 参照）で任意——
 * 指定しなかった属性が何になるかは adapter の裁量に委ねる（`buildNewMemoryFixture` 相当の
 * 既定値を想定しているが、この適合テストの `filter` の歯は指定した属性だけを見るため、
 * 他の既定値には依存しない）。
 *
 * **`provenanceKind` に `"stated"`/`"inferred"` を渡さないこと。** 理由は
 * `vector-store-conformance.ts` の `PrepareMemoryIdAttrs` の doc と同じ（CHECK 制約、ADR 0056）。
 */
export interface PrepareLexicalMemoryAttrs {
  content: string;
  status?: MemoryStatus;
  subjectId?: string;
  provenanceKind?: ProvenanceKind;
  /** ADR 0039: `filter.occurredAfter`/`occurredBefore` の歯が使う。 */
  occurredAt?: Date | null;
  /** ADR 0039: `occurredAt` が `null`/未指定のときに実効時刻として使われる値。 */
  recordedAt?: Date;
}

export interface LexicalStoreConformanceOptions {
  name: string;
  createStore: () => LexicalStore | Promise<LexicalStore>;
  /**
   * 実在する `content` を持つ Memory を用意するフック。`LexicalStore` は upsert/delete を
   * 持たず（`interfaces/lexical-store.ts` のクラス doc）、postgres 実装は `memories.content`
   * そのものの上に式索引を張るので、**書き込み口は `MemoryStore` 相当の生成経路しかない**——
   * `VectorStoreConformanceOptions.prepareMemoryId` と違い、ここに `store.upsert` に対応する
   * 呼び出しは存在しない。
   *
   * **省略可のオプションにしないこと。** 省略できると「`content`/`filter` を実際に検査できる
   * adapter」と「検査できない adapter」が同じ緑色の出力になる——
   * `vector-store-conformance.ts` の `prepareMemoryId`/`prepareEmbeddingSpace` の doc と
   * 同じ理由・同じ規律をここでも繰り返す（ADR 0011/0025/0027/0028 の族）。
   */
  prepareMemory: (ctx: Ctx, attrs: PrepareLexicalMemoryAttrs) => Promise<MemoryId> | MemoryId;
}

/**
 * `LexicalStore` の適合テスト（[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)、
 * Issue #106）。
 *
 * ここで検査するのは `interfaces/lexical-store.ts` の doc が定める契約——テナント分離、
 * `filter`（`status`/`subjectId`/`excludeProvenanceKinds`/`occurredAfter`/`occurredBefore`、
 * 境界は ADR 0039 と同じ両端包含）が実際に効くこと、**返り値が `rank` の降順であること**、
 * `limit` がその上位から切ること、語彙が1つも取れないクエリで0件が返ること、
 * 語彙的に一致しない Memory が返らないこと——である。
 *
 * **`decayFloorAtAfter` は検査しない。**`LexicalFilter` はこの欄を持たない
 * （`interfaces/lexical-store.ts` の `LexicalFilter` doc、ADR 0011）。
 *
 * **`rank` の具体的な値やアルゴリズムは検査しない。**`LexicalHit.rank` は
 * adapter ごとに尺度が違うと明記されている（同ファイルの doc）——この適合テストが固定するのは
 * 「降順に並んでいる」という構造だけであり、「どの Memory が何位になるか」を期待値として
 * 書き下ろすことはしない（書けば、それは特定の adapter のランキング関数を検査対象にしてしまう）。
 * 「rank の降順」の歯を意味のあるものにするため、フィクスチャは
 * クエリ語の出現頻度が Memory ごとに大きく異なるように作る——素朴な頻度ベースの rank
 * （`InMemoryLexicalStore` が採用する形。`in-memory-lexical-store.ts` 参照）でも
 * ts_rank_cd のような頻度に敏感な rank でも、順序が偶然一致してしまう可能性を下げるため。
 */
export function describeLexicalStoreConformance(options: LexicalStoreConformanceOptions): void {
  const { name, createStore, prepareMemory } = options;

  describe(`LexicalStore conformance (${name})`, () => {
    it("content にクエリ語を含む Memory が search で見つかる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemory(ctx, { content: "obsidian shards glimmer in the cave" });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });

      expect(hits.map((hit) => hit.memoryId)).toContain(memoryId);
    });

    // -------------------------------------------------------------------
    // 語彙的に一致しない Memory は返らない。
    // -------------------------------------------------------------------

    it("クエリ語を1つも含まない Memory は返らない", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const matchingId = await prepareMemory(ctx, { content: "obsidian shards glimmer" });
      const unrelatedId = await prepareMemory(ctx, { content: "granite pillars stand quietly" });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(matchingId);
      expect(ids).not.toContain(unrelatedId);
    });

    it("クエリ語の一部しか含まない Memory は返らない（AND 意味論。websearch_to_tsquery の既定と同じ）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const bothId = await prepareMemory(ctx, { content: "obsidian shards glimmer" });
      const partialId = await prepareMemory(ctx, { content: "obsidian pillars stand" });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(bothId);
      expect(ids).not.toContain(partialId);
    });

    it("語彙が1つも取れないクエリ（空白だけ）は0件を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await prepareMemory(ctx, { content: "obsidian shards glimmer" });

      const hits = await store.search(ctx, "   ", {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });

      expect(hits).toEqual([]);
    });

    it("語彙が1つも取れないクエリ（記号だけ）は0件を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await prepareMemory(ctx, { content: "obsidian shards glimmer" });

      const hits = await store.search(ctx, "!!!---", {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });

      expect(hits).toEqual([]);
    });

    // -------------------------------------------------------------------
    // テナント分離。
    // -------------------------------------------------------------------

    it("クロステナントの search には他テナントの Memory が現れない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      await prepareMemory(ctxA, { content: "obsidian shards glimmer" });

      const hitsB = await store.search(ctxB, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-b" },
      });

      expect(hitsB).toEqual([]);
    });

    // -------------------------------------------------------------------
    // rank の降順・limit の遵守。
    //
    // フィクスチャは非対称: クエリ語の出現頻度を Memory ごとに変える
    // （1回 / 3回 / 6回）——頻度に敏感などんな rank 関数でも、3件が同じ順位に
    // 並ぶ可能性を下げるため。
    // -------------------------------------------------------------------

    it("返り値は rank の降順である", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await prepareMemory(ctx, { content: "obsidian cave" });
      await prepareMemory(ctx, { content: "obsidian obsidian obsidian cave cave cave" });
      await prepareMemory(ctx, { content: "obsidian obsidian cave cave" });

      const hits = await store.search(ctx, "obsidian cave", {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });

      expect(hits.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < hits.length; i += 1) {
        expect(hits[i - 1]!.rank).toBeGreaterThanOrEqual(hits[i]!.rank);
      }
    });

    it("limit はその上位（rank の降順の先頭）から切る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await prepareMemory(ctx, { content: "obsidian cave" });
      await prepareMemory(ctx, { content: "obsidian obsidian obsidian cave cave cave" });
      await prepareMemory(ctx, { content: "obsidian obsidian cave cave" });
      await prepareMemory(ctx, {
        content: "obsidian obsidian obsidian obsidian cave cave cave cave",
      });

      const full = await store.search(ctx, "obsidian cave", {
        limit: 100,
        filter: { tenantId: "tenant-1" },
      });
      expect(full.length).toBeGreaterThanOrEqual(4);

      const limited = await store.search(ctx, "obsidian cave", {
        limit: 2,
        filter: { tenantId: "tenant-1" },
      });

      expect(limited).toEqual(full.slice(0, 2));
    });

    // -------------------------------------------------------------------
    // filter.status。
    // -------------------------------------------------------------------

    it("filter.status: 配列に無い status の Memory は返らず、配列に在る status の Memory は返る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const activeId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        status: "active",
      });
      const archivedId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        status: "archived",
      });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1", status: ["active"] },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(activeId);
      expect(ids).not.toContain(archivedId);
    });

    // -------------------------------------------------------------------
    // filter.subjectId。
    // -------------------------------------------------------------------

    it("filter.subjectId: 別の subject の Memory は返らず、一致する subject の Memory は返る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const matchingId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        subjectId: "subject-a",
      });
      const otherId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        subjectId: "subject-b",
      });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1", subjectId: "subject-a" },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(matchingId);
      expect(ids).not.toContain(otherId);
    });

    // -------------------------------------------------------------------
    // filter.excludeProvenanceKinds（ADR 0056）。
    // -------------------------------------------------------------------

    it("filter.excludeProvenanceKinds: 配列に在る kind の Memory は返らず、無い kind の Memory は返る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const excludedId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        provenanceKind: "consolidated",
      });
      const keptId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        provenanceKind: "imported",
      });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1", excludeProvenanceKinds: ["consolidated"] },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).not.toContain(excludedId);
      expect(ids).toContain(keptId);
    });

    it("filter.excludeProvenanceKinds: [] は no-op（両方とも返る）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const idA = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        provenanceKind: "consolidated",
      });
      const idB = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        provenanceKind: "imported",
      });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1", excludeProvenanceKinds: [] },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(idA);
      expect(ids).toContain(idB);
    });

    // -------------------------------------------------------------------
    // filter.occurredAfter / occurredBefore（ADR 0039: 両端とも包含 `>=`/`<=`）。
    // -------------------------------------------------------------------

    it("filter.occurredAfter: 境界と*ちょうど同じ* occurredAt は含まれ（`>=`）、境界より前は除外される", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const boundary = new Date("2026-01-01T00:00:00.000Z");
      const onBoundaryId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        occurredAt: boundary,
      });
      const beforeBoundaryId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        occurredAt: new Date(boundary.getTime() - 1000),
      });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1", occurredAfter: boundary },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(onBoundaryId);
      expect(ids).not.toContain(beforeBoundaryId);
    });

    it("filter.occurredBefore: 境界と*ちょうど同じ* occurredAt は含まれ（`<=`）、境界より後は除外される", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const boundary = new Date("2026-01-01T00:00:00.000Z");
      const onBoundaryId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        occurredAt: boundary,
      });
      const afterBoundaryId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        occurredAt: new Date(boundary.getTime() + 1000),
      });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1", occurredBefore: boundary },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(onBoundaryId);
      expect(ids).not.toContain(afterBoundaryId);
    });

    it("filter.occurredAfter/occurredBefore は occurredAt が null のとき recordedAt を実効時刻として使う（COALESCE。ADR 0039）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const boundary = new Date("2026-01-01T00:00:00.000Z");
      const insideByRecordedAtId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        occurredAt: null,
        recordedAt: new Date(boundary.getTime() + 1000),
      });
      const outsideByRecordedAtId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        occurredAt: null,
        recordedAt: new Date(boundary.getTime() - 1000),
      });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1", occurredAfter: boundary },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(insideByRecordedAtId);
      expect(ids).not.toContain(outsideByRecordedAtId);
    });

    it("filter は複数同時に渡すと AND になる（どれか1つが不一致なら返らない）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const bothMatchId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        status: "active",
        subjectId: "subject-a",
      });
      const statusOnlyMatchId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        status: "active",
        subjectId: "subject-b",
      });
      const subjectOnlyMatchId = await prepareMemory(ctx, {
        content: "obsidian shards glimmer",
        status: "archived",
        subjectId: "subject-a",
      });

      const hits = await store.search(ctx, "obsidian shards", {
        limit: 10,
        filter: { tenantId: "tenant-1", status: ["active"], subjectId: "subject-a" },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(bothMatchId);
      expect(ids).not.toContain(statusOnlyMatchId);
      expect(ids).not.toContain(subjectOnlyMatchId);
    });
  });
}

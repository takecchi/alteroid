import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  Ctx,
  EmbeddingSpaceId,
  MemoryId,
  MemoryStatus,
  ProvenanceKind,
  VectorStore,
} from "@mnemora/core";

/**
 * `prepareMemoryId` が用意する Memory の属性。指定しなかった属性が何になるかは
 * adapter の裁量に委ねる（`packages/testkit` の `buildNewMemoryFixture` 相当の既定値、
 * 具体的には `status: "active"` / `subjectId: null` / `decayFloorAt` は
 * `defaultDecayStrategy.floorAt` の計算結果、`provenance.kind` は `"imported"`、を
 * 想定しているが、この適合テストの `filter` の歯は指定した属性だけを見るため、
 * 他の既定値には依存しない）。
 *
 * **`provenanceKind` に `"stated"`/`"inferred"` を渡さないこと。** この2つは
 * `memories` の CHECK 制約（`packages/postgres/migrations/0001_init.sql:68`）により
 * `source_observation_id` を実在の Observation に向けなければならず、この適合テストの
 * フィクスチャはそこまで用意していない（ADR 0056）。この適合テストが実際に使うのは
 * その制約を要らない kind（`"imported"`/`"consolidated"` など）に限る。
 */
export interface PrepareMemoryIdAttrs {
  status?: MemoryStatus;
  subjectId?: string;
  decayFloorAt?: Date;
  provenanceKind?: ProvenanceKind;
  /**
   * ADR 0059: `filter.occurredAfter`/`occurredBefore` の歯が使う。指定しなければ
   * `buildNewMemoryFixture` の既定（`null`）——`COALESCE(occurred_at, recorded_at)` の
   * フォールバック（`recordedAt`）を検査する歯は、これを指定せず `recordedAt` だけ渡す。
   */
  occurredAt?: Date | null;
  /** ADR 0059: `occurredAt` が `null`/未指定のときに実効時刻として使われる値。 */
  recordedAt?: Date;
}

export interface VectorStoreConformanceOptions {
  name: string;
  createStore: () => VectorStore | Promise<VectorStore>;
  /**
   * `packages/postgres` の `memory_embeddings_<space>` テーブルは `memory_id` を
   * `memories(id)` への外部キーにしている（docs/memory-model.md §10）。この適合テストは
   * `VectorStore` 単体を検査するが、外部キーを持つ adapter のために「実在の Memory の id を
   * 用意する」フックを持つ。
   *
   * **`attrs` を渡したときは、指定した属性を持つ Memory を用意すること。** `attrs` を
   * 渡さなかったときにどんな属性になるかは adapter の裁量（`PrepareMemoryIdAttrs` の
   * doc コメント参照。この適合テストの `filter` の歯は指定した属性だけを見るため、
   * 未指定時の既定値がどうであれ歯の結果には影響しない）。
   *
   * `filter.status` / `filter.subjectId` / `filter.decayFloorAtAfter` の契約（ADR 0034、
   * `packages/core/src/interfaces/vector-store.ts`）を検査するには、`VectorStore.search` の
   * 相手になる Memory がどんな属性を持つかをテスト側から指定できる必要がある——
   * `memory-store-conformance.ts` の `listEventsForMemory`、`outbox-store-conformance.ts` の
   * `seedJob` と同じ理由（`MemoryStore`/`VectorStore` それ自体には無い操作を、適合テストの
   * ためだけに adapter へ用意させるフック）。
   *
   * **省略可のオプションにしないこと。** 省略できると「`filter` を実際に検査できる
   * adapter」と「検査できない adapter」が同じ緑色の出力になる——このリポジトリが
   * ADR 0011/0025/0027/0028 で繰り返した族の失敗を、フックの省略という形で
   * 再現することになる。`listEventsForMemory` の doc コメントに同じ理由が書いてある。
   */
  prepareMemoryId: (ctx: Ctx, attrs?: PrepareMemoryIdAttrs) => Promise<MemoryId> | MemoryId;
}

const space: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 };

/**
 * `VectorStore` の適合テスト（docs/architecture.md §5.2）。
 *
 * ここで検査するのは `VectorStore` の基本契約——upsert/search/delete の往復、
 * テナント分離、limit の遵守、そして `filter`（`status`/`subjectId`/`decayFloorAtAfter`/
 * `excludeProvenanceKinds`/`occurredAfter`/`occurredBefore`）が実際に効くこと
 * （ADR 0034、`excludeProvenanceKinds` は ADR 0056、`occurredAfter`/`occurredBefore` は
 * ADR 0059）——である。`EXPLAIN` で HNSW 索引が使われることの検査
 * （roadmap.md 段階2の完了条件）は pgvector 固有の関心事であり、`packages/postgres` 側の
 * テスト（生 SQL・`EXPLAIN` を直接扱う）に置く。
 */
export function describeVectorStoreConformance(options: VectorStoreConformanceOptions): void {
  const { name, createStore, prepareMemoryId } = options;

  describe(`VectorStore conformance (${name})`, () => {
    it("upsert した vector が search で見つかる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);

      await store.upsert(ctx, space, memoryId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });

      expect(hits.map((hit) => hit.memoryId)).toContain(memoryId);
    });

    it("同じ memoryId に対する2度目の upsert は行を増やさず、ベクトルを更新する", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);

      await store.upsert(ctx, space, memoryId, [1, 0, 0]);
      await store.upsert(ctx, space, memoryId, [0, 1, 0]);

      const hits = await store.search(ctx, space, [0, 1, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });
      const matches = hits.filter((hit) => hit.memoryId === memoryId);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.distance).toBeCloseTo(0, 5);
    });

    it("distance はコサイン距離である（ユークリッド距離では出ない順序・値になる組で検査する）", async () => {
      // q/A/B は「向きの違いを無視するコサイン」と「長さの違いも見るユークリッド」が
      // *逆の順序*を出すように選んだ組（呼び出し元の指示に基づく検算済みの値）。
      //   q = [1,0,0], A = [10,0,0]（向きは q と同じ、長さは10倍）, B = [1,1,0]
      //   コサイン距離: A=0, B=1-1/√2≈0.2928932 → 順序は A→B
      //   ユークリッド距離: A=9, B=1                → 順序は B→A（逆転する）
      // ⟹ A が B より先に返ることは、実装がコサインでありユークリッドでないことの
      // 直接の証拠になる。全成分0のベクトルはコサインが未定義になるため使わない
      // （packages/postgres/src/bench/scale-bench.ts:667 と同じ注意）。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const idA = await prepareMemoryId(ctx);
      const idB = await prepareMemoryId(ctx);

      await store.upsert(ctx, space, idA, [10, 0, 0]);
      await store.upsert(ctx, space, idB, [1, 1, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });
      const ids = hits.map((hit) => hit.memoryId);

      // 順序の歯: ユークリッドなら B が先になる組であり、A が先に返ることを検査する。
      expect(ids.indexOf(idA)).toBeLessThan(ids.indexOf(idB));

      // 値の歯: 期待値はリテラル（コサイン距離の式を独立に計算した結果）であり、
      // 実装側の距離関数を呼んで作ったものではない——検査対象と期待値が同じ関数を
      // 共有すると、両方が一緒に壊れて変異が素通りする。
      const hitA = hits.find((hit) => hit.memoryId === idA);
      const hitB = hits.find((hit) => hit.memoryId === idB);
      expect(hitA?.distance).toBeCloseTo(0, 5);
      expect(hitB?.distance).toBeCloseTo(1 - 1 / Math.sqrt(2), 5);
    });

    it("⚠ ゼロベクトルの候補は、どんな閾値とも比較が通らない距離になる（ADR 0040）", async () => {
      // **契約は「ゼロベクトルが絡む候補は recall() の結果に出ない」である。**
      // adapter がどんな値を返すかは自由だが、**下流の `total >= scoreThreshold` を
      // どんな閾値でも通らない値**でなければ契約を満たせない。
      // ⟹ ここでは「返した distance が `>= 0` の比較を通らないこと」を見る。
      // 実装が `NaN` を返すか別の値を返すかには踏み込まない。
      //
      // ⚠ 例外を投げないことも同時に見る。pgvector 0.8.2 の `<=>` は
      // **エラーにならず NaN を返す**（本 ADR で実測。以前は「エラーになる」と
      // 3箇所に書かれていたが誤りだった）。
      //
      // フィクスチャは非対称: ゼロベクトルの候補1件に対し、正常な候補を2件置く。
      // 正常な候補が返ることを同時に見ないと、「search が常に空を返す」実装が通る。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const zeroId = await prepareMemoryId(ctx);
      const okId1 = await prepareMemoryId(ctx);
      const okId2 = await prepareMemoryId(ctx);

      await store.upsert(ctx, space, zeroId, [0, 0, 0]);
      await store.upsert(ctx, space, okId1, [1, 0, 0]);
      await store.upsert(ctx, space, okId2, [0, 1, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });

      // 正常な候補2件は、比較の通る距離で返る（前提が成り立っていることの確認）。
      const ok1 = hits.find((h) => h.memoryId === okId1);
      const ok2 = hits.find((h) => h.memoryId === okId2);
      expect(ok1?.distance).toBeCloseTo(0, 5);
      expect(ok2?.distance).toBeCloseTo(1, 5);

      // ゼロベクトルの候補は、返ってきたとしても比較が通らない。
      const zero = hits.find((h) => h.memoryId === zeroId);
      if (zero !== undefined) {
        expect(zero.distance >= 0).toBe(false);
        expect(zero.distance <= 0).toBe(false);
      }
    });

    it("クロステナントの search には他テナントの vector が現れない", async () => {
      const store = await createStore();
      const ctxA: Ctx = { tenantId: "tenant-a" };
      const ctxB: Ctx = { tenantId: "tenant-b" };
      const memoryId = await prepareMemoryId(ctxA);

      await store.upsert(ctxA, space, memoryId, [1, 0, 0]);

      const hitsB = await store.search(ctxB, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-b" },
      });

      expect(hitsB).toEqual([]);
    });

    it("delete した vector は search に現れなくなる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId = await prepareMemoryId(ctx);

      await store.upsert(ctx, space, memoryId, [1, 0, 0]);
      await store.delete(ctx, space, memoryId);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1" },
      });

      expect(hits.map((hit) => hit.memoryId)).not.toContain(memoryId);
    });

    // -------------------------------------------------------------------
    // delete（族A: 契約は void・「無ければ何もしない」——形式不正な memoryId も
    // 例外を投げず何もしない。packages/postgres/src/mapping.ts の isUuidLike の
    // doc コメントが定める基準そのもの: 「存在しない」と「壊れた入力」を区別せずに
    // 済ませたい口では、クエリを投げる前に判定し、DB 由来のエラーを漏らさない。
    //
    // ⚠ 3つを並べて見る: 形式不正 / well-formed だが実在しない / 実在する
    // （実在するほうは直前の「delete した vector は search に現れなくなる」で
    // 既に検査済み）。
    // -------------------------------------------------------------------

    it("delete は形式不正な memoryId に対して例外を投げない（no-op）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.delete(ctx, space, "does-not-exist")).resolves.toBeUndefined();
    });

    it("delete は well-formed だが実在しない memoryId に対して例外を投げない（no-op）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      await expect(store.delete(ctx, space, randomUUID())).resolves.toBeUndefined();
    });

    it("search は limit を超えない件数を返す", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const memoryId1 = await prepareMemoryId(ctx);
      const memoryId2 = await prepareMemoryId(ctx);
      const memoryId3 = await prepareMemoryId(ctx);

      await store.upsert(ctx, space, memoryId1, [1, 0, 0]);
      await store.upsert(ctx, space, memoryId2, [0, 1, 0]);
      await store.upsert(ctx, space, memoryId3, [0, 0, 1]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 2,
        filter: { tenantId: "tenant-1" },
      });

      expect(hits.length).toBeLessThanOrEqual(2);
    });

    it("filter.status: 配列に無い status の Memory は返らず、配列に在る status の Memory は返る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const activeId = await prepareMemoryId(ctx, { status: "active" });
      const archivedId = await prepareMemoryId(ctx, { status: "archived" });

      await store.upsert(ctx, space, activeId, [1, 0, 0]);
      await store.upsert(ctx, space, archivedId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", status: ["active"] },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(activeId);
      expect(ids).not.toContain(archivedId);
    });

    it("filter.subjectId: 別の subject の Memory は返らず、一致する subject の Memory は返る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const matchingId = await prepareMemoryId(ctx, { subjectId: "subject-a" });
      const otherId = await prepareMemoryId(ctx, { subjectId: "subject-b" });

      await store.upsert(ctx, space, matchingId, [1, 0, 0]);
      await store.upsert(ctx, space, otherId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", subjectId: "subject-a" },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(matchingId);
      expect(ids).not.toContain(otherId);
    });

    // -------------------------------------------------------------------
    // filter.excludeProvenanceKinds（ADR 0056）: status とは向きが逆の「除外」の列挙。
    // 使う kind は CHECK 制約を要らないもの（"imported"/"consolidated"）に限る
    // （`PrepareMemoryIdAttrs` の doc コメント参照）。
    // -------------------------------------------------------------------

    it("filter.excludeProvenanceKinds: 配列に在る kind の Memory は返らず、無い kind の Memory は返る", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const excludedId = await prepareMemoryId(ctx, { provenanceKind: "consolidated" });
      const keptId = await prepareMemoryId(ctx, { provenanceKind: "imported" });

      await store.upsert(ctx, space, excludedId, [1, 0, 0]);
      await store.upsert(ctx, space, keptId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", excludeProvenanceKinds: ["consolidated"] },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).not.toContain(excludedId);
      expect(ids).toContain(keptId);
    });

    it("filter.excludeProvenanceKinds: [] は no-op（status: [] とは非対称——両方とも返る）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const idA = await prepareMemoryId(ctx, { provenanceKind: "consolidated" });
      const idB = await prepareMemoryId(ctx, { provenanceKind: "imported" });

      await store.upsert(ctx, space, idA, [1, 0, 0]);
      await store.upsert(ctx, space, idB, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", excludeProvenanceKinds: [] },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(idA);
      expect(ids).toContain(idB);
    });

    it("filter.excludeProvenanceKinds は他の filter（status）と AND になる", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const passesBothId = await prepareMemoryId(ctx, {
        status: "active",
        provenanceKind: "imported",
      });
      const excludedByProvenanceId = await prepareMemoryId(ctx, {
        status: "active",
        provenanceKind: "consolidated",
      });
      const excludedByStatusId = await prepareMemoryId(ctx, {
        status: "archived",
        provenanceKind: "imported",
      });

      await store.upsert(ctx, space, passesBothId, [1, 0, 0]);
      await store.upsert(ctx, space, excludedByProvenanceId, [1, 0, 0]);
      await store.upsert(ctx, space, excludedByStatusId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: {
          tenantId: "tenant-1",
          status: ["active"],
          excludeProvenanceKinds: ["consolidated"],
        },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(passesBothId);
      expect(ids).not.toContain(excludedByProvenanceId);
      expect(ids).not.toContain(excludedByStatusId);
    });

    it("filter.decayFloorAtAfter: 境界と*ちょうど同じ* decayFloorAt は除外され、境界より後は返る（狭義の `>`）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const boundary = new Date("2026-01-01T00:00:00.000Z");
      const onBoundaryId = await prepareMemoryId(ctx, { decayFloorAt: boundary });
      const afterBoundaryId = await prepareMemoryId(ctx, {
        decayFloorAt: new Date(boundary.getTime() + 1000),
      });

      await store.upsert(ctx, space, onBoundaryId, [1, 0, 0]);
      await store.upsert(ctx, space, afterBoundaryId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", decayFloorAtAfter: boundary },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).not.toContain(onBoundaryId);
      expect(ids).toContain(afterBoundaryId);
    });

    // -------------------------------------------------------------------
    // filter.occurredAfter / occurredBefore（ADR 0059）: 両端とも包含（`>=`/`<=`）。
    // ADR 0039 が固定した period の判定規則（境界を含む）を、段1（VectorStore）の
    // 場所でも同じ境界で固定する——ここが5箇所目の判定箇所になる。
    // -------------------------------------------------------------------

    it("filter.occurredAfter: 境界と*ちょうど同じ* occurredAt は含まれ（`>=`）、境界より前は除外される", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const boundary = new Date("2026-01-01T00:00:00.000Z");
      const onBoundaryId = await prepareMemoryId(ctx, { occurredAt: boundary });
      const beforeBoundaryId = await prepareMemoryId(ctx, {
        occurredAt: new Date(boundary.getTime() - 1000),
      });

      await store.upsert(ctx, space, onBoundaryId, [1, 0, 0]);
      await store.upsert(ctx, space, beforeBoundaryId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
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
      const onBoundaryId = await prepareMemoryId(ctx, { occurredAt: boundary });
      const afterBoundaryId = await prepareMemoryId(ctx, {
        occurredAt: new Date(boundary.getTime() + 1000),
      });

      await store.upsert(ctx, space, onBoundaryId, [1, 0, 0]);
      await store.upsert(ctx, space, afterBoundaryId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", occurredBefore: boundary },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(onBoundaryId);
      expect(ids).not.toContain(afterBoundaryId);
    });

    it("filter.occurredAfter/occurredBefore は occurredAt が null のとき recordedAt を実効時刻として使う（COALESCE。ADR 0039）", async () => {
      // occurredAt を渡さず recordedAt だけを渡す——`occurred_at IS NULL` の行で
      // `COALESCE(occurred_at, recorded_at)` が実際に効いていることを見る。
      // `COALESCE` を外して `occurred_at` 単独の比較に差し替える変異は、この歯を
      // 落とす（occurredAt が null の候補は、その変異の下では常に条件不成立になる）。
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };
      const boundary = new Date("2026-01-01T00:00:00.000Z");
      const insideByRecordedAtId = await prepareMemoryId(ctx, {
        occurredAt: null,
        recordedAt: new Date(boundary.getTime() + 1000),
      });
      const outsideByRecordedAtId = await prepareMemoryId(ctx, {
        occurredAt: null,
        recordedAt: new Date(boundary.getTime() - 1000),
      });

      await store.upsert(ctx, space, insideByRecordedAtId, [1, 0, 0]);
      await store.upsert(ctx, space, outsideByRecordedAtId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
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
      const bothMatchId = await prepareMemoryId(ctx, { status: "active", subjectId: "subject-a" });
      const statusOnlyMatchId = await prepareMemoryId(ctx, {
        status: "active",
        subjectId: "subject-b",
      });
      const subjectOnlyMatchId = await prepareMemoryId(ctx, {
        status: "archived",
        subjectId: "subject-a",
      });

      await store.upsert(ctx, space, bothMatchId, [1, 0, 0]);
      await store.upsert(ctx, space, statusOnlyMatchId, [1, 0, 0]);
      await store.upsert(ctx, space, subjectOnlyMatchId, [1, 0, 0]);

      const hits = await store.search(ctx, space, [1, 0, 0], {
        limit: 10,
        filter: { tenantId: "tenant-1", status: ["active"], subjectId: "subject-a" },
      });
      const ids = hits.map((hit) => hit.memoryId);

      expect(ids).toContain(bothMatchId);
      expect(ids).not.toContain(statusOnlyMatchId);
      expect(ids).not.toContain(subjectOnlyMatchId);
    });

    // -------------------------------------------------------------------
    // 外部キー相当（ADR 0047）: `memory_embeddings_<space>.memory_id → memories(id)`。
    // **存在だけ**を見る。
    //
    // ⚠ `.rejects.toThrow()` を引数なしで使っている理由は
    // `memory-store-conformance.ts` の同種の節と同じ（メッセージの一致ではなく
    // 「実在しない参照では必ず失敗する」ことを見る）。
    // -------------------------------------------------------------------

    it("upsert は実在しない memoryId に対して失敗し、実在する memoryId では成功する（外部キー、ADR 0047）", async () => {
      const store = await createStore();
      const ctx: Ctx = { tenantId: "tenant-1" };

      await expect(store.upsert(ctx, space, randomUUID(), [1, 0, 0])).rejects.toThrow();

      const memoryId = await prepareMemoryId(ctx);
      await expect(store.upsert(ctx, space, memoryId, [1, 0, 0])).resolves.toBeUndefined();
    });
  });
}

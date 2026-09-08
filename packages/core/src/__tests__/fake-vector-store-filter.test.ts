import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeVectorStore`（`packages/core` 自身の runtime テスト用フェイク、`runtime-fakes.ts`）が
 * `VectorFilter` の契約（ADR 0034、`packages/core/src/interfaces/vector-store.ts` の doc）を
 * 実際に守っていることを検査する歯。
 *
 * **`packages/testkit` の `vector-store-conformance.ts` の対象ではない。** `FakeVectorStore` は
 * adapter 適合テストの対象である `VectorStore` 実装（`InMemoryVectorStore`/
 * `PostgresVectorStore`）ではなく、`packages/core` 自身の runtime テスト専用の別系統
 * （`runtime-fakes.ts` 冒頭のコメント: core は testkit に依存しない）。ADR 0034 はこの
 * `FakeVectorStore` を「範囲外・別系統」として明示的に残しており（採らなかった案の節）、
 * 本テストはその残された穴を `packages/core` 側で埋める。
 *
 * 置く歯はすべて非対称——「除外される側」と「残る側」を同じ検査の中で押さえる。
 * 片方だけだと、全部返す実装／全部返さない実装のどちらかを緑にしてしまう。
 *
 * 期待値の導出について: `decayFloorAtAfter` の境界は `defaultDecayStrategy.floorAt` などの
 * 実装側関数からではなく、このファイル内のリテラルな `Date` から作る——検査対象
 * （`FakeVectorStore.search`）と期待値が同じ関数を共有すると、両方が一緒に壊れて
 * 変異が素通りする。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const space = { provider: "test", model: "fixture-model", dimensions: 3 };
/** ADR 0065: 「space 分離」の歯専用の、`space` とは別の embedding space。 */
const spaceB = { provider: "test", model: "fixture-model-b", dimensions: 3 };

let contentHashCounter = 0;

/** `recall-pipeline.test.ts` の `newMemory` と似た形だが、意図的に独立したコピー
 * （ファイル冒頭のコメント: `FakeVectorStore` はこの系統の別テストと結合させない）。 */
function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    // decayFloorAt はテストごとにリテラルな Date で指定する。既定値は「遠い過去」——
    // decayFloorAtAfter を指定しない歯では常に生き残らせるため。
    decayFloorAt: new Date("2020-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
    ...overrides,
  };
}

describe("FakeVectorStore — VectorFilter の契約（ADR 0034）", () => {
  it("filter.status: 配列に無い status の Memory は返らず、配列に在る status の Memory は返る", async () => {
    const stores = createFakeRuntimeStores();
    const active = await stores.memoryStore.createMemory(ctx, newMemory({ status: "active" }));
    const archived = await stores.memoryStore.createMemory(ctx, newMemory({ status: "archived" }));
    await stores.vectorStore.upsert(ctx, space, active.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, archived.id, [1, 0, 0]);

    const hits = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "tenant-1", status: ["active"] },
    });
    const ids = hits.map((hit) => hit.memoryId);

    expect(ids).toContain(active.id);
    expect(ids).not.toContain(archived.id);
  });

  it("filter.subjectId: 一致しない subject の Memory は返らず、一致する subject の Memory は返る", async () => {
    const stores = createFakeRuntimeStores();
    const matching = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ subjectId: "subject-a" }),
    );
    const other = await stores.memoryStore.createMemory(ctx, newMemory({ subjectId: "subject-b" }));
    await stores.vectorStore.upsert(ctx, space, matching.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, other.id, [1, 0, 0]);

    const hits = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "tenant-1", subjectId: "subject-a" },
    });
    const ids = hits.map((hit) => hit.memoryId);

    expect(ids).toContain(matching.id);
    expect(ids).not.toContain(other.id);
  });

  it("filter.decayFloorAtAfter: 境界と*ちょうど同じ* decayFloorAt は除外され、境界より後は返る（狭義の `>`）", async () => {
    const stores = createFakeRuntimeStores();
    const boundary = new Date("2026-03-15T00:00:00.000Z");
    const onBoundary = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(boundary.getTime()) }),
    );
    const afterBoundary = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(boundary.getTime() + 1000) }),
    );
    await stores.vectorStore.upsert(ctx, space, onBoundary.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, afterBoundary.id, [1, 0, 0]);

    const hits = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "tenant-1", decayFloorAtAfter: boundary },
    });
    const ids = hits.map((hit) => hit.memoryId);

    expect(ids).not.toContain(onBoundary.id);
    expect(ids).toContain(afterBoundary.id);
  });

  it("filter.occurredBefore: 境界と*ちょうど同じ* occurredAt は返り、境界より後は除外される（両端とも包含 `<=`。ADR 0059）", async () => {
    const stores = createFakeRuntimeStores();
    const boundary = new Date("2026-05-01T00:00:00.000Z");
    const onBoundary = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ occurredAt: new Date(boundary.getTime()) }),
    );
    const afterBoundary = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ occurredAt: new Date(boundary.getTime() + 1000) }),
    );
    await stores.vectorStore.upsert(ctx, space, onBoundary.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, afterBoundary.id, [1, 0, 0]);

    const hits = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      // 🔑 occurredBefore だけを渡す。occurredAfter は渡さない
      // ——下限側の変異に対してもこの歯が緑のままであるために必須。
      filter: { tenantId: "tenant-1", occurredBefore: boundary },
    });
    const ids = hits.map((hit) => hit.memoryId);

    // decayFloorAtAfter（狭義の `>`、上のテスト）とは含み方が逆――
    // occurredBefore は境界ちょうどを含む（`<=`）。
    expect(ids).toContain(onBoundary.id);
    expect(ids).not.toContain(afterBoundary.id);
  });

  it("filter は複数同時に渡すと AND になる（どれか1つが不一致なら返らない）", async () => {
    const stores = createFakeRuntimeStores();
    const bothMatch = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", subjectId: "subject-a" }),
    );
    const statusOnlyMatch = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "active", subjectId: "subject-b" }),
    );
    const subjectOnlyMatch = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ status: "archived", subjectId: "subject-a" }),
    );
    await stores.vectorStore.upsert(ctx, space, bothMatch.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, statusOnlyMatch.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, subjectOnlyMatch.id, [1, 0, 0]);

    const hits = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "tenant-1", status: ["active"], subjectId: "subject-a" },
    });
    const ids = hits.map((hit) => hit.memoryId);

    expect(ids).toContain(bothMatch.id);
    expect(ids).not.toContain(statusOnlyMatch.id);
    expect(ids).not.toContain(subjectOnlyMatch.id);
  });
});

/**
 * `FakeVectorStore.search` が space（`provider`/`model`/`dimensions`）で絞ることを
 * 検査する歯（ADR 0065）。
 *
 * `packages/testkit` の `vector-store-conformance.ts` に足した同じ形の歯
 * （「space が違う vector は同一 tenant の search でも混同されない」）の、`packages/core`
 * 側の対応物——`FakeVectorStore` は adapter 適合テストが届かない別系統
 * （`packages/core` は `@mnemora/testkit` を import できない、`dependency-boundary.test.ts`）
 * なので、ここに自前で置く。
 *
 * フィクスチャは非対称: space A に2件、space B に1件、ベクトルも別。「変わらない」
 * （B の search に A が出ない）だけでなく「変わる」（B の search で B 自身が返る）も
 * 同じ歯の中で固定する——そうしないと「search が常に空を返す」実装でも緑になる
 * （上の ADR 0040 の歯・`vector-store-conformance.ts` と同じ理由）。
 */
describe("FakeVectorStore.search — space 分離（ADR 0065）", () => {
  it("space が違う vector は同一 tenant の search でも混同されない（非対称フィクスチャ）", async () => {
    const stores = createFakeRuntimeStores();
    const a1 = await stores.memoryStore.createMemory(ctx, newMemory());
    const a2 = await stores.memoryStore.createMemory(ctx, newMemory());
    const b1 = await stores.memoryStore.createMemory(ctx, newMemory());

    await stores.vectorStore.upsert(ctx, space, a1.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, a2.id, [0, 1, 0]);
    await stores.vectorStore.upsert(ctx, spaceB, b1.id, [0, 0, 1]);

    // space A で search したら、space A の2件だけが返る（B は混ざらない）。
    const hitsA = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "tenant-1" },
    });
    const idsA = hitsA.map((hit) => hit.memoryId);
    expect(idsA).toContain(a1.id);
    expect(idsA).toContain(a2.id);
    expect(idsA).not.toContain(b1.id);

    // 「変わる」側: space B で search したら、B 自身の1件が返る
    // （A が2件とも返らないことも同時に見る）。
    const hitsB = await stores.vectorStore.search(ctx, spaceB, [0, 0, 1], {
      limit: 10,
      filter: { tenantId: "tenant-1" },
    });
    const idsB = hitsB.map((hit) => hit.memoryId);
    expect(idsB).toContain(b1.id);
    expect(idsB).not.toContain(a1.id);
    expect(idsB).not.toContain(a2.id);
  });
});

/**
 * `FakeVectorStore.search`（`cosineDistance` 経由）が ADR 0040 の契約を守っていることを
 * 検査する歯。
 *
 * ADR 0040 の「引き受ける負債」節が名指ししているとおり、`FakeVectorStore.cosineDistance` は
 * 本 ADR の対象外として `1` を返したまま残されていた（`packages/core` は `packages/testkit` の
 * `vector-store-conformance.ts` の適合テストが届かない別系統——`dependency-boundary.test.ts` が
 * core の実行時依存を zod だけに固定しており、core は testkit を import できない）。
 * ここではその適合テストと同じ形の歯を `packages/core` 側に自前で置く。
 *
 * **`Number.isNaN` で等値を見ない。** 見るのは「返ってきた distance がどんな閾値とも比較が
 * 通らないこと」——`distance >= 0` も `distance <= 0` も false であること。実装が `NaN` を
 * 返すという詳細ではなく、ADR 0040 が定めた契約（振る舞い）を検査する
 * （`vector-store-conformance.ts` の「⚠ ゼロベクトルの候補は、どんな閾値とも比較が通らない
 * 距離になる（ADR 0040）」と同じ理由・同じ形）。
 *
 * フィクスチャは非対称: ゼロベクトルの候補1件に対し、正常な候補を2件置く。正常な候補が
 * 比較の通る距離で返ることを同時に見ないと、「search が常に空を返す」実装が通ってしまう。
 */
describe("FakeVectorStore.search — ゼロベクトルの契約（ADR 0040）", () => {
  it("⚠ ゼロベクトルの候補は、どんな閾値とも比較が通らない距離になり、例外も投げない", async () => {
    const stores = createFakeRuntimeStores();
    const zero = await stores.memoryStore.createMemory(ctx, newMemory());
    const ok1 = await stores.memoryStore.createMemory(ctx, newMemory());
    const ok2 = await stores.memoryStore.createMemory(ctx, newMemory());

    await stores.vectorStore.upsert(ctx, space, zero.id, [0, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, ok1.id, [1, 0, 0]);
    await stores.vectorStore.upsert(ctx, space, ok2.id, [0, 1, 0]);

    const hits = await stores.vectorStore.search(ctx, space, [1, 0, 0], {
      limit: 10,
      filter: { tenantId: "tenant-1" },
    });

    // 正常な候補2件は、比較の通る距離で返る（前提が成り立っていることの確認）。
    const hitOk1 = hits.find((hit) => hit.memoryId === ok1.id);
    const hitOk2 = hits.find((hit) => hit.memoryId === ok2.id);
    expect(hitOk1?.distance).toBeCloseTo(0, 5);
    expect(hitOk2?.distance).toBeCloseTo(1, 5);

    // ゼロベクトルの候補は、返ってきたとしても比較が通らない。
    const hitZero = hits.find((hit) => hit.memoryId === zero.id);
    if (hitZero !== undefined) {
      expect(hitZero.distance >= 0).toBe(false);
      expect(hitZero.distance <= 0).toBe(false);
    }
  });
});

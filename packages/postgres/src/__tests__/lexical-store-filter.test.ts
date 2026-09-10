import type { Ctx } from "@mnemora/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture, buildProvenanceFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `LexicalFilter` の各フィールドが `PostgresLexicalStore.search` で実際に効くことの実測
 * （ADR 0084、Issue #106）。`packages/postgres/src/__tests__/vector-search-subject.test.ts` /
 * `vector-search-provenance.test.ts`（`VectorFilter` の同種の歯）の作法に倣う——
 * ただし `LexicalStore` は ANN の「over-fetch の窓」という構造を持たないため、
 * ここでは crowd/small のような窓落ちの実演はせず、「絞ると消える/絞らないと残る」を
 * 直接確認する形にしている。
 *
 * `occurredAfter`/`occurredBefore` の境界は ADR 0039（両端包含、`>=`/`<=`、
 * `COALESCE(occurred_at, recorded_at)`）——`vector-store.ts` の period 押し下げと
 * 同じ境界であることを、同じ形の歯で確認する
 * （`packages/testkit/src/vector-store-conformance.ts` の同種の歯と同型）。
 *
 * 全ての歯で共通のクエリ語 "obsidian shards" を使い、`content` にその語を含めることで
 * 語彙一致自体は常に成立させ、`filter` だけが結果を左右するようにしている——語彙一致と
 * filter の効果を混同しないため。
 */

const TENANT = "lexical-filter-tenant";
const QUERY = "obsidian shards";
const MATCHING_CONTENT = "obsidian shards glimmer in the cave";

describe("PostgresLexicalStore.search — LexicalFilter の各フィールド", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("filter.status: 配列に無い status の Memory は返らず、配列に在る status の Memory は返る", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const active = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-status-active",
        content: MATCHING_CONTENT,
        status: "active",
      }),
    );
    const archived = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-status-archived",
        content: MATCHING_CONTENT,
        status: "archived",
      }),
    );

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, status: ["active"] },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(active.id);
    expect(ids).not.toContain(archived.id);
  });

  it("filter.subjectId: 別の subject の Memory は返らず、一致する subject の Memory は返る", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const matching = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-subject-a",
        content: MATCHING_CONTENT,
        subjectId: "subject-a",
      }),
    );
    const other = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-subject-b",
        content: MATCHING_CONTENT,
        subjectId: "subject-b",
      }),
    );

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, subjectId: "subject-a" },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(matching.id);
    expect(ids).not.toContain(other.id);
  });

  it("filter.excludeProvenanceKinds: 配列に在る kind の Memory は返らず、無い kind の Memory は返る", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const excluded = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-prov-excluded",
        content: MATCHING_CONTENT,
        provenance: buildProvenanceFixture("consolidated"),
      }),
    );
    const kept = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-prov-kept",
        content: MATCHING_CONTENT,
        provenance: buildProvenanceFixture("imported"),
      }),
    );

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, excludeProvenanceKinds: ["consolidated"] },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).not.toContain(excluded.id);
    expect(ids).toContain(kept.id);
  });

  it("filter.excludeProvenanceKinds: [] は no-op（両方とも返る）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-prov-empty-a",
        content: MATCHING_CONTENT,
        provenance: buildProvenanceFixture("consolidated"),
      }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-prov-empty-b",
        content: MATCHING_CONTENT,
        provenance: buildProvenanceFixture("imported"),
      }),
    );

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, excludeProvenanceKinds: [] },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it("filter.occurredAfter: 境界と*ちょうど同じ* occurredAt は含まれ（>=）、境界より前は除外される（ADR 0039）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const boundary = new Date("2026-01-01T00:00:00.000Z");

    const onBoundary = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-after-on",
        content: MATCHING_CONTENT,
        occurredAt: boundary,
      }),
    );
    const beforeBoundary = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-after-before",
        content: MATCHING_CONTENT,
        occurredAt: new Date(boundary.getTime() - 1000),
      }),
    );

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, occurredAfter: boundary },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(onBoundary.id);
    expect(ids).not.toContain(beforeBoundary.id);
  });

  it("filter.occurredBefore: 境界と*ちょうど同じ* occurredAt は含まれ（<=）、境界より後は除外される（ADR 0039）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const boundary = new Date("2026-01-01T00:00:00.000Z");

    const onBoundary = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-before-on",
        content: MATCHING_CONTENT,
        occurredAt: boundary,
      }),
    );
    const afterBoundary = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-before-after",
        content: MATCHING_CONTENT,
        occurredAt: new Date(boundary.getTime() + 1000),
      }),
    );

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, occurredBefore: boundary },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(onBoundary.id);
    expect(ids).not.toContain(afterBoundary.id);
  });

  it("filter.occurredAfter/occurredBefore は occurredAt が null のとき recordedAt を実効時刻として使う（COALESCE。ADR 0039）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };
    const boundary = new Date("2026-01-01T00:00:00.000Z");

    const insideByRecordedAt = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-coalesce-inside",
        content: MATCHING_CONTENT,
        occurredAt: null,
        recordedAt: new Date(boundary.getTime() + 1000),
      }),
    );
    const outsideByRecordedAt = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-coalesce-outside",
        content: MATCHING_CONTENT,
        occurredAt: null,
        recordedAt: new Date(boundary.getTime() - 1000),
      }),
    );

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, occurredAfter: boundary },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(insideByRecordedAt.id);
    expect(ids).not.toContain(outsideByRecordedAt.id);
  });

  it("filter は複数同時に渡すと AND になる（どれか1つが不一致なら返らない）", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctx: Ctx = { tenantId: TENANT };

    const bothMatch = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-and-both",
        content: MATCHING_CONTENT,
        subjectId: "subject-a",
      }),
    );
    const subjectOnlyMatch = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: TENANT,
        contentHash: "hash-and-subject-only",
        content: MATCHING_CONTENT,
        subjectId: "subject-b",
      }),
    );

    const hits = await lexicalStore.search(ctx, QUERY, {
      limit: 10,
      filter: { tenantId: TENANT, subjectId: "subject-a", status: ["active"] },
    });
    const ids = hits.map((h) => h.memoryId);

    expect(ids).toContain(bothMatch.id);
    expect(ids).not.toContain(subjectOnlyMatch.id);
  });

  it("クロステナントの search には他テナントの Memory が現れない", async () => {
    const { db } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const lexicalStore = new PostgresLexicalStore(db);
    const ctxA: Ctx = { tenantId: "lexical-filter-tenant-a" };
    const ctxB: Ctx = { tenantId: "lexical-filter-tenant-b" };

    await memoryStore.createMemory(
      ctxA,
      buildNewMemoryFixture({
        tenantId: ctxA.tenantId,
        contentHash: "hash-cross-tenant",
        content: MATCHING_CONTENT,
      }),
    );

    const hitsB = await lexicalStore.search(ctxB, QUERY, {
      limit: 10,
      filter: { tenantId: ctxB.tenantId },
    });

    expect(hitsB).toEqual([]);
  });
});

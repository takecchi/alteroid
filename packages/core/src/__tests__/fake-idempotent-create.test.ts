import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0054: 擬似実装の `created` は、**この呼び出し自身が行を作ったか**を表す。
 *
 * `packages/testkit` の適合スイートは `InMemoryMemoryStore` と（CI では）
 * `PostgresMemoryStore` に対して同じ契約を測るが、`FakeMemoryStore`
 * （`packages/core/src/__tests__/runtime-fakes.ts`）は適合スイートの対象に入っていない
 * ——`packages/testkit` は `packages/core` に依存しており、逆向きに参照できないためである。
 * 3つ目の実装がこの契約から外れるのを防ぐのがこのファイルの役目
 * （ADR 0049「割れていたのは3実装のうち2つ」と同じ形の歯）。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

function observationInput(externalId: string) {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    externalId,
    kind: "utterance" as const,
    payload: { text: externalId },
    occurredAt: null,
    recordedAt: new Date(),
  };
}

describe("FakeMemoryStore の created は自分が作った行だけを指す（ADR 0054）", () => {
  it("createObservationWithOutbox は、別の行の作成が同時に起きても created を取り違えない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const dupInput = observationInput("ext-existing");

    const seed = await memoryStore.createObservationWithOutbox(ctx, dupInput, ["extract"]);
    expect(seed.created).toBe(true);

    const [dup, fresh] = await Promise.all([
      memoryStore.createObservationWithOutbox(ctx, dupInput, ["extract"]),
      memoryStore.createObservationWithOutbox(ctx, observationInput("ext-fresh"), ["extract"]),
    ]);

    expect({
      dupCreated: dup.created,
      dupJobs: dup.jobs.length,
      dupIsSeedRow: dup.observation.id === seed.observation.id,
      freshCreated: fresh.created,
      freshJobTargets: fresh.jobs.map((job) => job.payload.observationId),
      freshIsDistinctRow: fresh.observation.id !== seed.observation.id,
    }).toEqual({
      dupCreated: false,
      dupJobs: 0,
      dupIsSeedRow: true,
      freshCreated: true,
      freshJobTargets: [fresh.observation.id],
      freshIsDistinctRow: true,
    });
  });

  it("createMemoryWithOutbox は、別の行の作成が同時に起きても created を取り違えない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const observation = await memoryStore.createObservation(ctx, observationInput("ext-for-mem"));

    const base = {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: observation.id,
      extractorVersion: "v1",
      content: "本文",
      digest: "要約",
      digestSource: "llm" as const,
      provenance: {
        kind: "stated" as const,
        sourceObservationId: observation.id,
        at: "2026-01-01T00:00:00.000Z",
      },
      tags: [],
      occurredAt: null,
      recordedAt: new Date(),
      strength: 1,
      halfLifeHours: 24,
      decayFloorAt: new Date(),
      embeddingStatus: "pending" as const,
    };
    const dupInput = { ...base, contentHash: "hash-existing" };

    const seed = await memoryStore.createMemoryWithOutbox(ctx, dupInput, ["embed"]);
    expect(seed.created).toBe(true);

    const [dup, fresh] = await Promise.all([
      memoryStore.createMemoryWithOutbox(ctx, dupInput, ["embed"]),
      memoryStore.createMemoryWithOutbox(ctx, { ...base, contentHash: "hash-fresh" }, ["embed"]),
    ]);

    expect({
      dupCreated: dup.created,
      dupJobs: dup.jobs.length,
      dupIsSeedRow: dup.memory.id === seed.memory.id,
      freshCreated: fresh.created,
      freshJobTargets: fresh.jobs.map((job) => job.payload.memoryId),
      freshIsDistinctRow: fresh.memory.id !== seed.memory.id,
    }).toEqual({
      dupCreated: false,
      dupJobs: 0,
      dupIsSeedRow: true,
      freshCreated: true,
      freshJobTargets: [fresh.memory.id],
      freshIsDistinctRow: true,
    });
  });

  /**
   * ADR 0054 の不変条件のうち、**「判定と挿入の間に `await` を挟まない」側**。
   * 上の2本は「`created` を大域の件数差から導く」壊れ方を捕まえるが、**事前の存在検査 +
   * `await` 境界**という壊れ方は、鍵が違えば答えが合ってしまうため捕まえない。
   * ここでは**同じ冪等キーを同時に2回**作らせる（適合スイート側の同名の歯と同じ形）。
   */
  it("createObservationWithOutbox は、同じ冪等キーを同時に作っても created を1回しか返さない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const input = observationInput("ext-race");

    const [a, b] = await Promise.all([
      memoryStore.createObservationWithOutbox(ctx, input, ["extract"]),
      memoryStore.createObservationWithOutbox(ctx, input, ["extract"]),
    ]);

    const allJobs = [...a.jobs, ...b.jobs];
    expect({
      createdCount: [a.created, b.created].filter(Boolean).length,
      sameRow: a.observation.id === b.observation.id,
      totalJobs: allJobs.length,
      jobTargets: [...new Set(allJobs.map((job) => job.payload.observationId))],
    }).toEqual({
      createdCount: 1,
      sameRow: true,
      totalJobs: 1,
      jobTargets: [a.observation.id],
    });
  });

  it("createMemoryWithOutbox は、同じ冪等キーを同時に作っても created を1回しか返さない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const observation = await memoryStore.createObservation(ctx, observationInput("ext-for-race"));
    const input = {
      tenantId: "tenant-1",
      subjectId: null,
      sourceObservationId: observation.id,
      extractorVersion: "v1",
      content: "本文",
      contentHash: "hash-race",
      digest: "要約",
      digestSource: "llm" as const,
      provenance: {
        kind: "stated" as const,
        sourceObservationId: observation.id,
        at: "2026-01-01T00:00:00.000Z",
      },
      tags: [],
      occurredAt: null,
      recordedAt: new Date(),
      strength: 1,
      halfLifeHours: 24,
      decayFloorAt: new Date(),
      embeddingStatus: "pending" as const,
    };

    const [a, b] = await Promise.all([
      memoryStore.createMemoryWithOutbox(ctx, input, ["embed"]),
      memoryStore.createMemoryWithOutbox(ctx, input, ["embed"]),
    ]);

    const allJobs = [...a.jobs, ...b.jobs];
    expect({
      createdCount: [a.created, b.created].filter(Boolean).length,
      sameRow: a.memory.id === b.memory.id,
      totalJobs: allJobs.length,
      jobTargets: [...new Set(allJobs.map((job) => job.payload.memoryId))],
    }).toEqual({
      createdCount: 1,
      sameRow: true,
      totalJobs: 1,
      jobTargets: [a.memory.id],
    });
  });
});

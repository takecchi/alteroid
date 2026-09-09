// このファイルが roadmap.md 段階1の完了条件そのものにあたる:
// 「testkit の適合テストの雛形（2テナント分のデータを入れて走らせる枠組み）が、
//   プレースホルダ実装に対して動く」

import type { Ctx } from "@mnemora/core";
import { describeEventStoreConformance } from "../event-store-conformance.js";
import { describeMemoryStoreConformance } from "../memory-store-conformance.js";
import { describeOutboxStoreConformance } from "../outbox-store-conformance.js";
import { describeTenantSettingsStoreConformance } from "../tenant-settings-store-conformance.js";
import { describeVectorStoreConformance } from "../vector-store-conformance.js";
import { buildNewMemoryFixture, buildProvenanceFixture } from "../test-data.js";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

// `listEventsForMemory`（ADR 0031）も `seedJob`/`setDefaultHalfLifeHours` と同じ理由で
// 直近のインスタンスを持ち回る——`updateStatusWithEvent` が積んだイベントを読むには、
// `createStore()` が作った、まさにその `InMemoryMemoryStore` インスタンスの `events` 配列を
// 見る必要がある。
let latestMemoryStoreForEvents: InMemoryMemoryStore | undefined;

describeMemoryStoreConformance({
  name: "in-memory placeholder",
  createStore: () => {
    const store = new InMemoryMemoryStore();
    latestMemoryStoreForEvents = store;
    return store;
  },
  listEventsForMemory: (ctx, memoryId) => {
    if (!latestMemoryStoreForEvents) {
      throw new Error("listEventsForMemory より先に createStore() を呼ぶ必要がある");
    }
    return latestMemoryStoreForEvents.events.filter(
      (event) => event.tenantId === ctx.tenantId && event.memoryId === memoryId,
    );
  },
  // ADR 0047: `recall_usages.recall_id → recalls(id)` の外部キーを `InMemoryMemoryStore`
  // にも適用したことで、`recordUsage` の適合テストには実在の recallId が要る
  // （既定の固定文字列 `"recall-1"` はもう通らない）。`MemoryStore.createRecall` は
  // 本体がまさに用意している「recall を記録する」書き込み口そのものなので、それを使う
  // （`memory-store-conformance.ts` の「createRecall は recallId を発行する」の歯と
  // 同じ最小フィクスチャ）。
  prepareRecallId: async (ctx) => {
    if (!latestMemoryStoreForEvents) {
      throw new Error("prepareRecallId より先に createStore() を呼ぶ必要がある");
    }
    return latestMemoryStoreForEvents.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      query: { text: "fixture" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
      explain: { stages: [] },
      returnedMemoryIds: [],
    });
  },
  // ADR 0079: 積み直した `embed` ジョブを、運搬役が実際に claim できるところまで見る。
  // `InMemoryOutboxStore` は `InMemoryMemoryStore.outboxJobs` の配列を共有参照で受け取る
  // ——`createStore()` が作った、まさにその instance のジョブを claim する必要がある
  // （`listEventsForMemory` と同じ理由・同じ形）。
  // `leaseMs` はこの検査の中だけの値であり、実運用のリース長とは無関係（ADR 0032）。
  claimEmbedJobs: (ctx, now) => {
    if (!latestMemoryStoreForEvents) {
      throw new Error("claimEmbedJobs より先に createStore() を呼ぶ必要がある");
    }
    return new InMemoryOutboxStore(latestMemoryStoreForEvents.outboxJobs).claimBatch(ctx, {
      kinds: ["embed"],
      limit: 100,
      now,
      claimedBy: "conformance-requeue",
      leaseMs: 60_000,
    });
  },
});

// `InMemoryVectorStore` は `status`/`subjectId`/`decayFloorAt`（Memory の属性であり
// ベクトルの属性ではない）を見るために `InMemoryMemoryStore` を必須で参照する
// （in-memory-vector-store.ts のクラス doc、ADR 0034）。`prepareMemoryId` はこの
// 「まさに同じ `InMemoryMemoryStore` インスタンス」に実在の Memory を作ることで、
// `describeOutboxStoreConformance` の `seedJob`/`latestMemoryStoreForOutboxSeed` と
// 同じ理由・同じ形で辻褄を合わせる。
let latestMemoryStoreForVectorFixtures: InMemoryMemoryStore | undefined;
let vectorFixtureContentHashCounter = 0;

describeVectorStoreConformance({
  name: "in-memory placeholder",
  createStore: () => {
    const memoryStore = new InMemoryMemoryStore();
    latestMemoryStoreForVectorFixtures = memoryStore;
    return new InMemoryVectorStore(memoryStore);
  },
  prepareMemoryId: async (ctx, attrs) => {
    if (!latestMemoryStoreForVectorFixtures) {
      throw new Error("prepareMemoryId より先に createStore() を呼ぶ必要がある");
    }
    // `sourceObservationId` を持たせないため `createMemory` の冪等キー（extractionIndex）は
    // 使われず、`contentHash` の一意性は本来不要——それでも「別の Memory のつもりが
    // 同じ内容のまま」に読めてしまわないよう、呼ぶたびに変える。
    vectorFixtureContentHashCounter += 1;
    const memory = await latestMemoryStoreForVectorFixtures.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `fixture-hash-vector-${vectorFixtureContentHashCounter}`,
        ...(attrs?.status !== undefined ? { status: attrs.status } : {}),
        ...(attrs?.subjectId !== undefined ? { subjectId: attrs.subjectId } : {}),
        ...(attrs?.decayFloorAt !== undefined ? { decayFloorAt: attrs.decayFloorAt } : {}),
        ...(attrs?.provenanceKind !== undefined
          ? { provenance: buildProvenanceFixture(attrs.provenanceKind) }
          : {}),
        ...(attrs?.occurredAt !== undefined ? { occurredAt: attrs.occurredAt } : {}),
        ...(attrs?.recordedAt !== undefined ? { recordedAt: attrs.recordedAt } : {}),
      }),
    );
    return memory.id;
  },
  // ADR 0065: `InMemoryVectorStore` はテーブルを持たず、`search` が呼ばれた時点の
  // key prefix（provider:model:dimensions）一致で絞るだけ——`upsert`/`search` に
  // 未知の space を渡しても事前登録は要らない（`registerEmbeddingSpace` に相当する
  // ものが無い）。そのため no-op で足りる。
  prepareEmbeddingSpace: () => {},
});

// ADR 0047: `memory_events.memory_id → memories(id)` の外部キーを `InMemoryEventStore`
// にも適用したことで、コンストラクタに `InMemoryMemoryStore` が必須になった
// （#33 が `InMemoryVectorStore` に対して通したのと同じ形）。`prepareMemoryId` はこの
// 「まさに同じ `InMemoryMemoryStore` インスタンス」に実在の Memory を作ることで辻褄を
// 合わせる（`latestMemoryStoreForVectorFixtures`/`prepareMemoryId` と同じパターン）。
let latestMemoryStoreForEventFixtures: InMemoryMemoryStore | undefined;
let eventFixtureContentHashCounter = 0;

describeEventStoreConformance({
  name: "in-memory placeholder",
  createStore: () => {
    const memoryStore = new InMemoryMemoryStore();
    latestMemoryStoreForEventFixtures = memoryStore;
    return new InMemoryEventStore(memoryStore);
  },
  prepareMemoryId: async (ctx) => {
    if (!latestMemoryStoreForEventFixtures) {
      throw new Error("prepareMemoryId より先に createStore() を呼ぶ必要がある");
    }
    eventFixtureContentHashCounter += 1;
    const memory = await latestMemoryStoreForEventFixtures.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `fixture-hash-event-${eventFixtureContentHashCounter}`,
      }),
    );
    return memory.id;
  },
});

// `describeOutboxStoreConformance` の各 `it()` は必ず `createStore()` を先に呼ぶ
// （outbox-store-conformance.ts の全ケースがそうなっている）。in-memory 実装では
// `seedJob` が「OutboxStore 単体には無い enqueue」を `MemoryStore` 経由で代行する必要があり、
// `createStore()` が最後に作った `MemoryStore`（=同じジョブ配列を共有する側）を
// `seedJob` からも参照できるよう、モジュールスコープで直近のインスタンスを持ち回る。
// vitest はデフォルトで同一 describe 内の it() を並行実行しないため、この持ち回りは安全
// （`packages/postgres` が同じ理由で単一の共有 DB 接続を使い回すのと同じパターン）。
let latestMemoryStoreForOutboxSeed: InMemoryMemoryStore | undefined;

describeOutboxStoreConformance({
  name: "in-memory placeholder",
  createStore: () => {
    const memoryStore = new InMemoryMemoryStore();
    latestMemoryStoreForOutboxSeed = memoryStore;
    return new InMemoryOutboxStore(memoryStore.outboxJobs);
  },
  seedJob: async (ctx, input) => {
    if (!latestMemoryStoreForOutboxSeed) {
      throw new Error("seedJob より先に createStore() を呼ぶ必要がある");
    }
    const { jobs } = await latestMemoryStoreForOutboxSeed.createObservationWithOutbox(
      ctx,
      { tenantId: ctx.tenantId, subjectId: null, externalId: null, kind: "utterance", payload: {} },
      [input.kind],
    );
    const job = jobs[0]!;
    if (input.payload) {
      job.payload = input.payload;
    }
    if (input.availableAt) {
      job.availableAt = input.availableAt;
    }
    return job;
  },
});

let latestTenantSettingsStore: InMemoryTenantSettingsStore | undefined;

describeTenantSettingsStoreConformance({
  name: "in-memory placeholder",
  createStore: () => {
    const store = new InMemoryTenantSettingsStore();
    latestTenantSettingsStore = store;
    return store;
  },
  setDefaultHalfLifeHours: (ctx: Ctx, hours: number) => {
    if (!latestTenantSettingsStore) {
      throw new Error("setDefaultHalfLifeHours より先に createStore() を呼ぶ必要がある");
    }
    latestTenantSettingsStore.setDefaultHalfLifeHours(ctx.tenantId, hours);
  },
});

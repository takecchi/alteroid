import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { getTestClient, requireDatabaseUrl, resetTestDatabase } from "./test-db.js";

/**
 * `PostgresMemoryStore.supersedeWithNewMemories`（Issue #134 / ADR 0100）を
 * **本物の Postgres トランザクション・本物の並行**で検査する。
 *
 * `packages/testkit/src/memory-store-conformance.ts` の `supersedeWithNewMemories` の歯
 * （postgres 実装にも `conformance.postgres.test.ts` 経由で走る）は単一接続・逐次実行の
 * 範囲で「news の作成と supersede が同じ呼び出しで起きる」ことを検査できる。しかしそれ
 * だけでは、`memory-store-update-status-with-event-transaction.test.ts`（ADR 0031）が
 * `updateStatusWithEvent` に対して確認したのと同じ理由で、**`db.transaction()` が本物の
 * BEGIN/COMMIT として機能しているか**——同一行を奪い合う複数の**実際に別の**セッションの
 * 下でも、news の作成と supersede の CAS 判定が原子的であり続けるか——は確認できない。
 *
 * 🔴 検査する不変条件:
 * - 同じ1行に対して複数の「プロセス」（別々の `Pool`）が同時に
 *   `expectedStatus: 'active'` で supersede を試みると、**ちょうど1本だけ**その行を
 *   `superseded` へ動かし、`memory_events` に `superseded` イベントが**ちょうど1件**残る。
 * - `supersedeWithNewMemories` の CAS 意味論は `updateStatusWithEvent` と違い
 *   **例外にしない**——競合した呼び出しは reject せず、`conflicted` に積んで
 *   正常に resolve する（各呼び出しが作った `news` はその呼び出し自身が commit する）。
 *   ⟹ 「ちょうど1本だけ成功」は「resolve/reject の数」ではなく、
 *   **各呼び出しの `result.conflicted` の中身**で数える。
 * - 各呼び出しが渡した `news`（1件ずつ、呼び出しごとに別 content_hash）は、
 *   supersede が競合した呼び出しでも作られている——news の作成は supersede の CAS 結果に
 *   依存しない（この実装は news を先に処理する。ADR 0100 決定・postgres 実装の doc 参照）。
 *
 * **⚠ これは CI（postgres ジョブ）でしか走らない。** この器には Docker/PostgreSQL/
 * `DATABASE_URL` が無く、手元では実行できていない（`requireDatabaseUrl()` が
 * `DATABASE_URL` 未設定で例外を投げ、テストランナー自体が起動しない）。
 */
describe("PostgresMemoryStore.supersedeWithNewMemories を本物の並行・本物のトランザクションで検査する", () => {
  const pools: PostgresClient[] = [];

  afterAll(async () => {
    for (const client of pools) {
      await client.pool.end();
    }
  });

  it("同じ1行に4本が同時に expectedStatus:'active' で supersede を撃つと、ちょうど1本だけ conflicted が空になり、memory_events にちょうど1件だけ superseded が残る。news は4本とも作られる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const seedStore = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };
    const target = await seedStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: "tenant-1", contentHash: "target" }),
    );
    expect(target.status).toBe("active");

    // 4本の「プロセス」相当。同一 Pool を共有しない理由は
    // memory-store-update-status-with-event-transaction.test.ts の冒頭コメント参照。
    const N = 4;
    const clients = Array.from({ length: N }, () => createPostgresClient(requireDatabaseUrl()));
    pools.push(...clients);
    const stores = clients.map((client) => new PostgresMemoryStore(client.db));

    const results = await Promise.all(
      stores.map((store, i) =>
        store.supersedeWithNewMemories(
          ctx,
          [
            {
              input: buildNewMemoryFixture({
                tenantId: "tenant-1",
                contentHash: `concurrent-news-${i}`,
              }),
              jobKinds: [],
            },
          ],
          [
            {
              id: target.id,
              supersededByIndex: 0,
              expectedStatus: "active",
              event: {
                tenantId: ctx.tenantId,
                memoryId: target.id,
                kind: "superseded",
                actor: { type: "system" },
                digestSnapshot: target.digest,
                sizeBeforeBytes: null,
                meta: { reason: "concurrency-test" },
              },
            },
          ],
        ),
      ),
    );

    // すべて resolve する——supersedeWithNewMemories の CAS 意味論は例外にしない
    // （updateStatusWithEvent との違い、本ファイル冒頭のコメント参照）。
    expect(results).toHaveLength(N);

    // ちょうど1本だけ、その呼び出しの中で「競合していない」（conflicted が空）。
    const winners = results.filter((r) => r.conflicted.length === 0);
    const losers = results.filter((r) => r.conflicted.length === 1);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);

    for (const loser of losers) {
      expect(loser.conflicted[0]?.id).toBe(target.id);
      expect(loser.superseded).toEqual([]);
    }
    expect(winners[0]?.superseded).toHaveLength(1);

    // 4本とも news を1件ずつ作っている——supersede の CAS 結果に関わらず。
    for (const result of results) {
      expect(result.created).toHaveLength(1);
      expect(result.created[0]?.created).toBe(true);
    }

    // 最終状態: superseded が1回分だけ適用されている（二重に上書きされていない）。
    const final = await seedStore.get(ctx, target.id);
    expect(final?.status).toBe("superseded");
    // 勝った1本が自分の news として作った行へ寄っている——`supersededByIndex: 0` が
    // 「この呼び出しの news[0]」を指すこと（他の3本が作った行ではないこと）の確認。
    expect(final?.supersededById).toBe(winners[0]?.created[0]?.memory.id);

    // 🔴 本 PR の芯: status の更新と同じ回数だけイベントが残っている——3本が競合した分の
    // イベントが漏れて積まれていないこと（原子性が本物の並行下でも保たれていること）を、
    // 実データを直接読んで確認する。
    const events = await db.execute(sql`
      SELECT * FROM memory_events
      WHERE tenant_id = ${ctx.tenantId} AND memory_id = ${target.id} AND kind = 'superseded'
    `);
    expect(events.rows).toHaveLength(1);
  }, 20_000);

  it("supersede 対象が存在しないと throw し、同一トランザクション内の news の INSERT もロールバックされる（単一接続・逐次で厳密に確認する）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "tenant-1" };
    const observation = await store.createObservation(ctx, {
      tenantId: "tenant-1",
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "fixture" },
      occurredAt: null,
    });
    const newsInput = buildNewMemoryFixture({
      tenantId: "tenant-1",
      sourceObservationId: observation.id,
      extractorVersion: "postgres-concurrency-rollback-v1",
      contentHash: "rollback-check",
    });
    const missingId = "00000000-0000-0000-0000-000000000000";

    await expect(
      store.supersedeWithNewMemories(
        ctx,
        [{ input: newsInput, jobKinds: [] }],
        [
          {
            id: missingId,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: {
              tenantId: ctx.tenantId,
              memoryId: missingId,
              kind: "superseded",
              actor: { type: "system" },
              digestSnapshot: "digest",
              sizeBeforeBytes: null,
              meta: {},
            },
          },
        ],
      ),
    ).rejects.toThrow(/memory not found for tenant/);

    // news が本当にロールバックされたことの確認: 同じ冪等キーでもう一度
    // createMemoryWithOutbox を呼ぶと、ロールバックされていれば新規作成（created: true）
    // になる。ロールバックされていなければ既存行に衝突して created: false になる。
    const { created } = await store.createMemoryWithOutbox(ctx, newsInput, []);
    expect(created).toBe(true);
  });
});

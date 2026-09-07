import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore.setEmbeddingStatus`（`packages/core` 自身の runtime テスト用フェイク、
 * `runtime-fakes.ts`）が、`PostgresMemoryStore.setEmbeddingStatus`（ADR 0053）と同じ
 * 意味論——`ready` を `failed` へ巻き戻さない・例外にはしない・`failed → ready` は妨げない
 * ——を実際に守っていることを検査する歯。
 *
 * **`packages/testkit` の `memory-store-conformance.ts` の対象ではない。**
 * `FakeMemoryStore` は adapter 適合テストの対象である `MemoryStore` 実装
 * （`InMemoryMemoryStore`/`PostgresMemoryStore`）ではなく、`packages/core` 自身の
 * runtime テスト専用の別系統（`runtime-fakes.ts` 冒頭のコメント: core は testkit に
 * 依存しない）。`fake-reinforce-monotonicity.test.ts`（ADR 0049）・
 * `fake-referential-integrity.test.ts`（ADR 0047）・`fake-event-store-list.test.ts`
 * （ADR 0042）と同じ理由・同じ形。
 *
 * **⚠ この歯を置く前は、`FakeMemoryStore` にガードを足しても、それを測る歯が
 * どこにも無かった。**実際にガードを丸ごと外す変異を撃つと `packages/core` の
 * 288 件は1件も赤くならなかった（PR 本文の変異表 Mu-F0 参照）——ADR 0049 が
 * 「適合スイート側の歯だけを置き、`FakeMemoryStore` 側は据え置く」を採らなかったのと
 * 同じ形が、この PR でも起きていた。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
let contentHashCounter = 0;

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
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeMemoryStore.setEmbeddingStatus — ready を failed へ巻き戻さない（ADR 0053）", () => {
  it("⚠ 'ready' のところへ 'failed' を書いても巻き戻らない（例外も投げない）", async () => {
    // ⚠ `ready` は VectorStore.upsert が返った*後*にしか書かれない＝「ベクトル行が在る」
    // の主張である。`failed` はリースを失った古いワーカーの catch からも書かれうる
    // （ADR 0032 の at-least-once）。
    //
    // ⚠ **例外を投げないことも歯の一部である。**唯一の `failed` の呼び出し口は
    // `runtime.tick` の `catch (err) { ...; throw err }` の中であり、そこで投げると
    // 元の埋め込みエラーが握り潰されて別の例外にすり替わる。下の `await` がそのまま
    // 通ることが、それを固定している。
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());

    const readied = await stores.memoryStore.setEmbeddingStatus(ctx, memory.id, "ready");
    // 前提: 'ready' への遷移は実際に効いている。
    // ⚠ **この行はこの歯の捕獲力を増やしていない**（実測。PR 本文の変異 Mu4b）——
    // 下の `expect(rolledBack.embeddingStatus).toBe("ready")` は*正の*等値比較なので、
    // 実装が丸ごと壊れて何も書かなくなった場合（`pending` のまま）にも、この行が
    // 無くてもそれだけで赤くなる。この行が足しているのは**赤くなる位置**であって、
    // 赤くなるかどうかではない（適合スイート側の同じ歯と同じ記述）。
    expect(readied.embeddingStatus).toBe("ready");

    // ⚠ プリミティブへ即座に写し取る。FakeMemoryStore は backing の Map に入れた行
    // オブジェクトへの参照をそのまま返すため、`readied`（＝行そのもの）を保持したまま
    // 後段で比べると「別の読み取り」ではなく「同じオブジェクトを2回見ている」だけに
    // なり、比較が常に真になって歯が死ぬ（ADR 0049 の歯と同じ取り違え）。
    // **実測: 適合スイート側の同じ歯で、この写し取りを `const readyRow = readied` へ
    // 置き換えると `updatedAt` を触る変異が生き残った**（PR 本文の変異 Mu6''）。
    const readyUpdatedAtMs = readied.updatedAt.getTime();

    // ⚠ `updatedAt` は壁時計（`new Date()`）。2回の呼び出しは一瞬で終わるため、ガードが
    // 外れて書き込んでしまう実装でもミリ秒の解像度に収まって偶然同じ値になりかねない。
    // 実際に時間を進め、「書けば必ず値が変わる」状況を作ってから「変わっていない」を
    // 確かめる。
    // **実測: 適合スイート側の同じ歯で、この `await` を消すと `updatedAt` を触る変異が
    // 生き残った**（PR 本文の変異 Mu7）。
    await new Promise((resolve) => setTimeout(resolve, 5));

    const rolledBack = await stores.memoryStore.setEmbeddingStatus(ctx, memory.id, "failed");
    expect(rolledBack.embeddingStatus).toBe("ready");
    // 行そのものを触っていないことは updatedAt で確かめる。
    expect(rolledBack.updatedAt.getTime()).toBe(readyUpdatedAtMs);

    // 読み直しても同じ（返り値だけを繕う実装を弾く）。
    const reread = await stores.memoryStore.get(ctx, memory.id);
    expect(reread?.embeddingStatus).toBe("ready");
    expect(reread?.updatedAt.getTime()).toBe(readyUpdatedAtMs);
  });

  it("'failed' を 'ready' へ進めることは妨げない（片側だけの規則）", async () => {
    // ⚠ この歯は、規則が**片側だけ**であることを固定するためにある。実装が
    // 「ready と failed を対称に禁じる」や「常に何も書かない」へずれても、
    // 上の歯だけでは緑のままになる。
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());

    const failed = await stores.memoryStore.setEmbeddingStatus(ctx, memory.id, "failed");
    // 前提: 'failed' への遷移は実際に効いている（上の歯と同じく、捕獲力ではなく
    // 赤くなる位置を足す行である）。
    expect(failed.embeddingStatus).toBe("failed");
    // ⚠ 上の歯と同じ理由でプリミティブへ写し取る（参照を持ち回らない）。
    const failedUpdatedAtMs = failed.updatedAt.getTime();

    await new Promise((resolve) => setTimeout(resolve, 5));

    const readied = await stores.memoryStore.setEmbeddingStatus(ctx, memory.id, "ready");
    expect(readied.embeddingStatus).toBe("ready");
    // 行が実際に触られたこと（no-op ではないこと）を updatedAt で確かめる。
    expect(readied.updatedAt.getTime()).toBeGreaterThan(failedUpdatedAtMs);

    const reread = await stores.memoryStore.get(ctx, memory.id);
    expect(reread?.embeddingStatus).toBe("ready");
  });

  it("setEmbeddingStatus は存在しない Memory に対して失敗する（既存の挙動を壊していないことの確認）", async () => {
    const stores = createFakeRuntimeStores();
    await expect(
      stores.memoryStore.setEmbeddingStatus(ctx, "does-not-exist", "ready"),
    ).rejects.toThrow(/memory not found for tenant/);
  });
});

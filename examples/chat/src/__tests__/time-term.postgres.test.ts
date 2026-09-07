import { afterAll, describe, expect, it } from "vitest";
import { createMutableClock } from "../mutable-clock.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { TIE_EPSILON, formatTimeTermReport, runTimeTermArm } from "../time-term-arm.js";
import { TIME_PROBES } from "../time-term-probe-set.js";
import type { TimeProbeOutcome } from "../time-term-arm.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `freshness`/`decay` を意味的類似度から分離して測る arm を、本物の Postgres + pgvector に
 * 対して実際に1回走らせる(PR 本文)。
 *
 * **provider は擬似(`deterministic`)に固定する**——`time-term-arm.ts`/`cli.ts` の docstring の
 * とおり、ペアの2件は本文が厳密に同一なので `similarity` は構成上定数になり、
 * この測定は provider 層に依らない。実行環境にたまたま `OPENAI_API_KEY` が
 * 設定されていても、この歯は本物には倒れない(`retrieval-quality.postgres.test.ts` と
 * 同じ規律)。
 *
 * **`MutableClock` を注入する**(`decay-*` probe の要)。`createExampleRuntime` の4番目の
 * 引数に渡した `Clock` と、`runTimeTermArm` に渡す `clock` は**同じインスタンス**。
 *
 * **以下の assert は、実測の前に立てた予測である。**実測が予測と違ったときに、この歯の
 * 期待値を静かに書き換えて緑にしてはならない——どの assert がどんな実測値で落ちたかを
 * 記録することそのものが成果である(ADR 0058)。
 */
describe("examples/chat: time-term arm(擬似 provider・本物の Postgres)", () => {
  it("8 probe の pair outcome / freshness / decay / similarity / total を実測する", async () => {
    await resetTestDatabase();
    await getTestClient();
    const clock = createMutableClock();
    const handle = await createExampleRuntime(
      requireDatabaseUrl(),
      {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
      },
      {},
      clock,
    );
    try {
      expect(handle.llmMode).toBe("deterministic");
      expect(handle.embeddingMode).toBe("deterministic");

      // ⚠ **ハードコードした過去/未来の日付は使えない**——`recall()` の `freshness`/`decay` は
      // 注入した `MutableClock`(既定は実時計と同じ `new Date()`)を起点に計算する。
      // `now` はここで occurredAt/recordedAt の相対オフセットを作るためだけに使うので、
      // 実行中の実時計に近い値でなければ「0日前」のはずが数時間ずれてしまう。
      // ⟹ `new Date()` をここで1回捕まえ、8 probe すべてに同じ基準として使う
      // (「固定した Date」= 1回捕まえて使い回す、という意味。過去の固定リテラルではない)。
      const now = new Date();
      const report = await runTimeTermArm({
        armLabel: "time-term-test",
        tenantIdPrefix: "time-term-test",
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        now,
        clock,
      });

      // ⭐ 本命の成果物: 実測値をそのまま報告に貼る。
      console.log(formatTimeTermReport(report));

      const byId = new Map<string, TimeProbeOutcome>(report.probes.map((p) => [p.probeId, p]));

      // 6. 全 probe で newer 側は必ず返っている。そして**ペアが2件として残っている**
      //    ——probe ごとに専用テナントなので、スコープ内総数はペアの2件そのものである。
      //    ここが 2 でなければ `outcome` は `collapsed` になり、この arm は測れていない。
      expect(report.probes).toHaveLength(TIME_PROBES.length);
      for (const p of report.probes) {
        expect(p.newer).not.toBeNull();
        expect(p.totalInScope).toBe(2);
        expect(p.outcome).not.toBe("collapsed");
      }

      // 1. same-occurred-at: occurredAt が同じなら時間項は順位を決めない。
      const sameOccurredAt = byId.get("same-occurred-at")!;
      expect(sameOccurredAt.outcome).toBe("tied");
      expect(sameOccurredAt.similarityGapWithinPair).toBe(0);
      expect(sameOccurredAt.totalRatio).not.toBeNull();
      expect(Math.abs(sameOccurredAt.totalRatio! - 1)).toBeLessThan(TIE_EPSILON);

      // 2. absent: occurredAt を渡さないと freshness は decay と同値になる
      //    (ADR 0033 §4 が測った条件の再現)。
      const absent = byId.get("absent")!;
      expect(absent.outcome).toBe("tied");
      expect(absent.newer).not.toBeNull();
      expect(absent.older).not.toBeNull();
      expect(Math.abs(absent.newer!.score.freshness - absent.newer!.score.decay)).toBeLessThan(
        1e-9,
      );
      expect(Math.abs(absent.older!.score.freshness - absent.older!.score.decay)).toBeLessThan(
        1e-9,
      );

      // 3. half-life: freshness が 1.0 対 0.5、順位差の全部が freshness 由来。
      const halfLife = byId.get("half-life")!;
      expect(halfLife.outcome).toBe("newer-ranked-higher");
      expect(halfLife.newer).not.toBeNull();
      expect(halfLife.older).not.toBeNull();
      // 0.5**(0/30) = 1、0.5**(30/30) = 0.5(PR 本文の数値)。
      expect(halfLife.newer!.score.freshness).toBeCloseTo(1.0, 3);
      expect(halfLife.older!.score.freshness).toBeCloseTo(0.5, 3);
      expect(halfLife.similarityGapWithinPair).toBe(0);
      expect(halfLife.freshnessRatio).not.toBeNull();
      expect(halfLife.totalRatio).not.toBeNull();
      expect(Math.abs(halfLife.totalRatio! - halfLife.freshnessRatio!)).toBeLessThan(1e-3);

      // 4. realistic: 現実的に小さい差でも順位が動く。
      const realistic = byId.get("realistic")!;
      expect(realistic.outcome).toBe("newer-ranked-higher");
      expect(realistic.newer).not.toBeNull();
      expect(realistic.older).not.toBeNull();
      // 0.5**(1/30) = 0.977160、0.5**(4/30) = 0.911724(PR 本文の数値)。
      expect(realistic.newer!.score.freshness).toBeCloseTo(0.97716, 3);
      expect(realistic.older!.score.freshness).toBeCloseTo(0.911724, 3);
      expect(realistic.similarityGapWithinPair).toBe(0);
      expect(realistic.freshnessRatio).not.toBeNull();
      expect(realistic.totalRatio).not.toBeNull();
      expect(Math.abs(realistic.totalRatio! - realistic.freshnessRatio!)).toBeLessThan(1e-3);

      // 5. far-past: freshness が閾値を割って older 側が落ちる。
      const farPast = byId.get("far-past")!;
      expect(farPast.outcome).toBe("older-not-returned");
      expect(farPast.omittedKinds).toContain("below_threshold");

      // ---------------------------------------------------------------------
      // decay を freshness から分離して測る3件。
      // occurredAt は newer/older で揃えてある(7日前)ので、freshnessGapWithinPair は
      // どの decay-* probe でも 0 でなければならない——0 でなければ分離できていない。
      // ---------------------------------------------------------------------

      // decay-half-life: decay が 1.0 対 0.5、順位差の全部が decay 由来。
      const decayHalfLife = byId.get("decay-half-life")!;
      expect(decayHalfLife.outcome).toBe("newer-ranked-higher");
      expect(decayHalfLife.newer).not.toBeNull();
      expect(decayHalfLife.older).not.toBeNull();
      expect(decayHalfLife.similarityGapWithinPair).toBe(0);
      expect(decayHalfLife.freshnessGapWithinPair).toBe(0);
      // 0.5**(0/30) = 1、0.5**(30/30) = 0.5(PR 本文の数値、half-life probe と同じ式)。
      expect(decayHalfLife.newer!.score.decay).toBeCloseTo(1.0, 3);
      expect(decayHalfLife.older!.score.decay).toBeCloseTo(0.5, 3);
      expect(decayHalfLife.decayRatio).not.toBeNull();
      expect(decayHalfLife.totalRatio).not.toBeNull();
      expect(Math.abs(decayHalfLife.totalRatio! - decayHalfLife.decayRatio!)).toBeLessThan(1e-3);

      // decay-realistic: 現実的に小さい差でも順位が動く。
      const decayRealistic = byId.get("decay-realistic")!;
      expect(decayRealistic.outcome).toBe("newer-ranked-higher");
      expect(decayRealistic.newer).not.toBeNull();
      expect(decayRealistic.older).not.toBeNull();
      // 0.5**(1/30) = 0.977160、0.5**(4/30) = 0.911722(PR 本文の数値、realistic probe と同じ式)。
      expect(decayRealistic.newer!.score.decay).toBeCloseTo(0.97716, 3);
      expect(decayRealistic.older!.score.decay).toBeCloseTo(0.911722, 3);
      expect(decayRealistic.freshnessGapWithinPair).toBe(0);
      expect(decayRealistic.decayRatio).not.toBeNull();
      expect(decayRealistic.totalRatio).not.toBeNull();
      expect(Math.abs(decayRealistic.totalRatio! - decayRealistic.decayRatio!)).toBeLessThan(1e-3);

      // decay-same-recorded-at: recordedAt も同じなら時間項は順位を決めない。
      const decaySameRecordedAt = byId.get("decay-same-recorded-at")!;
      expect(decaySameRecordedAt.outcome).toBe("tied");
      expect(decaySameRecordedAt.freshnessGapWithinPair).toBe(0);
      expect(decaySameRecordedAt.totalRatio).not.toBeNull();
      expect(Math.abs(decaySameRecordedAt.totalRatio! - 1)).toBeLessThan(TIE_EPSILON);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});

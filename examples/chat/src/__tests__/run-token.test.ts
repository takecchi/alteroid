import { describe, expect, it } from "vitest";
import { buildArmTenantId, newRunToken } from "../retrieval-quality.js";

/**
 * `newRunToken`/`buildArmTenantId`(ADR 0068 ①-1c)の契約そのものを、DB 無しで
 * 素早く測る歯。`retrieval-quality-ingest-honesty.postgres.test.ts` の①-1が
 * end-to-end で同じ契約を踏むが、それは DB を要求する分遅い——ここでは純関数としての
 * 契約(「2回呼べば必ず違う」「同じ token なら同じ tenantId」)だけを高速に固定する。
 */
describe("newRunToken", () => {
  it("2回呼べば必ず違う値を返す(多数回呼んでも衝突しない)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(newRunToken());
    }
    expect(seen.size).toBe(1000);
  });
});

describe("buildArmTenantId", () => {
  it("同じ armKey・同じ runToken なら同じ tenantId になる", () => {
    const token = newRunToken();
    expect(buildArmTenantId("a", token)).toBe(buildArmTenantId("a", token));
  });

  it("runToken が違えば必ず違う tenantId になる(実行ごとの再現性事故を防ぐ本体)", () => {
    const token1 = newRunToken();
    const token2 = newRunToken();
    expect(buildArmTenantId("a", token1)).not.toBe(buildArmTenantId("a", token2));
  });

  it("armKey が違えば、同じ runToken でも別の tenantId になる(arm 同士が混ざらない)", () => {
    const token = newRunToken();
    expect(buildArmTenantId("a", token)).not.toBe(buildArmTenantId("b", token));
  });
});

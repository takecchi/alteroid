import { describe, expect, it } from "vitest";
import { decideDryRun } from "../publish-dry-run.mjs";

/**
 * `scripts/publish-dry-run.mjs` の歯（純関数）。
 *
 * これは `.github/workflows/publish.yml` の fail-open を塞いだ変更の芯である。
 * 直す前の shell 条件式は「`workflow_dispatch` かつ `dry_run === "true"`」の
 * ときだけ予行にし、それ以外は**すべて本番**にしていた——つまり想定外の値
 * （空文字・未定義・`"TRUE"`・`"1"` 等）は黙って本番へ倒れる fail-open だった。
 *
 * ここでは「危険と明示されたときだけ本番」という反転後の判定表そのものを、
 * shell を経由せず直接検査する。
 */
describe("decideDryRun（publish.yml の fail-open を塞いだ判定）", () => {
  it('workflow_dispatch × dry_run="true" ⟹ 予行・警告なし', () => {
    const result = decideDryRun({ eventName: "workflow_dispatch", dryRunInput: "true" });
    expect(result.dryRun).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('workflow_dispatch × dry_run="false" ⟹ 本番・警告なし', () => {
    const result = decideDryRun({ eventName: "workflow_dispatch", dryRunInput: "false" });
    expect(result.dryRun).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("release ⟹ 本番（dry_run の値が何であっても関係ない）・警告なし", () => {
    for (const dryRunInput of ["true", "false", "", undefined, "TRUE", "1"]) {
      const result = decideDryRun({ eventName: "release", dryRunInput });
      expect(result.dryRun, `dryRunInput=${JSON.stringify(dryRunInput)}`).toBe(false);
      expect(result.warnings, `dryRunInput=${JSON.stringify(dryRunInput)}`).toEqual([]);
    }
  });

  /**
   * ⭐ 芯。直す前のコードは、ここに挙げた値のどれに対しても本番（fail-open）を返していた。
   * 直した後は、どの想定外の値に対しても予行を返し、かつ警告を1本以上積むこと。
   */
  describe("workflow_dispatch × 想定外の dry_run ⟹ 予行（安全側）・警告あり", () => {
    const unexpectedValues = ["", undefined, "TRUE", "True", "1", "yes", "dry-run", "null"];

    for (const dryRunInput of unexpectedValues) {
      it(`dry_run=${JSON.stringify(dryRunInput)}`, () => {
        const result = decideDryRun({ eventName: "workflow_dispatch", dryRunInput });
        expect(result.dryRun).toBe(true);
        expect(result.warnings.length).toBeGreaterThanOrEqual(1);
        // 何が想定外だったかを名指ししていること（黙って倒れていないこと）。
        expect(result.warnings.join("\n")).toContain("dry_run");
      });
    }
  });

  it("release でも workflow_dispatch でもない event_name ⟹ 予行（安全側）・警告あり", () => {
    const result = decideDryRun({ eventName: "push", dryRunInput: undefined });
    expect(result.dryRun).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.join("\n")).toContain("push");
  });
});

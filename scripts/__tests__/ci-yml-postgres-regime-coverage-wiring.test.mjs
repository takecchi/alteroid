import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPECTED_SERVER_ENCODINGS } from "../lexical-regime-coverage-lib.mjs";

/**
 * ⭐ **この歯が測っているもの(消す前に読むこと)**
 *
 * **`.github/workflows/ci.yml` に、「両方の server_encoding regime が実際に走ったか」を
 * 測る `postgres-regime-coverage` ジョブが実際に配線されていること**(Issue #155
 * 満たすべきこと2)。
 *
 * `postgres` ジョブを matrix にしただけでは、片方の脚が skip/失敗しても
 * `postgres` ジョブ自体は(もう片方の脚が通れば)緑になりうる——⛔ それを
 * 「両方測れた」と読ませないための後続ジョブが要る。この歯は:
 *
 * 1. `postgres-regime-coverage` ジョブが存在し、`needs: postgres` / `if: always()`
 *    を持つこと(matrix の一部が落ちても走ること)。
 * 2. `needs.postgres.result` が `skipped` のとき明示的に非0で終わる段があること
 *    (skip を成功として読ませない)。
 * 3. `lexical-regime-*` パターンで artifact をダウンロードする段があること。
 * 4. `scripts/lexical-regime-coverage.mjs` を実行する段があること。
 * 5. 🔴 **`scripts/lexical-regime-coverage-lib.mjs` の `EXPECTED_SERVER_ENCODINGS`
 *    (このジョブが期待する脚の集合)が、`postgres` ジョブの matrix の脚
 *    (`scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` が固定している側)
 *    と一致すること。** 期待する脚の集合をスクリプト側にハードコードした二重管理なので、
 *    ずれたら赤くなるようにする——(c) と同じ思想。
 *
 * ⚠ **YAML は構造として解析していない(文字列で見ている)。**
 * 既存の wiring テストと同じ判断(依存追加はオーナー専権。`docs/autonomy.md`)。
 * 壊れたときは「配線が変わった」か「取り出し方が古い」かを見て、配線が変わっていない
 * なら取り出し方を直すこと(歯を消さないこと)。
 */

const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const COVERAGE_JOB_ID = "postgres-regime-coverage";
const POSTGRES_JOB_ID = "postgres";

/**
 * `jobs:` の下の1ジョブを切り出す(`ci-yml-postgres-regime-wiring.test.mjs` の
 * `extractJob` と同じ形。ファイルをまたいで共有していない——既存の wiring テスト群も
 * 各ファイルが自己完結している)。
 *
 * @param {string} jobId
 * @returns {string}
 */
function extractJob(jobId) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。Issue #155 が対象にしているジョブが消えたか、` +
        "名前が変わったか、インデントが変わった。",
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * `postgres` ジョブの `strategy.matrix.include` から `serverEncoding` の集合だけを
 * 取り出す(`ci-yml-postgres-regime-wiring.test.mjs` の `extractMatrixLegs` の
 * 簡約版——この歯は集合の一致だけを見るので initdbArgs までは要らない)。
 *
 * @returns {string[]}
 */
function extractMatrixServerEncodings() {
  const jobBlock = extractJob(POSTGRES_JOB_ID);
  const lines = jobBlock.split("\n");
  const includeAt = lines.findIndex((line) => line === "        include:");
  if (includeAt === -1) {
    throw new Error(
      "ci.yml の postgres ジョブに strategy.matrix.include が無い(Issue #155 の matrix 化が外れている)。",
    );
  }
  const encodings = [];
  for (let i = includeAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const legStart = /^ {10}- serverEncoding: (.+)$/.exec(line);
    if (legStart) {
      encodings.push(legStart[1].trim());
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#") || /^ {10,}/.test(line)) {
      continue;
    }
    break;
  }
  return encodings;
}

const coverageJobBlock = extractJob(COVERAGE_JOB_ID);

describe("ci.yml の postgres-regime-coverage ジョブの配線(Issue #155 満たすべきこと2)", () => {
  it("ジョブが存在し、needs: postgres / if: always() を持つ(片脚が落ちても走る)", () => {
    expect(coverageJobBlock).toContain("needs: postgres");
    expect(coverageJobBlock).toContain("if: always()");
  });

  it("🔴 needs.postgres.result が skipped のとき非0で終わる段がある(skip を成功として読ませない)", () => {
    expect(coverageJobBlock).toContain("needs.postgres.result");
    expect(coverageJobBlock).toMatch(/skipped/);
    expect(coverageJobBlock).toContain("exit 1");
  });

  it("lexical-regime-* パターンで artifact をダウンロードする段がある", () => {
    expect(coverageJobBlock).toContain("uses: actions/download-artifact@v");
    expect(coverageJobBlock).toContain("pattern: lexical-regime-*");
  });

  it("scripts/lexical-regime-coverage.mjs を実行する段がある", () => {
    expect(coverageJobBlock).toContain("lexical-regime-coverage.mjs");
    expect(coverageJobBlock).toContain("--artifacts-dir");
  });

  it("🔴🔴 lib の EXPECTED_SERVER_ENCODINGS が、postgres ジョブの matrix の脚と一致する(二重管理が壊れたら赤くなる)", () => {
    const matrixEncodings = extractMatrixServerEncodings();
    expect(new Set(matrixEncodings)).toEqual(new Set(EXPECTED_SERVER_ENCODINGS));
    // 集合だけでなく個数も一致すること(片方に重複があるケースを拾う)。
    expect(matrixEncodings).toHaveLength(EXPECTED_SERVER_ENCODINGS.length);
  });
});

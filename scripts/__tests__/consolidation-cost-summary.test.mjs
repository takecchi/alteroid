import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/consolidation-cost-summary.mjs` の歯。**本物のスクリプトを子プロセスとして
 * 実際に起動する**(`scripts/__tests__/retrieval-quality-summary.test.mjs` と同じ判断)
 * ——`consolidation-cost-summary-lib.test.mjs` は純関数だけを見ており、
 * 「CLI としての配線」(引数の読み方・ファイル I/O・exit code)はここでしか測れない。
 *
 * DB は要求しない——このスクリプトは JSON ファイル1〜2個を読むだけである。
 *
 * ⛔ `examples/chat/consolidation-baseline.json` はまだコミットされていない。ここで使う
 * measured/baseline はすべてこの歯の中で組み立てたインライン fixture である。
 */

const script = fileURLToPath(new URL("../consolidation-cost-summary.mjs", import.meta.url));

function makeProbe(overrides = {}) {
  return {
    probeId: "color",
    carriedCount: 2,
    carriedDigestTokens: 10,
    usageChars: 100,
    usageEstimatedTokens: 40,
    usageIndexChars: 10,
    totalInScope: 20,
    goldRank: 1,
    recalledActiveShare: 0.2,
    omittedKinds: [],
    budgetExceeded: false,
    ...overrides,
  };
}

function makeMean(overrides = {}) {
  return {
    carriedCount: 2,
    carriedDigestTokens: 10,
    usageChars: 100,
    usageEstimatedTokens: 40,
    usageIndexChars: 10,
    totalInScope: 20,
    recalledActiveShare: 0.2,
    goldRank: 1,
    goldRankExcludedCount: 0,
    ...overrides,
  };
}

function makeRound(overrides = {}) {
  return {
    round: 0,
    consolidation: null,
    store: {
      activeCount: 10,
      supersededCount: 0,
      activeContentChars: 500,
      activeContentTokens: 120,
      activeDigestChars: 200,
      activeDigestTokens: 60,
      allContentChars: 500,
    },
    recall: {
      unbudgeted: { probes: [makeProbe()], mean: makeMean() },
      budgeted: [{ budgetTokens: 32, probes: [makeProbe()], mean: makeMean() }],
    },
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "measured",
    measuredAt: "2026-09-10T00:00:00.000Z",
    commit: "0".repeat(40),
    llmMode: "deterministic",
    embeddingMode: "local",
    embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    probeCount: 1,
    haystackSize: 20,
    groupSize: 5,
    budgetLadder: [32],
    recallLimit: 50,
    stoppedAfterRound: 0,
    stopReason: "completed_all_rounds",
    rounds: [makeRound()],
    ...overrides,
  };
}

function makeBaselineRound(overrides = {}) {
  return {
    round: 0,
    consolidation: null,
    store: makeRound().store,
    recall: {
      unbudgeted: { mean: makeMean() },
      budgeted: [{ budgetTokens: 32, mean: makeMean() }],
    },
    ...overrides,
  };
}

function makeBaseline(overrides = {}) {
  return { ...makeMeasured(overrides), rounds: overrides.rounds ?? [makeBaselineRound()] };
}

let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function writeJson(name, data) {
  workDir ??= mkdtempSync(join(tmpdir(), "consolidation-cost-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("consolidation-cost-summary.mjs(子プロセスで起動)", () => {
  it("--measured だけを渡すと exit 0 で、差分節を出さない", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const result = run(["--measured", measuredPath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("基準値との差分");
  });

  it("基準値と一致するときは exit 0 で「一致」と出す", () => {
    const measured = makeMeasured();
    const measuredPath = writeJson("measured.json", measured);
    const baselinePath = writeJson("baseline.json", makeBaseline());
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("一致(差分なし)。");
  });

  it("🔴 基準値と相違するときも exit 0(門ではないことをここで固定する。ADR 0088 §2.1)", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const round = makeBaselineRound();
    round.store.activeCount = 999;
    const baselinePath = writeJson("baseline.json", makeBaseline({ rounds: [round] }));
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("相違した箇所がある");
    expect(result.stdout).toContain("store.activeCount");
  });

  it("weights_unavailable な measured でも exit 0", () => {
    const measuredPath = writeJson("measured.json", {
      status: "weights_unavailable",
      detail: "重みを取得できなかったので、値は測っていない: network error",
    });
    const result = run(["--measured", measuredPath]);
    expect(result.status, result.stderr).toBe(0);
  });

  it("🔴 weights_unavailable ＋ --baseline でも exit 0 で、比較を1つも出さない", () => {
    const measuredPath = writeJson("measured.json", {
      status: "weights_unavailable",
      detail: "重みを取得できなかったので、値は測っていない: network error",
    });
    const baselinePath = writeJson("baseline.json", makeBaseline());
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("基準値との差分");
    expect(result.stdout).not.toContain("一致");
    expect(result.stdout).not.toContain("相違");
  });

  it("3つの読み方の注意書きが出る", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const result = run(["--measured", measuredPath]);
    expect(result.stdout).toContain("擬似物の性質である");
    expect(result.stdout).toContain("probe 7件");
    expect(result.stdout).toContain("件数が減ったこと自体は良し悪しを言わない");
  });

  it("gold を載せるのに要った最小予算の節・退化検出の節が出る", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const result = run(["--measured", measuredPath]);
    expect(result.stdout).toContain("gold を載せるのに要った最小予算");
    expect(result.stdout).toContain("退化検出");
  });

  it("--measured を渡さないと非0", () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
  });

  it("--measured のパスが存在しないと非0", () => {
    const result = run(["--measured", join(tmpdir(), "does-not-exist-12345.json")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/読めない/);
  });

  it("--measured の中身が壊れた JSON(構文エラー)だと非0", () => {
    const measuredPath = writeJson("broken.json", "{ this is not json");
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parse/);
  });

  it("--measured の必須項目が無いと非0(壊れた入力=赤)", () => {
    const measured = makeMeasured();
    delete measured.llmMode;
    const measuredPath = writeJson("missing-field.json", measured);
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("llmMode");
  });

  it("--measured の round.store に必須項目が無いと非0", () => {
    const round = makeRound();
    delete round.store.activeCount;
    const measuredPath = writeJson("missing-store-field.json", makeMeasured({ rounds: [round] }));
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("activeCount");
  });

  it("--baseline を指定してそれが読めないと非0(baseline も「入力」である)", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const result = run([
      "--measured",
      measuredPath,
      "--baseline",
      join(tmpdir(), "does-not-exist-baseline-12345.json"),
    ]);
    expect(result.status).not.toBe(0);
  });

  it("--baseline の中身が壊れていると非0", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const baselinePath = writeJson("broken-baseline.json", "not json at all");
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status).not.toBe(0);
  });

  it("--baseline の status が measured でないと非0(基準値は常に measured のはず)", () => {
    const measuredPath = writeJson("measured.json", makeMeasured());
    const baselinePath = writeJson("baseline.json", {
      status: "weights_unavailable",
      detail: "x",
    });
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status).not.toBe(0);
  });
});

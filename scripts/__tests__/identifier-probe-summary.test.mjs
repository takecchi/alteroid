import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/identifier-probe-summary.mjs` の歯。**本物のスクリプトを子プロセスとして
 * 実際に起動する**(`scripts/__tests__/retrieval-quality-summary.test.mjs` と同じ形・
 * 同じ理由)——`identifier-probe-summary-lib.test.mjs` は純関数だけを見ており、
 * 「CLI としての配線」(引数の読み方・ファイル I/O・**exit code**)はここでしか測れない。
 *
 * 🔴 **このファイルが固定している線**:
 *
 * 1. **基準値と相違しても exit 0**(⛔ 門ではない。ADR 0094 / ADR 0088 §2.1)。
 * 2. **`status: "weights_unavailable"` でも exit 0**、かつ比較を1つも出さない。
 * 3. **入力そのものが壊れていれば非0**(JSON が読めない・parse できない・`status` が
 *    未知・`"measured"` なのに必須項目が無い・`--baseline` が壊れている)。
 *
 * DB もネットワークも要求しない——このスクリプトは JSON ファイルを最大2つ読むだけである。
 */

const script = fileURLToPath(new URL("../identifier-probe-summary.mjs", import.meta.url));

function makeGroup(overrides = {}) {
  return {
    label:
      "identifier-probes/identifiers-sparse(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元, haystack=sparse)",
    llmMode: "deterministic",
    embeddingMode: "local",
    embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
    haystackKind: "sparse",
    mrrOverall: 1,
    hit1Count: 12,
    hit10Count: 12,
    probeCount: 12,
    ...overrides,
  };
}

function makeMeasured(overrides = {}) {
  return {
    schemaVersion: 2,
    status: "measured",
    measuredAt: "2026-09-10T00:00:00.000Z",
    commit: "abc123",
    japanese: makeGroup({
      label:
        "identifier-probes/japanese(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元, haystack=sparse)",
      mrrOverall: 0.81,
      hit1Count: 5,
      hit10Count: 7,
      probeCount: 7,
    }),
    identifiersSparse: makeGroup(),
    identifiersDense: makeGroup({
      label:
        "identifier-probes/identifiers-dense(llm=deterministic, embedding=local/ruri-v3-30m/sym/256次元, haystack=dense)",
      haystackKind: "dense",
    }),
    ...overrides,
  };
}

function baselineFrom(measured) {
  return {
    groups: [
      { group: "japanese", ...structuredClone(measured.japanese) },
      { group: "identifiersSparse", ...structuredClone(measured.identifiersSparse) },
      { group: "identifiersDense", ...structuredClone(measured.identifiersDense) },
    ],
  };
}

let workDir;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function writeJson(name, data) {
  workDir ??= mkdtempSync(join(tmpdir(), "identifier-probe-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("identifier-probe-summary.mjs（子プロセスで起動）", () => {
  it("--measured だけを渡すと exit 0 で、差分節を出さない", () => {
    const result = run(["--measured", writeJson("measured.json", makeMeasured())]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("基準値との差分");
    expect(result.stdout).toContain("identifier-probes/identifiers-sparse");
  });

  it("基準値と一致するときは exit 0 で『一致』と出す", () => {
    const measured = makeMeasured();
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baselineFrom(measured)),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("一致（差分なし）");
  });

  it("🔴 基準値と相違するときも exit 0（⛔ 門ではないことをここで固定する）", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    baseline.groups[0].hit1Count = 1; // 「想起の質が大きく劣化した」に相当
    baseline.groups[0].mrrOverall = 0.2;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("相違した群が 1 件ある");
    expect(result.stdout).toContain("hit1Count");
  });

  it("🔴 weights_unavailable でも exit 0（測れなかったことは、この要約にとって壊れた入力ではない）", () => {
    const result = run([
      "--measured",
      writeJson("weights.json", {
        schemaVersion: 2,
        status: "weights_unavailable",
        measuredAt: "2026-09-10T00:00:00.000Z",
        commit: "abc123",
        detail: "HTTP 503 from the model host",
      }),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("重みを取得できなかったので、値は測っていない");
  });

  it("🔴 weights_unavailable ＋ --baseline でも exit 0 で、比較を1つも出さない", () => {
    const result = run([
      "--measured",
      writeJson("weights.json", {
        schemaVersion: 2,
        status: "weights_unavailable",
        measuredAt: "2026-09-10T00:00:00.000Z",
        commit: "abc123",
        detail: "HTTP 503 from the model host",
      }),
      "--baseline",
      writeJson("baseline.json", baselineFrom(makeMeasured())),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("基準値との差分");
    expect(result.stdout).not.toContain("一致");
    expect(result.stdout).not.toContain("相違");
    expect(result.stdout).not.toContain("ruri-v3-30m/sym");
  });

  it("--measured を渡さないと非0", () => {
    expect(run([]).status).not.toBe(0);
  });

  it("--measured のパスが存在しないと非0", () => {
    const result = run(["--measured", join(tmpdir(), "does-not-exist-identifier-12345.json")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/読めない/);
  });

  it("--measured の中身が壊れた JSON（構文エラー）だと非0", () => {
    const result = run(["--measured", writeJson("broken.json", "{ これは JSON ではない")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parse/);
  });

  it("--measured の status が未知の値だと非0", () => {
    const result = run(["--measured", writeJson("unknown.json", { status: "とても良かった" })]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("status");
  });

  it("--measured の群に必須項目が無いと非0", () => {
    const measured = makeMeasured();
    delete measured.identifiersDense.hit1Count;
    const result = run(["--measured", writeJson("missing-field.json", measured)]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("identifiersDense.hit1Count");
  });

  it("--baseline を指定してそれが読めないと非0（baseline も『入力』である）", () => {
    const result = run([
      "--measured",
      writeJson("measured.json", makeMeasured()),
      "--baseline",
      join(tmpdir(), "does-not-exist-identifier-baseline-12345.json"),
    ]);
    expect(result.status).not.toBe(0);
  });

  it("--baseline の中身が壊れていると非0", () => {
    const result = run([
      "--measured",
      writeJson("measured.json", makeMeasured()),
      "--baseline",
      writeJson("broken-baseline.json", "not json at all"),
    ]);
    expect(result.status).not.toBe(0);
  });

  it("--baseline の群に group キーが無いと非0（どの群と比べたのか言えない入力は壊れている）", () => {
    const measured = makeMeasured();
    const baseline = baselineFrom(measured);
    delete baseline.groups[0].group;
    const result = run([
      "--measured",
      writeJson("measured.json", measured),
      "--baseline",
      writeJson("baseline.json", baseline),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("group");
  });
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/retrieval-quality-summary.mjs` の歯。**本物のスクリプトを子プロセスとして
 * 実際に起動する**(`scripts/__tests__/publish-yml-dry-run-wiring.test.mjs` /
 * `scripts/__tests__/decide-publish-dry-run.test.mjs` と同じ判断)——
 * `retrieval-quality-summary-lib.test.mjs` は純関数だけを見ており、
 * 「CLI としての配線」(引数の読み方・ファイル I/O・exit code)はここでしか測れない。
 *
 * DB は要求しない——このスクリプトは JSON ファイル2つを読むだけである。
 */

const script = fileURLToPath(new URL("../retrieval-quality-summary.mjs", import.meta.url));

function makeArm(overrides = {}) {
  return {
    armLabel: "A: 擬似LLM+擬似埋め込み",
    llmMode: "deterministic",
    embeddingMode: "deterministic",
    mrrOverall: 0.018,
    mrrLexicalControl: 0,
    mrrNonLexical: 0.021,
    hit1Count: 0,
    hit10Count: 1,
    probeCount: 7,
    ...overrides,
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
  workDir ??= mkdtempSync(join(tmpdir(), "retrieval-quality-summary-"));
  const path = join(workDir, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("retrieval-quality-summary.mjs（子プロセスで起動）", () => {
  it("--measured だけを渡すと exit 0 で、差分節を出さない", () => {
    const measuredPath = writeJson("measured.json", { arms: [makeArm()] });
    const result = run(["--measured", measuredPath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("基準値との差分");
    expect(result.stdout).toContain("A: 擬似LLM+擬似埋め込み");
  });

  it("基準値と一致するときは exit 0 で『一致』と出す", () => {
    const arms = [makeArm()];
    const measuredPath = writeJson("measured.json", { arms });
    const baselinePath = writeJson("baseline.json", { arms });
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("一致（差分なし）");
  });

  it("基準値と相違するときも exit 0（🔴 門ではないことをここで固定する）", () => {
    const measuredPath = writeJson("measured.json", { arms: [makeArm({ mrrOverall: 0.5 })] });
    const baselinePath = writeJson("baseline.json", { arms: [makeArm({ mrrOverall: 0.018 })] });
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("相違した arm が 1 件ある");
    expect(result.stdout).toContain("mrrOverall");
  });

  it("arm ごとの表で arm・モード・MRR/hit@1/hit@10 が同一行に出る", () => {
    const measuredPath = writeJson("measured.json", { arms: [makeArm()] });
    const result = run(["--measured", measuredPath]);
    const row = result.stdout.split("\n").find((line) => line.includes("A: 擬似LLM+擬似埋め込み"));
    expect(row).toBeDefined();
    expect(row).toContain("deterministic");
    expect(row).toContain("0.018");
    expect(row).toContain("0/7");
    expect(row).toContain("1/7");
  });

  it("3つの読み方の注意書きが出る", () => {
    const measuredPath = writeJson("measured.json", { arms: [makeArm()] });
    const result = run(["--measured", measuredPath]);
    expect(result.stdout).toContain("similarity");
    expect(result.stdout).toContain("probe 7件");
    expect(result.stdout).toContain("否定・時制・矛盾");
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

  it("--measured の中身が壊れた JSON（構文エラー）だと非0", () => {
    const measuredPath = writeJson("broken.json", "{ this is not json");
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/parse/);
  });

  it("--measured に arms が無いと非0", () => {
    const measuredPath = writeJson("no-arms.json", { schemaVersion: 1 });
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
  });

  it("--measured の arm に必須項目が無いと非0", () => {
    const arm = makeArm();
    delete arm.hit1Count;
    const measuredPath = writeJson("missing-field.json", { arms: [arm] });
    const result = run(["--measured", measuredPath]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("hit1Count");
  });

  it("--baseline を指定してそれが読めないと非0（basline も『入力』である）", () => {
    const measuredPath = writeJson("measured.json", { arms: [makeArm()] });
    const result = run([
      "--measured",
      measuredPath,
      "--baseline",
      join(tmpdir(), "does-not-exist-baseline-12345.json"),
    ]);
    expect(result.status).not.toBe(0);
  });

  it("--baseline の中身が壊れていると非0", () => {
    const measuredPath = writeJson("measured.json", { arms: [makeArm()] });
    const baselinePath = writeJson("broken-baseline.json", "not json at all");
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status).not.toBe(0);
  });

  it("測定に無い arm が基準値にだけあっても、それは exit 0（壊れていない・入力として妥当）", () => {
    const measuredPath = writeJson("measured.json", { arms: [makeArm()] });
    const baselinePath = writeJson("baseline.json", {
      arms: [makeArm(), makeArm({ armLabel: "廃止された arm" })],
    });
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("廃止された arm");
  });

  it("測定にある arm が基準値に無いときも exit 0 で、その旨を出す", () => {
    const measuredPath = writeJson("measured.json", {
      arms: [makeArm(), makeArm({ armLabel: "新しい arm" })],
    });
    const baselinePath = writeJson("baseline.json", { arms: [makeArm()] });
    const result = run(["--measured", measuredPath, "--baseline", baselinePath]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("新しい arm");
    expect(result.stdout).toContain("基準値が無い");
  });
});

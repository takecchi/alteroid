import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの(消す前に読むこと)**
 *
 * **`.github/workflows/ci.yml` の `consolidation-cost` ジョブが、実際に
 * `scripts/consolidation-cost-summary.mjs` へ配線されていること。**
 *
 * ⚠ **これは `consolidation-cost-summary.test.mjs` / `consolidation-cost-summary-lib.test.mjs`
 * の重複ではない**(`ci-yml-retrieval-wiring.test.mjs` の docstring と同じ理由)。
 * その2本は**入力を自分で作って**要約の中身と exit code を測る——**どちらも `ci.yml` を
 * 1バイトも読まない。**⟹ 誰かが `ci.yml` から要約の段を消しても、`--baseline` のパスを
 * 打ち間違えても、`MNEMORA_CONSOLIDATION_JSON` の書き先と `--measured` の読み先を
 * ずらしても、**その2本は緑のまま通る。**この歯だけが `ci.yml` を入力に取る。
 *
 * ⛔ **`examples/chat/consolidation-baseline.json` はまだコミットされていない**
 * (マネージャーが実測値で作る予定であり、この歯が作ってはいけない)。そのため
 * `identifier-probes` 版の歯(`ci-yml-identifier-probes-wiring.test.mjs`)と違い、
 * **実行系のテストでは summary 段の `--baseline` の値をこの歯の中の一時ファイルへ
 * 差し替えて**走らせる(`substituteBaselinePath`)。**yml に書かれた本来のパス自体**
 * (`examples/chat/consolidation-baseline.json`)は、別のテストで文字列としてだけ固定する
 * ——ファイルの存在は要求しない。
 *
 * ⚠ **YAML は構造として解析していない(文字列で見ている)。**
 * 既存2本の wiring テストと同じ判断で、歯のために YAML パーサの依存を足していない
 * (依存追加はオーナー専権。`docs/autonomy.md`)。**だからこの歯は書き方の変更に弱い。**
 * 壊れたときは「配線が変わった」か「書き方が変わった」かを見て、**配線が変わっていない
 * なら取り出し方のほうを直すこと(歯を消さないこと)。**
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "consolidation-cost";
const BASELINE_RELATIVE_PATH = "examples/chat/consolidation-baseline.json";

/**
 * `jobs:` の下の1ジョブ(`  <id>:` から、次の同じ深さの `  <id>:` まで)を切り出す
 * (`ci-yml-retrieval-wiring.test.mjs` の `extractJob` と同じ形)。
 *
 * @param {string} yaml
 * @param {string} jobId
 * @returns {string}
 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。Issue #136 が足したジョブが消えたか、` +
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
 * ジョブ直下の `env:` を読む(段の中の `env:` は拾わない)。
 *
 * @param {string} jobBlock
 * @returns {Record<string, string>}
 */
function parseJobEnv(jobBlock) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((line) => line === "    env:");
  if (start === -1) {
    return {};
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const matched = /^ {6}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line);
    if (!matched) {
      break;
    }
    env[matched[1]] = matched[2].trim();
  }
  return env;
}

/**
 * `steps:` を段へ切り分け、各段の `name` / `env` / `run` だけを取り出す
 * (既存2本の wiring テストと同じ形)。
 *
 * @param {string} jobBlock
 * @returns {{ name: string, env: Record<string, string>, run: string }[]}
 */
function parseSteps(jobBlock) {
  const lines = jobBlock.split("\n");
  const stepsAt = lines.findIndex((line) => line === "    steps:");
  if (stepsAt === -1) {
    throw new Error(`ci.yml の ${JOB_ID} ジョブに \`    steps:\` が無い`);
  }
  /** @type {{ name: string, env: Record<string, string>, run: string }[]} */
  const steps = [];
  /** @type {{ name: string, env: Record<string, string>, runLines: string[] } | undefined} */
  let current;
  let mode = "none";

  const flush = () => {
    if (current) {
      steps.push({
        name: current.name,
        env: current.env,
        run: current.runLines.map((l) => l.replace(/^ {10}/, "")).join("\n"),
      });
    }
  };

  for (let i = stepsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const nameMatched = /^ {6}- name: (.*)$/.exec(line);
    if (nameMatched) {
      flush();
      current = { name: nameMatched[1], env: {}, runLines: [] };
      mode = "none";
      continue;
    }
    if (!current) {
      continue;
    }
    if (line === "        env:") {
      mode = "env";
      continue;
    }
    if (/^ {8}run: \|/.test(line)) {
      mode = "run";
      continue;
    }
    const inlineRun = /^ {8}run: (.+)$/.exec(line);
    if (inlineRun) {
      current.runLines.push(`          ${inlineRun[1]}`);
      mode = "none";
      continue;
    }
    if (mode === "env") {
      const envMatched = /^ {10}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line);
      if (envMatched) {
        current.env[envMatched[1]] = envMatched[2].trim();
        continue;
      }
      mode = "none";
    }
    if (mode === "run") {
      if (line.trim() === "" || /^ {10}/.test(line)) {
        current.runLines.push(line);
        continue;
      }
      mode = "none";
    }
  }
  flush();
  return steps;
}

const jobBlock = extractJob(workflow, JOB_ID);
const jobEnv = parseJobEnv(jobBlock);
const steps = parseSteps(jobBlock);

const benchStep = steps.find((step) => step.env.MNEMORA_CONSOLIDATION_JSON !== undefined);
const summaryStep = steps.find((step) => step.run.includes("consolidation-cost-summary.mjs"));
const artifactStep = steps.find((step) => step.name.includes("成果物として残す"));

/**
 * ある段の生テキスト(`- name: <name>` から次の段の `- name:` まで)を切り出す。
 * `parseSteps` は `if:`/`uses:`/`with:` を読まないので、それらを検査したいときは
 * こちらを使う。
 *
 * @param {string} stepName
 * @returns {string | undefined}
 */
function extractStepBlock(stepName) {
  const lines = jobBlock.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start === -1) {
    return undefined;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {6}- name:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * `${{ github.workspace }}` を実際の場所に置き換える。
 *
 * @param {string} text
 * @param {string} workspace
 * @returns {string}
 */
function substituteWorkspace(text, workspace) {
  const replaced = text.replaceAll("${{ github.workspace }}", workspace);
  if (replaced.includes("${{")) {
    throw new Error(
      `この歯が解釈できない GitHub Actions の式が残っている: ${replaced}。` +
        "式が増えたなら、この歯の置き換えのほうを足すこと(歯を消さないこと)。",
    );
  }
  return replaced;
}

/**
 * bench が JSON を書く先(`MNEMORA_CONSOLIDATION_JSON`)を yml から読む。
 * **この歯はパスを自分では書かない**——書き写すと、yml 側が変わったときに
 * 歯のほうが古いまま緑になる。
 *
 * @returns {string}
 */
function benchStepMeasuredPath() {
  if (!benchStep) {
    throw new Error(
      "ci.yml の consolidation-cost ジョブに MNEMORA_CONSOLIDATION_JSON を渡す段が無い。" +
        "機械可読な出力口への配線が外れている。",
    );
  }
  return benchStep.env.MNEMORA_CONSOLIDATION_JSON;
}

/** `--baseline <path>` を yml から読む(引用符あり・なしの両方を拾う)。 */
function summaryStepBaselinePath() {
  const matched = /--baseline\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
  return matched ? (matched[1] ?? matched[2]) : undefined;
}

/**
 * yml から取り出した要約の段を、実際に走らせる。
 *
 * ⛔ **baseline のパスは、yml に書かれた実物ではなく、この歯が用意した一時ファイルへ
 * 差し替える**(`examples/chat/consolidation-baseline.json` はまだコミットされていない
 * ため)。差し替えは文字列置換のみ——script の他の部分(node の呼び出し・`--measured` の
 * パスなど)はそのまま使う。
 *
 * @param {unknown} measured `--measured` が読むファイルに書き込む中身
 * @param {unknown} [baseline] `--baseline` が読むファイルに書き込む中身。省略時は
 *   `--baseline` の指定ごと script から取り除いて走らせる(measured のみのケース用)。
 * @returns {{ status: number, summary: string, stderr: string }}
 */
function runSummaryStepFromWorkflow(measured, baseline) {
  if (!summaryStep) {
    throw new Error(
      "ci.yml の consolidation-cost ジョブに consolidation-cost-summary.mjs を打つ段が無い。" +
        "「値を Job Summary に残す」配線が外れている。",
    );
  }
  const realBaselineFlag = summaryStepBaselinePath();
  if (!realBaselineFlag) {
    throw new Error("summary の段に --baseline の指定が無い。");
  }
  const workspace = mkdtempSync(join(tmpdir(), "mnemora-consolidation-wiring-"));
  try {
    let script = substituteWorkspace(summaryStep.run, workspace);
    const measuredPath = substituteWorkspace(benchStepMeasuredPath(), workspace);
    writeFileSync(
      measuredPath,
      typeof measured === "string" ? measured : `${JSON.stringify(measured, null, 2)}\n`,
      "utf8",
    );
    if (baseline === undefined) {
      // --baseline の指定ごと落として、measured のみで走らせる。
      script = script.replace(/\s*--baseline\s+(?:"[^"]+"|[^\s\\]+)/, "");
    } else {
      const tempBaselinePath = join(workspace, "baseline.json");
      writeFileSync(
        tempBaselinePath,
        typeof baseline === "string" ? baseline : `${JSON.stringify(baseline, null, 2)}\n`,
        "utf8",
      );
      script = script.replace(realBaselineFlag, tempBaselinePath);
    }
    const summaryPath = join(workspace, "step-summary.md");
    writeFileSync(summaryPath, "", "utf8");
    const result = spawnSync("bash", ["-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    });
    return {
      status: result.status ?? -1,
      summary: readFileSync(summaryPath, "utf8"),
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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
    rounds: [
      {
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
          unbudgeted: {
            probes: [
              {
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
              },
            ],
            mean: {
              carriedCount: 2,
              carriedDigestTokens: 10,
              usageChars: 100,
              usageEstimatedTokens: 40,
              usageIndexChars: 10,
              totalInScope: 20,
              recalledActiveShare: 0.2,
              goldRank: 1,
              goldRankExcludedCount: 0,
            },
          },
          budgeted: [],
        },
      },
    ],
    ...overrides,
  };
}

function makeBaseline(overrides = {}) {
  const measured = makeMeasured(overrides);
  return {
    ...measured,
    rounds: measured.rounds.map((round) => ({
      ...round,
      recall: {
        unbudgeted: { mean: round.recall.unbudgeted.mean },
        budgeted: round.recall.budgeted.map(({ probes: _probes, ...rung }) => rung),
      },
    })),
  };
}

describe("ci.yml の consolidation-cost ジョブの配線", () => {
  it("ジョブ自体が存在する(measure/summary/artifact の3段を持つ)", () => {
    expect(benchStep, "MNEMORA_CONSOLIDATION_JSON を渡す測定段が無い").toBeDefined();
    expect(summaryStep, "consolidation-cost-summary.mjs を打つ段が無い").toBeDefined();
    expect(artifactStep, "成果物を upload する段が無い").toBeDefined();
  });

  it("⭐ bench が JSON を書く先と、要約が読む先が同じ場所を指している", () => {
    const measuredFlag = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    expect(measuredFlag, "要約の段に --measured の指定が無い").not.toBeNull();
    expect(measuredFlag?.[1] ?? measuredFlag?.[2]).toBe(benchStepMeasuredPath());
  });

  it("🔴 要約の段が --baseline を、マネージャーが用意する予定の基準値ファイルへ渡している", () => {
    // ⭐ **これが「輪が閉じている」ことの固定点。**この行が消えると、値が動いても
    // 誰も気づかず、誰も基準値を更新せず、新しい値が PR の diff に現れなくなる。
    // ⚠ ファイル自体はこの PR の時点でまだコミットされていない(マネージャーが実測値で
    // 作る)——ここではパスの文字列だけを固定し、存在は要求しない。
    expect(summaryStepBaselinePath(), "要約の段に --baseline の指定が無い").toBe(
      BASELINE_RELATIVE_PATH,
    );
  });

  it("DATABASE_URL が設定され、pgvector の service container を使っている", () => {
    expect(jobEnv.DATABASE_URL).toBeDefined();
    expect(jobBlock).toContain("pgvector/pgvector");
  });

  it("拡張作成(vector/btree_gin/pgcrypto)の段がある", () => {
    const extStep = steps.find((step) => step.run.includes("CREATE EXTENSION"));
    expect(extStep, "拡張作成の段が無い").toBeDefined();
    expect(extStep.run).toContain("vector");
    expect(extStep.run).toContain("btree_gin");
    expect(extStep.run).toContain("pgcrypto");
  });

  it("migrate の段がある", () => {
    const migrateStep = steps.find((step) => step.run.includes("run migrate"));
    expect(migrateStep, "migrate を実行する段が無い").toBeDefined();
  });

  it("測定の段が consolidation-cost サブコマンドを起動している", () => {
    expect(benchStep.run).toContain("run consolidation-cost");
  });

  it("🔴 基準値と相違しても緑のまま(⛔ このジョブは門ではない。ADR 0088 の判断を踏襲)", () => {
    const measured = makeMeasured();
    const baseline = makeBaseline();
    baseline.rounds[0].store.activeCount = 1;
    const result = runSummaryStepFromWorkflow(measured, baseline);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("相違した箇所がある");
    expect(result.summary).toContain("store.activeCount");
  });

  it("基準値と一致していれば、その旨が Job Summary に出る(1行で黙る)", () => {
    const measured = makeMeasured();
    const result = runSummaryStepFromWorkflow(measured, makeBaseline());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("一致(差分なし)。");
    expect(result.summary).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("🔴 実測 JSON が壊れていたら赤くなる(bench が壊れた=赤、数字が動いた=赤ではない)", () => {
    const result = runSummaryStepFromWorkflow("{ これは JSON ではない", makeBaseline());
    expect(result.status).not.toBe(0);
  });

  it("weights_unavailable のときも要約の段は exit 0(if: always() の意図どおり)", () => {
    const result = runSummaryStepFromWorkflow(
      { status: "weights_unavailable", detail: "重みを取得できなかったので、値は測っていない: x" },
      makeBaseline(),
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).not.toContain("基準値との差分");
  });

  it("要約ステップに if: always() が付いている(measure が落ちても走る)", () => {
    const block = extractStepBlock(summaryStep.name);
    expect(block, "summary 段の生テキストが見つからない").toBeDefined();
    expect(block).toContain("if: always()");
  });

  it("artifact ステップにも if: always() が付いている(measure が落ちても成果物は残す)", () => {
    const block = extractStepBlock(artifactStep.name);
    expect(block, "artifact 段の生テキストが見つからない").toBeDefined();
    expect(block).toContain("if: always()");
  });

  it("実測値そのものを artifact として upload-artifact に渡している(bench の書き先と同じパス)", () => {
    const block = extractStepBlock(artifactStep.name);
    expect(block).toContain("uses: actions/upload-artifact@v");
    expect(block).toContain(benchStepMeasuredPath());
  });

  it("ジョブに timeout-minutes が設定されている(既定 360 分で刺さらない)", () => {
    expect(jobBlock).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });
});

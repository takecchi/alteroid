import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの(消す前に読むこと)**
 *
 * **`.github/workflows/ci.yml` の `postgres` ジョブが、実際に
 * `scripts/lexical-regime-summary.mjs` へ配線されていること。**(Issue #148)
 *
 * `packages/postgres/src/__tests__/lexical-store-identifier.test.ts` の
 * 「素の to_tsvector で識別子を引けるかどうかは server_encoding で反転する」の歯は、
 * `MNEMORA_LEXICAL_REGIME_JSON` が設定されていれば測った regime を機械可読な JSON として
 * 書く(PR #147 / ADR 0103 の続き)。**それが緑のときにも読めるためには、
 * CI が(1)その環境変数を渡し、(2)出た JSON を要約して Job Summary へ載せ、(3)
 * JSON 自体を artifact として残す、という3段の配線が要る。**
 *
 * ⚠ **これは `lexical-regime-summary.test.mjs`/`lexical-regime-summary-lib.test.mjs`
 * の重複ではない**(`ci-yml-consolidation-wiring.test.mjs` の docstring と同じ理由)。
 * その2本は**入力を自分で作って**要約の中身と exit code を測る——**どちらも `ci.yml` を
 * 1バイトも読まない。**⟹ 誰かが `ci.yml` から summary 段を消しても、
 * `MNEMORA_LEXICAL_REGIME_JSON` の書き先と `--measured` の読み先をずらしても、
 * **その2本は緑のまま通る。**この歯だけが `ci.yml` を入力に取る。
 *
 * 🔴 **さらに、`lexical-store-identifier.test.ts` のソースを文字列として読み、
 * `MNEMORA_LEXICAL_REGIME_JSON` を参照していることも固定する**(下の
 * describe("値を作る側の歯 …") を見ること)——DB を持たない環境(この歯が走る
 * `build` ジョブ自体がそう)でも、「歯が JSON を書く呼び出しごと消された」ことを
 * 赤で捕まえられるようにするためである。⚠ **この固定は文字列一致であり、書き方を
 * 変えれば(例えば別名の環境変数へ書き換える)簡単にすり抜ける。**壊れたときは
 * 「配線が変わった」のか「書き方が変わっただけ」なのかを見て、配線が変わっていない
 * なら固定のしかたを直すこと(既存の wiring 歯と同じ断り書き)。
 *
 * ⚠ **YAML は構造として解析していない(文字列で見ている)。**
 * 既存3本の wiring テストと同じ判断で、歯のために YAML パーサの依存を足していない
 * (依存追加はオーナー専権。`docs/autonomy.md`)。**だからこの歯は書き方の変更に弱い。**
 * 壊れたときは「配線が変わった」か「書き方が変わった」かを見て、**配線が変わっていない
 * なら取り出し方のほうを直すこと(歯を消さないこと)。**
 *
 * ⛔ **この歯は基準値ファイルの存在を要求しない。**`lexical-regime-summary.mjs` は
 * そもそも基準値と比べない(理由は `scripts/lexical-regime-summary-lib.mjs` の
 * docstring——SQL_ASCII をサポート対象にするかをオーナーがまだ決めていない前提の上に
 * 基準値を置くと、実装が先回りしてその判断を決めてしまう)。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "postgres";
const TOOTH_SOURCE_PATH = fileURLToPath(
  new URL(
    "../../packages/postgres/src/__tests__/lexical-store-identifier.test.ts",
    import.meta.url,
  ),
);

/**
 * `jobs:` の下の1ジョブ(`  <id>:` から、次の同じ深さの `  <id>:` まで)を切り出す
 * (`ci-yml-consolidation-wiring.test.mjs` の `extractJob` と同じ形)。
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
      `ci.yml に \`  ${jobId}:\` のジョブが無い。Issue #148 が対象にしているジョブが消えたか、` +
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
 * (既存3本の wiring テストと同じ形)。
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

const benchStep = steps.find((step) => step.env.MNEMORA_LEXICAL_REGIME_JSON !== undefined);
const summaryStep = steps.find((step) => step.run.includes("lexical-regime-summary.mjs"));
const artifactStep = steps.find(
  (step) => step.name.includes("成果物として残す") && step.name.includes("Issue #148"),
);

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
 * 歯が regime JSON を書く先(`MNEMORA_LEXICAL_REGIME_JSON`)を yml から読む。
 * **この歯はパスを自分では書かない**——書き写すと、yml 側が変わったときに
 * 歯のほうが古いまま緑になる。
 *
 * @returns {string}
 */
function benchStepMeasuredPath() {
  if (!benchStep) {
    throw new Error(
      "ci.yml の postgres ジョブに MNEMORA_LEXICAL_REGIME_JSON を渡す段が無い。" +
        "機械可読な出力口への配線が外れている。",
    );
  }
  return benchStep.env.MNEMORA_LEXICAL_REGIME_JSON;
}

function makeValidRegime(overrides = {}) {
  return {
    schemaVersion: 1,
    measuredAt: "2026-09-12T00:00:00.000Z",
    serverVersion: "PostgreSQL 17.11",
    serverEncoding: "UTF8",
    nonAsciiIsIndexed: true,
    rawTsvector: "'1234':2 '四半期レビューでproj':1",
    rawIdentifierHit: false,
    rawJapaneseWordHit: false,
    regime: "non_ascii_indexed",
    ...overrides,
  };
}

/**
 * yml から取り出した summary の段を、実際に bash で走らせる。
 *
 * @param {"present" | "missing"} fileState `"missing"` なら measured ファイルを
 *   一切書かず、ENOENT の経路を実地で走らせる。
 * @param {unknown} [content] `fileState: "present"` のときにファイルへ書く中身
 *   (JSON.stringify する。文字列を渡せばそのまま書く——壊れた JSON も作れる)。
 * @returns {{ status: number, summary: string, stderr: string }}
 */
function runSummaryStepFromWorkflow(fileState, content) {
  if (!summaryStep) {
    throw new Error(
      "ci.yml の postgres ジョブに lexical-regime-summary.mjs を打つ段が無い。" +
        "「値を Job Summary に残す」配線が外れている。",
    );
  }
  const workspace = mkdtempSync(join(tmpdir(), "mnemora-postgres-regime-wiring-"));
  try {
    const script = substituteWorkspace(summaryStep.run, workspace);
    const measuredPath = substituteWorkspace(benchStepMeasuredPath(), workspace);
    if (fileState === "present") {
      writeFileSync(
        measuredPath,
        typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
        "utf8",
      );
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

describe("ci.yml の postgres ジョブの regime 配線(Issue #148)", () => {
  it("ジョブ自体が存在する(measure/summary/artifact の3段を持つ)", () => {
    expect(benchStep, "MNEMORA_LEXICAL_REGIME_JSON を渡す測定段が無い").toBeDefined();
    expect(summaryStep, "lexical-regime-summary.mjs を打つ段が無い").toBeDefined();
    expect(artifactStep, "regime を upload する段が無い").toBeDefined();
  });

  it("⭐ 歯が JSON を書く先と、要約が読む先が同じ場所を指している", () => {
    const measuredFlag = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    expect(measuredFlag, "要約の段に --measured の指定が無い").not.toBeNull();
    expect(measuredFlag?.[1] ?? measuredFlag?.[2]).toBe(benchStepMeasuredPath());
  });

  it("DATABASE_URL が設定され、pgvector の service container を使っている", () => {
    expect(jobEnv.DATABASE_URL).toBeDefined();
    expect(jobBlock).toContain("pgvector/pgvector");
  });

  it("test:db の段が MNEMORA_LEXICAL_REGIME_JSON を渡している", () => {
    expect(benchStep.run).toContain("run test:db");
  });

  it("要約ステップに if: always() が付いている(測定段が落ちても走る)", () => {
    const block = extractStepBlock(summaryStep.name);
    expect(block, "summary 段の生テキストが見つからない").toBeDefined();
    expect(block).toContain("if: always()");
  });

  it("artifact ステップにも if: always() が付いている(測定段が落ちても成果物は残す)", () => {
    const block = extractStepBlock(artifactStep.name);
    expect(block, "artifact 段の生テキストが見つからない").toBeDefined();
    expect(block).toContain("if: always()");
  });

  it("実測値そのものを artifact として upload-artifact に渡している(歯の書き先と同じパス、if-no-files-found: ignore)", () => {
    const block = extractStepBlock(artifactStep.name);
    expect(block).toContain("uses: actions/upload-artifact@v");
    expect(block).toContain(benchStepMeasuredPath());
    expect(block).toContain("if-no-files-found: ignore");
  });

  it("⭐ 正常な JSON なら exit 0 で、Job Summary に server_encoding / server_version が出る", () => {
    const result = runSummaryStepFromWorkflow("present", makeValidRegime());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("server_encoding");
    expect(result.summary).toContain("server_version");
    expect(result.summary).toContain("UTF8");
  });

  it("🔴 nonAsciiIsIndexed が true でも false でも exit 0(⛔ 門ではないことの固定点)", () => {
    const trueResult = runSummaryStepFromWorkflow(
      "present",
      makeValidRegime({ nonAsciiIsIndexed: true, regime: "non_ascii_indexed" }),
    );
    expect(trueResult.status, `stderr: ${trueResult.stderr}`).toBe(0);

    const falseResult = runSummaryStepFromWorkflow(
      "present",
      makeValidRegime({
        nonAsciiIsIndexed: false,
        regime: "non_ascii_dropped",
        rawIdentifierHit: true,
      }),
    );
    expect(falseResult.status, `stderr: ${falseResult.stderr}`).toBe(0);
  });

  it("🔴 ファイルが無ければ非0(「値が出ていない」——測定段自体が落ちていないか先に見る経路)", () => {
    const result = runSummaryStepFromWorkflow("missing");
    expect(result.status).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("🔴 値が空文字なら非0で、かつ「ファイルが無い」場合とは異なるメッセージになる", () => {
    const emptyResult = runSummaryStepFromWorkflow(
      "present",
      makeValidRegime({ serverEncoding: "" }),
    );
    expect(emptyResult.status).not.toBe(0);
    const missingResult = runSummaryStepFromWorkflow("missing");
    expect(missingResult.status).not.toBe(0);
    // ⭐ 2つの非0経路が同じメッセージに潰れていないこと(「値が出ていない」と
    // 「値が空だった」を区別する、という Issue #148 の要求そのもの)。
    expect(emptyResult.stderr).not.toBe(missingResult.stderr);
  });

  it("実測 JSON が壊れている(JSON として parse できない)と非0", () => {
    const result = runSummaryStepFromWorkflow("present", "{ これは JSON ではない");
    expect(result.status).not.toBe(0);
  });
});

describe("値を作る側の歯が MNEMORA_LEXICAL_REGIME_JSON を参照していること(Issue #148)", () => {
  // 🔴 この describe が固定しているのは配線そのものではなく「配線の呼び出しが
  // ソースから消えていないか」である。DB を持たない環境(この歯が走る `build` ジョブ)
  // でも、`lexical-store-identifier.test.ts` が `MNEMORA_LEXICAL_REGIME_JSON` への
  // 書き込みごと削除されたことを赤で捕まえられるようにするため。
  //
  // ⚠ **文字列一致であり、書き方の変更に弱い。**環境変数名を変えずに書き込み処理
  // だけを別のヘルパー関数へ切り出す、といった変更にはこの歯は気づけない。
  // 壊れたときは「配線が変わった」のか「書き方が変わっただけ」なのかを見て、
  // 配線が変わっていないなら固定のしかたを直すこと(歯を消さないこと)。
  const toothSource = readFileSync(TOOTH_SOURCE_PATH, "utf8");

  it("MNEMORA_LEXICAL_REGIME_JSON を参照している", () => {
    expect(toothSource).toContain("MNEMORA_LEXICAL_REGIME_JSON");
  });

  it("`expect` より前に書き込んでいる(歯が赤くなっても値が残るための順序)", () => {
    const writeIndex = toothSource.indexOf("writeFileSync(regimeJsonPath");
    expect(writeIndex, "writeFileSync(regimeJsonPath, …) の呼び出しが見当たらない").toBeGreaterThan(
      -1,
    );
    const firstExpectAfterProbeIndex = toothSource.indexOf(
      "expect(\n        row.rawIdentifierHit,",
    );
    expect(
      firstExpectAfterProbeIndex,
      "この歯の1本目の expect(row.rawIdentifierHit, …) が見当たらない——歯の書き方が" +
        "変わった可能性がある。取り出し方を直すこと。",
    ).toBeGreaterThan(-1);
    expect(writeIndex).toBeLessThan(firstExpectAfterProbeIndex);
  });
});

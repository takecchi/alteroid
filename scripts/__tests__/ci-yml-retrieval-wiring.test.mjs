import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/ci.yml` の `retrieval-quality` ジョブが、実際に
 * `scripts/retrieval-quality-summary.mjs` へ配線されていること。**
 *
 * ⚠ **これは `scripts/__tests__/retrieval-quality-summary.test.mjs` /
 * `retrieval-quality-summary-lib.test.mjs` の重複ではない。**
 * その2本は**入力を自分で作って**要約の中身を測る——前者は CLI を子プロセスで起動し、
 * 後者は純関数を直接呼ぶ。**どちらも `ci.yml` を1バイトも読まない。**
 * ⟹ 誰かが `ci.yml` から要約の段を消しても、`--baseline` のパスを打ち間違えても、
 * `MNEMORA_RETRIEVAL_JSON` の書き先と `--measured` の読み先をずらしても、
 * **その2本は緑のまま通る。**ADR 0088 が「値が残る形にする」と決めたものが、
 * workflow 側の1行の書き換えで静かに空回りする。
 *
 * **この歯だけが `ci.yml` を入力に取る。**やっていることは
 * `scripts/__tests__/publish-yml-dry-run-wiring.test.mjs` と同じ形である:
 *
 * 1. `ci.yml` から `retrieval-quality` ジョブの段を**取り出す**
 * 2. **bench が JSON を書く先**（`MNEMORA_RETRIEVAL_JSON`）と
 *    **要約が読む先**（`--measured`）が**同じ場所を指している**ことを見る
 *    ——この2つは別の段に書かれており、片方だけ直すと
 *    「要約は走るが、読んでいるのは存在しないファイル」になる
 * 3. **yml に書いてある通りのコマンドで**本物のスクリプトを起動し、
 *    ⛔ **相違があっても緑**・🔴 **入力が壊れていれば赤**という
 *    ADR 0088 §2.1 の要が、配線の側でも成り立つことを見る
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。**
 * `publish-yml-dry-run-wiring.test.mjs` と同じ判断で、歯のために YAML パーサの依存を
 * 足していない（依存追加はオーナー専権。`docs/autonomy.md`）。**だからこの歯は
 * 書き方の変更に弱い。**壊れたときは「配線が変わった」か「書き方が変わった」かを見て、
 * **配線が変わっていないなら取り出し方のほうを直すこと**（歯を消さないこと）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "retrieval-quality";

/**
 * `jobs:` の下の1ジョブ（`  <id>:` から、次の同じ深さの `  <id>:` まで）を切り出す。
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
      `ci.yml に \`  ${jobId}:\` のジョブが無い。` +
        "ADR 0088 が足したジョブが消えたか、名前が変わったか、インデントが変わった。",
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
 * ジョブ直下の `env:` を読む（`    env:` の下の `      KEY: VALUE` だけを拾う）。
 * **段（step）の中の `env:` は拾わない**——深さが違う。
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
 * `steps:` を段へ切り分け、各段の `name` / `env` / `run` だけを取り出す。
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
        // `run: |` のブロックは 10 空白でインデントされている。前置きの空白を落として繋ぐ。
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

const benchStep = steps.find((step) => step.env.MNEMORA_RETRIEVAL_JSON !== undefined);
const summaryStep = steps.find((step) => step.run.includes("retrieval-quality-summary.mjs"));

/**
 * `${{ github.workspace }}` を実際の場所に置き換える。GitHub Actions がやることを、
 * この歯の中で同じように行う（他の式が現れたら気づけるよう、残ったら例外にする）。
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
        "式が増えたなら、この歯の置き換えのほうを足すこと（歯を消さないこと）。",
    );
  }
  return replaced;
}

/** 基準値ファイル（本物）。差分の有無を作り分けるための土台に使う。 */
const baseline = JSON.parse(
  readFileSync(join(repoRoot, "examples/chat/retrieval-baseline.json"), "utf8"),
);

/**
 * yml から取り出した要約の段を、実際に走らせる。
 *
 * @param {unknown} measured `--measured` が読むファイルに書き込む中身
 * @returns {{ status: number, summary: string, stderr: string }}
 */
function runSummaryStepFromWorkflow(measured) {
  if (!summaryStep) {
    throw new Error(
      "ci.yml の retrieval-quality ジョブに retrieval-quality-summary.mjs を打つ段が無い。" +
        "ADR 0088 が決めた「値を Job Summary に残す」配線が外れている。",
    );
  }
  const workspace = mkdtempSync(join(tmpdir(), "mnemora-ci-wiring-"));
  try {
    const script = substituteWorkspace(summaryStep.run, workspace);
    const measuredPath = substituteWorkspace(benchStepMeasuredPath(), workspace);
    writeFileSync(
      measuredPath,
      typeof measured === "string" ? measured : `${JSON.stringify(measured, null, 2)}\n`,
      "utf8",
    );
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

/**
 * bench が JSON を書く先（`MNEMORA_RETRIEVAL_JSON`）を yml から読む。
 * **この歯はパスを自分では書かない**——書き写すと、yml 側が変わったときに
 * 歯のほうが古いまま緑になる。
 *
 * @returns {string}
 */
function benchStepMeasuredPath() {
  if (!benchStep) {
    throw new Error(
      "ci.yml の retrieval-quality ジョブに MNEMORA_RETRIEVAL_JSON を渡す段が無い。" +
        "機械可読な出力口への配線が外れている（ADR 0088 §4）。",
    );
  }
  return benchStep.env.MNEMORA_RETRIEVAL_JSON;
}

describe("ci.yml の retrieval-quality ジョブの配線", () => {
  it("⭐ bench が JSON を書く先と、要約が読む先が同じ場所を指している", () => {
    // この2つは別の段に書かれている。片方だけ直すと、要約の段は走るが
    // 読んでいるのは存在しないファイルになる——そのとき要約は非0で落ちるので
    // 気づけるが、**気づけるのは、この2つが食い違ったときに落ちる形になっているから**である。
    // ここではその前提（同じ場所を指していること）自体を固定する。
    // ⚠ `${{ github.workspace }}` は中に空白を含むので、空白で切ってはいけない。
    // 引用符で括られた形と、括られていない1語の形の両方を拾う。
    const measuredFlag = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    expect(measuredFlag, "要約の段に --measured の指定が無い").not.toBeNull();
    expect(measuredFlag?.[1] ?? measuredFlag?.[2]).toBe(benchStepMeasuredPath());
  });

  it("⭐ ジョブが provider source を recorded に明示している（鍵が入った日に黙って課金しない）", () => {
    // CI に OPENAI_API_KEY が無いので既定でも recorded に落ちる。**明示が要るのは
    // 「いつか鍵が入った日」のため**——`decideProviderSource` の既定は
    // 「キーが在れば実 API」なので、明示が無いとこのジョブが黙って実 API を叩き始める。
    // 明示が効いていること自体（キーが在っても recorded になること）は
    // examples/chat 側の歯が本物の `decideProviderSource` を呼んで測っている。
    expect(jobEnv.MNEMORA_PROVIDER_SOURCE).toBe("recorded");
  });

  it("🔴 基準値と相違しても緑のまま（⛔ このジョブは門ではない。ADR 0088 §2.1）", () => {
    const measured = structuredClone(baseline);
    // arm C の hit@1 を 4 から 1 へ落とす——「想起の質が大きく劣化した」に相当する。
    // **それでも落ちてはいけない。**落ちるようになったら、この repo は
    // probe 7 件の標本で偽陽性を出す門を持ってしまったことになる（ADR 0033 §3）。
    measured.arms[2].hit1Count = 1;
    measured.arms[2].mrrOverall = 0.2;
    const result = runSummaryStepFromWorkflow(measured);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("0.200");
  });

  it("基準値と一致していれば、その旨が Job Summary に出る", () => {
    const result = runSummaryStepFromWorkflow(structuredClone(baseline));
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("一致");
  });

  it("🔴 実測 JSON が壊れていたら赤くなる（bench が壊れた＝赤、数字が動いた＝赤ではない）", () => {
    const result = runSummaryStepFromWorkflow("{ これは JSON ではない");
    expect(result.status).not.toBe(0);
  });

  it("要約の中身が Job Summary へ届いている（arm と数字が同じ行に並ぶ。ADR 0068 ②）", () => {
    const result = runSummaryStepFromWorkflow(structuredClone(baseline));
    const armC = baseline.arms[2];
    const row = result.summary
      .split("\n")
      .find((line) => line.includes(armC.armLabel) && line.includes("|"));
    expect(row, "arm C の行が Job Summary に無い").toBeDefined();
    // **同じ行**に、その arm の条件と数字が揃っていること。別の表を経由させると
    // 「arm B の MRR と arm C の hit@10 を束ねる」読み違えが起きる（ADR 0068 ②）。
    expect(row).toContain(armC.llmMode);
    expect(row).toContain(armC.embeddingMode);
    expect(row).toContain(`${armC.hit1Count}/${armC.probeCount}`);
    expect(row).toContain(`${armC.hit10Count}/${armC.probeCount}`);
  });

  it("⚠ 読み方の注意書きが Job Summary に随伴している", () => {
    const result = runSummaryStepFromWorkflow(structuredClone(baseline));
    // 数字だけが独り歩きしないための3点（ADR 0088 §4）。
    expect(result.summary).toContain("similarity");
    expect(result.summary).toContain("7");
    expect(result.summary).toMatch(/否定|時制/);
  });

  it("ジョブに timeout-minutes が設定されている（既定 360 分で刺さらない）", () => {
    expect(jobBlock).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });
});

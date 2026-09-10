import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateBaseline, validateMeasured } from "../identifier-probe-summary-lib.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/ci.yml` の `identifier-probes` ジョブが、実際に
 * `scripts/identifier-probe-summary.mjs` へ、`--measured` と `--baseline` の
 * 両方を渡して配線されていること。**
 *
 * ⚠ **これは `identifier-probe-summary.test.mjs` /
 * `identifier-probe-summary-lib.test.mjs` の重複ではない**
 * （`ci-yml-retrieval-wiring.test.mjs` の docstring と同じ理由）。その2本は
 * **入力を自分で作って**要約の中身と exit code を測る——**どちらも `ci.yml` を
 * 1バイトも読まない。**⟹ 誰かが `ci.yml` から `--baseline` を落としても、
 * パスを打ち間違えても、`MNEMORA_IDENTIFIER_PROBE_JSON` の書き先と `--measured` の
 * 読み先をずらしても、**その2本は緑のまま通る。**
 *
 * 🔑 **そして「基準値を読まない要約」は、この PR で実際に一度起きた**
 * （ADR 0094 §8。基準値ファイルはコミットされているのに誰も比べておらず、
 * ADR 0088 §3 が名指しした「値を残すだけで読まれない」形の再発だった）。
 * ⟹ **輪が閉じていることを、配線の側で固定する。**
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。**
 * `ci-yml-retrieval-wiring.test.mjs` / `publish-yml-dry-run-wiring.test.mjs` と
 * 同じ判断で、歯のために YAML パーサの依存を足していない（依存追加はオーナー専権。
 * `docs/autonomy.md`）。**だからこの歯は書き方の変更に弱い。**壊れたときは
 * 「配線が変わった」か「書き方が変わった」かを見て、**配線が変わっていないなら
 * 取り出し方のほうを直すこと（歯を消さないこと）。**
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

const JOB_ID = "identifier-probes";

/**
 * `jobs:` の下の1ジョブ（`  <id>:` から、次の同じ深さの `  <id>:` まで）を切り出す。
 *
 * @param {string} yaml
 * @param {string} jobId
 */
function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    throw new Error(
      `ci.yml に \`  ${jobId}:\` のジョブが無い。` +
        "Issue #109 が足したジョブが消えたか、名前が変わったか、インデントが変わった。",
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
 * `steps:` を段へ切り分け、各段の `name` / `env` / `run` だけを取り出す
 * （`ci-yml-retrieval-wiring.test.mjs` の `parseSteps` と同じ形）。
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
const steps = parseSteps(jobBlock);

const benchStep = steps.find((step) => step.env.MNEMORA_IDENTIFIER_PROBE_JSON !== undefined);
const summaryStep = steps.find((step) => step.run.includes("identifier-probe-summary.mjs"));

/**
 * `${{ github.workspace }}` を実際の場所に置き換える。GitHub Actions がやることを、
 * この歯の中で同じように行う（他の式が現れたら気づけるよう、残ったら例外にする）。
 *
 * @param {string} text
 * @param {string} workspace
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

/**
 * bench が JSON を書く先（`MNEMORA_IDENTIFIER_PROBE_JSON`）を yml から読む。
 * **この歯はパスを自分では書かない**——書き写すと、yml 側が変わったときに
 * 歯のほうが古いまま緑になる。
 */
function benchStepMeasuredPath() {
  if (!benchStep) {
    throw new Error(
      "ci.yml の identifier-probes ジョブに MNEMORA_IDENTIFIER_PROBE_JSON を渡す段が無い。" +
        "機械可読な出力口への配線が外れている。",
    );
  }
  return benchStep.env.MNEMORA_IDENTIFIER_PROBE_JSON;
}

/** `--baseline <path>` を yml から読む（引用符あり・なしの両方を拾う）。 */
function summaryStepBaselinePath() {
  const matched = /--baseline\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
  return matched ? (matched[1] ?? matched[2]) : undefined;
}

/**
 * yml から取り出した要約の段を、実際に走らせる。
 *
 * @param {unknown} measured `--measured` が読むファイルに書き込む中身
 * @returns {{ status: number, summary: string, stderr: string }}
 */
function runSummaryStepFromWorkflow(measured) {
  if (!summaryStep) {
    throw new Error(
      "ci.yml の identifier-probes ジョブに identifier-probe-summary.mjs を打つ段が無い。" +
        "「値を Job Summary に残す」配線が外れている。",
    );
  }
  const workspace = mkdtempSync(join(tmpdir(), "mnemora-idp-wiring-"));
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

/** 基準値ファイル（本物）。差分の有無を作り分けるための土台に使う。 */
const baselineRelativePath = "examples/chat/identifier-probe-baseline.json";
const baseline = JSON.parse(readFileSync(join(repoRoot, baselineRelativePath), "utf8"));

/**
 * 本物の基準値ファイルから、実測 JSON（`status: "measured"`）を組み立てる。
 * **群の名前（`group`）でキーを作る**——順番に依存しない。
 */
function measuredFromBaseline() {
  const byGroup = Object.fromEntries(
    baseline.groups.map((group) => {
      const copy = structuredClone(group);
      delete copy.group;
      delete copy.description;
      return [group.group, copy];
    }),
  );
  return {
    schemaVersion: 2,
    status: "measured",
    measuredAt: "2026-09-10T00:00:00.000Z",
    commit: "0".repeat(40),
    ...byGroup,
  };
}

describe("ci.yml の identifier-probes ジョブの配線", () => {
  it("⭐ bench が JSON を書く先と、要約が読む先が同じ場所を指している", () => {
    // ⚠ `${{ github.workspace }}` は中に空白を含みうるので、空白で切ってはいけない。
    const measuredFlag = /--measured\s+(?:"([^"]+)"|([^\s\\]+))/.exec(summaryStep?.run ?? "");
    expect(measuredFlag, "要約の段に --measured の指定が無い").not.toBeNull();
    expect(measuredFlag?.[1] ?? measuredFlag?.[2]).toBe(benchStepMeasuredPath());
  });

  it("🔴 要約の段が --baseline をコミット済みの基準値ファイルへ渡している（ADR 0094 §8）", () => {
    // ⭐ **これが「輪が閉じている」ことの固定点。**この行が消えると、値が動いても
    // 誰も気づかず、誰も基準値を更新せず、新しい値が PR の diff に現れなくなる。
    expect(summaryStepBaselinePath(), "要約の段に --baseline の指定が無い").toBe(
      baselineRelativePath,
    );
  });

  it("🔴 --baseline が指すファイルが、実際に validateBaseline を通る", () => {
    // パスが合っていても中身が要約の期待する形でなければ、CI では
    // 「基準値 JSON が使えない」で非0になる——それは repo に置いてある時点で分かる。
    const result = validateBaseline(baseline);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("🔴 基準値から組み立てた実測 JSON が validateMeasured を通る（2つの形が食い違っていない）", () => {
    const result = validateMeasured(measuredFromBaseline());
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
  });

  it("⭐ 各群の label が、その群自身の条件（llm・provider/model/dimensions・haystack）を落としていない", () => {
    // 🔴 この repo は「条件を落とした数字」を3度壊している（ADR 0068 / ADR 0081 §3.2）。
    // label は条件を文字列に埋めたものなので、**label だけが条件を落とす**ことも
    // 同じ壊れ方である。実際にこの PR の作業中、`japanese` 群の label が
    // `haystack=` を落としており、基準値ファイルの label と食い違っていた。
    for (const group of baseline.groups) {
      expect(group.label, `${group.group} の label`).toContain(`llm=${group.llmMode}`);
      expect(group.label, `${group.group} の label`).toContain(group.embeddingSpace.provider);
      expect(group.label, `${group.group} の label`).toContain(group.embeddingSpace.model);
      expect(group.label, `${group.group} の label`).toContain(
        `${group.embeddingSpace.dimensions}次元`,
      );
      expect(group.label, `${group.group} の label`).toContain(`haystack=${group.haystackKind}`);
    }
  });

  it("🔴 基準値と相違しても緑のまま（⛔ このジョブは門ではない。標本7件・12件。ADR 0033 §3）", () => {
    const measured = measuredFromBaseline();
    // japanese の hit@1 を 5 から 1 へ落とす——「想起の質が大きく劣化した」に相当。
    // **それでも落ちてはいけない。**落ちるようになったら、この repo は probe 7件の
    // 標本で偽陽性を出す門を持ってしまったことになる。
    measured.japanese.hit1Count = 1;
    measured.japanese.mrrOverall = 0.2;
    const result = runSummaryStepFromWorkflow(measured);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("0.200");
    expect(result.summary).toContain("### japanese");
    expect(result.summary).toContain("hit1Count");
  });

  it("🔴 embeddingSpace だけが動いた（数字は同じ）ときも、Job Summary が相違として出す", () => {
    const measured = measuredFromBaseline();
    measured.identifiersDense.embeddingSpace.model = "text-embedding-3-small";
    const result = runSummaryStepFromWorkflow(measured);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("### identifiersDense");
    expect(result.summary).toContain("embeddingSpace.model");
  });

  it("基準値と一致していれば、その旨が Job Summary に出る（1行で黙る）", () => {
    const result = runSummaryStepFromWorkflow(measuredFromBaseline());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("一致（差分なし）");
    expect(result.summary).not.toContain("| 項目 | 基準値 | 実測 |");
  });

  it("🔴 weights_unavailable のときは、Job Summary に比較が1つも出ない（緑のまま）", () => {
    // ⭐ オーナー代理の逐語: 「私が怖いのはジョブが落ちることではありません。
    // 『HF から取れなかった』が『想起の質が下がった』に見えることです。」
    // ⚠ measure の段自体は非0で落ちる仕様だが、この要約の段は `if: always()` で走り、
    // **測っていないことを測っていないと言う。**
    const result = runSummaryStepFromWorkflow({
      schemaVersion: 2,
      status: "weights_unavailable",
      measuredAt: "2026-09-10T00:00:00.000Z",
      commit: "0".repeat(40),
      detail: "HTTP 503 from the model host",
    });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("重みを取得できなかったので、値は測っていない");
    expect(result.summary).not.toContain("基準値との差分");
    expect(result.summary).not.toContain("一致");
    expect(result.summary).not.toContain("相違");
    expect(result.summary).not.toContain("MRR");
  });

  it("🔴 実測 JSON が壊れていたら赤くなる（bench が壊れた＝赤、数字が動いた＝赤ではない）", () => {
    const result = runSummaryStepFromWorkflow("{ これは JSON ではない");
    expect(result.status).not.toBe(0);
  });

  it("要約の中身が Job Summary へ届いている（群と条件と数字が同じ行に並ぶ）", () => {
    const result = runSummaryStepFromWorkflow(measuredFromBaseline());
    const dense = baseline.groups.find((group) => group.group === "identifiersDense");
    const row = result.summary
      .split("\n")
      .find((line) => line.includes(dense.label) && line.includes("|"));
    expect(row, "identifiersDense の行が Job Summary に無い").toBeDefined();
    // **同じ行**に、その群の条件と数字が揃っていること（ADR 0068 ②）。
    expect(row).toContain(dense.llmMode);
    expect(row).toContain(dense.embeddingSpace.provider);
    expect(row).toContain(dense.embeddingSpace.model);
    expect(row).toContain(`${dense.embeddingSpace.dimensions}次元`);
    expect(row).toContain(dense.haystackKind);
    expect(row).toContain(`${dense.hit1Count}/${dense.probeCount}`);
    expect(row).toContain(`${dense.hit10Count}/${dense.probeCount}`);
  });

  it("⚠ 標本の小ささの注意書きが Job Summary に随伴している", () => {
    const result = runSummaryStepFromWorkflow(measuredFromBaseline());
    expect(result.summary).toContain("ADR 0033 §3");
    expect(result.summary).toContain("統計的に主張しない");
  });

  it("ジョブに timeout-minutes が設定されている（既定 360 分で刺さらない）", () => {
    expect(jobBlock).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });

  /**
   * 🔴 **この歯が在る理由（この PR で実際に一度起きた形）**
   *
   * #127 が `ci.yml` の action を node24 の版へ上げたとき、この
   * `identifier-probes` ジョブは**まだ存在していなかった。**⟹ 両方が載ると
   * 「既存は v6・このジョブだけ v4(node20)」になる。
   *
   * ⚠ **これは何も鳴らない形の欠陥である:** 足した行が既存行と違うので git は
   * 衝突を報告せず（`mergeStateStatus` は `CLEAN` のまま）、GitHub Actions が
   * runner から Node 20 を削除する **2026-09-23** までは CI も緑である。
   * ⟹ **期限の日に、このジョブだけが壊れる。**
   * ⟹ 「両方が載った状態」を誰も検査していなかった。**そこを固定する。**
   *
   * ⚠ **歯からネットワークへ出ていない**（`action.yml` の `runs.using` を実際に
   * 引くことはしていない）。代わりに (a) ファイル内の他のジョブに後れを
   * 取っていないこと と (b) node24 だと確認できた版の下限表 の2つで挟む。
   */
  const NODE24_MIN_MAJOR = {
    // 2026-09-10 に `action.yml` の `runs.using` を引いて node24 だと確認した
    // 最小のメジャー。⚠ **表に無いメジャーは確認していない**——だから下限は
    // 安全側に寄せてある。ここより下の版へ落とすときは `runs.using` を自分で
    // 引き直し、この表を更新すること。
    //   actions/checkout@v6        node24（v4 は node20。v5 は未確認）
    //   actions/setup-node@v6      node24（v4 は node20。v5 は未確認）
    //   actions/upload-artifact@v6 node24（v4・v5 は未確認）
    //   actions/cache@v5, @v6      node24（v4 は node20）
    "actions/checkout": 6,
    "actions/setup-node": 6,
    "actions/upload-artifact": 6,
    "actions/cache": 5,
  };

  /**
   * `uses: actions/<name>@v<major>` を拾う。
   *
   * @param {string} block
   */
  function usesInBlock(block) {
    return [...block.matchAll(/^\s*uses: (actions\/[a-z-]+)@v(\d+)$/gm)].map((match) => ({
      action: match[1],
      major: Number(match[2]),
    }));
  }

  it("🔴 このジョブの action が ci.yml の他のジョブに後れを取っていない（#127 型の取り残し）", () => {
    const mine = usesInBlock(jobBlock);
    expect(mine.length).toBeGreaterThan(0);
    const fileWide = usesInBlock(workflow);
    for (const { action, major } of mine) {
      const maxMajor = Math.max(
        ...fileWide.filter((used) => used.action === action).map((used) => used.major),
      );
      expect(
        major,
        `${action}: このジョブは @v${major} だが、ci.yml の他所は @v${maxMajor} を使っている`,
      ).toBe(maxMajor);
    }
  });

  it("🔴 このジョブの action が node24 の版である（2026-09-23 に runner から Node 20 が消える）", () => {
    const mine = usesInBlock(jobBlock);
    expect(mine.length).toBeGreaterThan(0);
    for (const { action, major } of mine) {
      const min = NODE24_MIN_MAJOR[action];
      expect(min, `${action} の node24 下限が表に無い（引き直して表を更新すること）`).toBeDefined();
      expect(
        major,
        `${action}@v${major} は node24 だと確認できている下限 v${min} より古い`,
      ).toBeGreaterThanOrEqual(min);
    }
  });
});

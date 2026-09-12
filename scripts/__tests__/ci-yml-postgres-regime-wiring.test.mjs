import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";

/**
 * ⚠ **2026-09-12 追記(Issue #155)**: `postgres` ジョブを `server_encoding` の
 * matrix(`UTF8` / `SQL_ASCII`)にした。下の (b)(c) は matrix 化に合わせて
 * 主張を作り直した(弱めていない——`scripts/__tests__/ci-yml-postgres-regime-wiring
 * .test.mjs` 内の該当 describe の docstring に理由を書いた)。summary 段を実際に
 * 走らせる歯(`runSummaryStepFromWorkflow`)は `${{ matrix.serverEncoding }}` /
 * `${{ matrix.initdbArgs }}` も展開できるようにした(`substituteWorkspace` に
 * `leg` を渡す)。
 *
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
 * そもそも基準値と比べない。
 *
 * ⚠ **2026-09-12 訂正**: 以前はここに「SQL_ASCII をサポート対象にするかをオーナーが
 * まだ決めていない前提の上に基準値を置くと、実装が先回りしてその判断を決めてしまうから」
 * と書いていたが、オーナーの決定(2026-09-12T00:09Z、[ADR 0106](../../docs/decisions/
 * 0106-ci-declares-the-regime-it-measures.md))でこの前提は解けた——オーナーは
 * `server_encoding` が `SQL_ASCII` の PostgreSQL をサポート対象にすると決めた。
 * **基準値ファイルを置かない理由も変わった**: 「決まっていないから」ではなく、
 * **基準値はもう `.github/workflows/ci.yml` の `POSTGRES_INITDB_ARGS`
 * (`--encoding=UTF8`)に在り**、`lexical-regime-summary.mjs` の `--expect-encoding`
 * がそれを受け取っているからである(`scripts/lexical-regime-summary-lib.mjs` の
 * docstring も同様に訂正した)。⛔ **これは「だから門にする」という意味ではない。**
 * この歯・この script が門にするのは依然として「ci.yml が宣言した regime と実測が
 * 食い違ったこと」だけであり、どの regime をサポートするかという製品判断を1つも
 * 含まない。
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
 * このファイル内で `extractStepBlock` が `blankOutWorkflowComments` を通した結果、
 * 「扱えない」と名乗った箇所をすべて集める(呼び出し側がこれを無視できないようにするため
 * ——下の describe("コメント潰しが …") が空であることを固定する)。
 *
 * @type {{ stepName: string, unhandled: { lineNumber: number, reason: string, line: string }[] }[]}
 */
const stepBlockCommentUnhandled = [];

/**
 * ある段の生テキスト(`- name: <name>` から次の段の `- name:` まで)を切り出す。
 * `parseSteps` は `if:`/`uses:`/`with:` を読まないので、それらを検査したいときは
 * こちらを使う。
 *
 * 🔴 **返す前にコメントを空白へ潰す(Issue #148/#155 段1)。**この歯の一部
 * (下の `if: always()` / `${{ matrix.serverEncoding }}` の固定)は、実キーではなく
 * **地の文のコメントがその文字列を引用しているだけ**でも `toContain` が一致していた
 * (変異H。段0で実測)。⟹ 照合前にコメントを潰す(`blankOutComments` が
 * `lexical-store-identifier.test.ts` のために下ったのと同じ判断——
 * `scripts/workflow-comment-blank-lib.mjs` の docstring)。
 *
 * ⛔ **この関数は照合専用であり、実行はしない。**`jobBlock`/`parseSteps` 側
 * (`summaryStep.run` → `runSummaryStepFromWorkflow` が子プロセスで実際に走らせる)には
 * 適用しない——実行するテキストからコメントを潰すと歯の意味が変わる。
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
  const raw = lines.slice(start, end).join("\n");
  const { text, unhandled } = blankOutWorkflowComments(raw);
  if (unhandled.length > 0) {
    stepBlockCommentUnhandled.push({ stepName, unhandled });
  }
  return text;
}

/**
 * `${{ github.workspace }}` / `${{ matrix.serverEncoding }}` / `${{ matrix.initdbArgs }}`
 * を実際の値に置き換える。
 *
 * 🔴 **Issue #155 で足した。**`postgres` ジョブを matrix にしたことで、
 * `summaryStep.run` は `${{ matrix.serverEncoding }}` を、`POSTGRES_INITDB_ARGS` は
 * `${{ matrix.initdbArgs }}` を含むようになった——GitHub Actions はこれを実行時に
 * 脚ごとの値へ展開するが、この歯は bash へ直接渡すので**自分で展開する**必要がある。
 *
 * @param {string} text
 * @param {{ workspace: string, leg?: { serverEncoding: string, initdbArgs: string } }} substitutions
 * @returns {string}
 */
function substituteWorkspace(text, { workspace, leg }) {
  let replaced = text.replaceAll("${{ github.workspace }}", workspace);
  if (leg) {
    replaced = replaced
      .replaceAll("${{ matrix.serverEncoding }}", leg.serverEncoding)
      .replaceAll("${{ matrix.initdbArgs }}", leg.initdbArgs);
  }
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
    schemaVersion: 2,
    measuredAt: "2026-09-12T00:00:00.000Z",
    serverVersion: "PostgreSQL 17.11",
    serverEncoding: "UTF8",
    nonAsciiIsIndexed: true,
    rawTsvector: "'1234':2 '四半期レビューでproj':1",
    rawIdentifierHit: false,
    rawJapaneseWordHit: false,
    regime: "non_ascii_indexed",
    lcCollate: "en_US.UTF-8",
    lcCtype: "en_US.UTF-8",
    defaultTextSearchConfig: "pg_catalog.simple",
    ...overrides,
  };
}

/**
 * postgres ジョブの matrix の脚(既定は UTF8——既存の歯の呼び出しをそのまま使えるように
 * するため。Issue #155)。
 *
 * @type {{ serverEncoding: string, initdbArgs: string }}
 */
const DEFAULT_LEG = { serverEncoding: "UTF8", initdbArgs: "--encoding=UTF8" };

/**
 * yml から取り出した summary の段を、実際に bash で走らせる。
 *
 * @param {"present" | "missing"} fileState `"missing"` なら measured ファイルを
 *   一切書かず、ENOENT の経路を実地で走らせる。
 * @param {unknown} [content] `fileState: "present"` のときにファイルへ書く中身
 *   (JSON.stringify する。文字列を渡せばそのまま書く——壊れた JSON も作れる)。
 * @param {{ serverEncoding: string, initdbArgs: string }} [leg] `${{ matrix.* }}` を
 *   どの脚の値として展開するか(既定は UTF8 脚。Issue #155)。
 * @returns {{ status: number, summary: string, stderr: string }}
 */
function runSummaryStepFromWorkflow(fileState, content, leg = DEFAULT_LEG) {
  if (!summaryStep) {
    throw new Error(
      "ci.yml の postgres ジョブに lexical-regime-summary.mjs を打つ段が無い。" +
        "「値を Job Summary に残す」配線が外れている。",
    );
  }
  const workspace = mkdtempSync(join(tmpdir(), "mnemora-postgres-regime-wiring-"));
  try {
    const script = substituteWorkspace(summaryStep.run, { workspace, leg });
    const measuredPath = substituteWorkspace(benchStepMeasuredPath(), { workspace });
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

  it("🔴 Issue #155: artifact 名が matrix.serverEncoding へ配線されている(脚ごとに分かれていないと上書き・衝突する)", () => {
    const block = extractStepBlock(artifactStep.name);
    expect(block).toContain("name: lexical-regime-${{ matrix.serverEncoding }}");
  });

  it("⭐ 正常な JSON なら exit 0 で、Job Summary に server_encoding / server_version が出る(UTF8 脚)", () => {
    const result = runSummaryStepFromWorkflow("present", makeValidRegime());
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("server_encoding");
    expect(result.summary).toContain("server_version");
    expect(result.summary).toContain("UTF8");
  });

  it("🔴 Issue #155: SQL_ASCII 脚として走らせても、宣言と実測が一致していれば exit 0", () => {
    const sqlAsciiLeg = {
      serverEncoding: "SQL_ASCII",
      initdbArgs: "--encoding=SQL_ASCII --locale=C",
    };
    const result = runSummaryStepFromWorkflow(
      "present",
      makeValidRegime({
        serverEncoding: "SQL_ASCII",
        nonAsciiIsIndexed: false,
        regime: "non_ascii_dropped",
        rawIdentifierHit: true,
      }),
      sqlAsciiLeg,
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.summary).toContain("SQL_ASCII");
  });

  it("🔴 Issue #155: SQL_ASCII 脚として渡しているのに実測が UTF8 だと exit 1(宣言と実測の食い違い——matrix でも門は生きている)", () => {
    const sqlAsciiLeg = {
      serverEncoding: "SQL_ASCII",
      initdbArgs: "--encoding=SQL_ASCII --locale=C",
    };
    const result = runSummaryStepFromWorkflow(
      "present",
      makeValidRegime({ serverEncoding: "UTF8" }),
      sqlAsciiLeg,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SQL_ASCII");
    expect(result.stderr).toContain("UTF8");
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

/**
 * ソースから**コメントだけ**を空白へ潰す(改行は残す)。
 *
 * 🔴 **なぜ要るか — 変異試験で見つけた欠陥のために足した。**
 * 下の describe は「歯のコードがそう書いてあること」を固定するつもりで
 * `toContain("schemaVersion: 2")` を素のソースへ当てていた。ところが
 * `lexical-store-identifier.test.ts` は **docstring にも同じ文字列を書いている**ため、
 * **実際の代入を `schemaVersion: 1` に変えてもこの歯は緑のままだった**
 * (手で撃った変異が生き残った)。⟹ 当てる前にコメントを潰す。
 *
 * ⚠ **何を落として、何を落としていないか**:
 * - 落とす: ブロックコメント(`/*` 〜 `*` + `/`)と行コメント(`//` 〜 行末)
 * - 落とさない: 文字列リテラル(`'` / `"` / バッククォート)の中身。
 *   ⟹ 文字列の中に `//` が在っても潰さない(URL など)
 * - ⛔ 正規表現リテラルの中の `//` は見分けていない。この歯が読む対象には無いが、
 *   将来そこで誤爆したらこの関数を直すこと(**歯を消さないこと**)
 * - **改行は必ず残す。**残さないと、下の「`expect` より前に書いている」の固定
 *   (行頭の字下げごと一致させている)が壊れる
 *
 * ⭐ 1文字を消費したら必ず1文字を出すので、**元のソースと添字が一致する**。
 *
 * @param {string} source
 * @returns {string}
 */
export function blankOutComments(source) {
  let out = "";
  let state = "code";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        state = ch;
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
        i += 1;
        continue;
      }
      out += " ";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // 文字列の中: エスケープを1組として読み飛ばし、同じ引用符で閉じる。
    if (ch === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === state) {
      state = "code";
    }
    out += ch;
    i += 1;
  }
  return out;
}

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
  // 🔴 **コメントを潰してから当てる。**素のソースへ当てると「docstring に同じ文字列が
  // 在るだけ」で緑になる——実際にそれで変異が1本生き残った(`blankOutComments` の
  // docstring を見ること)。⛔ ここを `toothSource` に戻さないこと。
  const toothCode = blankOutComments(toothSource);

  it("MNEMORA_LEXICAL_REGIME_JSON を参照している", () => {
    expect(toothCode).toContain("MNEMORA_LEXICAL_REGIME_JSON");
  });

  it("`expect` より前に書き込んでいる(歯が赤くなっても値が残るための順序)", () => {
    const writeIndex = toothCode.indexOf("writeFileSync(regimeJsonPath");
    expect(writeIndex, "writeFileSync(regimeJsonPath, …) の呼び出しが見当たらない").toBeGreaterThan(
      -1,
    );
    const firstExpectAfterProbeIndex = toothCode.indexOf("expect(\n        row.rawIdentifierHit,");
    expect(
      firstExpectAfterProbeIndex,
      "この歯の1本目の expect(row.rawIdentifierHit, …) が見当たらない——歯の書き方が" +
        "変わった可能性がある。取り出し方を直すこと。",
    ).toBeGreaterThan(-1);
    expect(writeIndex).toBeLessThan(firstExpectAfterProbeIndex);
  });

  // 🔴 Issue #148 ②: ロケールを測るだけ足した(まだ宣言しない)ことを固定する。
  it("lcCollate / lcCtype / defaultTextSearchConfig を参照している(ロケールを測り始めたこと)", () => {
    expect(toothCode).toContain("lcCollate");
    expect(toothCode).toContain("lcCtype");
    expect(toothCode).toContain("defaultTextSearchConfig");
    // 🔴 **名前が在るだけでは足りない。**JSON の欄と TS の型だけを残して
    // `probe` の SQL から `current_setting(…)` を落とすと、名前は3つとも残ったまま
    // **値だけが undefined になる**——手で撃った変異がここで1本生き残った。
    // ⟹ **実際に問い合わせていること**も固定する。
    // ⚠ この器には DB が無いので、これが「本当に Postgres で動く SQL か」までは
    // 測っていない。測っているのは「問い合わせる行がソースから消えていないこと」だけである。
    // ⚠ 欄ごとに「正しい引き方」が違う。**同じ式で全部を測ろうとしない。**
    // PostgreSQL 16 で lc_collate / lc_ctype は GUC ではなくなり DB ごとの属性に
    // なった ⟹ GUC として引くと 42704 で落ちる（PR #151 の CI が pg17 で実測）。
    // ⟹ ロケール2つは pg_database から、text search config は GUC から引く。
    // ⚠ **空白の数で固定しない。**以前はここを `toContain("SELECT datctype   FROM
    // pg_database")` と**桁揃えの空白ごと**書いていたので、SQL の桁を揃え直すだけ
    // ——**SQL として1文字も意味が変わらない変更**——でこの歯が赤くなった（撃って確かめた）。
    // ⟹ それは「ふるまい不変で赤くなる歯」であり、直す人に嘘の警告を出す。
    // ⟹ 空白を \s+ で受ける正規表現にする。**測る強さは落ちていない**
    //   （式を消す・GUC 経由へ戻す、はどちらも下で赤くなる）。
    const probeExpressions = [
      ["lcCollate", /SELECT\s+datcollate\s+FROM\s+pg_database/],
      ["lcCtype", /SELECT\s+datctype\s+FROM\s+pg_database/],
      ["defaultTextSearchConfig", /current_setting\('default_text_search_config'\)/],
    ];
    for (const [field, expression] of probeExpressions) {
      expect(
        toothCode,
        `probe の SQL が ${field} を実際に問い合わせていない（期待する式: ${expression}）。` +
          "JSON の欄と TS の型だけが残ると、値は undefined になり、" +
          "Job Summary 側の validateMeasured が「値が空だった」で落ちるまで誰も気づかない。",
      ).toMatch(expression);
    }
    // 🔴 弾いていないことも測る: GUC 経由へ戻したら赤くなる。
    // 戻すと pg17 で 42704 になり、測定段そのものが落ちる。
    expect(
      toothCode.includes("current_setting('lc_collate')") ||
        toothCode.includes("current_setting('lc_ctype')"),
      "probe が lc_collate / lc_ctype を GUC として引いている。PostgreSQL 16 以降では " +
        "存在しないパラメータなので 42704 で落ちる。pg_database.datcollate / datctype を使うこと。",
    ).toBe(false);
  });

  it("schemaVersion: 2 である(ロケール3項目を足した版であることの固定点)", () => {
    expect(toothCode).toContain("schemaVersion: 2");
  });
});

describe("ci.yml の6本の pgvector ジョブが regime を宣言していること(Issue #148 ②/Issue #155)", () => {
  // 🔴 この describe が固定しているのは「1本で測った regime が6本に効く」根拠そのもの
  // ——`postgres` ジョブ1本だけが実際に regime を測るが、他5本は同じ
  // `POSTGRES_INITDB_ARGS` を宣言することで「同じ regime のはず」を保証する設計である
  // (ADR 0106「測ったこと」)。
  //
  // ⚠ **Issue #155 で (b)(c) の主張を作り直した(弱めていない)。**`postgres` ジョブが
  // matrix になったことで、6本のうち1本(`postgres` ジョブ)の `POSTGRES_INITDB_ARGS` は
  // もはやリテラル文字列ではなく `${{ matrix.initdbArgs }}` という式になった——だから
  // (b)「6本の値がすべて同一」という主張はそのままでは成立しなくなった(1本だけ式、
  // 5本はリテラル)。
  //
  // 作り直した主張:
  // - (b): **matrix 化していない他5本の値は、matrix の UTF8 脚の initdbArgs と一致する**
  //   ——UTF8 脚の値は Issue #148 由来の実測のまま1バイトも変えていないので、
  //   「1本(いまは1脚)で測った regime が他5本に効く」という根拠は保たれる。
  // - (c): **matrix の各脚について、--encoding= の値とその脚の serverEncoding が一致し
  //   (自己無矛盾)、かつ service env と summary 段がどちらも同じ matrix 変数へ
  //   直接配線されている**(値を書き写すのではなく、同じ変数を参照している——
  //   実行時にどちらの脚が走っても自動的に一致する)。

  /**
   * `image: pgvector/pgvector:pg17` を持つ全 services ブロックの `env:` 行を
   * (コメント込みで)切り出す。ジョブをまたぐため `extractJob` は使わない——
   * インデントの形(services 直下、8/10 スペース)だけを頼りに、生の行を直接見る。
   *
   * @returns {{ envLines: string[] }[]}
   */
  function extractPgvectorServiceEnvBlocks() {
    const lines = workflow.split("\n");
    /** @type {{ envLines: string[] }[]} */
    const blocks = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] !== "        image: pgvector/pgvector:pg17") {
        continue;
      }
      const envAt = i + 1;
      if (lines[envAt] !== "        env:") {
        throw new Error(
          `pgvector/pgvector:pg17 の直後に \`        env:\` が無い(行 ${envAt + 1})。` +
            "services ブロックの形が変わった可能性がある。",
        );
      }
      const envLines = [];
      let j = envAt + 1;
      while (j < lines.length && /^ {10}\S/.test(lines[j])) {
        envLines.push(lines[j]);
        j += 1;
      }
      blocks.push({ envLines });
    }
    return blocks;
  }

  /**
   * env ブロックの生テキスト(コメント行を含む)から `KEY: value` の実キー行だけを
   * 取り出す(コメント行は無視する)。
   *
   * @param {string[]} envLines
   * @returns {Record<string, string>}
   */
  function parseEnvLines(envLines) {
    /** @type {Record<string, string>} */
    const env = {};
    for (const line of envLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        continue;
      }
      const matched = /^([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(trimmed);
      if (matched) {
        env[matched[1]] = matched[2];
      }
    }
    return env;
  }

  /**
   * `postgres` ジョブの `strategy.matrix.include` を切り出す(Issue #155)。
   * `jobBlock` はファイル先頭で `extractJob(workflow, "postgres")` によってすでに
   * 切り出してある——このジョブの `strategy:` はここでしか出てこない前提で、
   * インデント(10スペースのバレット、12スペースの続き)だけを頼りに読む。
   *
   * @returns {{ serverEncoding: string, initdbArgs: string }[]}
   */
  function extractMatrixLegs() {
    const lines = jobBlock.split("\n");
    const includeAt = lines.findIndex((line) => line === "        include:");
    if (includeAt === -1) {
      throw new Error(
        "ci.yml の postgres ジョブに strategy.matrix.include が無い(Issue #155 の matrix 化が外れている)。",
      );
    }
    /** @type {{ serverEncoding: string, initdbArgs: string }[]} */
    const legs = [];
    /** @type {{ serverEncoding: string, initdbArgs?: string } | undefined} */
    let current;
    for (let i = includeAt + 1; i < lines.length; i += 1) {
      const line = lines[i];
      const legStart = /^ {10}- serverEncoding: (.+)$/.exec(line);
      if (legStart) {
        if (current?.initdbArgs !== undefined) {
          legs.push(/** @type {{ serverEncoding: string, initdbArgs: string }} */ (current));
        }
        current = { serverEncoding: legStart[1].trim() };
        continue;
      }
      const initdbArgsMatched = /^ {12}initdbArgs: "(.*)"$/.exec(line);
      if (initdbArgsMatched && current) {
        current.initdbArgs = initdbArgsMatched[1];
        continue;
      }
      if (line.trim() === "" || line.trim().startsWith("#")) {
        continue;
      }
      if (!/^ {10,}/.test(line)) {
        // include リストの終わり(次のキー、例えば `services:` へ戻った)。
        break;
      }
    }
    if (current?.initdbArgs !== undefined) {
      legs.push(/** @type {{ serverEncoding: string, initdbArgs: string }} */ (current));
    }
    return legs;
  }

  const serviceBlocks = extractPgvectorServiceEnvBlocks();
  const matrixLegs = extractMatrixLegs();

  it("(a) image: pgvector/pgvector:pg17 の services ブロックが6本あり、6本すべてが POSTGRES_INITDB_ARGS を持つ", () => {
    expect(serviceBlocks, "pgvector/pgvector:pg17 の services ブロックの数が変わった").toHaveLength(
      6,
    );
    for (const block of serviceBlocks) {
      const env = parseEnvLines(block.envLines);
      expect(
        env.POSTGRES_INITDB_ARGS,
        "POSTGRES_INITDB_ARGS を持たない pgvector の services ブロックがある(Issue #148 ②)",
      ).toBeDefined();
    }
  });

  it("🔴 Issue #155: postgres ジョブに strategy.matrix.include が2脚(UTF8/SQL_ASCII)ある", () => {
    expect(matrixLegs.map((leg) => leg.serverEncoding).sort()).toEqual(["SQL_ASCII", "UTF8"]);
  });

  it("🔴 Issue #155: strategy.fail-fast が false である(SQL_ASCII 脚が落ちても UTF8 脚の証拠を残す)", () => {
    expect(jobBlock).toMatch(/fail-fast:\s*false/);
  });

  it("(b) ⭐ matrix 化していない他5本の POSTGRES_INITDB_ARGS は、matrix の UTF8 脚の initdbArgs と一致する(Issue #155で作り直し。『1本(いま1脚)で測った regime が他5本に効く』根拠そのもの)", () => {
    const values = serviceBlocks.map((block) => parseEnvLines(block.envLines).POSTGRES_INITDB_ARGS);
    const matrixWired = values.filter((value) => value === "${{ matrix.initdbArgs }}");
    const fixedValues = values.filter((value) => value !== "${{ matrix.initdbArgs }}");

    expect(
      matrixWired,
      "postgres ジョブの POSTGRES_INITDB_ARGS が ${{ matrix.initdbArgs }} へ配線されていない" +
        "(matrix 化が外れたか、postgres ジョブが増えた)。",
    ).toHaveLength(1);
    expect(
      fixedValues,
      "matrix 化していないはずの5本の数が変わった(Issue #155 はpostgresジョブ1本だけをmatrix化する)。",
    ).toHaveLength(5);

    const utf8Leg = matrixLegs.find((leg) => leg.serverEncoding === "UTF8");
    expect(utf8Leg, "postgres ジョブの matrix に UTF8 脚が無い").toBeDefined();

    const distinctFixed = new Set(fixedValues);
    expect(
      distinctFixed.size,
      `matrix 化していない5本の POSTGRES_INITDB_ARGS が同一でない: ${JSON.stringify(fixedValues)}。` +
        "packages/postgres ジョブでしか regime を実測していない前提が崩れる(ADR 0106)。",
    ).toBe(1);
    // `parseEnvLines` は `KEY: "value"` の右辺をクォート込みで返す(YAML の文字列表現を
    // そのまま持つ)のに対し、`extractMatrixLegs` は `initdbArgs: "(.*)"` の中身だけを
    // 取り出しているのでクォート無し——比較する前に外側のクォートを剥がす。
    const fixedValueUnquoted = [...distinctFixed][0]?.replace(/^"(.*)"$/, "$1");
    expect(
      fixedValueUnquoted,
      "他5本の値が、postgres ジョブの matrix の UTF8 脚と食い違う。UTF8 脚は過去の実測との" +
        "比較可能性のため1バイトも変えない約束である。",
    ).toBe(utf8Leg?.initdbArgs);
  });

  it("(c) ⭐ matrix の各脚は自己無矛盾(--encoding= の値がその脚の serverEncoding と一致する)", () => {
    expect(matrixLegs.length).toBeGreaterThan(0);
    for (const leg of matrixLegs) {
      const match = /--encoding=([^\s"]+)/.exec(leg.initdbArgs);
      expect(
        match,
        `脚 ${leg.serverEncoding} の initdbArgs から --encoding= を取り出せない`,
      ).not.toBeNull();
      expect(
        match?.[1],
        `脚 ${leg.serverEncoding} の initdbArgs の --encoding=(${match?.[1]}) が` +
          "自身の serverEncoding と食い違う",
      ).toBe(leg.serverEncoding);
    }
  });

  it("(c') ⭐ service env の POSTGRES_INITDB_ARGS と summary 段の --expect-encoding は、どちらも同じ matrix 変数へ直接配線されている(値を書き写すのではなく、実行時に自動で揃う)", () => {
    const values = serviceBlocks.map((block) => parseEnvLines(block.envLines).POSTGRES_INITDB_ARGS);
    expect(
      values.filter((value) => value === "${{ matrix.initdbArgs }}"),
      "postgres ジョブの POSTGRES_INITDB_ARGS が ${{ matrix.initdbArgs }} という式そのもの" +
        "になっていない(リテラル値を書いてしまうと、脚によって食い違う余地が生まれる)。",
    ).toHaveLength(1);

    const expectFlag = /--expect-encoding\s+"([^"]+)"/.exec(summaryStep?.run ?? "");
    expect(expectFlag, "summary 段に --expect-encoding の指定が無い").not.toBeNull();
    expect(
      expectFlag?.[1],
      "summary 段の --expect-encoding がリテラル値になっている。" +
        "${{ matrix.serverEncoding }} という式そのものへ配線すること" +
        "(そうしないと、脚が増えたときにこの値だけ古いまま残りうる)。",
    ).toBe("${{ matrix.serverEncoding }}");
  });
});

describe("blankOutComments 自体が効いていること(⭐ この可視化が壊れても気づけるため)", () => {
  // 🔴 この describe が無いと、`blankOutComments` が将来「何も潰さない」実装に
  // 退化しても誰も気づかない——上の固定は全部緑のまま通り、変異は再び生き残る。
  // ⟹ **潰す処理そのものを直接測る。**

  it("コメントにだけ在る文字列は、潰したあと残らない", () => {
    const source = [
      "/**",
      " * schemaVersion: 2 はコメントにだけ在る。",
      " */",
      "const a = 1; // schemaVersion: 2 も行コメントに在る",
      "",
    ].join("\n");
    expect(source, "前提: 素のソースには在る").toContain("schemaVersion: 2");
    expect(
      blankOutComments(source),
      "コメントにだけ在る文字列が潰されていない——素のソースへ当てるのと同じことになる",
    ).not.toContain("schemaVersion: 2");
  });

  it("コードに在る文字列は、潰しても残る", () => {
    const source = ["/** schemaVersion: 2 の説明 */", "const x = { schemaVersion: 2 };", ""].join(
      "\n",
    );
    expect(blankOutComments(source)).toContain("schemaVersion: 2");
  });

  it("文字列リテラルの中の // は潰さない", () => {
    const source = 'const url = "https://example.invalid/ok";\n';
    expect(blankOutComments(source)).toContain("https://example.invalid/ok");
  });

  it("添字が元のソースと一致する(順序の固定が壊れないための性質)", () => {
    const source = ["const a = 1; // 消える", "/* 消える */ const b = 2;", ""].join("\n");
    const blanked = blankOutComments(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.indexOf("const b")).toBe(source.indexOf("const b"));
  });

  it("行数が変わらない(改行を残している)", () => {
    const source = ["/*", " * 2行のブロックコメント", " */", "const a = 1;", ""].join("\n");
    const countLines = (text) => text.split("\n").length;
    expect(countLines(blankOutComments(source))).toBe(countLines(source));
  });
});

describe("コメント潰しが postgres ジョブの対象範囲で「扱えない」形に当たっていないこと(段1)", () => {
  // 🔴 `extractStepBlock` が返す前に通す `blankOutWorkflowComments` の
  // unhandled を無視できないようにする(呼び出し側が黙って安全側へ倒さないための
  // 配線そのもの。`scripts/workflow-comment-blank-lib.mjs` の docstring)。
  // ⚠ 特定の呼び出し履歴に依存しないよう、ここで postgres ジョブの全段を
  // 洗い直してから確かめる。
  it("postgres ジョブの全段(name 段)に unhandled が無い", () => {
    stepBlockCommentUnhandled.length = 0;
    for (const step of steps) {
      extractStepBlock(step.name);
    }
    expect(stepBlockCommentUnhandled).toEqual([]);
  });
});

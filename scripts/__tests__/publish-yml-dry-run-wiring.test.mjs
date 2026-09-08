import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideDryRun } from "../publish-dry-run.mjs";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`.github/workflows/publish.yml` が、実際に `decideDryRun()` に配線されていること。**
 *
 * ⚠ **これは `scripts/__tests__/publish-dry-run.test.mjs` /
 * `scripts/__tests__/decide-publish-dry-run.test.mjs` の重複ではない。**
 * その2本は**入力を自分で作って**判定を測る——前者は関数を直接呼び、後者は CLI を
 * 子プロセスで起動する。**どちらも `publish.yml` を1バイトも読まない。**
 * ⟹ 誰かが `publish.yml` から `node scripts/decide-publish-dry-run.mjs` の呼び出しを消して
 * 直す前のインライン `if`（fail-open）に戻しても、**その2本は緑のまま通る。**
 * ADR 0067 が塞いだ穴が、workflow 側の1行の書き換えで静かに開く。
 *
 * **この歯だけが `publish.yml` を入力に取る。**やっていることは:
 *
 * 1. `publish.yml` から**判定ステップを取り出す**（`decide-publish-dry-run.mjs` を打つ段）
 * 2. そのステップが `env:` で何を渡しているかを**yml から読み取る**
 *    （`EVENT_NAME` / `DRY_RUN_INPUT` という名前をこの歯に書き写さない——
 *    書き写すと、名前が変わったときに歯のほうが古いまま緑になる）
 * 3. **yml に書いてある通りのコマンドと env 名で**本物のスクリプトを起動し、
 *    `decideDryRun()` と**同じ入力集合**（event_name × dry_run の総当たり）を流して、
 *    **答えが一致する**ことを見る
 * 4. 判定の答えが `npm publish` の段まで届いていること——出力名（`steps.<id>.outputs.dry_run`）と、
 *    それを受けて `--dry-run` を立てる shell 分岐——を、**yml から取り出した shell を
 *    実際に走らせて**確かめる
 *
 * ⚠ **YAML は構造として解析していない（文字列で見ている）。**
 * `scripts/__tests__/publish-targets.test.mjs` の workflow 節と同じ判断で、
 * 歯のために YAML パーサの依存を足していない。**だからこの歯は書き方の変更に弱い。**
 * 壊れたときは「配線が変わった」か「書き方が変わった」かを見て、
 * **配線が変わっていないなら取り出し方のほうを直すこと**（歯を消さないこと）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = fileURLToPath(new URL("../../.github/workflows/publish.yml", import.meta.url));

const workflow = readFileSync(workflowPath, "utf8");

/**
 * `steps:` の下の1段（`      - name: ...` から次の同じ深さまで）へ切り分ける。
 * 各段の `id:` / `env:` / `run:` だけを取り出す（それ以外は使わない）。
 *
 * @param {string} yaml
 * @returns {{ name: string, id: string | undefined, env: Record<string, string>, run: string }[]}
 */
function parseSteps(yaml) {
  const steps = [];
  /** @type {string[] | null} */
  let current = null;
  for (const line of yaml.split("\n")) {
    if (/^ {6}- /.test(line)) {
      current = [line.replace(/^ {6}- /, "        ")];
      steps.push(current);
      continue;
    }
    if (!current) continue;
    if (line.trim() !== "" && /^ {0,7}\S/.test(line)) {
      // steps ブロックより浅い行が来たら、そこで終わり。
      current = null;
      continue;
    }
    current.push(line);
  }
  return steps.map((lines) => {
    const text = lines.join("\n");
    const nameMatch = text.match(/^ {8}name: (.*)$/m);
    const idMatch = text.match(/^ {8}id: (\S+)/m);
    return {
      name: nameMatch ? nameMatch[1].trim() : "",
      id: idMatch ? idMatch[1] : undefined,
      env: parseBlock(lines, "env"),
      run: parseScalarBlock(lines, "run"),
    };
  });
}

/**
 * `        env:` の下の `          KEY: value` を拾う。
 *
 * @param {string[]} lines
 * @returns {Record<string, string>}
 */
function parseBlock(lines, key) {
  /** @type {Record<string, string>} */
  const out = {};
  let inside = false;
  for (const line of lines) {
    if (new RegExp(`^ {8}${key}:\\s*$`).test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (line.trim() === "") continue;
    if (/^ {8}\S/.test(line)) break;
    const match = line.match(/^ {10}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

/**
 * `        run: |` の下の本体、または `        run: <一行>` を返す。
 *
 * @param {string[]} lines
 * @returns {string}
 */
function parseScalarBlock(lines, key) {
  const body = [];
  let inside = false;
  for (const line of lines) {
    if (!inside) {
      const oneLine = line.match(new RegExp(`^ {8}${key}: (?!\\|)(.*)$`));
      if (oneLine) return oneLine[1].trim();
      if (new RegExp(`^ {8}${key}: \\|`).test(line)) {
        inside = true;
        continue;
      }
      continue;
    }
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (/^ {8}\S/.test(line)) break;
    body.push(line.replace(/^ {10}/, ""));
  }
  return body.join("\n").trim();
}

const steps = parseSteps(workflow);

const decisionStep = steps.find((step) => step.run.includes("decide-publish-dry-run.mjs"));
const publishStep = steps.find((step) => step.run.includes("npm publish"));

describe(".github/workflows/publish.yml が decideDryRun() に配線されていること（通しの歯）", () => {
  it("この歯は publish.yml を実際に読んでいる（読めなければ以下は何も測っていない）", () => {
    expect(workflow, `${workflowPath} が読めなかった`).not.toBe("");
    expect(steps.length, "publish.yml の steps を1段も切り出せなかった").toBeGreaterThan(5);
  });

  /**
   * ⭐ **この歯の存在理由そのもの。**これが落ちるときは、
   * publish.yml が判定を自前の shell に戻した（＝ ADR 0067 が塞いだ fail-open が開いた）か、
   * 呼び出し先のファイル名が変わったかのどちらかである。
   */
  it("判定を scripts/decide-publish-dry-run.mjs に委ねる段が在る（インライン判定に戻っていない）", () => {
    expect(
      decisionStep,
      "publish.yml に decide-publish-dry-run.mjs を打つ段が無い" +
        "——判定が workflow 内の shell に戻っている可能性がある（ADR 0067 の fail-open が再発する）",
    ).toBeDefined();
    expect(decisionStep.id, "判定の段に id: が無いと、下の段が出力を受け取れない").toBeDefined();
  });

  it("判定の段が打つスクリプトが実在する（パスの書き間違いで静かに落ちない）", () => {
    expect(
      decisionStep,
      "判定の段が無い——判定が workflow 内の shell に戻っている（ADR 0067 の fail-open が再発する）",
    ).toBeDefined();
    const invocation = decisionStep.run.match(/node\s+(\S*decide-publish-dry-run\.mjs)/);
    expect(invocation, `node で起動していない: ${JSON.stringify(decisionStep.run)}`).not.toBeNull();
    expect(existsSync(join(repoRoot, invocation[1])), `${invocation[1]} が無い`).toBe(true);
  });

  it("判定の段は event_name と dry_run を env: 経由で渡す（${{ }} の直接展開に戻っていない）", () => {
    expect(
      decisionStep,
      "判定の段が無い——判定が workflow 内の shell に戻っている（ADR 0067 の fail-open が再発する）",
    ).toBeDefined();
    const values = Object.values(decisionStep.env);
    expect(
      values.some((v) => v.includes("github.event_name")),
      "github.event_name を渡す env: が無い",
    ).toBe(true);
    expect(
      values.some((v) => v.includes("inputs.dry_run")),
      "inputs.dry_run を渡す env: が無い",
    ).toBe(true);
  });
});

/**
 * yml から読み取った「起動の仕方」。**この歯の中に env 名やコマンドを書き写さない。**
 * 書き写すと、yml 側で名前が変わったときに歯だけが古い名前で通り続ける。
 */
function readInvocationFromWorkflow() {
  // ⚠ 配線が消えていると decisionStep が undefined になる。ここで名指しで落とす
  // ——素の TypeError にすると「歯が壊れた」と読まれ、「配線が消えた」と読まれない。
  expect(
    decisionStep,
    "publish.yml に decide-publish-dry-run.mjs を打つ段が無い" +
      "——判定が workflow 内の shell に戻っている（ADR 0067 の fail-open が再発する）",
  ).toBeDefined();
  const invocation = decisionStep.run.match(/node\s+(\S*decide-publish-dry-run\.mjs)/);
  expect(
    invocation,
    "判定の段が node で decide-publish-dry-run.mjs を起動していない",
  ).not.toBeNull();
  const entries = Object.entries(decisionStep.env);
  const eventKey = entries.find(([, v]) => v.includes("github.event_name"))?.[0];
  const dryRunKey = entries.find(([, v]) => v.includes("inputs.dry_run"))?.[0];
  expect(eventKey, "判定の段が github.event_name を env: で渡していない").toBeDefined();
  expect(dryRunKey, "判定の段が inputs.dry_run を env: で渡していない").toBeDefined();
  return { command: invocation[1], eventKey, dryRunKey };
}

describe("publish.yml の判定が decideDryRun() と同じ答えを出す（同じ入力集合で突き合わせる）", () => {
  const eventNames = ["release", "workflow_dispatch", "push", ""];
  const dryRunInputs = ["true", "false", "", undefined, "TRUE", "True", "1", "yes", "null"];

  /**
   * yml に書いてある通りのコマンドと env 名で本物のスクリプトを起動し、
   * `$GITHUB_OUTPUT` に書かれた `dry_run=` を読む。
   */
  function runAsWorkflowWould({ eventName, dryRunInput }) {
    const { command, eventKey, dryRunKey } = readInvocationFromWorkflow();
    const workDir = mkdtempSync(join(tmpdir(), "publish-yml-wiring-"));
    try {
      const githubOutput = join(workDir, "github_output");
      writeFileSync(githubOutput, "");
      const env = { ...process.env, GITHUB_OUTPUT: githubOutput };
      delete env.EVENT_NAME;
      delete env.DRY_RUN_INPUT;
      env[eventKey] = eventName;
      if (dryRunInput !== undefined) env[dryRunKey] = dryRunInput;
      const result = spawnSync(process.execPath, [join(repoRoot, command)], {
        cwd: repoRoot,
        encoding: "utf8",
        env,
      });
      const written = readFileSync(githubOutput, "utf8");
      const match = written.match(/^dry_run=(true|false)$/m);
      return {
        status: result.status,
        stdout: result.stdout,
        dryRun: match ? match[1] === "true" : undefined,
      };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  for (const eventName of eventNames) {
    for (const dryRunInput of dryRunInputs) {
      const label = `event_name=${JSON.stringify(eventName)} dry_run=${JSON.stringify(dryRunInput)}`;
      it(`一致する: ${label}`, () => {
        const expected = decideDryRun({ eventName, dryRunInput });
        const actual = runAsWorkflowWould({ eventName, dryRunInput });
        expect(actual.status, `${label} で判定の段が 0 以外で終了した`).toBe(0);
        expect(
          actual.dryRun,
          `${label}: publish.yml の配線が出した答えと decideDryRun() の答えが食い違う`,
        ).toBe(expected.dryRun);
      });
    }
  }
});

describe("判定の答えが npm publish の段まで届いている（出力名と shell 分岐）", () => {
  it("npm publish の段が、判定の段の outputs.dry_run を env: で受けている", () => {
    expect(publishStep, "npm publish を打つ段が見つからない").toBeDefined();
    expect(decisionStep, "判定の段が無いので、受け取る出力そのものが存在しない").toBeDefined();
    const consumed = Object.entries(publishStep.env).find(([, v]) =>
      new RegExp(`steps\\.${decisionStep.id}\\.outputs\\.dry_run`).test(v),
    );
    expect(
      consumed,
      `npm publish の段が steps.${decisionStep.id}.outputs.dry_run を受けていない` +
        "——判定は走るが、その答えが publish に届いていない",
    ).toBeDefined();
  });

  /**
   * ⭐ 出力を**読み違えていない**ことを、yml から取り出した shell を実際に走らせて確かめる。
   * `dry_run=true` を受けたときにだけ `--dry-run` が立つこと。
   */
  it("受け取った dry_run が true のときだけ --dry-run が立つ（yml の shell を実際に走らせる）", () => {
    expect(decisionStep, "判定の段が無いので、受け取る出力そのものが存在しない").toBeDefined();
    const consumed = Object.entries(publishStep.env).find(([, v]) =>
      new RegExp(`steps\\.${decisionStep.id}\\.outputs\\.dry_run`).test(v),
    );
    expect(consumed, "npm publish の段が判定の段の outputs.dry_run を受けていない").toBeDefined();
    const consumedKey = consumed[0];
    const branch = publishStep.run.match(/(^|\n)( *)(\w+)=""\n[\s\S]*?\n\2fi/);
    expect(branch, "npm publish の段から --dry-run を立てる分岐を取り出せなかった").not.toBeNull();
    const flagVar = branch[3];
    const segment = branch[0];
    expect(segment, "取り出した分岐が --dry-run を立てていない").toContain("--dry-run");

    for (const [given, want] of [
      ["true", "--dry-run"],
      ["false", ""],
      ["", ""],
    ]) {
      // 分岐そのものの告知（「予行です」）は捨て、立った flag だけを読む。
      const result = spawnSync(
        "bash",
        ["-c", `set -u\n{\n${segment}\n} > /dev/null\nprintf '%s' "\${${flagVar}}"`],
        { encoding: "utf8", env: { ...process.env, [consumedKey]: given } },
      );
      expect(result.status, `${consumedKey}=${JSON.stringify(given)} で shell が落ちた`).toBe(0);
      expect(result.stdout, `${consumedKey}=${JSON.stringify(given)} のときの flag`).toBe(want);
    }
  });

  it("立てた flag が npm publish の行へ渡っている", () => {
    const branch = publishStep.run.match(/(^|\n)( *)(\w+)=""\n[\s\S]*?\n\2fi/);
    const flagVar = branch[3];
    expect(publishStep.run).toMatch(new RegExp(`npm publish[\\s\\S]{0,300}\\$\\{${flagVar}\\}`));
  });
});

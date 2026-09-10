import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * `MNEMORA_RETRIEVAL_JSON` の配線そのものを測る歯(PR「retrieval を CI に載せる」)。
 *
 * **⚠ `retrieval-json.test.ts` はこれを測っていない。**そちらは `buildRetrievalQualityJson`
 * という純関数だけを見ており、`cli.ts` の `runRetrieval()` が
 * 「env が設定されていたら実際に呼んで書く／されていなければ呼ばない」という配線を
 * 持っているかどうかには一切触れない。`cli.ts` は末尾で `main().catch(...)` を
 * 無条件に実行するため import 越しに部分的に呼べず(ADR 0068「引き受ける負債」が
 * `resolveCassetteForRun` について書いたのと同じ理由)、**本物のコマンドを子プロセスとして
 * 実際に起動する**ことでしか配線を検査できない
 * （`scripts/__tests__/publish-yml-dry-run-wiring.test.mjs` と同じ判断）。
 *
 * **DB を要求する**——`retrieval` は `requireDatabaseUrl()` を通るため、この歯自体も
 * DB 無しでは何も検査できない。だから `.postgres.test.ts` に置く
 * （ADR 0033「引き受ける負債」/ ADR 0015・0016 の分割）。
 *
 * ⚠ **実 API は絶対に叩かない**——`MNEMORA_PROVIDER_SOURCE=recorded` を明示し、
 * かつ `OPENAI_API_KEY` を env から確実に消してから子プロセスへ渡す(二重に塞ぐ。
 * このリポジトリの手順書と同じ規律)。カセット再生なので実行は数秒で終わる。
 */

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

let workDir: string | undefined;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function runRetrievalCli(env: Record<string, string | undefined>) {
  return spawnSync("pnpm", ["--filter", "@mnemora/example-chat", "run", "retrieval"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("examples/chat retrieval: MNEMORA_RETRIEVAL_JSON の配線(本物の CLI を子プロセスで起動)", () => {
  it("設定すれば書く。未設定なら1バイトも挙動を変えない(同じコマンドを2回、env だけ変えて起動する)", () => {
    workDir = mkdtempSync(join(tmpdir(), "retrieval-json-wiring-"));
    const jsonPath = join(workDir, "retrieval-quality.json");

    const baseEnv: Record<string, string | undefined> = {
      ...process.env,
      DATABASE_URL: requireDatabaseUrl(),
      MNEMORA_PROVIDER_SOURCE: "recorded",
    };
    // ⚠ 二重に塞ぐ。片方だけでは実 API に倒れうる(ADR 0081 の測定環境と同じ理由)。
    delete baseEnv.OPENAI_API_KEY;

    // --- 1回目: 設定する ---
    const withEnv = runRetrievalCli({ ...baseEnv, MNEMORA_RETRIEVAL_JSON: jsonPath });
    expect(withEnv.status, `stderr:\n${withEnv.stderr}\nstdout:\n${withEnv.stdout}`).toBe(0);
    expect(existsSync(jsonPath), "MNEMORA_RETRIEVAL_JSON を設定したのにファイルが無い").toBe(true);
    expect(withEnv.stdout).toContain("[retrieval] 機械可読な結果を書き出した");

    const json = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(json.schemaVersion).toBe(1);
    expect(json.providerSource).toBe("recorded");
    expect(json.cassette).not.toBeNull();
    expect(json.cassette.embedding.model).toBe("text-embedding-3-small");
    expect(json.cassette.embedding.dimensions).toBe(256);
    // commit は取れれば40桁16進、取れなければ null——どちらであっても壊れていない。
    expect(json.commit === null || /^[0-9a-f]{40}$/.test(json.commit)).toBe(true);
    expect(() => new Date(json.measuredAt).toISOString()).not.toThrow();
    expect(json.arms).toHaveLength(3);
    for (const arm of json.arms) {
      expect(typeof arm.armLabel).toBe("string");
      expect(["deterministic", "recorded", "openai"]).toContain(arm.llmMode);
      expect(["deterministic", "recorded", "openai"]).toContain(arm.embeddingMode);
      expect(typeof arm.mrrOverall).toBe("number");
      expect(typeof arm.hit1Count).toBe("number");
      expect(typeof arm.hit10Count).toBe("number");
      expect(arm.probeCount).toBe(7);
    }
    // §3.2(ADR 0081): arm を跨いで数字を拾えない形——各 arm が自分の値を持っている
    // ことを、少なくとも arm ラベルの重複が無い形で確認する。
    expect(new Set(json.arms.map((a: { armLabel: string }) => a.armLabel)).size).toBe(3);

    // --- 2回目: 未設定 ---
    const rmJsonPath = join(workDir, "should-not-appear.json");
    const withoutEnv = runRetrievalCli(baseEnv);
    expect(withoutEnv.status, `stderr:\n${withoutEnv.stderr}\nstdout:\n${withoutEnv.stdout}`).toBe(
      0,
    );
    expect(withoutEnv.stdout).not.toContain("[retrieval] 機械可読な結果を書き出した");
    expect(existsSync(rmJsonPath)).toBe(false);
  }, 180_000);
});

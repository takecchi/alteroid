import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLISH_TARGETS } from "../publish-targets.mjs";

/**
 * `scripts/publish-targets.mjs` の歯。
 *
 * ADR 0060 は「publish の順序は依存の向きで決まる（`core` → `testkit` / `openai` →
 * `postgres`）。**これを守らせる仕掛けはまだ無い**——順序を誤ると使う側が E404 を見る」を
 * 負債として明記していた。ADR 0066 でその仕掛けを `PUBLISH_TARGETS` の**配列の順序**として
 * 置いた。この歯はその順序を機械的に検査する——**手で並べた順序を、手で確かめない。**
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function readManifest(dir) {
  return JSON.parse(readFileSync(`${repoRoot}${dir}/package.json`, "utf8"));
}

describe("PUBLISH_TARGETS（ADR 0066）", () => {
  it("4パッケージである", () => {
    expect(PUBLISH_TARGETS).toHaveLength(4);
  });

  it("各 dir の package.json の name が、リストの name と一致する", () => {
    for (const target of PUBLISH_TARGETS) {
      expect(readManifest(target.dir).name, `${target.dir} の name`).toBe(target.name);
    }
  });

  /**
   * ⭐ これがこの歯の本体である。
   *
   * **なぜ「順序が正しいこと」ではなく「自分の `@mnemora/*` 依存が自分より前に在ること」を
   * 測るか**: 前者は正解の並びをここに書き写すことになり、`publish-targets.mjs` の写しが
   * 増えるだけで、新しいパッケージが増えたときに一緒に腐る。後者は**依存の向きという
   * 現物（各 package.json の dependencies）から順序の妥当性を導く**ので、
   * パッケージが増えても書き換える必要が無い。
   */
  it("各パッケージの @mnemora/* 依存が、自分より前に publish される順に並んでいる", () => {
    const positionOf = new Map(PUBLISH_TARGETS.map((t, i) => [t.name, i]));

    for (const [index, target] of PUBLISH_TARGETS.entries()) {
      const manifest = readManifest(target.dir);
      // devDependencies は publish された tarball に載らないので順序に関係しない
      // （例: packages/postgres は @mnemora/testkit を devDependency に持つが、
      // その向きは publish 順序を縛らない）。
      const runtimeDeps = { ...manifest.dependencies, ...manifest.peerDependencies };
      for (const depName of Object.keys(runtimeDeps)) {
        if (!depName.startsWith("@mnemora/")) continue;
        const depIndex = positionOf.get(depName);
        expect(
          depIndex,
          `${target.name} が依存する ${depName} が publish 対象に無い`,
        ).toBeDefined();
        expect(
          depIndex,
          `${target.name}（${index}番目）より後に ${depName}（${depIndex}番目）を publish すると、` +
            `使う側が install で E404 を見る`,
        ).toBeLessThan(index);
      }
    }
  });

  /**
   * `scripts/__tests__/check-publish-pack.test.mjs` は同じ4つを**独立に直書き**している
   * （そちらのファイル冒頭のコメント参照）。写しが2つ在ること自体は意図的だが、
   * **中身がずれたまま気づかない**のは意図ではない。ここで突き合わせる。
   */
  it("check-publish-pack.test.mjs が直書きしている4つと、集合として一致する", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./check-publish-pack.test.mjs", import.meta.url)),
      "utf8",
    );
    const listed = [
      ...source.matchAll(/\{ name: "(@mnemora\/[a-z]+)", dir: "(packages\/[a-z]+)" \}/g),
    ];
    expect(listed.length, "歯の側の直書きリストが読み取れなかった").toBe(4);
    expect(new Set(listed.map((m) => m[1]))).toEqual(new Set(PUBLISH_TARGETS.map((t) => t.name)));
    expect(new Set(listed.map((m) => m[2]))).toEqual(new Set(PUBLISH_TARGETS.map((t) => t.dir)));
  });
});

describe(".github/workflows/publish.yml（ADR 0066）", () => {
  /**
   * ⚠ ここは YAML を構造として解析していない——**文字列で見ている。**
   * リポジトリに YAML パーサの実行時依存を1つ足してまで見る価値は無いと判断した
   * （`@mnemora/core` が zod 以外の実行時依存を持たないという方針の隣で、
   * 歯のためだけに依存を増やしたくない）。**だから、この歯は書き方の変更に弱い。**
   *
   * それでも置いたのは、ここで押さえている3つが**どれも「静かに止まる」形で失敗する**からである。
   *
   * | 壊れ方 | 使う人／打った人が見るもの |
   * |---|---|
   * | この workflow を改名する | npm 側の信頼発行元は「org / repo / **ファイル名**」で照合するため **403** |
   * | `id-token: write` を落とす | npm が長期トークンを探して見つけられず **401**（「OIDC が無効」とは言わない） |
   * | npm CLI を上げる段を落とす | Node 22 同梱の npm 10.x は OIDC の交換を実装しておらず、同じく **401** |
   */
  const workflowPath = new URL("../../.github/workflows/publish.yml", import.meta.url);

  /** @type {string} */
  let workflow;
  try {
    workflow = readFileSync(workflowPath, "utf8");
  } catch {
    workflow = "";
  }

  it("publish.yml が在る（改名すると npm 側の信頼発行元設定と食い違って 403 になる）", () => {
    expect(workflow, ".github/workflows/publish.yml が読めなかった").not.toBe("");
  });

  it("id-token: write を持つ（無いと OIDC の token を発行できず 401 になる）", () => {
    expect(workflow).toContain("id-token: write");
  });

  it("npm CLI を上げる段が在る（Trusted Publishing は npm >= 11.5.1）", () => {
    expect(workflow).toContain("npm install -g npm@latest");
  });

  /**
   * 引き金は GitHub Release の \`published\` である（ADR 0066 の追記）。
   *
   * **\`push: tags\` を同時に持たせてはならない。**Releases の UI から Release を作ると
   * tag も同時に作られるため、両方が引き金だと**同じ版で2本走る**。
   * 後から走ったほうは「既に上がっている版を飛ばす」に落ちて緑になるので事故にはならないが、
   * どちらが本物の publish だったのか読めなくなる。
   */
  it("引き金は release の published である", () => {
    expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[published\]/);
  });

  it("push: tags を引き金に持たない（Release と二重に走らせない）", () => {
    expect(workflow).not.toMatch(/^\s*push:/m);
  });

  /**
   * GitHub は pre-release でも \`published\` を発火させる。ここで dist-tag を分けないと
   * **beta が \`latest\` になり、\`npm i @mnemora/core\` が beta を掴む。**
   */
  it("pre-release を latest にしない（dist-tag を next に振る）", () => {
    expect(workflow).toContain("github.event.release.prerelease");
    expect(workflow).toContain('NPM_TAG="next"');
    expect(workflow).toContain("--tag");
  });

  /**
   * 4本を順に上げる途中で1本落ちたとき、そのまま再実行すると「1本目が既に在る」で
   * E403 になって**再開できない**。**この歯は、その飛ばす分岐が消えていないことを見る。**
   *
   * 分岐そのものの正しさ（成功→続行 / 既存→飛ばす / 本物の失敗→止まる）は、
   * npm の実出力を再現して shell を走らせて確かめた（ADR 0066 測ったこと9）。
   * ここで見ているのは「その分岐が workflow から消えていないこと」だけである。
   */
  it("既に上がっている版を飛ばす分岐を持つ（同じ版での再実行が硬く落ちない）", () => {
    expect(workflow).toContain("cannot publish over the previously published");
  });

  it("梱包は pnpm・アップロードは npm である（決定2 の配線そのもの）", () => {
    // pnpm pack を呼ぶのは pack-publish-targets.mjs 経由である
    expect(workflow).toContain("scripts/pack-publish-targets.mjs");
    // アップロードは npm publish に tarball を渡す形（pnpm publish ではない）
    expect(workflow).toMatch(/npm publish "\$\{tarball\}"/);
    expect(workflow).not.toContain("pnpm publish");
  });
});

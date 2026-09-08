import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  findWorkspaceProtocolViolations,
  findMissingEntryPoints,
  findOrphanedSourceMaps,
  findLicenseViolations,
} from "../publish-pack-checks.mjs";

/**
 * `scripts/check-publish-pack.mjs`（publish 梱包の門）の歯。
 *
 * publish 対象4パッケージは固定である（`docs/roadmap.md` 等で機械的に判別できる
 * 目印は無く、上位で決定済みのリストを直書きしている——`check-publish-pack.mjs`
 * 冒頭のコメント参照）。この歯もその4つを直書きで持つ。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const gate = fileURLToPath(new URL("../check-publish-pack.mjs", import.meta.url));

const PUBLISH_TARGETS = [
  { name: "@mnemora/core", dir: "packages/core" },
  { name: "@mnemora/testkit", dir: "packages/testkit" },
  { name: "@mnemora/postgres", dir: "packages/postgres" },
  { name: "@mnemora/openai", dir: "packages/openai" },
];

function readManifest(dir) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${dir}/package.json`, import.meta.url)), "utf8"),
  );
}

describe("publish 対象4パッケージの package.json（静的）", () => {
  for (const target of PUBLISH_TARGETS) {
    describe(target.name, () => {
      const manifest = readManifest(target.dir);

      it("version が 0.0.0 のままではない", () => {
        expect(manifest.version).not.toBe("0.0.0");
        expect(manifest.version).toBeTruthy();
      });

      it("prepack が dist を作り直す（`pnpm pack` が空の tarball を出す穴を塞ぐ本体）", () => {
        expect(manifest.scripts?.prepack).toBe("pnpm run build");
      });

      it("publishConfig.access が public", () => {
        expect(manifest.publishConfig?.access).toBe("public");
      });

      /**
       * ⚠ これは作業ツリーの package.json を読むだけの静的な歯であり、
       * 「使う人が受け取る tarball に MIT の LICENSE が実際に入っているか」までは
       * 測っていない。それは下の「本物どおり起動すると EXIT=0 になる」歯
       * （`findLicenseViolations` を tarball 展開後の manifest に対して呼ぶ経路）が測る。
       * この歯はその代わりではなく、作業ツリー側の設定漏れを早く落とすための補助である
       * （ADR 0061）。
       */
      it("license が MIT である（UNLICENSED 等の他の値ではない）", () => {
        expect(manifest.license).toBe("MIT");
      });

      it("engines.node が設定されている", () => {
        expect(manifest.engines?.node).toBeTruthy();
      });

      it("repository が packages/<name> を指している", () => {
        expect(manifest.repository?.type).toBe("git");
        expect(manifest.repository?.url).toBe("git+https://github.com/takecchi/mnemora.git");
        expect(manifest.repository?.directory).toBe(target.dir);
      });

      it("homepage が設定されている", () => {
        expect(manifest.homepage).toContain("github.com/takecchi/mnemora");
        expect(manifest.homepage).toContain(target.dir);
      });

      it("bugs.url が設定されている", () => {
        expect(manifest.bugs?.url).toBe("https://github.com/takecchi/mnemora/issues");
      });

      /**
       * ⚠ これは「今のところそうなっている」を固定する歯であって、「そうあるべき」を
       * 固定する歯ではない。`private: true` は、この PR の時点で唯一の誤 publish の
       * ラッチである——publish を実際に始めるときには、対象4パッケージから
       * `private` を外す判断が別途必要になる（この PR ではやらない。上位判断）。
       * その判断が下って `private` が外れたら、この歯は目的通りに壊れて直され直す
       * ——それはこの歯の失敗ではなく、意図した形での陳腐化である。
       */
      it("private: true のままである（publish を止める唯一のラッチ。外す判断はこの PR の範囲外）", () => {
        expect(manifest.private).toBe(true);
      });
    });
  }

  it("4パッケージとも version が揃っている", () => {
    const versions = new Set(PUBLISH_TARGETS.map((t) => readManifest(t.dir).version));
    expect(versions.size).toBe(1);
  });
});

describe("publish-pack-checks.mjs の判定関数（合成フィクスチャに対する変異の歯）", () => {
  /**
   * ここで測りたいのは「違反が無いから緑」なのか「検出できていないから緑」なのかの
   * 区別。だから各歯は必ず対（壊した入力・直した入力）で書く——壊した側が実際に
   * 落ちる（＝検出する）ことを確認しないかぎり、直した側が通ることに意味は無い。
   */

  describe("findWorkspaceProtocolViolations", () => {
    it("dependencies の workspace: を検出する", () => {
      const violations = findWorkspaceProtocolViolations({
        dependencies: { "@mnemora/core": "workspace:*" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("dependencies.@mnemora/core");
      expect(violations[0]).toContain("workspace:*");
    });

    it("実版に置換されていれば検出しない", () => {
      const violations = findWorkspaceProtocolViolations({
        dependencies: { "@mnemora/core": "0.1.0" },
      });
      expect(violations).toEqual([]);
    });

    it("peerDependencies の workspace: も検出する", () => {
      const violations = findWorkspaceProtocolViolations({
        peerDependencies: { "@mnemora/core": "workspace:^0.1.0" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("peerDependencies.@mnemora/core");
    });

    it("optionalDependencies の workspace: も検出する", () => {
      const violations = findWorkspaceProtocolViolations({
        optionalDependencies: { "@mnemora/core": "workspace:*" },
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("optionalDependencies.@mnemora/core");
    });
  });

  describe("findMissingEntryPoints", () => {
    /** @type {string | undefined} */
    let fixtureDir;

    afterEach(() => {
      if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
        fixtureDir = undefined;
      }
    });

    it("main が実在すれば0件、消せば1件検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-main-"));
      writeFileSync(join(fixtureDir, "index.js"), "export {};\n");

      const present = findMissingEntryPoints({ main: "./index.js" }, fixtureDir);
      expect(present).toEqual([]);

      const missing = findMissingEntryPoints({ main: "./missing.js" }, fixtureDir);
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain("main");
      expect(missing[0]).toContain("./missing.js");
    });

    it("bin（オブジェクト形式）が実在すれば0件、消せば1件検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-bin-obj-"));
      mkdirSync(join(fixtureDir, "bin"));
      writeFileSync(join(fixtureDir, "bin", "migrate.js"), "#!/usr/bin/env node\n");

      const present = findMissingEntryPoints(
        { bin: { "mnemora-postgres-migrate": "./bin/migrate.js" } },
        fixtureDir,
      );
      expect(present).toEqual([]);

      const missing = findMissingEntryPoints(
        { bin: { "mnemora-postgres-migrate": "./bin/does-not-exist.js" } },
        fixtureDir,
      );
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain("bin.mnemora-postgres-migrate");
    });

    it("bin（文字列形式）が実在すれば0件、消せば1件検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-bin-str-"));
      writeFileSync(join(fixtureDir, "cli.js"), "#!/usr/bin/env node\n");

      const present = findMissingEntryPoints({ bin: "./cli.js" }, fixtureDir);
      expect(present).toEqual([]);

      const missing = findMissingEntryPoints({ bin: "./missing-cli.js" }, fixtureDir);
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain("bin");
      expect(missing[0]).toContain("./missing-cli.js");
    });
  });

  describe("findOrphanedSourceMaps", () => {
    /** @type {string | undefined} */
    let fixtureDir;

    afterEach(() => {
      if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
        fixtureDir = undefined;
      }
    });

    it("sources が tarball 内に実在すれば検出しない", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-map-ok-"));
      mkdirSync(join(fixtureDir, "dist"));
      writeFileSync(join(fixtureDir, "dist", "x.js"), "export {};\n");
      writeFileSync(
        join(fixtureDir, "dist", "x.d.ts.map"),
        JSON.stringify({ version: 3, sources: ["./x.js"] }),
      );

      expect(findOrphanedSourceMaps(fixtureDir)).toEqual([]);
    });

    /**
     * これは publish 前の現物で実際に起きていた形そのものである: 修正前の
     * `packages/core` の `dist/index.d.ts.map` は `sources: ["../src/index.ts"]` を
     * 持っていたが、`files: ["dist"]` は `src/` を tarball に含めないため、
     * その実体は tarball の中に無かった（実測して確認した。段6のADR相当の記録は
     * `docs/decisions/` 側に別途ある）。
     */
    it("sources が tarball 内に無ければ検出する（publish 前の現物で実際に起きていた形）", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-map-orphan-"));
      mkdirSync(join(fixtureDir, "dist"));
      writeFileSync(
        join(fixtureDir, "dist", "index.d.ts.map"),
        JSON.stringify({ version: 3, sources: ["../src/index.ts"] }),
      );
      // src/ は意図して作らない — files: ["dist"] が tarball に含めない部分の再現。

      const orphans = findOrphanedSourceMaps(fixtureDir);
      expect(orphans).toHaveLength(1);
      expect(orphans[0]).toContain("index.d.ts.map");
      expect(orphans[0]).toContain("../src/index.ts");
    });
  });

  describe("findLicenseViolations（ADR 0061）", () => {
    /** @type {string | undefined} */
    let fixtureDir;

    afterEach(() => {
      if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
        fixtureDir = undefined;
      }
    });

    it("license が MIT かつ LICENSE が実在すれば検出しない", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-license-ok-"));
      writeFileSync(join(fixtureDir, "LICENSE"), "MIT License\n");

      expect(findLicenseViolations({ license: "MIT" }, fixtureDir)).toEqual([]);
    });

    it("license が UNLICENSED なら検出する（LICENSE ファイルの有無に関わらず）", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-license-unlicensed-"));
      writeFileSync(join(fixtureDir, "LICENSE"), "MIT License\n");

      const violations = findLicenseViolations({ license: "UNLICENSED" }, fixtureDir);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("MIT");
      expect(violations[0]).toContain("UNLICENSED");
    });

    /**
     * 「`UNLICENSED` でないこと」だけを見る弱い歯だと、隣の値（`Apache-2.0` 等）を
     * 通してしまう。オーナーが選んだのは MIT そのものである（ADR 0061）ため、
     * `MIT` との等値で検査する——この歯はその等値検査が実際に隣の値を落とすことを測る。
     */
    it("license が Apache-2.0 なら検出する（隣の値を通さない）", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-license-apache-"));
      writeFileSync(join(fixtureDir, "LICENSE"), "Apache License\n");

      const violations = findLicenseViolations({ license: "Apache-2.0" }, fixtureDir);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("Apache-2.0");
    });

    it("LICENSE ファイルが無ければ検出する（license フィールドが MIT でも）", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-license-missing-file-"));
      // LICENSE を意図して作らない。

      const violations = findLicenseViolations({ license: "MIT" }, fixtureDir);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("LICENSE ファイルが tarball に入っていません");
    });

    it("license も LICENSE も両方欠けていれば2件検出する", () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "publish-pack-checks-license-both-missing-"));

      const violations = findLicenseViolations({ license: "UNLICENSED" }, fixtureDir);
      expect(violations).toHaveLength(2);
    });
  });
});

describe("scripts/check-publish-pack.mjs（動的・本物の pnpm pack を起動する）", () => {
  it("本物どおり起動すると EXIT=0 になる", () => {
    const result = spawnSync(process.execPath, [gate], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, `期待した EXIT=0 にならなかった。出力:\n${output}`).toBe(0);
    expect(output).toContain("publish 梱包の門を通りました");
  }, 120_000);
});

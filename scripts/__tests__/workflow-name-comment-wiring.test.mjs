import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeWorkflowNames } from "../workflow-name-comment-lib.mjs";

/**
 * `.github/workflows/**` に実在する全ての `name:`(job 名 / step 名 /
 * `with: name:` の artifact 名)が、引用符無しの値に半角空白付きの `#` を書いて
 * しまい、YAML のコメント規則に食われて黙って切れていないかを測る歯。
 *
 * ⭐ **この歯が無いと何が起きるか(伝聞ではなく、今日この手で実測した現物)**:
 * 修正前の `27d1340` では `ci.yml:644` の consolidation-cost ジョブが
 * ```
 * name: Runtime.consolidate() が「載る量」に効くかを実測し、値を残す（Issue #136）
 * ```
 * と書かれていたが、GitHub の check-runs API で実際に付いた job name は
 * ```
 * Runtime.consolidate() が「載る量」に効くかを実測し、値を残す（Issue
 * ```
 * だった——`（Issue #136）` の `#` の直前が半角空白であるため、YAML パーサが
 * そこをコメント開始と解釈し、閉じ括弧ごと黙って捨てていた。**job name は
 * branch protection の `required_status_checks.contexts` に登録する文字列その
 * ものなので**、これは実害である(登録した文字列と実際に付く名前がずれると、
 * 一致しない required check が居座って main がマージ不能になる)。
 * `ad4db927`(PR #158)で該当箇所を含む5箇所を引用符で囲んで直した——
 * **⛔ この歯の仕事は「直っていることを固定する」ことであり、値そのものを
 * 直す仕事はもう終わっている。**
 *
 * ⚠ **これは他の `ci-yml-*-wiring.test.mjs` の重複ではない。** 既存5本は
 * 「特定のジョブが特定のスクリプトへ配線されているか」(セマンティクス)を測るが、
 * どれも `name:` の値が YAML として無事に生き残っているかは1つも見ていない。
 * この歯だけが「書いた文字列と、YAML パーサが実際に読む文字列が一致するか」を
 * 測る——対象はジョブ名・ステップ名・artifact 名を含む `name:` というキー全部で
 * あり、特定のジョブに限らない(だから対象ファイルも `ci.yml` に限らず
 * `.github/workflows/` 配下の全ファイルにしている)。
 *
 * ## 採った形: (A) 生テキストの引用符の有無を見る(YAML パーサを書く/足すのではない)
 *
 * 依頼の選択肢のうち **(B) 実際に GitHub Actions を走らせ、check-runs API が
 * 返す job name と ci.yml の記述を突き合わせる形は採らなかった。** (B) は
 * ネットワークと「実際に走った workflow run」を要求するため、ルートの
 * `vitest run`(この歯が走る場所であり、`typecheck / lint / test / build` という
 * required context そのもの)の中では原理的に実行できない——CI 自身が「自分の
 * 名前が正しいか」を自分の実行結果を使って確かめることになり、鶏と卵になる。
 * **(A) は `.github/workflows/**` のテキストだけを入力にでき、DB もネットワークも
 * 要らないので、ルートの門にそのまま置ける。**この見立ては崩してよいと言われて
 * いるが、私はこの理由で (A) を採った。
 *
 * ## 依存を足していない理由
 *
 * この repo に YAML パーサは無い(`pnpm-lock.yaml` の `yaml` は vite の optional
 * peerDependency として名前が出ているだけで install されない)。既存の
 * `ci-yml-*-wiring.test.mjs` と同じ判断で、この歯のためにも YAML パーサの依存を
 * 足していない(依存追加はオーナー専権。`docs/autonomy.md`、ADR 0014/0061)。
 * ⟹ `scripts/workflow-name-comment-lib.mjs` が自前で YAML のコメント規則
 * (「行頭、または半角空白/タブの直後の `#`」)だけを実装している。
 *
 * ⚠ **この自前実装は万能ではない。** `workflow-name-comment-lib.mjs` の
 * docstring に挙げた「扱えない形」(block scalar・flow mapping・複数行に折り返す
 * 引用符付きスカラ・空の inline 値)に出会うと `status: "unhandled"` を返す。
 * **この歯は unhandled を安全側(緑)へ倒さず、赤くする。** 現状の
 * `.github/workflows/**` にはそれらの形が無いことを実測で確認済みだが
 * (`grep -nE 'name:\s*[|>]'` / `name:\s*\{` / `name:\s*$` がいずれも0件)、
 * 将来誰かがそういう形の `name:` を足したら、この歯は「安全とは言えない形が
 * 増えた」と名指しで落ちる——それはこの歯の仕事であり、バグではない。
 * 落ちたら `workflow-name-comment-lib.mjs` にその形の判定を足すこと
 * (歯を消さないこと・黙って許可リストへ入れないこと)。
 */

const workflowsDir = fileURLToPath(new URL("../../.github/workflows", import.meta.url));

/**
 * `.github/workflows/` 直下の `*.yml` / `*.yaml` を全部読む。
 * ⚠ サブディレクトリは辿らない(現状 `.github/workflows/` は平らな構成であり、
 * 実測でもサブディレクトリは無い)。
 *
 * @returns {{ fileName: string, text: string }[]}
 */
function readWorkflowFiles() {
  const fileNames = readdirSync(workflowsDir).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );
  expect(
    fileNames.length,
    ".github/workflows/ に *.yml/*.yaml が1つも無い——ディレクトリの場所か拡張子が変わった。",
  ).toBeGreaterThan(0);
  return fileNames.map((fileName) => ({
    fileName,
    text: readFileSync(join(workflowsDir, fileName), "utf8"),
  }));
}

describe(".github/workflows/** の name: が YAML のコメントに食われて切れていないこと", () => {
  const files = readWorkflowFiles();

  it("対象ファイルが2本(ci.yml / publish.yml)より減っていない(門の対象が痩せていないこと)", () => {
    // ⚠ **`toEqual` で完全一致にしない。** 完全一致にすると「痩せていないこと」だけでなく
    // 「増えていないこと」まで門にしてしまい、新しい健全な workflow ファイルを足すという
    // 正当な変更のたびにこの歯が無関係な理由(name: が切れているかとは無関係)で赤くなる
    // ——実際に `.github/workflows/zz-probe.yml` を足して撃ち、この行だけが赤くなり
    // 他10本は緑のままだったことを確認した(偽陽性)。**測りたいのは「対象が減っていない
    // こと」だけ**なので、`arrayContaining` で「これらが少なくとも含まれる」ことだけを
    // 主張する(増える分には門を掛けない)。
    expect(files.map((f) => f.fileName)).toEqual(expect.arrayContaining(["ci.yml", "publish.yml"]));
  });

  for (const { fileName, text } of files) {
    describe(fileName, () => {
      const results = analyzeWorkflowNames(text, fileName);

      it("name: 宣言が1個以上見つかる(抽出そのものが壊れていないこと)", () => {
        expect(
          results.length,
          `${fileName} から name: 宣言が1つも取れなかった——findNameDeclarations の` +
            "正規表現が壊れたか、ファイルの形が変わった。",
        ).toBeGreaterThan(0);
      });

      it("truncated(黙って切れる)判定が1件も無い", () => {
        const truncated = results.filter((r) => r.status === "truncated");
        expect(
          truncated,
          truncated
            .map(
              (r) =>
                `${fileName}:${r.lineNumber} — 引用符無しの値が半角空白付きの # で切れている。` +
                `残る部分: ${JSON.stringify(r.kept)} / 生の行: ${r.rawLine}`,
            )
            .join("\n"),
        ).toHaveLength(0);
      });

      it("🔴 unhandled(この歯が自信を持てない形)が1件も無い", () => {
        const unhandled = results.filter((r) => r.status === "unhandled");
        expect(
          unhandled,
          unhandled
            .map(
              (r) =>
                `${fileName}:${r.lineNumber} — この歯が扱えない形の name: に出会った` +
                `(reason: ${r.reason})。安全と決めつけず、workflow-name-comment-lib.mjs に` +
                `この形の判定を足すこと。生の行: ${r.rawLine}`,
            )
            .join("\n"),
        ).toHaveLength(0);
      });
    });
  }

  it("⭐ 対照: ci.yml:518 型(全角括弧の直後に #)の名前が、誤って truncated 扱いされていない", () => {
    // ⚠ **job id(`identifier-probes:`)で場所を探す。** ジョブの表示名(`name:` の値)の
    // 文言でここを探すと、`#` を含まない語の書き換え(変異試験(2))がたまたまこの
    // 文言に当たっただけで対照の場所を見失う——実際に撃って確かめた(手記: 変異試験(2)で
    // 「識別子・固有名詞」→「識別子・専門用語」に書き換えたところ、以前はここが
    // `startsWith("識別子・固有名詞 probe")` で探していたため見失った)。job id は
    // `ci-yml-identifier-probes-wiring.test.mjs` が既に「消えたら赤くなる」を担保している
    // 識別子であり、表示名より安定している。
    const ciYml = files.find((f) => f.fileName === "ci.yml");
    expect(ciYml, "ci.yml が読めていない").toBeDefined();
    const jobIdLine = ciYml.text.split("\n").findIndex((line) => line === "  identifier-probes:");
    expect(
      jobIdLine,
      "ci.yml に `  identifier-probes:` ジョブが無い——対照事例そのものが無くなっている。" +
        "ジョブ ID が変わったなら、この対照の探し方を直すこと。",
    ).toBeGreaterThan(-1);
    const results = analyzeWorkflowNames(ciYml.text, "ci.yml");
    const jobNameDecl = results.find(
      (r) => !r.isStep && r.indent === 4 && r.lineNumber > jobIdLine + 1,
    );
    expect(
      jobNameDecl,
      "identifier-probes ジョブの直後に job 直下の name: が見当たらない",
    ).toBeDefined();
    // `#106` という「# の直前が全角括弧」の断片は、変異試験(2)(# を含まない語だけを
    // 書き換える)の定義上は触られない部分なので、ここを固定点にする。
    expect(jobNameDecl?.value).toContain("（#106）");
    expect(jobNameDecl?.status).toBe("safe");
  });
});

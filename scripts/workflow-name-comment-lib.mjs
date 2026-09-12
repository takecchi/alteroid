/**
 * `.github/workflows/**` の `name:`(job / step / `with: name:` の artifact 名を含む)が、
 * **引用符無しの値に半角空白付きの `#` を書いてしまい、YAML のコメント規則に食われて
 * 黙って切れていないか**を測る純関数の側(このリポジトリで実際に起きた欠陥。
 * PR #157/#158 で `ci.yml:644` の job name が `Runtime.consolidate() が「載る量」に
 * 効くかを実測し、値を残す（Issue` で切れて名乗っていたのを、引用符で囲んで直した)。
 *
 * ⭐ **なぜ実害があるか**: job name は branch protection の
 * `required_status_checks.contexts` に登録する文字列そのものである。名前が黙って
 * 切れると、そこに登録した文字列と実際に付く名前がずれ、
 * 「いつまでも success にならない required check」が居座って main がマージ不能になる
 * (`ad4db927` のコミットメッセージが「今日 main をマージ不能にしかけた形」と書いている
 * とおり)。artifact 名(`with: name:`)が切れれば、`actions/download-artifact` の
 * `pattern:` と一致しなくなり、同じく黙って外れる。
 *
 * ## YAML のコメント規則(このモジュールが前提にしていること)
 *
 * YAML は「行頭、または**半角空白/タブの直後**の `#`」をコメント開始として読む。
 * ⟹ 引用符の無い(plain scalar の)値の途中に半角空白付きの `#` が在ると、
 * そこから行末までが構造上のコメントとして黙って捨てられる。
 * 引用符(`"…"` / `'…'`)の中の `#` はコメント開始にならない——これが
 * PR #158 の直し方(引用符で囲む)の効く理由である。
 *
 * ⚠ **全角文字は YAML の空白ではない。** `識別子・固有名詞 probe（#106）…`
 * (`ci.yml:518`)のように `#` の直前が全角の `（` である場合、コメントは始まらない
 * ——**「`#` が在るかどうか」だけを見る歯はここを誤検出して赤くなる。**
 * このモジュールの `classifyPlainScalarValue` は半角スペース/タブだけを
 * 「コメントを始める空白」として扱う。
 *
 * ## このモジュールが扱える形・扱えない形
 *
 * 扱う(判定できる):
 * - 二重引用符 `"…"` / 単一引用符 `'…'` で、**同じ行の中で閉じているもの**
 *   (`''` によるエスケープ、`\"` によるエスケープを解釈する)
 * - 引用符無しの plain scalar(1行に収まっているもの)
 *
 * 🔴 **扱えない(自信が持てない)形に出会ったら、黙って安全側へ倒さず
 * `status: "unhandled"` を返す。** 呼び出し側(このファイルの下の
 * `analyzeWorkflowNames` を使う歯)は、これを「安全」として無視してはならない
 * ——`AGENTS.md` の「確かめていないことは『確かめていない』と書く」の実装版である。
 * 具体的に unhandled にする形:
 * - block scalar(`name: |` / `name: >`。折り返し規則が plain scalar と別で、
 *   この実装は追っていない)
 * - flow mapping(`name: { … }`)
 * - 引用符が同じ行で閉じていない(複数行に折り返す plain/quoted scalar。
 *   この repo の `.github/workflows/**` には現状1つも無いことを確認済み——
 *   `grep -nE 'name:\s*[|>]'` / `name:\s*\{` / `name:\s*$` がいずれも0件。
 *   将来増えたら、この歯は「扱えない形が増えた」と名指しで落ちる)
 * - コロンの直後に何も無い(空の inline 値。次の行へ続く形かもしれず、
 *   この実装は「値が同じ行に無い」ことしか言えない)
 *
 * ⚠ **`docs/autonomy.md` に従い、この歯のために YAML パーサの依存を足していない。**
 * (`ci-yml-postgres-regime-wiring.test.mjs` などの既存 wiring 歯と同じ判断。
 * 依存追加はオーナー専権——ADR 0014/0061。)⟹ **この実装は自前の文字列解析であり、
 * 上に挙げた「扱えない形」の外では自信を持てない。** 壊れたときは
 * 「対象の形が増えた」のか「この実装の書き方が古いだけ」なのかを見て、
 * 前者なら unhandled の種類を足すこと(歯を消さないこと・黙って safe 側へ倒さないこと)。
 */

const COMMENT_START_WHITESPACE = new Set([" ", "\t"]);

/**
 * `.github/workflows/**` の1ファイルのテキストから、`name:` のキーを持つ行を
 * すべて拾う(job 直下の `name:` / step の `- name:` / `with:` 直下の `name:` を
 * 区別せず全部拾う——artifact 名も同じ静かな欠陥を踏むため、Issue の対象は
 * 「`name:` というキー全部」である)。
 *
 * ⚠ **正規表現は「行頭の空白 + 任意で `- ` + 直後に `name:`」だけを見ており、
 * YAML の構造(このキーが `steps:` の下か `with:` の下か)は見ていない。**
 * それでよい理由: この歯が測りたいのは「値が黙って切れるかどうか」であり、
 * どの階層の `name:` かは無関係だからである。
 *
 * 🔴 **実際に撃って確認した誤検出**: `run: |` の block scalar の中身に、行頭が
 * `name:` で始まる行(例えばヒアドキュメントで `name: dummy #123` を出力する行)が
 * 来ると、この関数はそれを YAML の `name:` キーだと誤って拾う——実測で確認済み
 * (`ci.yml` の build ジョブに
 * `run: |\n  cat <<EOF\n  name: dummy #123\n  EOF` という段を足して撃ったところ、
 * `dummy #123` が `truncated` として検出された)。**対照として、`echo "name: …"`
 * のように行頭が `name:` でない形(前に他の文字がある)は誤検出しない**——この
 * 正規表現は `^` で行頭からしか一致しないため。⟹ **弱いのは「block scalar の中で
 * 行頭に `name:` が来る」場合に限られる。** 現状の `.github/workflows/**` には
 * 実際にそういう行は無い(`ci.yml`/`publish.yml` 全行を目視して確認済み)。
 * 見つかったら、この関数は誤検出する(行が YAML の構造として `name:` キーでは
 * ないのに拾ってしまう)——その場合はここに `run:` ブロックの追跡を足すこと。
 *
 * @param {string} yamlText
 * @returns {{ lineNumber: number, indent: number, isStep: boolean, rawLine: string, value: string }[]}
 */
export function findNameDeclarations(yamlText) {
  const lines = yamlText.split("\n");
  const NAME_KEY_PATTERN = /^(\s*)(-\s+)?name:(.*)$/;
  /** @type {{ lineNumber: number, indent: number, isStep: boolean, rawLine: string, value: string }[]} */
  const declarations = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const matched = NAME_KEY_PATTERN.exec(line);
    if (!matched) {
      continue;
    }
    const [, indent, dash, rest] = matched;
    // `key: value` は `:` の直後にちょうど1個の半角スペースを置く形が普通だが、
    // 値そのものが空白から始まる可能性は無い(YAML はそれを許さない)ので、
    // 先頭の1個だけを剥がす。2個目以降の空白は値の一部として残す。
    const value = rest.startsWith(" ") ? rest.slice(1) : rest;
    declarations.push({
      lineNumber: i + 1,
      indent: indent.length,
      isStep: Boolean(dash),
      rawLine: line,
      value,
    });
  }
  return declarations;
}

/**
 * 引用符付きの値(`"…"` / `'…'`)が**同じ行の中で閉じているか**を確かめ、
 * 閉じていれば安全(コメントに食われない)と判定する。
 *
 * @param {string} value `"` または `'` から始まる文字列(name: の右辺そのもの)
 * @param {'"' | "'"} quoteChar
 * @returns {{ status: "safe" | "unhandled", reason: string }}
 */
function classifyQuotedValue(value, quoteChar) {
  let i = 1;
  while (i < value.length) {
    const ch = value[i];
    if (quoteChar === '"' && ch === "\\") {
      // 二重引用符はバックスラッシュでエスケープする(`\"` は閉じ引用符ではない)。
      i += 2;
      continue;
    }
    if (ch === quoteChar) {
      if (quoteChar === "'" && value[i + 1] === "'") {
        // 単一引用符は `''` で「エスケープされた1個の `'`」を表す(閉じではない)。
        i += 2;
        continue;
      }
      return { status: "safe", reason: "quoted-closed-on-same-line" };
    }
    i += 1;
  }
  return { status: "unhandled", reason: "quoted-not-closed-on-same-line" };
}

/**
 * 引用符無しの値(plain scalar)を判定する。
 *
 * 🔴 **これがこの歯の核心。** 半角空白/タブの直後、または値の先頭にある `#` だけを
 * 「コメントを始める `#`」として扱う。全角文字(例: `（`)の直後の `#` はコメントを
 * 始めない——YAML の空白ではないため。
 *
 * @param {string} value
 * @returns {{ status: "safe" | "truncated", reason: string, cutAt?: number, kept?: string }}
 */
function classifyPlainScalarValue(value) {
  if (value.length > 0 && value[0] === "#") {
    return { status: "truncated", reason: "value-starts-with-comment-marker", cutAt: 0, kept: "" };
  }
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === "#" && COMMENT_START_WHITESPACE.has(value[i - 1])) {
      return {
        status: "truncated",
        reason: "comment-marker-inside-unquoted-value",
        cutAt: i,
        kept: value.slice(0, i).replace(/[ \t]+$/, ""),
      };
    }
  }
  return { status: "safe", reason: "plain-scalar-no-comment-marker" };
}

/**
 * `name:` の右辺1個を判定する(`findNameDeclarations` が返す `value` を渡す)。
 *
 * @param {string} value
 * @returns {{ status: "safe" | "truncated" | "unhandled", reason: string, cutAt?: number, kept?: string }}
 */
export function classifyNameValue(value) {
  if (value.trim() === "") {
    return { status: "unhandled", reason: "empty-inline-value" };
  }
  if (value.startsWith("|") || value.startsWith(">")) {
    return { status: "unhandled", reason: "block-scalar" };
  }
  if (value.startsWith("{")) {
    return { status: "unhandled", reason: "flow-mapping" };
  }
  if (value.startsWith('"')) {
    return classifyQuotedValue(value, '"');
  }
  if (value.startsWith("'")) {
    return classifyQuotedValue(value, "'");
  }
  return classifyPlainScalarValue(value);
}

/**
 * 1ファイル分の YAML テキストを解析し、`name:` 宣言ごとに判定結果を付けて返す。
 *
 * @param {string} yamlText
 * @param {string} [fileLabel] エラーメッセージに出すファイル名(複数ファイルを
 *   まとめて扱う呼び出し側のため)。
 * @returns {{ lineNumber: number, indent: number, isStep: boolean, rawLine: string, value: string,
 *   status: "safe" | "truncated" | "unhandled", reason: string, cutAt?: number, kept?: string,
 *   fileLabel?: string }[]}
 */
export function analyzeWorkflowNames(yamlText, fileLabel) {
  return findNameDeclarations(yamlText).map((decl) => ({
    ...decl,
    fileLabel,
    ...classifyNameValue(decl.value),
  }));
}

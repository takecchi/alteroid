/**
 * `.github/workflows/**` から切り出したテキスト(ジョブ1本・段1本などの生の YAML)の
 * **コメントだけを空白へ潰す**純関数の側。
 *
 * ⭐ **なぜ要るか(段1・Issue #148/#155 の変異試験で見つけた欠陥)**
 *
 * `scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` と
 * `scripts/__tests__/ci-yml-postgres-regime-coverage-wiring.test.mjs` の一部の歯は、
 * `ci.yml` から切り出した生テキストへ `toContain("exit 1")` / `toContain("if: always()")`
 * のような素朴な文字列一致を当てていた。ところが**その文字列が「地の文のコメントの中で
 * 引用されているだけ」でも一致してしまう**ため、実際のキー(`if: always()` という YAML の
 * `if:` の値、`exit 1` という実行される bash 文)を無効化する変異(コメント化)を当てても、
 * 歯は緑のまま通っていた(段1の変異D・変異H。実測して確認済み)。
 *
 * この欠陥は `scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` の
 * `blankOutComments`(JavaScript のコメント専用)が既に一度踏んで直した欠陥と**同じ形**
 * である(`lexical-store-identifier.test.ts` の docstring に同じ文字列が在ったため、
 * 実際の代入を変えても歯が緑のままだった、という話)。⟹ **同じ判断を YAML / bash 向けに
 * 足す。**思想を作り直さない——`scripts/workflow-name-comment-lib.mjs`(PR #159)が
 * 既に「YAML のコメント規則(半角空白/タブの直後の `#` だけがコメントを開始する。
 * 全角文字の直後は違う)」と「扱えない形は黙って安全側へ倒さず `unhandled` を名乗って
 * 赤くする」という2つの判断を下しているので、それを踏襲する。
 *
 * ## 2つの規則(区別すること)
 *
 * - **YAML のコメント**: 行頭、または半角スペース/タブの直後の `#` から行末まで。
 *   全角文字の直後の `#` はコメントではない(`workflow-name-comment-lib.mjs` と同じ
 *   `COMMENT_START_WHITESPACE`)。引用符(`"…"` / `'…'`)の中の `#` もコメントではない。
 * - **`run: |` などの block scalar の中身は bash が読む。** bash でも `#` は
 *   「行頭か空白の直後」でコメントを開始する規則は同じだが、引用符の中は別
 *   (`echo "…（#106）…" >&2` のような行が実在する)。
 *
 * ⭐ **この2つは、この実装では同じ1回の走査で扱える**——「`#` の直前が半角空白/タブか
 * 行頭か」という開始条件そのものは YAML と bash で一致しており、行をまたいだ
 * コメント(block comment)がどちらの言語にも無い(YAML も bash も「行コメント」しか
 * 持たない)ため、状態機械は「行ごとにリセットする」だけで両方の場を満たせる。
 * ⟹ **呼び出し側がテキストの中で YAML の地の文と `run:` の中身のどちらを見ているかを
 * 教えなくてよい**——このモジュールは行の意味(構造)を解釈せず、文字だけを見る。
 *
 * ## 引用符の扱い(⚠ 既知の限界)
 *
 * 二重引用符 `"…"` はバックスラッシュでエスケープする(`\"` は閉じ引用符ではない —
 * `workflow-name-comment-lib.mjs` の `classifyQuotedValue` と同じ判断)。
 *
 * 単一引用符は YAML と bash で規則が違う: **YAML** は `''` を「エスケープされた1個の
 * `'`」として続きを同じ文字列の中で読む。**bash** の `'…'` にはエスケープが無く、
 * `'` が来た時点で閉じる(直後にまた `'` があれば、それは新しい単一引用符文字列の
 * 開始)。⟹ **`''` に出会ったとき、どちらの規則を採るべきかをこの実装は判定できない**
 * ——`status: "unhandled"` にする(黙ってどちらかを選ばない)。それ以外(`''` を含まない
 * 単一引用符)は bash の規則(次の `'` で閉じる)をそのまま使う——`run:` の中身が
 * この規則の主な行き先であるため。
 *
 * ## 扱えない形(黙って安全側へ倒さず、`unhandled` として報告する)
 *
 * - **同じ行で閉じない引用符**(複数行にまたがる YAML の折り返し文字列・bash の
 *   構文として非対称な引用符)。
 * - **ヒアドキュメント**(`<<EOF` / `<<'EOF'` / `<<-EOF`)。ヒアドキュメントの本体は
 *   bash がそのまま(コメントとして解釈せずに)読むテキストであり、`#` を含んでいても
 *   コメントではない——この実装はヒアドキュメントの構造を追わず、開始行を検出したら
 *   本体ごと `unhandled` にする(本体を勝手に「コメントとして潰さない」ことは保証するが、
 *   「潰すべきではない #106 のような行を誤って潰していないか」は確認していない、という
 *   意味で保守的に unhandled とする)。
 * - **`''`(単一引用符の中で単一引用符が連続する)**——上記のとおり YAML と bash で
 *   規則が違うため判定できない。
 *
 * 🔴 **呼び出し側はこれを無視できない API にすること。**`blankOutWorkflowComments` は
 * `{ text, unhandled }` を返す。`unhandled` が空でなければ、それを見なかったことに
 * せず、呼び出し側の歯が `expect(unhandled).toEqual([])` のような形で赤くなること
 * (`ci-yml-postgres-regime-wiring.test.mjs` / `ci-yml-postgres-regime-coverage-wiring
 * .test.mjs` の配線を見ること)。
 *
 * ⭐ **この関数の契約(`blankOutComments` と同じ):**
 * - 1文字を消費したら必ず1文字を出す(元のソースと添字が一致する)。
 * - 改行は必ず残す。
 * - 文字列(引用符)リテラルの中は潰さない。
 *
 * ⚠ **依存を足していない**(js-yaml 等)。`docs/autonomy.md` / ADR 0014・0061 で
 * 依存追加はオーナー専権——既存の wiring 歯・`workflow-name-comment-lib.mjs` と
 * 同じ判断。
 *
 * @param {string} text
 * @returns {{ text: string, unhandled: { lineNumber: number, reason: string, line: string }[] }}
 */
export function blankOutWorkflowComments(text) {
  const lines = text.split("\n");
  /** @type {{ lineNumber: number, reason: string, line: string }[]} */
  const unhandled = [];
  /** @type {string | undefined} 現在ヒアドキュメントの中かどうか。値は終端子(例: "EOF")。 */
  let heredocTerminator;

  const blankedLines = lines.map((line, index) => {
    const lineNumber = index + 1;

    if (heredocTerminator !== undefined) {
      // ヒアドキュメントの本体(またはその開始直後)。終端行が来るまで一切潰さない。
      if (line.trim() === heredocTerminator) {
        heredocTerminator = undefined;
      }
      return line;
    }

    const heredocMatch = /<<-?\s*(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|([A-Za-z_][A-Za-z0-9_]*))/.exec(
      line,
    );
    if (heredocMatch) {
      unhandled.push({
        lineNumber,
        reason: "heredoc-body-unhandled",
        line,
      });
      heredocTerminator = heredocMatch[1] ?? heredocMatch[2] ?? heredocMatch[3];
      // 開始行自体(`run: |` や `command <<EOF` の行)はコメント規則の対象にせず、
      // そのまま残す——ヒアドキュメント記法そのものを誤って潰さないため。
      return line;
    }

    return blankLineComment(line, lineNumber, unhandled);
  });

  if (heredocTerminator !== undefined) {
    unhandled.push({
      lineNumber: lines.length,
      reason: "heredoc-terminator-not-found",
      line: lines[lines.length - 1] ?? "",
    });
  }

  return { text: blankedLines.join("\n"), unhandled };
}

const COMMENT_START_WHITESPACE = new Set([" ", "\t"]);

/**
 * 1行分をコメント規則で潰す(改行を含まない1行のテキストを受け取る)。
 *
 * @param {string} line
 * @param {number} lineNumber
 * @param {{ lineNumber: number, reason: string, line: string }[]} unhandled 見つけた
 *   扱えない形をここへ積む(呼び出し側と共有する配列)。
 * @returns {string}
 */
function blankLineComment(line, lineNumber, unhandled) {
  /** @type {"code" | '"' | "'"} */
  let state = "code";
  let out = "";
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (state === "code") {
      if (ch === "#" && (i === 0 || COMMENT_START_WHITESPACE.has(line[i - 1]))) {
        // コメント開始。行末まで空白に潰す(改行はこの関数の外で保持される)。
        return out + " ".repeat(line.length - i);
      }
      if (ch === '"' || ch === "'") {
        state = ch;
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (state === '"') {
      if (ch === "\\" && i + 1 < line.length) {
        // `\"` は閉じ引用符ではない(bash / YAML どちらの二重引用符でも)。
        out += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"') {
        state = "code";
      }
      out += ch;
      i += 1;
      continue;
    }

    // state === "'"
    if (ch === "'") {
      if (line[i + 1] === "'") {
        // `''`: YAML は「エスケープされた1個の '(続く)」、bash は「閉じて即座に
        // 新しい単一引用符を開く(実質的には続く)」——どちらの規則を採るべきか
        // この実装は判定できない。黙って選ばず unhandled にする。
        unhandled.push({
          lineNumber,
          reason: "ambiguous-double-single-quote",
          line,
        });
        state = "code";
        out += ch;
        i += 1;
        continue;
      }
      state = "code";
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }

  if (state !== "code") {
    unhandled.push({
      lineNumber,
      reason: "quote-not-closed-on-same-line",
      line,
    });
    // 潰さず、元の行をそのまま返す(黙って安全側へ倒すのではなく、unhandled で
    // 名乗った上で、少なくとも実害(誤って潰す)を増やさない選択をする)。
    return line;
  }

  return out;
}

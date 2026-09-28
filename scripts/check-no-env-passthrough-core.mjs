/**
 * `check-no-env-passthrough.mjs` の判定だけを切り出したもの
 * （`check-tracked-nul-bytes-core.mjs` / `check-web-bundle-node-traces-core.mjs`
 * と同じ分け方 — 判定を CLI 側に置いたままだと、歯を試すには対象ファイルを
 * 実際に読む一式を毎回走らせるしかない。ここへ切り出せば、合成した文字列で
 * 判定だけを試せる）。
 *
 * ## 背景（Issue #1935、#1854 の再発防止）
 *
 * #1854 系の直し（子プロセスへ親の env を丸ごと渡さない。PR #1903 / #1905 /
 * #1916 / #1918 / #1925）は、どれも正しく入っている。ただし直しを直す前の形
 * （`{ ...process.env, … }` / `env: process.env`）へ戻しても、赤くなる歯が
 * 無かった（#1935 本文の実測1・実測2）。この検査は、その形が**テストのコード・
 * 変異試験ハーネス自身へ書き戻されたこと**を静的に検出する。
 *
 * ## 何を検査語に選んだか（最低限の3形。#1935 本文の受け入れ条件）
 *
 * 1. **`...process.env`**（スプレッドで丸ごと展開。オブジェクトリテラルの
 *    プロパティとしても、関数呼び出しの引数としても現れうる）
 * 2. **`env: process.env`**（プロパティ `env` の値に `process.env` を
 *    そのまま渡す。`process.env.FOO`（プロパティアクセス）は対象外 —
 *    `(?![\w.])` の否定先読みで区別する）
 * 3. **`Object.assign(…, process.env)`**（`Object.assign` の引数のどこかに
 *    裸の `process.env` が現れる形。合成先の1つとして丸ごと展開されるため
 *    1・2と同じ実害を持つ）
 *
 * **拾わない形（意図して測らない。#1854 本文が最初から明記している限界と
 * 同じ）**:
 *
 * - オプションを変数で組み立ててから渡す形（`const opts = buildOpts(); …
 *   execFileSync('git', args, opts)`）。`opts` の中身が `process.env` を
 *   丸ごと含むかどうかは、変数の定義元まで追わないと分からない —
 *   PR #1925 の本文が同じ限界を「(c) のうち `env` が shorthand（変数参照）
 *   だった13件は…個別に目で追って再分類した」と明記しているのと同じ形で、
 *   ここでは静的な正規表現走査の範囲外として扱う
 * - `env` プロパティの shorthand（`{ env }`。`env` という名前の変数を渡す形）
 *
 * **⚠️ 2026-09-28 追記（Issue #1971）: 「`spawn` 等が `env` オプションを一切
 * 指定しない形」は、かつてここで「この検査の対象外」と書いていたが、いまは
 * 対象に入っている。** env を指定しない呼び出しも、親の `process.env` を
 * 丸ごと継ぐ点で実害は同じである（#1854 の最後のコメントが「確かめていない
 * こと」として残していた在庫）。この**消極的な**形の検出は
 * `findMissingEnvChildProcessCalls` / `classifyChildProcessCallEnv`
 * （このファイルの後半）が持つ——上の3形（**積極的な**丸渡し）とは別の
 * 関数・別の ALLOWLIST（`ALLOWLIST_MISSING_ENV`）に分けてある。理由は
 * それぞれの doc コメントに書く。
 *
 * ## コメント・文字列の中は拾わない
 *
 * `usage-probe.test.ts` のように、この字面そのものを**説明する**コメントや
 * テストタイトルの文字列（例: `'env を渡すと { ...process.env, … } になる'`）
 * を持つファイルが実在する。素朴な正規表現走査だとこれらへ誤爆する
 * （逐語の解説文をコードだと誤認する）。**対策は `maskCommentsAndStrings`
 * で行コメント・ブロックコメント・文字列リテラル・テンプレートリテラル
 * （`${…}` の中はコードとして再度走査するよう、深さを数えて元へ戻す）・
 * 正規表現リテラルを、同じ長さの空白（改行は残す——行番号がずれないように
 * するため）へ置き換えてから走査すること**（PR #1925 が同じ理由で
 * `.scratch/mask.mjs` を書いたのと同じ考え方——あちらは子プロセス呼び出し
 * の在庫を数えるための一時スクリプトだったが、ここでは検査本体として
 * 常設する）。
 *
 * ⚠️ **正規表現リテラルの判定はヒューリスティックである。** 直前の非空白
 * トークンが演算子・区切り記号・特定のキーワードなら `/` を正規表現の
 * 開始とみなす（一般的な JS トークナイザの簡易近似）。この repo の対象
 * ファイル（テスト・変異試験ハーネス）を実測した限り、`process.env` を
 * 含む正規表現リテラルは1つも無い（`command grep` で確認済み——このファイル
 * 末尾の実データ検査がその前提のまま緑であることを毎回確かめ直す）。
 *
 * ## 許可の一覧（ALLOWLIST）
 *
 * わざと残す箇所は、ファイルと理由つきで一覧に載せる（`check-scripts-wired.test.ts`
 * の `EXEMPT` と同じ登録制）。**ファイル単位の粒度にした**——この検査の対象は
 * どれも「そのファイル全体が、親の env を丸ごと引き継ぐことを前提にした
 * 少数の歯」であり、同じファイルの中に許可すべき箇所と許可すべきでない
 * 箇所が混在する実例はいまのところ無い（下の実データ検査が示す4件は、
 * いずれも該当パターンがそのファイルに1箇所しか無い）。混在が実際に
 * 出てきたら、そのときにこの粒度を見直す。
 *
 * **古い許可が残らない**——`classifyEnvPassthroughHits` は、ALLOWLIST に
 * 載っているのに実際には1件も検出されないパス（＝直してしまって、もう
 * 許可が要らなくなった）を `stale` として返す。CLI 側はこれも失敗として
 * 扱う——許可の一覧に嘘が残ると、次に本当に別の理由で同じファイルへ
 * 丸渡しが増えても、この検査は「許可済み」として素通りしてしまう
 * （`check-scripts-wired.test.ts` の `EXEMPT` が「消えた門の宣言を残さない」
 * ことを歯にしているのと同じ理由）。
 */

import { listGitScannableFiles } from './git-scannable-files-core.mjs';

/**
 * コメント・文字列リテラル・テンプレートリテラル・正規表現リテラルを、
 * 同じ長さの空白（改行は保つ）へ置き換える。**行番号を保つため、置換後も
 * 文字数・改行位置は変えない**——`findEnvPassthroughHits` が返す行番号を、
 * 元のファイルの行番号とそのまま対応させるためである。
 *
 * テンプレートリテラルの `${…}` の中は**コードとして再走査する**
 * （`consumeTemplateExprBody` が `dispatchOne` を再帰的に呼ぶ——式の中に
 * ある `{}`（オブジェクトリテラル等）と、式そのものを閉じる `}` は深さで
 * 区別する）。この再帰は `${…}` の中にネストしたテンプレートリテラル
 * （`` `${`${x}`}` ``）も正しく処理する——内側のテンプレートも
 * `dispatchOne` 経由で同じ関数が呼ばれるため。
 */
export function maskCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;

  const isRegexContext = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    const c = out[j];
    if ('([{,;:=&|!?+-*%^~<>'.includes(c)) return true;
    const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(out.slice(0, j + 1));
    if (
      word &&
      [
        'return',
        'typeof',
        'instanceof',
        'in',
        'of',
        'new',
        'delete',
        'void',
        'throw',
        'case',
        'do',
        'else',
        'yield',
        'await',
      ].includes(word[0])
    ) {
      return true;
    }
    return false;
  };

  /** 空白以外を空白へ置き換える。改行は残す（行番号を保つため）。 */
  const blank = (text) => text.replace(/[^\n]/g, ' ');

  function consumeLineComment() {
    let j = i;
    while (j < n && source[j] !== '\n') j++;
    out += blank(source.slice(i, j));
    i = j;
  }

  function consumeBlockComment() {
    let j = i + 2;
    while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
    j = Math.min(j + 2, n);
    out += blank(source.slice(i, j));
    i = j;
  }

  function consumeQuotedString(quote) {
    let j = i + 1;
    while (j < n && source[j] !== quote) {
      if (source[j] === '\\') j += 2;
      else j++;
    }
    j = Math.min(j + 1, n);
    out += blank(source.slice(i, j));
    i = j;
  }

  function consumeRegexLiteral() {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      if (source[j] === '\\') {
        j += 2;
        continue;
      }
      if (source[j] === '[') {
        inClass = true;
      } else if (source[j] === ']') {
        inClass = false;
      } else if (source[j] === '/' && !inClass) {
        j++;
        break;
      } else if (source[j] === '\n') {
        break; // 正規表現リテラルは改行を跨がない —— これは正規表現ではなかった（保険）
      }
      j++;
    }
    out += blank(source.slice(i, j));
    i = j;
  }

  /**
   * いま `i` に居る1文字が、コメント・文字列・テンプレートリテラル・
   * 正規表現リテラルの開始であれば消費して `true` を返す。そうでなければ
   * 何もせず `false` を返す（呼び出し側が「普通のコード文字」として1文字
   * そのまま出力する）。
   */
  function dispatchOne() {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      consumeLineComment();
      return true;
    }
    if (c === '/' && c2 === '*') {
      consumeBlockComment();
      return true;
    }
    if (c === "'" || c === '"') {
      consumeQuotedString(c);
      return true;
    }
    if (c === '`') {
      consumeTemplateLiteral();
      return true;
    }
    if (c === '/' && isRegexContext()) {
      consumeRegexLiteral();
      return true;
    }
    return false;
  }

  /**
   * テンプレートリテラルの `${…}` の中身は、地の文とは違って**コードとして
   * 再走査する**（`dispatchOne` を再帰的に呼ぶ）。閉じ括弧は深さで数える
   * ——式の中の `{}`（オブジェクトリテラルやブロック）と、式そのものを
   * 閉じる `}` を区別するため。
   */
  function consumeTemplateExprBody() {
    let depth = 0;
    while (i < n) {
      if (dispatchOne()) continue;
      const c = source[i];
      if (c === '{') {
        depth++;
        out += c;
        i++;
        continue;
      }
      if (c === '}') {
        if (depth === 0) {
          out += '}';
          i++;
          return;
        }
        depth--;
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
    }
  }

  function consumeTemplateLiteral() {
    // `i` は開始の backtick を指している。
    out += ' ';
    i++;
    while (i < n) {
      if (source[i] === '\\') {
        out += blank(source.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (source[i] === '`') {
        out += ' ';
        i++;
        return;
      }
      if (source[i] === '$' && source[i + 1] === '{') {
        out += '${';
        i += 2;
        consumeTemplateExprBody();
        continue;
      }
      out += source[i] === '\n' ? '\n' : ' ';
      i++;
    }
  }

  while (i < n) {
    if (dispatchOne()) continue;
    out += source[i];
    i++;
  }
  return out;
}

/** 検出する3形。`describe` は CLI の出力に使う。 */
export const PATTERNS = [
  {
    id: 'spread-process-env',
    re: /\.\.\.\s*process\.env\b/g,
    describe: '`...process.env`（スプレッドで丸ごと展開）',
  },
  {
    id: 'env-direct-process-env',
    re: /\benv\s*:\s*process\.env(?![\w.])/g,
    describe: '`env: process.env`（丸ごとそのまま渡す）',
  },
  {
    id: 'object-assign-process-env',
    re: /Object\.assign\([^)]*\bprocess\.env(?![\w.])[^)]*\)/g,
    describe: '`Object.assign(…, process.env)`（丸ごと合成）',
  },
];

/**
 * `files`（`{ path, content }` の配列）を走査し、丸渡しの形が見つかった箇所を
 * 返す。1箇所につき1件（同じ行に複数当たれば複数件）。
 */
export function findEnvPassthroughHits(files) {
  const hits = [];
  for (const file of files) {
    const masked = maskCommentsAndStrings(file.content);
    const rawLines = file.content.split('\n');
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let m;
      while ((m = pattern.re.exec(masked))) {
        const line = masked.slice(0, m.index).split('\n').length;
        hits.push({
          path: file.path,
          line,
          kind: pattern.id,
          describe: pattern.describe,
          snippet: (rawLines[line - 1] ?? '').trim(),
        });
        if (m[0].length === 0) pattern.re.lastIndex += 1; // 無限ループ対策（この3形では起きない）
      }
    }
  }
  return hits;
}

/**
 * わざと残す箇所（ファイル単位）。**`why` は非空でなければならない**
 * （`classifyEnvPassthroughHits` の呼び出し側 = CLI がこれを見る）。
 *
 * ⛔ **ここへ足すときは、実際にそのファイルへ当たりが在ることを
 * `findEnvPassthroughHits` で確かめてから足すこと。** 当たりが無いのに
 * 載せると、`classifyEnvPassthroughHits` の `stale` に載って CLI が失敗する
 * （このファイルの単体テストが同じことを合成データで確かめる）。
 */
export const ALLOWLIST = [
  {
    path: '.github/scripts/update-claude-sdk.test.ts',
    reason:
      '`gitIsolatedEnv()` — git の identity（`GIT_AUTHOR_*` / `GIT_COMMITTER_*`）の' +
      '優先順位を測る歯で、親の env を丸ごと受け継ぐこと自体が前提になっている' +
      '（4つの identity 系の鍵だけを落とし、残りはそのまま通す設計）。' +
      'Issue #1854 の領域 D マネージャーコメント（2026-09-28T02:09:06Z）で' +
      '「直さないと決めたもの」として明示されている。',
  },
  {
    path: 'apps/daemon/src/runner-client.test.ts',
    reason:
      '別担当の領域。Issue #1854 の同コメントが「別担当の領域なので触っていないもの」' +
      'として明示している。この PR（#1935）ではこのファイルを書き換えない。',
  },
  {
    path: 'vitest.env-scrub.test.ts',
    reason:
      '別担当の領域。Issue #1854 の同コメントが「別担当の領域なので触っていないもの」' +
      'として明示している。この PR（#1935）ではこのファイルを書き換えない。',
  },
];

/**
 * `hits` と `allowlist` を突き合わせ、`{ violations, stale }` を返す。
 *
 * - `violations`: `allowlist` に載っていないパスで見つかった当たり
 * - `stale`: `allowlist` に載っているのに、実際には1件も当たりが無い
 *   エントリ（古い許可——直してしまって要らなくなった許可を、載せたまま
 *   にしない）
 */
export function classifyEnvPassthroughHits(hits, allowlist) {
  const allowedPaths = new Set(allowlist.map((e) => e.path));
  const violations = hits.filter((h) => !allowedPaths.has(h.path));
  const hitPaths = new Set(hits.map((h) => h.path));
  const stale = allowlist.filter((e) => !hitPaths.has(e.path));
  return { violations, stale };
}

/**
 * ## Issue #1971 — env を指定しない子プロセス呼び出しも同じ漏れである
 *
 * 上の3形（`findEnvPassthroughHits`）が拾うのは「親の env を**積極的に**
 * 丸ごと渡す形」だけである。だが Node は、`spawn` / `spawnSync` / `execFile` /
 * `execFileSync` / `exec` / `execSync` / `fork` の呼び出しで `env` オプション
 * を**指定しない**（オプションそのものを渡さない場合を含む）と、**既定で**
 * 親の `process.env` を丸ごと子へ渡す。これは書き手が明示していないだけで、
 * 実害は `...process.env` を書いたときと同じである（#1854 / #1935 が最初から
 * 「確かめていないこと」として明記していた在庫）。
 *
 * ### 何を検査語に選んだか
 *
 * `node:child_process` から直接 import された次の7つの関数名の呼び出し、
 * および `promisify(<いずれか>)` で作られた別名経由の呼び出し
 * （`const run = promisify(execFile); run(...)`。実在する形——
 * `packages/core/src/child-src.test-support.ts` 等）:
 *
 * `spawn` / `spawnSync` / `execFile` / `execFileSync` / `exec` / `execSync` / `fork`
 *
 * ### 呼び出しの形をどう分類するか（`classifyChildProcessCallEnv`）
 *
 * 第1引数（command / file / modulePath）を除いた残りの引数から、末尾の
 * インラインコールバック（`=>` を含む、または `function` で始まる）を
 * 1つだけ剥がし、残った引数列の**最後**を「options 候補」として見る:
 *
 * - **候補が無い**（引数が command だけ、または args 配列だけで options が
 *   無い）→ `missing-env`（違反）
 * - **候補がオブジェクトリテラル**（`{` で始まる）→ トップレベルの
 *   プロパティを見る。`env` キー（`env: …` または shorthand `{ env }`）が
 *   在れば `has-env`。無く、`...spread` が在れば `undeterminable`
 *   （spread 先の変数が `env` を持つかどうかは静的に分からない）。
 *   どちらも無ければ `missing-env`（違反）
 * - **候補が配列リテラル**（`spawn(cmd, args)` の2引数形で、`args` が
 *   `[...]` そのもの）→ それは args 配列であって options ではない
 *   ＝ options が無い → `missing-env`（違反）
 * - **候補が識別子・式**（変数で組み立てて渡す形。`spawn(cmd, opts)` の
 *   `opts` が変数）→ **`undeterminable`**（判定できない。#1971 の依頼文の
 *   「オプションを変数で渡す形は判定できないとして別に数える」に対応する
 *   3つ目の状態。赤にも緑にも倒さない——`findMissingEnvChildProcessCalls`
 *   はこの分類を返さず、`missing-env` だけを違反として返す）
 *
 * **この分類はヒューリスティックである**（`maskCommentsAndStrings` と同じ
 * 「正規表現ベースの近似」の限界を継ぐ）。実データでの検証（在庫が0件へ
 * 収束したこと）は Issue #1971 の PR 本文に生出力で書く。
 *
 * ### 拾わない形（意図した限界）
 *
 * - **完全な型のコールバック解析はしない**——「末尾が `=>` を含む、または
 *   `function` で始まる」という表面的なパターンでのみ剥がす。名前付き関数
 *   （`spawn(cmd, args, onExit)` のように変数で渡すコールバック）は
 *   `undeterminable` 側へ落ちる（安全側——見落として `missing-env` を
 *   見逃すより、判定を諦めるほうが良い）
 * - **`node:child_process` を `import * as` や `require` で読み込む形**は
 *   対象外（実データを走査した限り、この repo の対象ファイルはすべて
 *   named import — `import { execFileSync } from 'node:child_process'` —
 *   のみを使っている。#1971 の PR 本文の数え上げが根拠）
 */
const CHILD_PROCESS_CALL_NAMES = [
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
  'fork',
];

/** args 配列を第2引数に取りうる関数（options は3番目以降に来る）。 */
const ARGS_ARRAY_FAMILY = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']);

/**
 * `text` を、深さ0（トップレベル）のカンマで分割する。`(` `[` `{` で深さを
 * 上げ、対応する閉じ括弧で下げる——引数の中にネストした呼び出しやオブジェクト
 * リテラルがあっても、そこで誤って分割しない。呼び出し側は `maskCommentsAndStrings`
 * 済みのテキストを渡す前提（文字列・コメントの中の括弧に惑わされないため）。
 */
function splitTopLevelByComma(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim().length > 0 || parts.length > 0) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** `text` 中の `openIdx`（`(` の位置）に対応する閉じ `)` の直後の index を返す。 */
function findMatchingParenEnd(text, openIdx) {
  let depth = 1;
  let j = openIdx + 1;
  while (j < text.length && depth > 0) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')') depth--;
    j++;
  }
  return j;
}

/**
 * オブジェクトリテラル（外側の `{` `}` を含むテキスト）のトップレベルの
 * プロパティを見て、`env` キーの有無・spread の有無を判定する。
 */
function classifyOptionsObjectLiteral(objText) {
  const inner = objText.slice(1, -1);
  const segments = splitTopLevelByComma(inner);
  let hasEnvKey = false;
  let hasSpread = false;
  for (const seg of segments) {
    if (seg.startsWith('...')) {
      hasSpread = true;
      continue;
    }
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(seg) ?? /^([A-Za-z_$][\w$]*)$/.exec(seg);
    if (m && m[1] === 'env') hasEnvKey = true;
  }
  if (hasEnvKey) return 'has-env';
  if (hasSpread) return 'undeterminable';
  return 'missing-env';
}

/**
 * `kind`（`CHILD_PROCESS_CALL_NAMES` のいずれか。`promisify` の別名は解決後の
 * 元の名前を渡す）と、呼び出しの引数列（`args[0]` が command/file/modulePath）
 * から、`'has-env' | 'missing-env' | 'undeterminable'` のいずれかを返す。
 * 分類の考え方は上の doc コメントを見よ。
 */
export function classifyChildProcessCallEnv(kind, args) {
  let rest = args.slice(1);
  if (rest.length > 0) {
    const last = rest[rest.length - 1];
    if (/=>/.test(last) || /^(async\s+)?function\b/.test(last)) {
      rest = rest.slice(0, -1);
    }
  }

  if (!ARGS_ARRAY_FAMILY.has(kind)) {
    // exec / execSync: (command, options?, callback?) —— args 配列を取らない。
    if (rest.length === 0) return 'missing-env';
    const candidate = rest[rest.length - 1];
    if (candidate.startsWith('{')) return classifyOptionsObjectLiteral(candidate);
    return 'undeterminable';
  }

  // spawn/spawnSync/execFile/execFileSync/fork: (cmd, args?, options?)
  if (rest.length === 0) return 'missing-env';
  if (rest.length === 1) {
    const candidate = rest[0];
    if (candidate.startsWith('[')) return 'missing-env'; // args 配列のみ。options は無い
    if (candidate.startsWith('{')) return classifyOptionsObjectLiteral(candidate);
    return 'undeterminable'; // args 配列か options か、変数からは判定できない
  }
  const candidate = rest[rest.length - 1];
  if (candidate.startsWith('{')) return classifyOptionsObjectLiteral(candidate);
  return 'undeterminable';
}

/**
 * `rawContent`（マスク前。import 文のモジュール指定子の判定に要る）から、
 * `node:child_process` / `child_process` の named import で読み込まれた
 * 関数名の集合を返す。
 */
function findImportedChildProcessNames(rawContent) {
  const importedNames = new Set();
  const importRe = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/gm;
  let m;
  while ((m = importRe.exec(rawContent))) {
    for (const part of m[1].split(',')) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && CHILD_PROCESS_CALL_NAMES.includes(name)) importedNames.add(name);
    }
  }
  return importedNames;
}

/**
 * `maskedContent`（マスク済み）から `const NAME = promisify(FUNC)` の形を
 * 探し、`importedNames` に実在する `FUNC` へのエイリアスだけを返す
 * （`NAME -> FUNC` の Map）。
 */
function findPromisifyAliases(maskedContent, importedNames) {
  const aliasMap = new Map();
  const promisifyRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*promisify\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  let m;
  while ((m = promisifyRe.exec(maskedContent))) {
    const [, aliasName, funcName] = m;
    if (importedNames.has(funcName)) aliasMap.set(aliasName, funcName);
  }
  return aliasMap;
}

/**
 * `files`（`{ path, content }` の配列）を走査し、env オプションを指定して
 * いない子プロセス呼び出し（`missing-env` に分類されたもの）を返す。
 * 返り値の形は `findEnvPassthroughHits` と揃えてある（`path` / `line` /
 * `kind` / `describe` / `snippet`）ので、そのまま `classifyEnvPassthroughHits`
 * に渡せる。
 *
 * `undeterminable`（オプションを変数で渡していて判定できない形）は、ここ
 * では violations にも stale にも数えない——3つ目の状態として黙って落とす
 * （上の doc コメントの「拾わない形」と同じ考え方）。
 */
export function findMissingEnvChildProcessCalls(files) {
  const hits = [];
  for (const file of files) {
    const masked = maskCommentsAndStrings(file.content);
    const importedNames = findImportedChildProcessNames(file.content);
    if (importedNames.size === 0) continue;

    const aliasMap = findPromisifyAliases(masked, importedNames);
    const callNameToKind = new Map();
    for (const name of importedNames) callNameToKind.set(name, name);
    for (const [alias, func] of aliasMap) callNameToKind.set(alias, func);

    const rawLines = file.content.split('\n');
    for (const [callName, kind] of callNameToKind) {
      const callRe = new RegExp(`(?<![\\w.$])${callName}\\s*\\(`, 'g');
      let cm;
      while ((cm = callRe.exec(masked))) {
        const openIdx = cm.index + cm[0].length - 1;
        const closeIdxAfter = findMatchingParenEnd(masked, openIdx);
        const argsText = masked.slice(openIdx + 1, closeIdxAfter - 1);
        const args = splitTopLevelByComma(argsText);
        const classification = classifyChildProcessCallEnv(kind, args);
        if (classification !== 'missing-env') continue;
        const line = masked.slice(0, cm.index).split('\n').length;
        hits.push({
          path: file.path,
          line,
          kind: 'missing-env-child-process',
          describe:
            `\`${callName}(...)\`（\`${kind}\` 系。env オプションを指定していない —— ` +
            '親の process.env を丸ごと継承する）',
          snippet: (rawLines[line - 1] ?? '').trim(),
        });
      }
    }
  }
  return hits;
}

/**
 * わざと残す箇所（ファイル単位）。`findMissingEnvChildProcessCalls` が返す
 * 「env オプションを指定していない」形専用の許可の一覧——上の `ALLOWLIST`
 * （`...process.env` 等、積極的な丸渡し）とは別の一覧にしてある。理由:
 * 同じファイルが両方の形を含みうる（例: 一部の呼び出しは `env:
 * gitChildEnv()` で直しつつ、別の呼び出しはまだ env 無しのままにする、と
 * いう混在が実際にありうる）ため、1つの一覧に混ぜると「片方の形だけ許可
 * したい」を表現できない。
 *
 * ⛔ ここへ足すときは、実際にそのファイルへ `missing-env` の当たりが在る
 * ことを `findMissingEnvChildProcessCalls` で確かめてから足すこと。
 *
 * **2026-09-28（Issue #1971 段2）: `.claude/skills/mutation-testing/mutate-core.mjs` /
 * `mutate-selftest.mjs` の12件は、段1（PR #1973）で「未着手」として載せた
 * ものをここで直したので、この一覧からは外れている。** 直した内容・実測は
 * 両ファイルの `GIT_READONLY_CHILD_ENV` / `PNPM_HARNESS_CHILD_ENV` /
 * `MUTATE_SELFTEST_CHILD_ENV` の doc コメントと、この Issue の段2 PR 本文を見よ。
 */
export const ALLOWLIST_MISSING_ENV = [];

/**
 * 走査対象を判定する。
 *
 * - `*.test.ts` / `*.test.tsx`
 * - `*.test-support.ts` / `*.test-support.tsx`（テスト専用の補助モジュール。
 *   ファイル名の末尾がこの形のもの）
 * - `test-support.ts` / `test-support.tsx`（末尾に `.test-support.` を
 *   持たず、ファイル名そのものが `test-support` のもの。この repo には
 *   両方の命名が実在する——`apps/cli/src/test-support.ts` と
 *   `packages/core/src/git-child-env.test-support.ts` のように）
 * - `.claude/skills/mutation-testing/` 直下の `*.mjs`（`mutate.mjs` /
 *   `mutate-core.mjs` / `mutate-selftest.mjs`。サブディレクトリは無いが、
 *   将来増えても直下だけを対象にする——このハーネスは「依存なし・ビルド
 *   不要」の約束で同じディレクトリの素の `import` だけを使う設計なので、
 *   直下だけを見れば足りる）
 */
export function isTargetPath(relPath) {
  const MUTATION_TESTING_DIR = '.claude/skills/mutation-testing/';
  if (relPath.startsWith(MUTATION_TESTING_DIR) && relPath.endsWith('.mjs')) {
    const rest = relPath.slice(MUTATION_TESTING_DIR.length);
    return !rest.includes('/');
  }
  const base = relPath.split('/').pop() ?? '';
  if (/\.test\.tsx?$/.test(base)) return true;
  if (/\.test-support\.tsx?$/.test(base)) return true;
  if (/^test-support\.tsx?$/.test(base)) return true;
  return false;
}

/**
 * 追跡済み + 未追跡だが ignore されていないファイル（`git-scannable-files-core.mjs`、
 * Issue #1817 と同じ理由——新規ファイルを見落とさない）のうち、`isTargetPath` に
 * 一致するものだけを返す。
 */
export function listTargetFiles(root) {
  return listGitScannableFiles({ cwd: root }).filter(isTargetPath);
}

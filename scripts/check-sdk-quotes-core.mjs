/**
 * **同梱の SDK から逐語で引いたコメントが、いまの版でも逐語であることを機械で当てる。**
 *
 * ## 何を直そうとしているか
 *
 * この repo は `@anthropic-ai/claude-agent-sdk` 同梱の `sdk.d.ts` の JSDoc を、
 * 判断の根拠としてコメントへ逐語で引き写している。**引き写した先はソースなので、
 * SDK の版を上げても差分には出ない。** 実際 #639（0.3.259 → 0.3.261）は
 * 「lock と catalog の2ファイルだけ。ソースに触れていない」ことを確かめて
 * マージされたが、`agent-events.ts` の `ambient` の逐語は同じ更新で嘘になった。
 *
 * **ソースに触れていないことは、ソース中の記述が真であり続けることを意味しない。**
 * 引用は外の版に依存しており、依存はコンパイラにもレビューにも見えない。
 *
 * ## だから印を付けて、毎回当て直す
 *
 * 逐語を引いた行に `[sdk-verbatim <シンボル>]` の印を付ける。この検査は印の付いた
 * 引用を全部集め、**インストール済みの `sdk.d.ts` に対して素の部分文字列一致
 * （`grep -F` と同じ意味）が通ることを確かめる。** 通らなくなった瞬間に赤くなる。
 *
 * **版番号は印に書かない。** 書くと版を上げるたびに全部の印を書き直す必要が生まれ、
 * しかもその書き直しは「本当に文言が同じか」を確かめずに機械的にできてしまう
 * （＝門が形骸化する）。**当てるのは文言そのもの**であり、周りの日本語に書いてある
 * 「version 0.3.261 同梱」は人間向けの但し書きである。**この但し書きが腐っても
 * 害が無いのは、文言のほうを毎回機械が当て直しているからである。**
 *
 * ## 印の書き方（2つの形を受ける）
 *
 * 既存のコメントは2つの形で引用を持っており、どちらも壊さずに印を付けられる:
 *
 * 1. **同じ行に鉤括弧**（日本語の文中に埋め込んである形）
 *    `... の欄も逐語で引く: 「True for tasks that are not activity ...」 [sdk-verbatim ambient]`
 *    → 印の在る行に `「` と `」` が在れば、**最初の `「` から最後の `」` まで**を引用とする
 *
 * 2. **次の行にブロック引用**（JSDoc の `> ` の形）
 *    ```
 *    * [sdk-verbatim SDKBackgroundTasksChangedMessage]
 *    * > consumers that only need 'is background work running' should replace ...
 *    ```
 *    → 印の行に鉤括弧が無ければ、**次の1行**からコメント記号と `> ` を剥いだものを引用とする
 *
 * **⚠️ 引用は1行に収めること。** JSDoc の折り返しに跨った引用は `grep -F` で当たらない
 * （`sdk.d.ts` 側は JSDoc 1つが1行なので、こちら側で改行を入れた時点で一致しない）。
 * **当たらない引用は、無い引用より悪い** — 根拠が在るように見えるからである。
 * `printWidth: 100` を超えるが、prettier はコメントを折り返さないので問題にならない。
 *
 * ## シンボルも当てる
 *
 * 印は `[sdk-verbatim <シンボル>]` の形で、**どの型／欄から引いたか**を必ず名乗らせる。
 * シンボルは `.` で分けた各要素が `sdk.d.ts` に部分文字列として在ることを確かめる。
 * 文言が変わらないまま型が消えた・改名された場合はこちらが先に落ちる。
 *
 * ## この検査が言えないこと（範囲を広げて読まないこと）
 *
 * - **印の付いていない引用は見ていない。** 網羅は人の側の作法に残っている。
 *   この検査は「印を付けた引用が腐らない」ことしか保証しない
 * - **意図して古い版を引いている引用（新旧の対比）には印を付けない。**
 *   あれは「いまの版と違う」ことに意味が在る記述で、当たらないのが正しい
 * - **日本語の説明が引用と整合しているかは見ていない。** 文言が同じでも意味の取り違えは残る
 * - **⚠️ 「その欄が無い」という否定の主張は、原理的にこの門では書けない。**
 *   当て方は `sdkTypesText.includes(quote)` の**部分文字列一致**なので、言えるのは
 *   「この文言が在る」だけである。**「`SDKPermissionDeniedMessage` に `agent_type`
 *   は無い」のような不在の主張は、印を付けようにも当てる文言が存在しない。**
 *   紛らわしいのは、この門が「シンボルが**消えた**」は落とせることである
 *   （上の `missingSegment`）——**あれは「印を付けた引用の裏が取れなくなった」で
 *   あって、「ある欄が SDK に存在しない」の証明ではない。**
 *
 *   **⟹ 不在を守りたいなら、門を足すのではなく型の歯を置くこと。**
 *   `permission-denied.test.ts` の `HasKey<T, K>` が既にその形で、
 *   欄が生えた瞬間に `pnpm typecheck` が落ちる（`describe('SDK の型の前提
 *   （腐ったら typecheck が落ちる）')`）。**この門を「不在も見ている」と読んで、
 *   型の歯を省かないこと。**
 */

/**
 * 印の語。`grep -rn "[sdk-verbatim"` で全部引ける。
 *
 * **`@` で始めない。** JSDoc の中で `@foo` を書くとそこからがタグの本文になり、
 * **その後ろに続く日本語の説明が本文（description）から外れる。** この repo は
 * doc コメントそのものが資産なので、印を足すために doc の見え方を壊さない形を選んだ。
 * 角括弧で開くのは、印そのものについて書いた散文（`` `sdk-verbatim` `` のような
 * 言及）を引用として拾わないためである。
 */
export const MARKER = '[sdk-verbatim';

/**
 * 印とシンボルを取る。シンボルは `Foo` / `Foo.bar` / `Foo.bar.baz` の形だけ受ける。
 * 印だけ書いてシンボルを省いた場合も**当てて落とす**ために、印そのものは別に探す。
 */
const MARKER_WITH_SYMBOL = /\[sdk-verbatim[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*\]/;

/** 走査するファイルの拡張子。 */
export const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.md'];

/**
 * 走査から外すパス（前方一致）。**この検査自身**は、doc と試験の中に印の文字列を
 * 素で持っているので外す（外さないと自分の説明文を引用として当てにいく）。
 */
export const EXCLUDED_PREFIXES = ['scripts/check-sdk-quotes'];

/** 行頭のコメント記号と、行末の閉じ記号を剥ぐ。 */
function stripCommentLeader(line) {
  return line
    .replace(/^[ \t]*(?:\/\/+|\/\*+|\*+|#+|<!--)[ \t]?/, '')
    .replace(/[ \t]*(?:\*\/|-->)[ \t]*$/, '')
    .trim();
}

/** ブロック引用の `> ` と、外側の鉤括弧を剥ぐ。 */
function stripQuoteDecoration(text) {
  let out = text.replace(/^>[ \t]?/, '').trim();
  if (out.startsWith('「') && out.endsWith('」')) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * 印の行より後ろから、最初の「中身の在る行」を引用として取る。
 *
 * **空行を飛ばすのは Markdown のためである。** `.md` ではブロック引用の前に
 * 空行が要る（空けないと直前の段落に吸われる）ので、印と引用を隣接させられない。
 * JSDoc 側でも ` * ` だけの行を挟むほうが読みやすい。**飛ばす幅は狭く取る**
 * （`LOOKAHEAD` 行まで）— 広く取ると、引用を書き忘れた印が「たまたま後ろに在った
 * 英文」を拾って**当たってしまう**（＝ 印が守っていないのに緑になる）。
 */
const LOOKAHEAD = 3;

function nextQuoteLine(lines, markerIndex) {
  for (let j = markerIndex + 1; j < lines.length && j <= markerIndex + LOOKAHEAD; j += 1) {
    const text = stripQuoteDecoration(stripCommentLeader(lines[j]));
    if (text.length > 0) return text;
  }
  return '';
}

/** 行の中の `「…」`（最初の `「` から最後の `」` まで）を取る。無ければ null。 */
function bracketedSpan(line) {
  const start = line.indexOf('「');
  const end = line.lastIndexOf('」');
  if (start === -1 || end === -1 || end <= start + 1) return null;
  return line.slice(start + 1, end).trim();
}

/**
 * 印の付いた引用を集める。
 *
 * `files` は `{ path, content }` の配列。返すのは `{ path, line, symbol, quote, defect }`
 * の配列で、`defect` は集める段階で分かる欠陥（`'missing-symbol'` / `'empty-quote'`）。
 * **欠陥の在る印も落とさずに返す** — 黙って読み飛ばすと「印を書いたのに検査されない」が
 * 静かに起きるためである。
 */
export function collectMarkedQuotes(files) {
  const found = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      if (!raw.includes(MARKER)) continue;

      const at = { path: file.path, line: i + 1 };
      const symbolMatch = MARKER_WITH_SYMBOL.exec(raw);
      if (!symbolMatch) {
        found.push({ ...at, symbol: null, quote: null, defect: 'missing-symbol' });
        continue;
      }
      const symbol = symbolMatch[1];

      // 形1: 同じ行の鉤括弧。形2: 印より後ろの、最初の中身の在る行。
      const sameLine = bracketedSpan(raw);
      const quote = sameLine !== null ? sameLine : nextQuoteLine(lines, i);

      if (quote.length === 0) {
        found.push({ ...at, symbol, quote: null, defect: 'empty-quote' });
        continue;
      }
      found.push({ ...at, symbol, quote, defect: null });
    }
  }
  return found;
}

/**
 * 集めた引用を `sdk.d.ts` の本文へ当てる。返すのは**落ちた分だけ**の配列。
 *
 * 当て方は素の `String.includes`（＝ `grep -F`）である。正規化しない。
 * **正規化を入れると「当たったことにする」余地が生まれ、`grep -Fn` で確かめられる
 * という repo の作法（引用の検算方法そのもの）と食い違う。**
 */
export function findQuoteDefects(quotes, sdkTypesText) {
  const defects = [];
  for (const q of quotes) {
    if (q.defect === 'missing-symbol') {
      defects.push({
        ...q,
        reason: 'sdk-verbatim の印にシンボルが付いていない（例: [sdk-verbatim Options.env]）',
      });
      continue;
    }
    if (q.defect === 'empty-quote') {
      defects.push({
        ...q,
        reason: '印は在るが引用が取れない（同じ行の「…」か、次の行に1行で書く）',
      });
      continue;
    }
    const missingSegment = q.symbol.split('.').find((seg) => !sdkTypesText.includes(seg));
    if (missingSegment !== undefined) {
      defects.push({
        ...q,
        reason: `シンボル \`${q.symbol}\` の \`${missingSegment}\` が sdk.d.ts に無い（型が消えたか改名された）`,
      });
      continue;
    }
    if (!sdkTypesText.includes(q.quote)) {
      defects.push({
        ...q,
        reason: '逐語が sdk.d.ts に当たらない（文言が変わったか、折り返しが混ざっている）',
      });
    }
  }
  return defects;
}

/**
 * 走査対象のファイルを集める（`git ls-files` が挙げる追跡ファイルだけ）。
 *
 * **追跡ファイルに限るのは意図である。** 未追跡のファイルは PR に載らないので、
 * そこで印が腐っても誰も踏まない。逆に `node_modules` を除く仕掛けが要らなくなる。
 */
export function listScannableFiles(repoRoot, execFileSync, readFileSync) {
  // `-s` はモードを頭に付けて出す（`100644 <sha> 0\t<path>`）。**symlink（`120000`）を
  // 外すために要る** — この repo の `CLAUDE.md` は `AGENTS.md` への symlink であり、
  // 素の `git ls-files` で両方拾うと **同じ中身を2度数え、同じ欠陥を2行出す。**
  // 「55件のうち8件」が実は「51件のうち4件」だった、という数え違いがここで生まれる。
  const listed = execFileSync('git', ['ls-files', '-sz'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      return { mode: entry.slice(0, 6), path: entry.slice(tab + 1) };
    })
    .filter((entry) => entry.mode !== '120000')
    .map((entry) => entry.path);

  const paths = listed.filter(
    (p) =>
      SCANNED_EXTENSIONS.some((ext) => p.endsWith(ext)) &&
      !EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix)),
  );

  return paths.map((p) => ({ path: p, content: readFileSync(`${repoRoot}/${p}`, 'utf8') }));
}

/**
 * インストール済みの `sdk.d.ts` を見つける。
 *
 * **⚠️ 見つからなければ投げる。黙って緑にしない。**「引用を数えて0件だった」と
 * 「そもそも検査が走らなかった」は別物であり、後者を緑で通すとこの門は
 * 「在るのに効いていない」状態で何ヶ月でも生き延びる（`AGENTS.md`「静かに失敗する道具」）。
 *
 * **⚠️ 依存（`createRequire` / `existsSync` / `readFileSync`）を引数で受けているのは
 * 意図である。`import` に戻さないこと。** 「見つからない」の分岐は、**実物では
 * vitest の中から測れない** — vitest は自前のモジュール解決を差し込むので、素の node
 * なら `MODULE_NOT_FOUND` になる引き方でも `createRequire(...).resolve()` が通ってしまう
 * （2026-09-05 の変異試験で実測。`anchors` を存在しないパスへ差し替える変異が、
 * CLI では exit 1 になるのに vitest では緑のまま生存した）。**引数で受けていれば、
 * 器に依存せず「投げること」そのものを固定できる**（`check-sdk-quotes.test.ts` の
 * `resolveSdkTypes — 「見つからない」を緑にしない`）。
 *
 * 解決は `@anthropic-ai/claude-agent-sdk` を直接依存に持つワークスペースから
 * `createRequire` で引く。pnpm の実体は `node_modules/.pnpm/` の下に在り、
 * パスに版番号とハッシュが入るので、**パスを文字列で組み立てない。**
 *
 * **読むのは `sdk.d.ts` だけではない。** 同梱の型定義は `sdk.d.ts` と
 * `sdk-tools.d.ts` の2枚に分かれており（道具の入出力の型は後者に在る）、
 * この repo は**両方から逐語を引いている**（`AGENTS.md` が `FileReadOutput` を
 * 引いている先は `sdk-tools.d.ts` のほうである）。**片方だけ読むと、もう片方から
 * 引いた引用が「当たらない」と誤判定される。** 2枚とも必須にしてあるのは、
 * 片方が消えたときに「引用が腐った」ではなく「読む先が変わった」と読ませるためである。
 */
export function resolveSdkTypes(repoRoot, createRequire, existsSync, readFileSync) {
  const anchors = ['packages/core', 'apps/daemon', 'apps/runner'];
  const tried = [];
  for (const anchor of anchors) {
    let entry;
    try {
      const require = createRequire(`${repoRoot}/${anchor}/package.json`);
      entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    } catch (error) {
      tried.push(`${anchor}: 解決できない（${error.code ?? error.message}）`);
      continue;
    }
    const dir = entry.slice(0, entry.lastIndexOf('/'));
    const typesPaths = [`${dir}/sdk.d.ts`, `${dir}/sdk-tools.d.ts`];
    const missing = typesPaths.filter((path) => !existsSync(path));
    if (missing.length > 0) {
      tried.push(`${anchor}: ${missing.join(' / ')} が無い`);
      continue;
    }
    let version = '不明';
    try {
      version = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version ?? '不明';
    } catch {
      // 版が読めなくても検査自体は成り立つ（当てる先は型定義の本文である）
    }
    return {
      typesPath: typesPaths.join(' + '),
      version,
      text: typesPaths.map((path) => readFileSync(path, 'utf8')).join('\n'),
    };
  }
  throw new Error(
    `check-sdk-quotes: 同梱の型定義（sdk.d.ts / sdk-tools.d.ts）が見つからない。先に \`pnpm install\` を走らせたか。試した先:\n  ${tried.join('\n  ')}`,
  );
}

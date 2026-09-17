/**
 * `check-pr-closing-keywords.mjs` の判定だけを切り出したもの（Issue #1109）。
 *
 * ## 何を塞ぐために在るか
 *
 * GitHub の「閉じるキーワード」（`Closes #123` 等）は、書いた側の意図を2通りの
 * 形で無視し、**どちらも「閉じる」側へ倒れる。** この repo で2日のうちに2回、
 * 同じ Issue（#993）が意図せず閉じた。
 *
 * - **形1（trailing-text）**: PR #1095 の本文末に「`Closes #993 の段1。`」と書いた
 *   （バッククォート無しの裸）。書いた側は「段1 を閉じる」つもりだったが、GitHub は
 *   番号までしか読まず後ろの「の段1」を捨てる。実測: Issue #993 の timeline
 *   （2026-09-17 観測） `closed 2026-09-16T12:11:30Z commit_id=null`。PR #1095 の
 *   マージは `12:11:28Z` —— **マージの2秒後**に閉じている。
 * - **形2（in-code）**: PR #1107 の本文には、形1 を説明するための引用として
 *   バッククォートで囲んだキーワードが2箇所在っただけで、裸のキーワードは1つも
 *   無かった。しかも本文は「この PR では閉じるキーワードを書いていない」と明言
 *   している。**それでも閉じた**。実測: Issue #993 の timeline
 *   `closed 2026-09-16T16:46:19Z commit_id=f942230870358b137499f7a52613cd0f4cdfb0a0`
 *   （このコミットは PR #1107 のマージコミット）。PR #1107 のマージは
 *   `16:46:17Z` —— **こちらもマージの2秒後**。
 *
 * **閉じたことは PR の側に1文字も出ない**（CI は緑、マージも成功、警告も出ない）。
 *
 * ## 直近マージ済み PR 150本への適用（実測、2026-09-17 観測）
 *
 * この規則を `main` の直近マージ済み PR 150本の本文へ当てたところ、キーワード＋
 * 参照の隣接を持つのは **32本**、そのうちこの規則で `found`（NG）になるのは
 * **5本**（#1095 / #1107 / #1070 / #912 / #868）。出現の内訳は `in-code` 2件
 * （どちらも #1107）と `trailing-text` 4件。**残る27本は通る**（`Closes #NNN`
 * 単独行か、`**Closes #913**` のような強調で囲んだ形）。⟹ **意図して閉じている
 * 形は27本とも素通りし、意図と GitHub の読みが食い違っている形だけが赤くなる。**
 *
 * - `#868 → #866`（マージ `2026-09-12T02:12:10Z` / closed `02:12:11Z`）と
 *   `#915 → #913`（`20:41:02Z` / `20:41:03Z`）はどちらも1秒差で閉じており、
 *   **意図と一致していたと読める**（#915 の `**Closes #913**` の形を、下の
 *   「強調で囲んだ形も通す」の根拠にした理由）。
 * - `#1070` の `Closes #888 の反映（Issue 自体は既に closed）` は、#888 が
 *   `2026-09-15T22:44:45Z` に閉じたのに対し #1070 のマージが
 *   `2026-09-16T06:21:47Z` なので、**この PR が閉じたのではない**（本文の
 *   記述どおり）。`trailing-text` で赤くはなるが、実害が出た例ではない。
 * - `#912` の逐語は `closes #910 の候補（**draft。依頼者の合図待ち**。マージも
 *   issue の close もしていない）`。PR #912 のマージは `2026-09-13T01:03:46Z`、
 *   Issue #910 の `closed` は `01:03:47Z`（`commit_id=null`、reopen は無くいまも
 *   CLOSED）。**⚠️ 「誤って閉じた」と断定はしない** —— マージされた時点で閉じて
 *   よかった可能性があり、そこは確かめていない。言えるのは「本文が『close して
 *   いない』と書いている隣で、閉じたのは人の判断ではなくキーワードだった」ところ
 *   までである。
 *
 * ⟹ この門も **fail-closed** で書く。タイトル・本文・コミットメッセージのどれかが
 * 読めなかったら「無い」ではなく赤くする（下の `unreadable` verdict）。
 *
 * ## 何を読むか（タイトル・本文・コミットメッセージの3つ）
 *
 * `gh pr view <N> --json title,body,commits` で取る3つすべてを読む。
 *
 * - **タイトルを読む理由**: GitHub 公式ドキュメント
 *   （https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue、
 *   2026-09-17 に取得して確認）の逐語:
 *   `You can also use closing keywords in a commit message. The issue will be
 *   closed when you merge the commit into the default branch`。**squash マージは
 *   PR のタイトルをコミットの件名として焼く**（`AGENTS.md`「リポジトリの約束」・
 *   `check-pr-title-type-core.mjs` の doc が実測付きで持つ事実）。⟹ タイトルに
 *   閉じるキーワードが在れば、件名経由で閉じる経路が開く。
 *   - **⚠️ この repo のタイトル規約自身が、この罠の形をしている。** 規約は
 *     `<type>: <description>` で、type には `fix` が在る。公式 doc は
 *     キーワードの後ろにコロンを許すので（下の「コロン・大文字」）、
 *     `fix: #123 の…` という形のタイトルは `KEYWORD: #ISSUE` として読める
 *     余地がある——「型 + 説明」を書いたつもりが閉じる指示になる。
 *     **これは doc の記述からの推論であり、実際に本番の Issue を閉じて確認しては
 *     いない**（測るには本物の Issue を閉じるしかないので測っていない）。
 *   - 実測（2026-09-17、直近マージ済み150本）: キーワード＋参照の隣接をタイトルに
 *     持つものは **0本**。この追加で落ちる既存の形は測った範囲では無い。
 *   - 対照実例: PR #1112 のタイトル `fix: 台帳の重複の畳み込みを open() の1操作へ
 *     畳む（#1041）` は「型＋説明＋（#番号）」の形で、キーワードと参照が隣接して
 *     いないので当たらない。**この PR がマージの2秒後に #1041 を閉じているのは
 *     事実だが、原因はタイトルではなく本文の `Closes #1041` 単独行である**
 *     （確認済み）。タイトルが閉じたと読まないこと。
 * - **本文とコミットメッセージを両方読む理由**: 直上と同じ公式 doc の逐語が
 *   コミットメッセージでも効くことを明言している。squash マージ以外の戦略
 *   （merge commit・rebase merge）では元のコミットメッセージがそのまま
 *   default branch に入るので、コミット側もこの doc が直接扱っている経路である。
 * - コミットメッセージは `messageHeadline` + `messageBody` を
 *   `check-no-attribution-trailers-core.mjs` の `commitFullMessage` と同じ形で
 *   合成する。**あの関数を import して使い回す**（同じファイルに書き写さない。
 *   既に export されているものを重複させない）。
 *
 * ## なぜ repo のファイルも git の履歴も走査しないか（#785 と同じ族）
 *
 * この歯（`check-pr-closing-keywords.test.ts`）は fixture として閉じるキーワード
 * の逐語を持つ。repo を走査する形にすると、その fixture 自身を「見つかった」と
 * 誤検出する自己参照になる（`check-no-attribution-trailers-core.mjs` /
 * `check-pr-title-type-core.mjs` と同じ理由）。だからこの門が読むのは**この PR の
 * タイトル・本文・コミットメッセージだけ**である。
 *
 * ## キーワードと参照の形
 *
 * **キーワード（大小文字を区別しない）**: `close` `closes` `closed` `fix`
 * `fixes` `fixed` `resolve` `resolves` `resolved`。
 *
 * **確認済みの事実（公式 doc、2026-09-17 取得）**: 上のキーワード9語は公式 doc の
 * 一覧と完全に一致する。doc の逐語:
 * `The keywords can be followed by colons or in uppercase. For example:
 * Closes: #10, CLOSES #10, or CLOSES: #10.`
 * ⟹ **コロンと大文字は公式に有効。「確認できていない」ものではない。**
 *
 * **参照の形**:
 *
 * - `#123`・`GH-123`・`owner/repo#123`・issue の URL
 *   （`https://github.com/<owner>/<repo>/issues/123`）
 * - 公式 doc が明示するのは `KEYWORD #ISSUE-NUMBER` と、他 repo を指す
 *   `KEYWORD OWNER/REPOSITORY#ISSUE-NUMBER` の2形だけである。複数を閉じる例も
 *   doc に在る（逐語: `Resolves #10, resolves #123, resolves
 *   octo-org/octo-repo#100`）——**この規則の「`,` 区切りの対の並びを通す」は、
 *   ちょうどこの公式の例を通す。**
 * - **`GH-123` と issue の URL 形式は公式 doc に記述が無い**（探して無かった。
 *   「doc に記述が無いので拾う側へ倒した」のであって、実測でも推論でもない——
 *   記述の不在そのものである）。拾う側へ倒すのは fail-closed の向き（見逃しの
 *   ほうが実害があるため）。
 *
 * **キーワードと参照のあいだ（コロン・空白の扱い）**: 公式 doc の逐語どおり
 * コロンを挟む形（`Closes: #10`）も、コロン無しの空白1個以上（`Closes #10`）も
 * 両方拾う。実装は `(?:\s*:\s*|\s+)`——コロンの前後の空白は無くてもよい
 * （`Closes:#10` も拾う側へ倒す。doc はここまで明言していないが、コロンを許す
 * 以上、空白の有無で機構が変わるとは考えにくい方向へ広く取った）。
 *
 * **除外の記述は doc に無い**: コードブロック・引用・HTML コメントの中を除外する
 * という記述は公式 doc のどこにも無い（探して無かった。「除外しないと書いて
 * ある」のではなく「記述が無い」）。実際、形2（バッククォートで囲んだ形）は
 * 閉じることが実測で確認されている。⟹ **この門はコード・引用・コメントの中を
 * 「安全」とは扱わない**——全部 NG として拾う（下の「落とす形」）。引用と
 * HTML コメントについては実測が無いが、doc に除外の記述が無い以上、除外する
 * 根拠も無いので同じ側（拾う）へ倒す。
 *
 * ## 通す形（1つだけ）
 *
 * 「閉じるキーワード＋参照」の対だけで行が構成されているとき、その行は通す。
 * 厳密には、フェンスの外に在り、`>`（引用）で始まらず、HTML コメント
 * （`<!-- -->`）の中でもない行が、次のいずれかにマッチするとき:
 *
 * ```
 * ^\s*(?:<キーワード> <参照>)(?:\s*[,、]\s*(?:<キーワード> <参照>))*\s*[.。]?\s*$
 * ```
 *
 * （対が1つ以上、`,` か `、` で区切って並ぶだけの行。末尾の `.` / `。` は1つまで
 * 許す。）
 *
 * **加えて、対の並び全体を同じ強調記号（`**` / `*` / `__` / `_`）1組で囲んでも
 * よい。** 根拠は「規約に書いてあるか」ではなく「`main` に実在するか」で引いた
 * ——`check-pr-title-type-core.mjs` の `LEADING_MARKERS` が `[CI未起動]` を許す
 * のと同じ向き（あの doc の逐語: 「根拠は「規約に書いてあるか」ではなく「`main`
 * に実在するか」で引いた」）。実測: PR #915 の本文に `**Closes #913**` が実在し、
 * マージ（`2026-09-12T20:41:02Z`）の1秒後に Issue #913 が閉じている——**意図と
 * GitHub の読みが一致している形**。囲みの中に対以外の文字が在れば落ちる
 * （`**Closes #993 の段1。**` は `trailing-text` のまま落ちる——開いた強調記号の
 * 直後に対の並びが続き、その直後に同じ強調記号で閉じている必要があり、対の後ろに
 * 「の段1。」が挟まると閉じの強調記号が対の直後に来ないので通す形にならない）。
 *
 * ⟹ `Closes #123` / `closes #123、fixes #456` / `Fixes #123.` /
 * `**Closes #913**` は通る。
 *
 * ## 落とす形（それ以外の全部）
 *
 * 上の形に当てはまらない出現は全部 NG。なぜ落とすのかを出現ごとに分類する。
 *
 * | 分類 | 意味 | 由来 |
 * |---|---|---|
 * | `trailing-text` | 参照の後ろに同じ行で文字が続く | 形1 そのもの（`Closes #993 の段1。`）。GitHub は番号までしか読まない |
 * | `leading-text` | 行の中でキーワードの手前に文字が在る（後ろには続かない） | 「誤って closes #993」のような形。GitHub は閉じる |
 * | `in-code` | インラインコードスパン（`` ` ``）かフェンス（```` ``` ````）の中 | 形2 そのもの。囲んでも GitHub は閉じる（実測で確認済み） |
 * | `in-quote` | `>` で始まる引用行の中 | 引用でも閉じるかは未実測。doc に除外の記述も無いので、拾う側（NG）へ倒す |
 * | `in-html-comment` | `<!-- -->` の中 | 同上（未実測。doc に除外の記述が無いので拾う側へ倒す） |
 *
 * **分類が重なる場合の優先順位**（決めたことと、なぜそれで足りるか）:
 *
 * `in-code` > `in-html-comment` > `in-quote` > `trailing-text` > `leading-text`。
 *
 * - **場所に基づく3分類（`in-code` / `in-html-comment` / `in-quote`）を、形に
 *   基づく2分類（`trailing-text` / `leading-text`）より先に見る。** 場所が
 *   その出現の性質を決める主因であり（形2がまさにその実例——バッククォートで
 *   囲まれていること自体が「なぜこれが罠か」の全てである）、行の形の話は
 *   場所の話が無いときにだけ意味を持つ。
 * - **場所の3分類の中では、内側にあるものを先に見る**（`in-code` →
 *   `in-html-comment` → `in-quote`）。引用行の中にインラインコードが在る形
 *   （`` > `Closes #123` ``）では、最も内側の入れ物（コードスパン）が実測で
 *   確認済みの罠と直接対応するので、そちらを名乗るほうが次の一手（直し方）を
 *   正しく示せる。
 * - **`trailing-text` を `leading-text` より先に見る。** そもそも `leading-text`
 *   の定義自体が「後ろには続かない」を含むので（上の表）、後ろに文字が続く
 *   出現は定義上 `trailing-text` にしかなり得ない——2つのカテゴリは互いに
 *   排他的になるように定義してあり、優先順位というより定義の帰結である。
 *
 * ## verdict は3値
 *
 * `ok` / `found` / `unreadable`。`found` と `unreadable` はどちらも終了コード1
 * （`unreadable` は fail-closed。「見つからなかった」ではなく赤くする）。
 */

/** 閉じるキーワード9語（公式 doc の一覧と完全一致。大小文字は区別しない）。 */
export const CLOSING_KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
];

// 長い語を先に置く（`\b` があるので必須ではないが、バックトラックに頼らない
// 明示的な形にしておく）。
const KEYWORD_ALTERNATION = 'closed|closes|close|fixed|fixes|fix|resolved|resolves|resolve';
const KEYWORD_SOURCE = `\\b(?:${KEYWORD_ALTERNATION})\\b`;

/**
 * キーワードと参照のあいだの区切り。公式 doc の確認済み事実（コロンを許す）に
 * 基づき、コロンを挟む形（前後の空白は有っても無くてもよい）と、コロン無しの
 * 空白1個以上のどちらも受け付ける。
 */
const GAP_SOURCE = '(?:\\s*:\\s*|\\s+)';

/**
 * 参照の形。`#123` / `GH-123` / `owner/repo#123` / issue の URL。
 * **`GH-123` と URL は公式 doc に記述が無い**（doc の doc コメントを見よ）。
 * 長い（より具体的な）形を先に置く。
 */
const REFERENCE_SOURCE =
  '(?:https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/\\d+' +
  '|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#\\d+' +
  '|GH-\\d+' +
  '|#\\d+)';

/** 「キーワード＋区切り＋参照」の対。 */
const PAIR_SOURCE = `${KEYWORD_SOURCE}${GAP_SOURCE}${REFERENCE_SOURCE}`;

/** 出現検出用（`g` + `i`）。行内の全出現を拾う。 */
const OCCURRENCE_PATTERN = new RegExp(PAIR_SOURCE, 'gi');

/**
 * 対の並び全体を囲んでよい強調記号。`**` を `*` より先に置く（`**` の位置で
 * `*` が先に試されると1文字だけ消費してしまう）。同じく `__` を `_` より先に。
 */
const WRAP_SOURCE = '(\\*\\*|\\*|__|_)';

/**
 * 「通す形」の全体一致（1行）。対が1つ以上、`,`／`、` で区切って並ぶだけ。
 * 末尾の `.`／`。` は1つまで許す。先頭に強調記号が在れば、対の並びの直後に
 * **同じ**強調記号が続くことを `\1`（バックリファレンス）で要求する
 * ——開いたのに閉じていない形（`**Closes #913` で終わる行）は通さない。
 * JS の仕様上、`\1` は対応する capturing group が参加しなければ空文字列と
 * 一致するので、強調記号が無い行にも問題なく使える。
 */
const PURE_LINE_PATTERN = new RegExp(
  `^\\s*${WRAP_SOURCE}?` +
    `${PAIR_SOURCE}(?:\\s*[,、]\\s*${PAIR_SOURCE})*` +
    `\\1` +
    `\\s*[.。]?\\s*$`,
  'i',
);

/** フェンス区切り行（`` ``` `` を3つ以上、先頭の空白は許す）。 */
const FENCE_DELIMITER_PATTERN = /^\s*`{3,}/;

/** 引用行（先頭の空白を許した上で `>` で始まる）。 */
const QUOTE_LINE_PATTERN = /^\s*>/;

/** 行ごとの開始オフセット（`text.split('\n')` した各要素が全体の何文字目から始まるか）。 */
function computeLineStarts(lines) {
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1; // 1 は split で失われた '\n' の分
  }
  return starts;
}

/**
 * フェンスコードブロックの区間（絶対オフセット）。開いたまま閉じられていない
 * フェンスは、テキストの末尾までを fail-closed でコードとして扱う。
 */
function computeFenceIntervals(lines, lineStarts) {
  const intervals = [];
  let inFence = false;
  let openStart = null;
  for (let i = 0; i < lines.length; i++) {
    if (!FENCE_DELIMITER_PATTERN.test(lines[i])) continue;
    if (!inFence) {
      inFence = true;
      openStart = lineStarts[i];
    } else {
      inFence = false;
      intervals.push([openStart, lineStarts[i] + lines[i].length]);
      openStart = null;
    }
  }
  if (inFence && openStart !== null) {
    const last = lines.length - 1;
    intervals.push([openStart, lineStarts[last] + lines[last].length]);
  }
  return intervals;
}

/**
 * インラインコードスパン（単一のバッククォート対）の区間。行を跨がない
 * （Markdown のインラインコードは通常1行内で閉じるので、この単純化で足りる。
 * 二重バッククォート `` `` `` のような区切りの入れ子は対応していない——未対応の
 * まま緩めるより、単一バッククォートの形だけを確実に拾うほうを選んだ）。
 */
function computeInlineCodeIntervals(lines, lineStarts) {
  const intervals = [];
  const re = /`[^`\n]*`/g;
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      intervals.push([lineStarts[i] + m.index, lineStarts[i] + m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return intervals;
}

/**
 * HTML コメントの区間（絶対オフセット）。複数行に跨る `<!-- ... -->` も拾う
 * （`[\s\S]*?` で改行を含めて非貪欲に一致させる）。閉じられていないコメントは
 * 一致しない（`-->` が最後まで現れない限り、この regex は一致を作らない）。
 */
function computeCommentIntervals(text) {
  const intervals = [];
  const re = /<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    intervals.push([m.index, m.index + m[0].length]);
  }
  return intervals;
}

/** `[start, end)` が intervals のどれかと重なるか。 */
function overlapsAny(intervals, start, end) {
  return intervals.some(([a, b]) => start < b && end > a);
}

/**
 * 1行を分析し、その行に含まれる「キーワード＋参照」出現ごとの分類を返す。
 * `isPure` が真かつ場所の問題が無ければ、その行の出現は何も返さない（通る）。
 */
function analyzeLine(lineText, lineIndex, ctx) {
  const findings = [];
  const isPure = PURE_LINE_PATTERN.test(lineText);
  const lineStart = ctx.lineStarts[lineIndex];

  OCCURRENCE_PATTERN.lastIndex = 0;
  let match;
  while ((match = OCCURRENCE_PATTERN.exec(lineText)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    const absoluteStart = lineStart + matchStart;
    const absoluteEnd = lineStart + matchEnd;

    let category = null;
    if (overlapsAny(ctx.codeIntervals, absoluteStart, absoluteEnd)) {
      category = 'in-code';
    } else if (overlapsAny(ctx.commentIntervals, absoluteStart, absoluteEnd)) {
      category = 'in-html-comment';
    } else if (ctx.quoteLines.has(lineIndex)) {
      category = 'in-quote';
    } else if (!isPure) {
      const leadingSegment = lineText.slice(0, matchStart);
      const trailingSegment = lineText.slice(matchEnd);
      const hasTrailing = !/^\s*[.。]?\s*$/.test(trailingSegment);
      if (hasTrailing) {
        category = 'trailing-text';
      } else if (/\S/.test(leadingSegment)) {
        category = 'leading-text';
      } else {
        // 防御的フォールバック: leading も trailing も無いのに行が「通す形」に
        // 一致しない、という経路は理論上無いはずである（PURE_LINE_PATTERN と
        // OCCURRENCE_PATTERN は同じ PAIR_SOURCE から作っているため）。それでも
        // 3値の「判定できない」と同じ思想で、未知の形は見逃さない側へ倒す。
        category = 'trailing-text';
      }
    }

    if (category !== null) {
      findings.push({ category, line: lineText });
    }

    if (match[0].length === 0) OCCURRENCE_PATTERN.lastIndex++;
  }

  return findings;
}

/**
 * テキスト中の「閉じるキーワード＋参照」出現を、通る行を除いて全部返す。
 * `text` が文字列でない・空文字なら空配列（例外にしない）。
 *
 * @returns {{ category: 'trailing-text'|'leading-text'|'in-code'|'in-quote'|'in-html-comment', line: string }[]}
 */
export function findClosingKeywordOccurrences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const lines = text.split('\n');
  const lineStarts = computeLineStarts(lines);
  const codeIntervals = [
    ...computeFenceIntervals(lines, lineStarts),
    ...computeInlineCodeIntervals(lines, lineStarts),
  ];
  const commentIntervals = computeCommentIntervals(text);
  const quoteLines = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE_LINE_PATTERN.test(lines[i])) quoteLines.add(i);
  }

  const ctx = { lineStarts, codeIntervals, commentIntervals, quoteLines };
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    findings.push(...analyzeLine(lines[i], i, ctx));
  }
  return findings;
}

/** コミットの短縮 sha と見出しから `commit <sha> "<見出し>"` の形を作る。 */
function describeCommit(commit) {
  const oidShort =
    typeof commit?.oid === 'string' && commit.oid.length > 0 ? commit.oid.slice(0, 7) : '(sha不明)';
  const headline =
    typeof commit?.headline === 'string' && commit.headline.length > 0
      ? ` "${commit.headline}"`
      : '';
  return `commit ${oidShort}${headline}`;
}

/**
 * PR のタイトル・本文・全コミットメッセージから、閉じるキーワードが GitHub に
 * 解釈される形で残っていないかを判定する。
 *
 * @param {{ title: string|null, body: string|null, commits: { oid: string|null, headline: string, message: string }[]|null }} input
 *   `title` / `body` / `commits` のどれかが `null`（または `title` が文字列
 *   でない）なら「取得できなかった」を意味する（**空文字・空配列とは区別する**）。
 * @returns {{ verdict: 'ok'|'found'|'unreadable', findings: { source: string, category: string, line: string }[] }}
 */
export function evaluatePrClosingKeywords({ title, body, commits }) {
  if (typeof title !== 'string' || body === null || commits === null) {
    return { verdict: 'unreadable', findings: [] };
  }

  const findings = [];

  for (const occ of findClosingKeywordOccurrences(title)) {
    findings.push({ source: 'PR のタイトル', ...occ });
  }

  for (const occ of findClosingKeywordOccurrences(body)) {
    findings.push({ source: 'PR 本文', ...occ });
  }

  for (const commit of commits) {
    const occurrences = findClosingKeywordOccurrences(commit?.message);
    if (occurrences.length === 0) continue;
    const source = describeCommit(commit);
    for (const occ of occurrences) {
      findings.push({ source, ...occ });
    }
  }

  return { verdict: findings.length > 0 ? 'found' : 'ok', findings };
}

/**
 * 判定を、人が読んで次の一手が決まる文へ畳む（`check-no-attribution-trailers-core.mjs`
 * / `check-pr-title-type-core.mjs` の `formatVerdict` と同じ方針）。
 */
export function formatVerdict(prNumber, result) {
  const header = `check-pr-closing-keywords(#${prNumber}):`;
  switch (result.verdict) {
    case 'unreadable':
      return (
        `${header} 判定できなかった —— PR のタイトル・本文・コミットメッセージの` +
        'いずれかを読めなかった（fail-closed。「見つからなかった」ではなく赤くする）'
      );
    case 'found':
      return [
        `${header} NG —— 閉じるキーワードと参照の組が、GitHub に解釈される形で見つかった`,
        ...result.findings.map((f) => `  ${f.source} [${f.category}]: ${f.line}`),
        '  次の一手:',
        '   - 参照だけしたいなら番号だけ書く（キーワードを同じ行に置かない）',
        '   - 閉じたいならキーワードと参照だけの行にする、または手で閉じる（gh issue close <N>）',
        '   - GitHub のパーサに預けずに閉じたいなら `Alteroid-Issue-Done: <番号>` を' +
          ' PR 本文へ書く（書式は scripts/issue-done-trailer-core.mjs の doc。#1134）',
        '  ⚠️ バッククォートで囲んでも GitHub は閉じる',
      ].join('\n');
    case 'ok':
      return (
        `${header} OK —— 閉じるキーワードと参照の組は無いか、通す形` +
        '（キーワードと参照だけの単独行、または強調で囲んだ同じ形）だけである'
      );
    default:
      return `${header} 未知の verdict: ${result.verdict}`;
  }
}

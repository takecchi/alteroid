/**
 * `Bash` へ渡すコマンド文字列が「無限に待つだけの形」かどうかを見分ける、
 * 副作用の無い判定器（#894 段1・案(A)）。
 *
 * ## 経緯（#894）
 *
 * 作業者が `until <条件>; do ... sleep ...; done` の形の「待つだけの
 * ループ」を背景処理として残し、待っていた相手（本体の走行）が先に死んだ
 * ため条件が永遠に偽（または真）のままになり、`until` ループが回り続けた。
 * 器はこれを「背景処理がまだ在る」と見て畳み続け、起こし直しの通し上限
 * （`runner.ts` の `SUBAGENT_WAKEUP_LIMIT_PER_AGENT` = 8）を使い切って
 * 作業者が永久に停止した。#357 は「システムプロンプトに書けば守られる」を
 * 検証しないまま前提にしていたが、#894 はそれが実際には守られなかったこと
 * を実測した。⟹ **能力そのものを弾く側（器の PreToolUse）へ倒す。**
 *
 * ## この検出器がしていること・していないこと
 *
 * **弾くのは「無限待ちの意味」ではなく「無限待ちの *形*」である。** 相手が
 * 本当に終わるかどうかは一般には決定不能（停止性問題）なので、意味を判定
 * することはできない。ここで見ているのは構文だけ —— `until` / `while` が
 * `sleep` を伴って回っているか、`tail -f` / `--follow` が付いているか。
 * だから「この形をしていない無限待ち」は必ず残る。呼び出し側 doc
 * （`runner.ts` の `#onPreToolUse`）とこのファイルのテストの末尾に、
 * 弾けないと分かっている形を明記してある。
 *
 * ## 単独の `sleep` を弾かない理由
 *
 * **有界な1回の待ちは自分で終わる。** 無限にするのは *ループ* のほうで
 * あって、単独の `sleep` ではない。単独の `sleep` まで弾くと、普通の
 * 間合い調整（連続 API 呼び出しの間隔を空ける、等）まで止めたうえに、
 * 弾いた先に代わりの形が無い —— 待つこと自体は正当な操作なので、代替が
 * 無い拒否は「素通りする形（`python -c 'while True: ...'` 等）へ逃げる」
 * を誘発するだけである（AGENTS.md「テストを弱めずに直す」と同じ理由で、
 * 拒否は必ず具体的な逃げ道と対にする）。
 *
 * ## 「弾いてはいけないもの」の判定基準
 *
 * 次のどれかが在れば、`until`/`while` + `sleep` の形であっても通す:
 *
 * - 全体が `timeout N ...` に包まれている（先頭コマンドが `timeout`）
 * - `for` ループ（そもそも `until` / `while` に一致しないので、この検出器は
 *   何もしない —— 個別の除外条件を書く必要がない）
 * - `while read ...`（入力で尽きる。ループの条件節に `read` が在る）
 * - カウンタの比較が在る（`-lt` / `-le` / `-gt` / `-ge`、または算術文脈
 *   `(( ... ))`）
 * - 本体に `break` が在る
 * - ループが無い（この検出器はループの構文にしか反応しないので、他のどんな
 *   コマンドも通る）
 *
 * ## `do` / `done` は「コマンドの位置に在るとき」だけ終端と見なす（#894 段2で直した）
 *
 * 以前は `\bdo\b … \bdone\b`（単語境界だけ）で切り出していたため、**本体の
 * 途中に現れる引数やパス名がたまたま `do` / `done` という語を含むと、そこで
 * 早期に閉じたと誤読していた。** 実際にテスト作成時に踏んだ —— `if [ -f
 * /tmp/done ]; then break; fi; done` は `/tmp/done` の `done` を本物の
 * `done` と取り違え、`break` を読む前に本体を打ち切って `sleep` だけの
 * ループに見せかけていた（前任者はこれをテスト側の fixture のパス名を
 * `/tmp/finished.flag` へ避けて回避した —— 検出器ではなく、誤爆する入力の
 * ほうを歯から消しただけだった）。
 *
 * 直し方は、`do` / `done` の**手前の文字**を絞る —— 行頭・`;` / `&` / `|` /
 * 空白（改行を含む）のどれかが直前に在るときだけコマンド位置と認め、終端
 * として扱う（`(?<=^|[\s;&|])do\b` / 同じ形の `done`。lookbehind）。
 * `/tmp/done` の `done` は直前が `/` なのでこの条件に当たらず、終端と
 * 見なされなくなる。`grep -q done /tmp/x.log` のように `done` という語の
 * 前が空白であっても、この語のうち `do` の部分は末尾直後が `n`（単語文字）
 * のままなので、そもそも `do\b`（trailing boundary）にすら一致しない ——
 * この形は元から誤爆していなかった。
 *
 * ⚠️ **残る弱さ**: `do` / `done` を含む語が**引用符の中**に在ると、直前の
 * 文字が空白や `;` でもコマンド位置とは限らない（例: `echo "please do
 * this"` の `do` は直前が空白なので、この検出器はまだコマンド位置の `do`
 * と区別できない）。完全な shell 構文解析器ではないことの直接の帰結であり、
 * この PR でも直していない。
 *
 * ## このファイルが「待ちの形」以外も持つようになった経緯（#1764）
 *
 * ファイル名・doc の冒頭は今も #894（無限待ちの形）のままだが、#1764 で
 * `gh pr merge --delete-branch`（取り返しの付かない操作の形）をここへ足した。
 * 待ちの形とは害の種類が違う —— こちらは「終わらないこと」ではなく
 * 「終わった後に戻せないこと」を弾く。別ファイルに分けなかったのは、
 * `PreToolUse` から `Bash` の `command` を検査して deny する配線
 * （`runner.ts` の `#onPreToolUse`）がすでにここ1本しかなく、判定器を
 * 分けても呼び出し側の配線は増えないため —— 増えるのはこのファイルの
 * 行数だけだった。ファイル名は変えない（`inspectBashCommand` という
 * 入口の名前も変えていないので、呼び出し側の変更は0行で済んでいる）。
 */

/** 弾いた形の種別。テストと呼び出し側の note 文言がここへ分岐する。 */
export type WaitGuardForm =
  | 'until-sleep'
  | 'while-sleep'
  | 'tail-f'
  | 'gh-run-watch-background'
  | 'gh-pr-merge-delete-branch';

export type WaitGuardVerdict =
  { blocked: false } | { blocked: true; form: WaitGuardForm; reason: string };

/**
 * 拒否理由に必ず添える具体的な代替（依頼者からの明示の条件）。
 *
 * ⚠️ 代替を書かない拒否は安全側に効かない —— 弾いた先に道が無いと、
 * 作業者は素通りする形へ逃げ、それが「解決」に見えてしまう（#894）。
 */
const ALTERNATIVES =
  '代わりに次のいずれかを使うこと: ' +
  '(1) 起動した処理の完了を待つなら、待ち自体が終わる呼び出しにする ' +
  '（例: `gh run watch <id> --exit-status` を**前景で**）。 ' +
  '(2) 待ちに上限が要るなら `timeout <秒> <コマンド>` で自分から終わらせる。 ' +
  '(3) 完了通知を待つのではなく、成果物が在るかを前景の呼び出しで見に行く。';

function buildReason(shapeDescription: string): string {
  return `${shapeDescription}（無限待ちの形）。${ALTERNATIVES}`;
}

/**
 * 全体が `timeout N ...` に包まれているか。
 *
 * 先頭に環境変数の代入（`FOO=bar timeout 60 ...`）が在ってもよい —
 * シェルはそれを `timeout` コマンドへの環境変数付与として扱うので、
 * 有界性そのものは変わらない。
 */
function isTimeoutWrapped(trimmed: string): boolean {
  return /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*timeout\b/.test(trimmed);
}

/**
 * `tail -f` / `tail --follow` を、同じ単純コマンドの中だけで探す。
 *
 * `;` / `&&` / `||` / `|` / 改行の手前で切る —— これらは別の単純コマンドの
 * 境界なので、`tail -5 foo.log; other -f bar` のような無関係な `-f` を
 * 拾わないため。フラグは `-f` を含む短縮オプション（`-f` 単体・結合形）と
 * `--follow`（`--follow=name` も含む）の両方を見る。
 */
const TAIL_FOLLOW_RE =
  /\btail\b(?:(?!;|&&|\|\||\||\n).)*?(?:\s-[a-zA-Z]*f[a-zA-Z]*(?=[\s;&|]|$)|\s--follow\b)/;

function hasUnboundedTailFollow(command: string): boolean {
  return TAIL_FOLLOW_RE.test(command);
}

/**
 * `until <cond>; do <body>; done` / `while <cond>; do <body>; done` を拾う。
 *
 * `do` / `done` は「単語境界」だけでなく、直前の文字が行頭・`;` / `&` / `|` /
 * 空白（改行を含む）のいずれかであることも要求する（lookbehind）。これが
 * 無いと `/tmp/done` のようなパス名の一部が `\bdone\b` に一致し、本体を
 * 早期に打ち切って誤爆する（doc 冒頭「`do` / `done` は『コマンドの位置に
 * 在るとき』だけ終端と見なす」）。
 */
const LOOP_RE = /\b(until|while)\b([\s\S]*?)(?<=^|[\s;&|])do\b([\s\S]*?)(?<=^|[\s;&|])done\b/g;

/** カウンタ比較（`-lt` 系 / `(( ... ))`）が条件節・本体のどちらかに在るか。 */
const COUNTER_COMPARISON_RE = /-lt\b|-le\b|-gt\b|-ge\b|\(\(/;

function isBoundedLoop(keyword: 'until' | 'while', cond: string, body: string): boolean {
  // `while read ...`: 入力（パイプ・リダイレクト）が尽きれば自分で終わる。
  if (keyword === 'while' && /\bread\b/.test(cond)) return true;
  // カウンタの比較がある = 有限回で条件が反転する形だと読める。
  if (COUNTER_COMPARISON_RE.test(cond) || COUNTER_COMPARISON_RE.test(body)) return true;
  // 本体に break がある = ループの外へ出る経路を自分で持っている。
  if (/\bbreak\b/.test(body)) return true;
  return false;
}

/**
 * `gh run watch` を背景へ置く形（AGENTS.md「CI の完了を待つ形」）。
 *
 * ## なぜこの形だけ別に見るのか
 *
 * 他の3つの形（`until`/`while` + `sleep`・`tail -f`）は**コマンド自身が
 * 終わらない**。こちらは違う —— `gh run watch` は run が終われば返る。
 * 害は「終わらないこと」ではなく、**背景へ置くと待ちが自分の手から外れる**
 * ことのほうである。実測（2026-09-17、`.claude/skills/pr-green/SKILL.md` に逐語
 * ——この項は #1753 で AGENTS.md「CI の完了を待つ形」から移った）:
 * 作業者2人が同じ形で止まった。背景処理を残したまま作業者が畳むと、
 * 起こし直しの上限（`runner.ts` の `SUBAGENT_WAKEUP_LIMIT_PER_AGENT`）に
 * 達して**委譲そのものが停止する** —— しかも依頼側からは「まだ走っている」と
 * 区別が付かない。
 *
 * ## 「背景へ置く」の2つの形を両方見る
 *
 * 1. **コマンド文字列の `&`**（`gh run watch 1 &`）。
 * 2. ⭐ **`Bash` ツールの `run_in_background: true`**。こちらが実測で踏まれた
 *    ほうである —— AGENTS.md が記録した2本の実物はどちらも `&` を持たない。
 *    **この形はコマンド文字列に1文字も現れない** ⟹ 文字列だけを読む機械
 *    （`.claude/settings.json` のフック等）では原理的に検出できない。だから
 *    `invocation.backgrounded` として呼び出し側から受け取る（`runner.ts` の
 *    `#onPreToolUse` が `tool_input.run_in_background` を渡す）。
 *
 * ## ⚠️ この検出器が弾かないと分かっている形
 *
 * - **前景の `gh run watch`。** `Bash` の既定 120 秒を越えると器が自分で
 *   背景へ移すので、AGENTS.md は前景も危ういと書いている。**それはここでは
 *   弾かない** —— 弾くと `ALTERNATIVES` (1) が勧めている当の形を自分で
 *   禁じることになり、代替の無い拒否になる（このファイル冒頭「単独の
 *   `sleep` を弾かない理由」と同じ判断）。上限が要るなら `timeout` で包む。
 * - **`timeout` に包まれた背景の `gh run watch`。** このモジュールの約束
 *   （「全体が `timeout N ...` に包まれていれば有界と読む」）を新しい形の
 *   ためだけに崩さない。⟹ **意図して開けてある逃げ道である。**
 */
const GH_RUN_WATCH_RE = /\bgh\b(?:(?!;|&&|\|\||\||\n).)*?\brun\s+watch\b/;

/**
 * 直後に最初に現れる制御演算子が「背景化の `&`」かを見る。
 *
 * `&` は `2>&1`（直前が `>`）と `&&`（直前か直後が `&`）にも現れるので、
 * 単純な `&` の検索では誤爆する。lookbehind と lookahead でその2つを外す。
 * `;` / 改行が先に来たなら、その `gh run watch` は背景化されていない。
 */
const FIRST_CONTROL_OPERATOR_RE = /[;\n]|(?<![>&])&(?!&)/;

function isBackgroundedGhRunWatch(trimmed: string, backgrounded: boolean): boolean {
  const match = GH_RUN_WATCH_RE.exec(trimmed);
  if (match === null) return false;
  // ツール側の背景指定は、コマンド文字列のどこに在っても背景である。
  if (backgrounded) return true;
  const rest = trimmed.slice(match.index + match[0].length);
  const operator = FIRST_CONTROL_OPERATOR_RE.exec(rest);
  return operator !== null && operator[0] === '&';
}

/**
 * `gh pr merge --delete-branch` / `-d`（#1764）。
 *
 * ## なぜ「無限待ち」の3形・`gh-run-watch-background` と害の種類が違うか
 *
 * 上のどの形も「コマンドが終わらない」ことを弾いている。こちらは一瞬で
 * 終わる —— 害は終わらないことではなく、**終わった後に取り返しが付かない**
 * ことである。積んだ PR（この枝を base にしている PR）が在ると、マージと
 * 同時にその PR も黙って閉じ、閉じたあとは `reopen` も `--base` の付け替え
 * も拒まれる（実測 2026-09-15T07:3xZ、PR #1008 と #1010。
 * `.claude/skills/tool-quirks/SKILL.md` に生出力が在る）。この repo は
 * `delete_branch_on_merge=true` なので、**付けなくても枝は消える**
 * —— 正当な用途がほぼ無いぶん、逃げ道は「外して打つ」の1つで済む。
 *
 * ## 弾くのは「コマンドの位置に在る `gh pr merge`」だけ（#1764 の指定）
 *
 * この文字列は PR 本文・Issue 本文・説明の中に頻繁に書かれる
 * （`gh-run-watch-background` と同じ理由——2026-09-17 の注意）。だから
 * ヒアドキュメントの本文・引用符の中・別のコマンドの引数に現れる形は
 * **通す**。行頭、または `;` `&&` `||` `|` の直後に在る `gh pr merge` の
 * 呼び出しだけを見る —— `do`/`done` の lookbehind
 * （`(?<=^|[\s;&|])`）と同じ考え方で、直前の1文字が
 * 開始・`;`・`&`・`|`・改行のどれかであることだけを要求する。引用符の中の
 * `gh` は直前の文字が引用符そのもの（空白でも演算子でもない）なので、この
 * 条件だけで自然に落ちる —— `do`/`done` の弱さ（引用符の中の空白を演算子と
 * 区別できない）とは違い、`gh pr merge` の直前に来る文字は演算子か行頭しか
 * 認めていないので、`echo "gh pr merge …"` のような形は素通しできる。
 *
 * ## ヒアドキュメントだけは別扱いが要る（`stripHeredocs`）
 *
 * 改行はコマンド位置の印として扱っているので、ヒアドキュメントの本文の
 * 行頭もそのままでは「コマンド位置」に見えてしまう（本文の中の改行は
 * シェルにとって単なる文字であって、実際に新しいコマンドを始めてはい
 * ない）。引用符と違い、ヒアドキュメントは開始トークン（`<<'EOF'` 等）と
 * 終端トークン（行頭の `EOF`）を機械的に見分けられるので、検査の前に本文
 * を空白へ潰しておく。
 *
 * ## `timeout N ...` に包まれていても見る（この判定器だけの上乗せ）
 *
 * `isTimeoutWrapped` はモジュール全体の約束として「先頭が `timeout` なら
 * 中身がどんな形でも有界」と読むが、それは**待ちの形**についての約束で
 * あって、`gh pr merge --delete-branch` の危険（終わらないことではなく
 * 戻せないこと）には無関係である。`timeout 30 gh pr merge 123
 * --delete-branch` を「有界だから安全」と読むと、この検出器がまるごと
 * 迂回されてしまう。だから `timeout <数字><単位?>` 前置きは、下の
 * `LEADING_ENV_PREFIX_SRC`（コマンド位置と `gh` のあいだの前置き全体）の
 * 一部として読み飛ばす。**`timeout` 自身のオプション（`-k` / `--signal`
 * 等）までは解いていない** —— 見ているのは「`timeout` の直後が数字の
 * 継続時間である」という最も普通の書き方だけである（`isTimeoutWrapped`
 * 自身が継続時間の妥当性すら見ていないのと同じ単純さで揃えた）。
 *
 * ⚠️ **issue #1886 まではこれが2つの別の仕組みに分かれていた**——
 * `stripLeadingTimeout`（`TIMEOUT_PREFIX_RE`）が**コマンド文字列全体の
 * 先頭**の `[ENV=val...] timeout <数字><単位?>` だけを取り除き、この
 * 検出器自身は `&&` / `;` / `|` / 改行の**後ろ**のコマンド位置に来た
 * `timeout` を読み飛ばす手段を持っていなかった。⟹ `cd <dir> && timeout 20
 * gh pr merge <N> --squash --delete-branch` のように、AGENTS.md
 * 「自分が走っている器」が勧める `timeout <秒> …` の書き方そのものが
 * すり抜けていた（本番 runner での実測は issue #1886）。#1886 で
 * `stripLeadingTimeout`/`TIMEOUT_PREFIX_RE` を廃止し、同じパターン
 * （`TIMEOUT_COMMAND_PREFIX_SRC`）を `LEADING_ENV_PREFIX_SRC` へ統合した
 * ——これで文字列全体の先頭も `&&` 等の後ろのコマンド位置も、同じ1つの
 * 仕組みで読み飛ばされる（`hasGhPrMergeDeleteBranch` はもう前処理として
 * `timeout` を剥がさず、`GH_PR_MERGE_DELETE_BRANCH_RE` 自身がコマンド
 * 位置ごとに判定する）。
 *
 * ## `gh` の手前の環境変数・`timeout`・`env` 前置きも読み飛ばす（#1788 / #1886）
 *
 * `GH_TOKEN=xxx gh pr merge 123 --delete-branch` のように、コマンド位置と
 * `gh` のあいだに環境変数の代入（`NAME=値` の繰り返し）や `env` コマンド、
 * `timeout` 前置きを挟む形は日常的に書かれる（`gh` の認証トークンを都度
 * 指定する・待ちに上限を持たせる等）。以前はこの3つのうち環境変数と `env`
 * コマンドしか読み飛ばせず（issue #1788 の指摘で追加）、`timeout` は
 * コマンド文字列全体の先頭でしか読み飛ばせなかった（issue #1886 の指摘）。
 *
 * `LEADING_ENV_PREFIX_SRC` が読み飛ばすのは次の3つだけである —— (1) 環境
 * 変数の代入 (2) `timeout <数字><単位?>` (3) `env` コマンド。**この3つは
 * 順不同・回数任意で組み合わせられる**（`(?:A|T|E)*`）。
 *
 * ⚠️ **issue #1886 の最初の版はここを「代入 → `timeout` を1回だけ →
 * `env`」という固定順序でしか認めなかった**（確認した実例
 * `GH_PAGER=cat timeout 20 gh pr merge …` だけに絞って直した）。その版は
 * 「`timeout 20 GH_TOKEN=x gh pr merge …`」「`env FOO=1 timeout 20 gh pr
 * merge …`」のような別の並びを弾けないまま残し、しかもそのすり抜けを
 * テストで「未対応」として固定していた —— 固定順序に絞ったこと自体が、
 * 直したはずの穴の形を変えただけで穴そのものは残していた
 * （`bash-wait-guard-delete-branch-timeout-prefix.test.ts` の「前置きの
 * 並び順を問わず弾く」節）。**この版で順不同に直す。**
 *
 * 1. **単純な代入の繰り返し** —— `[A-Za-z_][A-Za-z0-9_]*=\S*`（**値の中に
 *    空白を含む引用符形（`X="a b" gh …`）は読み飛ばせない** —— `\S*` は
 *    最初の空白で区切るため、`"a` までしか値として拾えない。既存の簡略化
 *    と同じ弱さで、この PR で新しく増やした弱さではない）。
 * 2. **`timeout <数字><単位?>`** —— `TIMEOUT_COMMAND_PREFIX_SRC`。**回数の
 *    制限は無い**（`timeout 5 timeout 10 gh …` のような重複も、他の2つと
 *    混ざった並びも同じ1つの繰り返しが拾う）。
 * 3. **`env` コマンド** —— `env`（引数無しでそのまま次のコマンドを起動する
 *    形）・`env -u NAME ...` のような単純な形だけを見る。**`env` の直後の
 *    `NAME=値` はここでは読まない** —— 次の段落で理由を書く。`env` 自身の
 *    全オプション文法（`-i` の組み合わせ・`--split-string` 等）までは
 *    解いていない。
 *
 * ⚠️ **`ENV_COMMAND_PREFIX_SRC` の中で `env` の後ろの `NAME=値` まで読むと、
 * 後戻りが入力長に対して指数的に増える。** 3つの選択肢を無制限に繰り返す
 * `(?:A|T|E)*` の形では、ある位置から先の文字列を「代入の繰り返し」と
 * 「`env` コマンド1個（中に代入をいくつも含む）」のどちらに割り振るかが
 * 一意に決まらないと、同じ入力に対して指数個の分割が生まれる
 * （`env A=1 B=2 env A=1 B=2 …` を繰り返すほど、`env` 1個が代入を何個
 * 抱えるかの数え方が掛け算で増える）。**だから `env` の中では代入を読ま
 * ず、`env` の後ろの代入は常に外側の (1) の選択肢が読む**——これで3つの
 * 選択肢の先頭の語（`NAME=`・`timeout `・`env `）が互いに重ならなくなり、
 * ある位置でどの選択肢が読み進めるかが常に1通りに決まる（後戻りが要らな
 * い）。後戻りが増えないことは
 * `bash-wait-guard-delete-branch-timeout-prefix.test.ts` の
 * 「前置きの繰り返しが長くても後戻りで爆発しない」で測っている。
 *
 * どれも「コマンド位置の直後」でしか読み飛ばさない —— 読み飛ばしの開始
 * 位置そのものは既存の lookbehind（行頭・`;`・`&`・`|`・改行の直後）が決める
 * ので、引用符の中やヒアドキュメントの本文にこの形が現れても、開始位置の
 * 条件そのものは変わらず、素通しは維持される（`echo "GH_TOKEN=x gh pr merge
 * 1 --delete-branch"` は直前の文字が `"` なので引き続き通る）。
 *
 * ## `--subject` / `-t` / `--body` / `-b` の値の引用符の中は読み飛ばす（issue #1910）
 *
 * PR の件名・本文にガード自身の名前（`--delete-branch` という字面）を書くと、
 * `gh pr merge 1887 --subject "fix: … --delete-branch ガードが…" --body-file f`
 * のように、**フラグとしては付いていない**のに上の「コマンド位置の直後を
 * 素通しできない」だけの理由で弾かれていた（実測は issue #1910 本文。
 * PR の件名は `.claude/skills/pr-merge/SKILL.md` の約束でタイトルから作るので、
 * ガードそのものを直す PR ほど踏みやすい）。
 *
 * **これはガードを緩める変更なので、すり抜けを1つも作らないことを最優先
 * にする。** だから潰す範囲は最小に絞ってある —— 潰すのは `gh pr merge` の
 * `--subject` / `-t` / `--body` / `-b`（`--subject=…` / `--body=…` の形も）の
 * **値として渡された、引用符で閉じている区間の中身だけ**である。
 *
 * - **単一引用符（`'…'`）はそのまま安全に閉じ位置が分かる。** bash の単一
 *   引用符にはエスケープの仕組みが無い（`\` も含めて中の文字はすべて
 *   リテラル）ので、次に現れる `'` が機械的に閉じ引用符である
 *   （`SINGLE_QUOTED_VALUE_SRC` = `'[^']*'`）。
 * - **二重引用符（`"…"`）は、中にバックスラッシュ・`$`・バッククォートの
 *   どれか1つでもあれば潰さない。** bash の二重引用符は `\"` を「値の中の
 *   エスケープされた `"`」として読み、`$(...)`/`` `...` `` を実際に
 *   コマンド置換として実行するが、この検出器は shell の構文解析器では
 *   ないので、エスケープや実行結果を正しく辿れる保証が無い。**「読めない」
 *   と判断したら潰さない側（弾く側）へ倒す**（`DOUBLE_QUOTED_VALUE_SRC` =
 *   `` "[^"\\$\u0060]*" `` —— これらの文字を含む時点で不一致になり、その
 *   区間は素の文字列のまま残って、中に本物の `--delete-branch` の字面が
 *   在れば引き続き検出される。`$`/バッククォートを含める経緯は下の
 *   「二重引用符の値の中のコマンド置換は『読めない』として潰さない」参照）。
 *   同じ理由で、**閉じていない引用符**（終端が無い）も一致しないので潰さ
 *   ない。
 * - **潰す範囲は `gh pr merge` の呼び出し区間で絞っていない —— コマンド文字列
 *   全体から `--subject`/`-t`/`--body`/`-b` の直後の引用符を探す。** 最初は
 *   検出本体（`GH_PR_MERGE_DELETE_BRANCH_RE`）と同じ「`;`/`&&`/`||`/`|`/改行の
 *   手前までの呼び出し区間」を先に切り出してから中を探す形にしていたが、
 *   issue #1910 の**実例そのもの**（件名の値の中に `&&` を含む）でそれが
 *   壊れた —— 区間の切り出し自体が「引用符を追跡しない」設計なので、値の
 *   中の `&&` を本物の区切りと誤読して区間をそこで打ち切ってしまい、値の
 *   本当の閉じ引用符（`&&` より後ろ）へ届かなかった。詳しい経緯は
 *   `SUBJECT_BODY_QUOTED_VALUE_RE` の doc に書いた。**区間で絞らなくても
 *   安全な理由**: この置換は `--subject`/`-t`/`--body`/`-b` の直後に来た、
 *   きれいに閉じている引用符の中身しか潰さない。`gh pr merge` と無関係な
 *   箇所に当たっても、潰すのは引用符の中身だけで、`GH_PR_MERGE_DELETE_
 *   BRANCH_RE` が実際に見る「`gh pr merge` から次の境界まで」の外側の判定
 *   には触れない——本物の `--delete-branch`/`-d`（引用符の外に在るもの）を
 *   見逃す経路にはならない。
 * - **フラグの直前は行頭・空白のどちらかであることを要求する**
 *   （`SUBJECT_BODY_LONG_FLAG_SRC` / `SUBJECT_BODY_SHORT_FLAG_SRC` の
 *   lookbehind）。`--subject-t "…"` のような、たまたま `-t` という部分
 *   文字列を含む無関係な語を `-t` フラグと誤認しないため。
 * - **引用符そのものは残し、中身だけを空白へ潰す。** 潰した後も
 *   `--subject " "` のような形は残るので、`GH_PR_MERGE_DELETE_BRANCH_RE` が
 *   `--subject` という語自体を誤検知することはない（そもそもそこは見ていな
 *   い）。
 *
 * ⚠️ **意図して直していない・確かめていない形**（すり抜けを作らない方向の
 * 保守的な選択であり、下の「弾けないと分かっている形」の一部と重なる）:
 *
 * - **`'a'\''b --delete-branch'` のような、単一引用符を跨いで連結した値。**
 *   bash はこれを1つの引数として結合するが、この検出器は最初の `'…'` の
 *   区間しか潰さない。残りの区間（`\''b --delete-branch'`）はそのまま残り、
 *   本物の `--delete-branch` の字面が引き続き検出される —— **誤検知が残る
 *   側（安全側）へ倒れる**（確認済み、テストには含めていない・稀な形と
 *   判断）。
 * - **値のクオートを跨がず直後に別の語が連結する形**
 *   （`--subject 'x'--delete-branch` のように空白を挟まない結合）。同様に
 *   最初の `'x'` だけが潰され、連結した残りは検出対象のまま残る（安全側）。
 *
 * ## 二重引用符の値の中のコマンド置換は「読めない」として潰さない（PR #1990 レビュー指摘）
 *
 * 上の版は `DOUBLE_QUOTED_VALUE_SRC` が `\` だけを除外していて、`$` と
 * バッククォート（`` ` ``）を除外していなかった。**これは重大な見落とし
 * だった** —— 二重引用符は bash の変数展開・コマンド置換をそのまま素通し
 * するので、`--subject "$(gh pr merge 2 --delete-branch)"` や `--body
 * "` + "`" + `gh pr merge 2 -d` + "`" + `"`（レガシーのバッククォート）の
 * ような値は「ただの文字列」ではなく、**bash が中身を実際にコマンドとして
 * 実行してから、その出力へ置き換える。** 前の版はこの区間を「きれいに
 * 閉じた引用符」と誤認して中身ごと空白へ潰してしまい、実際に実行される
 * `gh pr merge --delete-branch`/`-d` を検出器の目から消していた（レビュー
 * で指摘され、テストの赤で再現した——
 * `bash-wait-guard-delete-branch-quoted-values.test.ts` の「二重引用符の
 * 値の中のコマンド置換は…」節）。
 *
 * ⟹ `\` と同じ「読めない」の族に `$` とバッククォートも加えた
 * （`DOUBLE_QUOTED_VALUE_SRC` = `` "[^"\\$\u0060]*" ``。`\u0060` は
 * バッククォートの unicode エスケープ —— テンプレートリテラルの中に生の
 * バッククォードを書くと構文が終端してしまうため）。値の中に `$` や
 * バッククォートが1つでもあれば潰さず、元の文字列がそのまま残る。
 *
 * ⚠️ **これだけでは足りない例が在った**（`--body` + バッククォート +
 * 短縮フラグ `-d` の組み合わせ）。「潰さない」だけでは、残った生の文字列
 * `` `gh pr merge 2 -d` `` の中の `-d` を `GH_PR_MERGE_DELETE_BRANCH_RE`
 * 自身が検出できるとは限らない —— 元々の `-d` の末尾条件
 * `(?=[\s;&|]|$)` は「空白・`;`・`&`・`|`・文字列末尾」しか終端と認めておら
 * ず、直後がバッククォートや `)`（`$(...)` の閉じ括弧）だと一致しない
 * （実際に赤いテストで確認した）。⟹ `--delete-branch\b` と同じ「語境界
 * （`\b`）」に揃え、`(?<=[\s])-d(?=[\s;&|]|$)` を `(?<=[\s])-d\b` に直した。
 * `\b` は「直前が単語構成文字、直後が単語構成文字でないか文字列末尾」を
 * 見るだけなので、バッククォート・`)`・引用符・句読点など、空白でも
 * `;`/`&`/`|` でもない非単語文字の直後にも当たるようになる——**既存の
 * 除外（`-dev` のように直後が英数字の場合に誤爆しないこと）はそのまま
 * 保たれる**（`e`/`v` は単語構成文字なので `\b` は成立しない。歯は
 * `bash-wait-guard.test.ts` の「-d を含む別の語（-dev 等）と誤認しない」）。
 *
 * ⚠️ **このバックティック/`$()` の話は、issue #1991（作業中に見つけた
 * 別件——素で引用符に囲まれた短縮フラグ `"-d"`/`'-d'` がすり抜ける）とは
 * 別の穴である。** #1991 は `-d` の**手前**（lookbehind、直前が引用符だと
 * 空白と認められない）の話で、ここで直したのは `-d` の**後ろ**
 * （lookahead/`\b`、直後がバッククォート等だと終端と認められない）の話。
 * 手前の穴（#1991）はこの PR でも直していない——`"-d"`/`'-d'` は
 * このコマンド置換の修正とは無関係にすり抜けたままである（下のテストで
 * 対照している）。
 *
 * ## ⚠️ この検出器が弾けないと分かっている形
 *
 * - **`bash -c '…'` の中。** 構文（コマンド位置）しか見ていないので、
 *   単一引用符の中の `gh pr merge --delete-branch` は「引用符の中」という
 *   条件だけで素通しされる。これは他の文字列だけを読む判定器と同じ限界
 *   であり、この PR でも直していない（歯は
 *   `bash-wait-guard.test.ts` の末尾に明記する）。
 * - **⚠️ `gh pr merge 1 "-d"` / `gh pr merge 1 '-d'` のように、`--subject` /
 *   `--body` の値ではなく素で引用符に囲まれた短縮フラグ `-d`。** issue #1910
 *   の作業中に見つけた、**この PR とは無関係な既存の穴**（この PR が作った
 *   ものでも、この PR で直すものでもない）。`-d` の検出
 *   （`(?<=[\s])-d(?=[\s;&|]|$)`）は直前が空白であることを要求するが、
 *   `"-d"` は直前が引用符でありシェルが引用符を剥がした後の実引数は
 *   リテラルの `-d`（本物のフラグ）である。長い形の `--delete-branch\b` は
 *   この lookbehind を持たないため同じ形でも引き続き弾く（対照は
 *   `bash-wait-guard-delete-branch-quoted-values.test.ts`）。issue #1991 で
 *   報告した（AGENTS.md「範囲外でも気づいたことは上げる」）。
 * - **`--delete-branch=false` のような明示的な無効化。** `\b` は文字種の
 *   境界でしか見ないので、`--delete-branch` の直後が `=false` でも弾く
 *   （確かめていない・稀な形と判断して対応していない）。
 * - **`-sd` のような短縮オプションの束ね書き。** `-d` は前後が空白/演算子/
 *   端であることを要求するので、他の短縮フラグと連結した形（`gh` の
 *   フラグパーサが許すかどうかも含め未確認）は弾けない。
 * - **`timeout` に `-k` 等のオプションが付いた形**
 *   （`timeout -k 5 30 gh pr merge 123 --delete-branch`）。直上の doc の
 *   とおり、`timeout` 自身のオプション文法までは解いていない。
 * - **代入の値が空白を含む引用符形（`X="a b" gh pr merge …`）。** 直上
 *   「`gh` の手前の環境変数・`timeout`・`env` 前置きも読み飛ばす」の doc の
 *   とおり、値パターンが `\S*` なので空白の手前までしか代入として読めない
 *   （既存の簡略化）。
 * - **`gh api -X DELETE …/git/refs/heads/<branch>`・`git push origin
 *   --delete <branch>`・`git push origin :<branch>`。** これらは
 *   `gh pr merge --delete-branch` と同じ実害（枝を消し、積んだ PR を
 *   黙って閉じる）に達しうるが、この検出器の対象は issue #1764 が
 *   明記したとおり「`gh pr merge` の呼び出し」に絞られている。1件ずつ
 *   検討して足す方針（#1192 のオーナー決定）のため、issue #1788 の指摘は
 *   ここへ記録するに留め、この PR では歯を足していない。
 * - **`sudo` / `nice` / `xargs` など `timeout` 以外の前置き。** issue #1886
 *   の「確かめていないこと」に明記されたとおり、この PR は `timeout` だけを
 *   扱う（1件ずつ検討する方針、#1192 のオーナー決定）。
 * - ~~`timeout 1.` のような、末尾が `.` で終わる小数の継続時間。~~ issue
 *   #1933 で `\d+(?:\.\d+)?|\.\d+` に直したが、この形（整数の直後に `.` が
 *   在り、その後ろに数字が無い）はどちらの選択肢にも一致しなかった。GNU の
 *   `timeout` は受ける（実測: `timeout 1. true` は exit 0）ため、稀な書き方
 *   と判断してその版では対応していなかった。**⚠️ PR #1939 のレビューで
 *   指摘のとおり、これは #1933 と同じ穴（小数の継続時間）の残りを doc に
 *   書いて残しているだけだった。** `\d+(?:\.\d+)?` を `\d+(?:\.\d*)?`
 *   （小数点の後ろが0桁でもよい）に直し、この版で塞いだ——もうこの検出器は
 *   弾く（歯は `bash-wait-guard-delete-branch-timeout-prefix.test.ts` の
 *   「末尾が `.` で終わる小数」）。**取り消し線のまま残すのは、次に同じ
 *   形の「稀だから対応しない」という判断をしそうになったとき、一度それで
 *   済ませて差し戻された経緯を読めるようにするためである。**
 */
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=[\s;&|]|$)/g;

/**
 * ヒアドキュメントの本体（開始トークン〜終端トークンまで全体）を、改行を
 * 残したまま空白へ潰す。オフセットを使う後続処理は無いので長さを保つ必要は
 * 無いが、この関数の入力を別の検査へ流用しても混乱しないよう保守的にそう
 * している。
 *
 * ⚠️ **完全な shell 構文解析ではない。** ネストしたヒアドキュメント・
 * `<<~`（インデント除去）等は個別に見ていない（`<<-` の `-` 自体は
 * トークンとして読むので、その形自体は拾える）。
 */
function stripHeredocs(command: string): string {
  return command.replace(HEREDOC_RE, (matched) => matched.replace(/[^\n]/g, ' '));
}

/**
 * `NAME=値` 形の代入の値の部分——末尾の空白は含まない（呼び出し側が `\s+` を
 * 付けて繰り返す）。**値の中に空白を含む引用符形（`X="a b"`）は最初の空白
 * までしか読めない**——`\S*` は最初の空白で区切るため
 * （doc「`gh` の手前の環境変数・`timeout`・`env` 前置きも読み飛ばす」の
 * 弱さの節）。
 */
const ENV_ASSIGNMENT_BODY_SRC = String.raw`[A-Za-z_][A-Za-z0-9_]*=\S*`;

/** `ENV_ASSIGNMENT_BODY_SRC` に末尾の空白を1個以上足した、繰り返し単位。 */
const ENV_ASSIGNMENT_SRC = String.raw`${ENV_ASSIGNMENT_BODY_SRC}\s+`;

/**
 * `timeout <数字><単位?>` 前置き（doc「`timeout N ...` に包まれていても
 * 見る」）。**issue #1886 より前は、これと同じパターンが `TIMEOUT_PREFIX_RE`
 * としてコマンド文字列全体の先頭（`stripLeadingTimeout` 経由）でしか使わ
 * れておらず、`&&` 等の後ろのコマンド位置では読み飛ばせなかった。**
 * `LEADING_ENV_PREFIX_SRC` へ統合したことで、コマンド位置ならどこでも同じ
 * 1つのパターンが効く。**このパターン自体は1回ぶんの一致であって、繰り返す
 * かどうかは呼び出し元の `LEADING_ENV_PREFIX_SRC` 側の `(?:A|T|E)*` が決め
 * る**（代入・`env` コマンドと順不同・回数任意で組み合わさる）。`timeout`
 * 自身のオプション（`-k` 等）までは解いていない——直後が数字の継続時間で
 * ある最も普通の書き方だけを見る。
 *
 * ⚠️ **issue #1933（#1886 の続き）——継続時間は小数（浮動小数点）も認める。**
 * 以前は `\d+[a-zA-Z]*` で整数の継続時間しか読み飛ばせず、`timeout 1.5m` /
 * `timeout 0.5h` のような小数の継続時間の前置きは読み飛ばせなかった（`1` の
 * 直後の `.` が `[a-zA-Z]` にも `\s` にも当たらないため、`gh` の手前がこの
 * パターンの一致で終わらず検出器自体が一致しない＝弾けない）。GNU
 * coreutils の `timeout` は継続時間に小数を受け付ける（この器で実測、
 * `timeout 9.7`。`timeout 1.5m true` / `timeout 0.5h true` / `timeout .5s
 * true` はいずれも exit 0）。⟹ 継続時間を `\d+(?:\.\d+)?|\.\d+`（整数・
 * 「整数.小数」・先頭が `.` の小数のいずれも認め、`.` 単独は認めない）に
 * 直した。二者択一の先頭の文字（数字 / `.`）が重ならないので、直上の
 * 「後戻りが指数的に増えない設計」（3つの前置きの選択肢の先頭の語が互いに
 * 重ならない）は崩していない。
 *
 * ⚠️ **PR #1939 のレビュー指摘——`1.`（末尾が `.` で終わる形）も同じ穴の
 * 残りだった。** 上の版は「`1.` は GNU が受けるが対応していない」と書いて
 * いたが、これは #1933 が挙げた「小数の継続時間」という同じ穴を doc に
 * 書いて残しているだけで、直したことにはならない。⟹ 整数側の選択肢を
 * `\d+(?:\.\d*)?`（小数点の後ろが0桁でもよい）に直し、`1` / `1.5` / `1.`
 * のいずれも先頭が数字の側で読めるようにした。`.5` は引き続き先頭が `.` の
 * 側（`\.\d+`。こちらは小数点の後ろに最低1桁を要求するので `.` 単独には
 * 一致しない）。**2つの選択肢は先頭の文字（数字 / `.`）で排他のままであり、
 * 後戻りが指数的に増えない設計は変わらず保たれている。**
 */
const TIMEOUT_COMMAND_PREFIX_SRC = String.raw`timeout\s+(?:\d+(?:\.\d*)?|\.\d+)[a-zA-Z]*\s+`;

/**
 * `env` コマンド経由の単純な前置き —— `env`（引数無し）・
 * `env -u NAME ...` の形だけを見る。`env` 自身の全オプション文法までは
 * 解いていない（doc 参照）。
 *
 * ⚠️ **ここで `env NAME=値 ...` の `NAME=値` を読まない（`ENV_ASSIGNMENT_
 * BODY_SRC` を含めない）のは意図的である。** `LEADING_ENV_PREFIX_SRC` の
 * `(?:代入|timeout|env)*` は、同じ入力を複数の分割で読めてしまうと後戻り
 * が指数的に増える（`env A=1 B=2 env A=1 B=2 …` の繰り返しで、代入をどの
 * `env` に何個ぶら下げるかの数え方が掛け算で増える）。`env` の中で代入を
 * 読まなければ、`env` の後ろの代入は必ず外側の代入の選択肢が拾うことに
 * なり、ある位置でどの選択肢が読み進めるかが一意に決まる（後戻りが要らな
 * い）。詳しくは `LEADING_ENV_PREFIX_SRC` の doc。
 */
const ENV_COMMAND_PREFIX_SRC = String.raw`env\b\s+(?:-u\s+\S+\s+)*`;

/**
 * コマンド位置と `gh` のあいだで読み飛ばす前置き全体 —— 単純な代入の繰り返し
 * ・`timeout <数字><単位?>`・`env` コマンドの3つを、**順不同・回数任意**で
 * 読み飛ばす（すべて0回でよい＝前置きが無い既存の形もそのまま一致する）。
 *
 * ⚠️ **issue #1886 の最初の版はここを固定順序（代入 → `timeout` を1回だけ
 * → `env`）に絞っていた**——確かめた実例（`GH_PAGER=cat timeout 20 gh pr
 * merge …`）の順序だけを直し、それ以外の並び（`timeout 20 GH_TOKEN=x gh …`
 * ・`env FOO=1 timeout 20 gh …`）は「未対応」としてテストで固定していた。
 * しかしこの3つはどれも `gh pr merge --delete-branch` へ辿り着く前に読み
 * 飛ばされるべき前置きであって、特定の並びだけを認める理由が無い——固定
 * 順序は直したはずの穴の形を変えただけで、穴自体は残っていた。**この版で
 * `(?:A|T|E)*` に直し、3つを任意の順序・任意の回数で組み合わせられるよう
 * にした。**
 *
 * 後戻りが入力長に対して指数的に増えないのは、3つの選択肢の先頭の語
 * （`NAME=`・`timeout `・`env `）が互いに重ならないため——`ENV_COMMAND_
 * PREFIX_SRC` の doc に理由を書いた。
 */
const LEADING_ENV_PREFIX_SRC = String.raw`(?:${ENV_ASSIGNMENT_SRC}|${TIMEOUT_COMMAND_PREFIX_SRC}|${ENV_COMMAND_PREFIX_SRC})*`;

const GH_PR_MERGE_DELETE_BRANCH_RE = new RegExp(
  String.raw`(?<=^|[;&|\n])[ \t]*${LEADING_ENV_PREFIX_SRC}gh\s+pr\s+merge\b(?:(?!;|&&|\|\||\||\n)[\s\S])*?(?:--delete-branch\b|(?<=[\s])-d\b)`,
);

/**
 * 二重引用符の値 —— 中に `"` / `\` / `$` / バッククォート（`` ` ``）の
 * どれも含まない区間だけを一致とする。
 *
 * - `\` を含む時点で不一致になるのは意図的（doc「二重引用符は、中に
 *   バックスラッシュが1つでもあれば潰さない」）。
 * - `$` / バッククォートを含む時点で不一致になるのも同じ理由（doc「二重
 *   引用符の値の中のコマンド置換は『読めない』として潰さない」、PR #1990
 *   レビュー指摘）—— 二重引用符の中では bash が `$(...)` / `` `...` ``
 *   を実際に実行するので、これらを含む区間は「ただの文字列」ではなく
 *   「読めない（潰したら実行される中身を見失う）」側へ倒す。
 * - `\u0060` はバッククォートの unicode エスケープ。テンプレートリテラル
 *   （`String.raw` の中）に生のバッククォート文字を書くとリテラル自体が
 *   終端してしまうため、エスケープ表記を使っている。
 */
const DOUBLE_QUOTED_VALUE_SRC = String.raw`"[^"\\$\u0060]*"`;

/** 単一引用符の値 —— bash にエスケープの仕組みが無いので、次の `'` が必ず閉じ引用符。 */
const SINGLE_QUOTED_VALUE_SRC = String.raw`'[^']*'`;

const QUOTED_VALUE_SRC = String.raw`(?:${DOUBLE_QUOTED_VALUE_SRC}|${SINGLE_QUOTED_VALUE_SRC})`;

/** `--subject` / `--body`（`=` または空白区切り）。直前は行頭か空白のみ認める。 */
const SUBJECT_BODY_LONG_FLAG_SRC = String.raw`(?<=^|[\s])(?:--subject|--body)(?:=|\s+)`;

/** `-t` / `-b`（空白区切りのみ——短縮形に `=` の形は扱わない）。直前は行頭か空白のみ認める。 */
const SUBJECT_BODY_SHORT_FLAG_SRC = String.raw`(?<=^|[\s])(?:-t|-b)\s+`;

const SUBJECT_BODY_FLAG_SRC = String.raw`(?:${SUBJECT_BODY_LONG_FLAG_SRC}|${SUBJECT_BODY_SHORT_FLAG_SRC})`;

/**
 * `--subject`/`-t`/`--body`/`-b` の値として渡された、きれいに閉じている
 * 引用符を見つける（フラグ部分と値部分を別の capture group で持つ ——
 * 置換のときにフラグ部分はそのまま残し、値の中身だけを潰すため）。
 *
 * ⚠️ **`gh pr merge` の呼び出し区間で範囲を絞っていない**（issue #1910の
 * 実装時に一度絞ったが、実例そのもので壊れたため外した——次の doc
 * 「なぜ `gh pr merge` の呼び出し区間で絞らないか」参照）。
 */
const SUBJECT_BODY_QUOTED_VALUE_RE = new RegExp(
  String.raw`(${SUBJECT_BODY_FLAG_SRC})(${QUOTED_VALUE_SRC})`,
  'g',
);

/** 引用符で囲まれた値の中身だけを空白へ潰す。引用符自体（先頭・末尾の1文字）は残す。 */
function blankQuotedValueInterior(quoted: string): string {
  const interior = quoted.slice(1, -1).replace(/[^\n]/g, ' ');
  return quoted[0] + interior + quoted[quoted.length - 1];
}

/**
 * `computeOutsideQuoteMask` が返す、走査位置ごとの状態。
 *
 * - `outside`: どちらの引用符の中にも居ない（bash の「素の」構文位置）
 * - `single`: 単一引用符の中
 * - `double`: 二重引用符の中
 * - `unknown`: これ以上は確信を持って追えない（末尾がバックスラッシュで
 *   終わる等）。**一度なったら残り全部が `unknown` のまま**（sticky）。
 */
type OutsideQuoteScanState = 'outside' | 'single' | 'double' | 'unknown';

/**
 * `command` の各文字位置について、「その位置の**直前まで**実際に bash の
 * 引用符規則で追った結果、引用符の外（`outside`）だと確信できるか」を表す
 * 真偽値の配列を返す（issue #1910 のレビュー指摘・指摘3、PR #1990）。
 *
 * ## なぜこれが要るか
 *
 * `SUBJECT_BODY_QUOTED_VALUE_RE` はコマンド文字列全体に対して素朴な正規
 * 表現一致で当たるだけで、**引用符の開き閉じそのものを追っていない**。
 * そのため、単一引用符（または二重引用符）の**中に書かれた** `--subject "`
 * （または `-t '`）という**字面**を、本物のフラグ+開き引用符だと誤読
 * できる。実例（bash の実際の argv 分割を `argv-dump.sh` で検証済み、
 * `bash-wait-guard-delete-branch-quoted-values.test.ts` に生出力の要約が
 * ある）:
 *
 * ```
 * gh pr merge 1 x'y --subject "' --delete-branch '"'
 * ```
 *
 * bash の読み: `x` + 単一引用符 `'y --subject "'`（1つの引数に結合）+
 * **本物の、引用符無しの `--delete-branch`** + 単一引用符 `'"'`。
 *
 * 正規表現の読み（このマスクが無い版）: `--subject ` の直後に来た `"`
 * （単一引用符の中の、ただの文字としての `"`）を開き引用符と誤認し、次の
 * `"`（末尾の単一引用符 `'"'` の中の `"`）までを二重引用符の値だと思い込み、
 * その中身（本物の `--delete-branch` を含む）を丸ごと空白へ潰してしまう。
 *
 * ⟹ 上の「区間で絞ることをやめても安全な理由」（`gh pr merge` の呼び出し
 * 区間で絞らなくても、引用符の外側の文字には触れないから安全、という説明）
 * は**不十分だった**——「引用符の外側」かどうかを正規表現の見た目でしか
 * 判定しておらず、**本物の引用符の中に書かれた字面が作る「偽の引用符」**
 * まで「外側」と誤認しうることを見落としていた。
 *
 * ## 状態機械の規則（bash の実際の引用符規則をなぞる）
 *
 * - `outside`（引用符の外）: `\` は直後の1文字を無条件にエスケープして
 *   読み飛ばす（2文字消費、状態は `outside` のまま）。`'` で `single` へ、
 *   `"` で `double` へ遷移する。それ以外はただの文字。
 * - `single`（単一引用符の中）: bash の単一引用符にはエスケープの仕組みが
 *   無いので、次の `'` が無条件に閉じ引用符（`outside` へ戻る）。それ以外は
 *   （`"` も `\` も）すべてただの文字。
 * - `double`（二重引用符の中）: `\` は直後の1文字を読み飛ばす（2文字消費、
 *   状態は `double` のまま——bash は `\"`/`\\`/`` \` ``/`\$` 等だけを特別
 *   扱いするが、この状態機械はより保守的に「バックスラッシュの直後は常に
 *   エスケープ」として扱う。過剰に読み飛ばす分には「閉じ引用符を早めに
 *   認識しすぎる」方向にしか倒れず、`outside` と誤認する方向には倒れない
 *   ——安全側）。それ以外の `"` で `outside` へ戻る。
 * - **末尾がバックスラッシュで終わる**（エスケープする相手の文字が無い）
 *   場合は `unknown` へ遷移し、**以降ずっと `unknown` のまま**（sticky）。
 *   `unknown` の位置は「外側だと確信できない」ので `false` を返す——弾く側
 *   に倒す。
 *
 * ## なぜフラグの開始位置だけ見ればよいか
 *
 * `--subject`/`-t`/`--body`/`-b` という字面自体、`=`、空白のどれも引用符・
 * バックスラッシュを含まない。⟹ フラグの開始位置の状態が `outside` なら、
 * その直後（フラグ+区切りぶん進んだ、実際の引用符が始まる位置）の状態も
 * 同じ `outside` のまま——別々に確かめる必要が無い。
 *
 * ## 完全な shell 構文解析ではない
 *
 * `$(...)`/`` `...` ``（コマンド置換）の中身は、bash では新しい構文解析
 * 文脈として扱われる（中の引用符はその文脈の中で閉じていればよい）。この
 * 状態機械はその入れ子を認識せず、コマンド置換の中の引用符も外側と地続き
 * の1本の状態として追う。**引用符が中で正しく閉じている（バランスが取れ
 * ている）普通の書き方なら、これでも実質的に同じ結果になる**——このファ
 * イル全体が「完全な shell 構文解析器ではない」前提（doc 冒頭）の上に
 * 立っており、意図的に踏み込まない。
 */
function computeOutsideQuoteMask(command: string): boolean[] {
  const mask: boolean[] = new Array(command.length);
  let state: OutsideQuoteScanState = 'outside';
  for (let i = 0; i < command.length; i++) {
    mask[i] = state === 'outside';
    if (state === 'unknown') continue;
    const ch = command[i];
    if (state === 'outside') {
      if (ch === '\\') {
        if (i + 1 >= command.length) {
          state = 'unknown';
        } else {
          i += 1;
        }
      } else if (ch === "'") {
        state = 'single';
      } else if (ch === '"') {
        state = 'double';
      }
    } else if (state === 'single') {
      if (ch === "'") state = 'outside';
    } else if (state === 'double') {
      if (ch === '\\') {
        if (i + 1 >= command.length) {
          state = 'unknown';
        } else {
          i += 1;
        }
      } else if (ch === '"') {
        state = 'outside';
      }
    }
  }
  return mask;
}

/**
 * `--subject`/`-t`/`--body`/`-b` の値として渡された、きれいに閉じている
 * 引用符の中身だけを、コマンド文字列全体から空白へ潰す（issue #1910）。
 *
 * ## なぜ `gh pr merge` の呼び出し区間で絞らないか
 *
 * 最初の実装は「`gh pr merge` の呼び出し区間（`GH_PR_MERGE_DELETE_BRANCH_RE`
 * と同じ、`;`/`&&`/`||`/`|`/改行の手前までの区間）を先に切り出し、その中だけで
 * 値の引用符を探す」形だった。だが issue #1910 の**実例そのもの**
 * （`--subject "fix: … --delete-branch ガードが && 後の timeout 前置きを
 * 弾かない (#1887)" --body-file f`）が、値の中に `&&` を含んでいた。呼び出し
 * 区間の切り出しはこのモジュール全体と同じ「引用符を追跡しない」設計
 * （`gh-pr-merge-delete-branch` の doc「弾けないと分かっている形」の
 * `bash -c '…'` の項と同根）なので、値の中の `&&` を本物のコマンド区切りと
 * 誤読して区間をそこで打ち切ってしまい、値の本当の閉じ引用符（`&&` より
 * 後ろ）へ届く前に区間が終わっていた。**結果、実例そのものが直らなかった**
 * （実装中に自分のテストで踏んだ——`bash-wait-guard-delete-branch-quoted-values.test.ts`
 * の「Issue #1910 の実例」が、区間切り出し版では赤のままだった）。
 *
 * ⟹ 区間切り出しをやめ、**コマンド文字列全体**に対して直接
 * `SUBJECT_BODY_QUOTED_VALUE_RE` を当てる形にした。引用符の中身を探す正規表現
 * （`[^"\\]*` / `[^']*`）はもともと `&`/`;`/`|` を特別扱いしていない —— 次の
 * 閉じ引用符が来るまでをそのまま値として読むので、値の中に演算子の字面が
 * 在っても正しく閉じ位置まで読める。
 *
 * ⚠️ **ただし区間で絞らないことの安全性の説明は、当初これだけでは不十分
 * だった**（PR #1990 のレビュー指摘・指摘3）。「引用符の外側の文字には
 * 一切触れない」という主張は、正規表現の見た目上の引用符しか見ておらず、
 * **本物の引用符の中に書かれた字面が作る「偽の `--subject "`/`-t '`」**
 * まで「外側の本物のフラグ」と誤読しうることを見落としていた（実例・
 * 直し方は `computeOutsideQuoteMask` の doc）。⟹ 潰す前に、一致した位置が
 * `computeOutsideQuoteMask` で「引用符の外」だと確信できるかを確かめ、
 * 確信できないときは（区間の内外を問わず）潰さない。
 *
 * **潰さない（＝弾く側に倒す）場合**: 二重引用符の中にバックスラッシュが
 * 在る（エスケープを含みうるので「読めない」と判断する）・引用符が閉じて
 * いない・そもそも `--subject`/`-t`/`--body`/`-b` の値として引用符が来て
 * いない・**一致した `--subject`/`-t`/`--body`/`-b` の字面が、実際には
 * 別の（本物の）引用符の中に在る**（今回加えた条件）。これらはこの関数が
 * 元の文字列をそのまま残すので、中に本物の `--delete-branch`/`-d` の字面が
 * 在れば引き続き検出される。
 */
function stripGhPrMergeQuotedSubjectBodyValues(command: string): string {
  const outsideQuoteMask = computeOutsideQuoteMask(command);
  return command.replace(
    SUBJECT_BODY_QUOTED_VALUE_RE,
    (whole: string, flagPart: string, value: string, offset: number) => {
      if (!outsideQuoteMask[offset]) return whole;
      return flagPart + blankQuotedValueInterior(value);
    },
  );
}

function hasGhPrMergeDeleteBranch(command: string): boolean {
  const withoutHeredocs = stripHeredocs(command);
  const withoutQuotedSubjectBodyValues = stripGhPrMergeQuotedSubjectBodyValues(withoutHeredocs);
  return GH_PR_MERGE_DELETE_BRANCH_RE.test(withoutQuotedSubjectBodyValues);
}

/**
 * `Bash` ツールの呼び出しのうち、コマンド文字列に現れない事実。
 *
 * **省略時は「背景ではない」に倒す**（fail-open）。呼び出し側が形の崩れた
 * 入力を受け取ったときも、ここへ `undefined` が来て**通す**側へ倒れる。
 */
export interface BashInvocation {
  /** `Bash` ツールの `run_in_background` が真であるか。 */
  readonly backgrounded?: boolean;
}

/**
 * `Bash` の `command` 文字列を検査する。
 *
 * **純関数。** I/O もプロセスの状態も見ない —— 文字列だけを見て判定する。
 */
export function inspectBashCommand(
  command: string,
  invocation: BashInvocation = {},
): WaitGuardVerdict {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { blocked: false };

  // `gh pr merge --delete-branch` は「無限待ち」とは害の種類が違う
  // （終わらないことではなく、終わった後に戻せないこと）ので、
  // `timeout` ラップの早期 return より先に見る。`timeout 30 gh pr merge
  // 123 --delete-branch` は待ちを有界にするだけで、PR を巻き添えで
  // 閉じる危険は1文字も消えない —— ここで先に見ないと、下の
  // `isTimeoutWrapped` がこの形を「有界だから安全」と誤読して素通しする。
  if (hasGhPrMergeDeleteBranch(trimmed)) {
    return {
      blocked: true,
      form: 'gh-pr-merge-delete-branch',
      reason:
        '`gh pr merge` に `--delete-branch`（または `-d`）が付いている。' +
        '**取り返しが付かない** —— この枝を base にしている PR が在ると、' +
        'マージと同時にその PR も黙って閉じ、閉じたあとは `reopen` も `--base` の' +
        '付け替えも拒まれる' +
        '（実測 2026-09-15T07:3xZ、PR #1008 と #1010。' +
        '`.claude/skills/tool-quirks/SKILL.md` に生出力が在る）。' +
        '代わりに次を使うこと: `--delete-branch` を外して打つ' +
        '（この repo は `delete_branch_on_merge` でマージ後に枝を消すので、' +
        '付けなくても枝は消える。積んだ PR が在るなら、先に依存側の base を' +
        '`gh pr edit <N> --base main` で付け替えてから base 側をマージすること）。',
    };
  }

  // 全体が timeout に包まれていれば、中身がどんな形でも有界だと読める
  // （待ちの形についてのみ。上の delete-branch はこの早期 return より先に
  // 見ているので、ここでは影響されない）。
  if (isTimeoutWrapped(trimmed)) return { blocked: false };

  if (isBackgroundedGhRunWatch(trimmed, invocation.backgrounded === true)) {
    return {
      blocked: true,
      form: 'gh-run-watch-background',
      reason:
        '`gh run watch` を背景へ置いている' +
        '（`&` か `Bash` の `run_in_background`）。**待ちが自分の手から外れる形**で、' +
        '背景処理を残したまま作業者が畳むと起こし直しの上限に達して委譲そのものが止まる' +
        '（実測 2026-09-17: 作業者2人が同じ形で停止した）。' +
        '代わりに次のいずれかを使うこと: ' +
        '(1) 前景で `timeout <秒> gh run watch <id> --exit-status` と書き、待ち自体に上限を持たせる。 ' +
        '(2) 上限付きのポーリングで確かめる' +
        '（`gh api repos/<owner>/<repo>/commits/<head_sha>/check-runs` を回数の上限を先に決めて叩く。' +
        '**head sha を明示すること** — PR 番号だけで引くと draft 中の `skipped` を緑と読む）。 ' +
        '⚠️ どちらでも `| tail` / `| head` をチェーンの末尾に置かないこと —— ' +
        'パイプの終了コードは既定で最後のものなので、`gh run watch` が 404 で即死しても成功の顔で返る。',
    };
  }

  if (hasUnboundedTailFollow(trimmed)) {
    return {
      blocked: true,
      form: 'tail-f',
      reason: buildReason('`tail -f` / `tail --follow` はファイルの終端で止まらず追従し続ける'),
    };
  }

  LOOP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOOP_RE.exec(trimmed)) !== null) {
    const keyword = match[1] as 'until' | 'while';
    const cond = match[2] ?? '';
    const body = match[3] ?? '';

    // sleep を伴わないループ（busy-wait 等）は、この検出器が弾く対象の形
    // ではない（下の doc 冒頭「していないこと」）。
    if (!/\bsleep\b/.test(body)) continue;
    if (isBoundedLoop(keyword, cond, body)) continue;

    return {
      blocked: true,
      form: keyword === 'until' ? 'until-sleep' : 'while-sleep',
      reason: buildReason(
        `\`${keyword} <条件>; do ... sleep ...; done\` は、条件が反転するまで` +
          '待ち続ける形で、相手（sentinel を書くはずの側）が先に死ねば二度と反転しない',
      ),
    };
  }

  return { blocked: false };
}

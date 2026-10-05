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
 * - ~~`for` ループ（そもそも `until` / `while` に一致しないので、この検出器は
 *   何もしない —— 個別の除外条件を書く必要がない）~~ **リストを回す `for`
 *   （`for i in …`）と、条件の有る C 形式の `for`（`for ((i=0;i<5;i++))`）だけ。**
 *   **条件の無い C 形式の `for`（`for ((;;))`）は、`while true` と同じ無限ループなので
 *   弾く**（形 `for-sleep`。teto の判断、#2179 の「残す」。`findUnboundedCFors` の doc）。
 *   もとの「for は有界」は、リストを回す for を前提にした判断で、条件の無い C 形式には
 *   当てはまらなかった。取り消し線のまま残すのは、前提が外れていた経緯を辿れるようにするため
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
 * ## 開発リポジトリ固有のマージの規約は、ここに持たない（#2884）
 *
 * 以前は `gh pr merge` の `--delete-branch` / `--match-head-commit` 無し / squash の本文無しもここで
 * 弾いていた（#1764・#2248・#2365）。それは alteroid 開発リポジトリの運用規約で、製品の門ではない。
 * マネージャーは Claude Code、クローンはそれを使う人間である（オーナーの回答 2026-10-05）。
 * 規約はそのリポジトリの指示（`AGENTS.md`・`.claude/skills/pr-merge/SKILL.md`・依頼文）で表す。
 */

/** 弾いた形の種別。テストと呼び出し側の note 文言がここへ分岐する。 */
export type WaitGuardForm =
  'until-sleep' | 'while-sleep' | 'for-sleep' | 'tail-f' | 'gh-run-watch-background';

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
  '（例: 対象の完了を返すコマンドを**前景で**。CI なら `gh run watch <id> --exit-status`）。 ' +
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
 *
 * #2423: `timeout` の直後のオプション（`--foreground 60`・`-k5 60`）は `timeout\b` で
 * 既に有界と読む（前置きの形には依存しない）。パス付き（`/usr/bin/timeout 60 …`）も
 * 同じく有界なので、先頭の語に `(?:[^\s=]{0,64}\/)?` を許す（上限の理由は
 * `TIMEOUT_COMMAND_PREFIX_SRC` の doc。無制限だと空白の無い長い1語で2乗になる）。
 */
function isTimeoutWrapped(trimmed: string): boolean {
  return (
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:[^\s=]{0,64}\/)?timeout\b/.test(trimmed) &&
    isSingleSimpleCommand(trimmed)
  );
}

/**
 * 全体が1つの単純コマンドか（#2399）。`timeout 60 make; tail -f x` のように、先頭の `timeout` が
 * 包むのは最初の単純コマンドだけなので、区切りの後ろを有界と読んではいけない。
 *
 * 引用符の外（`computeOutsideQuoteMask`）の `;` / `|`（`||` と `|&` も含む）/ 改行 /
 * 単体の `&` と `&&` が、**後ろに中身を持つ**とき、複数の単純コマンドと読む。
 * 末尾の区切り（`timeout 60 cmd &` / `;`）は、後ろに別のコマンドが無いので数えない。
 * `>&` / `<&` / `&>` のリダイレクトの `&` は区切りではない。ヒアドキュメントの本体は
 * 先に空白へ潰す（本体の改行と中身は、区切りでも別のコマンドでもない）。行の継続は先に外す。
 * 走査は1回で、線形。
 */
function isSingleSimpleCommand(trimmed: string): boolean {
  const command = stripHeredocs(joinLineContinuations(trimmed));
  const mask = computeOutsideQuoteMask(command);
  let lastContent = command.length - 1;
  while (lastContent >= 0 && /[\s;&]/.test(command.charAt(lastContent))) lastContent -= 1;
  for (let i = 0; i < lastContent; i++) {
    if (!mask[i]) continue;
    const ch = command[i];
    if (ch === ';' || ch === '|' || ch === '\n') return false;
    if (ch === '&') {
      const prev = i > 0 ? command[i - 1] : '';
      if (prev === '>' || prev === '<') continue;
      if (command[i + 1] === '>') continue;
      return false;
    }
  }
  return true;
}

/**
 * `tail -f` / `tail --follow` を、同じ単純コマンドの中だけで探す。
 *
 * `;` / `&&` / `||` / `|` / 改行の手前で切る —— これらは別の単純コマンドの
 * 境界なので、`tail -5 foo.log; other -f bar` のような無関係な `-f` を
 * 拾わないため。フラグは `-f` を含む短縮オプション（`-f` 単体・結合形）と
 * `--follow`（`--follow=name` も含む）の両方を見る。
 *
 * **`-F`（`--follow=name --retry`）も見る**（#2129）。以前は小文字の `f` しか見ず、
 * `tail -F x` / `tail -qF x` / `tail -Fn 5 x` がすり抜けていた。
 *
 * **一致の規則の正本**（issue #2195 のレビュー以降は、本体はこれを当てない）。本体は
 * `hasTailFollowPattern` が同じ一致を返す（`LOOP_RE`/`findUntilWhileLoops` と同じ関係）。
 * この正規表現は、区切りの無い1行の繰り返しで2乗になる（`(TAIL + ' ').repeat(8000)` で
 * 208ms、増分が4倍ごとに約4倍——2乗の伸び。2026-09-30 実測）。託宣として
 * `bash-wait-guard-issue-2195.test.ts` が突き合わせる。**規則を変えるときは、ここと
 * `hasTailFollowPattern` の両方を変えること。**
 */
export const TAIL_FOLLOW_RE =
  /\btail\b(?:(?!;|&&|\|\||\||\n).)*?(?:\s-[a-zA-Z]*[fF][a-zA-Z]*(?=[\s;&|]|$)|\s--follow\b)/;

/** `TAIL_FOLLOW_RE` の除外先読みと同じ字面の集合。**単体の `&` は境界に数えない**——
 * 元の先読み `(?!;|&&|\|\||\||\n)` が2文字の `&&` だけを見て単体の `&` を見ていないのに
 * 合わせている。`||` は単体の `|` を含むので、単体の `|` を見るだけで両方拾える。
 * 戻り値は境界トークンの長さ（`&&` なら2、それ以外の境界なら1、境界でなければ0）。
 */
function boundaryTokenLengthAt(command: string, i: number): 0 | 1 | 2 {
  const ch = command[i];
  if (ch === ';' || ch === '\n' || ch === '|') return 1;
  if (ch === '&' && command[i + 1] === '&') return 2;
  return 0;
}

const TAIL_WORD_ONLY_RE = /\btail\b/;
const FOLLOW_FLAG_ONLY_RE = /\s-[a-zA-Z]*[fF][a-zA-Z]*(?=[\s;&|]|$)|\s--follow\b/;
/** `FOLLOW_FLAG_ONLY_RE` の先頭固定版（区間の境界の改行を橋渡しするときに使う。下の doc）。 */
const FOLLOW_FLAG_ANCHORED_RE = /^\s-[a-zA-Z]*[fF][a-zA-Z]*(?=[\s;&|]|$)|^\s--follow\b/;

/**
 * `[start, end)` の区間（同じ単純コマンドの中）に `tail` のフラグ一致が在るか。
 *
 * 区間の中の**最も左の** `tail` の語の直後から、フラグが**どこかに1つでも**在るかだけを
 * 見れば十分——後ろの `tail` から見て満たせる条件（フラグがその tail より後ろに在る）は、
 * より左の tail から見ても常に満たせる（左の tail の方が「後ろ」の範囲が広い）。逆に
 * フラグが最も左の tail の後ろに1つも無ければ、それより右のどの tail の後ろにも無い。
 * ⟹ 区間ごとに定数回（`tail` 探索1回・フラグ探索1回）で判定できる。
 *
 * ⚠️ **改行だけは区間の境界を1文字だけ跨ぐ**（乱数突き合わせで発見、issue #2195）。
 * `TAIL_FOLLOW_RE` のフラグ側 `\s-…` の `\s` は改行にも一致するクラスなので、
 * `tail\n-f` のように **改行そのものがフラグの先頭 `\s` として使われる**形が、
 * 元の正規表現では一致する（`(?:(?!;|&&|\|\||\||\n).)*?` が改行を「消費」する
 * 必要はなく、レイジーな0回の時点で `\s-…` 側の先読みが改行を直接飲み込むため）。
 * `;`/`&&`/`||`/`|` はどれも空白類ではないので、この橋渡しは改行だけに起きる。
 */
function regionHasTailFollow(command: string, start: number, end: number): boolean {
  const region = command.slice(start, end);
  const tailMatch = TAIL_WORD_ONLY_RE.exec(region);
  if (!tailMatch) return false;
  const afterTail = region.slice(tailMatch.index + tailMatch[0].length);
  if (FOLLOW_FLAG_ONLY_RE.test(afterTail)) return true;
  return command[end] === '\n' && FOLLOW_FLAG_ANCHORED_RE.test(command.slice(end));
}

/**
 * `TAIL_FOLLOW_RE` と同じ判定を、後戻り無しで行う（issue #2195 のレビューで見つかった
 * 2乗の後戻り。`LOOP_RE`/`findUntilWhileLoops`（#2181）と同じ形——開始ごとに末尾まで
 * 読み直す代わりに、`;`/`&&`/`||`/`|`/改行（引用符は見ない——元の正規表現も見ていない）で
 * 区切った区間ごとに `regionHasTailFollow` を1回だけ呼ぶ。区間の合計長は `command` の
 * 長さを超えないので、全体で線形。
 */
export function hasTailFollowPattern(command: string): boolean {
  let start = 0;
  while (start <= command.length) {
    let end = start;
    while (end < command.length && boundaryTokenLengthAt(command, end) === 0) end += 1;
    if (regionHasTailFollow(command, start, end)) return true;
    if (end >= command.length) return false;
    start = end + boundaryTokenLengthAt(command, end);
  }
  return false;
}

/** `hasUnboundedTailFollow` が扱う、**引用符の外**の `;`/`&&`/`||`/`|`/改行で切った
 * 単純コマンドの区間（issue #2195 の再設計）。 */
interface SimpleCommandSpan {
  readonly start: number;
  readonly end: number;
}

/** `command` を、**引用符の外**の `;`/`&&`/`||`/`|`/改行で単純コマンドへ切る
 * （`mask` は `computeOutsideQuoteMask(command)` の結果）。境界トークン自体は
 * どちらの区間にも含まれない（次のスパンの `start` はトークンの直後）。 */
function splitOutsideQuoteSimpleCommands(
  command: string,
  mask: readonly boolean[],
): SimpleCommandSpan[] {
  const spans: SimpleCommandSpan[] = [];
  let start = 0;
  let i = 0;
  while (i < command.length) {
    let tokenLength = mask[i] ? boundaryTokenLengthAt(command, i) : 0;
    // 単体の `&`（背景化の区切り。#2401）も単純コマンドを分ける。`boundaryTokenLengthAt` は
    // `TAIL_FOLLOW_RE` の一致の規則と揃えてあるので単体の `&` を境界に数えない。ここ（引用符を
    // 潰す区間の切り出し）だけで足す。`>&` / `<&` / `|&` / `&>` のリダイレクト・パイプの `&` は除く。
    if (tokenLength === 0 && mask[i] && command[i] === '&') {
      const prev = i > 0 ? command[i - 1] : '';
      if (prev !== '>' && prev !== '<' && prev !== '|' && command[i + 1] !== '>') tokenLength = 1;
    }
    if (tokenLength > 0) {
      spans.push({ start, end: i });
      i += tokenLength;
      start = i;
    } else {
      i += 1;
    }
  }
  spans.push({ start, end: command.length });
  return spans;
}

/**
 * 単純コマンドの**先頭の語**が「引数を実行しないと分かっている」形か
 * （issue #2195、mgr-712ad619 のレビュー・2026-09-30。以前の版は「文字列を実行する
 * 5つの入口」を列挙して弾く側に倒していたが、`watch "tail -f x"` / `su -c "tail -f x"` /
 * `script -qc "tail -f x"` / `docker exec c sh -c "tail -f x"` / `bash <<<"tail -f x"`
 * （ヒアストリング） / `env -S "tail -f x"` / `"tail" -f x`（コマンド名自体を引用符で
 * 囲む） / `x="tail -f y"; $x` / `x="tail -f y"; eval $x` のように、列挙していない
 * 実行形がすり抜けた——列挙は「弾く形」を漏れなく挙げるには向かない（新しい実行形が
 * 見つかるたびに追記が要る、終わりの無い作業）。
 *
 * ⟹ 向きを逆にする。**「実行しないと確認できた」側だけを短い許可リストに載せ、それ以外は
 * すべて生の字面のまま見る**（＝弾く側に倒す。列挙されていない実行形は、そもそも
 * 引用符の中身を消さないので、誤って通ることが無い）。
 *
 * 許可リストに載るのは次だけ——広げるなら理由を書くこと。
 * - `echo` / `printf` / `grep` / `rg`（出力・検索。引数を実行しない）
 * - `git commit`（コミットメッセージを実行しない）
 * - `gh issue` / `gh pr` の `comment` / `create` / `edit` / `view` / `close` / `review`
 *   （本文・タイトルを実行しない）
 *
 * 当てない条件（弾く側へ倒す）:
 * - 先頭の語が引用符で囲まれている（コマンド名そのものが引用符の中）——
 *   `"echo" "tail -f x"` のような偽装を防ぐ
 * - `VAR=…` の代入で始まる——代入の右辺が後で実行されるかはこの語だけでは分からない
 * - 同じ単純コマンドにコマンド置換（`$(`/バッククォート）かプロセス置換（出力側 `>(`・
 *   入力側 `<(`。#2401）が在る——置換の中身は実際に実行される。`echo "…" > >(sh)` は出力を
 *   シェルへ渡す。`grep x <(bash -c "…")` は中身を実行する
 *
 * 語の終わりは空白か行末で見る（`\b` だと `echo-x` / `grep.sh` のような別のコマンドまで当たる）。
 */
const NON_EXECUTING_ARGS_COMMAND_RE =
  /^(?:echo|printf|grep|rg|git[ \t]+commit|gh[ \t]+(?:issue|pr)[ \t]+(?:comment|create|edit|view|close|review))(?=[ \t]|$)/;

function isNonExecutingArgsSimpleCommand(command: string, span: SimpleCommandSpan): boolean {
  let i = span.start;
  while (i < span.end && (command[i] === ' ' || command[i] === '\t')) i += 1;
  if (i >= span.end) return false;
  const ch = command[i] as string;
  if (ch === "'" || ch === '"' || (ch === '$' && command[i + 1] === "'")) return false;
  const rest = command.slice(i, span.end);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) return false;
  if (rest.includes('$(') || rest.includes('`') || rest.includes('>(') || rest.includes('<(')) {
    return false;
  }
  return NON_EXECUTING_ARGS_COMMAND_RE.test(rest);
}

/**
 * `command[i]` が「本物のパイプ」（`|` 単体、または `|&`）の先頭か（issue #2195、
 * mgr-712ad619 の追加レビュー・2026-09-30）。**`||`（論理 OR）は含まない**——`||` は
 * 左側の標準出力を右側へ渡さない（左右は独立に実行されるだけ）ので、ここでの
 * 「パイプの左側」には数えない。`boundaryTokenLengthAt` は `|`/`||` を区別せず
 * どちらも境界として扱うが（`TAIL_FOLLOW_RE` の除外先読みが元々そうしているため。
 * その doc 参照）、こちらは別の目的（本物のパイプかどうか）なので別に判定する。
 */
function isRealPipeBoundary(command: string, i: number): boolean {
  return command[i] === '|' && command[i + 1] !== '|';
}

/**
 * 引用符の中身を、**許可リストに当たる単純コマンドの中でだけ**空白へ潰した写しを返す
 * （issue #2195）。それ以外の単純コマンドは生のまま残す——引数を実行しうる形は
 * `isNonExecutingArgsSimpleCommand` の doc のとおり列挙しきれないので、許可リストに
 * 当たらない限りすべて「実行するかもしれない」として生の字面を見る（弾く側に倒す）。
 *
 * ⚠️ **許可リストに当たる単純コマンドでも、本物のパイプ（`isRealPipeBoundary`）の
 * 左側に在るときは消さない**（issue #2195 の追加レビュー・2026-09-30）。
 * `echo "tail -f x" | bash` / `printf '%s\n' "tail -f x" | sh` /
 * `echo "tail -f x" | xargs -I{} sh -c {}` のように、許可リストのコマンドの出力を
 * 次のコマンドへ実行させる形が見逃されていた——「引数を実行しない」ことは確認できても、
 * 「出力を実行する側へ渡さない」ことまでは確認できないため。⟹ 出力の行き先まで
 * 静的には読めないので、パイプの左側に在る許可リストのコマンドは弾く側へ倒す。
 *
 * `git commit -m "tail -f x.log"`（パイプが無い、単独の形）は今までどおり通す——
 * 対照は `bash-wait-guard-issue-2195.test.ts`。`echo "tail -f x" > r.sh; bash r.sh`
 * （ファイルへ書いてから別の呼び出しで実行する形）も今までどおり通す——`>` は
 * パイプではないので `isRealPipeBoundary` に当たらず、ここでは消したままにする
 * （`stripDataHeredocsForWaitForms` の「別の呼び出しで書いたファイルを後で走らせる形は
 * もともと見えない」と同じ限界。書いた直後の同じ呼び出しの中で実行される形だけを
 * 塞ぐのがこのガードの守備範囲である）。
 *
 * 文字数を変えないので、この後にかける `hasTailFollowPattern` の走査の複雑さは変わらない。
 */
function blankQuotedInteriorForNonExecutingCommands(command: string): string {
  const mask = computeOutsideQuoteMask(command);
  const spans = splitOutsideQuoteSimpleCommands(command, mask);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += command.slice(cursor, span.start);
    const feedsIntoPipe = isRealPipeBoundary(command, span.end);
    if (!feedsIntoPipe && isNonExecutingArgsSimpleCommand(command, span)) {
      for (let i = span.start; i < span.end; i += 1) {
        const ch = command[i] as string;
        out += mask[i] || ch === '\n' ? ch : ' ';
      }
    } else {
      out += command.slice(span.start, span.end);
    }
    cursor = span.end;
  }
  out += command.slice(cursor);
  return out;
}

/**
 * `tail -f` / `tail --follow` を検出する（issue #2195）。
 *
 * ## 直した誤検知（Issue 本文）
 *
 * 直す前は `TAIL_FOLLOW_RE` を `command` へそのままかけていたため、引用符の
 * **中**に書かれた `tail -f` の字面（実行されない）も拾っていた——
 * `git commit -m "use tail -f x.log"` / `gh issue comment 1 --body "run tail -f x.log"` /
 * grep の検索語に書いた `"tail -f x.log"` / `echo 'tail -f x.log'` がいずれも誤って弾かれていた。
 *
 * ⟹ `blankQuotedInteriorForNonExecutingCommands` で、許可リストに当たる単純コマンドの
 * 引用符の中身だけを空白へ潰した写しへ `hasTailFollowPattern` をかける。
 *
 * ## それでも弾く形（許可リストに当たらないものすべて。列挙ではなく既定で弾く側）
 *
 * `bash -c "…"` / `sh -c '…'` / `eval "…"` / `ssh host "…"` / `su -c "…"` /
 * `script -qc "…"` / `docker exec c sh -c "…"` / ヒアストリング（`bash <<<"…"`） /
 * `env -S "…"` / コマンド名自体を引用符で囲む形（`"tail" -f x`）は、どれも先頭の語が
 * 許可リストに無いので、引用符の中身は消さない——生の字面のまま `hasTailFollowPattern`
 * にかかる。`x="tail -f y"; echo $x` のような代入も、代入の単純コマンド自体が
 * 許可リストに当たらないので、代入の右辺（引用符の中）は生のまま残り、弾く
 * （`x="tail -f y"; $x` / `x="tail -f y"; eval $x` も同じ理由で弾く——これは意図した
 * 挙動である。「代入した変数を後で実行するかもしれない」ことまでは静的に読めないため）。
 *
 * `$(...)` とバッククォート（コマンド置換）は、許可リストに当たる単純コマンドでも
 * 同じ単純コマンドに在れば消さない（`isNonExecutingArgsSimpleCommand` の doc）ので、
 * `echo $(tail -f x)` / バッククォート形も生の字面のまま弾く。
 *
 * 許可リストに当たる単純コマンドでも、**本物のパイプ（`|`/`|&`。`||` は含まない）の
 * 左側**に在るなら消さない（`isRealPipeBoundary`/`blankQuotedInteriorForNonExecutingCommands`
 * の doc）——`echo "tail -f x" | bash` / `printf '%s\n' "tail -f x" | sh` /
 * `echo "tail -f x" | xargs -I{} sh -c {}` のように、出力を次のコマンドが実行しうる
 * ため。パイプが無い単独の形（`git commit -m "tail -f x.log"`）は今までどおり通す。
 *
 * ## 対照（弾くことを固定する——以前の版とは逆）
 *
 * `bash -c 'echo "tail -f x"'` は**弾く**——外側の `bash -c` の単純コマンドが許可
 * リストに当たらないので、内側の `echo "tail -f x"` を含む引用符の中身ごと生のまま
 * `hasTailFollowPattern` にかかり、`tail -f x` の字面がそのまま一致する。
 */
function hasUnboundedTailFollow(command: string): boolean {
  const view = blankQuotedInteriorForNonExecutingCommands(command);
  // **引用符とバックスラッシュを外した写しにもかける**（#2206）。bash は引用を外してから argv に
  // するので、`tail "-f" x` / `tail '-f' x` / `tail -"f" x` / `tail \-f x` / `tail $'-f' x` は
  // どれも `tail -f x` と同じく追従する。フラグの判定は「生の空白の直後の生の `-`」を見るので、
  // 元の写しだけでは見落としていた。どちらかが当たれば弾く（弾く側にしか倒れない）。
  return hasTailFollowPattern(view) || hasTailFollowPattern(stripQuoteCharacters(view));
}

/**
 * 引用符（`"` / `'`）・ANSI-C 引用の `$`（`$'…'` / `$"…"` の `$`）・バックスラッシュを取り除く
 * （#2206）。bash の引用除去の近似で、中身の展開はしない。1回の走査で線形。
 *
 * **引用符の中の空白と区切り（`;` `&` `|`）は `_` へ替える。** 引用符で包んだ1つの語は、
 * 引用を外しても1つの語のままである（`tail -n 5 "my -f file"` の `-f` をフラグと読まない）。
 * 単一引用符の中はバックスラッシュも字面、それ以外のバックスラッシュは次の1文字をエスケープする。
 * `$'…'` の中のエスケープは追わない（単一引用符と同じに読む）。読み違えても、語が1つに
 * まとまる向き（フラグと読まない側）か、元の写しと同じ判定になる。
 */
function stripQuoteCharacters(command: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else out += /[\s;&|]/.test(ch) ? '_' : ch;
      continue;
    }
    if (ch === '\\') {
      const next = command[i + 1];
      if (next !== undefined) {
        out += quote !== null && /[\s;&|]/.test(next) ? '_' : next;
        i += 1;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else out += /[\s;&|]/.test(ch) ? '_' : ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '$' && (command[i + 1] === "'" || command[i + 1] === '"')) continue;
    out += ch;
  }
  return out;
}

/**
 * `until <cond>; do <body>; done` / `while <cond>; do <body>; done` を拾う。
 *
 * `do` / `done` は「単語境界」だけでなく、直前の文字が行頭・`;` / `&` / `|` /
 * 空白（改行を含む）のいずれかであることも要求する（lookbehind）。これが
 * 無いと `/tmp/done` のようなパス名の一部が `\bdone\b` に一致し、本体を
 * 早期に打ち切って誤爆する（doc 冒頭「`do` / `done` は『コマンドの位置に
 * 在るとき』だけ終端と見なす」）。
 *
 * **一致の規則の正本**（#2181 からは、本体はこれを当てない）。本体は `findUntilWhileLoops`
 * で同じ一致を返す。この正規表現は、遅延の読みが2段あり、終端の `done` が無いと開始ごとに
 * 末尾まで読み直して3乗に近く遅くなる（`'while x; do '.repeat(400)+'x'` で 344.3ms、4000回で
 * 120秒を超えた。2026-09-29T12:1xZ）。託宣として `bash-wait-guard-loop-scan.test.ts` が
 * 突き合わせる。**規則を変えるときは、ここと `findUntilWhileLoops` の両方を変えること。**
 */
export const LOOP_RE =
  /\b(until|while)\b([\s\S]*?)(?<=^|[\s;&|])do\b([\s\S]*?)(?<=^|[\s;&|])done\b/g;

/** `findUntilWhileLoops` / `findUnboundedCFors` が返す、ループ1つ分。 */
export interface LoopMatch {
  readonly keyword: 'until' | 'while' | 'for';
  /** `until` / `while` は条件の節。`for` は `(( … ))` の2つ目（条件）の節。 */
  readonly cond: string;
  readonly body: string;
  /** 一致の始まり（`until` / `while` / `for` の位置）。 */
  readonly index: number;
}

const LOOP_BOUNDARY_RE = /[\s;&|]/;
const WORD_CHAR_RE = /\w/;

/** `command` の `i` に、コマンドの位置の語 `word` が在るか（直前が行頭か区切り、直後が語の文字でない）。 */
function isTokenAt(command: string, i: number, word: string): boolean {
  if (!command.startsWith(word, i)) return false;
  const prev = command[i - 1];
  if (prev !== undefined && !LOOP_BOUNDARY_RE.test(prev)) return false;
  const next = command[i + word.length];
  return next === undefined || !WORD_CHAR_RE.test(next);
}

/** 昇順の `positions` から、`from` 以上の最初の値を返す（無ければ `undefined`）。 */
function firstAtOrAfter(positions: readonly number[], from: number): number | undefined {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((positions[mid] ?? Infinity) < from) lo = mid + 1;
    else hi = mid;
  }
  return positions[lo];
}

/** `do` / `done` / 閉じの `}`（直前が空白か `;`）の語の位置を、1回の走査で集める。 */
function indexLoopTokens(command: string): { dos: number[]; dones: number[]; braces: number[] } {
  const dos: number[] = [];
  const dones: number[] = [];
  const braces: number[] = [];
  for (let i = command.indexOf('do'); i !== -1; i = command.indexOf('do', i + 1)) {
    if (isTokenAt(command, i, 'done')) dones.push(i);
    else if (isTokenAt(command, i, 'do')) dos.push(i);
  }
  for (let i = command.indexOf('}'); i !== -1; i = command.indexOf('}', i + 1)) {
    const prev = command[i - 1];
    if (prev !== undefined && /[\s;]/.test(prev)) braces.push(i);
  }
  return { dos, dones, braces };
}

const LOOP_KEYWORD_RE = /\b(until|while)\b/g;

/**
 * `until` / `while` のループを、**`LOOP_RE` を `g` で当てたのと同じ一致**として返す（#2181）。
 *
 * `LOOP_RE` の一致の規則を読み解くと、次のとおりである。
 * - 開始（`until` / `while`）の後ろで**最初の `do` の語**までが条件、その後ろで**最初の
 *   `done` の語**までが本体（遅延の読みは、いちばん短い分け方から試すため）
 * - 最初の `do` の後ろに `done` が無ければ、それより後ろのどの `do` の後ろにも無いので、その
 *   開始は一致しない。**後ろのどの開始も一致しない**（開始より後ろの `do` は、前の開始から見ても
 *   後ろに在る）ので、そこで探すのをやめてよい
 * - 一致したら、その `done` の直後から次の開始を探す（入れ子の本体の中の開始は読み飛ばす）
 *
 * `do` / `done` の語の位置を1回の走査で集め、開始ごとに二分探索で引く。
 */
export function findUntilWhileLoops(command: string): LoopMatch[] {
  const { dos, dones } = indexLoopTokens(command);
  const loops: LoopMatch[] = [];
  LOOP_KEYWORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOOP_KEYWORD_RE.exec(command)) !== null) {
    const keyword = m[1] as 'until' | 'while';
    const condStart = m.index + keyword.length;
    const doAt = firstAtOrAfter(dos, condStart);
    if (doAt === undefined) break;
    const doneAt = firstAtOrAfter(dones, doAt + 2);
    if (doneAt === undefined) break;
    loops.push({
      keyword,
      cond: command.slice(condStart, doAt),
      body: command.slice(doAt + 2, doneAt),
      index: m.index,
    });
    LOOP_KEYWORD_RE.lastIndex = doneAt + 4;
  }
  return loops;
}

/**
 * 条件の無い C 形式の `for`（`for ((init; cond; step))`）の見出し（teto の判断、#2179 の「残す」）。
 * 3つの節を捕獲する。見出しの後ろの空白と `;` を読み飛ばした位置を、本体の始まりの候補にする。
 */
const C_FOR_HEADER_RE = /\bfor[ \t]*\(\(([^;()]*);([^;()]*);([^()]*)\)\)[\s;]*/g;

/**
 * C 形式の for の条件の節が「無い」か（空、または 0 でない整数の定数だけ）。
 *
 * **符号と先頭の 0 も許す**（#2204）。bash の算術では `-1` / `+5` / `007`（8進の 7）も非零で真なので、
 * 無限ループになる。#2204 までは `/^[1-9]\d*$/` で、符号の付いた形と先頭が 0 の形を通していた
 * （doc の「0 でない整数の定数」とずれていた）。`0` / `00` / `-0` は偽なので通す。
 * `08` のように8進として不正な定数は bash がその場でエラーにして終わるが、ここでは非零として弾く
 * （弾く側に倒れるだけで、壊れたループを止めるので害は無い）。
 */
function isEndlessCForCondition(cond: string): boolean {
  const trimmed = cond.trim();
  return trimmed === '' || (/^[+-]?\d+$/.test(trimmed) && /[1-9]/.test(trimmed));
}

/**
 * **条件の無い** C 形式の `for` を返す（teto の判断、#2179 の「残す」。2026-09-29）。
 *
 * ## なぜ for を見るか
 *
 * このモジュールの判定基準は、長く「`for` ループは `until` / `while` に一致しないので何もしない
 * （有界）」と書いていた。これはリストを回す `for`（`for i in …`）と、条件の有る C 形式の `for`
 * を前提にした判断である。**条件の無い C 形式の `for`（`for ((;;))`）は、`while true` と同じ無限
 * ループで、前提が外れていた。**
 *
 * ## 線引き（領域 D のマネージャーの判断）
 *
 * - 弾く候補: 条件の節が空、または 0 でない整数の定数だけ（`for ((;;))` / `for (( ; ; ))` /
 *   `for ((i=0;;i++))` / `for ((;1;))`）。本体は `do … done` と `{ …; }` の両方の形を見る
 * - 通す: 条件の有る C 形式（`for ((i=0;i<5;i++))` / `for ((;0;))`）・リストを回す `for`。これは
 *   呼び出し側の `sleep` / `break` / カウンタ比較の判定より前に、ここで候補から外す
 *
 * 本体の終端（`done` / `}`）は、`findUntilWhileLoops` と同じ索引から二分探索で引く（見出しの
 * 数だけ試しても線形に近い）。
 */
export function findUnboundedCFors(command: string): LoopMatch[] {
  if (!command.includes('for')) return [];
  const { dos, dones, braces } = indexLoopTokens(command);
  const loops: LoopMatch[] = [];
  C_FOR_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = C_FOR_HEADER_RE.exec(command)) !== null) {
    const cond = m[2] ?? '';
    if (!isEndlessCForCondition(cond)) continue;
    const bodyStartCandidate = m.index + m[0].length;
    let body: string | undefined;
    if (firstAtOrAfter(dos, bodyStartCandidate) === bodyStartCandidate) {
      const doneAt = firstAtOrAfter(dones, bodyStartCandidate + 2);
      if (doneAt !== undefined) body = command.slice(bodyStartCandidate + 2, doneAt);
    } else if (command[bodyStartCandidate] === '{') {
      const closeAt = firstAtOrAfter(braces, bodyStartCandidate + 1);
      if (closeAt !== undefined) body = command.slice(bodyStartCandidate + 1, closeAt);
    }
    if (body === undefined) continue;
    loops.push({ keyword: 'for', cond, body, index: m.index });
  }
  return loops;
}

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
export const GH_RUN_WATCH_RE = /\bgh\b(?:(?!;|&&|\|\||\||\n).)*?\brun\s+watch\b/;

const GH_WORD_SRC_FOR_RUN_WATCH = String.raw`\bgh\b`;
const RUN_WATCH_SRC = String.raw`\brun\s+watch\b`;
/** `GH_RUN_WATCH_RE` の `(?:(?!…).)*?` が越えられない位置（`.` が改行類を跨がないことも含む）。 */
const RUN_WATCH_SEGMENT_END_SRC = /[;|\n\r\u2028\u2029]|&&/.source;

/**
 * `GH_RUN_WATCH_RE.exec` と同じ最初の一致（位置と末尾）を、線形の走査で探す（#2189）。
 *
 * 正規表現のままだと、区切りの無い1行に `gh` が n 個並ぶと、`gh` ごとに区切りまで読み直して
 * 2乗になる（`gh pr merge 1 ` の繰り返し 4000 回で約 130ms）。行の継続を取り除いた写しにも
 * 判定をかけるようになって、`\` + 改行で折り返した形もこの1行になる。同じ区切りの中の `gh` は
 * どれも同じ区切りまでしか読めないので、**区切りの中で最初の `gh` だけ**を試せば足りる。
 * `run watch` の検索は前へしか進まないので、見つけた一致を使い回す。
 */
export function findGhRunWatch(command: string): { index: number; end: number } | null {
  const found = findGhRunWatchFrom(command, 0);
  return found === null ? null : { index: found.index, end: found.end };
}

/**
 * `findGhRunWatch` の、`from` 以降を探す版（#2400）。見つけた一致に、その区切りの末尾（`limit`）を
 * 添える。次の一致は `limit` から探せば、区切りごとに1件を前へ進みながら全部を線形に拾える
 * （同じ区切りの中の後ろの一致は、同じ区切りまでしか読めないので、最初の1件で足りる）。
 */
function findGhRunWatchFrom(
  command: string,
  from0: number,
): { index: number; end: number; limit: number } | null {
  const gh = new RegExp(GH_WORD_SRC_FOR_RUN_WATCH, 'g');
  gh.lastIndex = from0;
  const runWatch = new RegExp(RUN_WATCH_SRC, 'g');
  const segmentEnd = new RegExp(RUN_WATCH_SEGMENT_END_SRC, 'g');
  let nextRunWatch: RegExpExecArray | null | undefined;
  let m: RegExpExecArray | null;
  while ((m = gh.exec(command)) !== null) {
    const from = m.index + m[0].length;
    segmentEnd.lastIndex = from;
    const end = segmentEnd.exec(command);
    const limit = end === null ? command.length : end.index;
    if (nextRunWatch === undefined || (nextRunWatch !== null && nextRunWatch.index < from)) {
      runWatch.lastIndex = from;
      nextRunWatch = runWatch.exec(command);
    }
    if (nextRunWatch === null) return null;
    if (nextRunWatch.index < limit) {
      return { index: m.index, end: nextRunWatch.index + nextRunWatch[0].length, limit };
    }
    // 同じ区切りの中の後ろの `gh` も、同じ区切りまでしか読めない。区切りの先へ飛ぶ。
    gh.lastIndex = Math.max(gh.lastIndex, limit);
  }
  return null;
}

/**
 * 直後に最初に現れる制御演算子が「背景化の `&`」かを見る。
 *
 * `&` は `2>&1`・`<&-`（直前が `>` / `<`）、`&&`（直前か直後が `&`）、`|&`（直前が `|`。
 * stderr もパイプへ流す前景の形）、`&>` / `&>>`（直後が `>`。両方をファイルへ流すリダイレクト）
 * にも現れるので、単純な `&` の検索では誤爆する。lookbehind と lookahead でそれらを外す
 * （`|&` と `&>` は #2271 の A）。`cmd |& tee log &` の最後の `&` は外さないので、背景と読む。
 * `;` / 改行が先に来たなら、その `gh run watch` は背景化されていない。
 */
const FIRST_CONTROL_OPERATOR_RE = /[;\n]|(?<![<>&|])&(?![&>])/;

const FIRST_CONTROL_OPERATOR_GLOBAL_RE = new RegExp(FIRST_CONTROL_OPERATOR_RE.source, 'g');

/**
 * **すべての** `gh run watch` を順に見る（#2400）。最初の1件だけを見ると、前景の run watch の
 * 後ろに背景の run watch が続く形（`gh run watch 1; gh run watch 2 &`）を見落とす。
 * 一致は区切りごとに1件ずつ、前へ進みながら拾う（`findGhRunWatchFrom`）。最初の制御演算子の探索も
 * 前へしか進まないので、見つけた位置を使い回す（一致のたびに末尾まで読み直すと2乗になる）。
 */
function isBackgroundedGhRunWatch(trimmed: string, backgrounded: boolean): boolean {
  let match = findGhRunWatchFrom(trimmed, 0);
  if (match === null) return false;
  // ツール側の背景指定は、コマンド文字列のどこに在っても背景である。
  if (backgrounded) return true;
  let operator: RegExpExecArray | null | undefined;
  const isInsideBackgrounded = createBackgroundedBraceGroupChecker(trimmed);
  while (match !== null) {
    if (operator === undefined || (operator !== null && operator.index < match.end)) {
      FIRST_CONTROL_OPERATOR_GLOBAL_RE.lastIndex = match.end;
      operator = FIRST_CONTROL_OPERATOR_GLOBAL_RE.exec(trimmed);
    }
    if (operator !== null && operator[0] === '&') return true;
    // `setsid`（`-w` / `--wait` が無い形）も背景へ置く形である（#2129）。
    const segment = trimmed.slice(commandPositionStartBefore(trimmed, match.index), match.index);
    if (isBackgroundingSetsid(segment)) return true;
    // `coproc` は子を非同期で起こす（#2179）。`setsid` と同じく、背景へ置く形である。
    if (COPROC_RE.test(segment)) return true;
    // `{ …; } &` の中（#2179）。`;` が `&` より先に来るので、上の最初の制御演算子の判定では
    // 背景と読めない。`( … ) &` は `)` の直後の `&` が最初の制御演算子なので、上で弾ける。
    if (isInsideBackgrounded(match.index)) return true;
    match = findGhRunWatchFrom(trimmed, match.limit);
  }
  return false;
}

/** `coproc [名前] <コマンド>` の `coproc`（#2179）。語の途中の `coproc` は拾わない。 */
const COPROC_RE = /(?:^|\s)coproc\s/;

/** 波括弧のグループを開く `{`・閉じる `}` として読める位置か（#2179）。 */
function isBraceOpenAt(command: string, i: number): boolean {
  if (command[i] !== '{') return false;
  const prev = command[i - 1];
  const next = command[i + 1];
  // `${var}` / `a{b,c}` のような展開は、`{` の直前が語の文字なので外れる。
  const prevOk = prev === undefined || /[\s;&|(]/.test(prev);
  const nextOk = next === undefined || /\s/.test(next);
  return prevOk && nextOk;
}

function isBraceCloseAt(command: string, i: number): boolean {
  if (command[i] !== '}') return false;
  const prev = command[i - 1];
  // 閉じの `}` は、`;` か改行（と空白）の後ろに来る。`${x}` の `}` は直前が語の文字なので外れる。
  return prev === undefined || /[\s;&|]/.test(prev);
}

/**
 * `index`（`gh run watch` の位置）を囲む `{ … }` のグループが、閉じの `}` の直後で背景の `&`
 * へ送られているか（#2179）。
 *
 * 手前へ走査して、まだ閉じていない `{` を探す。見つかれば、後ろへ走査して、それを閉じる `}` を
 * 探し、その後ろで最初に来る制御演算子が背景の `&` かを見る（`FIRST_CONTROL_OPERATOR_RE`。
 * `2>&1` と `&&` は背景と読まない）。**引用符は追わない**（このモジュールの他の判定と同じ）。
 * 引用符の中の `{` / `}` を読み違えても、弾く側か、いまと同じ（背景と読まない）側に倒れる。
 * 走査は線形である。
 */
function createBackgroundedBraceGroupChecker(command: string): (index: number) => boolean {
  // `index` を昇順に渡す前提（一致は前へしか進まない。#2400）。前から1回だけ走査して、まだ閉じていない
  // `{` の積み（`stack`。外側が先）を持ち回る。`gh run watch` が何件並んでも、手前への走査を
  // 一致ごとにやり直さない（やり直すと2乗になる）。対の `}` の位置は `{` ごとに1度だけ探す。
  const stack: number[] = [];
  let pos = 0;
  const closeOf = new Map<number, number>();
  const operatorRe = new RegExp(FIRST_CONTROL_OPERATOR_RE.source, 'g');
  let lastOperator: RegExpExecArray | null | undefined;
  let lastOperatorFrom = 0;
  // `from` は `open` の内側で、そこまでの `{` と `}` が釣り合っている位置（内側のグループの閉じの
  // 次）。外側のグループの対を、内側の続きから探すので、深い入れ子でも全体で線形になる。
  const findClose = (open: number, from: number): number => {
    const known = closeOf.get(open);
    if (known !== undefined) return known;
    let depth = 0;
    let close = -1;
    for (let i = from; i < command.length; i += 1) {
      if (isBraceOpenAt(command, i)) {
        depth += 1;
      } else if (isBraceCloseAt(command, i)) {
        if (depth === 0) {
          close = i;
          break;
        }
        depth -= 1;
      }
    }
    closeOf.set(open, close);
    return close;
  };
  return (index: number): boolean => {
    for (; pos < index; pos += 1) {
      if (isBraceOpenAt(command, pos)) stack.push(pos);
      else if (isBraceCloseAt(command, pos)) stack.pop();
    }
    // 内側のグループから外側へ順に見る（`{ { … }; } &` のように、外側のグループだけが背景へ
    // 送られる形があるため）。
    let balancedFrom = -1;
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const open = stack[k] as number;
      const close = findClose(open, balancedFrom >= 0 ? balancedFrom : open + 1);
      if (close < 0) return false;
      balancedFrom = close + 1;
      // `close` の後ろで最初の制御演算子。直前の探索が `close + 1` を含む区間の結果なら使い回す
      // （外側へ進むほど `close` は後ろになる。毎回末尾まで読み直すと深い入れ子で2乗になる）。
      if (
        lastOperator === undefined ||
        lastOperatorFrom > close + 1 ||
        (lastOperator !== null && lastOperator.index < close + 1)
      ) {
        operatorRe.lastIndex = close + 1;
        lastOperatorFrom = close + 1;
        lastOperator = operatorRe.exec(command);
      }
      if (lastOperator !== null && lastOperator[0] === '&') return true;
    }
    return false;
  };
}

/**
 * `setsid [オプション…]` が、子の終わりを待たずに返る形か（#2129）。
 *
 * util-linux の `setsid(1)` は、呼び出し元がプロセスグループの先頭なら子を fork して、
 * `-w` / `--wait` が無ければ待たずに返る（`setsid(1)` を読んでの判定。器で実際に
 * fork するかは確かめていない）。**弾く側へ倒すため、fork しない場合を区別しない。**
 * `-w` / `--wait`（短い形の束ね `-fw` を含む）が在れば、待つ形として通す。
 */
const SETSID_RE = /(?:^|\s)setsid((?:[ \t]+-\S+)*)[ \t]/;
const SETSID_WAIT_OPTION_RE = /(?:^|\s)(?:--wait|-[A-Za-z]*w[A-Za-z]*)(?=\s|$)/;

function isBackgroundingSetsid(segment: string): boolean {
  const m = SETSID_RE.exec(segment);
  if (m === null) return false;
  return !SETSID_WAIT_OPTION_RE.test(m[1] ?? '');
}

/**
 * ヒアドキュメントの一致の規則の**正本**（issue #2115 からは、本体はこれを当てない）。
 *
 * 本体は `findHeredocs` で同じ一致を線形に近い形で探す（この正規表現は、終端の無い入力で
 * 2乗になる）。この正規表現は、`findHeredocs` がこれと1文字も違わない一致を返すことを
 * 突き合わせる託宣として残す（`bash-wait-guard-heredoc-scan.test.ts`）。**規則を変えるときは、
 * ここと `findHeredocs` の両方を変えること** —— 片方だけ変えると、その歯が赤になる。
 */
export const HEREDOC_RE =
  /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=[\s;&|]|$)/g;

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
export function stripHeredocs(command: string): string {
  const spans = findHeredocs(command);
  if (spans.length === 0) return command;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += command.slice(cursor, span.start);
    out += command.slice(span.start, span.end).replace(/[^\n]/g, ' ');
    cursor = span.end;
  }
  return out + command.slice(cursor);
}

/** ヒアドキュメント1つ分の位置（`findHeredocs`。どれも `command` の中の添字）。 */
export interface HeredocSpan {
  /** `<<` の位置（`HEREDOC_RE` の一致全体の始まり）。 */
  readonly start: number;
  /** 終端の語の直後（一致全体の終わり）。 */
  readonly end: number;
  /** 本文の始まり（開始の行の改行の直後）。 */
  readonly bodyStart: number;
  /** 本文の終わり（終端の行の直前の改行の位置）。 */
  readonly bodyEnd: number;
}

/** `HEREDOC_RE` の前半（`<<` から開始の行の改行まで）。 */
const HEREDOC_OPENER_RE = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n/g;

const HEREDOC_WORD_START_RE = /[A-Za-z_]/;
const HEREDOC_WORD_CHAR_RE = /\w/;
const HEREDOC_TERMINATOR_FOLLOW_RE = /[\s;&|]/;

interface HeredocTerminator {
  /** 終端の行の直前の改行の位置。 */
  readonly newline: number;
  /** 終端の語の直後。 */
  readonly end: number;
}

/** 昇順の `list` から、`newline >= from` の最初の要素を二分探索で返す。 */
function firstTerminatorAtOrAfter(
  list: readonly HeredocTerminator[],
  from: number,
): HeredocTerminator | undefined {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid]?.newline ?? Infinity) < from) lo = mid + 1;
    else hi = mid;
  }
  return list[lo];
}

/**
 * コマンドの中のヒアドキュメントを、**`HEREDOC_RE` を `g` で当てたのと同じ一致**として
 * 返す（issue #2115）。
 *
 * ## なぜ正規表現で探さないか
 *
 * `HEREDOC_RE` の本文の部分（`[\s\S]*?\n[ \t]*\2`）は、終端が無いと開始の位置ごとに
 * 末尾まで読む。そのため、終端の無いヒアドキュメントが並ぶ入力で2乗になる
 * （`'cat <<E\n'.repeat(8000)+'x'` が 145.6ms。#2104 の `SHELL_HEREDOC_RE` と
 * `HEREDOC_BODY_RE` が同じ形でもう2回走らせ、`'bash <<E\n'` の8000回は 420.7ms だった）。
 *
 * ## どう探すか
 *
 * 終端になりうる行（行頭の空白の後に語が在り、その直後が空白・`;`・`&`・`|`・
 * 末尾のどれか）を、1回の走査で語ごとに索引する。開始（`HEREDOC_OPENER_RE`）
 * ごとに、その語の索引を二分探索して、本文の始まり以降で最初の終端を引く。
 *
 * ## `HEREDOC_RE` と1文字も変えない一致の規則
 *
 * 等価性は `bash-wait-guard-heredoc-scan.test.ts` が、元の正規表現を託宣として突き合わせる。
 *
 * - **終端の行は、本文の始まりの行より後ろに在る**（`[^\n]*\n[\s\S]*?\n` は、
 *   開始の行の改行の後に、もう1つ改行を要る。だから `cat <<E\nE` の空の本文は
 *   一致しない。元の癖をそのまま写した）
 * - **引用符の無い区切り語は、長いほうから順に短く読み直す**（`([A-Za-z_][\w]*)` は
 *   貪欲だが、失敗すると後戻りして短い語で試す。`<<EOFX` は、`EOFX` の終端が
 *   無ければ `EOF` の終端で閉じうる）。引用符付き（`<<'EOF'`）は、語の直後に
 *   引用符が要るので、語は1通りに決まる
 * - **見つからなければ、次の位置から開始を探し直す**（`g` の置換が失敗した位置の
 *   次へ進むのと同じ）。見つかれば、一致の終わりの後から探す
 */
export function findHeredocs(command: string): HeredocSpan[] {
  if (!command.includes('<<')) return [];

  const terminators = new Map<string, HeredocTerminator[]>();
  for (
    let newline = command.indexOf('\n');
    newline !== -1;
    newline = command.indexOf('\n', newline + 1)
  ) {
    let i = newline + 1;
    while (command[i] === ' ' || command[i] === '\t') i += 1;
    const first = command[i];
    if (first === undefined || !HEREDOC_WORD_START_RE.test(first)) continue;
    let j = i + 1;
    while (j < command.length && HEREDOC_WORD_CHAR_RE.test(command[j] ?? '')) j += 1;
    const next = command[j];
    if (next !== undefined && !HEREDOC_TERMINATOR_FOLLOW_RE.test(next)) continue;
    const word = command.slice(i, j);
    const list = terminators.get(word);
    const entry = { newline, end: j };
    if (list === undefined) terminators.set(word, [entry]);
    else list.push(entry);
  }

  const spans: HeredocSpan[] = [];
  HEREDOC_OPENER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEREDOC_OPENER_RE.exec(command)) !== null) {
    const quote = m[1] ?? '';
    const word = m[2] ?? '';
    const bodyStart = m.index + m[0].length;
    // 引用符付きは語が1通り。引用符無しは、長い語から順に短く読み直す。
    const lengths = quote === '' ? word.length : 1;
    let found: HeredocTerminator | undefined;
    for (let k = 0; k < lengths && found === undefined; k += 1) {
      const delimiter = quote === '' ? word.slice(0, word.length - k) : word;
      const list = terminators.get(delimiter);
      if (list !== undefined) found = firstTerminatorAtOrAfter(list, bodyStart);
    }
    if (found === undefined) {
      HEREDOC_OPENER_RE.lastIndex = m.index + 1;
      continue;
    }
    spans.push({ start: m.index, end: found.end, bodyStart, bodyEnd: found.newline });
    HEREDOC_OPENER_RE.lastIndex = found.end;
  }
  return spans;
}

/**
 * `NAME=値` 形の代入の値の部分——末尾の空白は含まない（呼び出し側が `\s+` を
 * 付けて繰り返す）。
 *
 * ⚠️ **issue #2068 C族で直した——値の中に空白を含む引用符形
 * （`X="a b"`）を読めるようにした。** 以前は `\S*`（非空白の続き）だけで、
 * 最初の空白までしか値として読めなかった（`bash-wait-guard.test.ts` の
 * 「値が空白を含む引用符形の代入」で `it.fails` として固定していた）。
 *
 * `ENV_ASSIGNMENT_VALUE_SRC` = `(?:"[^"]*"|'[^']*'|[^\s"'])*` ——
 * 「二重引用符区間」「単一引用符区間」「引用符でも空白でもない1文字」の
 * 3つを、**外側の `*` で任意回数**組み合わせる。1文字ずつしか進まない
 * 素の文字の選択肢と、区間を丸ごと1回で読む引用符の選択肢が、開始文字
 * （`"`/`'`/それ以外）で重ならないので、ある位置からどちらで読むかが
 * 常に1通りに決まる——`ENV_COMMAND_PREFIX_SRC` の doc と同じ「先頭の語が
 * 重ならない」設計をここでも保っている。素の文字を1文字ずつ読む形は
 * 一見遠回りだが、後戻りの余地が無いぶん指数的に増えない
 * （`'X="a b" '.repeat(5000)+'x'` で実測、後述）。
 *
 * 引用符を閉じていない値（`X="a`）はこの3択のどれにも一致しなくなった
 * 時点で読み取りが止まる——`\S*` の版と同じく、閉じていない引用符は
 * そこまでの文字だけが値になる（安全側、すり抜けを増やさない）。
 */
const ENV_ASSIGNMENT_VALUE_SRC = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'])*`;
const ENV_ASSIGNMENT_BODY_SRC = String.raw`[A-Za-z_][A-Za-z0-9_]*=${ENV_ASSIGNMENT_VALUE_SRC}`;

/**
 * `ENV_ASSIGNMENT_BODY_SRC` に末尾の空白を1個以上足した、繰り返し単位。
 *
 * ⚠️ **末尾の空白は `[ \t]+` にしてある（以前は `\s+`）。** `\s` は改行を含む
 * ので、`\s+` だと代入の鎖が改行を跨いで繋がり、改行の直後の開始位置ごとに
 * 残りの鎖を全部読み直す2乗の後戻りになっていた。`'A=1\n'.repeat(10000)+'x'`
 * （40KB）は、#2080 の直前の版で 478〜485ms、#2080 の後で 715〜788ms
 * （mgr-712ad619 の実測 2026-09-29T02:1xZ）。#2035 で予約語の後ろを `[ \t]+`
 * にしたのと同じ直し方である。**改行の直後は `COMMAND_POSITION_LOOKBEHIND_SRC`
 * が別の開始位置として拾うので、`A=1\ngh pr merge 1 -d` のような形は引き続き
 * 弾く**（2行目の `gh` がそのままコマンドの位置に在る）。`timeout` と `env` の
 * 前置き（`TIMEOUT_COMMAND_PREFIX_SRC` / `ENV_COMMAND_PREFIX_SRC`）の末尾も、
 * 同じ理由で `[ \t]+` にした。
 */
const ENV_ASSIGNMENT_SRC = String.raw`${ENV_ASSIGNMENT_BODY_SRC}[ \t]+`;

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
/**
 * `timeout` 自身のオプション（issue #2068 B族で追加）。**継続時間の手前に
 * 来るものだけ**を対象にする——`-k <秒>`（`SIGKILL` を送るまでの猶予）・
 * `--kill-after=<秒>`・`-s <シグナル>`/`--signal=<シグナル>`（送るシグナル）
 * ・`--preserve-status`（終了コードを子のものにする）。各選択肢は自分の
 * 末尾に必須の区切り空白 `[ \t]+` を持つ自己完結の形にしてある——
 * `ENV_COMMAND_OPTION_SRC` と同じ理由（1個ずつが独立して終端するので、
 * 繰り返しの中で「どこまでが1個のオプションか」があいまいにならない）。
 *
 * **#2423 で GNU timeout の文法どおりに広げた。** GNU の短いフラグは値なしの
 * `-f`（`--foreground`）・`-v`（`--verbose`）・`-p`（`--preserve-status`）と、
 * 値を取る `-k`（`--kill-after`）・`-s`（`--signal`）。値は詰めても
 * （`-k5`・`-sKILL`）空白で区切っても（`-k 5`）よく、長い形は `=` でも空白でもよい。
 * 値なしの短いフラグは束ねられる（`-fv`・`-vk5`）。選択肢は先頭の文字列で
 * 排他（`--kill-after`/`--signal`/`--foreground`/`--preserve-status`/`--verbose`
 * と `-` + 束）で、値は `\S+`（空白を含まない）なので、1語の読み方は1通りに決まる。
 * 束は `-[fvp]*` の後ろが `[ks]` か空白かで分かれ、`[fvp]` と `[ks]` は重ならない。
 *
 * 継続時間は `timeout` の最初の非オプション語なので、`[^\s-]\S*` で読み飛ばす
 * （`1e1`・`0x10`・`inf` も通る。`-` 始まりを除くのでオプションと重ならない。
 * 上の小数の doc は、この緩めた読み方の一部として引き続き成り立つ）。
 * 先頭の語は `/usr/bin/timeout` のようなパス付きも読む。パス部分は `=` を含めない
 * （`[^\s=]{0,62}`）—— `ENV_ASSIGNMENT_SRC` の語（`A=/x/timeout`）と同じ語が2通りに
 * 読めると、同じ語の繰り返しで読み方が指数的に増えるため。**上限は必須**:
 * 無制限の `*` だと、空白の無い長い1語（`a;a;a;…`）で各開始位置が語末まで走り2乗になった
 * （bash-wait-guard-heredoc-scan の時間の歯が赤くなった。`ssh` の `\S{0,64}` と同じ手当て）。
 *
 * **パスは `/`・`./`・`../`・`~/` で始まる形だけを読む**（`TIMEOUT_PATH_SRC`）。任意の文字から
 * 始められる形（`[^\s=]{0,64}\/`）だと、上限があっても**すべての開始位置で最大64文字先まで
 * `/` を探して引き返す**ので、`a;a;a;…` の1回あたりが約2.6倍に遅くなり（`a;`×40000 で
 * 107ms → 283ms）、上の時間の歯が混んだ CI で 5000ms を超えた（#2444 の CI、#2423 の後始末）。
 * 先頭の1文字（`/` `.` `~`）で候補を絞れば、それ以外の位置は1文字目で落ちる。`bin/timeout` の
 * ような `./` の無い相対パスは読まないが、読み飛ばせないだけで誤って弾く向きには倒れない。
 *
 * 残る穴: 長いオプションの省略形（`--kill=5`・`--sig KILL`。GNU の getopt は
 * 一意な省略を受ける）と `--`（オプションの終わり）は読まない。読めないだけで、
 * 誤って弾く方向にはならない。
 */
const TIMEOUT_COMMAND_OPTION_SRC = String.raw`(?:--kill-after(?:=\S*|[ \t]+\S+)[ \t]+|--signal(?:=\S*|[ \t]+\S+)[ \t]+|--(?:foreground|preserve-status|verbose)[ \t]+|-[fvp]+[ \t]+|-[fvp]*[ks](?:\S+|[ \t]+\S+)[ \t]+)`;
const TIMEOUT_PATH_SRC = String.raw`(?:(?:~|\.{1,2})?\/(?:[^\s=]{0,62}\/)?)`;
const TIMEOUT_COMMAND_PREFIX_SRC = String.raw`${TIMEOUT_PATH_SRC}?timeout[ \t]+(?:${TIMEOUT_COMMAND_OPTION_SRC})*[^\s-]\S*[ \t]+`;

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
/**
 * `env` 自身のオプション（issue #2068 B族で追加）——`-u NAME`（既存）に
 * `-i`（環境を空にする）・`--`（オプション終端）・`-S <文字列>`（分割文字列、
 * `--split-string` の短縮）・`--unset=NAME`（`-u` の long form）を足した。
 * 各選択肢は自分の末尾に必須の区切り空白を持つ自己完結の形——理由は直下
 * の doc「ここで `env NAME=値 …` の `NAME=値` を読まない」と同じで、
 * 繰り返しの中で1個ぶんの境界が常に一意に決まるようにするため。
 */
const ENV_COMMAND_OPTION_SRC = String.raw`(?:-u[ \t]+\S+[ \t]+|--unset=\S+[ \t]+|-S[ \t]+\S+[ \t]+|-i[ \t]+|--[ \t]+)`;
const ENV_COMMAND_PREFIX_SRC = String.raw`env\b[ \t]+(?:${ENV_COMMAND_OPTION_SRC})*`;

/**
 * bash の予約語・グルーピングが、直後の `gh pr merge` を「コマンドの位置」
 * から隠してしまう穴を塞ぐ前置き（issue #2035）。
 *
 * ## 穴の形
 *
 * `GH_PR_MERGE_DELETE_BRANCH_RE` の外側の lookbehind
 * （`(?<=^|[;&|\n])`）は、「行頭・`;`・`&`・`|`・改行の**直後**」だけを
 * コマンドの位置と認めていた。しかし bash では、予約語（`if`/`then`/
 * `elif`/`else`/`while`/`until`/`do`/`coproc`/`time`/`!`）やグルーピング
 * （`(`・`)`・バッククォート、`$(`/`<(` も `(` の字面で拾える）の**直後**
 * にもコマンドが来る。この直後は上のどの区切り文字でもないので、
 * lookbehind が届かず検出をすり抜けていた。実例（依頼者が実測、すべて
 * 直す前は `blocked: false`）: `if true; then gh pr merge 1
 * --delete-branch; fi` / `for i in 1; do gh pr merge $i --delete-branch;
 * done` / `{ gh pr merge 1 --delete-branch; }` / `(gh pr merge 1
 * --delete-branch)` / `! gh pr merge 1 --delete-branch` /
 * `while gh pr merge 1 -d; do :; done` / `time gh pr merge 1
 * --delete-branch` / `` echo `gh pr merge 1 --delete-branch` `` /
 * `case x in *) gh pr merge 1 --delete-branch;; esac` / `coproc gh pr
 * merge 1 --delete-branch` / `f() { gh pr merge 1 -d; }` 等（歯は
 * `bash-wait-guard-delete-branch-issue-2035.test.ts`）。
 *
 * **数える単位**: bash の文法で、直後の語をコマンドの位置に置く予約語と
 * グルーピング（`if then elif else while until do time coproc ! {` と、
 * `(` `)` バッククォート）。`sudo`/`nice`/`xargs`/`command`/`exec`/
 * `nohup` のような**コマンドとしての前置き**は別の類（1件ずつ検討する
 * 方針、#1192 のオーナー決定）なので、この issue では扱わない——下の
 * 「弾けないと分かっている形」に残す。
 *
 * ## 直し方は2箇所——lookbehind とキーワードの前置き、別々に足す
 *
 * 1. **グルーピング（`(` `)` バッククォート）は、外側の lookbehind の
 *    文字集合へ足す。** これらの文字は1文字そのものが区切りなので、
 *    `;`/`&`/`|`/改行と同じ扱いでよい（`GH_PR_MERGE_DELETE_BRANCH_RE` の
 *    lookbehind 参照）。
 * 2. **予約語（`if`/`then`/…/`time`/`!`/`{`）は、ここ
 *    `LEADING_ENV_PREFIX_SRC` の選択肢へ `SHELL_KEYWORD_PREFIX_SRC` として
 *    足す。** 予約語は複数文字の「語」であって1文字の区切りではない。
 *    この lookbehind は「直前の1文字が区切りか」だけを見る形にしてある
 *    （JS の lookbehind 自体は可変長を許すが、語をここへ入れると、語が
 *    コマンドの位置に在るかをもう一度 lookbehind の中で問うことになる）。
 *    だから語は、環境変数の代入・`timeout`・`env` コマンドと同じく、
 *    **読み飛ばす前置き**として Kleene star の中で消費する。前置きの列は
 *    lookbehind が認めた位置からしか始まらないので、先頭の予約語は必ず
 *    コマンドの位置に在る。
 *
 * ⚠️ **`!` と `{` は、あえて2つのどちらの直し方にも「lookbehind の文字
 * 集合」としては足していない。** 足すと、その文字が**何度も現れる入力**で
 * 2乗の後戻りが生まれる——実測: `'if then do time ! { '.repeat(3000)+'x'`
 * が、`!`/`{` を lookbehind の文字集合にも足した版では 546ms、この版
 * （語の側だけで読む）では 5.9ms（直す前・キーワード自体が無い版は
 * 3.8ms）。理由: lookbehind の文字集合に `!`/`{` を足すと、それらの**直後
 * のあらゆる位置**が新しい「コマンドの位置」になり、区切り文字が無い
 * 長い繰り返し入力でも `!`/`{` の出現回数ぶんだけ独立した開始位置が生まれ
 * る。各開始位置での一致の試行はそれ自体は線形でも、開始位置が入力長に
 * 比例して増えるので全体は2乗になる。`!`/`{` を**語の直後に空白を要求する
 * 前置きの選択肢**（`SHELL_KEYWORD_PREFIX_SRC` 内）としてだけ読めば、実際に
 * 一致を試みる開始位置は「元から区切り文字だった位置」だけのまま増えない
 * ——後戻りは線形に留まる（歯は
 * `bash-wait-guard-delete-branch-issue-2035.test.ts` の「後戻りが2乗に
 * 増えない」節）。
 *
 * ⚠️ **予約語の直後の空白は `[ \t]+` に固定し、`\s+` にしない。** `\s` は
 * 改行も含むので、`\s+` にすると予約語の連鎖が**改行を跨いで**繋がる。
 * 改行の直後は lookbehind が認める開始位置なので、`'then\n'.repeat(n)` の
 * ような入力では、各開始位置からの試行が残りの連鎖を全部読むことになり、
 * `!`/`{` と同じ形の2乗になる（実測 2026-09-28T23:29Z: 予約語の後ろを
 * `\s+` にした試作では `'then\n'.repeat(10000)+'x'` が 589.9ms・
 * `'do\n'.repeat(15000)+'x'` が 947.9ms、この版では 3.4ms・1.0ms。なお
 * 直す前から在る `ENV_ASSIGNMENT_SRC` の `\s+` には同じ形が残っていて、
 * `'A=1\n'.repeat(10000)+'x'` は直す前も後も 400ms 前後かかる——この PR
 * では触っていない）。`[ \t]+` なら、予約語の連鎖は区切りの文字で
 * 必ず切れるので、各開始位置からの試行は次の区切りまでで終わる。改行の
 * 後ろは lookbehind が別に拾うので、漏れは出ない。
 *
 * ## 選択肢の先頭の語は互いに重ならない（#1887 / #1939 の設計を崩さない）
 *
 * `SHELL_KEYWORD_PREFIX_SRC` を加えても、`(?:A|T|E)*` が
 * `(?:K|A|T|E)*` になるだけで、後戻りが指数的に増えない設計
 * （`ENV_COMMAND_PREFIX_SRC` の doc）は崩れない —— 4つの選択肢は先頭の
 * 文字列で互いに重ならない: `if=`（環境変数の代入）と `if `（予約語）は
 * 3文字目（`=` か空白か）で分かれ、`time `（予約語）と `timeout `
 * （`TIMEOUT_COMMAND_PREFIX_SRC`）は5文字目（空白か `o` か）で分かれる。
 * ある位置から先の文字列を「予約語」「代入」「`timeout`」「`env`」の
 * どれと読むかが常に1通りに決まるので、後戻りが要らない。
 *
 * ## 誤検知の向きは受け入れる（すり抜けを作らないほうを優先する）
 *
 * この直しは「弾く」側を広げる変更なので、新しい誤検知が生まれうる——
 * 受け入れる。たとえば `echo "(gh pr merge 1 -d)"` は直す前は通っていた
 * （引用符の中の `(` の直後という、この直しが新しく拾う位置）が、直した
 * 後は弾く（`echo "; gh pr merge 1 -d"` のような、以前から在る「引用符の
 * 中の演算子の直後」の誤検知と同じ族）。一方で `echo then gh pr merge 1
 * --delete-branch` は引き続き**通る**——`then` は `echo` の引数であって
 * コマンドの位置に無いので、`SHELL_KEYWORD_PREFIX_SRC` はそもそもここへ
 * 一致を試みる開始位置に無い（`echo` の直後は lookbehind の対象外のまま）。
 */
const SHELL_KEYWORD_PREFIX_SRC = String.raw`(?:(?:if|then|elif|else|while|until|do|coproc|time(?:[ \t]+-p)?|[!{])[ \t]+)`;

/**
 * それ自体が1個のコマンドとして実行される「前置きのコマンド」（issue #2068
 * A族）。`SHELL_KEYWORD_PREFIX_SRC`（bash の予約語・グルーピング、それ自体は
 * コマンドとして実行されない）とは別の族——こちらは実際に fork/exec される
 * 本物のコマンドで、`sudo`/`nice` のように「次に来るコマンドを何らかの形で
 * 包んで実行する」ものだけを対象にする。
 *
 * 列挙: `sudo`/`doas`（権限昇格）・`nice`/`ionice`（優先度）・`nohup`
 * （ハングアップ無視）・`command`/`builtin`（シェル関数・エイリアスの
 * 迂回）・`exec`（現在のシェルを置き換える）・`xargs`（標準入力から引数を
 * 組み立てて実行）・`setsid`（新しいセッション）・`stdbuf`（バッファリング
 * 変更）・`chronic`（moreutils、静かな成功時は出力を捨てる）・`unbuffer`
 * （expect 付属、疑似端末を割り当てる）・`caffeinate`（macOS、スリープ
 * 抑止）。issue #2035 の doc「弾けないと分かっている形」がここに挙げていた
 * `sudo`/`nice`/`xargs`/`command`/`exec`/`nohup` を含む。
 *
 * **列挙なので、ここに無い前置きは読み飛ばせない。** 残る形は doc
 * 「弾けないと分かっている形」に書く（`strace`/`ltrace`/`script`/`su`/
 * `runuser`/`systemd-run`/`firejail`/`ssh <host>` 等——1件ずつ検討する方針、
 * #1192 のオーナー決定は変えていない。今回は依頼者が挙げた列挙だけを足す）。
 *
 * ## オプションの読み方（`LEADING_COMMAND_PREFIX_OPTION_SRC` の doc に詳しい）
 *
 * 分離した値（`-u bot`/`-n 10`）とくっついた値（`-oL`/`-I{}`）を、構造的に
 * 重ならない2つの選択肢として読む。**最初の版（`-\S+` に任意で「空白+もう
 * 1トークン」を足しただけの形）は指数的な後戻りを生んだ**——理由と実測は
 * `LEADING_COMMAND_PREFIX_OPTION_SRC` の doc。
 *
 * どの短いオプションが実際に値を取るかは前置きコマンドごとに違う
 * （`sudo -u` は値を取る、`sudo -n` は取らない、等）が、**ここでは区別
 * しない**——「1文字+空白+別トークン」という形さえしていれば分離した値
 * として読む。区別しない理由は2つ: (1) 値を取らないオプションの直後に
 * たまたま次の非オプション語が来ても、その語が別の前置き名や `gh` の
 * どちらにも一致しなければその場で行き止まりになるだけで実害が無い
 * （`LEADING_COMMAND_PREFIX_OPTION_SRC` の doc「その場で行き止まりに
 * なる」）(2) 前置きごとに個別のオプション文法を持たせると列挙が膨らむ。
 */
const LEADING_COMMAND_PREFIX_NAME_SRC = String.raw`(?:sudo|doas|nice|ionice|nohup|command|builtin|exec|xargs|setsid|stdbuf|chronic|unbuffer|caffeinate)`;

/**
 * `gh` という語そのものの書き方（issue #2068 D族）。
 *
 * - **パス付き**（`/usr/local/bin/gh`・`./gh`）—— `(?:\S*\/)?gh` の
 *   任意グループが拾う。`\S*` は空白を跨がないので、パスの区切り `/` の
 *   直前までを1トークンとして読む。パスが無い（`gh` 単体）場合も同じ
 *   選択肢が0文字のパスとして一致する——素の `gh` の既存の挙動は変わらない。
 * - **バックスラッシュ**（`\gh`。エイリアス・シェル関数を迂回する書き方）
 *   —— `\\gh`。
 * - **引用符で囲んだだけ**（`"gh"`・`'gh'`）—— リテラル。
 *
 * どの形も直後に `\s+pr\s+merge` が続くことを要求するのは変わらないので、
 * `ghost`/`ghcli` のような別の語を誤って `gh` と読むことはない
 * （`gh` の直後が単語構成文字だと `\s+` の手前で一致しない）。
 *
 * ⚠️ **確かめていないこと**: この4形すべてで bash が実際に `gh` を実行
 * するかどうか自体は確認済み（パス付き・`\gh`・引用符はいずれも通常の
 * argv 分割で素の `gh` になる、bash の一般的な挙動）。**確かめていない
 * のは、この検出器の外側**——たとえば `PATH` にそのパスの `gh` が実在
 * するか等、実行時の話は判定に影響しない（この検出器は文字列だけを見る
 * 純関数）。
 *
 * ⚠️ **issue #2104 の作業中に発見（この PR では直していない、既存の穴）**:
 * `(?:\S*\/)?gh` の `\S*` が無制限なので、`;` が大量に並ぶ入力
 * （`'a;'.repeat(n) + 'gh pr merge 1 --delete-branch'`）で `GH_PR_MERGE_
 * DELETE_BRANCH_RE` の直接一致そのものが O(n^2) になる（実測 mgr-712ad619
 * 2026-09-29: main 2c8876f3 の写しで n=8000 が74ms・n=16000 が328ms——
 * 4倍/4倍の伸び）。この PR（issue #2104）の新しい `SHELL_NAME_SRC` は同じ
 * 構造の穴を避けるため `\S{0,64}` に絞ったが（doc 参照）、**この
 * `GH_WORD_SRC` 自身は直していない**——問い1で「別の穴」（すり抜けでは
 * なく後戻りの性能）、問い2で「既存の挙動、この PR は触っていない」に
 * 当たると判断した（AGENTS.md「範囲外でも気づいたことは上げる」）。次に
 * ここを触る人は、`\S*` を `\S{0,64}` に絞る同じ直し方が使えることを
 * `SHELL_NAME_SRC` の doc で確認できる。
 */
const GH_WORD_SRC = String.raw`(?:\\gh|"gh"|'gh'|(?:[^\s;&|()<>\u0060"']*\/)?gh)`;

/**
 * 1個ぶんのオプションを、**2つの重ならない形**として読む——
 * (1) 単一文字のフラグ+空白+別トークンの値（`-u bot`/`-n 10`。1文字の
 * あとに**必ず空白**が来ることを要求する） (2) ダッシュ+空白を含まない
 * 続き全体（`-oL`/`-I{}` のような、値が直接くっついた形。1文字より長い
 * 続きでも、次が空白ならそれだけで1トークン）。
 *
 * ⚠️ **最初の版は `-\S+(?:[ \t]+\S+)?`（1トークン+任意でもう1トークン）
 * だった。これは指数的な後戻りを生んだ**——`stdbuf -oL `.repeat(n) で
 * 実測、n=20 で26ms、n=30 で28755ms（約29秒）。原因: 値が直接くっついた
 * 形（`-oL`）には分離した値が実在しないのに、「任意でもう1トークン
 * 読む」という選択肢が**次の繰り返し単位の前置きコマンド名そのもの**
 * （`stdbuf`）を「値」として飲み込めてしまい、飲み込む/飲み込まないの
 * 2択が繰り返しの回数ぶん独立に生まれた（2^n）。飲み込んでも入力が
 * 周期的なので後続がそのまま同じパターンで一致し続けてしまい、失敗が
 * 判明するのは文字列の末尾まで達したときだけ——各分岐が「すぐには失敗
 * しない」ため、指数的な組み合わせを最後まで律儀に試みてしまっていた。
 *
 * ⟹ **1文字フラグ+空白+値**（分離形）と**ダッシュ+空白を含まない続き**
 * （くっついた形）を、構造的に重ならない2つの選択肢に分けた。分離形は
 * 「1文字の直後が空白であること」を要求するので、`-oL`（1文字目の直後が
 * 'L'）にはそもそも一致を試みない——選択の余地が最初から無い。逆に
 * `-u bot` では、選択肢(2)（`-\S+` だけ）も「`-u` +空白」までは一致できて
 * しまうが、そこで `bot` を置き去りにすると次のオプション反復も次の
 * 前置き名の一致も失敗し（`bot` はどちらの語彙にも無い）、**その場で
 * 行き止まりになる**——`stdbuf -oL` の場合と違い、置き去りにした語が
 * 次の繰り返し単位の一部として再合流できないので、分岐は増えない。
 *
 * ⚠️ **レビューで、上の「分岐は増えない」は成り立たないと分かった**（mgr-712ad619、
 * 2026-09-29T01:1xZ 実測）。値の位置に `-` で始まる語が来ると、(1) の値として
 * 飲み込む読みと、(2) で `-u` だけを読んで次の語を次のオプションとして読む読みが、
 * **同じ続きへ再合流する**。`'sudo ' + '-a '.repeat(n) + 'x'` は n=24 で 0.5ms、
 * n=28 で 3.5ms（4 増えるごとに約7倍＝フィボナッチの伸び）で、n=40 で1秒を
 * 超える。値に前置きの名前が来る形（`sudo -u sudo -u sudo …`）も同じ形で再合流する。
 *
 * ⟹ (1) の値を `LEADING_COMMAND_PREFIX_VALUE_SRC` に絞った。値は `-` で
 * 始まらず、次の前置き・予約語・代入・`env`・`gh` の語の始まりでもない。
 * これで、1文字のオプションの後ろの語を値として読むか読まないかが、常に
 * 1通りに決まる。**値から外す語は、値として読まなかったときの続きが必ず
 * `gh` まで届く語に限る。** `timeout`（後ろに継続時間を要する）と
 * `flock`（後ろにファイルを要する）は外さない。外すと `sudo -u timeout gh
 * pr merge 1 -d` の `timeout` を値として読めなくなり、すり抜ける。この2語は、
 * 値として読んだ場合と前置きとして読んだ場合とで次に来るべき語が食い違う
 * （値として読めば次はオプションか前置き、前置きとして読めば継続時間か
 * ファイル）ので、どちらか片方は次の語で必ず行き止まりになり、再合流しない。
 */
const LEADING_COMMAND_PREFIX_VALUE_SRC = String.raw`(?!-)(?!(?:(?:if|then|elif|else|while|until|do|coproc|time)[ \t]|[!{][ \t]|[A-Za-z_][A-Za-z0-9_]*=|env\b|${LEADING_COMMAND_PREFIX_NAME_SRC}\b|${GH_WORD_SRC}\s))\S+`;

const LEADING_COMMAND_PREFIX_OPTION_SRC = String.raw`(?:-[A-Za-z][ \t]+${LEADING_COMMAND_PREFIX_VALUE_SRC}[ \t]+|-\S+[ \t]+)`;

const LEADING_COMMAND_PREFIX_SRC = String.raw`(?:${LEADING_COMMAND_PREFIX_NAME_SRC}\b[ \t]+(?:${LEADING_COMMAND_PREFIX_OPTION_SRC})*)`;

/**
 * `flock <file> <command…>` の前置き（issue #2068 A族の一部）。
 *
 * 他の前置きと違い、`flock` はオプションの後ろに**素のファイルパス**
 * （フラグではない位置引数）を1個要求してから初めて包んだコマンドが来る。
 * `LEADING_COMMAND_PREFIX_OPTION_SRC` を再利用すると、値を取らない
 * `flock` 自身のオプション（`-n` 等）が後ろの位置引数を「値」として
 * 誤って飲み込んでしまう（`-[A-Za-z][ \t]+\S+[ \t]+` の分離形が、
 * `flock` の実際の文法を知らずに「次の1トークンは値だ」と判断するため）
 * ので、**あえてオプションを解かず**、`flock` の直後は常に位置引数
 * （ロックファイルのパス）だと読む——`flock -n /tmp/l gh …` のような
 * オプション付きの形はこの版では読み飛ばせない（doc「弾けないと分かって
 * いる形」に書く）。
 *
 * ⚠️ **その後、`flock` 自身のオプションを読むようにした**（mgr-712ad619、2026-09-29T06:2xZ）。
 * `flock -n /tmp/l gh pr merge 1 -d` など、オプション付きの7形がすり抜けていた。
 * （#2402: 短いオプションの束ねで最後が `w` / `E` の形 `-nw 5` も、値を1つ取る側で読む。
 * 値を取らない側の否定の先読みも同じ形に揃えてあるので、1つの語の読み方は1通りのまま。）
 * `FLOCK_OPTION_SRC` が、値を取るもの（`-w` / `-E` と長い形の `--wait` /
 * `--timeout` / `--conflict-exit-code`）と、値を取らないもの（`-n` / `-x` / `--nonblock` …）
 * を分けて読む。**値を取らない側は、値を取る名前を否定の先読みで除く**（`-w` を値なしで
 * 読む選択肢も、`--timeout=5` を両方の選択肢が読む形も作らない）。だから値を取る名前は
 * 必ず値を1つ取り、1つの語をどの選択肢で読むかは常に1通りに決まる。PR #2080 の指数の
 * 後戻り（オプションの2つの読み方の再合流）は起きない。**値そのものは `-` で始まって
 * もよい**（`flock -w -n …` のような誤った書き方も読み飛ばし、すり抜けの向きに倒さない。
 * 値に `(?!-)` を付けても後戻りは変わらないことを変異で確かめた）。
 *
 * **ファイルの位置引数は `-` で始まらない語に絞った。** これで `'sudo ' + '-u flock '.repeat(n)`
 * の2乗が消えた（下の ⚠️）。
 * `flock <file> -c <文字列>` の形は、文字列を `sh -c` に渡すので、#2104 の入口として
 * 読む（`FLOCK_DASH_C_RE`）。
 *
 * ⚠️ **28形の対照テストには含めていない**（Issue の必須の31形に `flock` は
 * 無い）。A族の列挙に明記して依頼されたので足したが、実際に `gh` が
 * 絡む形での確認は無い——`.scratch` の検証スクリプトで手元確認したのみ。
 *
 * ⚠️ **`'sudo ' + '-u flock '.repeat(n) + 'x'` は2乗で伸びる**（n=200 で
 * 0.7ms・n=2000 で 54.9ms。mgr-712ad619 の実測 2026-09-29T01:1xZ）。
 * `flock` は `LEADING_COMMAND_PREFIX_VALUE_SRC` の値から外していない
 * （外すと `sudo -u flock gh …` がすり抜ける。そちらの doc）ので、`flock`
 * の語ごとに「値として読む」「前置きとして読む」の2つを試す。後者は次の
 * 1語で行き止まりになるので指数にはならないが、各開始位置で残りを読む分
 * だけ2乗になる。すり抜けは作らず、18KB で 200ms の予算にも収まるので、
 * この版では直していない。**⟹ その後、ファイルの位置引数を `-` で始まらない語に絞った
 * ことで線形になった**（`-u` をファイルとして読む分かれ道が無くなった。n=8000 で
 * 3445.4ms → 5.2ms。mgr-712ad619 の実測 2026-09-29T06:2xZ。歯は
 * `bash-wait-guard-delete-branch-flock.test.ts`）。
 */
const FLOCK_OPTION_SRC = String.raw`(?:-[A-Za-z]*[wE][ \t]+\S+|--(?:wait|timeout|conflict-exit-code)(?:=\S+|[ \t]+\S+)|(?!-[A-Za-z]*[wE](?:[ \t]|$))(?!--(?:wait|timeout|conflict-exit-code)(?:[ \t=]|$))(?!-c(?:[ \t]|$))(?!--command(?:[ \t=]|$))-\S+)`;

const FLOCK_PREFIX_SRC = String.raw`(?:flock\b(?:[ \t]+${FLOCK_OPTION_SRC})*[ \t]+(?!-)\S+[ \t]+)`;

/**
 * コマンド位置と `gh` のあいだで読み飛ばす前置き全体 —— bash の予約語
 * （`SHELL_KEYWORD_PREFIX_SRC`、issue #2035）・単純な代入の繰り返し・
 * `timeout <数字><単位?>`・`env` コマンドの4つを、**順不同・回数任意**で
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
 * PREFIX_SRC` の doc に理由を書いた。issue #2035 で足した予約語の選択肢
 * （`SHELL_KEYWORD_PREFIX_SRC`）も同じ設計を保ったまま先頭へ加えた——
 * 理由はそちらの doc に書いた。
 *
 * ⚠️ **issue #2068 で `LEADING_COMMAND_PREFIX_SRC`（A族、コマンドとしての
 * 前置き）・`FLOCK_PREFIX_SRC`（`flock`）の2つを足した——`(?:K|A|T|E)*` が
 * `(?:K|A|T|E|L|F|)*` になった。** 先頭の語は引き続き重ならない——
 * `LEADING_COMMAND_PREFIX_NAME_SRC` の列挙（`sudo`/`doas`/…）と `flock`
 * は、他のどの選択肢の先頭の語（予約語・`NAME=`・`timeout `・`env `）とも
 * 文字列として重複しない固有の語である。後戻りが増えないことは
 * `bash-wait-guard-delete-branch-issue-2068.test.ts` の時間の歯で確認した。
 */
const LEADING_ENV_PREFIX_SRC = String.raw`(?:${SHELL_KEYWORD_PREFIX_SRC}|${ENV_ASSIGNMENT_SRC}|${TIMEOUT_COMMAND_PREFIX_SRC}|${ENV_COMMAND_PREFIX_SRC}|${LEADING_COMMAND_PREFIX_SRC}|${FLOCK_PREFIX_SRC})*`;

/**
 * 外側の lookbehind の文字集合（issue #2035 で `(` `)` バッククォートを
 * 足した）。`\u0060` はバッククォートの unicode エスケープ——`String.raw`
 * の中に生のバッククォード文字を書くとテンプレートリテラル自体が終端
 * してしまうため、既存の `DOUBLE_QUOTED_VALUE_SRC` と同じ表記に揃えた。
 *
 * `(` `)` を足す理由は `SHELL_KEYWORD_PREFIX_SRC` の doc「穴の形」参照——
 * `(gh pr merge …)`・`` `gh pr merge …` ``・`case … *) gh pr merge …`
 * のように、グルーピングの直後は1文字の区切りなので、`;`/`&`/`|`/改行と
 * 同じ扱いでよい（`$(`/`<(` も `(` の字面で拾える——`$`/`<` 自体は特別
 * 扱いしない）。`!`/`{` をここへ足さない理由（2乗の後戻り）は同じ doc
 * 参照。
 */
const COMMAND_POSITION_LOOKBEHIND_SRC = String.raw`(?<=^|[;&|\n()\u0060])`;

/**
 * `computeOutsideQuoteMask` が返す、走査位置ごとの状態。
 *
 * - `outside`: どちらの引用符の中にも居ない（bash の「素の」構文位置）
 * - `single`: 単一引用符（`'…'`）の中
 * - `double`: 二重引用符の中
 * - `ansiC`: **ANSI-C クオート（`$'…'`）の中**（issue #1991 の作業中に
 *   発見、下の doc「`$'…'`（ANSI-C クオート）も状態機械で追う」参照）
 * - `unknown`: これ以上は確信を持って追えない（末尾がバックスラッシュで
 *   終わる等）。**一度なったら残り全部が `unknown` のまま**（sticky）。
 */
type OutsideQuoteScanState = 'outside' | 'single' | 'double' | 'ansiC' | 'unknown';

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
 * ## `$'…'`（ANSI-C クオート）も状態機械で追う（issue #1991 の作業中に発見）
 *
 * 直す前の版は `$'…'` を専用に扱っておらず、開きの `'` を普通の単一引用符
 * と同じ規則（エスケープ無し）で読んでいた。**これが誤りだった**——bash の
 * ANSI-C クオートの中では `\'` がエスケープとして効き、閉じ引用符を1つ
 * 読み飛ばして文字列を開いたままにする（普通の `'…'` には無い規則）。
 *
 * 誤りが実際にすり抜けを作ることを確認した（`argv-dump.sh` で bash の実際
 * の argv 分割を検証、2026-09-28、`bash-wait-guard-delete-branch-issue-1991.test.ts`
 * に生出力の要約がある）:
 *
 * ```
 * gh pr merge 1 $'z\' --subject "y' --delete-branch '"'
 * ```
 *
 * bash の読み（実測）: `$'z\' --subject "y'`（ANSI-C クオート1つ。`\'` で
 * エスケープされた `'` を含みながら、最後の素の `'` まで1つの引数
 * `z' --subject "y` として結合）+ **本物の、引用符無しの `--delete-branch`**
 * + 単一引用符 `'"'`。
 *
 * 直す前の状態機械の読み: `$` を特別扱いせず、直後の `'` を普通の単一引用符
 * の開始として `single` へ遷移させる。`single` 状態は `\` を特別扱いしない
 * ので、`\'` の `\` はただの文字として読み飛ばし、次の `'` を（本当はまだ
 * 閉じていないのに）閉じ引用符と誤認して `outside` へ早期に戻ってしまう。
 * この誤った `outside` の期間の中に、たまたま字面として書かれた
 * `--subject "` が「本物のフラグ」だと誤読され（指摘3と同じ形の誤読）、
 * その後ろの空白混じりの `y' --delete-branch ` が「`--subject` の二重
 * 引用符の値」として素直に閉じ位置（誤って `single` に入り直した後の
 * `"`）まで見つかってしまい、**本物の `--delete-branch` ごと空白へ潰されて
 * 検出から消える**。実測: 直す前は `inspectBashCommand` がこの文字列に対し
 * `{ blocked: false }` を返していた（`bash-wait-guard-delete-branch-issue-1991.test.ts`
 * の該当テストが直す前は赤だった）。
 *
 * ⟹ **`$'`（2文字のトークン）を専用の状態 `ansiC` として追う。** `outside`
 * 状態で `$` の直後が `'` なら（2文字消費して）`ansiC` へ遷移する。`ansiC`
 * の中では `double` と同じ規則で `\` が直後の1文字を読み飛ばし（2文字消費、
 * 状態は `ansiC` のまま）、エスケープされていない `'` だけが `outside` へ
 * 戻す（`"` は `ansiC` の中では特別扱いしない——ただの文字）。これで上の
 * 実例は、`\'` を正しくエスケープとして読み飛ばし、本当の閉じ引用符
 * （`y` の直後の `'`）まで `ansiC` のまま追えるようになり、`--subject`
 * の開始位置は（`ansiC` の中なので）`outside` ではないと正しく判定される
 * ——`stripGhPrMergeQuotedSubjectBodyValues` が潰さず、本物の
 * `--delete-branch` がそのまま残って引き続き検出される。
 *
 * ⚠️ **`$` それ自体は特別扱いしない**（直後が `'` のときだけ `$'` という
 * 2文字のトークンとして見る）。`$(...)`/`${...}`/`$var` のような他の `$`
 * の使い方は、この状態機械にとって以前と同じ「ただの文字」のままである
 * （下の「完全な shell 構文解析ではない」の限界と同根——`$'…'` の中では
 * bash 自身もコマンド置換や変数展開を行わないので、この状態機械が
 * それらを追わなくても矛盾は起きない）。
 *
 * ⚠️ **確かめていない・意図して直していない形**:
 *
 * - **`ansiC` の中で `\` が文字列の末尾に来る場合** は `unknown` へ遷移する
 *   （`double` と同じ fail-safe。個別のテストは追加していない——`double`
 *   状態の同じ経路で既に「読めないときは弾く側」の設計が確認されている
 *   ため、同じコードパスを再利用しているここでも成り立つと判断した）。
 * - **`$'…'` の中に書かれた `\$`/`` \` `` 等、実際には bash が特別な1文字へ
 *   変換するエスケープシーケンス**（`\n`/`\t`/`\xNN` 等）の**中身**まで
 *   忠実に解釈する必要は無い——この状態機械が要るのは「文字列がどこで
 *   閉じるか」だけであり、`\` の直後の1文字を無条件に読み飛ばす規則は
 *   どのエスケープシーケンスに対しても閉じ位置を正しく保つ（`double` の
 *   doc と同じ理由）。
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
  return computeQuoteScan(command).outside;
}

/**
 * `computeOutsideQuoteMask` の本体。引用符の外かを表す `outside` に加え、**シェルのコメント**
 * （`#` から行末の改行の手前まで）の位置を `comment` で返す（#2424）。
 *
 * ## コメント（`comment` 状態。#2424）
 *
 * `outside` のとき、**語頭**の `#`（先頭、または直前が空白・改行・`;` `&` `|` `(` `)`）が来たら、
 * 次の改行の手前までがコメント。bash はコメントの中を実行せず、引用符も開かない——だから
 * コメントの中の `-t '` を開き引用符と読むと、次の行の本物の `gh pr merge --delete-branch` まで
 * 値として潰れて素通しになっていた。コメントの位置は `outside` が false（「外」ではない）で、
 * 引用符も追わない（`\` も特別扱いしない。bash のコメントは `\` + 改行で続かない）。終わりの
 * 改行は `outside` へ戻った位置（true）なので、区切りとして数えられる。
 *
 * 語頭でない `#`（`foo#bar` / `$#` / `${#x}` / `a=#x` / `'a'#b` / `\ #`（エスケープした空白の直後））と、
 * 引用符の中の `#` はコメントではない。
 *
 * **呼び出し元ごとの読み方**（`outside` をそのまま使うもの・`comment` を別に見るもの）:
 * - `isSingleSimpleCommand` / `splitOutsideQuoteSimpleCommands`: コメントの中の `;` `|` `&` は区切りでは
 *   ない（bash も実行しない）。`outside` のまま読んでよい（正しい向き）。
 * - `blankQuotedInteriorForNonExecutingCommands`: 許可リストの単純コマンドの末尾コメントは空白に潰れる。
 *   実行されない字面なので正しい向き。許可リスト外の単純コマンドは生のまま（従来どおり）。
 * - `stripGhPrMergeQuotedSubjectBodyValues`: コメントの中の `-t '` は潰さない。これが #2424 の直し。
 * - `flattenSeparatorsInsideQuotes`: **`comment` を別に見る**。`outside` のままだとコメントの中の
 *   区切りを空白にし、`gh pr merge 1 # ; -d` のように実行されない `-d` まで呼び出し区間へ届いて
 *   偽陽性が増える。コメントの中の区切りは触らず、従来どおりにする。
 */
function computeQuoteScan(command: string): { outside: boolean[]; comment: boolean[] } {
  const mask: boolean[] = new Array(command.length);
  const comment: boolean[] = new Array(command.length);
  let state: OutsideQuoteScanState | 'comment' = 'outside';
  // 直前の `\` のエスケープが消費した最後の位置（その直後の `#` は語頭ではない）。
  let escapedEnd = -2;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (state === 'comment' && ch === '\n') state = 'outside';
    mask[i] = state === 'outside';
    comment[i] = state === 'comment';
    if (state === 'unknown' || state === 'comment') continue;
    if (state === 'outside') {
      if (ch === '\\') {
        if (i + 1 >= command.length) {
          state = 'unknown';
        } else {
          i += 1;
          escapedEnd = i;
        }
      } else if (
        ch === '#' &&
        (i === 0 || (i - 1 !== escapedEnd && ' \t\n;&|()'.includes(command[i - 1] as string)))
      ) {
        state = 'comment';
        mask[i] = false;
        comment[i] = true;
      } else if (ch === '$' && command[i + 1] === "'") {
        // `$'…'`（ANSI-C クオート）—— 2文字のトークンとしてまとめて消費し、
        // 専用の `ansiC` 状態へ遷移する（issue #1991 の作業中に発見。doc
        // 「`$'…'`（ANSI-C クオート）も状態機械で追う」参照）。普通の `'`
        // （`single`）とは違い、この中では `\` がエスケープとして効く。
        state = 'ansiC';
        i += 1;
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
    } else if (state === 'ansiC') {
      // `double` と同じ規則——`\` は直後の1文字を無条件に読み飛ばす（2文字
      // 消費、状態は `ansiC` のまま）。`"` は特別扱いしない（ただの文字）。
      if (ch === '\\') {
        if (i + 1 >= command.length) {
          state = 'unknown';
        } else {
          i += 1;
        }
      } else if (ch === "'") {
        state = 'outside';
      }
    }
  }
  return { outside: mask, comment };
}

/**
 * `bash`/`sh`/`zsh`/`dash`/`ksh`。パス付き（`/bin/sh`）も読む——`GH_WORD_SRC`
 * と同じ考え方だが、**パス部分の量指定子は無制限の `\S*` にしていない**
 * （`GH_WORD_SRC` はそうしている）。
 *
 * ⚠️ **`\S*\/`（無制限）は、区切り文字の多い入力で2乗の後戻りを起こす**
 * （mgr-712ad619 実測 2026-09-29）。`(?:\S*\/)?` は「パス無し」の場合、
 * `\S*` がまず次の空白まで貪欲に伸び、末尾の `/` を見つけられずに1文字ずつ
 * 後戻りする——`/` が1つも無い入力ではゼロまで後戻りする。これ自体は
 * その1回の試行では線形だが、`COMMAND_POSITION_LOOKBEHIND_SRC` が
 * 「`;` の直後」を毎回コマンド位置として認めるので、`;` が大量に並ぶ入力
 * （`'a;'.repeat(n)` の後ろに本物の呼び出し）では、コマンド位置の候補が
 * 入力長に比例して増え、各候補での後戻り幅（次の空白までの距離）も
 * ほぼ入力長に比例するため、全体が O(n^2) になる（実測: `'a;'.repeat(n) +
 * 'bash -c "bash -c \'gh pr merge 1 -d\'"'` が n=4000 で27ms・n=8000 で
 * 95ms・n=16000 で推定350ms超——4倍ごとに約4倍、2乗の伸び）。
 *
 * ⟹ パス部分の量指定子を `\S{0,64}`（最大64文字）に絞った——現実の
 * シェルバイナリのパスがこれを超えることは無いと判断した実務上の妥協
 * （既存の `GH_WORD_SRC` の設計とは異なる、この PR だけの直し方）。後戻りの
 * 幅が定数（64）に抑えられるので、コマンド位置の候補数に比例して増えても
 * 全体は線形のまま——実測は
 * `bash-wait-guard-delete-branch-issue-2104.test.ts` の時間の歯。
 *
 * ⚠️ **同じ構造（`(?:\S*\/)?` を伴う）が既存の `GH_WORD_SRC` にも在り、
 * `GH_PR_MERGE_DELETE_BRANCH_RE` の直接一致（`hasGhPrMergeDeleteBranch` が
 * 毎回の深さで先に試す）自体も同じ2乗の後戻りを持つことを、この PR の
 * 作業中に発見した**（実測: `'a;'.repeat(n) + 'gh pr merge 1
 * --delete-branch'` を main 2c8876f3 の写しに通すと、n=8000 で74ms・
 * n=16000 で328ms——同じ4倍/4倍の伸び）。**これはこの PR が作った穴では
 * ない**（`GH_WORD_SRC` はこの PR で1文字も変えていない、issue #2068 由来）
 * ——問い1（同じ穴か）で見ると、症状は「別の穴」（すり抜けではなく後戻りの
 * 性能）であり、問い2（誰が作ったか）では「既存の挙動、この PR は触って
 * いない」に当たる。⟹ **この PR では直さず、Issue へ落とす**
 * （AGENTS.md「範囲外でも気づいたことは上げる」）。次に同じ形の入力を見た
 * 人が立ち止まれるよう、ここにポインタを残す——`GH_WORD_SRC` の doc 参照。
 */
/**
 * シェルの名前を変数で書いた形（`$SHELL` / `${SHELL}` / `"$SHELL"` / `$BASH` …）。
 * `$SHELL` はたいてい `/bin/bash` を、`$BASH` は bash 自身のパスを指す。
 * #2204 で待つ形の `SCRIPT_RUN_RE` にだけ足し、#2238 で `SHELL_NAME_SRC` に含めた
 * （`$SHELL -c "gh pr merge … --delete-branch"` の中身を取り出さずに通していた）。
 */
const SHELL_VAR_SRC = String.raw`"?\$(?:(?:SHELL|BASH)\b|\{(?:SHELL|BASH)\})"?`;

const SHELL_NAME_SRC = String.raw`(?:(?:\S{0,64}\/)?(?:bash|dash|ksh|mksh|ash|yash|sh|zsh|fish|csh|tcsh)\b|${SHELL_VAR_SRC})`;

/**
 * `<<` の手前の、コマンドの位置からの区間の始まり（`;` `&` `|` 改行 `(` `)` バッククォートの直後）。
 * `SHELL_HEREDOC_PREFIX_RE` をこの区間にだけ当てる（issue #2115。以前は本文ごと1本の
 * 正規表現で探していて、終端の無い入力で2乗になった）。
 */
function commandPositionStartBefore(command: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = command[i];
    if (
      ch === ';' ||
      ch === '&' ||
      ch === '|' ||
      ch === '\n' ||
      ch === '(' ||
      ch === ')' ||
      ch === '\u0060'
    ) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * 行の継続（`\` + 改行。`\r\n` も）を取り除いた写しを返す（#2179）。無ければ同じ文字列を返す。
 *
 * **引用符もヒアドキュメントも見ずに、全部取り除く。** bash が取り除かない場所（単一引用符の
 * 中・引用符付きのヒアドキュメントの本文）でも取り除くので、写しは実際の実行とずれうる。
 * だから呼び出し側（`inspectBashCommand`）は、元の文字列と写しの**両方**に判定をかけ、
 * どちらかが弾けば弾く（弾く側にしか倒れない）。`\\` + 改行（エスケープした `\` の後ろの
 * 改行）まで取り除く読み違えも、同じ理由で弾く側に倒れるだけである。
 */
function joinLineContinuations(command: string): string {
  return command.includes('\\\n') || command.includes('\\\r\n')
    ? command.replace(/\\\r?\n/g, '')
    : command;
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
 * 本文を実行しないと分かっている読み手（`cat` / `tee`）のヒアドキュメント（#2130）。
 * `<<` の手前の、コマンドの位置からの区間に当てる。
 */
const DATA_HEREDOC_READER_RE = new RegExp(
  String.raw`^[ \t]*${LEADING_ENV_PREFIX_SRC}(?:cat|tee)\b`,
);

/**
 * 同じ呼び出しの中で、書いたファイルを走らせうる形（#2130）。本文を消した後の写しに
 * これが在れば、本文を消さない（`cat > run.sh <<'EOF' … EOF` の後の `bash run.sh` で、
 * 本文が後で実行されるため）。シェルに語を渡す形（`bash run.sh`。`-` で始まるオプションは
 * 除く）・`source`・`. `・パスで起こす形（`./run.sh` / `/tmp/run.sh`）を見る。
 *
 * **シェルの名前を変数で書いた形（`$SHELL run.sh` / `"$SHELL" run.sh` / `${SHELL} run.sh`）も見る**
 * （#2204。C の横断レビューで見つかった）。`$BASH`（bash 自身のパス）も同じ。`$SHELL` はたいてい `/bin/bash` を指すので、`bash run.sh`
 * と同じく本文が後で実行される。#2204 までは名前の列挙（`SHELL_NAME_SRC`）にしか当てず、無限ループを
 * 書いた本文を「データだけ」と読んで弾かなかった。変数の形は `SHELL_NAME_SRC` に含めてある（#2238）。
 */
/**
 * シェル名の後ろで「何かを走らせる」形（#2398）。次のどちらか。
 * - オプション（`-x` など。`-c` で終わる束ねと `--version`/`--help` は除く——`-c` の中身は別の経路が見る）を読み飛ばして、
 *   `-` で始まらない語（スクリプト）が来る形（`bash -x r.sh`）
 * - 引数が無く、区切り・行末が来る形（`cat r.sh | bash` / `| sh`。標準入力を読んで走らせる）
 * オプション（`-` 始まり）と語（`-` 以外）は先頭の文字で分かれるので、後戻りは線形。
 */
const SCRIPT_RUN_SHELL_TAIL_SRC = String.raw`(?:[ \t]+(?!-[A-Za-z]*c\b|--(?:version|help)\b)-\S*)*(?:[ \t]+(?!-)\S|[ \t]*(?:$|[;&|)\n]))`;

const SCRIPT_RUN_RE = new RegExp(
  String.raw`${COMMAND_POSITION_LOOKBEHIND_SRC}[ \t]*${LEADING_ENV_PREFIX_SRC}(?:${SHELL_NAME_SRC}${SCRIPT_RUN_SHELL_TAIL_SRC}|source\b|\.[ \t]|\.{0,2}\/\S)|>\([ \t]*${LEADING_ENV_PREFIX_SRC}${SHELL_NAME_SRC}`,
);

/**
 * 文字列を組み立てて走らせうる形（#2130 の線の 4）。コマンド置換（`$(` / バッククォート）と
 * `eval`。本文を消した後の写しにこれが在れば、本文を消さない。置換の中身は静的には読めない
 * ので、在るだけで倒す（誤検知の向き）。
 */
const STRING_EXEC_RE = /\$\(|`|(?:^|[\s;&|()])eval\b/;

/**
 * 待つ形の判定（`gh-run-watch-background` / `tail-f` / `until-sleep` / `while-sleep`）に
 * かける写しを作る（#2130）。**本文を実行しないと分かっているヒアドキュメントの本文だけ**を、
 * 改行を残して空白へ潰す。
 *
 * ## なぜ
 *
 * ファイルに書くだけの `cat > f <<'EOF' … EOF` の本文に、背景へ置いた run watch・
 * `tail -f`・`while … sleep` の字面が在るだけで、待つ形のガードが弾いていた。
 * 2026-09-29T06:3xZ と 07:1xZ に、領域 D のマネージャーが本番の版で実際に踏んだ
 * （この変更の手順を渡すヒアドキュメントでも踏んだ）。`gh-pr-merge-delete-branch` は
 * `stripHeredocs` で本文を消してから見るので、この誤検知を持たない。
 *
 * ## すり抜けを作らないための線
 *
 * これはガードを緩める変更なので、消すのは次の3つを全部満たすヒアドキュメントの本文だけにする。
 * どれか1つでも満たさなければ、いまのまま本文も見る（弾く側に倒す）。
 * 1. 読み手が `cat` / `tee`（`DATA_HEREDOC_READER_RE`）
 * 2. 開始の行（`<<DELIM` を含む行）に `|` が無い（`cat <<EOF | bash` は本文を実行する）
 * 3. 本文を消した後の写しに、書いたファイルを走らせうる形（`SCRIPT_RUN_RE`）が無い
 * 4. 本文を消した後の写しに、コマンド置換（`$(` / バッククォート）と `eval` が無い
 *    （`STRING_EXEC_RE`）。`bash -c "$(cat run.sh)"` / `eval "$(cat run.sh)"` のように、
 *    書いたファイルの中身を文字列にして走らせる形は、3 の語の形では拾えない。置換の中身は
 *    静的には読めないので、置換が在るだけで本文を消さない側に倒す
 *
 * `bash <<EOF` / `ssh host <<EOF` / `docker exec -i c sh <<EOF` / `python - <<EOF` のような、
 * 読み手が `cat` / `tee` でないものは、本文をそのまま見る。
 *
 * ⚠️ **残る限界**: 別の呼び出しで書いたファイルを後で走らせる形は、もともと見えない
 * （スクリプトファイル経由は対象外）。**ガードは文字列しか見ないので、ファイルの中身や
 * 置換の結果を読んで判定することはできない**（それには実行が要る）。塞げるのは「同じ呼び出しの
 * 中で書いた本文を、消してよいか」の判定までで、4 がその線である。
 */
export function stripDataHeredocsForWaitForms(command: string): string {
  const spans = findHeredocs(command).filter((span) => {
    const lineEnd = command.indexOf('\n', span.start);
    const openerRest = command.slice(span.start, lineEnd < 0 ? command.length : lineEnd);
    if (openerRest.includes('|')) return false;
    const prefix = command.slice(commandPositionStartBefore(command, span.start), span.start);
    return DATA_HEREDOC_READER_RE.test(prefix);
  });
  if (spans.length === 0) return command;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += command.slice(cursor, span.bodyStart);
    out += command.slice(span.bodyStart, span.bodyEnd).replace(/[^\n]/g, ' ');
    cursor = span.bodyEnd;
  }
  out += command.slice(cursor);
  if (SCRIPT_RUN_RE.test(out) || STRING_EXEC_RE.test(out)) return command;
  return out;
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

  // 全体が timeout に包まれていれば、中身がどんな形でも有界だと読める。
  if (isTimeoutWrapped(trimmed)) return { blocked: false };

  // **待つ形の判定は、元の文字列と、行の継続（`\` + 改行）を取り除いた写しの両方にかける**（#2189。
  // #2179 のマージのガードと同じ理由）。`tail -f` と背景の run watch の判定は改行を区切りとして
  // 読むので、`tail \` + 改行 + `-f x` / `gh run watch 1 \` + 改行 + `&` を見落としていた。
  // どちらかが弾けば弾く（弾く側にしか倒れない）。行の継続が無ければ、写しは作らない。
  const direct = inspectWaitForms(trimmed, invocation);
  if (direct.blocked) return direct;
  const joined = joinLineContinuations(trimmed);
  return joined === trimmed ? direct : inspectWaitForms(joined, invocation);
}

/**
 * 待つ形（背景の `gh run watch`・`tail -f`・待つループ）の判定（#2189 で `inspectBashCommand` から
 * 切り出した。中身は1文字も変えていない）。`trimmed` は空白を落とした1つのコマンド文字列。
 * `timeout` で包まれた形の早期 return は、呼び出し側が先に済ませている。
 */
function inspectWaitForms(trimmed: string, invocation: BashInvocation): WaitGuardVerdict {
  // 待つ形の判定は、本文を実行しないヒアドキュメントの本文を消した写しにかける（#2130）。
  const waitView = stripDataHeredocsForWaitForms(trimmed);

  if (isBackgroundedGhRunWatch(waitView, invocation.backgrounded === true)) {
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

  if (hasUnboundedTailFollow(waitView)) {
    return {
      blocked: true,
      form: 'tail-f',
      reason: buildReason('`tail -f` / `tail --follow` はファイルの終端で止まらず追従し続ける'),
    };
  }

  // `until` / `while` の一致は `LOOP_RE` と同じ（`findUntilWhileLoops` の doc。#2181）。
  for (const { keyword: loopKeyword, cond, body } of findUntilWhileLoops(waitView)) {
    const keyword = loopKeyword as 'until' | 'while';

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

  // 条件の無い C 形式の for（teto の判断、#2179 の「残す」）。本体の判定は while と同じ
  // （`sleep` が在り、`break` もカウンタ比較も無ければ弾く）。条件の節は
  // `findUnboundedCFors` が先に絞っているので、ここでは見ない（`isBoundedLoop` は `((` を
  // カウンタ比較の印に数えるので、`for ((;;))` の見出しに当てると有界と誤読する）。
  for (const { body } of findUnboundedCFors(waitView)) {
    if (!/\bsleep\b/.test(body)) continue;
    if (/\bbreak\b/.test(body) || COUNTER_COMPARISON_RE.test(body)) continue;
    return {
      blocked: true,
      form: 'for-sleep',
      reason: buildReason(
        '条件の無い C 形式の `for ((;;)); do ... sleep ...; done` は、`while true` と同じで、' +
          '自分からは終わらない',
      ),
    };
  }

  return { blocked: false };
}

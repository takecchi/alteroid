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
  | 'for-sleep'
  | 'tail-f'
  | 'gh-run-watch-background'
  | 'gh-pr-merge-delete-branch'
  | 'gh-pr-merge-no-match-head-commit'
  | 'gh-pr-merge-squash-no-body';

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
    const tokenLength = mask[i] ? boundaryTokenLengthAt(command, i) : 0;
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
 * - 同じ単純コマンドにコマンド置換（`$(`/バッククォート）かプロセス置換の出力側（`>(`）が
 *   在る——置換の中身は実際に実行される。`echo "…" > >(sh)` は出力をシェルへ渡す
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
  if (rest.includes('$(') || rest.includes('`') || rest.includes('>(')) return false;
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
  const gh = new RegExp(GH_WORD_SRC_FOR_RUN_WATCH, 'g');
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
      return { index: m.index, end: nextRunWatch.index + nextRunWatch[0].length };
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

function isBackgroundedGhRunWatch(trimmed: string, backgrounded: boolean): boolean {
  const match = findGhRunWatch(trimmed);
  if (match === null) return false;
  // ツール側の背景指定は、コマンド文字列のどこに在っても背景である。
  if (backgrounded) return true;
  const rest = trimmed.slice(match.end);
  const operator = FIRST_CONTROL_OPERATOR_RE.exec(rest);
  if (operator !== null && operator[0] === '&') return true;
  // `setsid`（`-w` / `--wait` が無い形）も背景へ置く形である（#2129）。
  const segment = trimmed.slice(commandPositionStartBefore(trimmed, match.index), match.index);
  if (isBackgroundingSetsid(segment)) return true;
  // `coproc` は子を非同期で起こす（#2179）。`setsid` と同じく、背景へ置く形である。
  if (COPROC_RE.test(segment)) return true;
  // `{ …; } &` の中（#2179）。`;` が `&` より先に来るので、上の最初の制御演算子の判定では
  // 背景と読めない。`( … ) &` は `)` の直後の `&` が最初の制御演算子なので、上で弾ける。
  return isInsideBackgroundedBraceGroup(trimmed, match.index);
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
function isInsideBackgroundedBraceGroup(command: string, index: number): boolean {
  // 内側のグループから外側へ順に見る（`{ { … }; } &` のように、外側のグループだけが背景へ
  // 送られる形があるため）。手前の走査は `left` から、後ろの走査は `right` から続けるので、
  // 入れ子が深くても走査は全体で線形である。
  let left = index - 1;
  let right = index;
  for (;;) {
    let depth = 0;
    let open = -1;
    for (let i = left; i >= 0; i -= 1) {
      if (isBraceCloseAt(command, i)) {
        depth += 1;
      } else if (isBraceOpenAt(command, i)) {
        if (depth === 0) {
          open = i;
          break;
        }
        depth -= 1;
      }
    }
    if (open < 0) return false;
    depth = 0;
    let close = -1;
    for (let i = right; i < command.length; i += 1) {
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
    if (close < 0) return false;
    const operator = FIRST_CONTROL_OPERATOR_RE.exec(command.slice(close + 1));
    if (operator !== null && operator[0] === '&') return true;
    left = open - 1;
    right = close + 1;
  }
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
 * ⚠️ **issue #2035 で、「演算子か行頭」の集合へグルーピング（`(` `)`
 * バッククォート）を足し、さらに bash の予約語（`if`/`then`/…/`time`/
 * `!`/`{`）を読み飛ばす前置きとして加えた**——`COMMAND_POSITION_
 * LOOKBEHIND_SRC`・`SHELL_KEYWORD_PREFIX_SRC` の doc 参照。直す前は、
 * 予約語やグルーピングの直後に来た `gh pr merge --delete-branch` が
 * どの区切り文字の直後でもないと誤読され、検出をすり抜けていた。
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
 * 手前の穴（#1991）はこの PR（PR #1990）でも直していない——`"-d"`/`'-d'` は
 * このコマンド置換の修正とは無関係にすり抜けたままである（下のテストで
 * 対照している）。**その後、issue #1991 自体は別の依頼で直った**
 * （`SHORT_DELETE_BRANCH_FLAG_SRC` の doc 参照）。
 *
 * ## ⚠️ この検出器が弾けないと分かっている形
 *
 * - ~~**`bash -c '…'` の中。** 構文（コマンド位置）しか見ていないので、
 *   単一引用符の中の `gh pr merge --delete-branch` は「引用符の中」という
 *   条件だけで素通しされる。これは他の文字列だけを読む判定器と同じ限界
 *   であり、この PR でも直していない（歯は
 *   `bash-wait-guard.test.ts` の末尾に明記する）。~~ **issue #2104（PR #2114）で
 *   直った。** 文字列が別のシェルに渡されて実行される形（シェルの `-c`・`eval`・
 *   `ssh`・シェルへのパイプ・シェルへのヒアドキュメント）は、中身を取り出して同じ
 *   判定にもう一度かける（`hasGhPrMergeDeleteBranch` の doc。歯は
 *   `bash-wait-guard-delete-branch-issue-2104.test.ts`）。`bash-wait-guard.test.ts`
 *   の `bash -c` の歯も `it.fails` から `it` へ戻してある。**残る限界**（ファイルの
 *   中身・コマンド置換の結果は読めない、など）は同じ doc に在る。取り消し線のまま
 *   残すのは、他の直った項と同じ理由である。
 * - ~~**⚠️ `gh pr merge 1 "-d"` / `gh pr merge 1 '-d'` のように、`--subject` /
 *   `--body` の値ではなく素で引用符に囲まれた短縮フラグ `-d`。** issue #1910
 *   の作業中に見つけた、**この PR とは無関係な既存の穴**（この PR が作った
 *   ものでも、この PR で直すものでもない）。`-d` の検出
 *   （`(?<=[\s])-d(?=[\s;&|]|$)`）は直前が空白であることを要求するが、
 *   `"-d"` は直前が引用符でありシェルが引用符を剥がした後の実引数は
 *   リテラルの `-d`（本物のフラグ）である。長い形の `--delete-branch\b` は
 *   この lookbehind を持たないため同じ形でも引き続き弾く（対照は
 *   `bash-wait-guard-delete-branch-quoted-values.test.ts`）。issue #1991 で
 *   報告した（AGENTS.md「範囲外でも気づいたことは上げる」）。~~ **issue #1991
 *   で直した**（`SHORT_DELETE_BRANCH_FLAG_SRC` の doc 参照——`-d` の手前の
 *   lookbehind に「コマンド位置に在る引用符」を加えた）。**取り消し線のまま
 *   残すのは、直す前にどう限界を認識していたかを次に読む人が辿れるように
 *   するためである**（#1933/#1939 の同じ扱いと同根）。**残る限界**（引用符と
 *   テキストが直接連結した形 `"-"d` 等、`--body-file` の値が偶然 `-d` で
 *   始まる引用符文字列）は `SHORT_DELETE_BRANCH_FLAG_SRC` の doc に書いた。
 * - **`--delete-branch=false` のような明示的な無効化。** `\b` は文字種の
 *   境界でしか見ないので、`--delete-branch` の直後が `=false` でも弾く
 *   （確かめていない・稀な形と判断して対応していない）。**安全側の誤検知として、
 *   直さないと決めた**（#2127。`not planned`）。この repo は `delete_branch_on_merge=true`
 *   なので書く用途が薄い。一方、緩めるには pflag の「後ろの指定が勝つ」規則と短い形の
 *   `-d=false` の読み方を本物で確かめる必要があり、読み違えればすり抜けを作る。見直す
 *   条件も #2127 に在る。
 * - ~~**`-sd` のような短縮オプションの束ね書き。** `-d` は前後が空白/演算子/
 *   端であることを要求するので、他の短縮フラグと連結した形（`gh` の
 *   フラグパーサが許すかどうかも含め未確認）は弾けない。~~ **issue #2068
 *   F族で直した**（`SHORT_DELETE_BRANCH_FLAG_SRC` の doc「issue #2068 F族」
 *   参照——`-[smr]*d` に広げ、値を取らない短いフラグとの束ねを読む）。
 * - ~~**`timeout` に `-k` 等のオプションが付いた形**
 *   （`timeout -k 5 30 gh pr merge 123 --delete-branch`）。直上の doc の
 *   とおり、`timeout` 自身のオプション文法までは解いていない。~~ **issue
 *   #2068 B族で直した**（`TIMEOUT_COMMAND_OPTION_SRC` 参照——`-k`/
 *   `--kill-after=`/`-s`/`--signal=`/`--preserve-status` を読む。全オプション
 *   文法までは引き続き解いていない）。
 * - ~~**代入の値が空白を含む引用符形（`X="a b" gh pr merge …`）。** 直上
 *   「`gh` の手前の環境変数・`timeout`・`env` 前置きも読み飛ばす」の doc の
 *   とおり、値パターンが `\S*` なので空白の手前までしか代入として読めない
 *   （既存の簡略化）。~~ **issue #2068 C族で直した**（`ENV_ASSIGNMENT_
 *   VALUE_SRC` 参照——二重引用符・単一引用符の区間を読む）。
 * - **`gh api -X DELETE …/git/refs/heads/<branch>`・`git push origin
 *   --delete <branch>`・`git push origin :<branch>`。** これらは
 *   `gh pr merge --delete-branch` と同じ実害（枝を消し、積んだ PR を
 *   黙って閉じる）に達しうるが、この検出器の対象は issue #1764 が
 *   明記したとおり「`gh pr merge` の呼び出し」に絞られている。1件ずつ
 *   検討して足す方針（#1192 のオーナー決定）のため、issue #1788 の指摘は
 *   ここへ記録するに留め、この PR では歯を足していない。
 * - ~~**`sudo` / `nice` / `xargs` / `command` / `exec` / `nohup` など
 *   `timeout` 以外の**コマンドとしての**前置き。** issue #1886 の
 *   「確かめていないこと」に明記されたとおり、この PR は `timeout` だけを
 *   扱う（1件ずつ検討する方針、#1192 のオーナー決定）。issue #2035 で
 *   `if`/`while`/`{`/`(` のような**予約語・グルーピング**（コマンドの
 *   位置を作るが、それ自体はコマンドとして実行されない）は塞いだが、
 *   `command`/`exec`/`nohup` のように**それ自体が1個のコマンドとして
 *   実行される**前置きは同じ方針で引き続き対象外のまま残している——
 *   数える単位の違いは `SHELL_KEYWORD_PREFIX_SRC` の doc「数える単位」
 *   参照。**`timeout -k` のようなオプション付き `timeout`・値が空白を含む
 *   引用符形の代入（`X="a b" gh …`）・`-sd` のような短縮オプションの束ね
 *   書きも、同じ理由で未対応のまま残っている**（それぞれ直上・直下の
 *   doc に個別の理由が在る）。~~ **issue #2068 A族で、依頼者が列挙した
 *   14個の前置きコマンド（`sudo`/`doas`/`nice`/`ionice`/`nohup`/`command`/
 *   `builtin`/`exec`/`xargs`/`setsid`/`stdbuf`/`chronic`/`unbuffer`/
 *   `caffeinate`）と `flock <file>` を直した**（`LEADING_COMMAND_PREFIX_SRC`
 *   / `FLOCK_PREFIX_SRC` 参照）。**列挙なので、ここに無い前置き
 *   （`strace`/`ltrace`/`script`/`su`/`runuser`/`systemd-run`/`firejail`/
 *   `ssh <host>` 等）は引き続き読み飛ばせない**——1件ずつ検討する方針
 *   （#1192 のオーナー決定）自体は変えていない。
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
 * - **issue #2068 で新しく生まれた・残った限界**（`GH_WORD_SRC`/
 *   `GH_REPO_FLAG_SRC`/`FLOCK_PREFIX_SRC` の doc にも個別に書いてある）:
 *   - ~~`flock -n /tmp/l gh pr merge …` のような、**オプション付きの
 *     `flock`。** `flock` 自身のオプション文法は解いていない
 *     （`FLOCK_PREFIX_SRC` の doc）——`flock <file>`（オプション無し）の
 *     形だけを読む。~~ **その後、`flock` のオプションと `-c` / `--command` の形を
 *     読むようにして直った**（`FLOCK_PREFIX_SRC` / `FLOCK_DASH_C_RE` の doc。
 *     歯は `bash-wait-guard-delete-branch-flock.test.ts`）。
 *   - `-R`/`--repo` の**短縮の詰め込み形**（`-Ro/r`、空白も `=` も無く
 *     直後に値が続く書き方）。`GH_REPO_FLAG_SRC` は `-R o/r`/`--repo o/r`/
 *     `--repo=o/r` の3形だけを見ており、`-Ro/r` は読めない。
 *   - `$GH`/エイリアス経由で `gh` を指す変数・関数呼び出し。`GH_WORD_SRC`
 *     は字面としての `gh`（パス付き・`\gh`・引用符）だけを見ており、
 *     シェル変数や関数定義の中身までは追わない。
 */
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
 * ⚠️ **`timeout` の全オプション文法までは解いていない**（`--foreground`
 * 等、確認していない残りは doc「弾けないと分かっている形」参照は無い
 * ——このオプション自体が既知の全部ではないため、列挙漏れの前置きは
 * 単に読み飛ばせないだけで、誤って弾く方向にはならない）。
 */
const TIMEOUT_COMMAND_OPTION_SRC = String.raw`(?:-k[ \t]+\S+[ \t]+|--kill-after=\S+[ \t]+|-s[ \t]+\S+[ \t]+|--signal=\S+[ \t]+|--preserve-status[ \t]+)`;
const TIMEOUT_COMMAND_PREFIX_SRC = String.raw`timeout[ \t]+(?:${TIMEOUT_COMMAND_OPTION_SRC})*(?:\d+(?:\.\d*)?|\.\d+)[a-zA-Z]*[ \t]+`;

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
const FLOCK_OPTION_SRC = String.raw`(?:-[wE][ \t]+\S+|--(?:wait|timeout|conflict-exit-code)(?:=\S+|[ \t]+\S+)|(?!-[wE](?:[ \t]|$))(?!--(?:wait|timeout|conflict-exit-code)(?:[ \t=]|$))(?!-c(?:[ \t]|$))(?!--command(?:[ \t=]|$))-\S+)`;

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
 * `-d` の手前（lookbehind）—— issue #1991 で直した。
 *
 * ## 直す前の穴
 *
 * 以前は `(?<=[\s])-d\b`——直前が**空白1文字だけ**であることしか認めて
 * いなかった。`gh pr merge 1 "-d"` / `gh pr merge 1 '-d'` のように、
 * 引用符で囲んだ短縮フラグは直前が引用符（`"` / `'`）であって空白では
 * ないため、この lookbehind に当たらずすり抜けていた。**bash は引用符を
 * 外してから引数を渡すので、`gh` に実際に届く引数はリテラルの `-d`
 * （本物のフラグ）である**——PR #1990 の「後ろ」（lookahead/`\b`）の直し
 * とは無関係に残っていた、別の（手前の）穴（PR #1990 本文・issue #1991、
 * `bash-wait-guard-delete-branch-quoted-values.test.ts` の `it.fails` 2本
 * で固定されていた）。
 *
 * ## 直し方
 *
 * 直前が次のどちらかであれば認める:
 *
 * 1. **空白1文字**（従来どおり）。
 * 2. **引用符（`"` / `'`）で、かつその引用符自体が「コマンド位置」
 *    （行頭・`;`/`&`/`|`/改行の直後、または空白の直後）に在る**
 *    ——`(?:^|[\s;&|])['"]`。**引用符そのものが在ればよい、ではない**
 *    ——たとえば `foo"-d"` は bash の実際の argv 分割では1つの引数
 *    `foo-d`（`-d` 単体ではない）になるので、引用符の直前も
 *    `^`/空白/演算子であることを要求して除外する。
 *
 * 後ろ側（trailing）はこれまでの `\b` のままでよい —— `"` も `'` も
 * 単語構成文字ではないので、`"-d"` の閉じ引用符の手前で `\b` は自然に
 * 成立する（`d` → `"` の遷移は単語→非単語の境界）。
 *
 * ⚠️ **`-dfoo` / `--depth` を誤って弾かないこと** —— `\b` は `-d` の直後が
 * 単語構成文字（`f`/`e` 等）だと成立しないので、これらは従来どおり弾かれ
 * ない（`bash-wait-guard.test.ts` の「-d を含む別の語（-dev 等）と誤認
 * しない」、`bash-wait-guard-delete-branch-issue-1991.test.ts` の対照群）。
 *
 * ⚠️ **`--subject`/`-t`/`--body`/`-b` の値の中の `-d`（空白混じり含む）を
 * 誤って弾かないこと** —— この正規表現が評価される時点で、値の引用符の
 * 中身は `stripGhPrMergeQuotedSubjectBodyValues` が既に空白へ潰した後
 * である（`hasGhPrMergeDeleteBranch` の処理順）。潰された区間には `-d`
 * という文字自体が残らないので、この lookbehind の拡張がそこへ新しく
 * 誤爆することはない（`bash-wait-guard-delete-branch-issue-1991.test.ts`
 * の「--subject の値の中の空白混じりの -d」で確認）。
 *
 * ⚠️ **意図して直していない・確かめていない形**（すり抜けを作らない方向の
 * 保守的な選択）:
 *
 * - **引用符とテキストが直接連結した形**（`"-"d`・`-"d"`・`\-d` など）。
 *   bash はこれらも1つの引数 `-d` に結合しうるが、この直しは「引用符が
 *   `-d` を丸ごと囲む、素直な形」だけを見ている。連結形は直前が引用符・
 *   空白のどちらでもない位置に在りうるため、この lookbehind には当たらず
 *   引き続きすり抜ける（安全側——検出漏れは残るが誤検知は増えない）。
 * - **`--body-file`/他のフラグの値が偶然 `-d` で始まる引用符文字列**
 *   （例: `--body-file "-d-notes.txt"`）。これは同じ弱さが**引用符無し**
 *   の形（`--body-file -d-notes.txt`）にも従来から在る——空白の直後という
 *   条件だけでは、値なのかフラグなのかを区別できない。この PR で新しく
 *   増やした弱さではない。
 *
 * ## issue #2068 F族——短いフラグの束ね書きと ANSI-C/`$"…"` クオートを足した
 *
 * `gh pr merge` は pflag（Cobra）系のフラグ解析器を使っており、値を取らない
 * 短いフラグは束ねて書ける（`-s -d` を `-sd` と書ける等）。`gh pr merge
 * --help` で確認した実際の短いフラグ: 値を取らないもの `-s`（squash）・
 * `-m`（merge）・`-r`（rebase）・`-d`（delete-branch）、値を取るもの
 * `-b`（body）・`-t`（subject）・`-F`（body-file）・`-A`（author-email）。
 * **値を取るフラグの直後の文字は、その値になる**（`-bd` は `--body d` で
 * あって `-d` ではない——だから `gh pr merge 1 -bd` は弾かない側が正しい。
 * `bash-wait-guard-delete-branch-issue-2068.test.ts` の対照テストで固定
 * している）。
 *
 * 直し方: `-d` の前を `-[smr]*d`（値を取らない `s`/`m`/`r` の並びの後ろに
 * `d` が来る形。0個でもよいので素の `-d` もそのまま含む）に広げ、直後を
 * `(?=[smrbtFAR]|[^A-Za-z]|$)` （もう1文字続く短いフラグ・非英字・文字列末尾
 * のどれか）で締める。この直後条件が、`-dev` のような無関係な語（直後が
 * 英字だが `smrbtFAR` のどれでもない `e`）を引き続き弾かないための境界
 * ——既存の「-d を含む別の語（-dev 等）と誤認しない」歯をそのまま保つ。
 *
 * ⚠️ **`R` は、最初の版では直後の集合に入っていなかった**（レビューで
 * mgr-712ad619 が指摘）。`-R`（`--repo`）は `gh pr merge` が親から継ぐ短い
 * フラグで、値を取る。だから `-dR o/r` は `-d -R o/r` と読まれ、最初の版では
 * すり抜けていた（`gh pr merge 1 -dR o/r` / `-sdR o/r` がどちらも
 * `blocked:false`。2026-09-29T01:1xZ 実測）。
 *
 * - `-sd`/`-ds`/`-msd`（`[smr]*` の並びの前後どちらに `d` が来ても、値を
 *   取らない文字だけで構成されていれば拾う）
 * - `-sdt x`（`d` の直後に値を取る `t` が続いても、`d` 自体はその手前で
 *   確定しているので拾う——`t` 以降は無視してよい、`gh` 側の解釈がどうで
 *   あれ `-d` はすでに立っている）
 * - `-bd`（`d` の手前に値を取る `b` が来ると `-[smr]*d` に一致しない——
 *   `[smr]*` は `b` を含まないので、`b` の位置で先頭からのマッチが崩れる。
 *   対照テストで固定）
 *
 * `$'-d'`/`$"-d"`（ANSI-C クオート・`$"…"` 形の中の `-d`）も、手前の
 * lookbehind へ `\$['"]`（2文字）を選択肢として足して読む——`$'` の直後は
 * 「引用符の中」であって bash の実際の argv 分割ではリテラル `-d` になる
 * （`computeOutsideQuoteMask` が既に `$'…'` を追っているのと同じ理解）。
 *
 * ⚠️ **意図して確かめていない**: `gh`（pflag/Cobra）が実際にこれらの束ね
 * 書きをどう解釈するか自体は、本物の PR に対して打っていないので未確認
 * （Issue 本文にも明記——「gh が実際にこう解釈するかは確かめていない」）。
 * すり抜けを作らないほうを優先する方針なので、解釈が違っていても
 * 「弾く」側に倒れるだけで安全側である。
 */
const SHORT_DELETE_BRANCH_FLAG_SRC = String.raw`(?<=[\s]|(?:^|[\s;&|])(?:\$['"]|['"]))-[smr]*d(?=[smrbtFAR]|[^A-Za-z]|$)`;

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
 * `gh` と `pr` のあいだに来る、リポジトリ選択のフラグ（issue #2068 E族）。
 *
 * `-R <値>`・`--repo <値>`・`--repo=<値>` の3つの書き方を読み飛ばす
 * （`gh pr merge --help` の INHERITED FLAGS に `-R, --repo` が載っている
 * ことを確認済み）。
 *
 * ⚠️ **確かめていないこと**（Issue 本文どおり）: `gh` が実際にこの
 * 位置（`gh` の直後・`pr` の手前）でこのフラグを受け付けるかどうか自体
 * は確かめていない。**受けなくても弾く側に倒れるだけで安全**——このフラグ
 * を読み飛ばしても、その後ろに本物の `pr\s+merge` と `--delete-branch`/
 * `-d` が無ければ検出器は何も弾かない（誤検知が増えるだけで、実害の
 * すり抜けは増えない）。
 *
 * #2271 B: `pr` と `merge` のあいだ（`gh pr -R o/r merge 1 -d`）にも同じ読み飛ばしを足した。
 * cobra は継承フラグをサブコマンド名の前後どちらにも置ける。受けなくても弾く側に倒れるだけ。
 */
const GH_REPO_FLAG_SRC = String.raw`(?:(?:-R|--repo)(?:=\S+|[ \t]+\S+)[ \t]+)`;

const GH_PR_MERGE_DELETE_BRANCH_RE = new RegExp(
  String.raw`${COMMAND_POSITION_LOOKBEHIND_SRC}[ \t]*${LEADING_ENV_PREFIX_SRC}${GH_WORD_SRC}\s+(?:${GH_REPO_FLAG_SRC})*pr\s+(?:${GH_REPO_FLAG_SRC})*merge\b(?:(?!;|&&|\|\||\||\n)[\s\S])*?(?:--delete-branch\b|${SHORT_DELETE_BRANCH_FLAG_SRC})`,
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

/**
 * issue #2104 —— `gh pr merge --delete-branch` が、**文字列として別のシェルへ
 * 渡され、コマンドとして実行される形**をすり抜けていた。`bash -c '…'` は
 * #1764 から「弾けないと分かっている形」として doc と `bash-wait-guard.test.ts`
 * の `it.fails` に在ったが、同じ穴が `eval`・`ssh <host> <cmd>`・シェルへの
 * パイプ（`… | bash`）・シェルへのヒアドキュメント（`bash <<EOF`）にも在った
 * （観測は issue #2104 本文、mgr-712ad619 実測 2026-09-29）。
 *
 * ## 直し方 —— 外側の判定は崩さず、入口を見つけたら中身を取り出してもう一度
 *
 * `hasGhPrMergeDeleteBranch` 自身に「5つの入口のどれかを見つけたら中身を
 * 取り出し、`hasGhPrMergeDeleteBranch` 自身にもう一度かける」再帰を足す。
 * **外側の直接一致（`GH_PR_MERGE_DELETE_BRANCH_RE`）は毎回の深さで必ず先に
 * 試す**——既存の歯（`it.fails` を除く）が1つも変わらないのはこのため。
 * 深さの上限は `MAX_NESTED_SHELL_DEPTH`（3）。上限に達した深さでも、その
 * 深さの中身そのものへの直接一致は行う——止めるのは「**さらに**中身を
 * 取り出して再帰する」ことだけである。⟹ 4層ネスト（`bash -c "bash -c
 * \"bash -c \\\"bash -c \\\\\\\"gh pr merge 1 -d\\\\\\\"\\\"\""` のような
 * 形）は、3層目までは中身を取り出して辿れるが、4層目の中身は取り出せない
 * ——**4層目は、構文を見ずに字面だけで判定して弾く側へ倒す**
 * （`looksLikeGhPrMergeDeleteBranch`）。
 *
 * ⚠️ **最初の版は、上限を超えたら通す側へ倒していた**（作業者の判断。「上限は
 * 再帰の制御のための境界であって、4層は安全という判断ではない」）。レビュー
 * （mgr-712ad619）で、弾く側へ倒すよう直した。上限を超える入れ子は、それ自体が
 * 入れ子を重ねて判定を逃れる形になりうる。この Issue は、すり抜けを作らないことを
 * 最優先にしている。誤検知（4層の入れ子の中に、実行されない `gh … merge -d` の
 * 字面が在る形）は受け入れる。
 *
 * ## 5つの入口（数える単位、Issue 本文）
 *
 * 1. **シェルの `-c`**（`SHELL_DASH_C_RE`）—— `bash`/`sh`/`zsh`/`dash`/`ksh`。
 *    パス付き（`/bin/sh`）・束ね（`-lc`/`-ec`）・前置き付き（`timeout 60
 *    bash -c`/`xargs -I{} sh -c`、`LEADING_ENV_PREFIX_SRC` を再利用）を読む。
 *    直後の引数を二重引用符・単一引用符・引用符無し（次の1語）の3択で読む
 *    ——二重引用符は `\` によるエスケープを素朴に外す（Issue 本文「外せない
 *    ときは中身をそのまま使う＝弾く側に倒す」——閉じていない二重引用符は
 *    そもそも `NESTED_SHELL_DOUBLE_QUOTED_INNER_SRC` に一致しなくなるので、
 *    その位置では引用符無し（`\S+`、次の1語）の選択肢へ落ちる）。
 * 2. **`eval <引数…>`**（`EVAL_RE`）—— 次の境界（`;`/`&&`/`||`/`|`/改行）
 *    までを1つの文字列として捉え、単一・二重引用符を素朴に外してつなぐ
 *    （`unquoteJoin`）。
 * 3. **`ssh <host> <cmd>`**（`SSH_RE`）—— `ssh` のオプション文法は解かず、
 *    次の境界までの区間から**引用符の中身すべて**を拾って空白でつなぐ
 *    （Issue 本文「ssh の後ろの引用符の中身すべて」）。
 * 4. **シェルへのパイプ**（`extractPipeToShellPayloads`）—— `| bash`/`| sh`
 *    等の手前の「単純コマンド区間」（直近の `;`/`&`/`|`/改行の次から、この
 *    パイプまで）から**引用符の中身すべて**を拾って空白でつなぐ。
 * 5. **シェルへのヒアドキュメント**（`SHELL_HEREDOC_RE`）—— `stripHeredocs`
 *    は本文を空白へ潰す（既存、外側の直接一致の誤検知を防ぐため）が、
 *    こちらは**潰さずに本文を中身として見る**——ヒアドキュメントの対象が
 *    シェル（`bash`/`sh`/…）のときだけを対象にする（`cat > f <<EOF` は
 *    対象がシェルではないので、この入口には引っかからない——既存の
 *    「ヒアドキュメントの本文の中に在る gh pr merge --delete-branch は
 *    通す」歯がそのまま緑であり続ける根拠）。
 *
 * ## 誤検知は「同じ判定関数へそのまま渡す」ことで自然に抑える
 *
 * 取り出した中身を検出専用の別ロジックにかけるのではなく、**この関数自身
 * （`hasGhPrMergeDeleteBranch`）へそのまま渡す**——これにより、取り出した
 * 中身の中でも「コマンドの位置に在るもの」だけが数えられる。
 * `bash -c 'echo "gh pr merge 1 -d"'` は、取り出した中身
 * `echo "gh pr merge 1 -d"` を同じ関数へ渡したとき、`gh` が `echo` の
 * 引数（コマンドの位置ではない）なので弾かれない——対照の歯として固定する。
 *
 * ## 後戻りの設計（PR #2080 レビューの教訓を踏まえる）
 *
 * `LEADING_COMMAND_PREFIX_OPTION_SRC`（issue #2068）で、オプションの値の
 * 読み方の2択が同じ続きへ再合流し、フィボナッチ的に伸びた実例がある
 * （`'sudo ' + '-a '.repeat(n)` が n=40 で約1秒、doc 参照）。この PR の
 * 新しい正規表現はどれも `LEADING_ENV_PREFIX_SRC`（既に線形と確認済み）を
 * 前提に組み立てており、新しく足した部分（`SHELL_DASH_C_ARG_SRC` の3択・
 * `NESTED_SHELL_DOUBLE_QUOTED_INNER_SRC` の2択・ヒアドキュメントの
 * `(?:[ \t]+-\S+)*`）は、いずれも**選択肢の先頭文字が重ならない**か
 * **1回ごとに自己完結して次の反復へ再合流しない**形にしてある。長い
 * 繰り返し入力での実測は
 * `bash-wait-guard-delete-branch-issue-2104.test.ts` の時間の歯に書いた。
 */
const MAX_NESTED_SHELL_DEPTH = 3;

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
 * 二重引用符の値（issue #2104 の抽出専用——素朴なエスケープ外しを許す）。
 *
 * `DOUBLE_QUOTED_VALUE_SRC`（`--subject`/`--body` 用、「読めないときは
 * 弾く側」で `\`/`$`/バッククォートを含む時点で不一致にする）とは設計が
 * 違う。こちらは Issue 本文の指定どおり「素朴に外してよい」——`\` に
 * よるエスケープを読みながら閉じ引用符まで進む（2つの選択肢
 * `[^"\\]`/`\\.` の先頭文字が重ならないので後戻りは線形）。閉じていない
 * 二重引用符はこのパターンに一致しなくなり、`SHELL_DASH_C_ARG_SRC` では
 * 引用符無し（次の1語）の選択肢へ落ちる——「外せないときは中身をそのまま
 * 使う＝弾く側に倒す」を、より単純な形（次の1語だけを見る）で実現している。
 */
const NESTED_SHELL_DOUBLE_QUOTED_INNER_SRC = String.raw`(?:[^"\\]|\\.)*`;

/** バックスラッシュ1つによる素朴なエスケープを外す（`\X` → `X`）。 */
function unescapeBackslashes(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/**
 * `-c`/`-lc`/`-ec` 直後の引数——二重引用符・単一引用符・引用符無し（次の
 * 1語）の3択（Issue 本文「引用符が無ければ次の語」）。3つの選択肢の開始
 * 文字（`"`/`'`/それ以外）が重ならないので、後戻りは要らない。
 */
const SHELL_DASH_C_ARG_SRC = String.raw`(?:"(${NESTED_SHELL_DOUBLE_QUOTED_INNER_SRC})"|'([^']*)'|(\S+))`;

/**
 * `-c`/`-lc`/`-ec` —— 束ねたフラグは「`c` で終わる」ことだけを見る
 * （`-[A-Za-z]*c\b`）。`-config` のように `c` 以外で終わるフラグは
 * 一致しない（`\b` が `c` の直後に単語構成文字が続くことを許さない）。
 */
const SHELL_DASH_C_FLAG_SRC = String.raw`-[A-Za-z]*c\b`;

/**
 * シェル名と `-c` のあいだのオプション（#2397）——`-e`・`-euo pipefail`・`-o pipefail`・
 * `--norc`・`+o errexit`。`-c` 自身（`c` で終わる束ね）は読み飛ばさない。`-o`/`-O`/`+o` で
 * 終わる束ねだけが値を1語取る。値は `-` 始まりを許さない（`-` 始まりの語は次の
 * オプションとして読むので、1語の読み方が1通りに決まり後戻りが線形になる）。
 */
const SHELL_PRE_C_OPTION_SRC = String.raw`(?:-[A-Za-z]*[oO][ \t]+(?!-)\S+|\+o[ \t]+(?!-)\S+|(?!-[A-Za-z]*c\b)--?[A-Za-z][\w-]*)`;

/** `-c` のあとの `--`（オプションの終わり）。 */
const SHELL_DASH_C_END_OF_OPTIONS_SRC = String.raw`(?:--[ \t]+)?`;

const SHELL_DASH_C_RE = new RegExp(
  String.raw`${COMMAND_POSITION_LOOKBEHIND_SRC}[ \t]*${LEADING_ENV_PREFIX_SRC}${SHELL_NAME_SRC}(?:[ \t]+${SHELL_PRE_C_OPTION_SRC})*[ \t]+${SHELL_DASH_C_FLAG_SRC}[ \t]+${SHELL_DASH_C_END_OF_OPTIONS_SRC}${SHELL_DASH_C_ARG_SRC}`,
  'g',
);

/**
 * `eval <引数…>` —— 次の境界（`;`/`&&`/`||`/`|`/改行）までを読む。中身の
 * 引用符外しは `unquoteJoin` が別途行う。
 */
const EVAL_RE = new RegExp(
  String.raw`${COMMAND_POSITION_LOOKBEHIND_SRC}[ \t]*${LEADING_ENV_PREFIX_SRC}eval\b[ \t]+((?:(?!;|&&|\|\||\||\n)[\s\S])*)`,
  'g',
);

const UNQUOTE_JOIN_RE = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

/** `eval` の引数の引用符を外してその場でつなぐ。引用符でない部分はそのまま残す。 */
function unquoteJoin(value: string): string {
  return value.replace(
    UNQUOTE_JOIN_RE,
    (_whole: string, dq: string | undefined, sq: string | undefined) =>
      dq !== undefined ? unescapeBackslashes(dq) : (sq ?? ''),
  );
}

/**
 * `ssh [オプション…] <host> <コマンド…>` —— オプションの文法までは解かず、
 * 次の境界（`;`/`&&`/`||`/`|`/改行）までの区間全体を捉える。中身の抽出
 * （引用符の中身すべてを拾う）は `extractSshPayloads` が行う。
 *
 * パス付き（`/usr/bin/ssh`）のパス部分は `SHELL_NAME_SRC` と同じ理由で
 * `\S{0,64}` に絞ってある（無制限の `\S*\/` が2乗の後戻りを生む、doc 参照）。
 */
const SSH_RE = new RegExp(
  String.raw`${COMMAND_POSITION_LOOKBEHIND_SRC}[ \t]*${LEADING_ENV_PREFIX_SRC}(?:\S{0,64}\/)?ssh\b((?:(?!;|&&|\|\||\||\n)[\s\S])*)`,
  'g',
);

const QUOTED_SPAN_RE = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

/** ある区間の中の引用符の中身すべてを空白でつなぐ（`ssh`・シェルへのパイプ共通）。 */
function extractQuotedSpansJoined(segment: string): string {
  const spans: string[] = [];
  QUOTED_SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTED_SPAN_RE.exec(segment)) !== null) {
    if (m[1] !== undefined) spans.push(unescapeBackslashes(m[1]));
    else if (m[2] !== undefined) spans.push(m[2]);
  }
  return spans.join(' ');
}

/**
 * シェルへのパイプの手前の「単純コマンド区間」の開始位置——直近の区切り
 * 文字（`;`/`&`/`|`/改行）の次、無ければ文字列の先頭。この区切り文字の
 * 集合は `COMMAND_POSITION_LOOKBEHIND_SRC` の一部（`(`/`)`/バッククォートを
 * 除く）と同じ考え方——パイプ自身もこの集合に含まれるので、連続する
 * `a | b | bash` のような形でも、直前のパイプまでの短い区間しか遡らない
 * （後戻りが入力長に比例して増えない理由、doc「後戻りの設計」参照）。
 */
const PIPE_SEGMENT_BOUNDARY_CHARS = new Set([';', '&', '|', '\n']);

function findPrecedingSegmentStart(command: string, beforeIndex: number): number {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const ch = command[i];
    if (ch !== undefined && PIPE_SEGMENT_BOUNDARY_CHARS.has(ch)) return i + 1;
  }
  return 0;
}

/** `… | bash` / `… | sh`（`-c` が無い形）——パイプの手前の引用符の中身を拾う。 */
const PIPE_TO_SHELL_TARGET_RE = new RegExp(
  String.raw`\|[ \t]*${LEADING_ENV_PREFIX_SRC}${SHELL_NAME_SRC}`,
  'g',
);

/**
 * `bash <<'EOF' … EOF` / `sh <<EOF … EOF` —— 本体を消さずに中身として見る
 * （`stripHeredocs` と対になる、issue #2104 専用の抽出）。シェル名と `<<`
 * のあいだの単純なダッシュ付きフラグ（`-x` 等）は読み飛ばす——`flock`/
 * `LEADING_COMMAND_PREFIX_SRC` と違い、ここは値を取るかどうかを区別せず
 * 「ダッシュで始まる1トークン」だけを繰り返し読む（シェル自身のオプション
 * 文法までは解いていない、既知の限界）。
 */
const SHELL_HEREDOC_PREFIX_RE = new RegExp(
  String.raw`^[ \t]*${LEADING_ENV_PREFIX_SRC}${SHELL_NAME_SRC}(?:[ \t]+-\S+)*[ \t]*$`,
);

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
 * `flock [オプション] <file> -c <文字列>` / `--command <文字列>`。`flock` は文字列を
 * `sh -c` に渡すので、シェルの `-c` と同じ入口として中身を取り出す（`FLOCK_PREFIX_SRC` の doc）。
 */
const FLOCK_DASH_C_RE = new RegExp(
  String.raw`${COMMAND_POSITION_LOOKBEHIND_SRC}[ \t]*${LEADING_ENV_PREFIX_SRC}flock\b(?:[ \t]+${FLOCK_OPTION_SRC})*[ \t]+(?!-)\S+[ \t]+(?:-c|--command)(?:=|[ \t]+)${SHELL_DASH_C_ARG_SRC}`,
  'g',
);

function extractShellDashCPayloads(command: string): string[] {
  const payloads: string[] = [];
  for (const re of [SHELL_DASH_C_RE, FLOCK_DASH_C_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) {
      if (m[1] !== undefined) payloads.push(unescapeBackslashes(m[1]).trim());
      else if (m[2] !== undefined) payloads.push(m[2].trim());
      else if (m[3] !== undefined) payloads.push(m[3].trim());
    }
  }
  return payloads;
}

function extractEvalPayloads(command: string): string[] {
  const payloads: string[] = [];
  EVAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EVAL_RE.exec(command)) !== null) {
    payloads.push(unquoteJoin(m[1] ?? '').trim());
  }
  return payloads;
}

/**
 * `ssh` のうち値を取るオプション（OpenSSH の `ssh(1)`）。引用符の無い
 * `ssh host gh pr merge 1 -d` の形で、オプションと host を読み飛ばして残りの語を
 * 遠くで走るコマンドとして取り出すのに使う（mgr-712ad619 のレビューで足した）。
 */
const SSH_VALUE_OPTIONS = new Set([
  '-B',
  '-b',
  '-c',
  '-D',
  '-E',
  '-e',
  '-F',
  '-I',
  '-i',
  '-J',
  '-L',
  '-l',
  '-m',
  '-O',
  '-o',
  '-p',
  '-Q',
  '-R',
  '-S',
  '-W',
  '-w',
]);

/** `ssh` の引数から、オプションと host を除いた残り（遠くで走るコマンド）を返す。 */
function sshRemoteCommand(args: string): string {
  const tokens = args
    .trim()
    .split(/[ \t]+/)
    .filter((token) => token.length > 0);
  let i = 0;
  while (i < tokens.length && (tokens[i] ?? '').startsWith('-')) {
    if (SSH_VALUE_OPTIONS.has(tokens[i] ?? '')) i += 1;
    i += 1;
  }
  return unquoteJoin(tokens.slice(i + 1).join(' ')).trim();
}

function extractSshPayloads(command: string): string[] {
  const payloads: string[] = [];
  SSH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SSH_RE.exec(command)) !== null) {
    const joined = extractQuotedSpansJoined(m[1] ?? '').trim();
    if (joined.length > 0) payloads.push(joined);
    // 引用符の無い形（`ssh host gh pr merge 1 -d`）も、残りの語を1つのコマンドとして見る。
    const remote = sshRemoteCommand(m[1] ?? '');
    if (remote.length > 0) payloads.push(remote);
  }
  return payloads;
}

function extractPipeToShellPayloads(command: string): string[] {
  const payloads: string[] = [];
  let sawPipeToShell = false;
  PIPE_TO_SHELL_TARGET_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PIPE_TO_SHELL_TARGET_RE.exec(command)) !== null) {
    const segmentStart = findPrecedingSegmentStart(command, m.index);
    const segment = command.slice(segmentStart, m.index);
    const joined = extractQuotedSpansJoined(segment).trim();
    if (joined.length > 0) payloads.push(joined);
    sawPipeToShell = true;
  }
  // `cat <<EOF | bash` の形（パイプの手前が引用符ではなくヒアドキュメント）。シェルへ
  // パイプしている呼び出しでは、ヒアドキュメントの本文もすべて中身として見る
  // （mgr-712ad619 のレビューで足した）。どのヒアドキュメントがどのパイプに流れるかは
  // 解かない——同じ呼び出しに `cat > f <<EOF` が別に在れば、その本文も見る（誤検知の向き）。
  if (sawPipeToShell) {
    for (const span of findHeredocs(command)) {
      const body = command.slice(span.bodyStart, span.bodyEnd).trim();
      if (body.length > 0) payloads.push(body);
    }
  }
  return payloads;
}

function extractShellHeredocPayloads(command: string): string[] {
  const payloads: string[] = [];
  for (const span of findHeredocs(command)) {
    const prefix = command.slice(commandPositionStartBefore(command, span.start), span.start);
    if (SHELL_HEREDOC_PREFIX_RE.test(prefix)) {
      payloads.push(command.slice(span.bodyStart, span.bodyEnd).trim());
    }
  }
  return payloads;
}

/** 5つの入口すべてから、中身の候補をかき集める（順序に意味は無い）。 */
function extractNestedShellPayloads(command: string): string[] {
  return [
    ...extractShellDashCPayloads(command),
    ...extractEvalPayloads(command),
    ...extractSshPayloads(command),
    ...extractPipeToShellPayloads(command),
    ...extractShellHeredocPayloads(command),
  ];
}

/**
 * 深さの上限に達した中身を、構文を見ずに字面だけで判定する（mgr-712ad619 のレビューで足した）。
 * `gh` と `merge` と、`--delete-branch` か `-` で始まり `d` を含む短いフラグの字面が
 * この順に在れば真。**弾く側へ倒すための粗い判定**で、誤検知は受け入れる。
 * 正規表現の後戻りを持ち込まないよう、`indexOf` で順に探す（線形）。
 */
function looksLikeGhPrMergeDeleteBranch(payload: string): boolean {
  const gh = payload.indexOf('gh');
  if (gh < 0) return false;
  const merge = payload.indexOf('merge', gh + 2);
  if (merge < 0) return false;
  const rest = payload.slice(merge + 5);
  return rest.includes('--delete-branch') || /(?:^|[\s'"])-[A-Za-z]*d/.test(rest);
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
 * 引用符の中（`computeOutsideQuoteMask` が「外」と言い切れない位置）の改行を空白にした写しを返す
 * （#2271 B）。呼び出し区間の切り出しは改行で止まるので、`--body "$(cat <<'EOF'` の本文が
 * 複数行の形（ヒアドキュメントで本文を渡す打ち方）だと、その後ろの `--delete-branch` / `-d`
 * へ届かなかった。引用符が閉じていない・読めない（`unknown`）ときも「外」ではないので
 * 空白にする——弾く側にしか倒れない。無ければ同じ文字列を返す。
 */
function flattenNewlinesInsideQuotes(command: string): string {
  if (!command.includes('\n')) return command;
  const outside = computeOutsideQuoteMask(command);
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    out += ch === '\n' && !outside[i] ? ' ' : ch;
  }
  return out;
}

function hasGhPrMergeDeleteBranch(command: string, depth = 0): boolean {
  const withoutHeredocs = stripHeredocs(command);
  const withoutQuotedSubjectBodyValues = stripGhPrMergeQuotedSubjectBodyValues(withoutHeredocs);
  if (GH_PR_MERGE_DELETE_BRANCH_RE.test(withoutQuotedSubjectBodyValues)) return true;
  // 引用符の中の改行は区切りではない（#2271 B。`--body "$(cat <<'EOF' … EOF)" --squash -d`）。
  // 元の文字列と、引用符の中の改行を空白にした写しの両方にかける（弾く側にしか倒れない）。
  const flattened = flattenNewlinesInsideQuotes(withoutQuotedSubjectBodyValues);
  if (
    flattened !== withoutQuotedSubjectBodyValues &&
    GH_PR_MERGE_DELETE_BRANCH_RE.test(flattened)
  ) {
    return true;
  }
  if (depth >= MAX_NESTED_SHELL_DEPTH) {
    // 上限に達したら、さらに取り出して再帰はしない。代わりに、取り出せる中身に
    // `gh` … `merge` … `--delete-branch` / `-…d` の字面が在れば弾く側へ倒す
    // （`looksLikeGhPrMergeDeleteBranch`。すり抜けを作らないほうを優先する）。
    return extractNestedShellPayloads(command).some(looksLikeGhPrMergeDeleteBranch);
  }
  for (const payload of extractNestedShellPayloads(command)) {
    if (payload.length > 0 && hasGhPrMergeDeleteBranch(payload, depth + 1)) return true;
  }
  return false;
}

/**
 * コマンドの位置に在る `gh pr merge` と、その呼び出し区間（`;`/`&&`/`||`/`|`/改行の手前まで）。
 * 前置き・コマンド位置の判定は `GH_PR_MERGE_DELETE_BRANCH_RE` と同じ部品（新しい族は起こさない）。
 * 区間は捕捉群 1 に入る。`g` 付きなので `matchAll` で全部の呼び出しを見る。
 */
const GH_PR_MERGE_INVOCATION_RE = new RegExp(
  String.raw`${COMMAND_POSITION_LOOKBEHIND_SRC}[ \t]*${LEADING_ENV_PREFIX_SRC}${GH_WORD_SRC}\s+(?:${GH_REPO_FLAG_SRC})*pr\s+(?:${GH_REPO_FLAG_SRC})*merge\b((?:(?!;|&&|\|\||\||\n)[\s\S])*)`,
  'g',
);

/**
 * `--match-head-commit <sha>` / `--match-head-commit=<sha>`。値が空（`=` の直後が空白・末尾・
 * 空の引用符 `""` `''`）や、次のフラグ（`-` で始まる）は「付いていない」とみなす。
 */
const MATCH_HEAD_COMMIT_WITH_VALUE_RE =
  /(?<=[\s'"])--match-head-commit(?:=(?!["']{2}(?:\s|$)|\s|$)|[ \t]+(?!["']{2}(?:\s|$)|-|$))\S/;

/**
 * マージが起きない呼び出し（`--disable-auto`＝自動マージの取り消し、`--help`/`-h`）。
 * どちらも head を突き合わせる相手が無いので要求しない。`--auto` は要求する
 * （`gh pr merge --help` で `--match-head-commit` は他のフラグと排他と書かれておらず、
 * 自動マージでも「見た head」と「マージされる head」のずれは同じに起きる）。
 */
const GH_PR_MERGE_NO_MERGE_RE = /(?<=\s)(?:--disable-auto|--help|-h)(?=\s|$)/;

/**
 * コマンドの位置に在る `gh pr merge` に `--match-head-commit <sha>` が付いていないものが在るか（#1192 N7）。
 *
 * 「緑を見た head」と「マージされる head」のずれを、gh の側で拒ませる。PR の CI は
 * `refs/pull/N/merge` を見ていて `strict: false` なので、見た後に push された head は機械では
 * 突き合わされていない。前処理（ヒアドキュメントの本文・`--subject`/`--body` の引用符の値を潰す）と
 * 入れ子のシェルの取り出しは `hasGhPrMergeDeleteBranch` と同じ。
 *
 * 行の継続（`\` + 改行）は、呼び出し側が取り除いた写しだけを渡す（元の文字列の改行で区間が
 * 切れると、次の行の `--match-head-commit` を見落として誤って弾くため）。
 *
 * ⚠️ 残る限界: 区間の切り出しは引用符を追跡しない（既存の検出器と同じ）。潰されなかった
 * 引用符の値の中の `--match-head-commit` の字面は「付いている」と読む（通す側に倒れる）。
 */
function hasGhPrMergeWithoutMatchHeadCommit(command: string, depth = 0): boolean {
  const stripped = stripGhPrMergeQuotedSubjectBodyValues(stripHeredocs(command));
  for (const match of stripped.matchAll(GH_PR_MERGE_INVOCATION_RE)) {
    const segment = match[1] ?? '';
    if (GH_PR_MERGE_NO_MERGE_RE.test(segment)) continue;
    if (!MATCH_HEAD_COMMIT_WITH_VALUE_RE.test(segment)) return true;
  }
  if (depth >= MAX_NESTED_SHELL_DEPTH) {
    // 上限に達したら字面で粗く判定する（弾く側へ倒す。`looksLikeGhPrMergeDeleteBranch` と同じ考え）。
    return extractNestedShellPayloads(command).some((payload) => {
      const gh = payload.indexOf('gh');
      const merge = gh < 0 ? -1 : payload.indexOf('merge', gh + 2);
      return merge >= 0 && !payload.includes('--match-head-commit');
    });
  }
  for (const payload of extractNestedShellPayloads(command)) {
    if (payload.length > 0 && hasGhPrMergeWithoutMatchHeadCommit(payload, depth + 1)) return true;
  }
  return false;
}

/**
 * squash を選ぶフラグ: `--squash`、`-s`、束ねた短いフラグ（`-sd` など）。
 * 引用符で潰された値の中の字面は、`stripGhPrMergeQuotedSubjectBodyValues` が先に空白にする。
 */
const SQUASH_FLAG_RE = /(?<=[\s'"])(?:--squash(?=[\s'"=]|$)|-(?!-)[A-Za-z]*s[A-Za-z]*(?=[\s'"]|$))/;

/**
 * 本文を明示するフラグ: `--body` / `--body=…` / `--body-file` / `--body-file=…`、`-b` / `-F`
 * （束ねた形と、値をくっつけた形 `-bfoo` も含む）。値が空かどうかは見ない（`--body ""` も明示）。
 */
const BODY_FLAG_RE = /(?<=[\s'"])(?:--body(?:-file)?(?=[\s'"=]|$)|-(?!-)[A-Za-z]*[bF])/;

/**
 * コマンドの位置に在る `gh pr merge` で squash を選び、本文（`--body` / `-b` / `--body-file` / `-F`）
 * を明示していないものが在るか（#1350 の決定、#2280）。
 *
 * 既定の本文で squash すると、GitHub が `Co-authored-by:` の行を足すことがある（PR 内のコミットの
 * author が、マージする人と別の身元のとき）。前処理・入れ子のシェルの取り出し・区間の切り出しは
 * `hasGhPrMergeWithoutMatchHeadCommit` と同じ部品（新しい族は起こさない）。squash でない
 * （`--merge` / `--rebase` / 戦略の指定なし）とマージしない呼び出し（`--disable-auto` / `--help`）は弾かない。
 *
 * ⚠️ 残る限界: 区間の切り出しは引用符を追跡しない。潰されなかった引用符の値の中の `--body` の字面は
 * 「明示している」と読み、通す側に倒れる。`gh api` での直接マージ・alias・MCP の `merge_pull_request` は対象外。
 */
function hasGhPrMergeSquashWithoutBody(command: string, depth = 0): boolean {
  const stripped = stripGhPrMergeQuotedSubjectBodyValues(stripHeredocs(command));
  for (const match of stripped.matchAll(GH_PR_MERGE_INVOCATION_RE)) {
    const segment = match[1] ?? '';
    if (GH_PR_MERGE_NO_MERGE_RE.test(segment)) continue;
    if (SQUASH_FLAG_RE.test(segment) && !BODY_FLAG_RE.test(segment)) return true;
  }
  if (depth >= MAX_NESTED_SHELL_DEPTH) {
    // 上限に達したら字面で粗く判定する（弾く側へ倒す）。
    return extractNestedShellPayloads(command).some((payload) => {
      const gh = payload.indexOf('gh');
      const merge = gh < 0 ? -1 : payload.indexOf('merge', gh + 2);
      return merge >= 0 && payload.includes('--squash') && !payload.includes('--body');
    });
  }
  for (const payload of extractNestedShellPayloads(command)) {
    if (payload.length > 0 && hasGhPrMergeSquashWithoutBody(payload, depth + 1)) return true;
  }
  return false;
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
const SCRIPT_RUN_RE = new RegExp(
  String.raw`${COMMAND_POSITION_LOOKBEHIND_SRC}[ \t]*${LEADING_ENV_PREFIX_SRC}(?:${SHELL_NAME_SRC}[ \t]+(?!-)\S|source\b|\.[ \t]|\.{0,2}\/\S)`,
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

  // `gh pr merge --delete-branch` は「無限待ち」とは害の種類が違う
  // （終わらないことではなく、終わった後に戻せないこと）ので、
  // `timeout` ラップの早期 return より先に見る。`timeout 30 gh pr merge
  // 123 --delete-branch` は待ちを有界にするだけで、PR を巻き添えで
  // 閉じる危険は1文字も消えない —— ここで先に見ないと、下の
  // `isTimeoutWrapped` がこの形を「有界だから安全」と誤読して素通しする。
  //
  // **行の継続（`\` + 改行）を取り除いた写しにも、同じ判定をかける**（#2179）。bash は引用符の
  // 外の `\` + 改行を取り除いて1行として実行するが、この判定は改行を区切りとして読むので、
  // `gh pr merge 1 \` + 改行 + `--delete-branch` を見落としていた。**元の文字列と写しの両方に
  // かけ、どちらかが弾けば弾く。** 写しだけにかけると、単一引用符のヒアドキュメントの本文の
  // `\` + 改行（bash はそこでは取り除かない）で終端の行が消え、後ろの別のヒアドキュメントの
  // 終端まで本文として読んで、その間の本物のコマンドを消す形が作れる。両方にかければ、弾く
  // 側にしか倒れない。
  if (
    hasGhPrMergeDeleteBranch(trimmed) ||
    hasGhPrMergeDeleteBranch(joinLineContinuations(trimmed))
  ) {
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

  // `gh pr merge` に `--match-head-commit <sha>` が無い形（#1192 N7）。delete-branch と同じ理由で
  // `timeout` の早期 return より先に見る。行の継続を取り除いた写しにだけかける（理由は
  // `hasGhPrMergeWithoutMatchHeadCommit` の doc）。
  //
  // `gh pr merge --squash` に本文（`--body` / `-b` / `--body-file` / `-F`）が無い形（#1350 の決定、
  // #2280）も同じ位置で見る。**両方が欠けているときは、理由に両方を書く**（片方を直して打ち直すと
  // もう片方で弾かれる、を避ける）。形の名前は head の欠落を優先する（先に入れた形を変えない）。
  const joinedForMerge = joinLineContinuations(trimmed);
  const missingHead = hasGhPrMergeWithoutMatchHeadCommit(joinedForMerge);
  const missingBody = hasGhPrMergeSquashWithoutBody(joinedForMerge);
  if (missingHead || missingBody) {
    const headReason =
      '`gh pr merge` に `--match-head-commit <sha>` が付いていない。' +
      '**「緑を見た head」と「マージされる head」がずれうる** —— PR の CI は ' +
      '`refs/pull/N/merge` を見ていて、見た後に push された head は機械では突き合わされない ' +
      '（#1192 N7）。' +
      '代わりに次を使うこと: `--match-head-commit <確かめた head の sha>` を足して打つ' +
      '（sha は `gh pr view <N> --json headRefOid` で、緑を確かめた head と同じものを取る。' +
      'head が動いていれば gh が拒むので、確かめ直してからやり直す。`--auto` にも要る）。';
    const bodyReason =
      '`gh pr merge --squash` に本文（`--body` / `-b` / `--body-file` / `-F`）が付いていない。' +
      '**既定の本文で squash すると、GitHub が `Co-authored-by:` の行を足すことがある** —— ' +
      'PR 内のコミットの author がマージする人と別の身元のとき、その身元が共著者として ' +
      'main のコミットに焼かれて消せない（#1350 の決定。実例: #1473 の `87eec2bb`、' +
      'author が `claude` の別の身元）。マージする側が本文を明示する。' +
      '代わりに次を使うこと: 本文を書いたファイルを用意して ' +
      '`gh pr merge <N> --squash --match-head-commit <sha> --body-file <file>` と打つ' +
      '（`--body "<本文>"` でもよい。本文には帰属のトレーラと閉じるキーワードを書かない。' +
      '手順は `.claude/skills/pr-merge/SKILL.md`）。';
    return {
      blocked: true,
      form: missingHead ? 'gh-pr-merge-no-match-head-commit' : 'gh-pr-merge-squash-no-body',
      reason:
        missingHead && missingBody
          ? `次の2点が欠けている。(1) ${headReason} (2) ${bodyReason}`
          : missingHead
            ? headReason
            : bodyReason,
    };
  }

  // 全体が timeout に包まれていれば、中身がどんな形でも有界だと読める
  // （待ちの形についてのみ。上の delete-branch はこの早期 return より先に
  // 見ているので、ここでは影響されない）。
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

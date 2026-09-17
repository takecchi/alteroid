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
 */

/** 弾いた形の種別。テストと呼び出し側の note 文言がここへ分岐する。 */
export type WaitGuardForm = 'until-sleep' | 'while-sleep' | 'tail-f' | 'gh-run-watch-background';

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
 * ことのほうである。実測（2026-09-17、AGENTS.md「CI の完了を待つ形」に逐語）:
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

  // 全体が timeout に包まれていれば、中身がどんな形でも有界だと読める。
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

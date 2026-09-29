/**
 * `Bash` ツールの `timeout` 引数（ツールが待つ時間）が、コマンドの中の
 * `timeout <継続時間>`（子プロセスの寿命）より短い呼び出しを見つけ、引き上げる
 * 値を決める（issue #2088）。**純関数。** I/O もプロセスの状態も見ない。
 *
 * ## 何が起きていたか
 *
 * 作業者が `timeout 300 pnpm test` のようにコマンドの中へ寿命を書き、ツールの
 * `timeout` 引数を渡さずに打つ。コマンドの中の `timeout 300` は子プロセスを
 * 300秒で止めるだけで、**ツールが待つ時間は変えない。** ツールの既定は
 * 120000ms なので、120秒を過ぎた時点でツールの側が待つのをやめる。本番では
 * それが「自動で背景へ回す」形で現れ、作業者が背景の出力ファイルを読みに行って
 * 分類器に止められる事故が、2026-09-28 の夜に少なくとも3回起きた（#2088）。
 * 依頼文に書いても繰り返した。
 *
 * ## なぜ弾かずに引き上げるか
 *
 * PreToolUse の `updatedInput` で、ツールの `timeout` をコマンドの中の寿命に
 * 合わせて引き上げる。**弾くと往復が1回増えるうえ、打った側の能力は何も増えない。**
 * 引き上げれば、打った側が意図したとおり前景で終わりまで待てる。
 *
 * 次の3つは、本物の Claude Code 本体（SDK 0.3.283 / 本体 2.1.283）に偽の API を
 * 当てて、実行時に確かめた（2026-09-29T02:2xZ、#2088 のコメント）。
 * - フックの `tool_input` に `timeout` が載る
 * - `permissionDecision` を付けない `updatedInput` が適用される
 * - 書き換えた `timeout` の値が効く
 *
 * 歯は `real-cli-pre-tool-use-rewrite.test.ts`（SDK が上がって挙動が変われば赤になる）。
 *
 * ## 何を数えるか
 *
 * - **コマンドの中の `timeout <継続時間>` を全部拾い、合計する。** `a && b` の
 *   ように順に走るなら、合計が待つ時間の上限になる。並んで走る形や、引用符の
 *   中の字面まで数えると多めに見積もるが、引き上げる向きにしか働かない
 *   （待てる時間が延びるだけで、コマンドは終われば終わる）。だから構文は解かない
 * - 継続時間は GNU `timeout` の形（`300` / `1.5m` / `2h` / `1d`。単位を省けば秒）。
 *   `timeout` のオプション（`-k <値>` / `-s <値>` / `--…`）は読み飛ばす
 * - **`timeout 0` は「寿命なし」**（GNU の意味）なので、上限（600000ms）まで引き上げる
 * - 合計に余裕（`BASH_TOOL_TIMEOUT_MARGIN_MS`）を足す。コマンドの中の `timeout` が
 *   先に切れて、その出力（終了コード 124 など）がツールの結果として返るようにするため
 * - 上限は `BASH_TOOL_MAX_TIMEOUT_MS`（ツールの `timeout` 引数の上限。SDK の
 *   `BashInput.timeout` の doc「max 600000」）。それより長い寿命は引き上げきれない
 *
 * ## 触らないもの
 *
 * - **下げる向きには書き換えない。** ツールの `timeout` が既に十分なら何もしない
 * - **`run_in_background: true` の呼び出し**（背景ではツールは待たない）
 * - ツールの `timeout` が数でないとき（形が崩れている）は、既定の 120000ms と
 *   みなして比べる。書き換える入力は、元の入力の他の欄を1つも変えない
 */

/** ツールの `timeout` 引数を渡さないときの既定（ミリ秒）。 */
export const BASH_TOOL_DEFAULT_TIMEOUT_MS = 120_000;

/** ツールの `timeout` 引数の上限（ミリ秒）。SDK の `BashInput.timeout` の doc。 */
export const BASH_TOOL_MAX_TIMEOUT_MS = 600_000;

/** コマンドの中の `timeout` が先に切れるよう、合計に足す余裕（ミリ秒）。 */
export const BASH_TOOL_TIMEOUT_MARGIN_MS = 10_000;

/**
 * コマンドの中の `timeout [オプション…] <継続時間>`。
 *
 * - 手前は行頭・空白・`;` `&` `|` `(` `)` バッククォートのどれか（語の途中の
 *   `mytimeout` を拾わない）
 * - オプションは `-k <値>` / `-s <値>` / `--<名前>[=<値>]` / 値を取らない短い
 *   フラグ（`-v` など）を読み飛ばす。**選択肢の先頭が互いに重ならない**
 *   （`-k`・`-s` は値を必須にし、それ以外の短いフラグは値を取らない）ので、後戻りは増えない
 * - 継続時間の後ろは空白（`timeout 300pnpm` のような形は `timeout` ではない）
 */
const COMMAND_TIMEOUT_RE =
  /(?<=^|[\s;&|()`])timeout(?:[ \t]+(?:-[ks][ \t]+\S+|--\S+|-[A-Za-jl-rt-z]))*[ \t]+(\d+(?:\.\d*)?|\.\d+)([smhd]?)(?=[ \t])/g;

const UNIT_MS: Readonly<Record<string, number>> = {
  '': 1000,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** 引き上げの計画。`fromMs` はツールの `timeout` 引数（渡されていなければ `undefined`）。 */
export interface BashToolTimeoutRaise {
  readonly fromMs: number | undefined;
  readonly toMs: number;
  /** コマンドの中の `timeout` の合計（ミリ秒）。`timeout 0` を含めば `undefined`（寿命なし）。 */
  readonly commandTimeoutTotalMs: number | undefined;
}

/**
 * コマンドの中の `timeout` の合計（ミリ秒）を返す。1つも無ければ `null`、
 * `timeout 0`（寿命なし）を含めば `Infinity`。
 */
export function commandTimeoutTotalMs(command: string): number | null {
  let total = 0;
  let found = false;
  COMMAND_TIMEOUT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMMAND_TIMEOUT_RE.exec(command)) !== null) {
    found = true;
    const value = Number(match[1]);
    const unit = UNIT_MS[match[2] ?? ''] ?? 1000;
    if (value === 0) return Infinity;
    total += value * unit;
  }
  return found ? total : null;
}

/**
 * `Bash` の `tool_input` を見て、ツールの `timeout` 引数を引き上げるべきなら
 * その計画を返す。引き上げなくてよければ `undefined`。
 */
export function planBashToolTimeoutRaise(toolInput: {
  readonly command?: unknown;
  readonly timeout?: unknown;
  readonly run_in_background?: unknown;
}): BashToolTimeoutRaise | undefined {
  if (typeof toolInput.command !== 'string') return undefined;
  if (toolInput.run_in_background === true) return undefined;

  const total = commandTimeoutTotalMs(toolInput.command);
  if (total === null) return undefined;

  const fromMs =
    typeof toolInput.timeout === 'number' &&
    Number.isFinite(toolInput.timeout) &&
    toolInput.timeout > 0
      ? toolInput.timeout
      : undefined;
  const currentMs = fromMs ?? BASH_TOOL_DEFAULT_TIMEOUT_MS;

  const wantedMs = Math.min(
    BASH_TOOL_MAX_TIMEOUT_MS,
    Number.isFinite(total)
      ? Math.ceil(total + BASH_TOOL_TIMEOUT_MARGIN_MS)
      : BASH_TOOL_MAX_TIMEOUT_MS,
  );
  if (wantedMs <= currentMs) return undefined;

  return {
    fromMs,
    toMs: wantedMs,
    commandTimeoutTotalMs: Number.isFinite(total) ? total : undefined,
  };
}

/** 引き上げたことを、打った側（エージェント）へ伝える一文。 */
export function describeBashToolTimeoutRaise(raise: BashToolTimeoutRaise): string {
  const from =
    raise.fromMs === undefined
      ? `未指定（既定 ${BASH_TOOL_DEFAULT_TIMEOUT_MS}ms）`
      : `${raise.fromMs}ms`;
  const basis =
    raise.commandTimeoutTotalMs === undefined
      ? 'コマンドの中に `timeout 0`（寿命なし）が在るので上限まで'
      : `コマンドの中の \`timeout\` の合計 ${raise.commandTimeoutTotalMs}ms に余裕 ${BASH_TOOL_TIMEOUT_MARGIN_MS}ms を足した値（上限 ${BASH_TOOL_MAX_TIMEOUT_MS}ms）`;
  return (
    `この Bash の呼び出しの \`timeout\` 引数を ${from} から ${raise.toMs}ms に引き上げた（${basis}）。` +
    'コマンドの中の `timeout` は子プロセスの寿命であって、Bash ツールが待つ時間ではない。' +
    'ツールの `timeout` 引数が足りないと、ツールの側が先に待つのをやめる（背景へ回されることがある）。' +
    '次からは、長いコマンドにはツールの `timeout` 引数にも同じだけの値（600000 以下）を入れること。'
  );
}

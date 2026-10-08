export const BASH_TOOL_DEFAULT_TIMEOUT_MS = 120_000;

export const BASH_TOOL_MAX_TIMEOUT_MS = 600_000;

// コマンドの中の `timeout` が先に切れて、その出力（終了コード 124 など）がツールの結果として返るようにする
export const BASH_TOOL_TIMEOUT_MARGIN_MS = 10_000;

// 構文（引用符など）は解かない: 引用符の中の字面まで数えて多めに見積もっても、引き上げる向きにしか働かない（待てる時間が延びるだけ）ため
// 手前に引用符を許す: `bash -c "timeout 590 …"` の中の `timeout` も、外側のツールが待つ時間を決めるため
// 継続時間の後ろに空白以外の区切りも許す: 読めない形では引き上げが黙って効かないため
const COMMAND_TIMEOUT_RE =
  /(?<=^|[\s;&|()`'"])timeout(?:[ \t]+(?:-[ks][ \t]+\S+|--\S+|-[A-Za-jl-rt-z]))*[ \t]+(\d+(?:\.\d*)?|\.\d+)([smhd]?)(?=[\s;&|()`'"]|$)/g;

const TEST_DEADLINE_RE =
  /(?<=^|[\s;&|()`'"])--deadline-seconds(?:=|[ \t]+)(\d+)(?=[\s;&|()`'"]|$)/g;

// `scripts/test.mjs` の `DEADLINE_KILL_GRACE_MS` と同じ値
export const TEST_DEADLINE_KILL_GRACE_MS = 3000;

const UNIT_MS: Readonly<Record<string, number>> = {
  '': 1000,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export interface BashToolTimeoutRaise {
  readonly fromMs: number | undefined;
  readonly toMs: number;
  readonly commandTimeoutTotalMs: number | undefined;
}

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
  TEST_DEADLINE_RE.lastIndex = 0;
  while ((match = TEST_DEADLINE_RE.exec(command)) !== null) {
    const seconds = Number(match[1]);
    if (seconds === 0) continue;
    found = true;
    total += seconds * 1000 + TEST_DEADLINE_KILL_GRACE_MS;
  }
  return found ? total : null;
}

// 弾かずに引き上げる: 弾くと往復が1回増えるうえ、打った側の能力は何も増えないため
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

export function describeBashToolTimeoutRaise(raise: BashToolTimeoutRaise): string {
  const from =
    raise.fromMs === undefined
      ? `未指定（既定 ${BASH_TOOL_DEFAULT_TIMEOUT_MS}ms）`
      : `${raise.fromMs}ms`;
  const basis =
    raise.commandTimeoutTotalMs === undefined
      ? 'コマンドの中に `timeout 0`（寿命なし）が在るので上限まで'
      : `コマンドの中の \`timeout\` / \`--deadline-seconds\` の合計 ${raise.commandTimeoutTotalMs}ms に余裕 ${BASH_TOOL_TIMEOUT_MARGIN_MS}ms を足した値（上限 ${BASH_TOOL_MAX_TIMEOUT_MS}ms）`;
  return (
    `この Bash の呼び出しの \`timeout\` 引数を ${from} から ${raise.toMs}ms に引き上げた（${basis}）。` +
    'コマンドの中の `timeout` / `--deadline-seconds` は子プロセスの寿命であって、Bash ツールが待つ時間ではない。' +
    'ツールの `timeout` 引数が足りないと、ツールの側が先に待つのをやめる（背景へ回されることがある）。' +
    '次からは、長いコマンドにはツールの `timeout` 引数にも同じだけの値（600000 以下）を入れること。'
  );
}

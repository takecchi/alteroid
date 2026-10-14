/**
 * 大きな文字列を処理する手順を、途中で区切れる形（generator の `yield`）で書き、
 * 同期で最後まで回す口と、区切りごとにループへ順番を返す口の両方から使う（#4659）。
 * 同じ手順を2本書かない: 片方だけ直すと、順番を返す版と返さない版で答えが食い違うため。
 */

/** 区切る目安の字数。1M字の走査・解読は数 ms で、返す回数が多すぎず、1回の占有が見張りの閾値（1秒）を大きく下回る（`SSE_READ_YIELD_BYTES` と同じ考え方）。 */
export const LOOP_YIELD_CHARS = 1024 * 1024;

export type YieldingSteps<T> = Generator<void, T, void>;

/** 手順を同期で最後まで回す。 */
export function runSteps<T>(steps: YieldingSteps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}

/** 手順を回し、区切りごとに `setImmediate` でループへ順番を返す。 */
export async function runStepsYielding<T>(steps: YieldingSteps<T>): Promise<T> {
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * `body.split('\n')` と同じ行を、全体を割らずに1行ずつ渡す。行の始まりと終わり（`\n` の位置。最後の行は `body.length`）も渡す。
 * 渡した字数が `yieldChars` を超えるたびに区切る（`yield`）。
 */
export function* eachLine(
  body: string,
  yieldChars: number,
  onLine: (line: string, start: number, end: number) => void,
): YieldingSteps<void> {
  let start = 0;
  let sinceYield = 0;
  for (;;) {
    const newline = body.indexOf('\n', start);
    const end = newline === -1 ? body.length : newline;
    onLine(body.slice(start, end), start, end);
    if (newline === -1) return;
    sinceYield += end - start + 1;
    start = end + 1;
    if (sinceYield >= yieldChars) {
      sinceYield = 0;
      yield;
    }
  }
}

function* jsonLinesSteps(values: readonly unknown[], yieldChars: number): YieldingSteps<string> {
  const lines: string[] = [];
  let sinceYield = 0;
  for (const value of values) {
    // 直列化できない値は `map` と `join` と同じく空の行にする
    const line = JSON.stringify(value) ?? '';
    lines.push(line);
    sinceYield += line.length;
    if (sinceYield >= yieldChars) {
      sinceYield = 0;
      yield;
    }
  }
  return `${lines.join('\n')}\n`;
}

/** 値を1行ずつ JSON にして改行で繋ぐ（末尾にも改行）。約 `yieldChars` 字ごとにループへ順番を返す（#4659）。 */
export function jsonLinesYielding(
  values: readonly unknown[],
  yieldChars: number = LOOP_YIELD_CHARS,
): Promise<string> {
  return runStepsYielding(jsonLinesSteps(values, yieldChars));
}

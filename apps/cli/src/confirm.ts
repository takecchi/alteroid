import { createInterface } from 'node:readline/promises';
import { stdin } from 'node:process';
import { stdout } from './terminal-out.js';

/**
 * 戻せない操作の確認（Issue #3141）。
 *
 * **形は `alteroid reset`（`reset.ts`）に揃えてある。**
 * - 端末（TTY）なら対話で確認する。`y` ではなく `yes` の全文を要求する（1文字の
 *   誤打で通さない）。「やめた」ときは**決まった例外（{@link ConfirmDeclinedError}）を投げて**
 *   何もしない。入口の最上位（`index.ts` の `reportCliFailure`）がそれを stderr の1行
 *   （`取り消しました。何も変更していません。`）と**終了コード 1**にする（#3450）。やめたのに 0 で
 *   返ると、`alteroid reset && ...` のような連結で、やめたのに次が走る。stdout には成功の文を出さない
 * - `--yes` を渡すと確認を飛ばす（スクリプト・CI から呼ぶ用途）。確認を無くすのではなく、
 *   確認の主体を対話の相手から呼び出し側へ移すだけである
 * - **端末ではなく `--yes` も無いときは、実行せずに断る（例外＝終了コード非 0）。**
 *   スクリプトや cron が、確認の無いまま黙って消す形にしない。`alteroid reset` も
 *   Issue #3200 でこの扱いに揃えた（以前は標準入力から `yes` を読めた）
 *
 * **戻せない操作にだけ使う。** 戻せるもの（`daemon stop`・`runners vacate`・予定を外す等）
 * には付けない。どれを戻せないと判定したかは PR #3141 の本文に在る。
 */

/** 確認に使う口。テストが端末・標準入力に触れずに通せるよう差し込める。 */
export interface ConfirmIo {
  isTTY: boolean;
  write(text: string): void;
  ask(question: string): Promise<string>;
}

function defaultIo(): ConfirmIo {
  return {
    isTTY: stdin.isTTY === true && stdout.isTTY === true,
    write: (text) => {
      stdout.write(text);
    },
    ask: async (question) => {
      const rl = createInterface({ input: stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

/** やめたときの文。stderr に1行で出る（stdout には出さない）。 */
const DECLINED_MESSAGE = '取り消しました。何も変更していません。';

/**
 * 戻せない操作の確認で、使い手がやめた（#3450）。`confirmIrreversible` が投げる。
 *
 * **失敗とは別の型にしてあるのは、呼び出し側が区別できるようにするため**で、終了コードは
 * 他の失敗と同じ非 0（1）になる——スクリプトから「何もしなかった」を成功と見分けるため。
 * REPL（`confirmInRepl`）は対象外（REPL は続けるので、やめても終了しない）。
 */
export class ConfirmDeclinedError extends Error {
  constructor() {
    super(DECLINED_MESSAGE);
    this.name = 'ConfirmDeclinedError';
  }
}

const PROMPT = '続けるなら yes と入力してください: ';
const DECLINED = `${DECLINED_MESSAGE}\n`;

/** `yes`（大文字小文字・前後の空白は問わない）だけが承認。 */
function isYes(answer: string): boolean {
  return answer.trim().toLowerCase() === 'yes';
}

/**
 * `summary`（何が戻せなくなるか）を示して確認する。進めてよければ `true` を返す。
 * やめたなら {@link ConfirmDeclinedError} を投げる（#3450。`false` は返らない）。
 * 端末でなく `--yes` も無ければ、別の例外を投げる。
 */
export async function confirmIrreversible(
  summary: string,
  options: { yes?: boolean },
  io: ConfirmIo = defaultIo(),
): Promise<true> {
  if (options.yes === true) return true;
  if (!io.isTTY) {
    throw new Error(
      `${summary}\n取り消せない操作です。端末ではなく対話で確認できないので、実行しません` +
        '（何も変更していません）。確認を省くには --yes を付けてください。',
    );
  }
  io.write(`${summary}\n取り消せません。\n`);
  if (isYes(await io.ask(PROMPT))) return true;
  throw new ConfirmDeclinedError();
}

/**
 * REPL（`alteroid chat`）のスラッシュコマンド用。**REPL がすでに持っている readline で
 * 聞く**（同じ標準入力に2つ目の readline を重ねない）。REPL は対話の中なので TTY 判定も
 * `--yes` も無い——答えが `yes` でなければやめる。質問の口が閉じた（Ctrl-D 等）ときもやめる。
 */
export async function confirmInRepl(
  summary: string,
  ask: (question: string) => Promise<string>,
  write: (text: string) => void = (text) => {
    stdout.write(text);
  },
  isTTY: boolean = stdin.isTTY === true,
): Promise<boolean> {
  // 標準入力が端末でない REPL（パイプ）では、流れてきた `yes` で通さない（#3141・#3200 と同じ線）。
  if (!isTTY) {
    write(
      `${summary}\n取り消せない操作です。端末ではなく対話で確認できないので、実行しません（何も変更していません）。` +
        '確認を省くには、REPL ではなく単発のコマンドに --yes を付けてください。\n',
    );
    return false;
  }
  write(`${summary}\n取り消せません。\n`);
  let answer: string;
  try {
    answer = await ask(PROMPT);
  } catch {
    answer = '';
  }
  if (isYes(answer)) return true;
  write(DECLINED);
  return false;
}

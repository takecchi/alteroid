import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * 戻せない操作の確認（Issue #3141）。
 *
 * **形は `alteroid reset`（`reset.ts`）に揃えてある。**
 * - 端末（TTY）なら対話で確認する。`y` ではなく `yes` の全文を要求する（1文字の
 *   誤打で通さない）。「やめた」ときは `取り消しました。何も変更していません。` を出して
 *   何もしない
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
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

const PROMPT = '続けるなら yes と入力してください: ';
const DECLINED = '取り消しました。何も変更していません。\n';

/** `yes`（大文字小文字・前後の空白は問わない）だけが承認。 */
function isYes(answer: string): boolean {
  return answer.trim().toLowerCase() === 'yes';
}

/**
 * `summary`（何が戻せなくなるか）を示して確認する。進めてよければ `true`、やめたなら
 * `false`（何もしないこと）。端末でなく `--yes` も無ければ投げる。
 */
export async function confirmIrreversible(
  summary: string,
  options: { yes?: boolean },
  io: ConfirmIo = defaultIo(),
): Promise<boolean> {
  if (options.yes === true) return true;
  if (!io.isTTY) {
    throw new Error(
      `${summary}\n取り消せない操作です。端末ではなく対話で確認できないので、実行しません` +
        '（何も変更していません）。確認を省くには --yes を付けてください。',
    );
  }
  io.write(`${summary}\n取り消せません。\n`);
  if (isYes(await io.ask(PROMPT))) return true;
  io.write(DECLINED);
  return false;
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
): Promise<boolean> {
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

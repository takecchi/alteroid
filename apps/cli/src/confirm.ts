import { createInterface } from 'node:readline/promises';
import { stdin } from 'node:process';
import { stdout } from './terminal-out.js';

export interface ConfirmIo {
  isTTY: boolean;
  write(text: string): void;
  ask(question: string): Promise<string>;
}

export function defaultIo(): ConfirmIo {
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

const DECLINED_MESSAGE = '取り消しました。何も変更していません。';

export class ConfirmDeclinedError extends Error {
  constructor() {
    super(DECLINED_MESSAGE);
    this.name = 'ConfirmDeclinedError';
  }
}

const PROMPT = '続けるなら yes と入力してください: ';
const DECLINED = `${DECLINED_MESSAGE}\n`;

function isYes(answer: string): boolean {
  return answer.trim().toLowerCase() === 'yes';
}

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

// 「取り消せません」と言わない: 外せば元に戻る操作（`plugin add`）に、取り消せないという誤った重さを付けないため
export async function confirmProceed(
  summary: string,
  options: { yes?: boolean },
  io: ConfirmIo = defaultIo(),
): Promise<true> {
  if (options.yes === true) return true;
  if (!io.isTTY) {
    throw new Error(
      `${summary}\n端末ではなく対話で確認できないので、実行しません（何も変更していません）。` +
        '確認を省くには --yes を付けてください。',
    );
  }
  io.write(`${summary}\n`);
  if (isYes(await io.ask(PROMPT))) return true;
  throw new ConfirmDeclinedError();
}

export async function confirmInRepl(
  summary: string,
  ask: (question: string) => Promise<string>,
  write: (text: string) => void = (text) => {
    stdout.write(text);
  },
  isTTY: boolean = stdin.isTTY === true,
): Promise<boolean> {
  // 端末でない REPL（パイプ）では通さない: 流れてきた `yes` で戻せない操作が走るため
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

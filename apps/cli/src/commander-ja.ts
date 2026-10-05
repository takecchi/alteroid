import type { Command } from 'commander';

/**
 * commander が出す既定の英語（見出し・`-h` / `-V` / `help` の説明・引数の誤りの文）を日本語にする
 * （#2857）。**サブコマンドは作った時点の親の設定を引き継ぐ**（`copyInheritedSettings`）ので、
 * 呼ぶのは `new Command()` の直後、`.command()` を足す前である。
 */

const TITLES: Readonly<Record<string, string>> = {
  'Usage:': '使い方:',
  'Options:': 'オプション:',
  'Commands:': 'コマンド:',
  'Arguments:': '引数:',
};

/**
 * commander の誤りの文（英語・`error: …` の1行）を日本語にする。知らない形は
 * そのまま返す（commander が文を足したときに、握り潰さず元の文が見える）。
 */
export function translateCommanderError(raw: string): string {
  const line = raw.replace(/\n$/, '');
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [
      /^error: unknown command '(.*?)'(?: \(Did you mean (.*?)\?\))?$/,
      (m) =>
        `error: 「${m[1]}」というコマンドはありません${m[2] === undefined ? '' : `（もしかして ${m[2]}）`}`,
    ],
    [/^error: missing required argument '(.*?)'$/, (m) => `error: 引数 <${m[1]}> が足りません`],
    [
      /^error: required option '(.*?)' not specified$/,
      (m) => `error: オプション ${m[1]} は必須です`,
    ],
    [
      /^error: option '(.*?)' argument missing$/,
      (m) => `error: オプション ${m[1]} には値が要ります`,
    ],
    [
      /^error: unknown option '(.*?)'(?: \(Did you mean (.*?)\?\))?$/,
      (m) =>
        `error: 「${m[1]}」というオプションはありません${m[2] === undefined ? '' : `（もしかして ${m[2]}）`}`,
    ],
    [
      /^error: too many arguments(?: for '(.*?)')?\. Expected (\d+) arguments? but got (\d+)\.$/,
      (m) =>
        `error: 引数が多すぎます${m[1] === undefined ? '' : `（${m[1]}）`}。${m[2]} 個のところに ${m[3]} 個渡されました`,
    ],
  ];
  for (const [pattern, render] of rules) {
    const match = pattern.exec(line);
    if (match !== null) return `${render(match)}\n`;
  }
  return raw;
}

export function localizeCommander(command: Command): Command {
  return command
    .configureHelp({ styleTitle: (title) => TITLES[title] ?? title })
    .configureOutput({ outputError: (text, write) => write(translateCommanderError(text)) })
    .helpOption('-h, --help', 'このコマンドの使い方を出す')
    .helpCommand('help [command]', 'コマンドの使い方を出す')
    .showHelpAfterError('（使い方は --help で見られます）');
}

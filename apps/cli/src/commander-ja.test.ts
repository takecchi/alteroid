import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { localizeCommander, translateCommanderError } from './commander-ja.js';

function build() {
  const out: string[] = [];
  const program = new Command();
  program.exitOverride();
  localizeCommander(program);
  program.configureOutput({
    writeOut: (s) => out.push(s),
    writeErr: (s) => out.push(s),
    outputError: (s, write) => write(translateCommanderError(s)),
  });
  program.name('t').description('試験').version('1.0.0', '-V, --version', 'バージョンを出す');
  program.command('show <slug>').description('1件を出す');
  program.command('rm').requiredOption('--types <種類>', '種類').description('消す');
  return { program, out };
}

describe('commander の既定の英語を日本語にする（#2857）', () => {
  it('help の見出し・-h・help コマンドの説明が日本語', () => {
    const { program, out } = build();
    expect(() => program.parse(['node', 't', '--help'])).toThrow();
    const text = out.join('');
    expect(text).toContain('使い方:');
    expect(text).toContain('オプション:');
    expect(text).toContain('コマンド:');
    expect(text).toContain('このコマンドの使い方を出す');
    expect(text).toContain('コマンドの使い方を出す');
    expect(text).toContain('バージョンを出す');
    expect(text).not.toMatch(/display help|output the version|Usage:|Options:|Commands:/);
  });

  it('サブコマンドの help も日本語（親の設定を引き継ぐ）', () => {
    const { program, out } = build();
    expect(() => program.parse(['node', 't', 'show', '--help'])).toThrow();
    const text = out.join('');
    expect(text).toContain('使い方:');
    expect(text).toContain('オプション:');
    expect(text).not.toContain('display help for command');
  });

  it.each([
    [['bogus'], '「bogus」というコマンドはありません'],
    [['show'], '引数 <slug> が足りません'],
    [['rm'], 'オプション --types <種類> は必須です'],
    [['show', 'a', '--nope'], '「--nope」というオプションはありません'],
  ])('誤りの文 %j は日本語で、--help への入口を添える', (argv, expected) => {
    const { program, out } = build();
    expect(() => program.parse(['node', 't', ...argv])).toThrow();
    const text = out.join('');
    expect(text).toContain(expected);
    expect(text).toContain('使い方は --help で見られます');
    expect(text).not.toMatch(/unknown|missing required|not specified/);
  });

  it('知らない形の文は握り潰さず、そのまま返す', () => {
    expect(translateCommanderError("error: something new 'x'\n")).toBe(
      "error: something new 'x'\n",
    );
  });
});

import { describe, expect, it } from 'vitest';

import { COMMANDS, helpLines, resolveCommand } from './commands.js';

describe('resolveCommand', () => {
  it('/ で始まらなければ発言（前後の空白は落とす）', () => {
    expect(resolveCommand('  こんにちは ')).toEqual({ kind: 'text', text: 'こんにちは' });
  });

  it('名前と別名で解決し、引数を取る。大文字小文字は区別しない', () => {
    expect(resolveCommand('/exit')).toMatchObject({ kind: 'command', spec: { action: 'exit' } });
    expect(resolveCommand('/QUIT')).toMatchObject({ kind: 'command', spec: { action: 'exit' } });
    expect(resolveCommand('/history  x y')).toMatchObject({
      kind: 'command',
      spec: { action: 'conversations' },
      args: 'x y',
    });
    expect(resolveCommand('/?')).toMatchObject({ kind: 'command', spec: { action: 'help' } });
  });

  it('/resume は進行中の会話へ戻るコマンドで、引数に会話 id を取る', () => {
    expect(resolveCommand('/resume')).toMatchObject({
      kind: 'command',
      spec: { action: 'resume' },
      args: '',
    });
    expect(resolveCommand('/RESUME c-1')).toMatchObject({
      kind: 'command',
      spec: { action: 'resume' },
      args: 'c-1',
    });
  });

  it('/ だけなら help', () => {
    expect(resolveCommand('/')).toMatchObject({ kind: 'command', spec: { action: 'help' } });
  });

  it('未知の名前はクローンへ送らず unknown にする', () => {
    expect(resolveCommand('/exti')).toEqual({ kind: 'unknown', name: 'exti' });
  });

  it('// で始めると、先頭の / を 1 つ外した発言として送れる', () => {
    expect(resolveCommand('//exit は終了です')).toEqual({ kind: 'text', text: '/exit は終了です' });
  });

  it('Issue が挙げた画面移動のコマンドが全部ある', () => {
    for (const name of ['chat', 'approvals', 'managers', 'journal', 'memory', 'exit']) {
      expect(resolveCommand(`/${name}`).kind).toBe('command');
    }
  });

  it('名前・別名が重複しない', () => {
    const names = COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('help は全コマンドを載せる', () => {
    const text = helpLines().join('\n');
    for (const c of COMMANDS) expect(text).toContain(`/${c.name}`);
  });

  it('help は改行のキーと、Shift+Enter が端末によっては送信になることを案内する', () => {
    const text = helpLines().join('\n');
    expect(text).toContain('Alt+Enter');
    expect(text).toContain('行末の \\ + Enter');
    expect(text).toMatch(/Shift\+Enter[^\n]*送信になる/);
  });

  it('help は入力欄の編集キー（Home/End・Ctrl+A/E/W/K・Delete）を案内する', () => {
    const text = helpLines().join('\n');
    for (const k of ['Home', 'End', 'Ctrl+A', 'Ctrl+E', 'Ctrl+W', 'Ctrl+K', 'Delete']) {
      expect(text).toContain(k);
    }
  });

  it('help は、書きかけがあるときの終了が二度押し（^D か /exit）であることを案内する（#3490・#3518）', () => {
    const exit = COMMANDS.find((c) => c.action === 'exit');
    expect(exit?.describe).toMatch(/書きかけ[^\n]*もう一度/);
    const text = helpLines().join('\n');
    expect(text).toMatch(/Ctrl\+D[^\n]*書きかけ[^\n]*もう一度/);
    expect(text).not.toContain('Ctrl+D（入力欄が空のとき）終了');
  });
});

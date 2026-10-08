import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  ENTER_ALT_SCREEN,
  enterAltScreen,
  installCrashRestore,
  LEAVE_ALT_SCREEN,
  POP_KITTY_KEYBOARD,
  RESET_TERMINAL,
  resetTerminalModes,
  TUI_KITTY_KEYBOARD,
} from './terminal.js';

describe('kitty keyboard protocol の設定', () => {
  it('問い合わせて応じた端末にだけ、disambiguate だけを要求する（Enter・Tab・文字の符号は変えない）', () => {
    expect(TUI_KITTY_KEYBOARD).toEqual({ mode: 'auto', flags: ['disambiguateEscapeCodes'] });
    expect(POP_KITTY_KEYBOARD).toBe('\x1b[<u');
  });
});

function sink() {
  const writes: string[] = [];
  return { writes, write: (text: string) => writes.push(text) };
}

describe('enterAltScreen', () => {
  it('入るときに enter を書き、抜ける関数は leave を 1 度だけ書く（冪等）', () => {
    const out = sink();
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const leave = enterAltScreen(out, proc);
    expect(out.writes).toEqual([ENTER_ALT_SCREEN]);
    leave();
    leave();
    expect(out.writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
  });

  it('明示の leave を通らなくても、プロセスの exit で端末を戻す', () => {
    const out = sink();
    const proc = new EventEmitter();
    enterAltScreen(out, proc as unknown as NodeJS.Process);
    proc.emit('exit');
    expect(out.writes).toEqual([ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN]);
    proc.emit('exit');
    expect(out.writes).toHaveLength(2);
  });
});

describe('resetTerminalModes', () => {
  it('マウス・bracketed paste・カーソル・alt screen を全部落とす列を書く', () => {
    const out = sink();
    resetTerminalModes(out);
    expect(out.writes).toEqual([RESET_TERMINAL]);
    for (const mode of ['?1000l', '?1002l', '?1003l', '?1006l', '?2004l', '?25h', '?1049l']) {
      expect(RESET_TERMINAL).toContain(mode);
    }
  });
});

describe('installCrashRestore', () => {
  function fakeProc() {
    const emitter = new EventEmitter();
    const exit = vi.fn();
    return { emitter, exit, proc: Object.assign(emitter, { exit }) as unknown as NodeJS.Process };
  }

  it('未捕捉の例外では、端末を戻してから理由を出して終了する（alt screen のまま消えない）', () => {
    const { emitter, exit, proc } = fakeProc();
    const order: string[] = [];
    const err = { write: (t: string) => order.push(`err:${t}`) };
    installCrashRestore(() => order.push('restore'), err, proc);
    emitter.emit('uncaughtException', new Error('壊れた'));
    expect(order[0]).toBe('restore');
    expect(order[1]).toContain('壊れた');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('SIGTERM / SIGHUP でも戻して終了する', () => {
    const { emitter, exit, proc } = fakeProc();
    const restore = vi.fn();
    installCrashRestore(restore, sink(), proc);
    emitter.emit('SIGTERM');
    expect(restore).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('解除関数で全部外れる', () => {
    const { emitter, proc } = fakeProc();
    const uninstall = installCrashRestore(vi.fn(), sink(), proc);
    uninstall();
    for (const event of ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGHUP']) {
      expect(emitter.listenerCount(event)).toBe(0);
    }
  });
});

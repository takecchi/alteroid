import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Ink の render が返す instance を拾う: テストから unmount（= 正常終了）させるため
const instances: { unmount: () => void }[] = [];
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: (node: Parameters<typeof actual.render>[0], options: object) => {
      // patchConsole だけ切る: vitest が差し替えた console に Ink の patch-console が付けないため（kittyKeyboard など他の指定はそのまま通す）
      const instance = actual.render(node, { ...options, patchConsole: false });
      instances.push(instance);
      return instance;
    },
  };
});

const { runApp } = await import('./main.js');
const { fakeApi } = await import('./fake-api.js');
const { FakeStdin } = await import('./test-helpers.js');
const { POP_KITTY_KEYBOARD, RESET_TERMINAL } = await import('./terminal.js');

const QUERY = '\x1b[?u';
const SUPPORTED_REPLY = '\x1b[?0u';
const PUSH = '\x1b[>1u';

class FakeStdout extends EventEmitter {
  readonly writes: string[] = [];
  readonly isTTY = true;
  readonly rows = 24;
  readonly columns = 80;
  write = (text: string): boolean => {
    this.writes.push(text);
    return true;
  };
  count(sequence: string): number {
    return this.writes.filter((w) => w === sequence).length;
  }
  has(sequence: string): boolean {
    return this.writes.some((w) => w.includes(sequence));
  }
}

function setup() {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const stderr = { write: vi.fn() };
  const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const done = runApp(
    fakeApi(),
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
    proc as unknown as Pick<NodeJS.Process, 'on' | 'removeListener' | 'exit'>,
  );
  return { stdin, stdout, proc, done };
}

afterEach(() => {
  instances.splice(0);
});

describe('runApp と kitty keyboard protocol（Shift+Enter を区別して送らせる要求）', () => {
  it('起動時に端末へ問い合わせ、応じた端末にだけ要求を出し、正常終了で 1 度だけ戻す', async () => {
    const { stdin, stdout, done } = setup();
    await vi.waitFor(() => expect(stdout.has(QUERY)).toBe(true));
    // 応じる前は要求を出さない
    expect(stdout.has(PUSH)).toBe(false);
    stdin.write(SUPPORTED_REPLY);
    await vi.waitFor(() => expect(stdout.count(PUSH)).toBe(1));
    instances[0]?.unmount();
    await done;
    // 戻しは 1 度だけ（親のシェルが積んだ設定まで pop しない）。要求より後、端末のモードを落とす列より前
    expect(stdout.count(POP_KITTY_KEYBOARD)).toBe(1);
    const at = (s: string) => stdout.writes.findIndex((w) => w === s);
    expect(at(POP_KITTY_KEYBOARD)).toBeGreaterThan(at(PUSH));
    expect(at(POP_KITTY_KEYBOARD)).toBeLessThan(at(RESET_TERMINAL));
  });

  it('応じない端末には要求を出さず、戻しも書かない（いまの動きのまま）', async () => {
    const { stdout, done } = setup();
    await vi.waitFor(() => expect(stdout.has(QUERY)).toBe(true));
    instances[0]?.unmount();
    await done;
    expect(stdout.has(PUSH)).toBe(false);
    expect(stdout.has(POP_KITTY_KEYBOARD)).toBe(false);
    expect(stdout.has(RESET_TERMINAL)).toBe(true);
  });

  it.each(['SIGTERM', 'SIGHUP'])(
    '%s で落ちるときも、端末を戻す列と kitty の戻しを書いて終わる',
    async (signal) => {
      const { stdin, stdout, proc, done } = setup();
      await vi.waitFor(() => expect(stdout.has(QUERY)).toBe(true));
      stdin.write(SUPPORTED_REPLY);
      await vi.waitFor(() => expect(stdout.count(PUSH)).toBe(1));
      proc.emit(signal);
      expect(stdout.count(POP_KITTY_KEYBOARD)).toBe(1);
      expect(stdout.has(RESET_TERMINAL)).toBe(true);
      expect(proc.exit).toHaveBeenCalledWith(130);
      instances[0]?.unmount();
      await done;
    },
  );

  it('未捕捉の例外で落ちるときも、戻してから理由を出して終わる', async () => {
    const { stdin, stdout, proc, done } = setup();
    await vi.waitFor(() => expect(stdout.has(QUERY)).toBe(true));
    stdin.write(SUPPORTED_REPLY);
    await vi.waitFor(() => expect(stdout.count(PUSH)).toBe(1));
    proc.emit('uncaughtException', new Error('壊れた'));
    expect(stdout.count(POP_KITTY_KEYBOARD)).toBe(1);
    expect(stdout.has(RESET_TERMINAL)).toBe(true);
    expect(proc.exit).toHaveBeenCalledWith(1);
    instances[0]?.unmount();
    await done;
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveTarget = vi.fn();
vi.mock('../target.js', async () => {
  const actual = await vi.importActual<typeof import('../target.js')>('../target.js');
  return { ...actual, resolveTarget: (...args: unknown[]) => resolveTarget(...args) as unknown };
});

const { runTui } = await import('./main.js');

function io(tty: { stdin: boolean; stdout: boolean }) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdin: { isTTY: tty.stdin } as unknown as NodeJS.ReadStream,
      stdout: {
        isTTY: tty.stdout,
        rows: 30,
        columns: 100,
        write: (t: string) => out.push(t),
      } as unknown as NodeJS.WriteStream,
      stderr: { write: (t: string) => err.push(t) } as unknown as NodeJS.WriteStream,
    },
  };
}

afterEach(() => resolveTarget.mockReset());

describe('runTui', () => {
  it('未ログイン（note が非 null）なら、stdout に書かず例外で終わる（入口が非 0 にする。画面モードに入らない）（#4073）', async () => {
    resolveTarget.mockResolvedValue({
      baseUrl: 'https://alt.example.com',
      headers: {},
      remote: true,
      note: 'https://alt.example.com にログインしていません（alteroid login）',
    });
    const { io: streams, out } = io({ stdin: true, stdout: true });
    await expect(runTui(streams)).rejects.toThrow(
      'https://alt.example.com にログインしていません（alteroid login）',
    );
    expect(out).toEqual([]);
  });

  it('端末でなければ、デーモンを起こす前に断る', async () => {
    const { io: streams } = io({ stdin: false, stdout: true });
    await expect(runTui(streams)).rejects.toThrow(/端末（TTY）でだけ動きます/);
    expect(resolveTarget).not.toHaveBeenCalled();
    const second = io({ stdin: true, stdout: false });
    await expect(runTui(second.io)).rejects.toThrow(/TTY/);
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('接続の解決の失敗は例外で上へ通す（入口が stderr に出して非 0 で終わる）', async () => {
    resolveTarget.mockRejectedValue(new Error('runner の器の中ではデーモンを起こしません'));
    const { io: streams } = io({ stdin: true, stdout: true });
    await expect(runTui(streams)).rejects.toThrow(/runner/);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStderr, captureStdout } from './test-support.js';

vi.mock('./practice.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./practice.js')>()),
  practiceShowCommand: vi.fn(() => Promise.resolve()),
}));

const { practiceShowCommand } = await import('./practice.js');
const { program } = await import('./index.js');

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function run(...args: string[]): Promise<void> {
  await program.parseAsync(['node', 'alteroid', ...args]);
}

describe('practice show --version（commander を通す）', () => {
  it.each([
    ['--version 3 を slug の後ろに', ['practice', 'show', 'x', '--version', '3']],
    ['--version 3 を slug の前に', ['practice', 'show', '--version', '3', 'x']],
    ['--version=3', ['practice', 'show', 'x', '--version=3']],
  ])('%s 置いても、CLI のバージョンではなく過去の版 3 を取りに行く', async (_label, argv) => {
    const out = captureStdout();
    captureStderr();

    await run(...argv);

    expect(practiceShowCommand).toHaveBeenCalledWith('x', { version: '3' });
    expect(out()).not.toContain('alteroid ');
  });

  it('成立しない版番号は、数に直さず打った文字列のまま渡す（エラー文が NaN にならない）', async () => {
    captureStdout();
    captureStderr();

    await run('practice', 'show', 'x', '--version', 'abc');

    expect(practiceShowCommand).toHaveBeenCalledWith('x', { version: 'abc' });
  });

  it('ルートの -V / --version は、これまでどおり CLI のバージョンを出す', async () => {
    const out = captureStdout();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await run('--version').catch(() => undefined);

    expect(exit).toHaveBeenCalledWith(0);
    expect(out()).toMatch(/^alteroid /);
    expect(practiceShowCommand).not.toHaveBeenCalled();
  });
});

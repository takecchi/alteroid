import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStderr, captureStdout } from './test-support.js';

const NOTE = 'https://runner.example.com にログインしていません（alteroid login）';

vi.mock('./target.js', () => ({
  resolveTarget: () =>
    Promise.resolve({
      baseUrl: 'https://runner.example.com',
      headers: {},
      note: NOTE,
      remote: true,
    }),
  describeAuthFailure: () => null,
}));

const { topologyCommand } = await import('./topology.js');

describe('topologyCommand（未ログイン）の標準出力と標準エラー', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([{ json: true }, { json: true, watch: true }])(
    '%j: 標準出力は空（JSON でない文を混ぜない）で、案内は標準エラーにあり、正常に戻る',
    async (options) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const readOut = captureStdout();
      const readErr = captureStderr();
      await expect(topologyCommand(options)).resolves.toBeUndefined();
      expect(readOut()).toBe('');
      expect(readErr()).toContain(NOTE);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('--json でなければ、案内はこれまでどおり標準出力へ出る', async () => {
    const readOut = captureStdout();
    const readErr = captureStderr();
    await topologyCommand();
    expect(readOut()).toContain(NOTE);
    expect(readErr()).toBe('');
  });
});

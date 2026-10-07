import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmIo } from './confirm.js';

const NOTE = 'https://remote.example.com にログインしていません（alteroid login）';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({
      baseUrl: 'https://remote.example.com',
      headers: {},
      note: NOTE,
      remote: true,
    }),
}));

const { resetCommand } = await import('./reset.js');
const { accessRemoveUnreadableCommand, accessRevokeCommand } = await import('./access.js');
const { tokenRemoveUnreadableCommand } = await import('./token.js');
const { permissionRemoveUnreadableCommand } = await import('./permission.js');
const { profileClearCommand } = await import('./profile.js');

let originalFetch: typeof fetch;
let fetched: number;
let touched: string[];

const io: ConfirmIo = {
  isTTY: true,
  write: (text) => {
    touched.push(`write:${text}`);
  },
  ask: (question) => {
    touched.push(`ask:${question}`);
    return Promise.resolve('yes');
  },
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetched = 0;
  touched = [];
  globalThis.fetch = (() => {
    fetched += 1;
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('未ログインなら、確認を出す前に断る — issue #3214', () => {
  it('reset', async () => {
    await expect(resetCommand({}, io)).rejects.toThrow(NOTE);
    expect(touched).toEqual([]);
    expect(fetched).toBe(0);
  });

  const cases: [string, () => Promise<void>][] = [
    ['access remove-unreadable', () => accessRemoveUnreadableCommand(['row-1'])],
    ['access revoke', () => accessRevokeCommand('acct-1')],
    ['token remove-unreadable', () => tokenRemoveUnreadableCommand(['row-1'])],
    ['permission remove-unreadable', () => permissionRemoveUnreadableCommand(['row-1'])],
    ['profile clear', () => profileClearCommand()],
  ];
  for (const [name, run] of cases) {
    it(name, async () => {
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(NOTE);
      expect(fetched).toBe(0);
    });
  }
});

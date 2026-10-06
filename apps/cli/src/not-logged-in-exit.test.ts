import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

/**
 * Issue #2456（クローン teto の判断 2026-09-30）: 未ログインの遠隔先
 * （`resolveTarget` が `note` を返す）では、**状態を変える書き込み系は例外で
 * 終える（＝入口の `program.parseAsync(...).catch(...)` が stderr へ出して終了コード
 * 1）**。読み取り系は今のまま note を stdout に出して正常 return（終了コード 0）。
 *
 * 書き込み系: interrupt / memory の edit・set・remove / practice の edit・set・remove /
 * runners vacate / permission revoke / inbox remove / conversations read（既読の位置を
 * 進める。#3447）。読み取り系の代表: usage /
 * progress / runners / permission list / memory list・show / practice list・show・history /
 * inbox show。
 *
 * 歯は「HTTP に一度も出ない」「stdout に note を出さない（二重に出さない）」
 * 「reject のメッセージが note そのもの」の3つ。
 */
const NOTE = 'https://runner.example.com にログインしていません（alteroid login）';

vi.mock('./target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./target.js')>()),
  resolveTarget: () =>
    Promise.resolve({
      baseUrl: 'https://runner.example.com',
      headers: {},
      note: NOTE,
      remote: true,
    }),
}));

const { interruptCommand } = await import('./interrupt.js');
const {
  memoryEditCommand,
  memoryListCommand,
  memoryRemoveCommand,
  memorySetCommand,
  memoryShowCommand,
} = await import('./memory.js');
const {
  practiceEditCommand,
  practiceHistoryCommand,
  practiceListCommand,
  practiceRemoveCommand,
  practiceSetCommand,
  practiceShowCommand,
} = await import('./practice.js');
const { runnersCommand, runnersVacateCommand } = await import('./runners.js');
const { permissionListCommand, permissionRevokeCommand } = await import('./permission.js');
const { inboxRemoveCommand, inboxShowCommand } = await import('./inbox.js');
const { conversationsReadCommand } = await import('./conversations.js');
const { usageCommand } = await import('./usage.js');
const { progressCommand } = await import('./progress.js');

let fetchCalls = 0;
const originalFetch = globalThis.fetch;

function stubFetch(): void {
  fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    return Promise.reject(new Error('fetch must not be called when not logged in'));
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const writes: [string, () => Promise<void>][] = [
  ['interrupt', () => interruptCommand()],
  ['memory edit', () => memoryEditCommand('foo')],
  ['memory set', () => memorySetCommand('foo', { file: '-' })],
  ['memory remove', () => memoryRemoveCommand('foo')],
  ['practice edit', () => practiceEditCommand('foo')],
  ['practice set', () => practiceSetCommand('foo', { file: '-' })],
  ['practice remove', () => practiceRemoveCommand('foo')],
  ['runners vacate', () => runnersVacateCommand('runner-1')],
  ['permission revoke', () => permissionRevokeCommand('grant-1')],
  ['conversations read', () => conversationsReadCommand('conv-1')],
  [
    'inbox remove',
    () => inboxRemoveCommand({ types: 'manager_message', reason: 'test', execute: true }),
  ],
];

const reads: [string, () => Promise<void>][] = [
  ['usage', () => usageCommand({})],
  ['progress', () => progressCommand()],
  ['runners', () => runnersCommand()],
  ['permission list', () => permissionListCommand()],
  ['memory list', () => memoryListCommand()],
  ['memory show', () => memoryShowCommand('foo')],
  ['practice list', () => practiceListCommand()],
  ['practice show', () => practiceShowCommand('foo')],
  ['practice history', () => practiceHistoryCommand('foo')],
  ['inbox show', () => inboxShowCommand()],
];

describe('未ログインの遠隔先（target.note）— 書き込み系は非 0 で終える（#2456）', () => {
  it.each(writes)(
    '%s は note を載せて reject し、stdout に書かず、HTTP に出ない',
    async (_name, run) => {
      stubFetch();
      const read = captureStdout();

      await expect(run()).rejects.toThrow(NOTE);

      expect(read()).toBe('');
      expect(fetchCalls).toBe(0);
    },
  );
});

describe('未ログインの遠隔先（target.note）— 読み取り系は今のまま 0 で note を出す（#2456）', () => {
  it.each(reads)(
    '%s は note を stdout に書いて正常 return し、HTTP に出ない',
    async (_name, run) => {
      stubFetch();
      const read = captureStdout();

      await expect(run()).resolves.toBeUndefined();

      expect(read()).toBe(`${NOTE}\n`);
      expect(fetchCalls).toBe(0);
    },
  );
});

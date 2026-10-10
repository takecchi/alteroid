import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from './test-support.js';

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
const {
  tokenAddCommand,
  tokenDisableCommand,
  tokenEnableCommand,
  tokenListCommand,
  tokenPolicyCommand,
  tokenRemoveCommand,
  tokenRemoveUnreadableCommand,
} = await import('./token.js');
const {
  integrationCreateCommand,
  integrationListCommand,
  integrationRemoveUnreadableCommand,
  integrationRevokeCommand,
} = await import('./integration.js');
const {
  profileClearCommand,
  profileEditCommand,
  profileListCommand,
  profileRemoveCommand,
  profileSetCommand,
  profileShowCommand,
  profileStatusCommand,
} = await import('./profile.js');
const { codexLoginCommand, codexLogoutCommand, codexStatusCommand } = await import('./codex.js');
const { credentialListCommand, credentialRemoveCommand, credentialSetCommand } =
  await import('./credential.js');
const { mcpClearCommand, mcpEditCommand, mcpListCommand, mcpSetCommand, mcpShowCommand } =
  await import('./mcp.js');

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
  // token・integration・profile・codex。標準入力を読む口・確認を出す口も、読む前・出す前に断る
  ['token add', () => tokenAddCommand({ label: 'x', file: '-' })],
  ['token remove', () => tokenRemoveCommand('t1')],
  ['token disable', () => tokenDisableCommand('t1')],
  ['token enable', () => tokenEnableCommand('t1')],
  ['token policy（設定を変える）', () => tokenPolicyCommand('off')],
  ['token policy --cooldown-ms', () => tokenPolicyCommand(undefined, { cooldownMs: '1000' })],
  ['token remove-unreadable', () => tokenRemoveUnreadableCommand(['t1'])],
  ['integration create', () => integrationCreateCommand({ name: 'x', source: 'github' })],
  ['integration revoke', () => integrationRevokeCommand('k1')],
  ['integration remove-unreadable', () => integrationRemoveUnreadableCommand(['k1'])],
  ['profile set', () => profileSetCommand('foo', { file: '-' })],
  ['profile edit', () => profileEditCommand('foo')],
  ['profile rm', () => profileRemoveCommand('foo')],
  ['profile clear', () => profileClearCommand()],
  // 標準出力は本文だけ（`show | set` で note が本文として撒かれない）ため、読み取り系でも例外にする
  ['profile show', () => profileShowCommand('foo')],
  ['codex login', () => codexLoginCommand()],
  ['codex logout', () => codexLogoutCommand()],
  // credential・mcp。確認・標準入力・エディタより前に断る
  ['credential set', () => credentialSetCommand('GH_TOKEN', { file: '-' })],
  ['credential remove', () => credentialRemoveCommand('GH_TOKEN')],
  ['mcp set', () => mcpSetCommand('-')],
  ['mcp edit', () => mcpEditCommand()],
  ['mcp clear', () => mcpClearCommand()],
  // 標準出力は JSON だけ（`show > f; set f` で note が登録として撒かれない）ため、読み取り系でも例外にする
  ['mcp show', () => mcpShowCommand()],
  ['mcp show --reveal', () => mcpShowCommand({ reveal: true })],
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
  ['token list', () => tokenListCommand()],
  ['token policy（見るだけ）', () => tokenPolicyCommand(undefined)],
  ['integration list', () => integrationListCommand()],
  ['profile list', () => profileListCommand()],
  ['profile status', () => profileStatusCommand()],
  ['codex status', () => codexStatusCommand()],
  ['credential list', () => credentialListCommand()],
  ['mcp list', () => mcpListCommand()],
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

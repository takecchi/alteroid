import { describe, expect, it } from 'vitest';

import { ChatController } from './chat-controller.js';
import type { ConversationMessage } from './api.js';
import { fakeApi } from './fake-api.js';

const AUTH_HINT = 'クローンの認証が通りません。認証トークンが登録されているか確かめてください。';
const QUOTA_HINT = '利用上限に当たっています。上限が開いたあとに、もう一度送ってください。';

function setup() {
  const api = fakeApi();
  const controller = new ChatController(api);
  const entries = () =>
    controller.store.getSnapshot().entries.map((e) => [e.kind, e.text] as const);
  return { api, controller, entries };
}

const open = { type: 'open' as const, conversationId: 'c1' };

describe('受信中の error の kind', () => {
  it('auth は認証の案内を添える', async () => {
    const { api, controller, entries } = setup();
    api.scripts.push([open, { type: 'error', message: '失敗', kind: 'auth' }]);
    await controller.send('x');
    expect(entries()).toEqual([
      ['user', 'x'],
      ['error', '失敗'],
      ['system', AUTH_HINT],
    ]);
  });

  it('quota は利用上限の案内を添える', async () => {
    const { api, controller, entries } = setup();
    api.scripts.push([open, { type: 'error', message: '失敗', kind: 'quota' }]);
    await controller.send('x');
    expect(entries().slice(1)).toEqual([
      ['error', '失敗'],
      ['system', QUOTA_HINT],
    ]);
  });

  it('other と、kind を付けない古いデーモンは今のまま', async () => {
    const { api, controller, entries } = setup();
    api.scripts.push(
      [open, { type: 'error', message: '失敗', kind: 'other' }],
      [open, { type: 'error', message: '失敗2' }],
    );
    await controller.send('x');
    await controller.send('y');
    expect(entries().filter(([kind]) => kind === 'system')).toEqual([]);
  });

  it('文面に「認証」があっても kind が other なら案内しない', async () => {
    const { api, controller, entries } = setup();
    api.scripts.push([open, { type: 'error', message: '認証に失敗: 利用上限', kind: 'other' }]);
    await controller.send('x');
    expect(entries().filter(([kind]) => kind === 'system')).toEqual([]);
  });
});

describe('履歴の turnFailureKind', () => {
  const failed = (id: string, extra: Partial<ConversationMessage>): ConversationMessage => ({
    id,
    at: 't',
    role: 'outbound',
    text: '認証に失敗しました（利用上限）',
    turnFailure: 'failed',
    ...extra,
  });

  it('auth / quota の失敗ターンの直後に案内を出す', async () => {
    const { api, controller, entries } = setup();
    api.messages.c9 = [
      failed('1', { turnFailureKind: 'auth' }),
      failed('2', { turnFailureKind: 'quota' }),
    ];
    expect(await controller.openConversation('c9')).toBe(true);
    expect(
      entries().map(([kind, text]) => [kind, text === AUTH_HINT || text === QUOTA_HINT]),
    ).toEqual([
      ['assistant', false],
      ['system', true],
      ['assistant', false],
      ['system', true],
    ]);
    expect(entries().map(([, text]) => text)).toContain(AUTH_HINT);
    expect(entries().map(([, text]) => text)).toContain(QUOTA_HINT);
  });

  it('other・種別なし・失敗でない発言には案内しない', async () => {
    const { api, controller, entries } = setup();
    api.messages.c9 = [
      failed('1', { turnFailureKind: 'other' }),
      failed('2', {}),
      failed('3', { turnFailure: undefined, turnFailureKind: 'auth' }),
    ];
    expect(await controller.openConversation('c9')).toBe(true);
    expect(entries().filter(([kind]) => kind === 'system')).toEqual([]);
  });
});

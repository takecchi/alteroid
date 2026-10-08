import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendMessage } from './chat.js';
import type { Target } from './target.js';
import { captureStdout } from './test-support.js';

const target: Target = {
  baseUrl: 'http://127.0.0.1:4517',
  headers: { authorization: 'Bearer t' },
  remote: false,
  note: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function stubChat(frames: string[]): void {
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST' && url.endsWith('/chat')) {
      return Promise.resolve(
        new Response(frames.join(''), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }
    if (url.endsWith('/read')) {
      return Promise.resolve(Response.json({ readThrough: 't', unreadCount: 0 }));
    }
    return Promise.resolve(
      Response.json({ messages: [], scanned: 0, reachedStart: true, supersededCount: 0 }),
    );
  });
}

async function failWith(message: string, kind: string): Promise<string> {
  stubChat([
    frame('open', { conversationId: 'c1' }),
    frame('error', { type: 'error', message, kind }),
  ]);
  const read = captureStdout();
  await sendMessage(target, '質問', null);
  return read();
}

describe('chat のターン失敗の案内（kind）', () => {
  it('auth: メッセージのあとに、認証トークンを確かめる1行を添える', async () => {
    const text = await failWith('認証できなかった', 'auth');
    expect(text).toContain('エラー: 認証できなかった\n');
    expect(text).toContain(
      'クローンの認証が通りません。認証トークンが登録されているか確かめてください。',
    );
  });

  it('quota: 上限が開いたあとに送り直す1行を添える', async () => {
    const text = await failWith('上限', 'quota');
    expect(text).toContain(
      '利用上限に当たっています。上限が開いたあとに、もう一度送ってください。',
    );
  });

  it('other: 本文に 401 や上限の語があっても、これまでどおりメッセージだけ', async () => {
    const text = await failWith('HTTP 401 usage limit Not logged in', 'other');
    expect(text).toContain('エラー: HTTP 401 usage limit Not logged in\n');
    expect(text).not.toContain('認証トークン');
    expect(text).not.toContain('利用上限に当たっています');
  });
});

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

const CLEAR = '\r\x1b[2K';

const hadTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

afterEach(() => {
  if (hadTTY) Object.defineProperty(process.stdout, 'isTTY', hadTTY);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
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
      Response.json({
        messages: [
          { id: 'm1', at: 't1', role: 'inbound', text: '質問' },
          { id: 'm2', at: 't2', role: 'outbound', text: '答え' },
        ],
        scanned: 2,
        reachedStart: true,
        supersededCount: 0,
      }),
    );
  });
}

const reply = [
  frame('open', { conversationId: 'c1' }),
  frame('queued', {}),
  frame('thinking', {}),
  frame('text', { text: '答え\n' }),
  frame('done', {}),
];

describe('chat の queued / thinking', () => {
  it('端末では、順番待ちと考え始めを上書きされる1行で出し、本文の前に消す', async () => {
    setTTY(true);
    stubChat(reply);
    const read = captureStdout();
    await sendMessage(target, '質問', null);
    const text = read();
    expect(text).toContain('順番を待っている');
    expect(text).toContain('考えている');
    // 状態の行は本文より前に消えている（本文と同じ行に残らない）。
    expect(text.lastIndexOf(CLEAR)).toBeLessThan(text.indexOf('答え'));
    expect(text.slice(text.lastIndexOf(CLEAR) + CLEAR.length)).toBe('答え\n\n');
  });

  it('端末でも、本文が出たあとの thinking は行の途中へ書かない', async () => {
    setTTY(true);
    stubChat([
      frame('open', { conversationId: 'c1' }),
      frame('text', { text: '途中' }),
      frame('thinking', {}),
      frame('text', { text: '続き\n' }),
      frame('done', {}),
    ]);
    const read = captureStdout();
    await sendMessage(target, '質問', null);
    expect(read()).toBe('途中続き\n\n');
  });

  it('パイプ（非 TTY）では何も足さない', async () => {
    setTTY(false);
    stubChat(reply);
    const read = captureStdout();
    await sendMessage(target, '質問', null);
    expect(read()).toBe('答え\n\n');
  });

  it('順番待ちのまま接続が切れても、状態の行を残さない', async () => {
    setTTY(true);
    stubChat([frame('open', { conversationId: 'c1' }), frame('queued', {})]);
    const read = captureStdout();
    await sendMessage(target, '質問', null);
    const text = read();
    expect(text.lastIndexOf(CLEAR)).toBeGreaterThan(text.indexOf('順番を待っている'));
    expect(text).toContain('応答が途中で切れました');
  });
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderConversationDetail, type ConversationMessage } from './conversations.js';
import { captureStdout, pretendStdinTty } from './test-support.js';
import { WITHDRAWN_MESSAGE_LABEL, withdrawnMessageText } from './withdrawn-message.js';

/**
 * #3990: 取り下げた発言（`delivery: 'withdrawn'`）は、`/conversation`・`conversations show` で
 * 普通の発言として出さない。欄の無い応答（古いデーモン）は今までどおり。
 */
let lines: string[] = [];

vi.mock('node:readline/promises', () => ({
  createInterface: () => {
    const mine = lines;
    const handlers: { line?: (text: string) => void; close?: () => void } = {};
    return {
      on: (event: string, handler: (text: string) => void) => {
        if (event === 'line') handlers.line = handler;
      },
      once: (_event: 'close', handler: () => void) => {
        handlers.close = handler;
      },
      setPrompt: () => undefined,
      prompt: () => {
        queueMicrotask(() => {
          const next = mine.shift();
          if (next === undefined) handlers.close?.();
          else handlers.line?.(next);
        });
      },
      close: () => undefined,
    };
  },
}));

vi.mock('./target.js', async (orig) => ({
  ...(await orig<typeof import('./target.js')>()),
  resolveTarget: async () => ({
    baseUrl: 'http://127.0.0.1:4517',
    headers: {},
    remote: false,
    note: null,
  }),
}));

let chatCommand: typeof import('./chat.js').chatCommand;
beforeAll(async () => {
  ({ chatCommand } = await import('./chat.js'));
}, 60_000);

let restoreStdinTty: () => void;
beforeEach(() => {
  restoreStdinTty = pretendStdinTty(true);
});

afterEach(() => {
  restoreStdinTty();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const message = (id: string, text: string, delivery?: 'withdrawn') => ({
  id,
  at: '2026-08-16T10:00:00.000Z',
  role: 'inbound' as const,
  text,
  ...(delivery === undefined ? {} : { delivery }),
});

async function runConversation(messages: ReturnType<typeof message>[]): Promise<string> {
  lines = ['/conversation conv-1'];
  vi.stubGlobal('fetch', (url: unknown) => {
    if (/\/conversations\/conv-1(\?|$)/.test(String(url))) {
      return Promise.resolve(
        Response.json({
          conversationId: 'conv-1',
          messages,
          scanned: messages.length,
          reachedStart: true,
          supersededCount: 0,
        }),
      );
    }
    return Promise.resolve(Response.json({}));
  });
  const out = captureStdout();
  await chatCommand();
  return out();
}

describe('chat /conversation: 取り下げた発言（#3990）', () => {
  it('取り下げた発言は「（取り下げた発言）」の畳んだ行で出し、編集の番号を振らない', async () => {
    const output = await runConversation([
      message('m1', '届いた発言'),
      message('m2', '取り下げた発言の本文', 'withdrawn'),
    ]);
    expect(output).toContain(`人間: ${WITHDRAWN_MESSAGE_LABEL}取り下げた発言の本文`);
    // 普通の吹き出しの形（本文だけの行）では出さない
    expect(output).not.toMatch(/人間: 取り下げた発言の本文/);
    expect(output).toContain('[1]');
    expect(output).not.toContain('[2]');
    expect(output).toMatch(/\[1\] \[[^\]]+\] 人間: 届いた発言/);
  });

  it('delivery の無い発言（取り下げていない・古いデーモン）は今までどおり番号つきの普通の行', async () => {
    const output = await runConversation([message('m1', '一つ目'), message('m2', '二つ目')]);
    expect(output).toMatch(/\[1\] \[[^\]]+\] 人間: 一つ目/);
    expect(output).toMatch(/\[2\] \[[^\]]+\] 人間: 二つ目/);
    expect(output).not.toContain(WITHDRAWN_MESSAGE_LABEL);
  });
});

describe('conversations show: 取り下げた発言（#3990）', () => {
  const render = (messages: ConversationMessage[]) =>
    renderConversationDetail('conv-1', messages, messages.length, true, 0);

  it('取り下げた発言は畳んだ行で出し、取り下げていない発言は今までどおり', () => {
    const text = render([
      message('m1', '届いた発言'),
      message('m2', '取り下げた発言', 'withdrawn'),
    ]);
    expect(text).toContain('(id: m1): 届いた発言');
    expect(text).toContain(`(id: m2): ${WITHDRAWN_MESSAGE_LABEL}取り下げた発言`);
    expect(text).not.toContain('(id: m2): 取り下げた発言');
  });

  it('欄の無い応答は壊れず、普通に出す', () => {
    const text = render([message('m1', '古いデーモンの発言')]);
    expect(text).toContain('(id: m1): 古いデーモンの発言');
    expect(text).not.toContain(WITHDRAWN_MESSAGE_LABEL);
  });
});

describe('withdrawnMessageText', () => {
  it('長い本文・改行は1行に畳み、空なら語だけ', () => {
    expect(withdrawnMessageText('a\n\nb')).toBe(`${WITHDRAWN_MESSAGE_LABEL}a b`);
    expect(withdrawnMessageText('あ'.repeat(100))).toBe(
      `${WITHDRAWN_MESSAGE_LABEL}${'あ'.repeat(60)}…`,
    );
    expect(withdrawnMessageText('  ')).toBe(WITHDRAWN_MESSAGE_LABEL);
  });
});

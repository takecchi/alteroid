import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { captureStdout, pretendStdinTty } from './test-support.js';

// `run` ごとに作り直す: chat-attach-only.test.ts と同じ理由（置き去りの実行が次のテストの行を横取りしない）
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

async function run(
  input: string[],
  options: { uploadFails?: boolean; msgMissingOnce?: boolean } = {},
): Promise<{
  msgBodies: Record<string, unknown>[];
  chatBodies: Record<string, unknown>[];
  uploads: number;
  output: string;
}> {
  lines = [...input];
  const msgBodies: Record<string, unknown>[] = [];
  const chatBodies: Record<string, unknown>[] = [];
  let uploads = 0;
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/managers/mgr-1/messages')) {
      msgBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (options.msgMissingOnce === true && msgBodies.length === 1) {
        return Promise.resolve(
          Response.json(
            {
              error: '添付が見つからない（保持期限が過ぎて消えた）: att-1。',
              code: 'attachment_missing',
            },
            { status: 400 },
          ),
        );
      }
      return Promise.resolve(Response.json({ outcome: 'delivered', detail: '届けた' }));
    }
    if (u.endsWith('/chat')) {
      chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(
        new Response('event: done\ndata: {"type":"done"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }
    if (u.includes('/attachments')) {
      if (init?.method === 'POST') {
        uploads += 1;
        if (options.uploadFails === true) {
          return Promise.resolve(Response.json({ error: '上げられない' }, { status: 500 }));
        }
      }
      return Promise.resolve(
        Response.json({
          id: `att-${uploads}`,
          name: 'a.log',
          mediaType: 'text/plain',
          size: 1,
          sha256: 'x',
        }),
      );
    }
    return Promise.resolve(Response.json({}));
  });
  const out = captureStdout();
  await chatCommand();
  return { msgBodies, chatBodies, uploads, output: out() };
}

async function attachedFile(): Promise<string> {
  const dir = await makeTempDir('alteroid-chat-msg-');
  const path = join(dir, 'a.log');
  await writeFile(path, 'x');
  return path;
}

describe('chat: /msg に添えかけを載せる', () => {
  it('添えかけ付きの /msg は上げて attachments を送り、添えかけを外す', async () => {
    const path = await attachedFile();
    const { msgBodies, chatBodies, uploads } = await run([
      `/attach ${path}`,
      '/msg mgr-1 これを見て',
      '次の発言',
    ]);
    expect(uploads).toBe(1);
    expect(msgBodies).toEqual([{ text: 'これを見て', attachments: ['att-1'] }]);
    // 外れているので、次の通常発言には載らない
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).not.toHaveProperty('attachments');
  });

  it('上げに失敗したら /msg を送らず、添えかけを残す', async () => {
    const path = await attachedFile();
    const { msgBodies, output } = await run(
      [`/attach ${path}`, '/msg mgr-1 これを見て', '/attachments'],
      { uploadFails: true },
    );
    expect(msgBodies).toEqual([]);
    expect(output).toContain('添付を上げられなかったので送っていません');
    expect(output).toContain('添えかけは残してあります');
    // 残っているので /attachments が 1 件を出す
    expect(output).toMatch(/1\b.*a\.log/);
  });

  it('attachment_missing で断られたら、上げ済みの印を捨てて、次の /msg で上げ直す（#5339。POST /chat と同じ扱い）', async () => {
    const path = await attachedFile();
    const { msgBodies, uploads, output } = await run(
      [`/attach ${path}`, '/msg mgr-1 これを見て', '/msg mgr-1 もう一度'],
      { msgMissingOnce: true },
    );
    expect(output).toContain('添付が見つからない');
    expect(output).toContain('添付が期限切れだったので送っていない');
    expect(uploads).toBe(2);
    expect(msgBodies).toEqual([
      { text: 'これを見て', attachments: ['att-1'] },
      { text: 'もう一度', attachments: ['att-2'] },
    ]);
  });

  it('添えかけが無ければ従来どおり text だけを送り、上げない', async () => {
    const { msgBodies, uploads } = await run(['/msg mgr-1 これを見て']);
    expect(uploads).toBe(0);
    expect(msgBodies).toEqual([{ text: 'これを見て' }]);
  });
});

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { captureStdout, pretendStdinTty } from './test-support.js';

/**
 * `/edit <番号|id>`（添えかけの流れ。#3642）。readline の `chatCommand` に行を流して確かめる
 * （`chat-attach-only.test.ts` と同じ形）。**待ちは書かない**（入力が尽きたら閉じる）。
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

const attachment = (id: string, name: string) => ({
  id,
  name,
  mediaType: 'text/csv',
  size: 12,
  sha256: 'x',
});

const CONVERSATION = {
  conversationId: 'conv-1',
  messages: [
    {
      id: 'm1',
      at: '2026-08-16T10:00:00.000Z',
      role: 'inbound',
      text: 'この表を見て',
      attachments: [attachment('att-1', 'a.csv'), attachment('att-2', 'b.csv')],
    },
  ],
  scanned: 1,
  reachedStart: true,
  supersededCount: 0,
};

async function run(
  input: string[],
  /** n 回目（0 始まり）の /chat への応答を差し替える。 */
  chatReply: (n: number) => Response | undefined = () => undefined,
): Promise<{ chatBodies: Record<string, unknown>[]; uploads: number; output: string }> {
  lines = [...input];
  const chatBodies: Record<string, unknown>[] = [];
  let uploads = 0;
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/chat')) {
      chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const replaced = chatReply(chatBodies.length - 1);
      if (replaced !== undefined) return Promise.resolve(replaced);
      return Promise.resolve(
        new Response('event: done\ndata: {"type":"done"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }
    if (/\/conversations\/conv-1(\?|$)/.test(u))
      return Promise.resolve(Response.json(CONVERSATION));
    if (u.includes('/attachments')) {
      if (init?.method === 'POST') uploads += 1;
      return Promise.resolve(
        Response.json({
          id: `new-${uploads}`,
          name: 'c.log',
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
  return { chatBodies, uploads, output: out() };
}

const OPEN = '/conversation conv-1';

describe('chat: /edit <番号|id>（添えかけの流れ。#3642）', () => {
  it('始めると、元の本文と元の添付を出す。そのまま本文を打つと、元の添付を付けて supersedes で送る（上げ直さない）', async () => {
    const { chatBodies, uploads, output } = await run([OPEN, '/edit 1', '直した文']);
    expect(output).toContain('元の本文: この表を見て');
    expect(output).toContain('a.csv');
    expect(output).toContain('b.csv');
    expect(uploads).toBe(0);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({
      text: '直した文',
      conversationId: 'conv-1',
      supersedes: 'm1',
      attachments: ['att-1', 'att-2'],
    });
  });

  it('/detach で外した添付は送られない', async () => {
    const { chatBodies } = await run([OPEN, '/edit 1', '/detach 1', '直した文']);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]?.attachments).toEqual(['att-2']);
  });

  it('全部外すと、本文を打てば添付なしで送れる（attachments を付けない）', async () => {
    const { chatBodies } = await run([OPEN, '/edit 1', '/detach all', '直した文']);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ text: '直した文', supersedes: 'm1' });
    expect(chatBodies[0]).not.toHaveProperty('attachments');
  });

  it('本文を空にして、添付だけで確定できる（空行の Enter）', async () => {
    const { chatBodies } = await run([OPEN, '/edit 1', '/detach 2', '']);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({
      text: '',
      supersedes: 'm1',
      conversationId: 'conv-1',
      attachments: ['att-1'],
    });
  });

  it('添付も本文も無ければ送らない（使い方を出す）。そのあと本文を打てば送れる', async () => {
    const { chatBodies, output } = await run([OPEN, '/edit 1', '/detach all', '', '直した文']);
    expect(output).toContain('本文も添付も無いので送っていません');
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ text: '直した文', supersedes: 'm1' });
  });

  it('/attach で足した分は新しく上げて付く（元の添付はそのまま）', async () => {
    const dir = await makeTempDir('alteroid-chat-edit-');
    const path = join(dir, 'c.log');
    await writeFile(path, 'x');
    const { chatBodies, uploads } = await run([OPEN, '/edit 1', `/attach ${path}`, '']);
    expect(uploads).toBe(1);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({
      text: '',
      supersedes: 'm1',
      attachments: ['att-1', 'att-2', 'new-1'],
    });
  });

  it('/edit-cancel で何も送らない。添えかけも空になり、次の発言は編集ではない', async () => {
    const { chatBodies, output } = await run([OPEN, '/edit 1', '/edit-cancel', '', '普通の発言']);
    expect(output).toContain('編集をやめました');
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ text: '普通の発言' });
    expect(chatBodies[0]).not.toHaveProperty('supersedes');
    expect(chatBodies[0]).not.toHaveProperty('attachments');
  });

  it('期限切れの添付は 400 attachment_missing の理由を出し、送らずに編集を続けられる（外せば送れる）', async () => {
    const { chatBodies, output } = await run(
      [OPEN, '/edit 1', '直した文', '/detach 1', '直した文'],
      (n) =>
        n === 0
          ? Response.json(
              {
                error: '添付が見つからない（期限切れの可能性）: att-1',
                code: 'attachment_missing',
              },
              { status: 400 },
            )
          : undefined,
    );
    expect(output).toContain('添付が見つからない（期限切れの可能性）: att-1');
    expect(output).toContain('元の添付が期限切れだったので送っていない（a.csv）');
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[0]?.attachments).toEqual(['att-1', 'att-2']);
    // 外した att-1 は付かず、まだ編集中なので supersedes のまま
    expect(chatBodies[1]).toMatchObject({ supersedes: 'm1', attachments: ['att-2'] });
  });

  it('編集の途中の /edit は断る（編集は変わらない）', async () => {
    const { chatBodies, output } = await run([OPEN, '/edit 1', '/edit 1 別の本文', '直した文']);
    expect(output).toContain('編集の途中です');
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ text: '直した文', supersedes: 'm1' });
  });

  it('添えかけに別のファイルが残っていれば、編集を始めない', async () => {
    const dir = await makeTempDir('alteroid-chat-edit-');
    const path = join(dir, 'c.log');
    await writeFile(path, 'x');
    const { chatBodies, output } = await run([OPEN, `/attach ${path}`, '/edit 1', '普通の発言']);
    expect(output).toContain('添えかけのファイルが残っています');
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).not.toHaveProperty('supersedes');
  });

  it('既存の1行の形 /edit <番号> <本文> は、元の添付を付けて即送る', async () => {
    const { chatBodies } = await run([OPEN, '/edit 1 直した文']);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({
      text: '直した文',
      supersedes: 'm1',
      attachments: ['att-1', 'att-2'],
    });
  });

  it('編集の確定が通ると編集は終わる（次の発言は編集ではない）', async () => {
    const { chatBodies } = await run([OPEN, '/edit 1', '直した文', '次の発言']);
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]).toMatchObject({ text: '次の発言' });
    expect(chatBodies[1]).not.toHaveProperty('supersedes');
    expect(chatBodies[1]).not.toHaveProperty('attachments');
  });
});

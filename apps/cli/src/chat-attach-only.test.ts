import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { captureStdout } from './test-support.js';

/** readline に流す行（尽きたら Ctrl-C 相当で投げる）。 */
const lines: string[] = [];

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: async () => {
      const next = lines.shift();
      if (next === undefined) throw new Error('closed');
      return next;
    },
    close: () => undefined,
  }),
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function run(input: string[]): Promise<{ chatBodies: Record<string, unknown>[] }> {
  lines.push(...input);
  const chatBodies: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/chat')) {
      chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Promise.resolve(
        new Response('event: done\ndata: {"type":"done"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    }
    if (u.includes('/attachments')) {
      return Promise.resolve(
        Response.json({
          id: 'att-1',
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
  const { chatCommand } = await import('./chat.js');
  await chatCommand();
  out();
  return { chatBodies };
}

describe('chat: 添えかけがあるときの空行（添付だけの発言）', () => {
  it('/attach のあとの空行で text:"" と attachments が /chat に送られ、その後の空行は送らない', async () => {
    const dir = await makeTempDir('alteroid-chat-only-');
    const path = join(dir, 'a.log');
    await writeFile(path, 'x');
    const { chatBodies } = await run([`/attach ${path}`, '', '']);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ text: '', attachments: ['att-1'] });
  });

  it('添えかけが無い空行は送らない', async () => {
    const { chatBodies } = await run(['', '']);
    expect(chatBodies).toEqual([]);
  });
});

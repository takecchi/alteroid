import { describe, expect, it } from 'vitest';

import { createAlteroidClient } from './index.js';

const FAKE_GHP = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

function clientReturning(status: number, body: string) {
  return createAlteroidClient({
    baseUrl: 'http://127.0.0.1:1',
    fetch: () => Promise.resolve(new Response(body, { status })),
  });
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('ok でない応答で投げられるはずが、成功してしまった');
}

const drain = async (client: ReturnType<typeof clientReturning>) => {
  await client.journalStream().next();
};

describe('SSE の ok でない応答', () => {
  it('本文の偽の値は message に出ず、path と status は残る', async () => {
    const message = await messageOf(() =>
      drain(clientReturning(502, `bad gateway ${FAKE_GHP} postgres://u:FAKE@h/db\nparams: FAKE`)),
    );

    expect(message).toContain('/journal/stream');
    expect(message).toContain('502');
    expect(message).toContain('bad gateway');
    expect(message).not.toContain(FAKE_GHP);
    expect(message).not.toContain('u:FAKE@');
    expect(message).not.toMatch(/params: FAKE/);
  });

  it('chat の口も同じ', async () => {
    const message = await messageOf(async () => {
      await clientReturning(500, `token ${FAKE_GHP}`).chat({ text: 'x' }).next();
    });
    expect(message).toContain('/chat');
    expect(message).toContain('500');
    expect(message).not.toContain(FAKE_GHP);
  });

  it('長い本文は切る（切ったことが分かる）', async () => {
    const message = await messageOf(() => drain(clientReturning(503, 'あ'.repeat(100_000))));
    expect(message.length).toBeLessThan(700);
    expect(message.endsWith('…')).toBe(true);
    expect(message).toContain('503');
  });

  it('伏せてから切る: 上限をまたぐトークンの断片が残らない', async () => {
    const body = `${'x '.repeat(250)}${FAKE_GHP}`;
    const message = await messageOf(() => drain(clientReturning(500, body)));
    expect(message).not.toContain('ghp_A1b2');
  });

  it('値を含まない普通の本文は、今までどおり出る（対照）', async () => {
    const message = await messageOf(() => drain(clientReturning(503, 'service unavailable')));
    expect(message).toBe('/journal/stream が 503 を返した: service unavailable');
  });
});
